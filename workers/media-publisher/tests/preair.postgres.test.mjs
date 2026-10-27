import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import pg from "pg";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { processPublishRequested } from "../src/publish.mjs";

const url=process.env.SLOPTOGETHER_PREAIR_TEST_DATABASE_URL;
const enabled=Boolean(url);
const exec=promisify(execFile);
let pool, directory, baseVideo, upscaleVideo, interruptVideo, previousFetch;
const sha=bytes=>createHash("sha256").update(bytes).digest();

before(async()=>{
  if(!enabled)return;
  const parsed=new URL(url);
  if(!["localhost","127.0.0.1","::1"].includes(parsed.hostname)||!parsed.pathname.startsWith("/sloptogether_preair_test_"))
    throw new Error("preair_integration_requires_isolated_loopback_database");
  pool=new pg.Pool({connectionString:url});
  directory=await mkdtemp(join(tmpdir(),"sloptogether-preair-test-"));
  async function video(width,height,name,duration=1){
    const path=join(directory,name);
    await exec("ffmpeg",["-hide_banner","-loglevel","error","-f","lavfi","-i",`color=c=blue:s=${width}x${height}:r=24:d=${duration}`,
      "-f","lavfi","-i",`sine=frequency=440:sample_rate=48000:duration=${duration}`,"-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac","-shortest",path]);
    return readFile(path);
  }
  baseVideo=await video(512,288,"base.mp4");
  upscaleVideo=await video(1184,666,"upscale.mp4");
  interruptVideo=await video(512,288,"subscriber-interrupt.mp4",10.125);
  previousFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({id:"test",results:[{flagged:false,categories:{},category_applied_input_types:{}}]}),{status:200,headers:{"Content-Type":"application/json"}});
});

after(async()=>{if(previousFetch)globalThis.fetch=previousFetch;await pool?.end();if(directory)await rm(directory,{recursive:true,force:true});});

