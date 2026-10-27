import { createHash,createHmac,randomBytes,randomUUID } from "node:crypto";
import { Socket } from "node:net";
import { S3Client } from "@aws-sdk/client-s3";
import { afterAll,beforeAll,describe,expect,it,vi } from "vitest";
// @ts-expect-error The shared local-only guard is a JavaScript module outside the web project.
import { assertBitsScratchDatabase } from "../../../../../scripts/bits-local-db-guard.mjs";

// Opt in only with an isolated, migrated loopback database named
// sloptogether_bits_test_*. This file never calls real Twitch or Fal APIs.
const databaseUrl=process.env.SLOPTOGETHER_BITS_TEST_DATABASE_URL;
const guardMarker=process.env.SLOPTOGETHER_BITS_TEST_GUARD_MARKER;
const run=Boolean(databaseUrl);
const extensionId="local-bits-test-extension";
const sku="local-test-turbo-480p";
const promptLockSku="prompt-lock-local-test-400";
const secret=Buffer.from("local-only-extension-test-secret-32-bytes");
const eventSecret="local-only-eventsub-test-secret-12345";
const mocks=vi.hoisted(()=>({getExtensionTransaction:vi.fn(),listExtensionBitsProducts:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("./twitch",()=>({
  getExtensionTransaction:mocks.getExtensionTransaction,
  listExtensionBitsProducts:mocks.listExtensionBitsProducts,
  twitchExtensionClientId:()=>extensionId,
  appAccessToken:vi.fn(),twitchCredentials:vi.fn(),
}));
import { createExtensionBitsIntent,createExtensionPromptLockIntent,getExtensionPromptLockState,recordExtensionBitsReceipt } from "./paid-bits-service";
import { handleEventSubWebhook } from "./subscriber-service";
import { claimWorkerLease } from "./worker-service";
import { hashWorkerSecret } from "./crypto";
import { pool } from "./db";

type Fixture={channel:string;viewer:string;segment:string;revision:string;screen:string;boundary:string};
const hash=(value:string)=>createHash("sha256").update(value).digest();
function jwt(payload:Record<string,unknown>){
  const header=Buffer.from(JSON.stringify({alg:"HS256",typ:"JWT"})).toString("base64url");
  const body=Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.${createHmac("sha256",secret).update(`${header}.${body}`).digest("base64url")}`;
}
function auth(f:Fixture){return jwt({exp:Math.floor(Date.now()/1000)+600,channel_id:f.channel,opaque_user_id:`U${f.viewer}`,user_id:f.viewer,role:"viewer",client_id:extensionId});}
function receipt(f:Fixture,transactionId:string,development:boolean,time:Date){return jwt({exp:Math.floor(Date.now()/1000)+600,topic:"bits_transaction_receipt",domainID:`twitch.ext${extensionId}`,
  ...(development?{product:"inDevelopment"}:{}),data:{transactionId,userId:f.viewer,time:time.toISOString()}});}
function request(path:string,body:unknown,token:string){return new Request(`http://127.0.0.1:3000/sloptogether/api/v1/${path}`,{
  method:"POST",headers:{"Content-Type":"application/json","x-extension-jwt":token},body:JSON.stringify(body),
});}
function signedEvent(messageId:string,event:Record<string,unknown>|null,type="notification"){
  const time=new Date().toISOString();
  const body=JSON.stringify({subscription:{id:"local-test-subscription",type:"extension.bits_transaction.create",version:"1",
    condition:{extension_client_id:extensionId},transport:{method:"webhook"}},...(event?{event}:{challenge:"local-test-challenge"})});
  const signature=createHmac("sha256",eventSecret).update(messageId+time+body).digest("hex");
  return new Request("http://127.0.0.1:3000/sloptogether/api/v1/webhooks/eventsub",{method:"POST",body,headers:{
    "Content-Type":"application/json","twitch-eventsub-message-id":messageId,"twitch-eventsub-message-timestamp":time,
    "twitch-eventsub-message-type":type,"twitch-eventsub-message-signature":`sha256=${signature}`,
  }});
}

describe.skipIf(!run)("isolated Bits transaction pipeline",()=>{
  let database:ReturnType<typeof pool>;
  let restoreSocket=()=>{};
  const network=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{void input;void init;throw new Error("test_network_blocked")});
  beforeAll(async()=>{
    const target=new URL(databaseUrl!);
    if(process.env.NODE_ENV!=="test"||target.protocol!=="postgresql:"||target.hostname!=="127.0.0.1"||target.port!=="56432"
      ||target.username!=="postgres"||target.password||!/^\/sloptogether_bits_test_[a-f0-9]{16}$/.test(target.pathname)||target.search||target.hash
      ||!guardMarker||!/^[a-f0-9]{48}$/.test(guardMarker))
      throw new Error("bits_integration_requires_isolated_loopback_database");
    if(globalThis.__sloptogetherPool||globalThis.__sloptogetherLifecyclePool)throw new Error("bits_integration_requires_fresh_pools");
    const originalConnect=Socket.prototype.connect;
    const permittedPort=Number(target.port||5432);
    Socket.prototype.connect=function(this:Socket,...args:unknown[]){
      const options=typeof args[0]==="object"&&args[0]!==null?args[0] as {host?:unknown;port?:unknown}:null;
      const host=options?.host??args[1],port=options?.port??args[0];
      if(host!=="127.0.0.1"||Number(port)!==permittedPort)throw new Error("test_network_blocked");
      return Reflect.apply(originalConnect,this,args) as Socket;
    } as typeof Socket.prototype.connect;
    restoreSocket=()=>{Socket.prototype.connect=originalConnect};
    // Exercise direct Vitest invocation too: libpq/pg service and credential
    // settings must not influence the verified scratch connection.
    for(const name of ["PGPASSWORD","PGPASSFILE","PGSERVICE","PGSERVICEFILE","PGHOST","PGHOSTADDR","PGPORT","PGUSER","PGDATABASE","PGOPTIONS"])
      vi.stubEnv(name,"synthetic-value-that-must-be-cleared");
    for(const name of Object.keys(process.env)){
      if(/^PG[A-Z0-9_]*$/.test(name))vi.stubEnv(name,undefined);
      else if(/(?:KEY|SECRET|TOKEN|DATABASE_URL|^R2_)/.test(name))vi.stubEnv(name,"");
    }
    expect(process.env.PGPASSWORD).toBeUndefined();expect(process.env.PGSERVICE).toBeUndefined();expect(process.env.PGOPTIONS).toBeUndefined();
    for(const [name,value] of Object.entries({DATABASE_URL:databaseUrl!,TWITCH_EXTENSION_CLIENT_ID:extensionId,
      TWITCH_EXTENSION_SECRET_CURRENT:secret.toString("base64"),SLOPTOGETHER_BITS_TURBO_ENABLED:"true",
      SLOPTOGETHER_BITS_POLICY_APPROVED:"true",SLOPTOGETHER_BITS_EVENTSUB_READY:"true",SLOPTOGETHER_BITS_DISPATCH_READY:"true",
      TWITCH_EVENTSUB_SECRET:eventSecret,
      SLOPTOGETHER_KEY_HASH_PEPPER:"local-only-test-key-hash-pepper-32bytes",
      SLOPTOGETHER_BITS_RECONCILE_SECRET:"local-only-reconcile-secret-0123456789",
      PUBLIC_APP_URL:"http://127.0.0.1:3000/sloptogether",SLOPTOGETHER_BITS_RECONCILE_URL:"http://127.0.0.1:3000/sloptogether/api/v1/internal/bits/reconcile",
      SLOPTOGETHER_BITS_TURBO_PRODUCTS_JSON:JSON.stringify([{sku,amountBits:400,resolution:"480P",reservedUsd:0.55}]),
      SLOPTOGETHER_BITS_PROMPT_LOCK_ENABLED:"true",SLOPTOGETHER_BITS_PROMPT_LOCK_POLICY_APPROVED:"true",SLOPTOGETHER_BITS_PROMPT_LOCK_EVENTSUB_READY:"true",
      SLOPTOGETHER_BITS_PROMPT_LOCK_DISPATCH_READY:"true",SLOPTOGETHER_BITS_PROMPT_LOCK_PRODUCTS_JSON:JSON.stringify([{sku:promptLockSku,amountBits:400,reservedUsd:0.55}]),FAL_KEY:"local-only-fal-key"}))vi.stubEnv(name,value);
    vi.stubGlobal("fetch",network);
    database=pool();
    const identity=await database.query(`select current_database() as "databaseName",current_setting('data_directory') as "dataDirectory",
      host(inet_server_addr()) as "serverAddress",inet_server_port() as "serverPort",
      (select marker from public.sloptogether_bits_test_guard limit 1) as "guardMarker"`);
    assertBitsScratchDatabase(identity.rows[0],target.pathname.slice(1),guardMarker);
    await database.query("insert into sloptogether.extension_bits_eventsub_subscriptions(extension_client_id,subscription_id,state) values($1,'local-test-bits-subscription','enabled')",[extensionId]);
    mocks.listExtensionBitsProducts.mockResolvedValue([{sku,amountBits:400,displayName:"Test Turbo",inDevelopment:false},
      {sku:promptLockSku,amountBits:400,displayName:"Test Prompt Lock",inDevelopment:false}]);
    const challenge=await handleEventSubWebhook(signedEvent("local-verification",null,"webhook_callback_verification"));
    expect(challenge.status).toBe(200);expect(await challenge.text()).toBe("local-test-challenge");
  },20_000);
  afterAll(async()=>{
    await database?.end();
    globalThis.__sloptogetherPool=undefined;
    restoreSocket();
    vi.unstubAllGlobals();vi.unstubAllEnvs();
  });

  async function fixture():Promise<Fixture>{
    const channel=(BigInt("810000000000000")+BigInt(`0x${randomBytes(4).toString("hex")}`)).toString();
    const viewer=(BigInt(channel)+1n).toString();
    const revision=randomUUID(),screen=randomUUID(),asset=randomUUID(),boundary=randomUUID(),election=randomUUID(),proposal=randomUUID();
    const revisionHash=hash(`revision:${revision}`),screenHash=hash(`screen:${screen}`),imageHash=hash(`image:${asset}`);
    await database.query("insert into sloptogether.channels(twitch_channel_id,owner_twitch_user_id,twitch_login,display_name) values($1,$1,$2,'Local Bits Test')",[channel,`bits${channel}`]);
    const main=(await database.query<{segment_id:string}>(`select s.id as segment_id from sloptogether.streams st
      join sloptogether.branches b on b.stream_id=st.id and b.is_selected join sloptogether.segments s on s.branch_id=b.id and s.ordinal=0
      where st.twitch_channel_id=$1 and st.is_default`,[channel])).rows[0]!;
    const segment=main.segment_id;
    await database.query("insert into sloptogether.assets(id,twitch_channel_id,storage_key,sha256,media_kind,content_type,status) values($1,$2,$3,$4,'image','image/png','approved')",[asset,channel,`private/${channel}/start.png`,imageHash]);
    await database.query("insert into sloptogether.boundary_revisions(id,twitch_channel_id,asset_id,created_by) values($1,$2,$3,$2)",[boundary,channel,asset]);
    await database.query("insert into sloptogether.segment_revisions(id,segment_id,revision,prompt,start_boundary_revision_id,planning_mode,provider_recipe_id,input_sha256,requested_by,state) values($1,$2,1,'A small telescope turns.',$3,'continuation','fast-h3-trim-5step-vsa20-b1',$4,$5,'selected')",[revision,segment,boundary,revisionHash,viewer]);
    await database.query("update sloptogether.segments set selected_revision_id=$2,state='selected' where id=$1",[segment,revision]);
    await database.query("insert into sloptogether.input_screens(id,twitch_channel_id,input_sha256,prompt_sha256,image_sha256s,moderation_model,moderation_policy_revision,automated_state,effective_state,expires_at) values($1,$2,$3,$4,$5,'local-test',1,'clear','clear',now()+interval '1 hour')",[screen,channel,screenHash,hash('prompt'),[imageHash.toString('hex')]]);
    await database.query("insert into sloptogether.elections(id,segment_id,state,closes_at,rule_snapshot) values($1,$2,'selected',now()+interval '10 minutes','{}')",[election,segment]);
    await database.query("insert into sloptogether.proposals(id,election_id,author_twitch_user_id,proposal_kind,prompt,start_boundary_revision_id,input_screen_id,state,segment_revision_id) values($1,$2,$3,'scene','A small telescope turns.',$4,$5,'selected',$6)",[proposal,election,viewer,boundary,screen,revision]);
    return {channel,viewer,segment,revision,screen,boundary};
  }
  async function promptLockProposal(f:Fixture){
    const branch=(await database.query<{branch_id:string;next_ordinal:number}>(`select branch_id,(max(ordinal)+1)::int as next_ordinal
      from sloptogether.segments where branch_id=(select branch_id from sloptogether.segments where id=$1) group by branch_id`,[f.segment])).rows[0]!;
    const segmentId=randomUUID(),electionId=randomUUID(),proposalId=randomUUID(),revisionId=randomUUID(),screenId=randomUUID();
    const prompt="A tiny cartoon astronaut rides a comet and waves to the moon.";
    const revisionHash=hash(`prompt-lock-revision:${revisionId}`),screenHash=hash(`prompt-lock-screen:${screenId}`);
    const assetHash=(await database.query<{sha256:Buffer}>("select a.sha256 from sloptogether.boundary_revisions b join sloptogether.assets a on a.id=b.asset_id where b.id=$1",[f.boundary])).rows[0]!.sha256;
    await database.query("insert into sloptogether.segments(id,twitch_channel_id,branch_id,ordinal,state) values($1,$2,$3,$4,'voting')",
      [segmentId,f.channel,branch.branch_id,branch.next_ordinal]);
    await database.query("insert into sloptogether.segment_revisions(id,segment_id,revision,prompt,start_boundary_revision_id,planning_mode,provider_recipe_id,input_sha256,requested_by,state) values($1,$2,1,$3,$4,'continuation','fast-h3-trim-5step-vsa20-b1',$5,$6,'proposal')",
      [revisionId,segmentId,prompt,f.boundary,revisionHash,f.viewer]);
    await database.query("insert into sloptogether.input_screens(id,twitch_channel_id,input_sha256,prompt_sha256,image_sha256s,moderation_model,moderation_policy_revision,automated_state,effective_state,expires_at) values($1,$2,$3,$4,$5,'local-test',1,'clear','clear',now()+interval '1 hour')",
      [screenId,f.channel,screenHash,hash(prompt),[assetHash.toString("hex")]]);
    await database.query("insert into sloptogether.elections(id,segment_id,state,closes_at,rule_snapshot) values($1,$2,'open',now()+interval '10 minutes','{}')",
      [electionId,segmentId]);
    await database.query("insert into sloptogether.proposals(id,election_id,author_twitch_user_id,proposal_kind,prompt,start_boundary_revision_id,input_screen_id,state,segment_revision_id) values($1,$2,$3,'scene',$4,$5,$6,'eligible',$7)",
      [proposalId,electionId,f.viewer,prompt,f.boundary,screenId,revisionId]);
    const competingProposalId=randomUUID(),competingRevisionId=randomUUID(),competingScreenId=randomUUID();
    const competingAuthor=(BigInt(f.viewer)+1n).toString(),competingPrompt="The audience chooses a tiny moon garden.";
    await database.query("insert into sloptogether.segment_revisions(id,segment_id,revision,prompt,start_boundary_revision_id,planning_mode,provider_recipe_id,input_sha256,requested_by,state) values($1,$2,2,$3,$4,'continuation','fast-h3-trim-5step-vsa20-b1',$5,$6,'proposal')",
      [competingRevisionId,segmentId,competingPrompt,f.boundary,hash(`competing-revision:${competingRevisionId}`),competingAuthor]);
    await database.query("insert into sloptogether.input_screens(id,twitch_channel_id,input_sha256,prompt_sha256,image_sha256s,moderation_model,moderation_policy_revision,automated_state,effective_state,expires_at) values($1,$2,$3,$4,$5,'local-test',1,'clear','clear',now()+interval '1 hour')",
      [competingScreenId,f.channel,hash(`competing-screen:${competingScreenId}`),hash(competingPrompt),[assetHash.toString("hex")]]);
    await database.query("insert into sloptogether.proposals(id,election_id,author_twitch_user_id,proposal_kind,prompt,start_boundary_revision_id,input_screen_id,state,segment_revision_id) values($1,$2,$3,'scene',$4,$5,$6,'eligible',$7)",
      [competingProposalId,electionId,competingAuthor,competingPrompt,f.boundary,competingScreenId,competingRevisionId]);
    for(const voter of [BigInt(f.viewer)+2n,BigInt(f.viewer)+3n,BigInt(f.viewer)+4n])
      await database.query("insert into sloptogether.ballots(election_id,twitch_user_id,proposal_id,source_surface) values($1,$2,$3,'extension')",[electionId,voter.toString(),competingProposalId]);
    return {segmentId,electionId,proposalId,competingProposalId,revisionId,screenId,prompt};
  }
  async function createIntent(f:Fixture){
    return createExtensionBitsIntent(request("extension/bits/intents",{sku},auth(f)));
  }
  function fakeTransaction(f:Fixture,id:string,development:boolean,time:Date){
    mocks.getExtensionTransaction.mockResolvedValue({id,broadcasterId:f.channel,extensionClientId:extensionId,userId:f.viewer,sku,amountBits:400,inDevelopment:development,timestamp:time});
    return {id,extension_client_id:extensionId,broadcaster_user_id:f.channel,user_id:f.viewer,product:{sku,bits:400,in_development:development}};
  }
  function fakePromptLockTransaction(f:Fixture,id:string,time:Date){
    mocks.getExtensionTransaction.mockResolvedValue({id,broadcasterId:f.channel,extensionClientId:extensionId,userId:f.viewer,sku:promptLockSku,amountBits:400,inDevelopment:false,timestamp:time});
    return {id,extension_client_id:extensionId,broadcaster_user_id:f.channel,user_id:f.viewer,product:{sku:promptLockSku,bits:400,in_development:false}};
  }
  async function counts(f:Fixture){return (await database.query<{funding:string;jobs:string;dispatches:string}>(`select
    (select count(*)::text from sloptogether.funding_authorizations where twitch_channel_id=$1) as funding,
    (select count(*)::text from sloptogether.jobs where twitch_channel_id=$1) as jobs,
    (select count(*)::text from sloptogether.paid_turbo_dispatches d join sloptogether.jobs j on j.id=d.job_id where j.twitch_channel_id=$1) as dispatches`,[f.channel])).rows[0]!;}

  it("ignores signed development receipts and duplicate events without funding or dispatch",async()=>{
    const f=await fixture(),intent=await createIntent(f),id=`local-dev-${randomUUID()}`,time=new Date();
    const devReceipt=receipt(f,id,true,time);
    const parts=devReceipt.split(".");parts[2]=(parts[2]![0]==="A"?"B":"A")+parts[2]!.slice(1);
    await expect(recordExtensionBitsReceipt(request("extension/bits/receipt",{intentId:intent.intentId,transactionReceipt:parts.join(".")},auth(f))))
      .rejects.toMatchObject({status:401,code:"bits_receipt_signature_invalid"});
    await expect(recordExtensionBitsReceipt(request("extension/bits/receipt",{intentId:intent.intentId,transactionReceipt:devReceipt},auth(f)))).resolves.toMatchObject({state:"development_ignored",accepted:false});
    const event=fakeTransaction(f,id,true,time);
    const invalidWebhook=signedEvent(`local-invalid-${id}`,event);invalidWebhook.headers.set("twitch-eventsub-message-signature",`sha256=${"0".repeat(64)}`);
    await expect(handleEventSubWebhook(invalidWebhook)).rejects.toMatchObject({status:403,code:"eventsub_signature_invalid"});
    expect((await handleEventSubWebhook(signedEvent(`local-event-${id}`,event))).status).toBe(204);
    expect((await handleEventSubWebhook(signedEvent(`local-event-${id}`,event))).status).toBe(204);
    expect(await counts(f)).toEqual({funding:"0",jobs:"0",dispatches:"0"});expect(network).not.toHaveBeenCalled();
  });

  it("keeps Turbo disabled and never sends its Bits transaction to Fal",async()=>{
    const f=await fixture(),intent=await createIntent(f),id=`local-paid-${randomUUID()}`,time=new Date();
    const body={intentId:intent.intentId,transactionReceipt:receipt(f,id,false,time)};
    await expect(recordExtensionBitsReceipt(request("extension/bits/receipt",body,auth(f)))).resolves.toMatchObject({state:"receipt_seen"});
    const event=fakeTransaction(f,id,false,time);
    expect((await handleEventSubWebhook(signedEvent(`local-event-${id}`,event))).status).toBe(204);
    expect((await handleEventSubWebhook(signedEvent(`local-event-${id}`,event))).status).toBe(204);
    await expect(recordExtensionBitsReceipt(request("extension/bits/receipt",body,auth(f)))).resolves.toMatchObject({state:"reserved",accepted:true});
    expect(await counts(f)).toEqual({funding:"1",jobs:"1",dispatches:"1"});
    const row=(await database.query<{id:string;aggregate_id:string;payload:Record<string,unknown>;leased_until:Date}>(`update sloptogether.outbox set leased_until=date_trunc('milliseconds',now()+interval '5 minutes')
      where event_kind='paid.turbo.dispatch' and payload->>'intentId'=$1 returning id,aggregate_id,payload,leased_until`,[intent.intentId])).rows[0]!;
    // @ts-expect-error The publisher is an ESM JavaScript module outside the web TypeScript project.
    const {processPaidTurboMessage}=await import("../../../../../workers/media-publisher/src/paid-turbo.mjs");
    const storage=new S3Client({endpoint:"https://local-test.invalid",region:"us-east-1",forcePathStyle:true,
      credentials:{accessKeyId:"local-test",secretAccessKey:"local-test"},requestHandler:{handle:async()=>{throw new Error("test_network_blocked")}}});
    const message={id:row.id,eventKind:"paid.turbo.dispatch",aggregateId:row.aggregate_id,payload:row.payload,leaseUntil:row.leased_until};
    const config={bucket:"local-test",paidBitsReady:true,falKey:"local-only-fal-key"};
    await expect(processPaidTurboMessage({pool:database,storage,config,message})).resolves.toMatchObject({unfulfilled:true});
    expect(network).not.toHaveBeenCalled();
    const replay=(await database.query<{id:string;leased_until:Date}>(`insert into sloptogether.outbox(event_kind,aggregate_id,payload,idempotency_key,leased_until)
      values('paid.turbo.dispatch',$1,$2::jsonb,$3,date_trunc('milliseconds',now()+interval '5 minutes')) returning id,leased_until`,
      [row.aggregate_id,JSON.stringify(row.payload),`local-replay:${randomUUID()}`])).rows[0]!;
    await expect(processPaidTurboMessage({pool:database,storage,config,message:{...message,id:replay.id,leaseUntil:replay.leased_until}})).resolves.toMatchObject({duplicate:true});
    expect(network).not.toHaveBeenCalled();
    const final=(await database.query<{state:string;attempts_authorized:number}>("select state,attempts_authorized from sloptogether.funding_authorizations where twitch_channel_id=$1",[f.channel])).rows[0];
    expect(final).toEqual({state:"paid_unfulfilled",attempts_authorized:1});
    expect(await counts(f)).toEqual({funding:"1",jobs:"1",dispatches:"1"});
  },30_000);

  it("handles the verified webhook arriving before its signed receipt exactly once",async()=>{
    network.mockClear();
    const f=await fixture(),intent=await createIntent(f),id=`local-first-${randomUUID()}`,time=new Date();
    const event=fakeTransaction(f,id,false,time);
    expect((await handleEventSubWebhook(signedEvent(`local-event-${id}`,event))).status).toBe(204);
    const body={intentId:intent.intentId,transactionReceipt:receipt(f,id,false,time)};
    await expect(recordExtensionBitsReceipt(request("extension/bits/receipt",body,auth(f)))).resolves.toMatchObject({state:"reserved",accepted:true});
    expect((await handleEventSubWebhook(signedEvent(`local-event-${id}`,event))).status).toBe(204);
    expect(await counts(f)).toEqual({funding:"1",jobs:"1",dispatches:"1"});
    const persisted=(await database.query<{receipt_transaction_id:string;state:string}>(
      "select receipt_transaction_id,state from sloptogether.paid_action_intents where id=$1",[intent.intentId])).rows[0];
    expect(persisted).toEqual({receipt_transaction_id:id,state:"reserved"});
    expect(network).not.toHaveBeenCalled();
  });

  it("locks the viewer's screened proposal above votes and leases exactly one FastH3 job",async()=>{
    network.mockClear();
    const f=await fixture(),target=await promptLockProposal(f);
    const stateRequest=new Request("http://127.0.0.1:3000/sloptogether/api/v1/extension/bits/prompt-lock/state?stream=main",{
      headers:{"x-extension-jwt":auth(f)},
    });
    const state=await getExtensionPromptLockState(stateRequest);
    expect(state).toMatchObject({enabled:true,stream:{slug:"main"},proposals:[{proposalId:target.proposalId,electionId:target.electionId,segmentId:target.segmentId}]});
    const intent=await createExtensionPromptLockIntent(request("extension/bits/prompt-lock/intents",{
      sku:promptLockSku,proposalId:target.proposalId,stream:"main",
    },auth(f)));
    expect(intent).toMatchObject({actionKind:"prompt_lock",proposalId:target.proposalId,streamSlug:"main",amountBits:400});
    await expect(createExtensionPromptLockIntent(request("extension/bits/prompt-lock/intents",{
      sku:promptLockSku,proposalId:target.proposalId,stream:"main",
    },auth(f)))).rejects.toMatchObject({status:409,code:"prompt_lock_slot_already_locked"});

    const transactionId=`local-prompt-lock-${randomUUID()}`,time=new Date();
    const receiptBody={intentId:intent.intentId,transactionReceipt:receipt(f,transactionId,false,time)};
    await expect(recordExtensionBitsReceipt(request("extension/bits/receipt",receiptBody,auth(f))))
      .resolves.toMatchObject({accepted:false,state:"receipt_seen"});
    const event=fakePromptLockTransaction(f,transactionId,time);
    expect((await handleEventSubWebhook(signedEvent(`local-prompt-lock-event-${transactionId}`,event))).status).toBe(204);
    expect((await handleEventSubWebhook(signedEvent(`local-prompt-lock-event-${transactionId}`,event))).status).toBe(204);
    await expect(recordExtensionBitsReceipt(request("extension/bits/receipt",receiptBody,auth(f))))
      .resolves.toMatchObject({accepted:true,actionKind:"prompt_lock",state:"reserved"});
    expect(await counts(f)).toEqual({funding:"1",jobs:"1",dispatches:"0"});

    const keyId=randomUUID(),credential=`slw_${keyId}.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-`;
    await database.query(`insert into sloptogether.application_keys(key_id,secret_hash,key_prefix,issuing_twitch_user_id,twitch_channel_id,display_name,scopes,worker_roles)
      values($1,$2,$3,$4,$5,'Prompt lock test worker',ARRAY['worker:generation'],ARRAY['generation'])`,
      [keyId,hashWorkerSecret(credential),`slw_${keyId}`,f.channel,f.channel]);
    await database.query(`insert into sloptogether.trusted_executions(twitch_channel_id,key_id,issuer_twitch_user_id,execution_role,policy_revision)
      select $1,$2,$1,'generation',policy_revision from sloptogether.channels where twitch_channel_id=$1`,[f.channel,keyId]);
    const lease=await claimWorkerLease(new Request("http://127.0.0.1:3000/sloptogether/api/v1/workers/leases?role=generation",{
      method:"POST",headers:{Authorization:`Bearer ${credential}`,"Content-Type":"application/json"},
      body:JSON.stringify({supportedRecipes:["fast-h3-trim-5step-vsa20-b1"]}),
    }));
    expect(lease).toMatchObject({status:"leased",job:{kind:"story",recipeId:"fast-h3-trim-5step-vsa20-b1",prompt:target.prompt,width:448,height:256,frameCount:362}});
    const result=await database.query<{funding_state:string;intent_state:string;job_state:string;proposal_state:string;election_state:string;winner_proposal_id:string;competing_proposal_state:string;competing_votes:number}>(`select
      f.state as funding_state,pai.state as intent_state,j.state as job_state,p.state as proposal_state,e.state as election_state,e.winner_proposal_id,
      other.state as competing_proposal_state,(select count(*)::int from sloptogether.ballots b where b.election_id=e.id and b.proposal_id=other.id) as competing_votes
      from sloptogether.paid_action_intents pai join sloptogether.funding_authorizations f on f.paid_action_intent_id=pai.id
      join sloptogether.jobs j on j.funding_id=f.id join sloptogether.proposals p on p.id=pai.proposal_id
      join sloptogether.elections e on e.id=pai.election_id join sloptogether.proposals other on other.id=$2 where pai.id=$1`,[intent.intentId,target.competingProposalId]);
    expect(result.rows).toEqual([{funding_state:"consumed_uncertain",intent_state:"reserved",job_state:"leased",proposal_state:"selected",election_state:"selected",
      winner_proposal_id:target.proposalId,competing_proposal_state:"superseded",competing_votes:3}]);
    expect(await counts(f)).toEqual({funding:"1",jobs:"1",dispatches:"0"});
    expect(network).not.toHaveBeenCalled();
  },30_000);

  it("rejects non-loopback sockets and unstubbed network requests",async()=>{
    const external=new Socket(),wrongPort=new Socket();
    try{
      expect(()=>external.connect({host:"203.0.113.1",port:443})).toThrow("test_network_blocked");
      expect(()=>wrongPort.connect({host:"127.0.0.1",port:9})).toThrow("test_network_blocked");
      await expect(fetch("https://api.twitch.tv/helix/users")).rejects.toThrow("test_network_blocked");
    }finally{external.destroy();wrongPort.destroy();}
  });
});
