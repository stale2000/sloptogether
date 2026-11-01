import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks=vi.hoisted(()=>({query:vi.fn(),transaction:vi.fn(),findChannel:vi.fn(),getStream:vi.fn(),
  requestPrincipal:vi.fn(),requireContentReviewer:vi.fn(),isBanned:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("./db",()=>({query:mocks.query,transaction:mocks.transaction}));
vi.mock("./channels",()=>({findChannel:mocks.findChannel,requireContentReviewer:mocks.requireContentReviewer,isBanned:mocks.isBanned}));
vi.mock("./stream-service",()=>({getStream:mocks.getStream}));
vi.mock("./principals",()=>({requestPrincipal:mocks.requestPrincipal}));
vi.mock("./http",async importOriginal=>({...await importOriginal<typeof import("./http")>(),assertSameOrigin:vi.fn()}));
import {approveStoryCandidate,listStoryCandidateFrames,rejectStoryCandidate,replanStoryCandidate,retryStoryCandidateScreen} from "./story-candidate-service";

const itemId="00000000-0000-4000-8000-000000000001";
const boundaryId="00000000-0000-4000-8000-000000000002";
const assetId="00000000-0000-4000-8000-000000000003";
const channel={twitch_channel_id:"123",owner_twitch_user_id:"42",policy_revision:1};
const stream={id:"00000000-0000-4000-8000-000000000004",slug:"main"};
const candidate={id:itemId,state:"planned",candidate_revision:"1",candidate_prompt:"cartoon scene",candidate_plan:{visualAction:"cartoon scene"},start_boundary_revision_id:null,approved_by:null,approved_at:null,approved_candidate_revision:null};
function request(body:unknown={boundaryRevisionId:boundaryId,expectedCandidateRevision:1}){
  return new Request("https://www.clips.gg/sloptogether/api/v1/channels/owner/streams/main/story-candidates/approve",{method:"POST",headers:{"content-type":"application/json",origin:"https://www.clips.gg"},body:JSON.stringify(body)});
}
function database(row:Record<string,unknown>|null=candidate,frame=true){
  const client={query:vi.fn(async(sql:string)=>{
    if(sql.includes("FROM sloptogether.channels"))return {rows:[{policy_revision:1}],rowCount:1};
    if(sql.includes("FROM sloptogether.story_batch_items i JOIN"))return {rows:row?[row]:[],rowCount:row?1:0};
    if(sql.includes("FROM sloptogether.boundary_revisions b JOIN"))return {rows:frame?[{id:boundaryId}]:[],rowCount:frame?1:0};
    if(sql.includes("UPDATE sloptogether.story_batch_items"))return {rows:[{candidate_revision:sql.includes("state='pending'")?"3":"2"}],rowCount:1};
    return {rows:[],rowCount:1};
  })};
  mocks.transaction.mockImplementation(async fn=>fn(client));
  return client;
}
beforeEach(()=>{
  vi.clearAllMocks();mocks.findChannel.mockResolvedValue(channel);mocks.getStream.mockResolvedValue(stream);
  mocks.requestPrincipal.mockResolvedValue({kind:"session",session:{twitchUserId:"42"}});
  mocks.requireContentReviewer.mockResolvedValue("42");mocks.isBanned.mockResolvedValue(false);
});

describe("planned story candidate approval",()=>{
  it("approves an independently planned candidate with an approved stream frame",async()=>{
    const client=database();
    await expect(approveStoryCandidate("owner",itemId,request())).resolves.toEqual({itemId,state:"planned",candidateRevision:2,approved:true,startBoundaryRevisionId:boundaryId});
    const select=client.query.mock.calls.find(([sql])=>sql.includes("FROM sloptogether.boundary_revisions b JOIN"))?.[0]??"";
    expect(select).toContain("branch.stream_id=$2");expect(select).toContain("a.status IN ('approved','published')");
    const itemSelect=client.query.mock.calls.find(([sql])=>sql.includes("FROM sloptogether.story_batch_items i JOIN"))?.[0]??"";
    expect(itemSelect).toContain("branch.stream_id=batch.stream_id");
    expect(client.query.mock.calls.some(([sql])=>sql.includes("story.candidate.approved"))).toBe(true);
  });
  it("treats a same-actor exact retry as idempotent without writing",async()=>{
    const client=database({...candidate,candidate_revision:"2",approved_candidate_revision:"2",approved_at:new Date(),approved_by:"42",start_boundary_revision_id:boundaryId});
    await expect(approveStoryCandidate("owner",itemId,request())).resolves.toMatchObject({approved:true,candidateRevision:2});
    expect(client.query.mock.calls.some(([sql])=>sql.includes("UPDATE sloptogether.story_batch_items"))).toBe(false);
  });
  it("rejects stale revisions, already approved candidates, and unapproved frames",async()=>{
    for(const [row,frame,code] of [
      [{...candidate,candidate_revision:"2"},true,"story_candidate_changed"],
      [{...candidate,candidate_revision:"2",approved_candidate_revision:"2",approved_at:new Date(),approved_by:"other",start_boundary_revision_id:boundaryId},true,"story_candidate_already_approved"],
      [candidate,false,"story_start_frame_not_approved"],
      [{...candidate,state:"scheduled"},true,"story_candidate_not_planned"],
    ] as const){
      const client=database(row,frame);
      await expect(approveStoryCandidate("owner",itemId,request())).rejects.toMatchObject({status:409,code});
      expect(client.query.mock.calls.some(([sql])=>sql.includes("UPDATE sloptogether.story_batch_items"))).toBe(false);
    }
  });
  it("checks reviewer authorization and a fresh ban before making changes",async()=>{
    mocks.requestPrincipal.mockResolvedValueOnce({kind:"worker-key",worker:{issuingTwitchUserId:"42"}});
    await expect(approveStoryCandidate("owner",itemId,request())).rejects.toMatchObject({status:403});
    expect(mocks.transaction).not.toHaveBeenCalled();
    const client=database();mocks.isBanned.mockResolvedValueOnce(true);
    await expect(approveStoryCandidate("owner",itemId,request())).rejects.toMatchObject({status:403,code:"channel_ban_active"});
    expect(client.query).toHaveBeenCalledTimes(1);
  });
  it("fences approval if the channel review policy changed after authorization",async()=>{
    const client=database();
    mocks.findChannel.mockResolvedValueOnce({...channel,policy_revision:2});
    await expect(approveStoryCandidate("owner",itemId,request())).rejects.toMatchObject({status:409,code:"channel_policy_changed"});
    expect(client.query.mock.calls.some(([sql])=>sql.includes("UPDATE sloptogether.story_batch_items"))).toBe(false);
  });
  it("lists only stream-scoped approved frames through the authorized preview route",async()=>{
    mocks.query.mockResolvedValueOnce({rows:[{id:boundaryId,asset_id:assetId,created_at:new Date("2026-10-27T00:00:00Z")}],rowCount:1});
    const result=await listStoryCandidateFrames("owner",request(),"main");
    expect(result.frames).toEqual([{boundaryRevisionId:boundaryId,assetId,previewUrl:`/sloptogether/api/v1/media/${assetId}/preview`,createdAt:"2026-10-27T00:00:00.000Z"}]);
    expect(mocks.query.mock.calls[0]?.[1]).toEqual(["123",stream.id]);
    expect(mocks.query.mock.calls[0]?.[0]).toContain("branch.stream_id=$2");
    expect(mocks.query.mock.calls[0]?.[0]).toContain("a.status IN ('approved','published')");
  });
  it("rejects an unapproved draft without funding or scheduling a render",async()=>{
    const client=database();
    await expect(rejectStoryCandidate("owner",itemId,request({expectedCandidateRevision:1,reason:"Wrong scene"})))
      .resolves.toEqual({itemId,state:"planned",candidateRevision:2,rejected:true});
    expect(client.query.mock.calls.some(([sql])=>sql.includes("story.candidate.rejected"))).toBe(true);
    expect(client.query.mock.calls.some(([sql])=>sql.includes("funding_authorizations")||sql.includes("INSERT INTO sloptogether.jobs"))).toBe(false);
  });
  it("replans a rejected candidate only by explicit idempotent request without spending",async()=>{
    const client=database({...candidate,candidate_revision:"2",rejected_at:new Date(),rejected_by:"42",rejection_reason:"Wrong scene",segment_id:null,job_id:null});
    await expect(replanStoryCandidate("owner",itemId,request({expectedCandidateRevision:2,requestId:"00000000-0000-4000-8000-000000000005"})))
      .resolves.toEqual({itemId,state:"pending",candidateRevision:3});
    expect(client.query.mock.calls.some(([sql])=>sql.includes("story.candidate.replan"))).toBe(true);
    expect(client.query.mock.calls.some(([sql])=>sql.includes("INSERT INTO sloptogether.jobs")||sql.includes("INSERT INTO sloptogether.funding_authorizations"))).toBe(false);
  });
  it("returns the stored result on an exact replan retry and rejects a changed request",async()=>{
    const saved={action:"story.candidate.replan",actor_twitch_user_id:"42",target_id:itemId,
      after_state:{streamId:stream.id,expectedCandidateRevision:2,candidateRevision:3}};
    const client={query:vi.fn(async(sql:string)=>sql.includes("FROM sloptogether.channels")
      ?{rows:[{policy_revision:1}],rowCount:1}:sql.includes("FROM sloptogether.audit_log")
      ?{rows:[saved],rowCount:1}:{rows:[],rowCount:0})};
    mocks.transaction.mockImplementation(async fn=>fn(client));
    const requestId="00000000-0000-4000-8000-000000000005";
    await expect(replanStoryCandidate("owner",itemId,request({expectedCandidateRevision:2,requestId})))
      .resolves.toEqual({itemId,state:"pending",candidateRevision:3});
    await expect(replanStoryCandidate("owner",itemId,request({expectedCandidateRevision:3,requestId})))
      .rejects.toMatchObject({status:409,code:"story_candidate_replan_idempotency_conflict"});
    expect(client.query.mock.calls.some(([sql])=>sql.includes("UPDATE sloptogether.story_batch_items"))).toBe(false);
  });
  it("never replans an approved or already materialized candidate",async()=>{
    for(const row of [
      {...candidate,candidate_revision:"2",rejected_at:new Date(),approved_at:new Date(),job_id:null},
      {...candidate,candidate_revision:"2",rejected_at:new Date(),approved_at:null,job_id:"used-job"},
    ]){
      const client=database(row);
      await expect(replanStoryCandidate("owner",itemId,request({expectedCandidateRevision:2,requestId:"00000000-0000-4000-8000-000000000005"})))
        .rejects.toMatchObject({status:409,code:"story_candidate_not_replannable"});
      expect(client.query.mock.calls.some(([sql])=>sql.includes("UPDATE sloptogether.story_batch_items"))).toBe(false);
    }
  });
  it("allows a reviewer to explicitly retry a blocked screen without changing approvals",async()=>{
    const client=database({...candidate,candidate_revision:"2",approved_candidate_revision:"2",approved_at:new Date(),approved_by:"42",
      start_boundary_revision_id:boundaryId,pair_screen_blocked:true,screen_active:false});
    const requestId="00000000-0000-4000-8000-000000000005";
    await expect(retryStoryCandidateScreen("owner",itemId,request({expectedCandidateRevision:2,requestId})))
      .resolves.toEqual({itemId,state:"planned",candidateRevision:2,screenRetryRequested:true});
    const update=client.query.mock.calls.find(([sql])=>sql.includes("UPDATE sloptogether.story_batch_items"))?.[0]??"";
    expect(update).toContain("pair_screen_blocked=false");expect(update).not.toContain("approved_at=");
  });
  it("does not retry screens for stale or in-flight candidates",async()=>{
    const base={...candidate,candidate_revision:"2",approved_candidate_revision:"2",approved_at:new Date(),approved_by:"42",
      start_boundary_revision_id:boundaryId,pair_screen_blocked:true,screen_active:false};
    for(const row of [{...base,screen_active:true},{...base,pair_screen_blocked:false},{...base,candidate_revision:"3"},
      {...base,state:"scheduled"},{...base,rejected_at:new Date()}]){
      const client=database(row);
      await expect(retryStoryCandidateScreen("owner",itemId,request({expectedCandidateRevision:2,requestId:"00000000-0000-4000-8000-000000000005"})))
        .rejects.toMatchObject({status:409});
      expect(client.query.mock.calls.some(([sql])=>sql.includes("UPDATE sloptogether.story_batch_items"))).toBe(false);
    }
  });
  it("deduplicates a retried screen request without changing a newer candidate",async()=>{
    const saved={action:"story.candidate.screen_retry",actor_twitch_user_id:"42",target_id:itemId,
      after_state:{streamId:stream.id,candidateRevision:2}};
    const client={query:vi.fn(async(sql:string)=>sql.includes("FROM sloptogether.channels")
      ?{rows:[{policy_revision:1}],rowCount:1}:sql.includes("FROM sloptogether.audit_log")
      ?{rows:[saved],rowCount:1}:{rows:[],rowCount:0})};
    mocks.transaction.mockImplementation(async fn=>fn(client));
    const requestId="00000000-0000-4000-8000-000000000005";
    await expect(retryStoryCandidateScreen("owner",itemId,request({expectedCandidateRevision:2,requestId})))
      .resolves.toMatchObject({screenRetryRequested:true,candidateRevision:2});
    await expect(retryStoryCandidateScreen("owner",itemId,request({expectedCandidateRevision:3,requestId})))
      .rejects.toMatchObject({status:409,code:"story_candidate_screen_retry_idempotency_conflict"});
    expect(client.query.mock.calls.some(([sql])=>sql.includes("UPDATE sloptogether.story_batch_items"))).toBe(false);
  });
  it("keeps rejected or already approved drafts from being changed silently",async()=>{
    const rejected={...candidate,candidate_revision:"2",rejected_at:new Date(),rejected_by:"42",rejection_reason:"Wrong scene"};
    const client=database(rejected);
    await expect(rejectStoryCandidate("owner",itemId,request({expectedCandidateRevision:1,reason:"Wrong scene"})))
      .resolves.toMatchObject({rejected:true,candidateRevision:2});
    await expect(approveStoryCandidate("owner",itemId,request())).rejects.toMatchObject({status:409,code:"story_candidate_rejected"});
    expect(client.query.mock.calls.some(([sql])=>sql.includes("UPDATE sloptogether.story_batch_items"))).toBe(false);
    database({...candidate,approved_at:new Date(),approved_by:"42",approved_candidate_revision:"1",start_boundary_revision_id:boundaryId});
    await expect(rejectStoryCandidate("owner",itemId,request({expectedCandidateRevision:1,reason:"Wrong scene"})))
      .rejects.toMatchObject({status:409,code:"story_candidate_already_approved"});
  });
});