async function fixture({enabled:optIn=true,planningMode="continuation"}={}){
  const channel=String(BigInt("800000000000000")+BigInt(Math.floor(Math.random()*1_000_000_000)));
  const revision=randomUUID(),image=randomUUID(),boundary=randomUUID();
  const screen=randomUUID(),base=randomUUID(),baseJob=randomUUID(),baseAttempt=randomUUID();
  const baseKey=`private/${channel}/artifacts/${base}/base.mp4`;
  const imageSha=sha(Buffer.from("image")),promptSha=sha(Buffer.from("A fox waves."));
  const screenSha=sha(Buffer.concat([promptSha,imageSha]));
  // Match proposal-service.ts: the revision digest wraps the preflight digest
  // with the prompt, boundary IDs and planning mode.
  const revisionSha=sha(Buffer.from(JSON.stringify({prompt:"A fox waves.",screen:screenSha.toString("hex"),start:boundary,end:planningMode==="planned_anchors"?boundary:null,mode:planningMode})));
  const baseSha=sha(baseVideo);
  await pool.query(`INSERT INTO sloptogether.channels(twitch_channel_id,owner_twitch_user_id,twitch_login,display_name,preair_upscale_enabled)
    VALUES($1,$1,$2,'Test',$3)`,[channel,"preair"+channel,optIn]);
  const main=(await pool.query("SELECT b.id AS branch_id,s.id AS segment_id FROM sloptogether.streams st JOIN sloptogether.branches b ON b.stream_id=st.id AND b.is_selected JOIN sloptogether.segments s ON s.branch_id=b.id AND s.ordinal=0 WHERE st.twitch_channel_id=$1 AND st.is_default",[channel])).rows[0];
  const branch=main.branch_id,segment=main.segment_id;
  await pool.query("INSERT INTO sloptogether.assets(id,twitch_channel_id,storage_key,sha256,media_kind,content_type,status) VALUES($1,$2,$3,$4,'image','image/png','approved')",[image,channel,`private/${channel}/image`,imageSha]);
  await pool.query("INSERT INTO sloptogether.boundary_revisions(id,twitch_channel_id,asset_id,created_by) VALUES($1,$2,$3,$2)",[boundary,channel,image]);
  await pool.query(`INSERT INTO sloptogether.segment_revisions(id,segment_id,revision,prompt,start_boundary_revision_id,requested_end_boundary_revision_id,planning_mode,provider_recipe_id,input_sha256,requested_by,state)
    VALUES($1,$2,1,'A fox waves.',$3,CASE WHEN $6='planned_anchors' THEN $3::uuid ELSE NULL END,$6,'fast-h3-trim-5step-vsa20-b1',$4,$5,'ready')`,[revision,segment,boundary,revisionSha,channel,planningMode]);
  await pool.query("UPDATE sloptogether.segments SET selected_revision_id=$2,state='ready' WHERE id=$1",[segment,revision]);
  await pool.query(`INSERT INTO sloptogether.input_screens(id,twitch_channel_id,input_sha256,prompt_sha256,image_sha256s,moderation_model,moderation_policy_revision,automated_state,effective_state,expires_at)
    VALUES($1,$2,$3,$4,$5,'test',1,'clear','clear',now()+interval '1 hour')`,[screen,channel,screenSha,promptSha,[imageSha.toString("hex")]]);
  await pool.query(`INSERT INTO sloptogether.assets(id,twitch_channel_id,storage_key,sha256,media_kind,content_type,byte_size,width,height,fps_num,fps_den,duration_seconds,status)
    VALUES($1,$2,$3,$4,'video','video/mp4',$5,512,288,24,1,1,'approved')`,[base,channel,baseKey,baseSha,baseVideo.length]);
  await pool.query(`INSERT INTO sloptogether.jobs(id,twitch_channel_id,segment_revision_id,stage,execution_mode,state,recipe_id,recipe_sha256,input_sha256,requested_by,planning_payload)
    VALUES($1,$2,$3,'video_base','pull_worker','succeeded','test',$4,$5,$2,$6::jsonb)`,[baseJob,channel,revision,revisionSha,revisionSha,JSON.stringify({inputScreenId:screen,outputWidth:512,outputHeight:288})]);
  await pool.query(`INSERT INTO sloptogether.job_attempts(id,job_id,attempt_number,fence,client_idempotency_key,state,input_sha256,output_asset_id)
    VALUES($1,$2,1,1,$3,'succeeded',$4,$5)`,[baseAttempt,baseJob,`base:${baseAttempt}`,revisionSha,base]);
  await pool.query(`INSERT INTO sloptogether.artifact_approvals(asset_id,sha256,input_screen_id,approval_path,reviewer_twitch_user_id,trust_policy_revision,decision)
    VALUES($1,$2,$3,'human_review',$4,1,'approved')`,[base,baseSha,screen,channel]);
  const outbox=await pool.query(`INSERT INTO sloptogether.outbox(event_kind,aggregate_id,payload,idempotency_key,leased_until)
    VALUES('media.publish_requested',$1,$2::jsonb,$3,date_trunc('milliseconds',now()+interval '5 minutes')) RETURNING id,leased_until`,[base,JSON.stringify({assetId:base}),`publish:${base}`]);
  const message={id:outbox.rows[0].id,leaseUntil:outbox.rows[0].leased_until,payload:{assetId:base}};
  const objects=new Map([[baseKey,baseVideo]]);
  const storage={send:async(command)=>{
    const key=command.input.Key;
    if(command instanceof GetObjectCommand){const body=objects.get(key);if(!body)throw new Error("missing test object");return {Body:Readable.from([body]),ContentLength:body.length};}
    if(command instanceof PutObjectCommand){objects.set(key,Buffer.from(command.input.Body));return {};}
    throw new Error("unsupported test storage command");
  }};
  return {channel,segment,revision,revisionSha,screen,base,baseJob,baseSha,baseKey,message,objects,storage};
}

async function publish(f,extraConfig={}){return processPublishRequested({pool,storage:f.storage,config:{bucket:"test",tempDir:directory,minDurationSeconds:0.5,maxDurationSeconds:2,segmentSeconds:1,openAiKey:"test",...extraConfig},message:f.message});}
async function reLease(f){const row=await pool.query("UPDATE sloptogether.outbox SET leased_until=date_trunc('milliseconds',now()+interval '5 minutes') WHERE id=$1 RETURNING leased_until",[f.message.id]);f.message.leaseUntil=row.rows[0].leased_until;}
async function approveUpscale(f,job,{bytes=upscaleVideo,uploader=null}={}){
  const child=randomUUID(),childKey=`private/${f.channel}/artifacts/${child}/upscale.mp4`,childSha=sha(bytes);
  f.objects.set(childKey,bytes);
  await pool.query(`INSERT INTO sloptogether.assets(id,twitch_channel_id,storage_key,sha256,media_kind,content_type,byte_size,width,height,fps_num,fps_den,duration_seconds,status,uploaded_by_twitch_user_id)
    VALUES($1,$2,$3,$4,'video','video/mp4',$5,1184,666,24,1,1,'approved',$6)`,[child,f.channel,childKey,childSha,bytes.length,uploader]);
  await pool.query("UPDATE sloptogether.jobs SET state='succeeded' WHERE id=$1",[job]);
  await pool.query("UPDATE sloptogether.job_attempts SET state='succeeded',output_asset_id=$2 WHERE job_id=$1",[job,child]);
  await pool.query(`INSERT INTO sloptogether.artifact_approvals(asset_id,sha256,input_screen_id,approval_path,reviewer_twitch_user_id,trust_policy_revision,decision)
    VALUES($1,$2,$3,'human_review',$4,1,'approved')`,[child,childSha,f.screen,f.channel]);
  return child;
}

