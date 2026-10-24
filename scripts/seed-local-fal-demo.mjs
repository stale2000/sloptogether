import { createHash,randomBytes,randomUUID } from "node:crypto";
import { readFile,stat,writeFile,chmod } from "node:fs/promises";
import { S3Client,PutObjectCommand } from "@aws-sdk/client-s3";
import pg from "pg";
import { assertLocalDemoDatabase,assertLocalDemoEnvironment } from "./local-demo-guard.mjs";

const {Pool}=pg;
const channelId="900000001";
const login="localdemo";
const recipeId="fast-h3-trim-5step-vsa20-b1";
const recipeSha=Buffer.from("9a2d5d19fb22b7e55d29c8e6048c4c421c5b73b044b7cc010188efe7df9ccaef","hex");
const falVideoPath=process.env.FAL_SMOKE_VIDEO??"/tmp/sloptogether-fal-test/sloptogether-fal-smoke.mp4";
const startPath=process.env.FAL_SMOKE_START_FRAME??"/tmp/sloptogether-fal-test/start.png";
const endPath=process.env.FAL_SMOKE_END_FRAME??"/tmp/sloptogether-fal-test/end.png";

function digest(bytes){return createHash("sha256").update(bytes).digest();}
function revisionDigest(prompt,screenHash,startId,endId){
  return digest(Buffer.from(JSON.stringify({prompt,screen:screenHash,start:startId,end:endId,mode:"planned_anchors"})));
}

const databaseUrl=process.env.DATABASE_URL;const endpointValue=process.env.SLOPTOGETHER_LOCAL_S3_ENDPOINT;
const publicUrl=process.env.PUBLIC_APP_URL;
assertLocalDemoEnvironment({nodeEnv:process.env.NODE_ENV,databaseUrl,storageUrl:endpointValue,publicUrl});
const storageProbe=await fetch(endpointValue,{method:"OPTIONS",headers:{Origin:publicUrl},signal:AbortSignal.timeout(3000)}).catch(()=>null);
if(storageProbe?.status!==204||storageProbe.headers.get("x-sloptogether-local-store")!=="loopback-v1")
  throw new Error("local_demo_storage_emulator_required");
const bucket=process.env.R2_BUCKET_NAME;const pepper=process.env.SLOPTOGETHER_KEY_HASH_PEPPER;
if(!bucket||!pepper||pepper.length<32||!process.env.R2_ACCESS_KEY_ID||!process.env.R2_SECRET_ACCESS_KEY)throw new Error("local_demo_storage_or_key_config_missing");
const videoInfo=await stat(falVideoPath);
if(!videoInfo.isFile()||videoInfo.size===0)throw new Error("local_demo_video_fixture_invalid");
const [startBytes,endBytes]=await Promise.all([readFile(startPath),readFile(endPath)]);
const startSha=digest(startBytes),endSha=digest(endBytes),screenId=randomUUID(),startAsset=randomUUID(),endAsset=randomUUID();
const startBoundary=randomUUID(),endBoundary=randomUUID(),revisionId=randomUUID(),jobId=randomUUID(),attemptId=randomUUID(),keyId=randomUUID();
const prompt="A playful 16:9 animated sci-fi shot: a tiny maintenance robot finds a glowing blue crystal inside a quiet spaceship corridor, looks surprised, then carefully picks it up. The robot says clearly, “I found a spark of stardust!” Gentle camera push-in, clear single action, family-friendly, synchronized ambient sound.";
const screenHash=digest(Buffer.from(JSON.stringify({prompt,images:[startSha.toString("hex"),endSha.toString("hex")]})));
const inputHash=revisionDigest(prompt,screenHash.toString("hex"),startBoundary,endBoundary);
const startKey=`private/${channelId}/images/${startAsset}/start.png`,endKey=`private/${channelId}/images/${endAsset}/end.png`;
const accessSecret=randomBytes(32).toString("base64url"),workerKey=`slw_${keyId}.${accessSecret}`;
const secretHash=createHash("sha256").update(pepper).update("\0").update(workerKey).digest();
const ownerKey=process.env.SLOPTOGETHER_TOKEN_ENCRYPTION_KEY;
if(!ownerKey)throw new Error("local_demo_web_environment_missing");
const workerEnv=`SLOPTOGETHER_WORKER_KEY=${workerKey}\nSLOPTOGETHER_API_BASE_URL=http://localhost:3000/sloptogether/api/v1\nSLOPTOGETHER_WORKER_ROLE=generation\nSLOPTOGETHER_WORKER_PLATFORM=linux\nSLOPTOGETHER_CHANNEL_ID=${channelId}\nSLOPTOGETHER_LOCAL_S3_ENDPOINT=${endpointValue}\nSLOPTOGETHER_WORKER_HOME=/tmp/sloptogether-local-worker\nSLOPTOGETHER_COMFY_URL=http://127.0.0.1:8188\n`;
const workerEnvPath="/tmp/sloptogether-worker.env";
const s3=new S3Client({region:endpointValue?"us-east-1":"auto",endpoint:endpointValue,forcePathStyle:true,
  credentials:{accessKeyId:process.env.R2_ACCESS_KEY_ID,secretAccessKey:process.env.R2_SECRET_ACCESS_KEY}});
