import { createHash } from "node:crypto";
import { compileH3StoryPrompt } from "@sloptogether/contracts";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";

const mocks=vi.hoisted(()=>({transaction:vi.fn(),query:vi.fn(),findChannel:vi.fn(),getStream:vi.fn(),isBanned:vi.fn(),canContribute:vi.fn(),requestPrincipal:vi.fn(),requireStreamerController:vi.fn(),signedPrivateReadUrl:vi.fn(),screenPromptAndImages:vi.fn(),hmacKeySecret:vi.fn(),randomSecret:vi.fn(),signUploadTicket:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("./db",()=>({transaction:mocks.transaction,query:mocks.query}));
vi.mock("./channels",()=>({findChannel:mocks.findChannel,isBanned:mocks.isBanned,canContribute:mocks.canContribute,requireStreamerController:mocks.requireStreamerController}));
vi.mock("./stream-service",()=>({getStream:mocks.getStream}));
vi.mock("./principals",()=>({requestPrincipal:mocks.requestPrincipal,requireKeyScope:(grant:{scopes:string[]},scope:string)=>{if(!grant.scopes.includes(scope))throw new Error("scope_denied")}}));
vi.mock("./session",()=>({currentSession:vi.fn(),sessionOverview:vi.fn()}));
vi.mock("./twitch-subs",()=>({getModeratedChannelIds:vi.fn()}));
vi.mock("./crypto",()=>({hmacKeySecret:mocks.hmacKeySecret,randomSecret:mocks.randomSecret,signUploadTicket:mocks.signUploadTicket}));
vi.mock("./storage",()=>({signedPrivateReadUrl:mocks.signedPrivateReadUrl}));
vi.mock("./preflight",()=>({screenPromptAndImages:mocks.screenPromptAndImages}));
vi.mock("./proxy-client-ip",()=>({trustedProxyClientIp:vi.fn()}));

import { claimStoryProducer,claimWorkerLease,createPairing,downloadWorkerAsset,requestClipUpscale,submitStoryProposal } from "./worker-service";

const channel={twitch_channel_id:"123",owner_twitch_user_id:"42",policy_revision:7,owner_budget_cap_usd:"0.0000"};
const grant={keyId:"producer-key",issuingTwitchUserId:"42",channelId:"123",scopes:["story:write_future"],roles:["story-producer"],recipes:[],paired:false,platform:null};
const producerLeaseExpires=new Date(Date.now()+60_000);
const sceneSeed="00000000-0000-4000-8000-000000000011";
const batchItemId="00000000-0000-4000-8000-000000000016";

function claimClient(activeClaim:boolean,ownerBudgetCapUsd="1.0000",reservedUsd="0"){
  const calls:Array<{sql:string;values?:unknown[]}>=[];
  const client={query:vi.fn(async(sql:string,values?:unknown[]):Promise<{rows:unknown[];rowCount:number}>=>{
    calls.push({sql,values});
    if(sql.includes("SELECT policy_revision,subscriber_interrupt_policy"))return {rows:[{policy_revision:7,subscriber_interrupt_policy:{enabled:false},owner_budget_cap_usd:ownerBudgetCapUsd}],rowCount:1};
    if(sql.includes("SELECT id FROM sloptogether.trusted_executions"))return {rows:[{id:"binding"}],rowCount:1};
    if(sql.includes("SELECT id,fence,last_sequence,lease_expires_at,execution_binding_id"))return {rows:[{id:"producer",fence:"1",last_sequence:"0",lease_expires_at:producerLeaseExpires,execution_binding_id:"binding"}],rowCount:1};
    if(sql.includes("SELECT id,idempotency_key,expected_channel_revision,input_payload"))return {rows:[{id:"attempt",idempotency_key:"00000000-0000-4000-8000-000000000010",expected_channel_revision:7,input_payload:{theme:"A kind forest",sceneSeed,batchItemId}}],rowCount:1};
    if(sql.includes("FROM sloptogether.story_batch_items i JOIN"))return {rows:[{id:batchItemId,position:0,previous_state:null,previous_segment_id:null}],rowCount:1};
    if(sql.includes("SELECT s.id AS segment_id,r.state AS revision_state"))return {rows:[{segment_id:"source",revision_state:"ready",boundary_id:"boundary",asset_status:"approved"}],rowCount:1};
    if(sql.includes("JOIN LATERAL(SELECT s.id,s.state,s.selected_revision_id"))return {rows:[],rowCount:0};
    if(sql.includes("SELECT coalesce(sum(greatest(reserved_usd"))return {rows:[{total:reservedUsd}],rowCount:1};
    if(sql.includes("UPDATE sloptogether.story_plan_attempts")&&sql.includes("RETURNING claim_token"))return activeClaim?{rows:[],rowCount:0}:{rows:[{claim_token:values?.[3]}],rowCount:1};
    return {rows:[],rowCount:1};
  })};
  return {client,calls};
}

function leaseRequest(){return new Request("https://clips.gg/sloptogether/api/v1/channels/channel/story-producer/leases",{method:"POST"})}

describe("worker render lease claims",()=>{
  it("stores the low-resolution output profile when an election schedules a new base render",async()=>{
    const job={id:"00000000-0000-4000-8000-000000000031",twitch_channel_id:"123",segment_revision_id:"00000000-0000-4000-8000-000000000032",interrupt_id:null,stage:"video_base",
      recipe_id:"fast-h3-trim-5step-vsa20-b1",recipe_sha256:Buffer.alloc(32,1),input_sha256:Buffer.alloc(32,1),
      planning_payload:{inputScreenId:"screen",outputWidth:512,outputHeight:288},funding_id:null,prompt:"A cartoon fox finds a map.",
      start_boundary_revision_id:"00000000-0000-4000-8000-000000000033",start_frame_asset_id:"00000000-0000-4000-8000-000000000034",end_boundary_revision_id:null,end_frame_asset_id:null,source_asset_id:null,
      width:448,height:256,output_width:512,output_height:288,fps_num:24,fps_den:1,frame_count:362,attempt_id:"00000000-0000-4000-8000-000000000035",
      fence:"1",deadline:new Date(Date.now()+60_000),execution_binding_id:"binding"};
    const client={query:vi.fn(async(sql:string)=>{
      if(sql.includes("SELECT policy_revision FROM sloptogether.channels"))return {rows:[{policy_revision:7}],rowCount:1};
      if(sql.includes("SELECT id FROM sloptogether.trusted_executions WHERE twitch_channel_id"))return {rows:[{id:"binding"}],rowCount:1};
      if(sql.includes("SELECT e.id,e.segment_id FROM sloptogether.elections"))return {rows:[{id:"election",segment_id:"segment"}],rowCount:1};
      if(sql.includes("SELECT p.id AS proposal_id"))return {rows:[{proposal_id:"proposal",revision_id:"revision",author_id:"42",start_boundary_id:"boundary",end_boundary_id:null,planning_mode:"continuation",recipe_id:"fast-h3-trim-5step-vsa20-b1",input_sha256:Buffer.alloc(32,1),input_screen_id:"screen"}],rowCount:1};
      if(sql.includes("SELECT 1 FROM sloptogether.boundary_revisions"))return {rows:[{}],rowCount:1};
      if(sql.includes("SELECT count(*)::text AS count FROM sloptogether.job_attempts"))return {rows:[{count:"0"}],rowCount:1};
      if(sql.includes("SELECT j.id,j.twitch_channel_id"))return {rows:[job],rowCount:1};
      return {rows:[],rowCount:0};
    })};
    mocks.requestPrincipal.mockResolvedValue({kind:"worker-key",worker:{...grant,keyId:"render-key",scopes:["worker:generation"],roles:["generation"]}});
    mocks.transaction.mockImplementation(async(work:(db:typeof client)=>Promise<unknown>)=>work(client));
    const result=await claimWorkerLease(new Request("https://clips.gg/sloptogether/api/v1/workers/leases?role=generation",{method:"POST"}));
    const insert=client.query.mock.calls.find(([sql])=>String(sql).includes("INSERT INTO sloptogether.jobs"));
    expect(insert).toBeDefined();
    const values=(insert as unknown as [string,unknown[]])[1];
    expect(JSON.parse(String(values[8]))).toMatchObject({inputScreenId:"screen",outputWidth:512,outputHeight:288});
    expect(result).toMatchObject({status:"leased",job:{jobId:"00000000-0000-4000-8000-000000000031",recipeId:"fast-h3-trim-5step-vsa20-b1",width:448,height:256,frameCount:362}});
  });

  it.each([
    {outputWidth:512,outputHeight:288,planningPayload:{outputWidth:512,outputHeight:288}},
    {outputWidth:1280,outputHeight:720,planningPayload:{}},
  ])("leases base artifact dimensions $outputWidth×$outputHeight while retaining the model render size",async({outputWidth,outputHeight,planningPayload})=>{
    const job={id:"00000000-0000-4000-8000-000000000021",twitch_channel_id:"123",segment_revision_id:"00000000-0000-4000-8000-000000000022",
      interrupt_id:null,stage:"video_base",recipe_id:"fast-h3-trim-5step-vsa20-b1",recipe_sha256:Buffer.alloc(32,1),input_sha256:Buffer.alloc(32,2),
      planning_payload:planningPayload,funding_id:null,prompt:"A fox discovers a map.",start_boundary_revision_id:null,
      start_frame_asset_id:"00000000-0000-4000-8000-000000000023",end_boundary_revision_id:null,end_frame_asset_id:null,source_asset_id:null,
      width:1280,height:720,output_width:outputWidth,output_height:outputHeight,fps_num:24,fps_den:1,frame_count:362,
      attempt_id:"00000000-0000-4000-8000-000000000024",fence:"1",deadline:new Date(Date.now()+60_000),execution_binding_id:"binding"};
    let claimSql="";
    const client={query:vi.fn(async(sql:string)=>{
      if(sql.includes("SELECT policy_revision FROM sloptogether.channels"))return {rows:[{policy_revision:7}],rowCount:1};
      if(sql.includes("SELECT id FROM sloptogether.trusted_executions WHERE twitch_channel_id"))return {rows:[{id:"binding"}],rowCount:1};
      if(sql.includes("SELECT count(*)::text AS count FROM sloptogether.job_attempts"))return {rows:[{count:"0"}],rowCount:1};
      if(sql.includes("SELECT j.id,j.twitch_channel_id")){claimSql=sql;return {rows:[job],rowCount:1};}
      return {rows:[],rowCount:0};
    })};
    mocks.requestPrincipal.mockResolvedValue({kind:"worker-key",worker:{...grant,keyId:"render-key",scopes:["worker:generation"],roles:["generation"]}});
    mocks.transaction.mockImplementation(async(work:(db:typeof client)=>Promise<unknown>)=>work(client));
    await expect(claimWorkerLease(new Request("https://clips.gg/sloptogether/api/v1/workers/leases?role=generation",{method:"POST"})))
      .resolves.toMatchObject({status:"leased",job:{width:448,height:256,outputWidth,outputHeight}});
    expect(claimSql).toContain("coalesce(nullif(j.planning_payload->>'outputWidth','')::int,CASE WHEN j.stage='video_upscale' THEN 1920 ELSE c.output_width END)");
  });

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

  it.each([
    {width:1184,height:666,planningPayload:{outputWidth:1184,outputHeight:666},recipeId:"sol-h3-upscale-pruna-fast-1184-v1",advertised:["sol-h3-upscale-pruna-fast-1184-v1"]},
    {width:1920,height:1080,planningPayload:{outputWidth:1920,outputHeight:1080},recipeId:"sol-h3-upscale-pruna-fast",advertised:undefined},
    {width:1920,height:1080,planningPayload:{},recipeId:"sol-h3-upscale-pruna-fast",advertised:undefined},
  ])("leases the planned upscale target $width×$height, including legacy jobs",async({width,height,planningPayload,recipeId,advertised})=>{
    const job={
      id:"00000000-0000-4000-8000-000000000021",twitch_channel_id:"123",segment_revision_id:"00000000-0000-4000-8000-000000000022",
      interrupt_id:null,stage:"video_upscale",recipe_id:recipeId,recipe_sha256:Buffer.alloc(32,1),input_sha256:Buffer.alloc(32,2),
      planning_payload:planningPayload,funding_id:null,prompt:"Preserve the scene and soundtrack.",start_boundary_revision_id:null,
      start_frame_asset_id:null,end_boundary_revision_id:null,end_frame_asset_id:null,source_asset_id:"00000000-0000-4000-8000-000000000023",
      width,height,output_width:width,output_height:height,fps_num:24,fps_den:1,frame_count:362,
      attempt_id:"00000000-0000-4000-8000-000000000024",fence:"1",deadline:new Date(Date.now()+60_000),execution_binding_id:"binding",
    };
    let claimSql="";
    const client={query:vi.fn(async(sql:string)=>{
      if(sql.includes("SELECT policy_revision FROM sloptogether.channels"))return {rows:[{policy_revision:7}],rowCount:1};
      if(sql.includes("SELECT id FROM sloptogether.trusted_executions WHERE twitch_channel_id"))return {rows:[{id:"binding"}],rowCount:1};
      if(sql.includes("SELECT count(*)::text AS count FROM sloptogether.job_attempts"))return {rows:[{count:"0"}],rowCount:1};
      if(sql.includes("SELECT j.id,j.twitch_channel_id")){claimSql=sql;return {rows:[job],rowCount:1};}
      return {rows:[],rowCount:1};
    })};
    mocks.requestPrincipal.mockResolvedValue({kind:"worker-key",worker:{...grant,keyId:"render-key",scopes:["worker:upscale"],roles:["upscale"]}});
    mocks.transaction.mockImplementation(async(work:(db:typeof client)=>Promise<unknown>)=>work(client));

    const request=new Request("https://clips.gg/sloptogether/api/v1/workers/leases?role=upscale",{method:"POST",...(advertised?{headers:{"Content-Type":"application/json"},body:JSON.stringify({supportedRecipes:advertised})}:{})});
    await expect(claimWorkerLease(request))
      .resolves.toMatchObject({status:"leased",job:{stage:"upscale",requireAudio:true,width,height,outputWidth:width,outputHeight:height}});
    expect(claimSql).toContain("coalesce(nullif(j.planning_payload->>'outputWidth','')::int,CASE WHEN j.stage='video_upscale' THEN 1920 ELSE c.output_width END)");
    expect(claimSql).toContain("coalesce(nullif(j.planning_payload->>'outputWidth','')::int,1920) AS width");
  });
});

describe("upscale requests",()=>{
  it.each([
    {sourceWidth:512,sourceHeight:288,outputWidth:1184,outputHeight:666,recipeId:"sol-h3-upscale-pruna-fast-1184-v1",hash:"8bd316e466037db6e4ec4e9b0b3c6b010274020df16c1609e788bb97b8fd6848"},
    {sourceWidth:1280,sourceHeight:720,outputWidth:1920,outputHeight:1080,recipeId:"sol-h3-upscale-pruna-fast",hash:"e0b4949fbbc02e31b0dc697fc2bedc5a7a1efe57d5d96fe908013d89a3bf8b8c"},
  ])("pins $outputWidth×$outputHeight for a $sourceWidth×$sourceHeight source",async({sourceWidth,sourceHeight,outputWidth,outputHeight,recipeId,hash})=>{
    vi.stubEnv("PUBLIC_APP_URL","https://www.clips.gg/sloptogether");
    const client={query:vi.fn(async(sql:string,_values?:unknown[])=>{
      void _values;
      if(sql.includes("SELECT twitch_channel_id FROM sloptogether.channels"))return {rows:[{twitch_channel_id:"123"}],rowCount:1};
      if(sql.includes("SELECT a.id AS asset_id"))return {rows:[{asset_id:"asset",segment_revision_id:"revision",stream_id:"stream-main",sha256:Buffer.alloc(32),screen_id:"screen",width:sourceWidth,height:sourceHeight}],rowCount:1};
      return {rows:[],rowCount:1};
    })};
    mocks.transaction.mockImplementation(async(work:(db:typeof client)=>Promise<unknown>)=>work(client));
    const request=new Request("https://www.clips.gg/sloptogether/api/v1/channels/channel/upscale",{method:"POST",headers:{Origin:"https://www.clips.gg","Content-Type":"application/json"},body:JSON.stringify({programItemId:"00000000-0000-4000-8000-000000000001"})});
    await expect(requestClipUpscale("channel",request)).resolves.toMatchObject({accepted:true,existing:false});
    const insert=client.query.mock.calls.find(([sql])=>String(sql).includes("INSERT INTO sloptogether.jobs"));
    expect(insert?.[1]?.[3]).toBe(recipeId);
    expect((insert?.[1]?.[4] as Buffer).toString("hex")).toBe(hash);
    expect(JSON.parse(String(insert?.[1]?.[8]))).toMatchObject({inputScreenId:"screen",outputWidth,outputHeight});
    expect(insert?.[1]?.[9]).toBe("stream-main");
  });

  it("limits a stream request to clips on that stream",async()=>{
    vi.stubEnv("PUBLIC_APP_URL","https://www.clips.gg/sloptogether");
    const client={query:vi.fn(async(sql:string)=>sql.includes("SELECT a.id AS asset_id")?{rows:[],rowCount:0}:{rows:[{}],rowCount:1})};
    mocks.transaction.mockImplementation(async(work:(db:typeof client)=>Promise<unknown>)=>work(client));
    const request=new Request("https://www.clips.gg/sloptogether/api/v1/channels/channel/streams/main/upscale",{method:"POST",headers:{Origin:"https://www.clips.gg","Content-Type":"application/json"},body:JSON.stringify({programItemId:"00000000-0000-4000-8000-000000000001"})});
    await expect(requestClipUpscale("channel",request,"main")).rejects.toMatchObject({status:404,code:"approved_story_clip_not_found"});
    const source=client.query.mock.calls.find(([sql])=>String(sql).includes("SELECT a.id AS asset_id"));
    expect(source?.[0]).toContain("pi.stream_id=$3");
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("INSERT INTO sloptogether.jobs"))).toBe(false);
  });

  it.each([{width:1920,height:1080,code:"clip_already_at_upscale_target"},{width:512,height:256,code:"clip_dimensions_invalid"}])
  ("rejects an invalid or non-enlargeable source",async({width,height,code})=>{
    vi.stubEnv("PUBLIC_APP_URL","https://www.clips.gg/sloptogether");
    const client={query:vi.fn(async(sql:string)=>sql.includes("SELECT a.id AS asset_id")
      ?{rows:[{asset_id:"asset",segment_revision_id:"revision",sha256:Buffer.alloc(32),screen_id:"screen",width,height}],rowCount:1}
      :{rows:[{}],rowCount:1})};
    mocks.transaction.mockImplementation(async(work:(db:typeof client)=>Promise<unknown>)=>work(client));
    const request=new Request("https://www.clips.gg/sloptogether/api/v1/channels/channel/upscale",{method:"POST",headers:{Origin:"https://www.clips.gg","Content-Type":"application/json"},body:JSON.stringify({programItemId:"00000000-0000-4000-8000-000000000001"})});
    await expect(requestClipUpscale("channel",request)).rejects.toMatchObject({status:409,code});
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("INSERT INTO sloptogether.jobs"))).toBe(false);
  });
});