test("disabled policy keeps existing base publication",{skip:!enabled,timeout:90_000},async()=>{
  const f=await fixture({enabled:false});
  assert.equal((await pool.query("SELECT sloptogether.schedule_preair_upscale($1) AS id",[f.base])).rows[0].id,null);
  const result=await publish(f);
  assert.equal(result.status,"published");
  assert.equal((await pool.query("SELECT asset_id FROM sloptogether.program_items WHERE segment_id=$1",[f.segment])).rows[0].asset_id,f.base);
});

test("planned-anchor clips retain their original continuity path",{skip:!enabled,timeout:90_000},async()=>{
  const f=await fixture({planningMode:"planned_anchors"});
  assert.equal((await pool.query("SELECT sloptogether.schedule_preair_upscale($1) AS id",[f.base])).rows[0].id,null);
  assert.equal((await publish(f)).status,"published");
  assert.equal((await pool.query("SELECT asset_id FROM sloptogether.program_items WHERE segment_id=$1",[f.segment])).rows[0].asset_id,f.base);
});

test("publishes a 10-second subscriber interrupt into the stream HLS program",{skip:!enabled,timeout:90_000},async()=>{
  const f=await fixture();
  const stream=(await pool.query("SELECT id FROM sloptogether.streams WHERE twitch_channel_id=$1 AND is_default",[f.channel])).rows[0].id;
  const event=randomUUID(),interrupt=randomUUID(),funding=randomUUID(),job=randomUUID(),attempt=randomUUID(),asset=randomUUID();
  const key=`private/${f.channel}/artifacts/${asset}/subscriber-interrupt.mp4`,assetSha=sha(interruptVideo);
  const inputSha=sha(Buffer.from(`interrupt:${interrupt}`));
  await pool.query("UPDATE sloptogether.channels SET subscriber_interrupt_policy=$2::jsonb WHERE twitch_channel_id=$1",[f.channel,
    JSON.stringify({enabled:true,newSubscriptions:true,resubscriptionMessages:false,giftMode:"off",minimumGapSeconds:0,eventMaxAgeSeconds:180,hourlySpendCapUsd:5,fallback:"skip"})]);
  await pool.query(`INSERT INTO sloptogether.subscription_events(id,twitch_message_id,event_type,broadcaster_twitch_id,twitch_actor_id,is_anonymous,event_payload,event_at,state)
    VALUES($1,$2,'channel.subscribe',$3,'777',false,'{}'::jsonb,now(),'rendering')`,[event,`local-publish-event-${event}`,f.channel]);
  await pool.query(`INSERT INTO sloptogether.funding_authorizations(id,twitch_channel_id,source,purchaser_twitch_user_id,action_intent_id,reserved_usd,state)
    VALUES($1,$2,'owner_budget',$2,$3,0.25,'reserved')`,[funding,f.channel,interrupt]);
  await pool.query(`INSERT INTO sloptogether.interrupt_requests(id,broadcaster_twitch_id,stream_id,trigger_event_id,idempotency_key,subscriber_label,
    plan_payload,program_state,funding_id,expires_at) VALUES($1,$2,$3,$4,$5,'Local Subscriber',$6::jsonb,'rendering',$7,now()+interval '3 minutes')`,
    [interrupt,f.channel,stream,event,`local-publish-interrupt-${interrupt}`,JSON.stringify({kind:"subscriber_interrupt",durationSeconds:10,frameCount:243}),funding]);
  await pool.query("UPDATE sloptogether.subscription_events SET interrupt_id=$2 WHERE id=$1",[event,interrupt]);
  await pool.query(`INSERT INTO sloptogether.assets(id,twitch_channel_id,storage_key,sha256,media_kind,content_type,byte_size,width,height,fps_num,fps_den,duration_seconds,status)
    VALUES($1,$2,$3,$4,'video','video/mp4',$5,512,288,24,1,10.125,'approved')`,[asset,f.channel,key,assetSha,interruptVideo.length]);
  await pool.query(`INSERT INTO sloptogether.jobs(id,twitch_channel_id,segment_revision_id,interrupt_id,stage,execution_mode,state,recipe_id,recipe_sha256,input_sha256,requested_by,funding_id,planning_payload)
    VALUES($1,$2,$3,$4,'video_base','pull_worker','succeeded','fast-h3-trim-5step-vsa20-b1-10s',$5,$6,$2,$7,$8::jsonb)`,
    [job,f.channel,f.revision,interrupt,f.revisionSha,inputSha,funding,JSON.stringify({prompt:"A friendly cartoon subscriber gag.",outputWidth:512,outputHeight:288,durationSeconds:10,frameCount:243})]);
  await pool.query(`INSERT INTO sloptogether.job_attempts(id,job_id,attempt_number,fence,client_idempotency_key,state,input_sha256,output_asset_id,funding_id)
    VALUES($1,$2,1,1,$3,'succeeded',$4,$5,$6)`,[attempt,job,`local-interrupt-attempt-${attempt}`,inputSha,asset,funding]);
  await pool.query(`INSERT INTO sloptogether.artifact_approvals(asset_id,sha256,input_screen_id,approval_path,reviewer_twitch_user_id,trust_policy_revision,decision)
    VALUES($1,$2,$3,'human_review',$4,1,'approved')`,[asset,assetSha,f.screen,f.channel]);
  const outbox=await pool.query(`INSERT INTO sloptogether.outbox(event_kind,aggregate_id,payload,idempotency_key,leased_until)
    VALUES('media.publish_requested',$1,$2::jsonb,$3,date_trunc('milliseconds',now()+interval '5 minutes')) RETURNING id,leased_until`,
    [asset,JSON.stringify({assetId:asset}),`local-subscriber-publish:${asset}`]);
  f.objects.set(key,interruptVideo);
  const result=await processPublishRequested({pool,storage:f.storage,config:{bucket:"test",tempDir:directory,minDurationSeconds:13,maxDurationSeconds:17,segmentSeconds:1},
    message:{id:outbox.rows[0].id,leaseUntil:outbox.rows[0].leased_until,payload:{assetId:asset}}});
  assert.equal(result.status,"published");
  const program=await pool.query(`SELECT pi.item_kind,pi.interrupt_id,pi.stream_id,pm.program_epoch,pm.manifest_revision,pm.channel_duration_seconds
    FROM sloptogether.program_items pi JOIN sloptogether.program_manifests pm ON pm.stream_id=pi.stream_id AND pm.program_epoch=pi.program_epoch
    WHERE pi.interrupt_id=$1`,[interrupt]);
  assert.equal(program.rowCount,1);
  assert.equal(program.rows[0].item_kind,"subscriber_interrupt");
  assert.equal(program.rows[0].stream_id,stream);
  assert.ok(Number(program.rows[0].channel_duration_seconds)>=9.5&&Number(program.rows[0].channel_duration_seconds)<=10.5);
  assert.ok(Number(program.rows[0].manifest_revision)>0);
  const hls=await pool.query("SELECT count(*)::int AS count FROM sloptogether.program_media_segments pms JOIN sloptogether.program_items pi ON pi.id=pms.program_item_id WHERE pi.interrupt_id=$1",[interrupt]);
  assert.ok(hls.rows[0].count>=10);
  assert.deepEqual((await pool.query("SELECT program_state,asset_id FROM sloptogether.interrupt_requests WHERE id=$1",[interrupt])).rows[0],{program_state:"ready",asset_id:asset});
  assert.equal((await pool.query("SELECT state FROM sloptogether.subscription_events WHERE id=$1",[event])).rows[0].state,"ready");
  assert.equal((await pool.query("SELECT state FROM sloptogether.funding_authorizations WHERE id=$1",[funding])).rows[0].state,"consumed_succeeded");
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM sloptogether.preair_upscale_requests WHERE base_asset_id=$1",[asset])).rows[0].count,0);
});

