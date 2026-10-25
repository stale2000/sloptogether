import { createHash } from "node:crypto";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { compileH3StoryPrompt } from "@sloptogether/contracts";

const mocks=vi.hoisted(()=>({transaction:vi.fn(),query:vi.fn(),requestPrincipal:vi.fn(),findChannel:vi.fn(),requireChannelModerator:vi.fn(),screenPromptAndImages:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("./db",()=>({transaction:mocks.transaction,query:mocks.query}));
vi.mock("./principals",()=>({requestPrincipal:mocks.requestPrincipal}));
vi.mock("./channels",()=>({findChannel:mocks.findChannel,requireChannelModerator:mocks.requireChannelModerator}));
vi.mock("./preflight",()=>({screenPromptAndImages:mocks.screenPromptAndImages}));

import { cancelComfyGeneration,createComfyFrameGeneration,createComfyPromptGeneration,getComfyFrameGenerationImage,getComfyGeneration,getComfyPromptGenerationText } from "./comfy-frame-service";

const requestId="73afcad4-d30a-4fd8-9c33-f6c1c277a7bf";
const localId="72afcad4-d30a-4fd8-9c33-f6c1c277a7bf";
const providerId="71afcad4-d30a-4fd8-9c33-f6c1c277a7bf";
const ownerId="456";
const prompt="A friendly little starship finds a lighthouse among the stars.";
const principal={kind:"session",session:{twitchUserId:ownerId}};
const channel={twitch_channel_id:"123",owner_twitch_user_id:ownerId,twitch_login:"demo",display_name:"Demo",is_enabled:true,visibility:"public"};

function request(body:unknown){
  return new Request("http://localhost:3000/sloptogether/api/v1/channels/localdemo/comfy-frame-generations",{
    method:"POST",headers:{Origin:"http://localhost:3000","Content-Type":"application/json"},body:JSON.stringify(body),
  });
}

function client(){
  const row={id:localId,request_id:requestId,twitch_channel_id:"123",requested_by:ownerId,prompt,prompt_sha256:Buffer.alloc(32),
    generation_kind:"frame",generated_text:null,state:"submitting",provider_job_id:null,output_asset_id:null,error_code:null,created_at:new Date(),updated_at:new Date()};
  const calls:string[]=[];
  const db={query:vi.fn(async(sql:string)=>{
    calls.push(sql);
    if(sql.includes("WHERE twitch_channel_id=$1 AND requested_by=$2 AND request_id=$3 FOR UPDATE"))return {rows:[],rowCount:0};
    if(sql.includes("SELECT count(*)::text AS count"))return {rows:[{count:"0"}],rowCount:1};
    if(sql.includes("INSERT INTO sloptogether.comfy_frame_generations"))return {rows:[row],rowCount:1};
    return {rows:[],rowCount:1};
  })};
  return {db,calls,row};
}

beforeEach(()=>{
  vi.resetAllMocks();
  vi.stubEnv("PUBLIC_APP_URL","http://localhost:3000/sloptogether");
  vi.stubEnv("SLOPTOGETHER_COMFY_FRAME_GENERATION_ENABLED","true");
  vi.stubEnv("SLOPTOGETHER_COMFY_PROMPT_GENERATION_ENABLED","true");
  vi.stubEnv("SLOPTOGETHER_COMFY_API_KEY","test-comfy-api-key-with-enough-length");
  vi.stubEnv("SLOPTOGETHER_COMFY_FRAME_GENERATION_CHANNEL_IDS","123");
  vi.stubEnv("SLOPTOGETHER_OPENAI_MODERATION_KEY","test-moderation-key");
  mocks.requestPrincipal.mockReturnValue(principal);
  mocks.findChannel.mockResolvedValue(channel);
  mocks.requireChannelModerator.mockResolvedValue(ownerId);
  mocks.screenPromptAndImages.mockResolvedValue({decision:"clear"});
});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});

describe("Comfy Cloud start-frame generation",()=>{
  it("allows a verified moderator session to manually request a frame",async()=>{
    const moderatorId="789";mocks.requestPrincipal.mockReturnValue({kind:"session",session:{twitchUserId:moderatorId}});
    mocks.requireChannelModerator.mockResolvedValue(moderatorId);
    const {db}=client();mocks.transaction.mockImplementation(async(work:(client:typeof db)=>Promise<unknown>)=>work(db));
    const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({id:providerId,status:"queued",outputs:[]}),{status:201}));
    vi.stubGlobal("fetch",fetch);
    await expect(createComfyFrameGeneration("localdemo",request({requestId,prompt}))).resolves.toMatchObject({kind:"frame",state:"queued"});
    expect(mocks.requireChannelModerator).toHaveBeenCalledWith(channel,{kind:"session",session:{twitchUserId:moderatorId}});
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not let extension or worker credentials generate frames automatically",async()=>{
    const fetch=vi.fn();vi.stubGlobal("fetch",fetch);
    for(const principal of [{kind:"extension",extension:{channelId:"123",role:"broadcaster"}},{kind:"worker-key",worker:{channelId:"123",scopes:["worker:generation"]}}]){
      mocks.requestPrincipal.mockReturnValue(principal);
      await expect(createComfyFrameGeneration("localdemo",request({requestId,prompt}))).rejects.toMatchObject({status:401,code:"login_required"});
    }
    expect(mocks.requireChannelModerator).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("submits one fixed, cropped H3-sized workflow after prompt screening",async()=>{
    vi.stubEnv("SLOPTOGETHER_COMFY_API_KEY","");
    vi.stubEnv("COMFY_API_KEY","test-comfy-api-key-with-enough-length");
    vi.stubEnv("NODE_ENV","development");
    const {db,calls}=client();
    mocks.transaction.mockImplementation(async(work:(client:typeof db)=>Promise<unknown>)=>work(db));
    const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({id:providerId,status:"queued",outputs:[]}),{status:201}));
    vi.stubGlobal("fetch",fetch);

    await expect(createComfyFrameGeneration("localdemo",request({requestId,prompt})))
      .resolves.toMatchObject({id:localId,requestId,state:"queued"});
    expect(mocks.screenPromptAndImages).toHaveBeenCalledWith({channelId:"123",prompt,images:[]});
    expect(calls.some(sql=>sql.includes("comfy-frame-account"))).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url,init]=fetch.mock.calls[0]!;
    expect(url).toBe("https://cloud.comfy.org/api/v2/jobs");
    expect((init as RequestInit).headers).toMatchObject({Authorization:"Bearer test-comfy-api-key-with-enough-length","Idempotency-Key":localId});
    const body=JSON.parse(String((init as RequestInit).body));
    expect(body.extra_data.api_key_comfy_org).toBe("test-comfy-api-key-with-enough-length");
    expect(body.workflow["25"]).toMatchObject({class_type:"OpenAIGPTImageNodeV2",inputs:{
      model:"gpt-image-2.5-flare","model.size":"Custom","model.custom_width":848,"model.custom_height":480,
      "model.quality":"low","model.background":"opaque",n:1,
    }});
    expect(body.workflow["26"].inputs).toMatchObject({width:448,height:256,crop:"center"});
    expect(body.workflow["28"].inputs.images).toEqual(["26",0]);
    expect(calls.some(sql=>sql.includes("INSERT INTO sloptogether.audit_log"))).toBe(true);
  });

  it("submits a cheap Comfy OpenAI Chat prompt workflow with a saved text output",async()=>{
    const {db}=client();mocks.transaction.mockImplementation(async(work:(client:typeof db)=>Promise<unknown>)=>work(db));
    const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({id:providerId,status:"queued",outputs:[]}),{status:201}));
    vi.stubGlobal("fetch",fetch);
    await expect(createComfyPromptGeneration("localdemo",request({requestId,prompt})))
      .resolves.toMatchObject({id:localId,requestId,kind:"prompt",state:"queued"});
    const body=JSON.parse(String((fetch.mock.calls[0]![1] as RequestInit).body));
    expect(body.workflow["3"]).toMatchObject({class_type:"OpenAIChatNode",inputs:{model:"gpt-4.1-nano",persist_context:false}});
    expect(body.workflow["19"]).toMatchObject({class_type:"SaveText",inputs:{text:["3",0],format:"txt"}});
    expect(body.workflow["3"].inputs.prompt).toContain("untrusted descriptive idea data");
  });

  it("recognizes the Comfy Text node output as a completed prompt job",async()=>{
    const row={id:localId,request_id:requestId,twitch_channel_id:"123",requested_by:ownerId,prompt,prompt_sha256:Buffer.alloc(32),generation_kind:"prompt",generated_text:null,state:"running",
      provider_job_id:providerId,output_asset_id:null,error_code:null,created_at:new Date(),updated_at:new Date()};
    mocks.query.mockResolvedValue({rows:[row],rowCount:1});
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({id:providerId,status:"succeeded",outputs:[{
      node_id:"19",type:"text",content_type:"text/plain",size_bytes:512,id:"70afcad4-d30a-4fd8-9c33-f6c1c277a7bf",
    }]}),{status:200})));
    await expect(getComfyGeneration("localdemo",localId,new Request("http://localhost:3000/sloptogether/api/v1/channels/localdemo/comfy-generations/x")))
      .resolves.toMatchObject({kind:"prompt",state:"succeeded"});
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("SET state='succeeded',output_asset_id=$2"),[localId,"70afcad4-d30a-4fd8-9c33-f6c1c277a7bf"]);
  });

  it("keeps ambiguous provider submissions consumed rather than submitting again",async()=>{
    const {db}=client();mocks.transaction.mockImplementation(async(work:(client:typeof db)=>Promise<unknown>)=>work(db));
    const fetch=vi.fn().mockRejectedValue(new Error("connection reset"));vi.stubGlobal("fetch",fetch);
    await expect(createComfyFrameGeneration("localdemo",request({requestId,prompt})))
      .resolves.toMatchObject({id:localId,requestId,state:"uncertain"});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("SET state=$2,error_code=$3"),[localId,"uncertain","comfy_request_uncertain"]);
  });

  it("does not expose a provider output until the prompt and image both pass screening",async()=>{
    const row={id:localId,request_id:requestId,twitch_channel_id:"123",requested_by:ownerId,prompt,prompt_sha256:Buffer.alloc(32),generation_kind:"frame",generated_text:null,state:"succeeded",
      provider_job_id:providerId,output_asset_id:"70afcad4-d30a-4fd8-9c33-f6c1c277a7bf",error_code:null,created_at:new Date(),updated_at:new Date()};
    mocks.query.mockResolvedValue({rows:[row],rowCount:1});
    mocks.screenPromptAndImages.mockResolvedValue({decision:"held"});
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(Buffer.from("png"),{status:200,headers:{"Content-Type":"image/png"}})));
    await expect(getComfyFrameGenerationImage("localdemo",localId,new Request("http://localhost:3000/sloptogether/api/v1/channels/localdemo/comfy-generations/x/frame",{headers:{Origin:"http://localhost:3000"}})))
      .rejects.toMatchObject({status:422,code:"comfy_output_held"});
    expect(mocks.screenPromptAndImages).toHaveBeenCalledWith({channelId:"123",prompt,images:[{bytes:Buffer.from("png"),contentType:"image/png"}]});
  });

  it("returns the generated PNG only after screening clears it",async()=>{
    const row={id:localId,request_id:requestId,twitch_channel_id:"123",requested_by:ownerId,prompt,prompt_sha256:Buffer.alloc(32),generation_kind:"frame",generated_text:null,state:"succeeded",
      provider_job_id:providerId,output_asset_id:"70afcad4-d30a-4fd8-9c33-f6c1c277a7bf",error_code:null,created_at:new Date(),updated_at:new Date()};
    mocks.query.mockResolvedValue({rows:[row],rowCount:1});
    mocks.screenPromptAndImages.mockResolvedValue({decision:"clear"});
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(Buffer.from("png"),{status:200,headers:{"Content-Type":"image/png"}})));
    await expect(getComfyFrameGenerationImage("localdemo",localId,new Request("http://localhost:3000/sloptogether/api/v1/channels/localdemo/comfy-generations/x/frame")))
      .resolves.toMatchObject({bytes:Buffer.from("png")});
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("FROM sloptogether.comfy_frame_generations"),[localId,"123",ownerId]);
  });

  it("returns only a validated H3 prompt after the generated text passes screening",async()=>{
    const plan={visualAction:"A friendly robot waves at the viewer.",camera:"Slow push-in.",speakerId:"S1",speakerCharacter:"a friendly robot",
      voiceDescription:"a curious warm voice",dialogue:"Hello, friend!",soundscape:"Soft, warm chimes.",music:"none" as const};
    const generated=JSON.stringify(plan);const expected=compileH3StoryPrompt(plan);
    const row={id:localId,request_id:requestId,twitch_channel_id:"123",requested_by:ownerId,prompt,prompt_sha256:Buffer.alloc(32),generation_kind:"prompt",generated_text:null,state:"succeeded",
      provider_job_id:providerId,output_asset_id:"70afcad4-d30a-4fd8-9c33-f6c1c277a7bf",error_code:null,created_at:new Date(),updated_at:new Date()};
    mocks.query.mockResolvedValue({rows:[row],rowCount:1});mocks.screenPromptAndImages.mockResolvedValue({decision:"clear"});
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(generated,{status:200,headers:{"Content-Type":"text/plain; charset=utf-8"}})));
    await expect(getComfyPromptGenerationText("localdemo",localId,new Request("http://localhost:3000/sloptogether/api/v1/channels/localdemo/comfy-generations/x/prompt")))
      .resolves.toEqual({text:expected});
    expect(mocks.screenPromptAndImages).toHaveBeenCalledWith({channelId:"123",prompt:expected,images:[]});
  });

  it("rejects malformed Comfy prompt output before it can fill the proposal form",async()=>{
    const row={id:localId,request_id:requestId,twitch_channel_id:"123",requested_by:ownerId,prompt,prompt_sha256:Buffer.alloc(32),generation_kind:"prompt",generated_text:null,state:"succeeded",
      provider_job_id:providerId,output_asset_id:"70afcad4-d30a-4fd8-9c33-f6c1c277a7bf",error_code:null,created_at:new Date(),updated_at:new Date()};
    mocks.query.mockResolvedValue({rows:[row],rowCount:1});
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response("just a plain prompt",{status:200,headers:{"Content-Type":"text/plain"}})));
    await expect(getComfyPromptGenerationText("localdemo",localId,new Request("http://localhost:3000/sloptogether/api/v1/channels/localdemo/comfy-generations/x/prompt")))
      .rejects.toMatchObject({status:422,code:"comfy_prompt_format_invalid"});
    expect(mocks.screenPromptAndImages).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("SET state='failed'"),[localId]);
  });

  it("requests cancellation for the owner job without hiding an unconfirmed cancel",async()=>{
    const row={id:localId,request_id:requestId,twitch_channel_id:"123",requested_by:ownerId,prompt,prompt_sha256:Buffer.alloc(32),generation_kind:"frame",generated_text:null,state:"running",
      provider_job_id:providerId,output_asset_id:null,error_code:null,created_at:new Date(),updated_at:new Date()};
    mocks.query.mockResolvedValue({rows:[row],rowCount:1});
    const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({id:providerId,status:"canceling",outputs:[]}),{status:200}));
    vi.stubGlobal("fetch",fetch);
    await expect(cancelComfyGeneration("localdemo",localId,new Request("http://localhost:3000/sloptogether/api/v1/channels/localdemo/comfy-generations/x/cancel")))
      .resolves.toMatchObject({state:"running"});
    expect(fetch.mock.calls[0]?.[0]).toBe(`https://cloud.comfy.org/api/v2/jobs/${providerId}/cancel`);
    expect((fetch.mock.calls[0]?.[1] as RequestInit).method).toBe("POST");
  });

  it("fails closed when the Comfy feature gate is off",async()=>{
    vi.stubEnv("SLOPTOGETHER_COMFY_FRAME_GENERATION_ENABLED","false");
    const fetch=vi.fn();vi.stubGlobal("fetch",fetch);
    await expect(createComfyFrameGeneration("localdemo",request({requestId,prompt}))).rejects.toMatchObject({status:503,code:"comfy_frame_generation_unavailable"});
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not spend Comfy credits when prompt and image moderation is unavailable",async()=>{
    vi.stubEnv("SLOPTOGETHER_OPENAI_MODERATION_KEY","");
    vi.stubEnv("OPENAI_API_KEY","");
    const fetch=vi.fn();vi.stubGlobal("fetch",fetch);
    await expect(createComfyFrameGeneration("localdemo",request({requestId,prompt})))
      .rejects.toMatchObject({status:503,code:"comfy_frame_generation_unavailable"});
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.screenPromptAndImages).not.toHaveBeenCalled();
  });

  it("blocks a second request while the owner has a pending or uncertain provider job",async()=>{
    const db={query:vi.fn(async(sql:string)=>{
      if(sql.includes("WHERE twitch_channel_id=$1 AND requested_by=$2 AND request_id=$3 FOR UPDATE"))return {rows:[],rowCount:0};
      if(sql.includes("state IN ('submitting','queued','running','uncertain')"))return {rows:[{count:"1"}],rowCount:1};
      return {rows:[],rowCount:1};
    })};
    mocks.transaction.mockImplementation(async(work:(client:typeof db)=>Promise<unknown>)=>work(db));
    const fetch=vi.fn();vi.stubGlobal("fetch",fetch);
    await expect(createComfyFrameGeneration("localdemo",request({requestId,prompt})))
      .rejects.toMatchObject({status:409,code:"comfy_frame_job_in_flight"});
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects reusing the same local idempotency key for another Comfy job kind",async()=>{
    const prior={id:localId,request_id:requestId,twitch_channel_id:"123",requested_by:ownerId,prompt,prompt_sha256:createHash("sha256").update(prompt).digest(),
      generation_kind:"frame",generated_text:null,state:"queued",provider_job_id:providerId,output_asset_id:null,error_code:null,created_at:new Date(),updated_at:new Date()};
    const db={query:vi.fn(async(sql:string)=>sql.includes("WHERE twitch_channel_id=$1 AND requested_by=$2 AND request_id=$3 FOR UPDATE")
      ?{rows:[prior],rowCount:1}:{rows:[],rowCount:1})};
    mocks.transaction.mockImplementation(async(work:(client:typeof db)=>Promise<unknown>)=>work(db));
    const fetch=vi.fn();vi.stubGlobal("fetch",fetch);
    await expect(createComfyPromptGeneration("localdemo",request({requestId,prompt})))
      .rejects.toMatchObject({status:409,code:"comfy_request_id_reused"});
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not let headless workers initiate Comfy generation",async()=>{
    mocks.requestPrincipal.mockReturnValue({kind:"worker-key"});
    const fetch=vi.fn();vi.stubGlobal("fetch",fetch);
    await expect(createComfyFrameGeneration("localdemo",request({requestId,prompt})))
      .rejects.toMatchObject({status:401,code:"login_required"});
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.screenPromptAndImages).not.toHaveBeenCalled();
  });

  it("keeps the shared Comfy key restricted to the configured channel allowlist",async()=>{
    mocks.findChannel.mockResolvedValue({...channel,twitch_channel_id:"999"});
    const fetch=vi.fn();vi.stubGlobal("fetch",fetch);
    await expect(createComfyFrameGeneration("other",request({requestId,prompt})))
      .rejects.toMatchObject({status:503,code:"comfy_frame_generation_unavailable"});
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.screenPromptAndImages).not.toHaveBeenCalled();
  });

  it("does not fall back to the interactive Comfy CLI key in production",async()=>{
    vi.stubEnv("SLOPTOGETHER_COMFY_API_KEY","");
    vi.stubEnv("COMFY_API_KEY","test-cli-key-with-enough-length");
    vi.stubEnv("NODE_ENV","production");
    const fetch=vi.fn();vi.stubGlobal("fetch",fetch);
    await expect(createComfyFrameGeneration("localdemo",request({requestId,prompt})))
      .rejects.toMatchObject({status:503,code:"comfy_frame_generation_unavailable"});
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.screenPromptAndImages).not.toHaveBeenCalled();
  });
});
