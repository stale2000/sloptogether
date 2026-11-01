import { beforeEach, describe, expect, it, vi } from "vitest";

const m=vi.hoisted(()=>({findChannel:vi.fn(),isBanned:vi.fn(),controller:vi.fn(),transaction:vi.fn(),screen:vi.fn(),principal:vi.fn(),stream:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("./channels",()=>({findChannel:m.findChannel,isBanned:m.isBanned,requireStreamerController:m.controller}));
vi.mock("./db",()=>({transaction:m.transaction}));
vi.mock("./preflight",()=>({screenPromptAndImages:m.screen}));
vi.mock("./principals",()=>({requestPrincipal:m.principal}));
vi.mock("./stream-service",()=>({getStream:m.stream}));
vi.mock("./story-candidate-service",()=>({candidateStream:"TRUE",streamBoundary:"TRUE"}));
vi.mock("./candidate-election",()=>({resolveCandidateElections:vi.fn()}));
vi.mock("./http",async load=>({...await load<typeof import("./http")>(),assertSameOrigin:vi.fn()}));
import { submitOwnerCandidate } from "./owner-candidate-service";

const itemId="00000000-0000-4000-8000-000000000001";
const boundaryRevisionId="00000000-0000-4000-8000-000000000002";
const request=()=>new Request("https://example.test/api",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({prompt:"A cartoon fox waves",boundaryRevisionId,expectedCandidateRevision:1})});

describe("broadcaster candidate submission",()=>{
  beforeEach(()=>{
    vi.resetAllMocks(); m.findChannel.mockResolvedValue({twitch_channel_id:"123",policy_revision:3});
    m.principal.mockResolvedValue({kind:"session"});m.controller.mockResolvedValue("123");
    m.stream.mockResolvedValue({id:"stream-a"});m.isBanned.mockResolvedValue(false);
    m.screen.mockResolvedValue({decision:"clear",digest:"11".repeat(32)});
  });
  function setup(options:{openElection?:boolean;validFrame?:boolean}={}){
    const db={query:vi.fn(async(sql:string,values?:unknown[])=>{
      void values;
      if(sql.includes("SELECT policy_revision"))return {rows:[{policy_revision:3}],rowCount:1};
      if(sql.includes("FROM sloptogether.story_batch_items i"))return {rows:[{segment_id:"segment",candidate_revision:"1",candidate_plan:{visualAction:"old"},state:"planned",segment_state:"open",approved_at:null,rejected_at:null,protected_at:null,selected_revision_id:null}],rowCount:1};
      if(sql.includes("FROM sloptogether.elections"))return {rows:[],rowCount:options.openElection?1:0};
      if(sql.includes("FROM sloptogether.boundary_revisions"))return {rows:[],rowCount:options.validFrame===false?0:1};
      if(sql.includes("UPDATE sloptogether.story_batch_items"))return {rows:[{candidate_revision:"2"}],rowCount:1};
      return {rows:[],rowCount:1};
    })};
    m.transaction.mockImplementation(async fn=>fn(db));return db;
  }
  it("screens the prompt and approves only the candidate; it never dispatches a job",async()=>{
    const db=setup();
    await expect(submitOwnerCandidate("owner",itemId,request(),"cartoon")).resolves.toMatchObject({approved:true,candidateRevision:2,startBoundaryRevisionId:boundaryRevisionId});
    expect(m.screen).toHaveBeenCalledWith({channelId:"123",prompt:expect.stringContaining("A cartoon fox waves"),images:[]});
    const update=db.query.mock.calls.find(([sql])=>sql.includes("UPDATE sloptogether.story_batch_items"));
    expect(update?.[1]?.[1]).toBe(m.screen.mock.calls[0]?.[0].prompt);
    expect(JSON.parse(String(update?.[1]?.[5]))).toMatchObject({visualAction:"A cartoon fox waves",dialogue:"Here we go!"});
    expect(db.query.mock.calls.some(([sql])=>sql.includes("INSERT INTO sloptogether.jobs"))).toBe(false);
  });
  it("does not approve a held prompt",async()=>{
    m.screen.mockResolvedValue({decision:"held"});
    await expect(submitOwnerCandidate("owner",itemId,request(),"cartoon")).rejects.toMatchObject({code:"input_screen_not_clear"});
    expect(m.transaction).not.toHaveBeenCalled();
  });
  it("refuses an open vote and a frame outside the stream",async()=>{
    setup({openElection:true});
    await expect(submitOwnerCandidate("owner",itemId,request(),"cartoon")).rejects.toMatchObject({code:"story_candidate_vote_open"});
    setup({validFrame:false});
    await expect(submitOwnerCandidate("owner",itemId,request(),"cartoon")).rejects.toMatchObject({code:"story_start_frame_not_approved"});
  });
  it("rejects non-session credentials before screening",async()=>{
    m.principal.mockResolvedValue({kind:"worker-key"});
    await expect(submitOwnerCandidate("owner",itemId,request(),"cartoon")).rejects.toMatchObject({code:"broadcaster_session_required"});
    expect(m.screen).not.toHaveBeenCalled();
  });
});