test("private channels do not schedule pre-air GPU work",{skip:!enabled,timeout:90_000},async()=>{
  const f=await fixture();
  await pool.query("UPDATE sloptogether.channels SET visibility='private' WHERE twitch_channel_id=$1",[f.channel]);
  assert.equal((await pool.query("SELECT sloptogether.schedule_preair_upscale($1) AS id",[f.base])).rows[0].id,null);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM sloptogether.preair_upscale_requests WHERE base_asset_id=$1",[f.base])).rows[0].n,0);
});

test("legacy channel-sized bases schedule the legacy 1080p recipe",{skip:!enabled,timeout:90_000},async()=>{
  const f=await fixture();
  await pool.query("UPDATE sloptogether.assets SET width=1280,height=720 WHERE id=$1",[f.base]);
  const job=(await pool.query("SELECT sloptogether.schedule_preair_upscale($1) AS id",[f.base])).rows[0].id;
  const row=(await pool.query("SELECT recipe_id,planning_payload FROM sloptogether.jobs WHERE id=$1",[job])).rows[0];
  assert.equal(row.recipe_id,"sol-h3-upscale-pruna-fast");
  assert.deepEqual({width:row.planning_payload.outputWidth,height:row.planning_payload.outputHeight},{width:1920,height:1080});
});

