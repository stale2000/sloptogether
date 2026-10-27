import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { validateOne } from "../src/index.mjs";

const url=process.env.SLOPTOGETHER_PREAIR_TEST_DATABASE_URL;
const enabled=Boolean(url);
let pool;

after(async()=>{await pool?.end();});

test("expired validation attempts are rejected before snapshot download or publication",{skip:!enabled},async()=>{
  const parsed=new URL(url);
  assert.ok(["localhost","127.0.0.1","::1"].includes(parsed.hostname),"validation integration requires loopback Postgres");
  assert.ok(parsed.pathname.startsWith("/sloptogether_preair_test_"),"validation integration requires a disposable test database");
  pool=new pg.Pool({connectionString:url});

  const channel=String(BigInt("900000000000000")+BigInt(Math.floor(Math.random()*1_000_000_000)));
  const revision=randomUUID(),image=randomUUID(),boundary=randomUUID(),screen=randomUUID();
  const job=randomUUID(),attempt=randomUUID(),asset=randomUUID(),reservation=randomUUID();
  const prompt="A cartoon fox waves at the moon.";
  const inputSha=createHash("sha256").update("screened input").digest();
  const promptSha=createHash("sha256").update(prompt).digest();
  const imageSha=createHash("sha256").update("approved start frame").digest();
  const outputSha=createHash("sha256").update("late output bytes").digest();
  const storageKey=`private/${channel}/artifacts/${asset}/output.mp4`;

  await pool.query(`INSERT INTO sloptogether.channels(twitch_channel_id,owner_twitch_user_id,twitch_login,display_name)
    VALUES($1,$1,$2,'Validation test')`,[channel,`validation${channel}`]);
  const segment=(await pool.query(`SELECT s.id FROM sloptogether.streams st JOIN sloptogether.branches b ON b.stream_id=st.id AND b.is_selected
    JOIN sloptogether.segments s ON s.branch_id=b.id WHERE st.twitch_channel_id=$1 AND st.is_default AND s.ordinal=0`,[channel])).rows[0].id;
  await pool.query(`INSERT INTO sloptogether.assets(id,twitch_channel_id,storage_key,sha256,media_kind,content_type,status)
    VALUES($1,$2,$3,$4,'image','image/png','approved')`,[image,channel,`private/${channel}/frame.png`,imageSha]);
  await pool.query(`INSERT INTO sloptogether.boundary_revisions(id,twitch_channel_id,asset_id,created_by) VALUES($1,$2,$3,$2)`,[boundary,channel,image]);
  await pool.query(`INSERT INTO sloptogether.segment_revisions(id,segment_id,revision,prompt,start_boundary_revision_id,planning_mode,provider_recipe_id,input_sha256,requested_by,state)
    VALUES($1,$2,1,$3,$4,'continuation','fast-h3-trim-5step-vsa20-b1',$5,$6,'locked')`,[revision,segment,prompt,boundary,inputSha,channel]);
  await pool.query("UPDATE sloptogether.segments SET selected_revision_id=$2,state='rendering',protected_at=now() WHERE id=$1",[segment,revision]);
  await pool.query(`INSERT INTO sloptogether.input_screens(id,twitch_channel_id,input_sha256,prompt_sha256,image_sha256s,moderation_model,moderation_policy_revision,automated_state,effective_state,expires_at)
    VALUES($1,$2,$3,$4,ARRAY[$5],'validation-test',1,'clear','clear',now()+interval '1 hour')`,[screen,channel,inputSha,promptSha,imageSha.toString("hex")]);
  await pool.query(`INSERT INTO sloptogether.assets(id,twitch_channel_id,storage_key,sha256,media_kind,content_type,byte_size,status)
    VALUES($1,$2,$3,$4,'video','video/mp4',16,'quarantine')`,[asset,channel,storageKey,outputSha]);
  await pool.query(`INSERT INTO sloptogether.jobs(id,twitch_channel_id,segment_revision_id,stage,execution_mode,state,recipe_id,recipe_sha256,input_sha256,requested_by,planning_payload)
    VALUES($1,$2,$3,'video_base','pull_worker','validating','fast-h3-trim-5step-vsa20-b1',$4,$4,$2,$5::jsonb)`,[job,channel,revision,inputSha,JSON.stringify({inputScreenId:screen})]);
  await pool.query(`INSERT INTO sloptogether.job_attempts(id,job_id,attempt_number,fence,client_idempotency_key,state,attempt_deadline_at,input_sha256,output_asset_id)
    VALUES($1,$2,1,7,$3,'validating',clock_timestamp()-interval '1 minute',$4,$5)`,[attempt,job,`validation:${attempt}`,inputSha,asset]);
  await pool.query(`INSERT INTO sloptogether.upload_reservations(id,attempt_id,fence,staging_key,max_bytes,content_type,expires_at,immutable_snapshot_key,snapshot_sha256,state)
    VALUES($1,$2,7,$3,1024,'video/mp4',now()+interval '1 hour',$4,$5,'snapshotted')`,[reservation,attempt,`incoming/${channel}/${attempt}/output.mp4`,storageKey,outputSha]);
  const payload={assetId:asset,attemptId:attempt,jobId:job,channelId:channel,fence:7,sha256:outputSha.toString("hex"),storageKey,stage:"video_base",inputScreenId:screen};
  const outbox=(await pool.query(`INSERT INTO sloptogether.outbox(event_kind,aggregate_id,payload,idempotency_key,leased_until)
    VALUES('media.validate',$1,$2::jsonb,$3,date_trunc('milliseconds',clock_timestamp()+interval '5 minutes')) RETURNING id,leased_until`,[asset,JSON.stringify(payload),`validate:${attempt}`])).rows[0];
  let snapshotReads=0;
  const storage={send:async()=>{snapshotReads+=1;throw new Error("expired_attempt_must_not_download");}};

  const result=await validateOne(pool,storage,{}, {id:outbox.id,leaseUntil:outbox.leased_until,payload});
  assert.deepEqual(result,{status:"rejected",code:"worker_attempt_expired"});
  assert.equal(snapshotReads,0);
  const state=(await pool.query(`SELECT ja.state AS attempt_state,ja.error_code,j.state AS job_state,a.status AS asset_status,
      sr.state AS revision_state,s.state AS segment_state,s.protected_at,o.delivered_at
    FROM sloptogether.job_attempts ja JOIN sloptogether.jobs j ON j.id=ja.job_id JOIN sloptogether.assets a ON a.id=ja.output_asset_id
    JOIN sloptogether.segment_revisions sr ON sr.id=j.segment_revision_id JOIN sloptogether.segments s ON s.id=sr.segment_id
    JOIN sloptogether.outbox o ON o.id=$2 WHERE ja.id=$1`,[attempt,outbox.id])).rows[0];
  assert.deepEqual(state,{attempt_state:"rejected",error_code:"worker_attempt_expired",job_state:"failed",asset_status:"rejected",revision_state:"rejected",segment_state:"open",protected_at:null,delivered_at:state.delivered_at});
  assert.ok(state.delivered_at instanceof Date);
});
