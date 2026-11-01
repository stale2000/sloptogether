import {createHash,createHmac,randomBytes,randomUUID} from "node:crypto";
import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {compileH3StoryPrompt} from "@sloptogether/contracts";

const preflight=vi.hoisted(()=>({inputAsset:vi.fn(),screenPromptAndImages:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("./preflight",()=>preflight);
vi.mock("./storage",()=>({signedPrivateReadUrl:vi.fn(async(key:string)=>`http://private.test/${encodeURIComponent(key)}`)}));

import {pool} from "./db";
import {castBallot} from "./voting-service";
import {submitProposal} from "./proposal-service";
import {claimWorkerLease} from "./worker-service";
import {claimStoryProducer,submitStoryProposal} from "./worker-service";
import {requestPrincipal} from "./principals";
import * as principalModule from "./principals";
import {hashWorkerSecret} from "./crypto";
import {handleEventSubWebhook} from "./subscriber-service";
import {heartbeatPlayback} from "./program-service";
import {createComfyFrameGeneration} from "./comfy-frame-service";

const url=process.env.SLOPTOGETHER_POLICY_TEST_DATABASE_URL;
const integration=url?describe:describe.skip;
const extensionId="local-extension-vote-worker-test";
const extensionSecret=Buffer.from("local-only-extension-flow-secret-32-bytes");
const eventSubSecret="local-only-eventsub-extension-flow-secret-32-bytes";
const workerKeyPepper="local-only-worker-test-pepper-0123456789";
const startImage=Buffer.from("synthetic local start frame");
const endImage=Buffer.from("synthetic local end frame");
let database:ReturnType<typeof pool>|undefined;
let channelId="";
let startAssetId="";
let endAssetId="";
let created=false;

function jwt(payload:Record<string,unknown>,secret:Buffer){
  const header=Buffer.from(JSON.stringify({alg:"HS256",typ:"JWT"})).toString("base64url");
  const body=Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.${createHmac("sha256",secret).update(`${header}.${body}`).digest("base64url")}`;
}

function extensionRequest(path:string,userId:string,body:unknown){
  const token=jwt({exp:Math.floor(Date.now()/1000)+600,channel_id:channelId,opaque_user_id:`U${userId}`,user_id:userId,
    role:"viewer",client_id:extensionId},extensionSecret);
  return new Request(`http://127.0.0.1:3000/sloptogether/api/v1/${path}`,{method:"POST",headers:{
    "Content-Type":"application/json","x-extension-jwt":token,
  },body:JSON.stringify(body)});
}

