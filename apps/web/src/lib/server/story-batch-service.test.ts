import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(), transaction: vi.fn(), findChannel: vi.fn(), getStream: vi.fn(),
  requestPrincipal: vi.fn(), requireStreamerController: vi.fn(), requireContentReviewer: vi.fn(), isBanned: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("./db", () => ({ query: mocks.query, transaction: mocks.transaction, DatabaseUnavailable: class extends Error {} }));
vi.mock("./channels", () => ({ findChannel: mocks.findChannel, requireStreamerController: mocks.requireStreamerController, requireContentReviewer: mocks.requireContentReviewer, isBanned: mocks.isBanned }));
vi.mock("./stream-service", () => ({ getStream: mocks.getStream }));
vi.mock("./principals", () => ({ requestPrincipal: mocks.requestPrincipal }));
vi.mock("./http", async importOriginal => {
  const actual = await importOriginal<typeof import("./http")>();
  return { ...actual, assertSameOrigin: vi.fn() };
});

import { createStoryBatch, listStoryBatches } from "./story-batch-service";

const requestId = "36b8f84d-df4e-4d49-b662-bcde71a8764f";
const channel = { twitch_channel_id: "123", owner_twitch_user_id: "42", is_enabled: true, owner_budget_cap_usd: "1.00" };
const stream = { id: "stream-id", twitch_channel_id: "123", slug: "main" };
const row = { id: "batch-id", requested_by: "42", created_at: new Date("2026-10-27T00:00:00.000Z"), scheduled: 0, pending: 4 };