test("approved derivative is published once before the base can air",{skip:!enabled,timeout:90_000},async()=>{
  const f=await fixture();
  const priorSegment=randomUUID(),priorAsset=randomUUID(),priorItem=randomUUID();
  const stream=(await pool.query("SELECT id FROM sloptogether.streams WHERE twitch_channel_id=$1 AND is_default",[f.channel])).rows[0].id;
  await pool.query("UPDATE sloptogether.segments SET ordinal=1 WHERE id=$1",[f.segment]);
  await pool.query(`INSERT INTO sloptogether.segments(id,twitch_channel_id,branch_id,ordinal,state)
    SELECT $1,twitch_channel_id,branch_id,0,'played' FROM sloptogether.segments WHERE id=$2`,[priorSegment,f.segment]);
  await pool.query("INSERT INTO sloptogether.assets(id,twitch_channel_id,storage_key,sha256,media_kind,content_type,status) VALUES($1,$2,$3,$4,'video','video/mp4','published')",[priorAsset,f.channel,`private/${f.channel}/prior`,sha(baseVideo)]);
  await pool.query(`INSERT INTO sloptogether.program_items(id,twitch_channel_id,stream_id,item_kind,segment_id,asset_id,item_order,source_pts_start,source_pts_end,program_epoch,committed_at)
    VALUES($1,$2,$3,'story',$4,$5,0,0,1,1,now())`,[priorItem,f.channel,stream,priorSegment,priorAsset]);
  await pool.query("UPDATE sloptogether.program_manifests SET manifest_revision=1,channel_duration_seconds=1 WHERE stream_id=$1 AND program_epoch=1",[stream]);
  const priorBefore=(await pool.query("SELECT to_jsonb(pi) AS row FROM sloptogether.program_items pi WHERE id=$1",[priorItem])).rows[0].row;
  const job=(await pool.query("SELECT sloptogether.schedule_preair_upscale($1) AS id",[f.base])).rows[0].id;
  assert.ok(job);
  const recipe=(await pool.query("SELECT recipe_id,encode(recipe_sha256,'hex') AS digest FROM sloptogether.jobs WHERE id=$1",[job])).rows[0];
  assert.equal(recipe.recipe_id,"sol-h3-upscale-pruna-fast-1184-v1");
  assert.equal(recipe.digest,createHash("sha256").update(await readFile(new URL("../../runtime/src/sloptogether_worker/assets/recipes/sol-upscale-1184-v1.json",import.meta.url))).digest("hex"));
  assert.equal((await publish(f)).status,"waiting_for_upscale");
  const child=await approveUpscale(f,job);
  await reLease(f);
  assert.equal((await publish(f)).status,"published");
  assert.equal((await pool.query("SELECT asset_id FROM sloptogether.program_items WHERE segment_id=$1",[f.segment])).rows[0].asset_id,child);
  assert.deepEqual((await pool.query("SELECT state,selected_asset_id FROM sloptogether.preair_upscale_requests WHERE base_asset_id=$1",[f.base])).rows[0],{state:"selected",selected_asset_id:child});
  assert.equal((await pool.query("SELECT status FROM sloptogether.assets WHERE id=$1",[f.base])).rows[0].status,"approved");
  assert.deepEqual((await pool.query("SELECT to_jsonb(pi) AS row FROM sloptogether.program_items pi WHERE id=$1",[priorItem])).rows[0].row,priorBefore);
});

test("concurrent publisher deliveries cannot commit two items for the same pre-air choice",{skip:!enabled,timeout:90_000},async()=>{
  const f=await fixture();
  const job=(await pool.query("SELECT sloptogether.schedule_preair_upscale($1) AS id",[f.base])).rows[0].id;
  const child=await approveUpscale(f,job);
  const results=await Promise.all([publish(f),publish(f)]);
  assert.equal(results.filter(result=>result.status==="published").length,1);
  const items=await pool.query("SELECT asset_id FROM sloptogether.program_items WHERE segment_id=$1",[f.segment]);
  assert.equal(items.rowCount,1);assert.equal(items.rows[0].asset_id,child);
});