describe("recipe capability admission",()=>{
  it.each([
    {label:"legacy worker",offered:undefined,restricted:[],expected:"sol-h3-upscale-pruna-fast"},
    {label:"upgraded worker",offered:["sol-h3-upscale-pruna-fast-1184-v1","sol-h3-upscale-pruna-fast"],restricted:[],expected:"sol-h3-upscale-pruna-fast-1184-v1"},
    {label:"restricted binding",offered:["sol-h3-upscale-pruna-fast-1184-v1"],restricted:["sol-h3-upscale-pruna-fast"],expected:null},
    {label:"no supported recipes",offered:[],restricted:[],expected:null},
  ])("filters queued jobs for $label",async({offered,restricted,expected})=>{
    const legacy="sol-h3-upscale-pruna-fast",low="sol-h3-upscale-pruna-fast-1184-v1";
    const makeJob=(recipeId:string,width:number,height:number,id:string)=>({id,twitch_channel_id:"123",segment_revision_id:"00000000-0000-4000-8000-000000000022",
      interrupt_id:null,stage:"video_upscale",recipe_id:recipeId,recipe_sha256:Buffer.alloc(32,1),input_sha256:Buffer.alloc(32,2),
      planning_payload:{outputWidth:width,outputHeight:height},funding_id:null,prompt:"Preserve the scene.",start_boundary_revision_id:null,
      start_frame_asset_id:null,end_boundary_revision_id:null,end_frame_asset_id:null,source_asset_id:"00000000-0000-4000-8000-000000000023",
      width,height,output_width:width,output_height:height,fps_num:24,fps_den:1,frame_count:362,
      attempt_id:"00000000-0000-4000-8000-000000000024",fence:"1",deadline:new Date(Date.now()+60_000),execution_binding_id:"binding"});
    const queued=[makeJob(low,1184,666,"00000000-0000-4000-8000-000000000020"),makeJob(legacy,1920,1080,"00000000-0000-4000-8000-000000000021")];
    let claimSql="",claimValues:unknown[]=[];
    const client={query:vi.fn(async(sql:string,values?:unknown[])=>{
      if(sql.includes("SELECT policy_revision FROM sloptogether.channels"))return {rows:[{policy_revision:7}],rowCount:1};
      if(sql.includes("SELECT id FROM sloptogether.trusted_executions WHERE twitch_channel_id"))return {rows:[{id:"binding"}],rowCount:1};
      if(sql.includes("SELECT count(*)::text AS count FROM sloptogether.job_attempts"))return {rows:[{count:"0"}],rowCount:1};
      if(sql.includes("SELECT j.id,j.twitch_channel_id")){
        claimSql=sql;claimValues=values??[];
        const supported=values?.[5] as string[];
        const allowedByBinding=restricted as string[];
        const selected=queued.find(job=>supported.includes(job.recipe_id)&&(!allowedByBinding.length||allowedByBinding.includes(job.recipe_id)));
        return {rows:selected?[selected]:[],rowCount:selected?1:0};
      }
      return {rows:[],rowCount:0};
    })};
    mocks.requestPrincipal.mockResolvedValue({kind:"worker-key",worker:{...grant,keyId:"render-key",scopes:["worker:upscale"],roles:["upscale"]}});
    mocks.transaction.mockImplementation(async(work:(db:typeof client)=>Promise<unknown>)=>work(client));
    const request=new Request("https://clips.gg/sloptogether/api/v1/workers/leases?role=upscale",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(offered===undefined?{}:{supportedRecipes:offered})});
    const result=await claimWorkerLease(request);
    if(expected)expect(result).toMatchObject({status:"leased",job:{recipeId:expected}});
    else expect(result).toEqual({status:"empty"});
    expect(claimValues[5]).toEqual(offered??[legacy]);
    expect(claimSql).toContain("j.recipe_id=ANY($6::text[])");
    expect(claimSql).toContain("cardinality(te.recipe_ids)=0 OR j.recipe_id=ANY(te.recipe_ids)");
    expect(claimSql).toContain("j.execution_mode='pull_worker'");
    expect(claimSql).toContain("j.recipe_id=$7 AND coalesce(nullif(j.planning_payload->>'outputWidth','')::int,1920)=1920");
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
    const assetId="00000000-0000-4000-8000-000000000072";
    mocks.requestPrincipal.mockResolvedValue({kind:"worker-key",worker:{keyId:"generation-key",issuingTwitchUserId:"42",channelId:"123",scopes:["worker:generation"],roles:["generation"],recipes:[],paired:false}});
    mocks.query.mockResolvedValue({rows:[{fence:"7",attempt_state:"running",lease_expires_at:new Date(Date.now()+60_000),deadline:new Date(Date.now()+120_000),channel_id:"123",stage:"video_base",key_id:"generation-key",binding_role:"generation",binding_revoked_at:null,requested_by:"42",interrupt_actor_id:null,parent_asset_id:null,start_asset_id:assetId,end_asset_id:null,asset_id:assetId,storage_key:"private/123/images/asset/frame.png",content_type:"image/png",byte_size:"141261",status:"approved",screen_clear:true}],rowCount:1});
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
  mocks.getStream.mockResolvedValue({id:"stream-main",twitch_channel_id:"123",slug:"main",display_name:"Main stream",is_default:true});
  mocks.requireStreamerController.mockResolvedValue("42");
  mocks.isBanned.mockResolvedValue(false);
  mocks.canContribute.mockResolvedValue(false);
  mocks.requestPrincipal.mockResolvedValue({kind:"worker-key",worker:grant});
  mocks.randomSecret.mockReturnValue("AQEBAQEBAQEBAQEBAQ");
  mocks.signedPrivateReadUrl.mockResolvedValue("https://private.example/start.png");
  mocks.screenPromptAndImages.mockResolvedValue({decision:"clear",digest:"a".repeat(64)});
});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals()});

