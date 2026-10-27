import {beforeEach,describe,expect,it,vi} from "vitest";

const mocks=vi.hoisted(()=>({query:vi.fn(),transaction:vi.fn(),requestPrincipal:vi.fn(),findChannel:vi.fn(),
  canContribute:vi.fn(),principalTwitchId:vi.fn(),getDefaultStreamId:vi.fn(),inputAsset:vi.fn(),screenPromptAndImages:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("./db",()=>({query:mocks.query,transaction:mocks.transaction}));
vi.mock("./principals",()=>({requestPrincipal:mocks.requestPrincipal}));
vi.mock("./channels",()=>({findChannel:mocks.findChannel,canContribute:mocks.canContribute,principalTwitchId:mocks.principalTwitchId}));
vi.mock("./stream-service",()=>({getDefaultStreamId:mocks.getDefaultStreamId}));
vi.mock("./preflight",()=>({inputAsset:mocks.inputAsset,screenPromptAndImages:mocks.screenPromptAndImages}));
vi.mock("./storage",()=>({signedPrivateReadUrl:vi.fn()}));
vi.mock("./http",async importOriginal=>({...await importOriginal<typeof import("./http")>(),assertSameOrigin:vi.fn()}));

import {submitProposal} from "./proposal-service";

const segment="00000000-0000-4000-8000-000000000001";
const image="00000000-0000-4000-8000-000000000002";
function request(){return new Request("https://www.clips.gg/sloptogether/api/v1/channels/test/proposals",{
  method:"POST",headers:{"content-type":"application/json"},
  body:JSON.stringify({segmentId:segment,prompt:"A small cartoon rocket",imageAssetId:image,planningMode:"continuation"}),
});}

beforeEach(()=>{
  vi.clearAllMocks();
  mocks.requestPrincipal.mockResolvedValue({kind:"session",session:{twitchUserId:"42",scopes:[]}});
  mocks.findChannel.mockResolvedValue({twitch_channel_id:"123",owner_twitch_user_id:"42",policy_revision:1,
    upload_approval_bypass_ids:[],role_based_upload_bypass:[]});
  mocks.getDefaultStreamId.mockResolvedValue("stream");
  mocks.canContribute.mockResolvedValue(true);
  mocks.principalTwitchId.mockReturnValue("42");
  mocks.inputAsset.mockResolvedValue({assetId:image,bytes:Buffer.from("frame"),contentType:"image/png"});
  mocks.screenPromptAndImages.mockResolvedValue({digest:"ab".repeat(32),decision:"clear"});
});

function setup(targetPresent:boolean,lockPresent:boolean){
  const client={query:vi.fn(async(sql:string)=>{
    if(sql.includes("SELECT id,branch_id,ordinal,state FROM sloptogether.segments")||sql.includes("SELECT s.id,s.branch_id,s.ordinal,s.state FROM sloptogether.segments s")&&sql.includes("FOR UPDATE"))
      return {rows:lockPresent?[{id:segment,branch_id:"branch",ordinal:"0",state:"open"}]:[],rowCount:lockPresent?1:0};
    if(sql.includes("SELECT policy_revision FROM sloptogether.channels"))return {rows:[{policy_revision:1}],rowCount:1};
    if(sql.includes("sloptogether.bans"))return {rows:[],rowCount:0};
    if(sql.includes("count(*)"))return {rows:[{n:"0"}],rowCount:1};
    if(sql.includes("SELECT coalesce(r.requested_end"))return {rows:[],rowCount:0};
    if(sql.includes("FROM sloptogether.input_screens"))return {rows:[{id:"screen",effective_state:"clear"}],rowCount:1};
    if(sql.includes("INSERT INTO sloptogether.boundary_revisions"))return {rows:[{id:"boundary"}],rowCount:1};
    if(sql.includes("INSERT INTO sloptogether.elections"))return {rows:[{id:"election"}],rowCount:1};
    if(sql.includes("SELECT id FROM sloptogether.elections"))return {rows:[],rowCount:0};
    if(sql.includes("coalesce(max(revision)"))return {rows:[{n:1}],rowCount:1};
    return {rows:[],rowCount:1};
  })};
  mocks.transaction.mockImplementation(async work=>work(client));
  mocks.query.mockImplementation(async(sql:string)=>{
    if(sql.includes("SELECT s.id,s.branch_id,s.ordinal,s.state FROM sloptogether.segments s"))return {rows:targetPresent?[{id:segment,branch_id:"branch",ordinal:"0",state:"open"}]:[],rowCount:targetPresent?1:0};
    return {rows:[],rowCount:0};
  });
  return client;
}

describe("candidate-owned future segments",()=>{
  it("filters candidate-owned segments before any input screening",async()=>{
    setup(false,false);
    await expect(submitProposal("test",request())).rejects.toMatchObject({status:409,code:"open_segment_required"});
    const selection=mocks.query.mock.calls.find(([sql])=>String(sql).includes("SELECT s.id,s.branch_id"));
    expect(String(selection?.[0])).toContain("NOT EXISTS(SELECT 1 FROM sloptogether.story_batch_items");
    expect(mocks.screenPromptAndImages).not.toHaveBeenCalled();
  });

  it("rejects a segment reserved by a candidate after screening but before commit",async()=>{
    const client=setup(true,false);
    await expect(submitProposal("test",request())).rejects.toMatchObject({status:409,code:"segment_locked"});
    const locking=client.query.mock.calls.find(([sql])=>String(sql).includes("FOR UPDATE OF s"));
    expect(String(locking?.[0])).toContain("NOT EXISTS(SELECT 1 FROM sloptogether.story_batch_items");
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("INSERT INTO sloptogether.proposals"))).toBe(false);
  });

  it("still accepts a proposal for a normal unlocked future segment",async()=>{
    const client=setup(true,true);
    await expect(submitProposal("test",request())).resolves.toMatchObject({segmentId:segment,state:"pending"});
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("INSERT INTO sloptogether.proposals"))).toBe(true);
  });
});