test("a failed upscale releases the approved base",{skip:!enabled,timeout:90_000},async()=>{
  const f=await fixture();
  const job=(await pool.query("SELECT sloptogether.schedule_preair_upscale($1) AS id",[f.base])).rows[0].id;
  await pool.query("UPDATE sloptogether.jobs SET state='failed' WHERE id=$1",[job]);
  await pool.query("UPDATE sloptogether.job_attempts SET state='rejected' WHERE job_id=$1",[job]);
  assert.equal((await publish(f)).status,"published");
  assert.equal((await pool.query("SELECT asset_id FROM sloptogether.program_items WHERE segment_id=$1",[f.segment])).rows[0].asset_id,f.base);
  assert.deepEqual((await pool.query("SELECT state,fallback_reason FROM sloptogether.preair_upscale_requests WHERE base_asset_id=$1",[f.base])).rows[0],{state:"fallback",fallback_reason:"upscale_failed"});
});

test("fallback never spends or changes the paid base's single funding attempt",{skip:!enabled,timeout:90_000},async()=>{
  const f=await fixture(),funding=randomUUID();
  await pool.query(`INSERT INTO sloptogether.funding_authorizations(id,twitch_channel_id,source,purchaser_twitch_user_id,amount_bits,reserved_usd,state)
    VALUES($1,$2,'twitch_extension_bits','777',100,1,'consumed_succeeded')`,[funding,f.channel]);
  await pool.query("UPDATE sloptogether.jobs SET funding_id=$2 WHERE id=$1",[f.baseJob,funding]);
  await pool.query("UPDATE sloptogether.job_attempts SET funding_id=$2 WHERE job_id=$1",[f.baseJob,funding]);
  const job=(await pool.query("SELECT sloptogether.schedule_preair_upscale($1) AS id",[f.base])).rows[0].id;
  assert.equal((await pool.query("SELECT funding_id FROM sloptogether.jobs WHERE id=$1",[job])).rows[0].funding_id,null);
  assert.equal((await pool.query("SELECT funding_id FROM sloptogether.job_attempts WHERE job_id=$1",[job])).rows[0].funding_id,null);
  await pool.query("UPDATE sloptogether.jobs SET state='failed' WHERE id=$1",[job]);
  assert.equal((await publish(f)).status,"published");
  assert.equal((await pool.query("SELECT state FROM sloptogether.funding_authorizations WHERE id=$1",[funding])).rows[0].state,"consumed_succeeded");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM sloptogether.job_attempts WHERE funding_id=$1",[funding])).rows[0].n,1);
});

test("continuation uses the actual approved upscale's screened end frame",{skip:!enabled,timeout:90_000},async()=>{
  const f=await fixture();
  await pool.query("UPDATE sloptogether.segment_revisions SET planning_mode='continuation',requested_end_boundary_revision_id=NULL WHERE id=$1",[f.revision]);
  const job=(await pool.query("SELECT sloptogether.schedule_preair_upscale($1) AS id",[f.base])).rows[0].id;
  const child=await approveUpscale(f,job);
  const previousFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({id:"test",results:[{flagged:false,categories:{},category_applied_input_types:{}}]}),{status:200,headers:{"Content-Type":"application/json"}});
  try{assert.equal((await publish(f,{openAiKey:"test"})).status,"published");}finally{globalThis.fetch=previousFetch;}
  const endpoint=await pool.query(`SELECT er.source_artifact_id,a.width,a.height FROM sloptogether.endpoint_resolutions er
    JOIN sloptogether.boundary_revisions b ON b.id=er.resolved_end_boundary_revision_id JOIN sloptogether.assets a ON a.id=b.asset_id
    WHERE er.segment_revision_id=$1`,[f.revision]);
  assert.deepEqual(endpoint.rows[0],{source_artifact_id:child,width:1184,height:666});
});

test("a held source fences pre-air work and never publishes",{skip:!enabled,timeout:90_000},async()=>{
  const f=await fixture();
  const job=(await pool.query("SELECT sloptogether.schedule_preair_upscale($1) AS id",[f.base])).rows[0].id;
  await pool.query("UPDATE sloptogether.input_screens SET effective_state='held' WHERE id=$1",[f.screen]);
  assert.equal((await publish(f)).status,"stale");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM sloptogether.program_items WHERE segment_id=$1",[f.segment])).rows[0].n,0);
  const attempt=(await pool.query("SELECT state,fence FROM sloptogether.job_attempts WHERE job_id=$1",[job])).rows[0];
  assert.equal(attempt.state,"expired");assert.equal(Number(attempt.fence),2);
  assert.deepEqual((await pool.query("SELECT state,fallback_reason FROM sloptogether.preair_upscale_requests WHERE base_asset_id=$1",[f.base])).rows[0],{state:"fallback",fallback_reason:"base_no_longer_eligible"});
});