const pool=new Pool({connectionString:databaseUrl,max:1,application_name:"sloptogether-local-fal-demo-seed"});
async function ensureLocalDemoChannel(){
  const client=await pool.connect();
  try{
    const identity=await client.query(`SELECT current_database() AS database_name,current_setting('data_directory') AS data_directory,
      host(inet_server_addr()) AS server_address,inet_server_port() AS server_port`);
    assertLocalDemoDatabase(identity.rows[0]??{});
    await client.query("BEGIN");
    await client.query(`INSERT INTO sloptogether.channels(twitch_channel_id,owner_twitch_user_id,twitch_login,display_name)
      VALUES($1,$1,$2,'Local Demo Channel') ON CONFLICT(twitch_channel_id) DO NOTHING`,[channelId,login]);
    const channel=await client.query("SELECT owner_twitch_user_id,twitch_login,display_name FROM sloptogether.channels WHERE twitch_channel_id=$1 FOR UPDATE",[channelId]);
    if(!channel.rowCount||channel.rows[0].owner_twitch_user_id!==channelId||channel.rows[0].twitch_login!==login)
      throw new Error("local_demo_channel_fixture_conflict");
    let branch=await client.query("SELECT id FROM sloptogether.branches WHERE twitch_channel_id=$1 AND is_selected AND archived_at IS NULL LIMIT 1",[channelId]);
    if(!branch.rowCount)branch=await client.query(`INSERT INTO sloptogether.branches(twitch_channel_id,name,is_selected,created_by)
      VALUES($1,'Main story',true,$1) RETURNING id`,[channelId]);
    await client.query(`INSERT INTO sloptogether.segments(twitch_channel_id,branch_id,ordinal,state)
      VALUES($1,$2,0,'open') ON CONFLICT(branch_id,ordinal) DO NOTHING`,[channelId,branch.rows[0].id]);
    await client.query("INSERT INTO sloptogether.playback_sessions(twitch_channel_id) VALUES($1) ON CONFLICT(twitch_channel_id) DO NOTHING",[channelId]);
    await client.query(`INSERT INTO sloptogether.memberships(twitch_user_id,twitch_channel_id,role,status)
      VALUES($1,$1,'broadcaster','active') ON CONFLICT(twitch_user_id,twitch_channel_id) DO NOTHING`,[channelId]);
    await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release();}
}
try{
  await ensureLocalDemoChannel();
  const channel=await pool.query("SELECT owner_twitch_user_id,policy_revision,output_width,output_height FROM sloptogether.channels WHERE twitch_channel_id=$1 AND twitch_login=$2 AND is_enabled",[channelId,login]);
  if(!channel.rowCount||channel.rows[0].owner_twitch_user_id!==channelId||Number(channel.rows[0].policy_revision)!==1
    ||Number(channel.rows[0].output_width)!==1280||Number(channel.rows[0].output_height)!==720)throw new Error("local_demo_channel_fixture_missing_or_changed");
  const slot=await pool.query("SELECT id,branch_id FROM sloptogether.segments WHERE twitch_channel_id=$1 AND ordinal=0 AND state='open' AND selected_revision_id IS NULL AND protected_at IS NULL",[channelId]);
  if(slot.rows.length!==1)throw new Error("local_demo_open_slot_missing");
  const existing=await pool.query("SELECT 1 FROM sloptogether.application_keys WHERE key_id=$1",[keyId]);
  if(existing.rowCount)throw new Error("local_demo_random_key_collision");
  await s3.send(new PutObjectCommand({Bucket:bucket,Key:startKey,Body:startBytes,ContentLength:startBytes.length,ContentType:"image/png"}));
  await s3.send(new PutObjectCommand({Bucket:bucket,Key:endKey,Body:endBytes,ContentLength:endBytes.length,ContentType:"image/png"}));
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    await client.query("SELECT twitch_channel_id FROM sloptogether.channels WHERE twitch_channel_id=$1 AND policy_revision=1 FOR UPDATE",[channelId]);
    await client.query(`INSERT INTO sloptogether.input_screens(id,twitch_channel_id,input_sha256,prompt_sha256,image_sha256s,moderation_model,moderation_policy_revision,
      category_flags,applied_input_types,automated_state,effective_state,expires_at)
      VALUES($1,$2,$3,$4,$5,'local-demo-fixture',1,'{}'::jsonb,'{"prompt":true,"images":true}'::jsonb,'clear','clear',now()+interval '1 day')`,
      [screenId,channelId,screenHash,digest(Buffer.from(prompt)),[startSha.toString("hex"),endSha.toString("hex")]]);
    await client.query(`INSERT INTO sloptogether.assets(id,twitch_channel_id,storage_key,sha256,media_kind,content_type,byte_size,width,height,status,uploaded_by_twitch_user_id)
      VALUES($1,$2,$3,$4,'image','image/png',$5,1280,720,'approved',$6),($7,$2,$8,$9,'image','image/png',$10,1280,720,'approved',$6)`,
      [startAsset,channelId,startKey,startSha,startBytes.length,channelId,endAsset,endKey,endSha,endBytes.length]);
    await client.query(`INSERT INTO sloptogether.boundary_revisions(id,twitch_channel_id,asset_id,transformation,created_by,moderation_evidence_id)
      VALUES($1,$2,$3,'{"kind":"local_fal_test_start"}'::jsonb,$4,$5),($6,$2,$7,'{"kind":"local_fal_test_end"}'::jsonb,$4,$5)`,
      [startBoundary,channelId,startAsset,channelId,screenId,endBoundary,endAsset]);
    const revision=await client.query(`INSERT INTO sloptogether.segment_revisions(id,segment_id,revision,prompt,visual_prompt,dialogue,start_boundary_revision_id,requested_end_boundary_revision_id,
      planning_mode,provider_recipe_id,input_sha256,requested_by,state)
      VALUES($1,$2,1,$3,$3,'I found a spark of stardust!',$4,$5,'planned_anchors',$6,$7,'900000002','selected') RETURNING id`,
      [revisionId,slot.rows[0].id,prompt,startBoundary,endBoundary,recipeId,inputHash]);
    await client.query("UPDATE sloptogether.segments SET selected_revision_id=$2,state='rendering',protected_at=now() WHERE id=$1",[slot.rows[0].id,revision.rows[0].id]);
    await client.query(`INSERT INTO sloptogether.application_keys(key_id,secret_hash,key_prefix,issuing_twitch_user_id,twitch_channel_id,display_name,scopes,worker_roles,recipe_ids)
      VALUES($1,$2,$3,$4,$4,'Local Fal smoke worker',ARRAY['worker:generation','artifact:system_approve'],ARRAY['generation'],ARRAY[$5])`,
      [keyId,secretHash,workerKey.slice(0,12),channelId,recipeId]);
    await client.query(`INSERT INTO sloptogether.trusted_executions(twitch_channel_id,key_id,issuer_twitch_user_id,execution_role,recipe_ids,policy_revision)
      VALUES($1,$2,$3,'generation',ARRAY[$4],1)`,[channelId,keyId,channelId,recipeId]);
    await client.query(`INSERT INTO sloptogether.jobs(id,twitch_channel_id,segment_revision_id,stage,execution_mode,state,recipe_id,recipe_sha256,input_sha256,
      requested_by,planning_payload,priority,result_deadline_at)
      VALUES($1,$2,$3,'video_base','pull_worker','ready',$4,$5,$6,'900000002',$7::jsonb,100,now()+interval '1 hour')`,
      [jobId,channelId,revision.rows[0].id,recipeId,recipeSha,inputHash,JSON.stringify({inputScreenId:screenId,startBoundaryRevisionId:startBoundary,startFrameAssetId:startAsset})]);
    await client.query(`INSERT INTO sloptogether.job_attempts(id,job_id,attempt_number,fence,client_idempotency_key,state,attempt_deadline_at,input_sha256)
      VALUES($1,$2,1,1,$3,'ready',now()+interval '1 hour',$4)`,[attemptId,jobId,`local-fal-smoke:${jobId}`,inputHash]);
    await client.query("INSERT INTO sloptogether.endpoint_resolution_dependencies(resolution_id,dependent_job_id) SELECT id,$2 FROM sloptogether.endpoint_resolutions WHERE resolved_end_boundary_revision_id=$1 AND retired_at IS NULL ON CONFLICT DO NOTHING",[startBoundary,jobId]);
    await client.query("INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,actor_key_id,action,target_kind,target_id,after_state) VALUES($1,$2,$3,'local_demo.fal_job','job',$4,$5::jsonb)",
      [channelId,channelId,keyId,jobId,JSON.stringify({segmentId:slot.rows[0].id,revisionId:revision.rows[0].id,recipeId,localOnly:true})]);
    await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release();}
  await writeFile(workerEnvPath,workerEnv,{mode:0o600});await chmod(workerEnvPath,0o600);
  console.log(JSON.stringify({channel:login,segmentId:slot.rows[0].id,revisionId,jobId,workerEnvPath,workerRole:"generation",approvalPath:"trusted_execution_policy",localOnly:true}));
}finally{await pool.end();await s3.destroy();}