integration("Twitch Extension prompt to pull-worker PostgreSQL flow",()=>{
  beforeAll(async()=>{
    const target=new URL(url!);
    if(process.env.NODE_ENV!=="test"||target.protocol!=="postgresql:"||target.hostname!=="127.0.0.1"||target.port!=="56432"
      ||target.username!=="postgres"||target.password||!/^\/sloptogether_preair_test_[a-f0-9]{16}$/.test(target.pathname)||target.search||target.hash)
      throw new Error("extension_worker_flow_requires_isolated_loopback_database");
    for(const [name,value] of Object.entries({DATABASE_URL:url!,TWITCH_EXTENSION_CLIENT_ID:extensionId,
      TWITCH_EXTENSION_SECRET_CURRENT:extensionSecret.toString("base64"),SLOPTOGETHER_KEY_HASH_PEPPER:workerKeyPepper,
      SLOPTOGETHER_UPLOAD_TICKET_KEY:"local-only-upload-ticket-key-0123456789",TWITCH_EVENTSUB_SECRET:eventSubSecret,
      SLOPTOGETHER_SUBSCRIBER_ATTEMPT_RESERVATION_USD:"0.25",SLOPTOGETHER_GENERATION_ATTEMPT_RESERVATION_USD:"0.01",
      PUBLIC_APP_URL:"http://localhost:3000/sloptogether",SLOPTOGETHER_COMFY_API_KEY:"local-only-comfy-api-key-0123456789",
      SLOPTOGETHER_COMFY_FRAME_GENERATION_ENABLED:"true",SLOPTOGETHER_OPENAI_MODERATION_KEY:"local-only-comfy-moderation-key"}))vi.stubEnv(name,value);
    const expectedMarker=process.env.SLOPTOGETHER_EVENTSUB_TEST_GUARD_MARKER;
    if(!expectedMarker||!/^[a-f0-9]{48}$/.test(expectedMarker))throw new Error("extension_worker_flow_guard_marker_missing");
    database=pool();
    const identity=await database.query(`select current_database() as "databaseName",current_setting('data_directory') as "dataDirectory",
      host(inet_server_addr()) as "serverAddress",inet_server_port() as "serverPort",
      (select marker from public.sloptogether_eventsub_test_guard limit 1) as "guardMarker"`);
    if(identity.rows[0]?.databaseName!==target.pathname.slice(1)||identity.rows[0]?.dataDirectory!=="/tmp/sloptogether-pg"
      ||identity.rows[0]?.serverAddress!=="127.0.0.1"||Number(identity.rows[0]?.serverPort)!==56432||identity.rows[0]?.guardMarker!==expectedMarker)
      throw new Error("extension_worker_flow_database_identity_not_allowed");
    const suffix=randomBytes(4).toString("hex");
    channelId=(BigInt("820000000000000")+BigInt(`0x${suffix}`)).toString();
    vi.stubEnv("SLOPTOGETHER_COMFY_FRAME_GENERATION_CHANNEL_IDS",channelId);
    const authorId=(BigInt(channelId)+1n).toString();
    await database.query(`INSERT INTO sloptogether.channels(twitch_channel_id,owner_twitch_user_id,twitch_login,display_name,upload_approval_bypass_ids)
      VALUES($1,$1,$2,'Local Extension Flow',ARRAY[$3])`,[channelId,`flow_${channelId}`,authorId]);
    created=true;
    await database.query("UPDATE sloptogether.channels SET owner_budget_cap_usd=0 WHERE twitch_channel_id=$1",[channelId]);
    startAssetId=randomUUID();
    await database.query(`INSERT INTO sloptogether.assets(id,twitch_channel_id,storage_key,sha256,media_kind,content_type,byte_size,status,uploaded_by_twitch_user_id)
      VALUES($1,$2,$3,$4,'image','image/png',$5,'approved',$6)`,[startAssetId,channelId,`private/${channelId}/start.png`,createHash("sha256").update(startImage).digest(),startImage.length,authorId]);
    endAssetId=randomUUID();
    await database.query(`INSERT INTO sloptogether.assets(id,twitch_channel_id,storage_key,sha256,media_kind,content_type,byte_size,status,uploaded_by_twitch_user_id)
      VALUES($1,$2,$3,$4,'image','image/png',$5,'approved',$6)`,[endAssetId,channelId,`private/${channelId}/end.png`,createHash("sha256").update(endImage).digest(),endImage.length,authorId]);
    const stream=(await database.query<{id:string}>("SELECT id FROM sloptogether.streams WHERE twitch_channel_id=$1 AND is_default",[channelId])).rows[0]!;
    const branchId=(await database.query<{id:string}>(`SELECT id FROM sloptogether.branches
      WHERE twitch_channel_id=$1 AND stream_id=$2 AND is_selected AND archived_at IS NULL`,[channelId,stream.id])).rows[0]!.id;
    const initialBoundaryId=(await database.query<{id:string}>(`INSERT INTO sloptogether.boundary_revisions(twitch_channel_id,asset_id,created_by)
      VALUES($1,$2,$3) RETURNING id`,[channelId,startAssetId,authorId])).rows[0]!.id;
    const initialSegmentId=(await database.query<{id:string}>(`SELECT id FROM sloptogether.segments
      WHERE twitch_channel_id=$1 AND branch_id=$2 AND ordinal=0`,[channelId,branchId])).rows[0]!.id;
    const initialRevisionId=randomUUID();
    await database.query(`INSERT INTO sloptogether.segment_revisions(id,segment_id,revision,prompt,start_boundary_revision_id,
      requested_end_boundary_revision_id,planning_mode,provider_recipe_id,input_sha256,requested_by,state)
      VALUES($1,$2,1,'Local fixture boundary',$3,$3,'planned_anchors','fast-h3-trim-5step-vsa20-b1',$4,$5,'ready')`,
      [initialRevisionId,initialSegmentId,initialBoundaryId,Buffer.alloc(32,1),authorId]);
    await database.query("UPDATE sloptogether.segments SET selected_revision_id=$2 WHERE id=$1",[initialSegmentId,initialRevisionId]);
    await database.query("UPDATE sloptogether.segments SET state='played' WHERE id=$1",[initialSegmentId]);
    await database.query("INSERT INTO sloptogether.segments(twitch_channel_id,branch_id,ordinal,state) VALUES($1,$2,1,'open')",[channelId,branchId]);
    preflight.inputAsset.mockImplementation(async(_channel:string,asset:string)=>({assetId:asset,bytes:asset===endAssetId?endImage:startImage,contentType:"image/png"}));
    vi.stubGlobal("fetch",async(input:RequestInfo|URL)=>{
      const url=new URL(String(input));
      if(url.hostname!=="private.test")throw new Error("test_network_blocked");
      return new Response(url.pathname.endsWith("end.png")?endImage:startImage,{status:200,headers:{"Content-Type":"image/png"}});
    });
    preflight.screenPromptAndImages.mockImplementation(async({prompt,images}:{prompt:string;images:Array<{bytes:Buffer;contentType:string}>})=>{
      const promptDigest=createHash("sha256").update(prompt).digest();
      const imageDigests=images.map(image=>createHash("sha256").update(image.bytes).digest());
      const digest=createHash("sha256").update(Buffer.concat([promptDigest,...imageDigests])).digest();
      await database!.query(`INSERT INTO sloptogether.input_screens(twitch_channel_id,input_sha256,prompt_sha256,image_sha256s,moderation_model,
        moderation_policy_revision,automated_state,effective_state,expires_at) VALUES($1,$2,$3,$4,'local-test',1,'clear','clear',now()+interval '1 hour')
        ON CONFLICT DO NOTHING`,[channelId,digest,promptDigest,imageDigests.map(value=>value.toString("hex"))]);
      return {decision:"clear",digest:digest.toString("hex"),promptDigest:promptDigest.toString("hex"),imageDigests:imageDigests.map(value=>value.toString("hex")),model:"local-test"};
    });
  },20_000);

  afterAll(async()=>{
    if(database&&created){
      const jobs=await database.query<{id:string}>("SELECT id FROM sloptogether.jobs WHERE twitch_channel_id=$1",[channelId]);
      if(jobs.rows.length){
        await database.query("DELETE FROM sloptogether.upload_reservations WHERE attempt_id IN (SELECT id FROM sloptogether.job_attempts WHERE job_id=ANY($1::uuid[]))",[jobs.rows.map(row=>row.id)]);
        await database.query("DELETE FROM sloptogether.job_attempts WHERE job_id=ANY($1::uuid[])",[jobs.rows.map(row=>row.id)]);
        await database.query("UPDATE sloptogether.interrupt_requests SET job_id=NULL WHERE job_id=ANY($1::uuid[])",[jobs.rows.map(row=>row.id)]);
        await database.query("DELETE FROM sloptogether.jobs WHERE id=ANY($1::uuid[])",[jobs.rows.map(row=>row.id)]);
      }
      await database.query("DELETE FROM sloptogether.proposal_rate_reservations WHERE twitch_channel_id=$1",[channelId]);
      await database.query("DELETE FROM sloptogether.outbox WHERE aggregate_id IN (SELECT id::text FROM sloptogether.interrupt_requests WHERE broadcaster_twitch_id=$1)",[channelId]);
      await database.query("DELETE FROM sloptogether.outbox WHERE aggregate_id IN (SELECT id::text FROM sloptogether.comfy_frame_generations WHERE twitch_channel_id=$1)",[channelId]);
      await database.query("UPDATE sloptogether.playback_sessions SET active_item_id=NULL WHERE twitch_channel_id=$1",[channelId]);
      await database.query("DELETE FROM sloptogether.program_media_segments WHERE program_item_id IN (SELECT id FROM sloptogether.program_items WHERE twitch_channel_id=$1)",[channelId]);
      await database.query("DELETE FROM sloptogether.program_items WHERE twitch_channel_id=$1",[channelId]);
      await database.query("UPDATE sloptogether.subscription_events SET interrupt_id=NULL WHERE broadcaster_twitch_id=$1",[channelId]);
      await database.query("DELETE FROM sloptogether.interrupt_requests WHERE broadcaster_twitch_id=$1",[channelId]);
      await database.query("DELETE FROM sloptogether.subscription_events WHERE broadcaster_twitch_id=$1",[channelId]);
      await database.query("DELETE FROM sloptogether.sessions WHERE twitch_user_id=$1",[channelId]);
      await database.query("DELETE FROM sloptogether.audit_log WHERE twitch_channel_id=$1",[channelId]);
      await database.query("DELETE FROM sloptogether.story_plan_attempts WHERE twitch_channel_id=$1",[channelId]);
      await database.query("DELETE FROM sloptogether.story_producers WHERE twitch_channel_id=$1",[channelId]);
      await database.query("DELETE FROM sloptogether.trusted_executions WHERE twitch_channel_id=$1",[channelId]);
      await database.query("DELETE FROM sloptogether.application_keys WHERE twitch_channel_id=$1",[channelId]);
      await database.query("DELETE FROM sloptogether.ballots WHERE election_id IN (SELECT e.id FROM sloptogether.elections e JOIN sloptogether.segments s ON s.id=e.segment_id WHERE s.twitch_channel_id=$1)",[channelId]);
      await database.query("UPDATE sloptogether.elections SET winner_proposal_id=NULL WHERE segment_id IN (SELECT id FROM sloptogether.segments WHERE twitch_channel_id=$1)",[channelId]);
      await database.query("DELETE FROM sloptogether.proposals WHERE election_id IN (SELECT e.id FROM sloptogether.elections e JOIN sloptogether.segments s ON s.id=e.segment_id WHERE s.twitch_channel_id=$1)",[channelId]);
      await database.query("DELETE FROM sloptogether.elections WHERE segment_id IN (SELECT id FROM sloptogether.segments WHERE twitch_channel_id=$1)",[channelId]);
      await database.query("UPDATE sloptogether.segments SET selected_revision_id=NULL WHERE twitch_channel_id=$1",[channelId]);
      await database.query("DELETE FROM sloptogether.segment_revisions WHERE segment_id IN (SELECT id FROM sloptogether.segments WHERE twitch_channel_id=$1)",[channelId]);
      await database.query("DELETE FROM sloptogether.segments WHERE twitch_channel_id=$1",[channelId]);
      await database.query("DELETE FROM sloptogether.branches WHERE twitch_channel_id=$1",[channelId]);
      await database.query("DELETE FROM sloptogether.playback_sessions WHERE twitch_channel_id=$1",[channelId]);
      await database.query("DELETE FROM sloptogether.program_manifests WHERE twitch_channel_id=$1",[channelId]);
      await database.query("DELETE FROM sloptogether.streams WHERE twitch_channel_id=$1",[channelId]);
      await database.query("DELETE FROM sloptogether.boundary_revisions WHERE twitch_channel_id=$1",[channelId]);
      await database.query("DELETE FROM sloptogether.assets WHERE twitch_channel_id=$1",[channelId]);
      await database.query("DELETE FROM sloptogether.input_screens WHERE twitch_channel_id=$1",[channelId]);
      await database.query("DELETE FROM sloptogether.comfy_frame_generations WHERE twitch_channel_id=$1",[channelId]);
      await database.query("DELETE FROM sloptogether.funding_authorizations WHERE twitch_channel_id=$1",[channelId]);
      await database.query("DELETE FROM sloptogether.eventsub_config_fingerprints WHERE twitch_channel_id=$1",[channelId]);
      await database.query("DELETE FROM sloptogether.channels WHERE twitch_channel_id=$1",[channelId]);
    }
    await database?.end();
    globalThis.__sloptogetherPool=undefined;
    vi.unstubAllGlobals();vi.unstubAllEnvs();
  });

  it("submits an Extension prompt, casts a linked vote, and leases the winner to FastH3",async()=>{
    const authorId=(BigInt(channelId)+1n).toString();
    const voterId=(BigInt(channelId)+2n).toString();
    const prompt="A tiny cartoon astronaut rides a toast slice past the moon and waves.";
    const submission=await submitProposal(channelId,extensionRequest("channels/flow/proposals",authorId,{
      prompt,endFrameAssetId:endAssetId,planningMode:"planned_anchors",
    }));
    expect(submission).toMatchObject({state:"eligible",screen:"clear",awaitingUpstreamBoundary:false});
    const principal=await requestPrincipal(extensionRequest("channels/flow/elections",voterId,{}));
    expect(principal?.kind).toBe("extension");
    const ballot=await castBallot(submission.electionId,submission.proposalId,principal!,"extension",undefined,undefined);
    expect(ballot).toMatchObject({state:"recorded",choiceId:submission.proposalId});
    await database!.query("UPDATE sloptogether.channels SET chat_voting_enabled=true WHERE twitch_channel_id=$1",[channelId]);
    await database!.query(`INSERT INTO sloptogether.eventsub_config_fingerprints(twitch_channel_id,registration_key,config_fingerprint,subscription_ids)
      VALUES($1,$2,$3,ARRAY['local-chat-subscription'])`,[channelId,`chat:${channelId}`,Buffer.alloc(32,3)]);
    const chatMessageId=`local-chat-vote-${randomUUID()}`;const chatTimestamp=new Date().toISOString();
    const chatBody=Buffer.from(JSON.stringify({subscription:{id:"local-chat-subscription",type:"channel.chat.message",version:"1",
      condition:{broadcaster_user_id:channelId,user_id:channelId},transport:{method:"webhook",callback:"http://localhost:3000/sloptogether/api/v1/webhooks/eventsub"}},event:{broadcaster_user_id:channelId,
      broadcaster_user_login:`flow_${channelId}`,chatter_user_id:(BigInt(channelId)+3n).toString(),chatter_user_login:"chat_voter",
      message_id:chatMessageId,message:{text:"!slop vote 1"}}}));
    const chatSignature=createHmac("sha256",eventSubSecret).update(Buffer.concat([Buffer.from(chatMessageId+chatTimestamp),chatBody])).digest("hex");
    const chatRequest=new Request("http://127.0.0.1:3000/sloptogether/api/v1/webhooks/eventsub",{method:"POST",body:chatBody,headers:{
      "Content-Type":"application/json","Twitch-Eventsub-Message-Id":chatMessageId,"Twitch-Eventsub-Message-Timestamp":chatTimestamp,
      "Twitch-Eventsub-Message-Signature":`sha256=${chatSignature}`,"Twitch-Eventsub-Message-Type":"notification",
    }});
    expect((await handleEventSubWebhook(chatRequest)).status).toBe(204);
    const chatBallot=await database!.query<{proposal_id:string;source_surface:string}>("SELECT proposal_id,source_surface FROM sloptogether.ballots WHERE election_id=$1 AND source_surface='chat'",[submission.electionId]);
    expect(chatBallot.rows).toEqual([{proposal_id:submission.proposalId,source_surface:"chat"}]);
    await database!.query("UPDATE sloptogether.elections SET closes_at=now()-interval '1 second' WHERE id=$1",[submission.electionId]);

    const keyId=randomUUID();
    const credential=`slw_${keyId}.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-`;
    await database!.query(`INSERT INTO sloptogether.application_keys(key_id,secret_hash,key_prefix,issuing_twitch_user_id,twitch_channel_id,
      display_name,scopes,worker_roles) VALUES($1,$2,$3,$4,$5,'Local generation worker',ARRAY['worker:generation'],ARRAY['generation'])`,
      [keyId,hashWorkerSecret(credential),`slw_${keyId}`,authorId,channelId]);
    await database!.query(`INSERT INTO sloptogether.trusted_executions(twitch_channel_id,key_id,issuer_twitch_user_id,execution_role,policy_revision)
      SELECT $1,$2,$3,'generation',policy_revision FROM sloptogether.channels WHERE twitch_channel_id=$1`,[channelId,keyId,authorId]);
    const workerRequest=new Request("http://127.0.0.1:3000/sloptogether/api/v1/workers/leases?role=generation",{method:"POST",
      headers:{Authorization:`Bearer ${credential}`,"Content-Type":"application/json"},body:JSON.stringify({supportedRecipes:["fast-h3-trim-5step-vsa20-b1"]})});
    const lease=await claimWorkerLease(workerRequest);
    expect(lease).toMatchObject({status:"leased",job:{kind:"story",recipeId:"fast-h3-trim-5step-vsa20-b1",width:448,height:256,frameCount:362}});
    const queued=await database!.query<{state:string}>("SELECT state FROM sloptogether.jobs WHERE segment_revision_id=$1 AND stage='video_base'",[submission.revisionId]);
    expect(queued.rows[0]?.state).toBe("leased");
    expect(await database!.query("SELECT 1 FROM sloptogether.funding_authorizations WHERE twitch_channel_id=$1",[channelId])).toMatchObject({rowCount:0});
  },30_000);

  it("turns a signed subscription into a claimed ten-second FastH3 worker job",async()=>{
    await database!.query(`UPDATE sloptogether.channels SET subscriber_interrupt_policy=$2::jsonb,owner_budget_cap_usd=10
      WHERE twitch_channel_id=$1`,[channelId,JSON.stringify({enabled:true,newSubscriptions:true,resubscriptionMessages:false,giftMode:"off",
      minimumGapSeconds:0,eventMaxAgeSeconds:180,hourlySpendCapUsd:2,fallback:"skip"})]);
    await database!.query(`INSERT INTO sloptogether.sessions(token_hash,twitch_user_id,twitch_login,display_name,access_token_encrypted,
      granted_scopes,token_expires_at,expires_at) VALUES($1,$2,'local_owner','Local Owner',$3,ARRAY['channel:read:subscriptions'],now()+interval '1 hour',now()+interval '1 hour')`,
      [randomBytes(32),channelId,Buffer.from("local-only-token")]);
    const messageId=`local-sub-${randomUUID()}`;const timestamp=new Date().toISOString();
    await database!.query(`INSERT INTO sloptogether.eventsub_config_fingerprints(twitch_channel_id,registration_key,config_fingerprint,subscription_ids)
      VALUES($1,'subscriber-events',$2,ARRAY['local-subscription-flow'])`,[channelId,Buffer.alloc(32,4)]);
    const body=Buffer.from(JSON.stringify({subscription:{id:"local-subscription-flow",type:"channel.subscribe",version:"1",
      condition:{broadcaster_user_id:channelId},transport:{method:"webhook",callback:"http://localhost:3000/sloptogether/api/v1/webhooks/eventsub"}},event:{broadcaster_user_id:channelId,user_id:"987654321",
      user_login:"local_subscriber",user_name:"Local Subscriber",is_anonymous:false,is_gift:false}}));
    const signature=createHmac("sha256",eventSubSecret).update(Buffer.concat([Buffer.from(messageId+timestamp),body])).digest("hex");
    const eventRequest=new Request("http://127.0.0.1:3000/sloptogether/api/v1/webhooks/eventsub",{method:"POST",body,headers:{
      "Content-Type":"application/json","Twitch-Eventsub-Message-Id":messageId,"Twitch-Eventsub-Message-Timestamp":timestamp,
      "Twitch-Eventsub-Message-Signature":`sha256=${signature}`,"Twitch-Eventsub-Message-Type":"notification",
    }});
    expect((await handleEventSubWebhook(eventRequest)).status).toBe(204);
    const keyId=randomUUID();
    const credential=`slw_${keyId}.QRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOP`;
    await database!.query(`INSERT INTO sloptogether.application_keys(key_id,secret_hash,key_prefix,issuing_twitch_user_id,twitch_channel_id,
      display_name,scopes,worker_roles) VALUES($1,$2,$3,$4,$5,'Local story and generation worker',ARRAY['story:write_future','worker:generation'],ARRAY['story-producer','generation'])`,
      [keyId,hashWorkerSecret(credential),`slw_${keyId}`,channelId,channelId]);
    await database!.query(`INSERT INTO sloptogether.trusted_executions(twitch_channel_id,key_id,issuer_twitch_user_id,execution_role,policy_revision)
      SELECT $1,$2,$3,role,policy_revision FROM sloptogether.channels CROSS JOIN (VALUES('story_producer'),('generation')) roles(role)
      WHERE twitch_channel_id=$1`,[channelId,keyId,channelId]);
    const auth={Authorization:`Bearer ${credential}`,"Content-Type":"application/json"};
    const producer=await claimStoryProducer(channelId,new Request("http://127.0.0.1:3000/sloptogether/api/v1/story-producer/leases",{method:"POST",headers:auth}));
    expect(producer).toMatchObject({interruptId:expect.any(String),storyContext:{taskKind:"subscriber_interrupt",subscriberLabel:"Local Subscriber"}});
    const scene={visualAction:"A cartoon rocket blooms into confetti and gently lowers a waving astronaut onto a moon cushion.",
      camera:"One continuous playful cartoon shot.",speakerId:"S1",speakerCharacter:"a cartoon announcer",voiceDescription:"a cheerful theatrical voice",
      dialogue:"Local Subscriber just subscribed! The rocket runs on confetti!",soundscape:"A soft rocket hum and gentle confetti pops.",music:"none" as const};
    const proposal=await submitStoryProposal(channelId,new Request("http://127.0.0.1:3000/sloptogether/api/v1/story-proposals",{method:"POST",headers:auth,
      body:JSON.stringify({leaseId:producer.leaseId,fence:producer.fence,sequence:producer.sequence,idempotencyKey:producer.idempotencyKey,
        claimToken:producer.claimToken,interruptId:producer.interruptId,plan:scene,compiledH3Prompt:compileH3StoryPrompt(scene),
        plannerUsage:{provider:"template",templateId:"rocket_confetti",inputTokens:0,outputTokens:0}})}));
    expect(proposal).toMatchObject({accepted:true,state:"rendering"});
    if(!("jobId" in proposal))throw new Error("subscriber_job_not_scheduled");
    const lease=await claimWorkerLease(new Request("http://127.0.0.1:3000/sloptogether/api/v1/workers/leases?role=generation",{method:"POST",headers:auth,
      body:JSON.stringify({supportedRecipes:["fast-h3-trim-5step-vsa20-b1-10s"]})}));
    expect(lease).toMatchObject({status:"leased",job:{kind:"subscriber_interrupt",recipeId:"fast-h3-trim-5step-vsa20-b1-10s",frameCount:243,width:448,height:256}});
    const state=await database!.query<{state:string;program_state:string;duration_seconds:number;frame_count:number}>(`SELECT j.state,ir.program_state,
      (j.planning_payload->>'durationSeconds')::int AS duration_seconds,(j.planning_payload->>'frameCount')::int AS frame_count
      FROM sloptogether.jobs j JOIN sloptogether.interrupt_requests ir ON ir.id=j.interrupt_id WHERE j.id=$1`,[proposal.jobId]);
    expect(state.rows[0]).toEqual({state:"leased",program_state:"rendering",duration_seconds:10,frame_count:243});
  },30_000);

  it("marks a ready subscriber clip skipped when the controller seeks past it, but preserves it on rewind",async()=>{
    if(!channelId)throw new Error("integration_fixture_missing");
    const streamId=(await database!.query<{id:string}>("SELECT id FROM sloptogether.streams WHERE twitch_channel_id=$1 AND is_default",[channelId])).rows[0]!.id;
    const segmentId=(await database!.query<{id:string}>("SELECT id FROM sloptogether.segments WHERE twitch_channel_id=$1 ORDER BY ordinal LIMIT 1",[channelId])).rows[0]!.id;
    const interruptId=(await database!.query<{id:string}>("SELECT id FROM sloptogether.interrupt_requests WHERE broadcaster_twitch_id=$1 ORDER BY created_at DESC LIMIT 1",[channelId])).rows[0]!.id;
    const storyBeforeId=randomUUID(),interruptItemId=randomUUID(),storyAfterId=randomUUID();
    await database!.query("UPDATE sloptogether.interrupt_requests SET program_state='ready',asset_id=$2 WHERE id=$1",[interruptId,startAssetId]);
    await database!.query(`INSERT INTO sloptogether.program_items(id,twitch_channel_id,stream_id,item_kind,segment_id,interrupt_id,asset_id,item_order,source_pts_start,source_pts_end,program_epoch,committed_at)
      VALUES($1,$4,$5,'story',$6,NULL,$7,0,0,15,1,now()),($2,$4,$5,'subscriber_interrupt',NULL,$8,$7,1,15,30,1,now()),($3,$4,$5,'story',$6,NULL,$7,2,30,45,1,now())`,
    [storyBeforeId,interruptItemId,storyAfterId,channelId,streamId,segmentId,startAssetId,interruptId]);
    for(const [programItemId,start] of [[storyBeforeId,0],[interruptItemId,15],[storyAfterId,30]] as const){
      await database!.query(`INSERT INTO sloptogether.program_media_segments(program_item_id,media_asset_id,media_sequence,duration_seconds,source_pts_start,source_pts_end,sha256)
        VALUES($1,$2,0,15,$3,$4,$5)`,[programItemId,startAssetId,start,start+15,Buffer.alloc(32,7)]);
    }
    await database!.query("UPDATE sloptogether.program_manifests SET manifest_revision=1 WHERE stream_id=$1 AND program_epoch=1",[streamId]);
    const controlKeyId=randomUUID(),credential=`slw_${controlKeyId}.abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH`;
    await database!.query(`INSERT INTO sloptogether.application_keys(key_id,secret_hash,key_prefix,issuing_twitch_user_id,twitch_channel_id,
      display_name,scopes,worker_roles) VALUES($1,$2,$3,$4,$5,'Local playback controller',ARRAY['streamer:control'],ARRAY[]::text[])`,
    [controlKeyId,hashWorkerSecret(credential),`slw_${controlKeyId}`,channelId,channelId]);
    const headers={Authorization:`SlopWorker ${credential}`,"Content-Type":"application/json"};
    await database!.query(`UPDATE sloptogether.playback_sessions SET controller_user_id=$2,controller_epoch=1,event_sequence=0,
      active_item_id=$3,item_offset_seconds=14,lease_expires_at=now()+interval '1 minute' WHERE stream_id=$1`,[streamId,channelId,storyBeforeId]);
    const seekPastAlert=()=>heartbeatPlayback(channelId!,new Request("http://127.0.0.1:3000/sloptogether/api/v1/channels/playback/position",{
      method:"POST",headers,body:JSON.stringify({itemId:storyAfterId,offsetSeconds:31,controllerEpoch:1,programEpoch:1,manifestRevision:1,sequence:1}),
    }));
    await expect(seekPastAlert()).resolves.toMatchObject({accepted:true,itemId:storyAfterId});
    await expect(database!.query<{program_state:string}>("SELECT program_state FROM sloptogether.interrupt_requests WHERE id=$1",[interruptId]))
      .resolves.toMatchObject({rows:[{program_state:"skipped"}]});

    await database!.query("UPDATE sloptogether.interrupt_requests SET program_state='ready' WHERE id=$1",[interruptId]);
    await database!.query("UPDATE sloptogether.playback_sessions SET active_item_id=$2,event_sequence=1,item_offset_seconds=1 WHERE stream_id=$1",[streamId,storyAfterId]);
    await expect(heartbeatPlayback(channelId!,new Request("http://127.0.0.1:3000/sloptogether/api/v1/channels/playback/position",{
      method:"POST",headers,body:JSON.stringify({itemId:storyBeforeId,offsetSeconds:1,controllerEpoch:1,programEpoch:1,manifestRevision:1,sequence:2}),
    }))).resolves.toMatchObject({accepted:true,itemId:storyBeforeId});
    await expect(database!.query<{program_state:string}>("SELECT program_state FROM sloptogether.interrupt_requests WHERE id=$1",[interruptId]))
      .resolves.toMatchObject({rows:[{program_state:"ready"}]});
  },30_000);

  it("manually submits one screened Comfy frame and atomically queues its expiry",async()=>{
    const owner={id:channelId,twitchUserId:channelId,twitchLogin:`flow_${channelId}`,displayName:"Local Owner",
      accessToken:"local-test-token",scopes:["openid","user:read:moderated_channels"],expiresAt:new Date(Date.now()+60_000)};
    const principalSpy=vi.spyOn(principalModule,"requestPrincipal").mockResolvedValue({kind:"session",session:owner});
    const fetch=vi.fn(async(input:RequestInfo|URL)=>{
      const url=new URL(String(input));
      if(url.origin!=="https://cloud.comfy.org")throw new Error("comfy_integration_network_blocked");
      return new Response(JSON.stringify({id:randomUUID(),status:"queued",outputs:[]}),{status:201});
    });
    vi.stubGlobal("fetch",fetch);
    try{
      const requestId=randomUUID();
      const result=await createComfyFrameGeneration(`flow_${channelId}`,new Request("http://localhost:3000/sloptogether/api/v1/channels/frame/comfy-frame-generations",{
        method:"POST",headers:{Origin:"http://localhost:3000","Content-Type":"application/json"},
        body:JSON.stringify({requestId,prompt:"A tiny hand-drawn paper crane glowing above a cartoon astronaut."}),
      }));
      expect(result).toMatchObject({requestId,kind:"frame",state:"queued"});
      const generation=await database!.query<{workflow_version:string;state:string}>(
        "SELECT workflow_version,state FROM sloptogether.comfy_frame_generations WHERE id=$1",[result.id]);
      expect(generation.rows[0]).toEqual({workflow_version:"z-image-turbo-8step-448x256-v1",state:"queued"});
      const expiry=await database!.query<{aggregate_id:string;payload:{id:string};idempotency_key:string}>(
        "SELECT aggregate_id,payload,idempotency_key FROM sloptogether.outbox WHERE event_kind='comfy.frame_generation.expire' AND aggregate_id=$1",[result.id]);
      expect(expiry.rows[0]).toEqual({aggregate_id:result.id,payload:{id:result.id},idempotency_key:`comfy-frame-expire:${result.id}`});
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(preflight.screenPromptAndImages).toHaveBeenCalledWith({channelId,prompt:"A tiny hand-drawn paper crane glowing above a cartoon astronaut.",images:[]});
    }finally{principalSpy.mockRestore();}
  },30_000);
});