test("a banned upscale contributor causes fallback to the approved base",{skip:!enabled,timeout:90_000},async()=>{
  const f=await fixture();
  const job=(await pool.query("SELECT sloptogether.schedule_preair_upscale($1) AS id",[f.base])).rows[0].id;
  const child=await approveUpscale(f,job,{uploader:"777"});
  await pool.query("INSERT INTO sloptogether.bans(twitch_user_id,twitch_channel_id,scope,reason,issued_by) VALUES('777',$1,'channel','test',$1)",[f.channel]);
  assert.equal((await publish(f)).status,"published");
  assert.equal((await pool.query("SELECT asset_id FROM sloptogether.program_items WHERE segment_id=$1",[f.segment])).rows[0].asset_id,f.base);
  assert.equal((await pool.query("SELECT fallback_reason FROM sloptogether.preair_upscale_requests WHERE base_asset_id=$1",[f.base])).rows[0].fallback_reason,"upscale_banned");
  assert.notEqual(child,f.base);
});

test("a revoked derivative during HLS packaging falls back without changing history",{skip:!enabled,timeout:90_000},async()=>{
  const f=await fixture();
  const job=(await pool.query("SELECT sloptogether.schedule_preair_upscale($1) AS id",[f.base])).rows[0].id;
  const child=await approveUpscale(f,job);
  let revoked=false;
  const send=f.storage.send;
  f.storage.send=async(command)=>{
    if(command instanceof PutObjectCommand&&!revoked){revoked=true;await pool.query("UPDATE sloptogether.artifact_approvals SET decision='revoked' WHERE asset_id=$1",[child]);}
    return send(command);
  };
  assert.equal((await publish(f)).status,"waiting_for_upscale");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM sloptogether.program_items WHERE segment_id=$1",[f.segment])).rows[0].n,0);
  await reLease(f);
  assert.equal((await publish(f)).status,"published");
  assert.equal((await pool.query("SELECT asset_id FROM sloptogether.program_items WHERE segment_id=$1",[f.segment])).rows[0].asset_id,f.base);
  assert.equal((await pool.query("SELECT fallback_reason FROM sloptogether.preair_upscale_requests WHERE base_asset_id=$1",[f.base])).rows[0].fallback_reason,"upscale_rejected");
});

test("invalid derivative encoding falls back to the valid base",{skip:!enabled,timeout:90_000},async()=>{
  const f=await fixture();
  const job=(await pool.query("SELECT sloptogether.schedule_preair_upscale($1) AS id",[f.base])).rows[0].id;
  const child=await approveUpscale(f,job,{bytes:baseVideo});
  assert.equal((await publish(f)).status,"upscale_fallback");
  assert.equal((await pool.query("SELECT status FROM sloptogether.assets WHERE id=$1",[child])).rows[0].status,"rejected");
  await reLease(f);
  assert.equal((await publish(f)).status,"published");
  assert.equal((await pool.query("SELECT asset_id FROM sloptogether.program_items WHERE segment_id=$1",[f.segment])).rows[0].asset_id,f.base);
});

test("expired running upscale is fenced before the approved base is committed",{skip:!enabled,timeout:90_000},async()=>{
  const f=await fixture();
  const job=(await pool.query("SELECT sloptogether.schedule_preair_upscale($1) AS id",[f.base])).rows[0].id;
  await pool.query("UPDATE sloptogether.preair_upscale_requests SET deadline_at=now()-interval '1 second' WHERE base_asset_id=$1",[f.base]);
  await pool.query("UPDATE sloptogether.jobs SET state='running' WHERE id=$1",[job]);
  await pool.query("UPDATE sloptogether.job_attempts SET state='running',lease_expires_at=now()+interval '30 seconds' WHERE job_id=$1",[job]);
  const reservation=randomUUID();
  await pool.query(`INSERT INTO sloptogether.upload_reservations(id,attempt_id,fence,staging_key,max_bytes,content_type,expires_at,state)
    SELECT $1,id,fence,$2,1000,'video/mp4',now()+interval '30 seconds','issued' FROM sloptogether.job_attempts WHERE job_id=$3`,[reservation,`incoming/${f.channel}/${reservation}`,job]);
  assert.equal((await publish(f)).status,"published");
  const attempt=(await pool.query("SELECT state,fence FROM sloptogether.job_attempts WHERE job_id=$1",[job])).rows[0];
  assert.equal(attempt.state,"expired");assert.equal(Number(attempt.fence),2);
  assert.equal((await pool.query("SELECT state FROM sloptogether.upload_reservations WHERE id=$1",[reservation])).rows[0].state,"expired");
  assert.deepEqual((await pool.query("SELECT state,fallback_reason FROM sloptogether.preair_upscale_requests WHERE base_asset_id=$1",[f.base])).rows[0],{state:"fallback",fallback_reason:"deadline_expired"});
  assert.equal((await pool.query("SELECT asset_id FROM sloptogether.program_items WHERE segment_id=$1",[f.segment])).rows[0].asset_id,f.base);
});