describe("story producer planning claims",()=>{
  it.each([
    {position:1,previous_state:"scheduled",previous_segment_id:"source"},
    {position:1,previous_state:"pending",previous_segment_id:null},
  ])("plans a future candidate without waiting for an earlier rendered endpoint: %j",async scenario=>{
    const {client}=claimClient(false);
    const original=client.query.getMockImplementation()!;
    client.query.mockImplementation(async(sql:string,values?:unknown[])=>{
      if(sql.includes("FROM sloptogether.story_batch_items i JOIN"))return {rows:[{id:batchItemId,...scenario}],rowCount:1};
      return original(sql,values);
    });
    mocks.transaction.mockImplementation(async(work:(db:typeof client)=>Promise<unknown>)=>work(client));
    await expect(claimStoryProducer("channel",leaseRequest())).resolves.toMatchObject({batchItemId,storyContext:{sceneSeed}});
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("SELECT s.id AS segment_id,r.state AS revision_state"))).toBe(false);
    expect(mocks.screenPromptAndImages).not.toHaveBeenCalled();
  });

  it("pins 512×288 when the story producer schedules a subscriber render",async()=>{
    const subscriber=true;
    const bytes=Buffer.from("synthetic-start-image");
    const imageSha=createHash("sha256").update(bytes).digest();
    const interruptId="00000000-0000-4000-8000-000000000019";
    mocks.query.mockImplementation(async(sql:string)=>sql.includes("SELECT coalesce(r.requested_end_boundary_revision_id")
      ?{rows:[{boundary_id:"boundary",resolution_id:null,source_revision_id:"source",source_segment_id:"segment"}],rowCount:1}
      :sql.includes("SELECT a.storage_key,a.content_type")
        ?{rows:[{storage_key:"private/123/start.png",content_type:"image/png",byte_size:String(bytes.length),sha256:imageSha}],rowCount:1}
        :{rows:[],rowCount:0});
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(bytes,{status:200})));
    const calls:Array<{sql:string;values?:unknown[]}> = [];
    const client={query:vi.fn(async(sql:string,values?:unknown[])=>{
      calls.push({sql,values});
      if(sql.includes("SELECT policy_revision,subscriber_interrupt_policy,output_width"))return {rows:[{policy_revision:7,subscriber_interrupt_policy:{enabled:true},output_width:1280,output_height:720}],rowCount:1};
      if(sql.includes("SELECT policy_revision,owner_budget_cap_usd"))return {rows:[{policy_revision:7,owner_budget_cap_usd:"100"}],rowCount:1};
      if(sql.includes("SELECT id,fence,lease_expires_at,last_sequence,stream_id FROM sloptogether.story_producers"))return {rows:[{id:"producer",fence:"1",lease_expires_at:new Date(Date.now()+60_000),last_sequence:"0",stream_id:"stream-main"}],rowCount:1};
      if(sql.includes("expected_channel_revision,input_payload FROM sloptogether.story_plan_attempts"))return {rows:[{id:"attempt",expected_channel_revision:7,input_payload:subscriber?{interruptId}:{batchItemId}}],rowCount:1};
      if(sql.includes("FROM sloptogether.story_batch_items i JOIN"))return {rows:[{id:batchItemId,position:0,previous_state:null,previous_segment_id:null}],rowCount:1};
      if(sql.includes("SELECT s.id AS segment_id,r.state AS revision_state"))return {rows:[{segment_id:"source",revision_state:"ready",boundary_id:"boundary",asset_status:"approved"}],rowCount:1};
      if(sql.includes("JOIN LATERAL(SELECT s.id,s.state,s.selected_revision_id"))return {rows:[],rowCount:0};
      if(sql.includes("SELECT ir.funding_id,ir.expires_at"))return {rows:[{funding_id:"funding",expires_at:new Date(Date.now()+600_000),trigger_event_id:"event",subscriber_label:"viewer",event_actor_id:null}],rowCount:1};
      if(sql.includes("SELECT coalesce(sum(greatest(reserved_usd"))return {rows:[{total:"0"}],rowCount:1};
      if(sql.includes("SELECT id FROM sloptogether.branches"))return {rows:[{id:"branch"}],rowCount:1};
      if(sql.includes("SELECT id,ordinal::text,state"))return {rows:[],rowCount:0};
      if(sql.includes("SELECT coalesce(r.requested_end_boundary_revision_id"))return {rows:[{boundary_id:"boundary",resolution_id:null,revision_id:"source",segment_id:"segment",frame_asset_id:"frame"}],rowCount:1};
      if(sql.includes("SELECT 1 FROM sloptogether.boundary_revisions"))return {rows:[{}],rowCount:1};
      if(sql.includes("INSERT INTO sloptogether.segments("))return {rows:[{id:"new-segment"}],rowCount:1};
      if(sql.includes("SELECT coalesce(max(revision),0)+1"))return {rows:[{revision:1}],rowCount:1};
      if(sql.includes("INSERT INTO sloptogether.segment_revisions("))return {rows:[{id:"new-revision"}],rowCount:1};
      if(sql.includes("SELECT id FROM sloptogether.input_screens"))return {rows:[{id:"screen"}],rowCount:1};
      return {rows:[],rowCount:1};
    })};
    mocks.transaction.mockImplementation(async(work:(db:typeof client)=>Promise<unknown>)=>work(client));
    const plan={visualAction:"A friendly fox waves beside a star map.",camera:"One continuous wide shot.",speakerId:"S1",speakerCharacter:"a cartoon fox",voiceDescription:"a warm curious voice",dialogue:"Hello, stars!",soundscape:"Soft forest chimes.",music:"none" as const};
    const request=new Request("https://clips.gg/sloptogether/api/v1/channels/channel/story-proposals",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
      leaseId:"00000000-0000-4000-8000-000000000014",fence:1,sequence:1,idempotencyKey:"00000000-0000-4000-8000-000000000012",claimToken:"00000000-0000-4000-8000-000000000013",
      ...(subscriber?{interruptId}:{}),plan,compiledH3Prompt:compileH3StoryPrompt(plan),
    })});
    await expect(submitStoryProposal("channel",request)).resolves.toMatchObject({accepted:true});
    const insert=calls.find(call=>call.sql.includes("INSERT INTO sloptogether.jobs"));
    expect(insert).toBeDefined();
    const payloadValue=insert?.values?.find(value=>typeof value==="string"&&value.includes('"outputWidth"'));
    const payload=JSON.parse(String(payloadValue));
    expect(payload).toMatchObject({inputScreenId:"screen",outputWidth:512,outputHeight:288,...(subscriber?{durationSeconds:10,frameCount:243}:{})});
    if(subscriber)expect(insert?.values?.[4]).toBe("fast-h3-trim-5step-vsa20-b1-10s");
  });

  it.each(["0.0000","0.5500"])("allows free candidate planning independently of owner render budget %s",async cap=>{
    const {client}=claimClient(false,cap,cap);
    mocks.transaction.mockImplementation(async(work:(db:typeof client)=>Promise<unknown>)=>work(client));
    await expect(claimStoryProducer("channel",leaseRequest())).resolves.toMatchObject({batchItemId});
    expect(mocks.screenPromptAndImages).not.toHaveBeenCalled();
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("INSERT INTO sloptogether.jobs"))).toBe(false);
  });

  it("never screens or schedules an approved pair when the owner render budget is exhausted",async()=>{
    mocks.findChannel.mockResolvedValue({...channel,owner_budget_cap_usd:"0.5500"});
    const {client}=claimClient(false,"0.5500","0.5500");
    const original=client.query.getMockImplementation()!;
    client.query.mockImplementation(async(sql:string,values?:unknown[])=>{
      if(sql.includes("SELECT policy_revision,owner_budget_cap_usd"))return {rows:[{policy_revision:7,owner_budget_cap_usd:"0.5500"}],rowCount:1};
      if(sql.includes("SELECT 1 FROM sloptogether.trusted_executions"))return {rows:[{}],rowCount:1};
      return original(sql,values);
    });
    mocks.transaction.mockImplementation(async(work:(db:typeof client)=>Promise<unknown>)=>work(client));
    await expect(claimStoryProducer("channel",leaseRequest())).resolves.toMatchObject({batchItemId});
    expect(mocks.screenPromptAndImages).not.toHaveBeenCalled();
    expect(mocks.signedPrivateReadUrl).not.toHaveBeenCalled();
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("pair_screen_token=$2"))).toBe(false);
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("INSERT INTO sloptogether.jobs"))).toBe(false);
  });

  it("stores an independently planned candidate without screening or creating a render job",async()=>{
    const calls:Array<{sql:string;values?:unknown[]}>=[];
    const client={query:vi.fn(async(sql:string,values?:unknown[])=>{
      calls.push({sql,values});
      if(sql.includes("SELECT policy_revision FROM sloptogether.channels"))return {rows:[{policy_revision:7}],rowCount:1};
      if(sql.includes("SELECT 1 FROM sloptogether.trusted_executions"))return {rows:[{}],rowCount:1};
      if(sql.includes("SELECT fence,lease_expires_at,last_sequence FROM sloptogether.story_producers"))return {rows:[{fence:"1",lease_expires_at:new Date(Date.now()+60_000),last_sequence:"0"}],rowCount:1};
      if(sql.includes("SELECT expected_channel_revision,input_payload FROM sloptogether.story_plan_attempts"))return {rows:[{expected_channel_revision:7,input_payload:{batchItemId}}],rowCount:1};
      if(sql.includes("FROM sloptogether.story_batch_items i JOIN"))return {rows:[{id:batchItemId,position:2,segment_id:"existing-segment"}],rowCount:1};
      if(sql.includes("SET state='planned',candidate_plan"))return {rows:[{candidate_revision:1}],rowCount:1};
      return {rows:[],rowCount:1};
    })};
    mocks.transaction.mockImplementation(async(work:(db:typeof client)=>Promise<unknown>)=>work(client));
    const plan={visualAction:"A friendly fox waves beside a star map.",camera:"One continuous wide shot.",speakerId:"S1",speakerCharacter:"a cartoon fox",voiceDescription:"a warm curious voice",dialogue:"Hello, stars!",soundscape:"Soft forest chimes.",music:"none" as const};
    const request=new Request("https://clips.gg/sloptogether/api/v1/channels/channel/story-proposals",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
      leaseId:"00000000-0000-4000-8000-000000000014",fence:1,sequence:1,idempotencyKey:"00000000-0000-4000-8000-000000000012",claimToken:"00000000-0000-4000-8000-000000000013",plan,compiledH3Prompt:compileH3StoryPrompt(plan),
    })});
    await expect(submitStoryProposal("channel",request)).resolves.toMatchObject({accepted:true,batchItemId,state:"planned"});
    const saved=calls.find(call=>call.sql.includes("SET state='planned',candidate_plan"));
    expect(saved?.values?.[0]).toBe(batchItemId);
    expect(JSON.parse(String(saved?.values?.[1]))).toEqual(plan);
    expect(saved?.values?.[2]).toBe(compileH3StoryPrompt(plan));
    expect(mocks.screenPromptAndImages).not.toHaveBeenCalled();
    expect(mocks.signedPrivateReadUrl).not.toHaveBeenCalled();
    expect(calls.some(call=>call.sql.includes("INSERT INTO sloptogether.jobs"))).toBe(false);
    expect(calls.some(call=>call.sql.includes("INSERT INTO sloptogether.funding_authorizations"))).toBe(false);
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
      if(sql.includes("FROM sloptogether.story_batch_items i JOIN"))return {rows:[{id:batchItemId,position:0,previous_state:null,previous_segment_id:null}],rowCount:1};
      if(sql.includes("SELECT s.id AS segment_id,r.state AS revision_state"))return {rows:[{segment_id:"source",revision_state:"ready",boundary_id:"boundary",asset_status:"approved"}],rowCount:1};
      if(sql.includes("JOIN LATERAL(SELECT s.id,s.state,s.selected_revision_id"))return {rows:[],rowCount:0};
      if(sql.includes("SELECT c.story_world_prompt"))return {rows:[{story_world_prompt:"A kind forest",recent_story_summary:"A fox arrived",recent_dialogue:"Hello there."}],rowCount:1};
      if(sql.includes("SELECT ir.id,ir.subscriber_label,ir.plan_payload"))return {rows:[],rowCount:0};
      return {rows:[],rowCount:1};
    })};
    mocks.transaction.mockImplementation(async(work:(db:typeof client)=>Promise<unknown>)=>work(client));

    const lease=await claimStoryProducer("channel",leaseRequest()) as {
      claimToken:string;idempotencyKey:string;storyContext:{sceneSeed:string};
    };
    const insert=calls.find(call=>call.sql.includes("INSERT INTO sloptogether.story_plan_attempts"));
    const stored=JSON.parse(String(insert?.values?.[7]));
    expect(lease.claimToken).toBe(insert?.values?.[8]);
    expect(lease.idempotencyKey).toBe(insert?.values?.[5]);
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
    const client={query:vi.fn(async(sql:string)=>sql.includes("SELECT policy_revision FROM sloptogether.channels")
      ?{rows:[{policy_revision:7}],rowCount:1}
      :sql.includes("SELECT 1 FROM sloptogether.trusted_executions")
        ?{rows:[{}],rowCount:1}
        :sql.includes("SELECT fence,lease_expires_at,last_sequence FROM sloptogether.story_producers")
          ?{rows:[{fence:"1",lease_expires_at:new Date(Date.now()+60_000),last_sequence:"0"}],rowCount:1}
          :sql.includes("SELECT expected_channel_revision,input_payload FROM sloptogether.story_plan_attempts")
            ?{rows:[{expected_channel_revision:7,input_payload:{interruptId:"subscriber-request"}}],rowCount:1}
            :{rows:[],rowCount:0})};
    mocks.transaction.mockImplementation(async(work:(db:typeof client)=>Promise<unknown>)=>work(client));
    const plan={visualAction:"A friendly fox waves beside a star map.",camera:"One continuous wide shot.",speakerId:"S1",speakerCharacter:"a cartoon fox",voiceDescription:"a warm curious voice",dialogue:"Hello, stars!",soundscape:"Soft forest chimes.",music:"none" as const};
    const compiledH3Prompt=compileH3StoryPrompt(plan);
    const request=new Request("https://clips.gg/sloptogether/api/v1/channels/channel/story-proposals",{
      method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({leaseId:"00000000-0000-4000-8000-000000000014",fence:1,sequence:1,idempotencyKey:"00000000-0000-4000-8000-000000000012",claimToken:"00000000-0000-4000-8000-000000000013",plan,compiledH3Prompt}),
    });
    await expect(submitStoryProposal("channel",request)).rejects.toMatchObject({status:409,code:"story_plan_attempt_not_current"});
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("candidate_plan=$2"))).toBe(false);
    expect(mocks.screenPromptAndImages).not.toHaveBeenCalled();
  });
});