function request(body: unknown = { requestId }) {
  return new Request("https://www.clips.gg/sloptogether/api/v1/channels/owner/streams/main/story-batches", {
    method: "POST", headers: { origin: "https://www.clips.gg", "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findChannel.mockResolvedValue(channel);
  mocks.getStream.mockResolvedValue(stream);
  mocks.requestPrincipal.mockResolvedValue({ kind: "session", session: { twitchUserId: "42" } });
  mocks.requireStreamerController.mockResolvedValue("42");
  mocks.requireContentReviewer.mockResolvedValue("42");
  mocks.isBanned.mockResolvedValue(false);
});
afterEach(() => vi.unstubAllEnvs());

describe("streamer story batches", () => {
  it("queues four ordered slots under the selected stream in one transaction", async () => {
    const client = { query: vi.fn(async (sql: string, _values?: unknown[]) => {
      void _values;
      if (sql.includes("FROM sloptogether.channels")) return { rows: [{ owner_twitch_user_id: "42" }], rowCount: 1 };
      if (sql.includes("INSERT INTO sloptogether.story_batches")) return { rows: [{ id: "batch-id" }], rowCount: 1 };
      if (sql.includes("FROM sloptogether.story_batches")) return { rows: [row], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    }) };
    mocks.transaction.mockImplementation(async work => work(client));
    await expect(createStoryBatch("owner", request())).resolves.toEqual({ batchId: "batch-id", requested: 4, scheduled: 0, pending: 4, createdAt: "2026-10-27T00:00:00.000Z" });
    expect(client.query.mock.calls.find(([sql]) => sql.includes("generate_series(0,3)"))?.[1]).toEqual(["batch-id"]);
    expect(client.query.mock.calls.filter(([sql]) => sql.includes("INSERT INTO sloptogether.story_batch_items"))).toHaveLength(1);
    expect(client.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO sloptogether.story_batches"))?.[1]).toEqual(["123", "stream-id", "42", requestId]);
  });

  it("returns the original result on an idempotent retry without adding slots", async () => {
    const client = { query: vi.fn(async (sql: string, _values?: unknown[]) => {
      void _values;
      if (sql.includes("FROM sloptogether.channels")) return { rows: [{ owner_twitch_user_id: "42" }], rowCount: 1 };
      if (sql.includes("INSERT INTO sloptogether.story_batches")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM sloptogether.story_batches")) return { rows: [{ ...row, scheduled: 2, pending: 2 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    }) };
    mocks.transaction.mockImplementation(async work => work(client));
    await expect(createStoryBatch("owner", request())).resolves.toMatchObject({ batchId: "batch-id", requested: 4, scheduled: 2, pending: 2 });
    expect(client.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO sloptogether.story_batch_items"))).toBe(false);
    expect(client.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO sloptogether.audit_log"))).toBe(false);
  });

  it("rejects non-broadcaster and non-session requests before any write", async () => {
    for (const principal of [{ kind: "session", session: { twitchUserId: "other" } }, { kind: "worker-key", worker: { issuingTwitchUserId: "42" } }, null]) {
      mocks.requestPrincipal.mockResolvedValue(principal);
      await expect(createStoryBatch("owner", request())).rejects.toMatchObject({ status: principal ? 403 : 401 });
      expect(mocks.transaction).not.toHaveBeenCalled();
    }
  });

  it("rechecks a ban under the channel lock before inserting any batch", async () => {
    const client = { query: vi.fn(async (_sql: string, _values?: unknown[]) => { void _sql; void _values; return { rows: [{ owner_twitch_user_id: "42" }], rowCount: 1 }; }) };
    mocks.transaction.mockImplementation(async work => work(client));
    mocks.isBanned.mockResolvedValueOnce(true);
    await expect(createStoryBatch("owner", request())).rejects.toMatchObject({ status: 403, code: "channel_ban_active" });
    expect(mocks.isBanned).toHaveBeenCalledWith("123", "42", client);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed request IDs before beginning a transaction", async () => {
    await expect(createStoryBatch("owner", request({ requestId: "bad" }))).rejects.toThrow();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("does not queue when broadcaster authorization is revoked", async () => {
    mocks.requireStreamerController.mockRejectedValueOnce(Object.assign(new Error("channel_ban_active"), { status: 403 }));
    await expect(createStoryBatch("owner", request())).rejects.toMatchObject({ status: 403 });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("lists the selected stream's newest batches", async () => {
    mocks.query.mockImplementation(async (sql: string) => sql.includes("story_batch_items_details") ? {rows: [], rowCount: 0} : sql.includes("FROM sloptogether.story_batches")
      ? { rows: [row], rowCount: 1 } : { rows: [{ producer_lease_active: true, has_approved_start: true, committed: "0.25" }], rowCount: 1 });
    vi.stubEnv("SLOPTOGETHER_GENERATION_ATTEMPT_RESERVATION_USD", "0.5");
    await expect(listStoryBatches("owner", request(), "main")).resolves.toMatchObject({ batches: [{ batchId: "batch-id", requested: 4, pending: 4 }] });
    expect(mocks.query.mock.calls[0]?.[1]).toEqual(["stream-id", "123"]);
    expect(mocks.query.mock.calls[0]?.[0]).toContain("ORDER BY b.created_at DESC,b.id DESC");
    await expect(listStoryBatches("owner", request())).resolves.toMatchObject({ availability: { producerLeaseActive: true, hasApprovedStart: true, budget: "available" } });
  });

  it("reports unavailable and exhausted budgets without claiming a producer is running", async () => {
    mocks.query.mockImplementation(async (sql: string) => sql.includes("story_batch_items_details") ? {rows: [], rowCount: 0} : sql.includes("FROM sloptogether.story_batches")
      ? { rows: [row], rowCount: 1 } : { rows: [{ producer_lease_active: false, has_approved_start: false, committed: "0.75" }], rowCount: 1 });
    vi.stubEnv("SLOPTOGETHER_GENERATION_ATTEMPT_RESERVATION_USD", "0");
    await expect(listStoryBatches("owner", request())).resolves.toMatchObject({ availability: { producerLeaseActive: false, hasApprovedStart: false, budget: "unavailable" } });
    vi.stubEnv("SLOPTOGETHER_GENERATION_ATTEMPT_RESERVATION_USD", "0.5");
    await expect(listStoryBatches("owner", request())).resolves.toMatchObject({ availability: { producerLeaseActive: false, budget: "exhausted" } });
  });

  it("lists ordered batch slots with current prompts and authorized frame previews", async () => {
    const assetId="f9e2de7e-7c49-413f-b26f-c40209d8ba37";
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("story_batch_items_details")) return {rows:[
        {batch_id:"batch-id",item_id:"item-0",position:0,state:"planned",prompt:"A cartoon astronaut waves.",dialogue:"Hello!",start_asset_id:assetId,end_asset_id:assetId,start_boundary_revision_id:"boundary",candidate_revision:"2",candidate_approved:false,can_approve:true,candidate_rejected:false,can_reject:true,can_replan:false,screen_blocked:false,can_retry_screen:false},
        {batch_id:"batch-id",item_id:"item-1",position:1,state:"pending",prompt:null,dialogue:null,start_asset_id:null,start_boundary_revision_id:null,candidate_revision:"0",candidate_approved:false,can_approve:false,candidate_rejected:false,can_reject:false,can_replan:false,screen_blocked:false,can_retry_screen:false},
        {batch_id:"batch-id",item_id:"item-2",position:2,state:"expired",prompt:"A stale job.",dialogue:null,start_asset_id:assetId,start_boundary_revision_id:"boundary",candidate_revision:"3",candidate_approved:true,can_approve:false,candidate_rejected:false,can_reject:false,can_replan:false,screen_blocked:false,can_retry_screen:false},
        {batch_id:"batch-id",item_id:"item-3",position:3,state:"superseded",prompt:null,dialogue:null,start_asset_id:null,start_boundary_revision_id:null,candidate_revision:"0",candidate_approved:false,can_approve:false,candidate_rejected:false,can_reject:false,can_replan:false,screen_blocked:false,can_retry_screen:false},
      ],rowCount:4};
      if(sql.includes("FROM sloptogether.story_batches")) return {rows:[row],rowCount:1};
      return {rows:[{producer_lease_active:true,has_approved_start:true,committed:"0"}],rowCount:1};
    });
    const result=await listStoryBatches("owner",request(),"main");
    expect(result.batches[0]?.items).toEqual([
      {itemId:"item-0",position:0,state:"planned",prompt:"A cartoon astronaut waves.",dialogue:"Hello!",startFrameUrl:`/sloptogether/api/v1/media/${assetId}/preview`,endFrameUrl:`/sloptogether/api/v1/media/${assetId}/preview`,startBoundaryRevisionId:"boundary",candidateRevision:2,candidateApproved:false,candidateRejected:false,canApprove:true,canReject:true,canReplan:false,screenBlocked:false,canRetryScreen:false},
      {itemId:"item-1",position:1,state:"pending",prompt:null,dialogue:null,startFrameUrl:null,endFrameUrl:null,startBoundaryRevisionId:null,candidateRevision:0,candidateApproved:false,candidateRejected:false,canApprove:false,canReject:false,canReplan:false,screenBlocked:false,canRetryScreen:false},
      {itemId:"item-2",position:2,state:"expired",prompt:"A stale job.",dialogue:null,startFrameUrl:`/sloptogether/api/v1/media/${assetId}/preview`,endFrameUrl:null,startBoundaryRevisionId:"boundary",candidateRevision:3,candidateApproved:true,candidateRejected:false,canApprove:false,canReject:false,canReplan:false,screenBlocked:false,canRetryScreen:false},
      {itemId:"item-3",position:3,state:"superseded",prompt:null,dialogue:null,startFrameUrl:null,endFrameUrl:null,startBoundaryRevisionId:null,candidateRevision:0,candidateApproved:false,candidateRejected:false,canApprove:false,canReject:false,canReplan:false,screenBlocked:false,canRetryScreen:false},
    ]);
    const details=mocks.query.mock.calls.find(([sql])=>String(sql).includes("story_batch_items_details"));
    expect(details?.[1]).toEqual(["stream-id","123",["batch-id"]]);
    expect(String(details?.[0])).toContain("b.stream_id=$1 AND b.twitch_channel_id=$2");
    expect(String(details?.[0])).toContain("branch.stream_id=b.stream_id");
    expect(String(details?.[0])).toContain("branch.twitch_channel_id=b.twitch_channel_id");
    expect(String(details?.[0])).toContain("branch.is_selected AND branch.archived_at IS NULL");
    expect(JSON.stringify(result)).not.toContain("storage_key");
  });

  it("lets a reviewer see slots without revealing the broadcaster budget or creating batches", async () => {
    mocks.requestPrincipal.mockResolvedValue({kind:"session",session:{twitchUserId:"mod"}});
    mocks.requireContentReviewer.mockResolvedValue("mod");
    mocks.query.mockImplementation(async (sql:string) => sql.includes("story_batch_items_details") ? {rows:[],rowCount:0} : sql.includes("FROM sloptogether.story_batches")
      ? {rows:[row],rowCount:1} : {rows:[{producer_lease_active:true,has_approved_start:true,committed:"0.25"}],rowCount:1});
    await expect(listStoryBatches("owner",request())).resolves.toMatchObject({canGenerate:false,availability:{budget:null}});
    await expect(createStoryBatch("owner",request())).rejects.toMatchObject({status:403});
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("denies a banned or unapproved reviewer before loading batches", async () => {
    mocks.requireContentReviewer.mockRejectedValueOnce(Object.assign(new Error("content_reviewer_required"),{status:403}));
    await expect(listStoryBatches("owner",request())).rejects.toMatchObject({status:403});
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("surfaces a rejected draft without representing it as a rendered job", async () => {
    mocks.query.mockImplementation(async (sql:string) => {
      if (sql.includes("story_batch_items_details")) return {rows:[{
        batch_id:"batch-id",item_id:"item-0",position:0,state:"rejected",prompt:"A funny scene.",dialogue:null,
        start_asset_id:null,end_asset_id:null,start_boundary_revision_id:null,candidate_revision:"2",
        candidate_approved:false,candidate_rejected:true,can_approve:false,can_reject:false,can_replan:true,screen_blocked:true,
      }],rowCount:1};
      if (sql.includes("FROM sloptogether.story_batches")) return {rows:[row],rowCount:1};
      return {rows:[{producer_lease_active:true,has_approved_start:true,committed:"0"}],rowCount:1};
    });
    const result=await listStoryBatches("owner",request());
    expect(result.batches[0]?.items[0]).toMatchObject({state:"rejected",candidateRejected:true,canReplan:true,canApprove:false});
  });
});