test("mismatched job and revision digests cannot schedule a pre-air job",{skip:!enabled,timeout:90_000},async()=>{
  const f=await fixture();
  await pool.query("UPDATE sloptogether.jobs SET input_sha256=$2 WHERE id=$1",[f.baseJob,sha(Buffer.from("different input"))]);
  assert.equal((await pool.query("SELECT sloptogether.schedule_preair_upscale($1) AS id",[f.base])).rows[0].id,null);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM sloptogether.preair_upscale_requests WHERE base_asset_id=$1",[f.base])).rows[0].n,0);
});

test("an approval for a different clear screen cannot schedule a pre-air job",{skip:!enabled,timeout:90_000},async()=>{
  const f=await fixture();
  const other=randomUUID(),digest=sha(Buffer.from("other screen"));
  await pool.query(`INSERT INTO sloptogether.input_screens(id,twitch_channel_id,input_sha256,prompt_sha256,moderation_model,moderation_policy_revision,automated_state,effective_state,expires_at)
    VALUES($1,$2,$3,$3,'test',1,'clear','clear',now()+interval '1 hour')`,[other,f.channel,digest]);
  await pool.query("UPDATE sloptogether.artifact_approvals SET input_screen_id=$2 WHERE asset_id=$1",[f.base,other]);
  assert.equal((await pool.query("SELECT sloptogether.schedule_preair_upscale($1) AS id",[f.base])).rows[0].id,null);
});

test("a tampered child binding fails closed without committing either clip",{skip:!enabled,timeout:90_000},async()=>{
  const f=await fixture();
  const job=(await pool.query("SELECT sloptogether.schedule_preair_upscale($1) AS id",[f.base])).rows[0].id;
  await pool.query("UPDATE sloptogether.jobs SET input_sha256=$2 WHERE id=$1",[job,sha(Buffer.from("different source"))]);
  assert.equal((await publish(f)).status,"waiting_for_upscale");
  const retry=(await pool.query("SELECT extract(epoch FROM (available_at-now())) AS seconds,leased_until FROM sloptogether.outbox WHERE id=$1",[f.message.id])).rows[0];
  assert.ok(Number(retry.seconds)>0&&Number(retry.seconds)<=10);assert.equal(retry.leased_until,null);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM sloptogether.program_items WHERE segment_id=$1",[f.segment])).rows[0].n,0);
});

test("an expired invalid binding falls back without fencing its unverified job",{skip:!enabled,timeout:90_000},async()=>{
  const f=await fixture();
  const job=(await pool.query("SELECT sloptogether.schedule_preair_upscale($1) AS id",[f.base])).rows[0].id;
  await pool.query("UPDATE sloptogether.jobs SET input_sha256=$2 WHERE id=$1",[job,sha(Buffer.from("different source"))]);
  await pool.query("UPDATE sloptogether.preair_upscale_requests SET deadline_at=now()-interval '1 second' WHERE base_asset_id=$1",[f.base]);
  assert.equal((await publish(f)).status,"published");
  assert.deepEqual((await pool.query("SELECT state,fallback_reason FROM sloptogether.preair_upscale_requests WHERE base_asset_id=$1",[f.base])).rows[0],{state:"fallback",fallback_reason:"binding_invalid"});
  const attempt=(await pool.query("SELECT state,fence FROM sloptogether.job_attempts WHERE job_id=$1",[job])).rows[0];
  assert.equal(attempt.state,"ready");assert.equal(Number(attempt.fence),1);
  assert.equal((await pool.query("SELECT asset_id FROM sloptogether.program_items WHERE segment_id=$1",[f.segment])).rows[0].asset_id,f.base);
});
