import { createHmac } from "node:crypto";
import { beforeEach,afterEach,describe,expect,it,vi } from "vitest";
import type { ChannelRow } from "./channels";
import type { RequestPrincipal } from "./principals";

const mocks=vi.hoisted(()=>({query:vi.fn(),transaction:vi.fn(),requestPrincipal:vi.fn(),currentSession:vi.fn(),moderatedChannels:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("./db",()=>({query:mocks.query,transaction:mocks.transaction,DatabaseUnavailable:class extends Error{}}));
vi.mock("./database",()=>({publicAppUrl:()=>new URL("https://clips.gg/sloptogether")}));
vi.mock("./session",()=>({currentSession:mocks.currentSession}));
vi.mock("./principals",()=>({requestPrincipal:mocks.requestPrincipal,requireKeyScope:(grant:{scopes:string[]},scope:string)=>{if(!grant.scopes.includes(scope))throw new Error("scope_denied")}}));
vi.mock("./twitch-subs",()=>({getModeratedChannelIds:mocks.moderatedChannels}));
vi.mock("./twitch",()=>({decryptTwitchAccess:()=>"fresh-token"}));

import { canContribute,canModerate,canReviewContent,listPublicChannels } from "./channels";
import { decideArtifactReview,decideReview,ownerBudgetSummary,sessionOverview,updateChannelSettings } from "./channel-service";
import { reservationUsd } from "./reservation";
import { verifyExtensionBitsReceipt,verifyExtensionRequest } from "./extension-auth";
import { claimWorkerLease } from "./worker-service";
import { castBallot } from "./voting-service";

const channel:ChannelRow={
  twitch_channel_id:"123",owner_twitch_user_id:"1",twitch_login:"channel",display_name:"Channel",visibility:"public",is_enabled:true,
  policy_revision:1,contribution_mode:"any_non_banned_twitch_user",contributor_whitelist:[],reviewer_whitelist:["2"],
  upload_approval_bypass_ids:[],role_based_upload_bypass:[],subscriber_interrupt_policy:{},story_world_prompt:"Private story world",
  h3_style_profile:"trim",owner_budget_cap_usd:"100",layout_revision:1,chat_voting_enabled:false,
  preair_upscale_enabled:false,preair_upscale_wait_seconds:1200,
};
const reviewer={kind:"session",session:{id:"reviewer-session",twitchUserId:"2",twitchLogin:"reviewer",displayName:"Reviewer",accessToken:"token",scopes:[],expiresAt:new Date(Date.now()+60_000)}} as RequestPrincipal;
const worker={kind:"worker-key",worker:{keyId:"worker-key",issuingTwitchUserId:"2",channelId:"123",scopes:["worker:generation"],roles:["generation"],recipes:[],paired:true,platform:"linux"}} as RequestPrincipal;

function request(body:unknown){return new Request("https://clips.gg/sloptogether/api/v1/channels/channel/settings",{method:"PATCH",headers:{Origin:"https://clips.gg","Content-Type":"application/json"},body:JSON.stringify(body)});}
function jwt(payload:Record<string,unknown>){
  const header=Buffer.from(JSON.stringify({alg:"HS256",typ:"JWT"})).toString("base64url");
  const encoded=Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature=createHmac("sha256",Buffer.alloc(32,7)).update(`${header}.${encoded}`).digest("base64url");
  return `${header}.${encoded}.${signature}`;
}

beforeEach(()=>{
  vi.resetAllMocks();
  vi.stubEnv("PUBLIC_APP_URL","https://clips.gg/sloptogether");
  vi.stubEnv("TWITCH_EXTENSION_CLIENT_ID","extension-client");
  vi.stubEnv("TWITCH_EXTENSION_SECRET_CURRENT",Buffer.alloc(32,7).toString("base64"));
  mocks.requestPrincipal.mockResolvedValue(reviewer);
  mocks.moderatedChannels.mockResolvedValue(new Set<string>());
  mocks.query.mockImplementation(async(sql:string)=>({rows:sql.includes("FROM sloptogether.channels")?[channel]:[],rowCount:sql.includes("FROM sloptogether.channels")?1:0}));
});
afterEach(()=>{vi.unstubAllEnvs();});

describe("channel access boundaries",()=>{
  it("reports Twitch sign-in readiness without exposing credentials",async()=>{
    vi.stubEnv("TWITCH_CLIENT_ID","");
    vi.stubEnv("TWITCH_CLIENT_SECRET","");
    mocks.currentSession.mockResolvedValue(null);
    await expect(sessionOverview(new Request("https://clips.gg/sloptogether/api/v1/auth/session")))
      .resolves.toMatchObject({authenticated:false,configured:{twitchOAuth:false}});
    vi.stubEnv("TWITCH_CLIENT_ID","client-id");
    vi.stubEnv("TWITCH_CLIENT_SECRET","client-secret");
    vi.stubEnv("DATABASE_URL","postgresql://postgres@127.0.0.1:56432/sloptogether");
    vi.stubEnv("SLOPTOGETHER_TOKEN_ENCRYPTION_KEY",Buffer.alloc(32,7).toString("base64"));
    await expect(sessionOverview(new Request("https://clips.gg/sloptogether/api/v1/auth/session")))
      .resolves.toMatchObject({authenticated:false,configured:{twitchOAuth:true}});
  });

  it("reports lifetime owner budget remaining without allowing negative balances",()=>{
    expect(ownerBudgetSummary("0.5500","0.5500",0.55)).toEqual({ownerBudgetCommittedUsd:0.55,ownerBudgetRemainingUsd:0,ownerGenerationAttemptReservationUsd:0.55,ownerBudgetRemainingAttempts:0});
    expect(ownerBudgetSummary("1.0000","0.2750",0.55)).toEqual({ownerBudgetCommittedUsd:0.275,ownerBudgetRemainingUsd:0.725,ownerGenerationAttemptReservationUsd:0.55,ownerBudgetRemainingAttempts:1});
    expect(ownerBudgetSummary("0.1000","0.2000",null)).toEqual({ownerBudgetCommittedUsd:0.2,ownerBudgetRemainingUsd:0,ownerGenerationAttemptReservationUsd:null,ownerBudgetRemainingAttempts:null});
  });

  it("reports only a valid rounded per-scene reservation",()=>{
    vi.stubEnv("SLOPTOGETHER_GENERATION_ATTEMPT_RESERVATION_USD","0.55001");
    expect(reservationUsd("SLOPTOGETHER_GENERATION_ATTEMPT_RESERVATION_USD")).toBe(0.5501);
    vi.stubEnv("SLOPTOGETHER_SUBSCRIBER_ATTEMPT_RESERVATION_USD","0.12501");
    expect(reservationUsd("SLOPTOGETHER_SUBSCRIBER_ATTEMPT_RESERVATION_USD")).toBe(0.1251);
    vi.stubEnv("SLOPTOGETHER_GENERATION_ATTEMPT_RESERVATION_USD","0");
    expect(reservationUsd("SLOPTOGETHER_GENERATION_ATTEMPT_RESERVATION_USD")).toBeNull();
  });

  it("validates Twitch-signed Bits receipts before an intent can be bound",()=>{
    const receipt=jwt({topic:"bits_transaction_receipt",domainID:"twitch.extextension-client",exp:Math.floor(Date.now()/1000)+60,
      data:{transactionId:"transaction-1",userId:"2",time:new Date().toISOString()}});
    expect(verifyExtensionBitsReceipt(receipt)).toMatchObject({transactionId:"transaction-1",userId:"2",inDevelopment:false});
    const wrongDomain=jwt({topic:"bits_transaction_receipt",domainID:"twitch.extanother-extension",exp:Math.floor(Date.now()/1000)+60,
      data:{transactionId:"transaction-1",userId:"2",time:new Date().toISOString()}});
    expect(()=>verifyExtensionBitsReceipt(wrongDomain)).toThrow("bits_receipt_payload_invalid");
    const [header,payload,signature]=receipt.split(".");
    const invalidSignature=`${header}.${payload}.${signature?.[0]==="A"?"B":"A"}${signature?.slice(1)}`;
    expect(()=>verifyExtensionBitsReceipt(invalidSignature)).toThrow("bits_receipt_signature_invalid");
  });

  it("accepts signed linked and unlinked viewers while rejecting invalid linked IDs",()=>{
    const payload={channel_id:"123",exp:Math.floor(Date.now()/1000)+300,opaque_user_id:"U-opaque-viewer",role:"viewer",user_id:"2",is_unlinked:false};
    expect(verifyExtensionRequest(new Request("https://clips.gg",{headers:{"x-extension-jwt":jwt(payload)}})).linkedTwitchUserId).toBe("2");
    expect(()=>verifyExtensionRequest(new Request("https://clips.gg",{headers:{"x-extension-jwt":jwt({...payload,user_id:"bad-id"})}}))).toThrow("invalid_extension_user_id");
    const unlinked={...payload,is_unlinked:true};delete (unlinked as {user_id?:string}).user_id;
    expect(verifyExtensionRequest(new Request("https://clips.gg",{headers:{"x-extension-jwt":jwt(unlinked)}})).linkedTwitchUserId).toBeNull();
  });

  it("allows the local Extension preview origin only in explicit development demo mode",()=>{
    const token=jwt({channel_id:"123",exp:Math.floor(Date.now()/1000)+300,opaque_user_id:"U-local-viewer",role:"viewer",user_id:"2",client_id:"extension-client"});
    const request=new Request("http://localhost:3000/sloptogether/extension",{headers:{Origin:"http://localhost:3000","x-extension-jwt":token}});
    vi.stubEnv("NODE_ENV","development");
    vi.stubEnv("NEXT_PUBLIC_LOCAL_DEMO_ENABLED","true");
    expect(verifyExtensionRequest(request).channelId).toBe("123");
    vi.stubEnv("NEXT_PUBLIC_LOCAL_DEMO_ENABLED","false");
    expect(()=>verifyExtensionRequest(request)).toThrow("extension_origin_not_allowed");
    vi.stubEnv("NEXT_PUBLIC_LOCAL_DEMO_ENABLED","true");
    vi.stubEnv("NODE_ENV","production");
    expect(()=>verifyExtensionRequest(request)).toThrow("extension_origin_not_allowed");
  });

  it("lets allowlisted reviewers review content without gaining moderator or settings authority",async()=>{
    mocks.moderatedChannels.mockRejectedValue(new Error("Twitch unavailable"));
    expect(await canReviewContent(channel,reviewer)).toBe(true);
    expect(await canModerate(channel,reviewer)).toBe(false);
    await expect(updateChannelSettings("channel",request({uploadApprovalBypassIds:["2"],ownerBudgetCapUsd:500}))).rejects.toMatchObject({status:403,code:"streamer_control_required"});
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects subscriber lifecycle settings from the generic settings endpoint",async()=>{
    mocks.requestPrincipal.mockResolvedValue({kind:"session",session:{twitchUserId:"1"}});
    await expect(updateChannelSettings("channel",request({subscriberInterrupts:{enabled:true}}))).rejects.toThrow();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("keeps automated holds in place when a reviewer approves the proposal",async()=>{
    const client={query:vi.fn().mockResolvedValue({rows:[{id:"proposal",state:"pending",election_id:"election",segment_id:"segment",input_screen_id:"screen",effective_state:"held"}],rowCount:1})};
    mocks.transaction.mockImplementation(async(callback:(value:typeof client)=>Promise<unknown>)=>callback(client));
    await expect(decideReview("channel","proposal",request({decision:"approve",reason:""}))).rejects.toMatchObject({status:409,code:"input_screen_not_clear"});
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it("returns only the public channel projection in the directory contract",async()=>{
    expect(await listPublicChannels()).toEqual({channels:[{twitchChannelId:"123",twitchLogin:"channel",displayName:"Channel"}]});
    expect(mocks.query.mock.calls[0]?.[0]).not.toMatch(/whitelist|bypass|budget|story_world_prompt/);
  });

  it("rechecks paired worker contribution modes instead of inheriting reviewer authority",async()=>{
    expect(await canContribute(channel,worker)).toBe(true);
    expect(await canContribute({...channel,contribution_mode:"explicit_allowlist",contributor_whitelist:["2"]},worker)).toBe(true);
    expect(await canContribute({...channel,contribution_mode:"explicit_allowlist"},worker)).toBe(false);
    expect(await canContribute({...channel,contribution_mode:"broadcaster_and_moderators"},worker)).toBe(false);
    mocks.query.mockImplementation(async(sql:string)=>({rows:sql.includes("FROM sloptogether.sessions")?[{access_token_encrypted:Buffer.from("token")}]:[],rowCount:0}));
    mocks.moderatedChannels.mockResolvedValue(new Set(["123"]));
    expect(await canContribute({...channel,contribution_mode:"broadcaster_and_moderators"},worker)).toBe(true);
    mocks.moderatedChannels.mockResolvedValue(new Set());
    expect(await canContribute({...channel,contribution_mode:"broadcaster_and_moderators"},worker)).toBe(false);
  });

  it("does not let a channel-scoped worker key cast a viewer ballot",async()=>{
    await expect(castBallot("election","proposal",worker,"website")).rejects.toMatchObject({status:403,code:"voter_identity_required"});
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("checks ballot bans on the held transaction client",async()=>{
    const client={query:vi.fn(async(sql:string)=>{
      if(sql.includes("FOR UPDATE OF e"))return {rows:[{id:"election",closes_at:new Date(Date.now()+60_000),state:"open",twitch_channel_id:"123"}],rowCount:1};
      if(sql.startsWith("SELECT 1 FROM sloptogether.bans"))return {rows:[],rowCount:0};
      if(sql.includes("FROM sloptogether.proposals"))return {rows:[{}],rowCount:1};
      if(sql.includes("INSERT INTO sloptogether.ballots"))return {rows:[{revision:1}],rowCount:1};
      return {rows:[],rowCount:1};
    })};
    mocks.transaction.mockImplementation(async(callback:(value:typeof client)=>Promise<unknown>)=>callback(client));
    const voter={kind:"session",session:{id:"voter-session",twitchUserId:"7",twitchLogin:"viewer",displayName:"Viewer",accessToken:"token",scopes:[],expiresAt:new Date(Date.now()+60_000)}} as RequestPrincipal;

    await expect(castBallot("election","proposal",voter,"website")).resolves.toEqual({electionId:"election",choiceId:"proposal",state:"recorded"});
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("FROM sloptogether.bans"))).toBe(true);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("rejects a paired Windows GPU claim before the API can lease work",async()=>{
    mocks.requestPrincipal.mockResolvedValue({kind:"worker-key",worker:{keyId:"windows-worker",issuingTwitchUserId:"2",channelId:"123",scopes:["worker:upscale"],roles:["upscale"],recipes:[],paired:true,platform:"windows"}});
    await expect(claimWorkerLease(new Request("https://clips.gg/sloptogether/api/v1/workers/leases?role=upscale",{method:"POST"})))
      .rejects.toMatchObject({status:409,code:"worker_platform_unqualified"});
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("records approval for an exact validated video and queues publication",async()=>{
    const asset={id:"video-asset",sha256:Buffer.alloc(32,4),status:"validated",uploaded_by_twitch_user_id:"3",input_screen_id:"screen",effective_state:"clear",screen_expires_at:new Date(Date.now()+60_000),stage:"video_base",job_id:"job",attempt_id:"attempt",segment_revision_id:"revision",segment_id:"segment",funding_id:"funding"};
    const client={query:vi.fn(async(sql:string,values?:unknown[])=>sql.includes("FOR UPDATE OF s")&&values?.[0]==="video-asset"?{rows:[{id:"segment",selected_revision_id:"revision",state:"rendering",revision_id:"revision"}],rowCount:1}:sql.includes("FROM sloptogether.assets a JOIN sloptogether.job_attempts")?{rows:[asset],rowCount:1}:{rows:[],rowCount:1})};
    mocks.transaction.mockImplementation(async(callback:(value:typeof client)=>Promise<unknown>)=>callback(client));
    await expect(decideArtifactReview("channel","video-asset",request({decision:"approve",reason:""}))).resolves.toMatchObject({state:"approved",publicationPending:true});
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("media.publish_requested"))).toBe(true);
    expect(client.query.mock.calls.find(([sql])=>String(sql).includes("UPDATE sloptogether.job_attempts SET state=$2"))?.[1]).toEqual(["attempt","succeeded",null]);
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("segment_revisions SET state='ready'")&&String(sql).includes("'selected'"))).toBe(true);
  });

  function subscriberReviewClient(interruptState="rendering",enabled=true,expiresAt=new Date(Date.now()+60_000),interruptId:string|null="interrupt"){
    const asset={id:"subscriber-video",sha256:Buffer.alloc(32,5),status:"validated",uploaded_by_twitch_user_id:"3",
      input_screen_id:"screen",effective_state:"clear",stage:"video_base",job_id:"job",attempt_id:"attempt",
      segment_revision_id:null,segment_id:null,interrupt_id:interruptId,funding_id:null};
    return {query:vi.fn(async(sql:string)=>{
      if(sql.includes("FOR UPDATE OF s"))return {rows:[],rowCount:0};
      if(sql.includes("FROM sloptogether.assets a JOIN sloptogether.job_attempts"))return {rows:[asset],rowCount:1};
      if(sql.includes("FROM sloptogether.interrupt_requests ir JOIN"))return {rows:[{program_state:interruptState,enabled,expires_at:expiresAt}],rowCount:1};
      return {rows:[],rowCount:1};
    })};
  }

  it.each(["approve","reject"])("allows a reviewer to %s a subscriber clip without a story segment",async decision=>{
    const client=subscriberReviewClient();
    mocks.transaction.mockImplementation(async(callback:(value:typeof client)=>Promise<unknown>)=>callback(client));
    await expect(decideArtifactReview("channel","subscriber-video",request({decision,reason:"Reviewed subscriber clip"})))
      .resolves.toMatchObject({state:decision==="approve"?"approved":"rejected",publicationPending:decision==="approve"});
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("INSERT INTO sloptogether.artifact_approvals"))).toBe(true);
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("UPDATE sloptogether.segment_revisions"))).toBe(false);
  });

  it.each([
    {state:"cancelled",enabled:true,expiresAt:new Date(Date.now()+60_000)},
    {state:"rendering",enabled:false,expiresAt:new Date(Date.now()+60_000)},
    {state:"rendering",enabled:true,expiresAt:new Date(0)},
  ])("keeps subscriber eligibility checks when no story segment exists: %j",async({state,enabled,expiresAt})=>{
    const client=subscriberReviewClient(state,enabled,expiresAt);
    mocks.transaction.mockImplementation(async(callback:(value:typeof client)=>Promise<unknown>)=>callback(client));
    await expect(decideArtifactReview("channel","subscriber-video",request({decision:"approve",reason:""})))
      .rejects.toMatchObject({status:409,code:"subscriber_interrupt_no_longer_eligible"});
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("INSERT INTO sloptogether.artifact_approvals"))).toBe(false);
  });

  it("still rejects an orphaned story artifact without a selected segment",async()=>{
    const client=subscriberReviewClient("rendering",true,new Date(Date.now()+60_000),null);
    mocks.transaction.mockImplementation(async(callback:(value:typeof client)=>Promise<unknown>)=>callback(client));
    await expect(decideArtifactReview("channel","subscriber-video",request({decision:"approve",reason:""})))
      .rejects.toMatchObject({status:409,code:"artifact_segment_missing"});
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("INSERT INTO sloptogether.artifact_approvals"))).toBe(false);
  });
});
