import { createHash } from "node:crypto";
import { compileH3StoryPrompt } from "@sloptogether/contracts";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";

const mocks=vi.hoisted(()=>({transaction:vi.fn(),query:vi.fn(),findChannel:vi.fn(),isBanned:vi.fn(),canContribute:vi.fn(),requestPrincipal:vi.fn(),signedPrivateReadUrl:vi.fn(),screenPromptAndImages:vi.fn(),hmacKeySecret:vi.fn(),randomSecret:vi.fn(),signUploadTicket:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("./db",()=>({transaction:mocks.transaction,query:mocks.query}));
vi.mock("./channels",()=>({findChannel:mocks.findChannel,isBanned:mocks.isBanned,canContribute:mocks.canContribute,requireStreamerController:vi.fn()}));
vi.mock("./principals",()=>({requestPrincipal:mocks.requestPrincipal,requireKeyScope:(grant:{scopes:string[]},scope:string)=>{if(!grant.scopes.includes(scope))throw new Error("scope_denied")}}));
vi.mock("./session",()=>({currentSession:vi.fn(),sessionOverview:vi.fn()}));
vi.mock("./twitch-subs",()=>({getModeratedChannelIds:vi.fn()}));
vi.mock("./crypto",()=>({hmacKeySecret:mocks.hmacKeySecret,randomSecret:mocks.randomSecret,signUploadTicket:mocks.signUploadTicket}));
vi.mock("./storage",()=>({signedPrivateReadUrl:mocks.signedPrivateReadUrl}));
vi.mock("./preflight",()=>({screenPromptAndImages:mocks.screenPromptAndImages}));
vi.mock("./proxy-client-ip",()=>({trustedProxyClientIp:vi.fn()}));

import { claimStoryProducer,claimWorkerLease,createPairing,downloadWorkerAsset,submitStoryProposal } from "./worker-service";

const channel={twitch_channel_id:"123",owner_twitch_user_id:"42",policy_revision:7};
const grant={keyId:"producer-key",issuingTwitchUserId:"42",channelId:"123",scopes:["story:write_future"],roles:["story-producer"],recipes:[],paired:false,platform:null};
const producerLeaseExpires=new Date(Date.now()+60_000);
const sceneSeed="00000000-0000-4000-8000-000000000011";

function claimClient(activeClaim:boolean,ownerBudgetCapUsd="1.0000",reservedUsd="0"){
  const calls:Array<{sql:string;values?:unknown[]}>=[];
  const client={query:vi.fn(async(sql:string,values?:unknown[])=>{
    calls.push({sql,values});
    if(sql.includes("SELECT policy_revision,subscriber_interrupt_policy"))return {rows:[{policy_revision:7,subscriber_interrupt_policy:{enabled:false},owner_budget_cap_usd:ownerBudgetCapUsd}],rowCount:1};
    if(sql.includes("SELECT id FROM sloptogether.trusted_executions"))return {rows:[{id:"binding"}],rowCount:1};
    if(sql.includes("SELECT id,fence,last_sequence,lease_expires_at,execution_binding_id"))return {rows:[{id:"producer",fence:"1",last_sequence:"0",lease_expires_at:producerLeaseExpires,execution_binding_id:"binding"}],rowCount:1};
    if(sql.includes("SELECT id,idempotency_key,expected_channel_revision,input_payload"))return {rows:[{id:"attempt",idempotency_key:"00000000-0000-4000-8000-000000000010",expected_channel_revision:7,input_payload:{theme:"A kind forest",sceneSeed}}],rowCount:1};
    if(sql.includes("SELECT coalesce(sum(greatest(reserved_usd"))return {rows:[{total:reservedUsd}],rowCount:1};
    if(sql.includes("UPDATE sloptogether.story_plan_attempts")&&sql.includes("RETURNING claim_token"))return activeClaim?{rows:[],rowCount:0}:{rows:[{claim_token:values?.[3]}],rowCount:1};
    return {rows:[],rowCount:1};
  })};
  return {client,calls};
}

function leaseRequest(){return new Request("https://clips.gg/sloptogether/api/v1/channels/channel/story-producer/leases",{method:"POST"})}

describe("worker render lease claims",()=>{
  it("locks the current execution binding before touching jobs so revocation cannot miss the lease",async()=>{
    const calls:string[]=[];
    const client={query:vi.fn(async(sql:string,_values?:unknown[])=>{
      void _values;
      calls.push(sql);
      if(sql.includes("SELECT policy_revision FROM sloptogether.channels"))return {rows:[{policy_revision:7}],rowCount:1};
      if(sql.includes("SELECT id FROM sloptogether.trusted_executions WHERE twitch_channel_id"))return {rows:[{id:"binding"}],rowCount:1};
      if(sql.includes("SELECT count(*)::text AS count FROM sloptogether.job_attempts"))return {rows:[{count:"0"}],rowCount:1};
      if(sql.includes("SELECT j.id,j.twitch_channel_id"))return {rows:[],rowCount:0};
      return {rows:[],rowCount:0};
    })};
    mocks.requestPrincipal.mockResolvedValue({kind:"worker-key",worker:{...grant,keyId:"render-key",scopes:["worker:upscale"],roles:["upscale"]}});
    mocks.transaction.mockImplementation(async(work:(db:typeof client)=>Promise<unknown>)=>work(client));

    await expect(claimWorkerLease(new Request("https://clips.gg/sloptogether/api/v1/workers/leases?role=upscale",{method:"POST"})))
      .resolves.toEqual({status:"empty"});
    const bindingLock=calls.findIndex(sql=>sql.includes("SELECT id FROM sloptogether.trusted_executions WHERE twitch_channel_id"));
    const leaseCleanup=calls.findIndex(sql=>sql.includes("SELECT a.id,a.job_id,j.segment_revision_id"));
    expect(bindingLock).toBeGreaterThan(-1);
    expect(leaseCleanup).toBeGreaterThan(bindingLock);
    expect(calls[bindingLock]).toContain("ORDER BY id FOR UPDATE");
  });

  it("returns no lease after the execution binding has been revoked",async()=>{
    const client={query:vi.fn(async(sql:string)=>sql.includes("SELECT policy_revision FROM sloptogether.channels")
      ?{rows:[{policy_revision:7}],rowCount:1}:sql.includes("SELECT id FROM sloptogether.trusted_executions WHERE twitch_channel_id")
        ?{rows:[],rowCount:0}:{rows:[],rowCount:0})};
    mocks.requestPrincipal.mockResolvedValue({kind:"worker-key",worker:{...grant,keyId:"render-key",scopes:["worker:upscale"],roles:["upscale"]}});
    mocks.transaction.mockImplementation(async(work:(db:typeof client)=>Promise<unknown>)=>work(client));

    await expect(claimWorkerLease(new Request("https://clips.gg/sloptogether/api/v1/workers/leases?role=upscale",{method:"POST"})))
      .resolves.toEqual({status:"empty"});
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("SELECT a.id,a.job_id,j.segment_revision_id"))).toBe(false);
  });

  it("allows a Twitch-paired WSL2 client to claim the Linux Comfy recipe path",async()=>{
    const calls:string[]=[];
    const client={query:vi.fn(async(sql:string)=>{
      calls.push(sql);
      if(sql.includes("SELECT policy_revision FROM sloptogether.channels"))return {rows:[{policy_revision:7}],rowCount:1};
      if(sql.includes("SELECT id FROM sloptogether.trusted_executions WHERE twitch_channel_id"))return {rows:[{id:"binding"}],rowCount:1};
      if(sql.includes("SELECT count(*)::text AS count FROM sloptogether.job_attempts"))return {rows:[{count:"0"}],rowCount:1};
      if(sql.includes("SELECT j.id,j.twitch_channel_id"))return {rows:[],rowCount:0};
      return {rows:[],rowCount:1};
    })};
    mocks.requestPrincipal.mockResolvedValue({kind:"worker-key",worker:{...grant,keyId:"wsl-worker",scopes:["worker:generation"],roles:["generation"],paired:true,platform:"wsl"}});
    mocks.canContribute.mockResolvedValue(true);
    mocks.transaction.mockImplementation(async(work:(db:typeof client)=>Promise<unknown>)=>work(client));

    await expect(claimWorkerLease(new Request("https://clips.gg/sloptogether/api/v1/workers/leases?role=generation",{method:"POST"})))
      .resolves.toEqual({status:"empty"});
    expect(calls.some(sql=>sql.includes("SELECT j.id,j.twitch_channel_id"))).toBe(true);
  });

  it("stores WSL2 as a distinct pairing platform",async()=>{
    const client={query:vi.fn(async(sql:string,_values?:unknown[])=>{
      void _values;
      if(sql.includes("request_ip_hash"))return {rows:[{n:"0"}],rowCount:1};
      if(sql.includes("approved_at IS NULL AND expires_at>now()"))return {rows:[{n:"0"}],rowCount:1};
      if(sql.includes("requested_device->>'installationId'"))return {rows:[{n:"0"}],rowCount:1};
      return {rows:[],rowCount:1};
    })};
    mocks.randomSecret.mockReturnValue("AQEBAQEBAQEBAQEBAQ");
    mocks.hmacKeySecret.mockReturnValue(Buffer.alloc(32,1));
    mocks.transaction.mockImplementation(async(work:(db:typeof client)=>Promise<unknown>)=>work(client));
    const request=new Request("https://clips.gg/sloptogether/api/v1/workers/pairings",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
      installationId:"00000000-0000-4000-8000-000000000031",displayName:"Windows WSL2 GPU worker",platform:"wsl",roles:["generation"],clientVersion:"0.1.0",
    })});

    await expect(createPairing(request)).resolves.toMatchObject({pairingId:expect.any(String),userCode:expect.any(String)});
    const insert=client.query.mock.calls.find(([sql])=>String(sql).includes("INSERT INTO sloptogether.worker_pairings"));
    expect(JSON.parse(String(insert?.[1]?.[3])).platform).toBe("wsl");
  });

  it("requires audio on upscale leases so the worker rejects a soundtrack-dropping output",async()=>{
    const job={
      id:"00000000-0000-4000-8000-000000000021",twitch_channel_id:"123",segment_revision_id:"00000000-0000-4000-8000-000000000022",
      interrupt_id:null,stage:"video_upscale",recipe_id:"sol-h3-upscale-pruna-fast",recipe_sha256:Buffer.alloc(32,1),input_sha256:Buffer.alloc(32,2),
      planning_payload:{outputWidth:1920,outputHeight:1080},funding_id:null,prompt:"Preserve the scene and soundtrack.",start_boundary_revision_id:null,
      start_frame_asset_id:null,end_boundary_revision_id:null,end_frame_asset_id:null,source_asset_id:"00000000-0000-4000-8000-000000000023",
      width:1920,height:1080,output_width:1920,output_height:1080,fps_num:24,fps_den:1,frame_count:362,
      attempt_id:"00000000-0000-4000-8000-000000000024",fence:"1",deadline:new Date(Date.now()+60_000),execution_binding_id:"binding",
    };
    const client={query:vi.fn(async(sql:string)=>{
      if(sql.includes("SELECT policy_revision FROM sloptogether.channels"))return {rows:[{policy_revision:7}],rowCount:1};
      if(sql.includes("SELECT id FROM sloptogether.trusted_executions WHERE twitch_channel_id"))return {rows:[{id:"binding"}],rowCount:1};
      if(sql.includes("SELECT count(*)::text AS count FROM sloptogether.job_attempts"))return {rows:[{count:"0"}],rowCount:1};
      if(sql.includes("SELECT j.id,j.twitch_channel_id"))return {rows:[job],rowCount:1};
      return {rows:[],rowCount:1};
    })};
    mocks.requestPrincipal.mockResolvedValue({kind:"worker-key",worker:{...grant,keyId:"render-key",scopes:["worker:upscale"],roles:["upscale"]}});
    mocks.transaction.mockImplementation(async(work:(db:typeof client)=>Promise<unknown>)=>work(client));

    await expect(claimWorkerLease(new Request("https://clips.gg/sloptogether/api/v1/workers/leases?role=upscale",{method:"POST"})))
      .resolves.toMatchObject({status:"leased",job:{stage:"upscale",requireAudio:true}});
  });
});

