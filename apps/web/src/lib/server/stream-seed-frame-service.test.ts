import { beforeEach, describe, expect, it, vi } from "vitest";

const m=vi.hoisted(()=>({findChannel:vi.fn(),isBanned:vi.fn(),requireContentReviewer:vi.fn(),transaction:vi.fn(),inputAsset:vi.fn(),screen:vi.fn(),principal:vi.fn(),stream:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("./channels",()=>({findChannel:m.findChannel,isBanned:m.isBanned,requireContentReviewer:m.requireContentReviewer}));
vi.mock("./db",()=>({transaction:m.transaction}));
vi.mock("./preflight",()=>({inputAsset:m.inputAsset,screenPromptAndImages:m.screen}));
vi.mock("./principals",()=>({requestPrincipal:m.principal}));
vi.mock("./stream-service",()=>({getStream:m.stream}));
vi.mock("./http",async load=>({...await load<typeof import("./http")>(),assertSameOrigin:vi.fn()}));
import { addStreamSeedFrame } from "./stream-seed-frame-service";

const assetId="00000000-0000-4000-8000-000000000001";
const boundaryId="00000000-0000-4000-8000-000000000002";
const request=()=>new Request("https://example.test/api",{method:"POST",headers:{"content-type":"application/json",origin:"https://example.test"},body:JSON.stringify({assetId,prompt:"A cartoon rocket"})});

describe("stream seed frames",()=>{
  beforeEach(()=>{
    vi.resetAllMocks();
    m.findChannel.mockResolvedValue({twitch_channel_id:"123",policy_revision:3});
    m.principal.mockResolvedValue({kind:"session"});m.requireContentReviewer.mockResolvedValue("42");
    m.stream.mockResolvedValue({id:"stream-a"});m.isBanned.mockResolvedValue(false);
    m.inputAsset.mockResolvedValue({assetId,bytes:Buffer.from("image"),contentType:"image/png"});
    m.screen.mockResolvedValue({decision:"clear",digest:"11".repeat(32)});
  });
  it("saves a screened frame scoped to the stream without scheduling",async()=>{
    const db={query:vi.fn(async (sql:string)=>{
      if(sql.includes("SELECT policy_revision"))return {rows:[{policy_revision:3}],rowCount:1};
      if(sql.includes("SELECT id FROM sloptogether.assets"))return {rows:[{id:assetId}],rowCount:1};
      if(sql.includes("SELECT id FROM sloptogether.input_screens"))return {rows:[{id:"screen"}],rowCount:1};
      if(sql.includes("INSERT INTO sloptogether.boundary_revisions"))return {rows:[{id:boundaryId}],rowCount:1};
      return {rows:[],rowCount:1};
    })};
    m.transaction.mockImplementation(async fn=>fn(db));
    await expect(addStreamSeedFrame("owner",request(),"cartoon")).resolves.toEqual({assetId,boundaryRevisionId:boundaryId});
    const calls=db.query.mock.calls.map(([sql])=>sql);
    expect(calls.some(sql=>sql.includes("INSERT INTO sloptogether.stream_seed_frames"))).toBe(true);
    expect(calls.some(sql=>sql.includes("INSERT INTO sloptogether.jobs")||sql.includes("INSERT INTO sloptogether.elections"))).toBe(false);
  });
  it("never approves held inputs",async()=>{
    m.screen.mockResolvedValue({decision:"held",digest:"11".repeat(32)});
    await expect(addStreamSeedFrame("owner",request(),"cartoon")).rejects.toMatchObject({code:"input_screen_not_clear"});
    expect(m.transaction).not.toHaveBeenCalled();
  });
  it("rejects worker credentials",async()=>{
    m.principal.mockResolvedValue({kind:"worker-key"});
    await expect(addStreamSeedFrame("owner",request(),"cartoon")).rejects.toMatchObject({code:"reviewer_session_required"});
    expect(m.inputAsset).not.toHaveBeenCalled();
  });
});