describe("worker private media grants",()=>{
  it("issues a short signed ticket only after checking the live lease and channel-scoped asset",async()=>{
    const leaseId="00000000-0000-4000-8000-000000000071";
    const assetId="00000000-0000-4000-8000-000000000072";
    const now=Date.now();
    mocks.requestPrincipal.mockResolvedValue({kind:"worker-key",worker:{keyId:"generation-key",issuingTwitchUserId:"42",channelId:"123",scopes:["worker:generation"],roles:["generation"],recipes:[],paired:false}});
    mocks.query.mockResolvedValue({rows:[{fence:"7",attempt_state:"running",lease_expires_at:new Date(now+60_000),deadline:new Date(now+120_000),channel_id:"123",stage:"video_base",key_id:"generation-key",binding_role:"generation",binding_revoked_at:null,requested_by:"42",interrupt_actor_id:null,parent_asset_id:null,start_asset_id:assetId,end_asset_id:null,asset_id:assetId,storage_key:"private/123/images/asset/frame.png",content_type:"image/png",byte_size:"141261",status:"approved",screen_clear:true}],rowCount:1});
    mocks.isBanned.mockResolvedValue(false);
    mocks.signUploadTicket.mockReturnValue("signed-short-lived-ticket");
    vi.stubEnv("SLOPTOGETHER_UPLOAD_WORKER_ORIGIN","https://uploads.clips.gg");

    const response=await downloadWorkerAsset(leaseId,assetId,new Request(`https://www.clips.gg/sloptogether/api/v1/workers/leases/${leaseId}/asset/${assetId}`,{headers:{Authorization:"SlopWorker test", "x-lease-fence":"7"}}));

    expect(response).toEqual({url:"https://uploads.clips.gg/worker-media",ticket:"signed-short-lived-ticket"});
    expect(mocks.signUploadTicket).toHaveBeenCalledWith(expect.objectContaining({version:1,purpose:"worker_asset_read",channelId:"123",leaseId,assetId,fence:7,
      storageKey:"private/123/images/asset/frame.png",contentType:"image/png",byteSize:141261}));
    const ticket=mocks.signUploadTicket.mock.calls[0]![0] as {expiresAt:string};
    expect(Date.parse(ticket.expiresAt)).toBeGreaterThan(Date.now());
    expect(Date.parse(ticket.expiresAt)).toBeLessThanOrEqual(Date.now()+60_000);
  });

  it("rejects a gateway override outside the pinned upload host",async()=>{
    vi.stubEnv("SLOPTOGETHER_UPLOAD_WORKER_ORIGIN","https://attacker.example");
    await expect(downloadWorkerAsset("00000000-0000-4000-8000-000000000071","00000000-0000-4000-8000-000000000072",
      new Request("https://www.clips.gg/sloptogether/api/v1/workers/leases/lease/asset/asset",{headers:{Authorization:"SlopWorker test", "x-lease-fence":"7"}})))
      .rejects.toMatchObject({code:"upload_gateway_not_configured"});
    expect(mocks.signUploadTicket).not.toHaveBeenCalled();
  });
});

beforeEach(()=>{
  vi.resetAllMocks();
  vi.stubEnv("SLOPTOGETHER_GENERATION_ATTEMPT_RESERVATION_USD","0.55");
  mocks.findChannel.mockResolvedValue(channel);
  mocks.isBanned.mockResolvedValue(false);
  mocks.canContribute.mockResolvedValue(false);
  mocks.requestPrincipal.mockResolvedValue({kind:"worker-key",worker:grant});
  mocks.randomSecret.mockReturnValue("AQEBAQEBAQEBAQEBAQ");
  mocks.signedPrivateReadUrl.mockResolvedValue("https://private.example/start.png");
  mocks.screenPromptAndImages.mockResolvedValue({decision:"clear",digest:"a".repeat(64)});
});
afterEach(()=>vi.unstubAllEnvs());

describe("story producer planning claims",()=>{
  it("does not claim a paid planning attempt when its render budget is unavailable",async()=>{
    const {client}=claimClient(false,"0.0000");
    mocks.transaction.mockImplementation(async(work:(db:typeof client)=>Promise<unknown>)=>work(client));

    await expect(claimStoryProducer("channel",leaseRequest())).rejects.toMatchObject({status:409,code:"owner_generation_budget_unavailable"});
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("SET claim_token"))).toBe(false);
  });

  it("does not pay for a story plan when existing reservations exhaust the owner cap",async()=>{
    const {client}=claimClient(false,"0.5500","0.5500");
    mocks.transaction.mockImplementation(async(work:(db:typeof client)=>Promise<unknown>)=>work(client));

    await expect(claimStoryProducer("channel",leaseRequest())).rejects.toMatchObject({status:409,code:"owner_generation_budget_exhausted"});
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("SET claim_token"))).toBe(false);
  });

  it("does not hand the same active plan to a concurrent process",async()=>{
    const {client}=claimClient(true);
    mocks.transaction.mockImplementation(async(work:(db:typeof client)=>Promise<unknown>)=>work(client));

    await expect(claimStoryProducer("channel",leaseRequest())).resolves.toEqual({status:"empty"});
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("claim_expires_at<=now()"))).toBe(true);
  });

  it("reclaims an expired plan with a new token and the same scene seed/idempotency identity",async()=>{
    const {client}=claimClient(false);
    mocks.transaction.mockImplementation(async(work:(db:typeof client)=>Promise<unknown>)=>work(client));

    await expect(claimStoryProducer("channel",leaseRequest())).resolves.toMatchObject({
      idempotencyKey:"00000000-0000-4000-8000-000000000010",
      claimToken:expect.any(String),
      storyContext:{sceneSeed},
    });
    const update=client.query.mock.calls.find(([sql])=>String(sql).includes("RETURNING claim_token"));
    expect(update?.[0]).toContain("input_payload ? 'sceneSeed'");
  });

  it("persists the initial claim token and scene seed with the new attempt",async()=>{
    const calls:Array<{sql:string;values?:unknown[]}>=[];
    const client={query:vi.fn(async(sql:string,values?:unknown[])=>{
      calls.push({sql,values});
      if(sql.includes("SELECT policy_revision,subscriber_interrupt_policy"))return {rows:[{policy_revision:7,subscriber_interrupt_policy:{enabled:false},owner_budget_cap_usd:"1.0000"}],rowCount:1};
      if(sql.includes("SELECT id FROM sloptogether.trusted_executions"))return {rows:[{id:"binding"}],rowCount:1};
      if(sql.includes("SELECT id,fence,last_sequence,lease_expires_at,execution_binding_id"))return {rows:[{id:"producer",fence:"1",last_sequence:"0",lease_expires_at:producerLeaseExpires,execution_binding_id:"binding"}],rowCount:1};
      if(sql.includes("SELECT id,idempotency_key,expected_channel_revision,input_payload"))return {rows:[],rowCount:0};
      if(sql.includes("SELECT c.story_world_prompt"))return {rows:[{story_world_prompt:"A kind forest",recent_story_summary:"A fox arrived",recent_dialogue:"Hello there."}],rowCount:1};
      if(sql.includes("SELECT ir.id,ir.subscriber_label,ir.plan_payload"))return {rows:[],rowCount:0};
      return {rows:[],rowCount:1};
    })};
    mocks.transaction.mockImplementation(async(work:(db:typeof client)=>Promise<unknown>)=>work(client));

    const lease=await claimStoryProducer("channel",leaseRequest()) as {
      claimToken:string;idempotencyKey:string;storyContext:{sceneSeed:string};
    };
    const insert=calls.find(call=>call.sql.includes("INSERT INTO sloptogether.story_plan_attempts"));
    const stored=JSON.parse(String(insert?.values?.[6]));
    expect(lease.claimToken).toBe(insert?.values?.[7]);
    expect(lease.idempotencyKey).toBe(insert?.values?.[4]);
    expect(lease.storyContext.sceneSeed).toBe(stored.sceneSeed);
  });

  it("cannot submit a subscriber plan as an ordinary story when interruptId is omitted",async()=>{
    const bytes=Buffer.from("synthetic-start-image");
    const digest=createHash("sha256").update(bytes).digest();
    mocks.query.mockImplementation(async(sql:string)=>sql.includes("SELECT coalesce(r.requested_end_boundary_revision_id")
      ?{rows:[{boundary_id:"boundary",resolution_id:null,source_revision_id:"source",source_segment_id:"segment"}],rowCount:1}
      :sql.includes("SELECT a.storage_key,a.content_type")
        ?{rows:[{storage_key:"private/123/start.png",content_type:"image/png",byte_size:String(bytes.length),sha256:digest}],rowCount:1}
        :{rows:[],rowCount:0});
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(bytes,{status:200})));
    const client={query:vi.fn(async(sql:string)=>sql.includes("SELECT policy_revision,owner_budget_cap_usd")
      ?{rows:[{policy_revision:7,owner_budget_cap_usd:"100"}],rowCount:1}
      :sql.includes("SELECT id,fence,lease_expires_at,last_sequence FROM sloptogether.story_producers")
        ?{rows:[{id:"00000000-0000-4000-8000-000000000014",fence:"1",lease_expires_at:new Date(Date.now()+60_000),last_sequence:"0"}],rowCount:1}
        :sql.includes("SELECT id,expected_channel_revision,input_payload FROM sloptogether.story_plan_attempts")
          ?{rows:[{id:"attempt",expected_channel_revision:7,input_payload:{interruptId:"subscriber-request"}}],rowCount:1}
          :{rows:[],rowCount:1})};
    mocks.transaction.mockImplementation(async(work:(db:typeof client)=>Promise<unknown>)=>work(client));
    const plan={visualAction:"A friendly fox waves beside a star map.",camera:"One continuous wide shot.",speakerId:"S1",speakerCharacter:"a cartoon fox",voiceDescription:"a warm curious voice",dialogue:"Hello, stars!",soundscape:"Soft forest chimes.",music:"none" as const};
    const compiledH3Prompt=compileH3StoryPrompt(plan);
    const request=new Request("https://clips.gg/sloptogether/api/v1/channels/channel/story-proposals",{
      method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({leaseId:"00000000-0000-4000-8000-000000000014",fence:1,sequence:1,idempotencyKey:"00000000-0000-4000-8000-000000000012",claimToken:"00000000-0000-4000-8000-000000000013",plan,compiledH3Prompt}),
    });
    await expect(submitStoryProposal("channel",request)).rejects.toMatchObject({status:409,code:"story_plan_interrupt_binding_mismatch"});
    expect(client.query).toHaveBeenCalledTimes(3);
  });
});
