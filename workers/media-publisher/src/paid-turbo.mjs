import { createHash,randomUUID } from "node:crypto";
import { createReadStream,createWriteStream } from "node:fs";
import { mkdtemp,rm,stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { DeleteObjectCommand,GetObjectCommand,PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { cancelFalTurbo,FalTurboError,falCdnReadToken,falInput,falRequestId,falTurboResult,falVideoResult,submitFalTurbo,falTurboStatus } from "./fal-turbo.mjs";

const execFileAsync=promisify(execFile);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PROVIDER_JSON_BYTES=1024*1024;

export function falSubmitOutcome(code){
  const definitelyRejected=(/^fal_http_4\d\d$/.test(String(code))&&code!=="fal_http_408")||code==="fal_input_invalid"||code==="fal_key_missing";
  return definitelyRejected?"paid_unfulfilled":"consumed_uncertain";
}

export function falResultErrorDisposition(code,attempts){
  const permanent=new Set(["fal_video_result_invalid","fal_result_request_mismatch","fal_cdn_content_type_invalid","fal_video_too_large","fal_video_empty",
    "fal_input_probe_failed","fal_input_probe_invalid","fal_output_profile_invalid","fal_output_conformance_failed","fal_output_size_invalid"]);
  if(permanent.has(code))return "failed";
  if(/^fal_(?:http|cdn_http)_(?:408|429|5\d\d)$/.test(code))return "retry";
  const repeatedProviderError=(/^fal_(?:http|cdn_http)_4\d\d$/.test(code)||["fal_response_invalid_json","fal_response_too_large","fal_cdn_token_invalid"].includes(code));
  return repeatedProviderError&&attempts>=3?"failed":"retry";
}

function canonicalJson(value){
  if(Array.isArray(value))return `[${value.map(canonicalJson).join(",")}]`;
  if(value&&typeof value==="object")return `{${Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>`${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value)??"null";
}

function snapshotDigest(value){return createHash("sha256").update(canonicalJson(value)).digest();}
function queryDigest(value){return Buffer.isBuffer(value)?value:Buffer.from(value??[]);}

async function begin(pool){const client=await pool.connect();await client.query("BEGIN");return client;}
async function rollback(client){await client.query("ROLLBACK").catch(()=>undefined);client.release();}
async function commit(client){await client.query("COMMIT");client.release();}

async function finishOutbox(client,message){
  await client.query("UPDATE sloptogether.outbox SET delivered_at=now(),leased_until=NULL WHERE id=$1 AND delivered_at IS NULL AND leased_until=$2",[message.id,message.leaseUntil]);
}

async function finishStaleMessage(pool,message){
  await pool.query("UPDATE sloptogether.outbox SET delivered_at=now(),leased_until=NULL WHERE id=$1 AND delivered_at IS NULL AND leased_until=$2",[message.id,message.leaseUntil]);
  return {stale:true};
}

async function schedulePoll(client,dispatch,generation,delaySeconds=10){
  await client.query(`INSERT INTO sloptogether.outbox(event_kind,aggregate_id,payload,idempotency_key,available_at)
    VALUES('paid.turbo.poll',$1,$2::jsonb,$3,now()+($4::int*interval '1 second')) ON CONFLICT(idempotency_key) DO NOTHING`,
    [dispatch.attempt_id,JSON.stringify({attemptId:dispatch.attempt_id,requestId:dispatch.request_id,generation}),
      `paid-turbo-poll:${dispatch.attempt_id}:${generation}`,delaySeconds]);
}

async function setOutcome(client,dispatch,outcome,reason,{reopen=false}={}){
  const consumed=outcome!=="paid_unfulfilled";
  if(["failed","cancelled","ingested"].includes(dispatch.dispatch_state))return;
  await client.query(`UPDATE sloptogether.paid_turbo_dispatches SET state=CASE WHEN state='cancelled' THEN state ELSE 'failed' END,
    poll_generation=poll_generation+1,failure_code=$2,completed_at=now(),updated_at=now() WHERE id=$1`,
    [dispatch.id,reason.slice(0,80)]);
  await client.query("UPDATE sloptogether.jobs SET state='failed',completed_at=now() WHERE id=$1 AND state NOT IN ('succeeded','failed','expired','cancelled')",[dispatch.job_id]);
  await client.query("UPDATE sloptogether.job_attempts SET state='failed',finished_at=now(),error_code=$2 WHERE id=$1 AND state NOT IN ('succeeded','failed','rejected','expired','cancelled')",
    [dispatch.attempt_id,reason.slice(0,80)]);
  await client.query("UPDATE sloptogether.funding_authorizations SET state=$2,consumed_at=coalesce(consumed_at,now()),settled_at=now() WHERE id=(SELECT funding_id FROM sloptogether.jobs WHERE id=$1)",
    [dispatch.job_id,consumed?outcome:"paid_unfulfilled"]);
  await client.query("UPDATE sloptogether.paid_action_intents SET state=$2,state_reason=$3,updated_at=now() WHERE id=$1",
    [dispatch.intent_id,consumed?outcome:"paid_unfulfilled",reason.slice(0,500)]);
  await client.query("UPDATE sloptogether.extension_bits_transactions SET settlement_state=$2,processed_at=now() WHERE intent_id=$1",
    [dispatch.intent_id,consumed?outcome:"paid_unfulfilled"]);
  await client.query(`INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,action,target_kind,target_id,after_state)
    SELECT p.twitch_channel_id,p.twitch_user_id,'bits.turbo.outcome','paid_action_intent',p.id,$2::jsonb
    FROM sloptogether.paid_action_intents p WHERE p.id=$1`,[dispatch.intent_id,JSON.stringify({state:consumed?outcome:"paid_unfulfilled",reason:reason.slice(0,500)})]);
  if(reopen){
    const revision=await client.query("SELECT segment_revision_id FROM sloptogether.jobs WHERE id=$1",[dispatch.job_id]);
    const revisionId=revision.rows[0]?.segment_revision_id;
    if(revisionId){
      await client.query(`UPDATE sloptogether.segment_revisions r SET state='superseded' WHERE r.id=$1 AND r.state NOT IN ('played','superseded')
        AND EXISTS(SELECT 1 FROM sloptogether.segments s WHERE s.id=r.segment_id AND s.selected_revision_id=r.id AND s.state NOT IN ('played','retired')
          AND NOT EXISTS(SELECT 1 FROM sloptogether.program_items pi WHERE pi.segment_id=s.id AND pi.committed_at IS NOT NULL))`,[revisionId]);
      await client.query(`UPDATE sloptogether.proposals p SET state='superseded',reviewed_at=now(),review_reason=$2
        WHERE p.segment_revision_id=$1 AND p.state='selected' AND EXISTS(SELECT 1 FROM sloptogether.segments s WHERE s.selected_revision_id=p.segment_revision_id
          AND s.state NOT IN ('played','retired') AND NOT EXISTS(SELECT 1 FROM sloptogether.program_items pi WHERE pi.segment_id=s.id AND pi.committed_at IS NOT NULL))`,[revisionId,reason.slice(0,500)]);
      await client.query(`UPDATE sloptogether.elections e SET state='closed',winner_proposal_id=NULL,closed_by=NULL
        WHERE e.segment_id=(SELECT segment_id FROM sloptogether.segment_revisions r JOIN sloptogether.segments s ON s.id=r.segment_id
          WHERE r.id=$1 AND s.selected_revision_id=r.id AND s.state NOT IN ('played','retired')
            AND NOT EXISTS(SELECT 1 FROM sloptogether.program_items pi WHERE pi.segment_id=s.id AND pi.committed_at IS NOT NULL)) AND e.state='selected'`,[revisionId]);
      await client.query(`UPDATE sloptogether.segments s SET state='open',selected_revision_id=NULL,protected_at=NULL
        WHERE s.selected_revision_id=$1 AND s.state NOT IN ('played','retired')
          AND NOT EXISTS(SELECT 1 FROM sloptogether.program_items pi WHERE pi.segment_id=s.id AND pi.committed_at IS NOT NULL)`,[revisionId]);
    }
  }
}

async function dispatchContext(client,jobId){
  const identity=await client.query(`SELECT j.twitch_channel_id FROM sloptogether.jobs j WHERE j.id=$1 AND j.execution_mode='provider_queue'`,[jobId]);
  const channelId=identity.rows[0]?.twitch_channel_id;if(!channelId)return null;
  await client.query("SELECT twitch_channel_id FROM sloptogether.channels WHERE twitch_channel_id=$1 FOR UPDATE",[channelId]);
  const result=await client.query(`SELECT d.id,d.state AS dispatch_state,d.request_id,d.poll_generation,d.snapshot_sha256,d.intent_id,d.job_id,d.attempt_id,
      j.twitch_channel_id,j.segment_revision_id,j.stage,j.execution_mode,j.state AS job_state,j.requested_by,j.funding_id,j.planning_payload,j.result_deadline_at,j.recipe_id,j.recipe_sha256,j.input_sha256 AS job_input_sha256,
      a.state AS attempt_state,a.fence,a.provider_request_id,a.input_sha256 AS attempt_input_sha256,a.output_asset_id,a.attempt_deadline_at,
      i.twitch_user_id AS purchaser_id,i.product_sku,i.amount_bits AS intent_amount_bits,i.state AS intent_state,i.segment_id AS intent_segment_id,i.input_screen_id,i.input_sha256 AS intent_input_sha256,
      i.policy_revision AS intent_policy_revision,i.dispatch_snapshot,i.dispatch_snapshot_sha256,i.receipt_transaction_id,
      f.state AS funding_state,f.source,f.twitch_transaction_id,f.amount_bits AS funding_amount_bits,f.purchaser_twitch_user_id AS funding_purchaser_id,
      bt.state AS transaction_state,bt.settlement_state,bt.product_sku AS transaction_sku,bt.amount_bits AS transaction_amount_bits,bt.purchaser_twitch_user_id AS transaction_purchaser_id,
      c.policy_revision AS channel_policy_revision,c.visibility,c.is_enabled,c.output_width,c.output_height,c.output_fps_num,c.output_fps_den,
      s.selected_revision_id,s.state AS segment_state,b.is_selected AS branch_selected,b.archived_at AS branch_archived_at,r.prompt,r.input_sha256 AS revision_input_sha256,
      scr.effective_state,scr.expires_at AS screen_expires_at,scr.input_sha256 AS screen_sha256,scr.moderation_model,scr.moderation_policy_revision,
      sb.id AS start_boundary_id,sb.retired_at AS start_retired_at,sb.asset_id AS start_asset_id,sa.storage_key AS start_storage_key,sa.sha256 AS start_sha256,sa.status AS start_status,
      eb.id AS end_boundary_id,eb.retired_at AS end_retired_at,eb.asset_id AS end_asset_id,ea.storage_key AS end_storage_key,ea.sha256 AS end_sha256,ea.status AS end_status,
      EXISTS(SELECT 1 FROM sloptogether.program_items pi WHERE pi.segment_id=s.id AND pi.committed_at IS NOT NULL) AS committed,
      EXISTS(SELECT 1 FROM sloptogether.job_attempts a2 JOIN sloptogether.jobs j2 ON j2.id=a2.job_id WHERE j2.segment_revision_id=r.id
        AND j2.stage='video_base' AND a2.state IN ('leased','running','uploaded','validating') AND a2.id<>a.id) AS competing_attempt,
      EXISTS(SELECT 1 FROM sloptogether.bans b WHERE b.twitch_user_id=ANY(ARRAY[j.requested_by,i.twitch_user_id]) AND b.revoked_at IS NULL
        AND (b.expires_at IS NULL OR b.expires_at>now()) AND (b.scope='global' OR b.twitch_channel_id=j.twitch_channel_id)) AS banned
    FROM sloptogether.paid_turbo_dispatches d JOIN sloptogether.jobs j ON j.id=d.job_id
    JOIN sloptogether.job_attempts a ON a.id=d.attempt_id AND a.job_id=j.id
    JOIN sloptogether.paid_action_intents i ON i.id=d.intent_id
    JOIN sloptogether.funding_authorizations f ON f.id=j.funding_id AND f.paid_action_intent_id=i.id
    JOIN sloptogether.extension_bits_transactions bt ON bt.transaction_id=f.twitch_transaction_id AND bt.intent_id=i.id
    JOIN sloptogether.channels c ON c.twitch_channel_id=j.twitch_channel_id
    JOIN sloptogether.segment_revisions r ON r.id=j.segment_revision_id
    JOIN sloptogether.segments s ON s.id=r.segment_id
    JOIN sloptogether.branches b ON b.id=s.branch_id
    JOIN sloptogether.input_screens scr ON scr.id=i.input_screen_id AND scr.twitch_channel_id=c.twitch_channel_id
    JOIN sloptogether.boundary_revisions sb ON sb.id=r.start_boundary_revision_id
    JOIN sloptogether.assets sa ON sa.id=sb.asset_id AND sa.media_kind='image'
    LEFT JOIN sloptogether.boundary_revisions eb ON eb.id=r.requested_end_boundary_revision_id
    LEFT JOIN sloptogether.assets ea ON ea.id=eb.asset_id AND ea.media_kind='image'
    WHERE d.job_id=$1 FOR UPDATE OF d,j,a,i,f,bt,s,r,b,scr,sb,sa`,[jobId]);
  return result.rows[0]??null;
}

function snapshotMatches(row){
  const parsed=row.dispatch_snapshot;
  if(!parsed||typeof parsed!=="object"||Array.isArray(parsed)||!queryDigest(row.dispatch_snapshot_sha256).equals(snapshotDigest(parsed))
    ||!queryDigest(row.snapshot_sha256).equals(queryDigest(row.dispatch_snapshot_sha256)))return false;
  return parsed.schemaVersion===1&&parsed.channelId===row.twitch_channel_id&&parsed.policyRevision===row.intent_policy_revision
    &&parsed.segmentId===row.intent_segment_id&&parsed.segmentRevisionId===row.segment_revision_id&&parsed.prompt===row.prompt
    &&parsed.input?.screenId===row.input_screen_id&&parsed.input?.screenSha256===row.screen_sha256?.toString("hex")
    &&parsed.input?.revisionSha256===row.revision_input_sha256?.toString("hex")&&parsed.input?.moderationModel===row.moderation_model
    &&queryDigest(row.intent_input_sha256).equals(queryDigest(row.revision_input_sha256))
    &&queryDigest(row.job_input_sha256).equals(queryDigest(row.revision_input_sha256))
    &&queryDigest(row.attempt_input_sha256).equals(queryDigest(row.revision_input_sha256))
    &&parsed.input?.moderationPolicyRevision===row.moderation_policy_revision&&parsed.recipeSha256===queryDigest(row.recipe_sha256).toString("hex")
    &&parsed.durationSeconds===15&&parsed.promptExpansionMode==="disabled"&&parsed.enableSafetyChecker===true&&parsed.syncMode===false
    &&row.recipe_id===`fal/minimax/h3-max-turbo-${String(parsed.resolution).toLowerCase()}`
    &&row.planning_payload?.dispatchSnapshotHash===queryDigest(row.dispatch_snapshot_sha256).toString("hex")
    &&parsed.start?.boundaryRevisionId===row.start_boundary_id
    &&parsed.start?.assetId===row.start_asset_id&&parsed.start?.sha256===row.start_sha256?.toString("hex")
    &&(parsed.end===null?row.end_boundary_id===null&&row.end_asset_id===null
      :parsed.end?.boundaryRevisionId===row.end_boundary_id&&parsed.end?.assetId===row.end_asset_id&&parsed.end?.sha256===row.end_sha256?.toString("hex"));
}

function dispatchEligible(row){
  return Boolean(row&&row.dispatch_state==="ready"&&row.job_state==="ready"&&row.attempt_state==="ready"&&row.stage==="video_base"&&row.execution_mode==="provider_queue"
    &&row.intent_state==="reserved"&&row.funding_state==="reserved"&&row.source==="twitch_extension_bits"&&row.settlement_state==="reserved"
    &&row.transaction_state==="reserved"&&row.product_sku===row.transaction_sku&&row.intent_amount_bits===row.transaction_amount_bits
    &&row.intent_amount_bits===row.funding_amount_bits&&row.purchaser_id===row.funding_purchaser_id&&row.purchaser_id===row.transaction_purchaser_id
    &&row.receipt_transaction_id===row.twitch_transaction_id&&row.is_enabled&&row.visibility!=="private"
    &&row.channel_policy_revision===row.intent_policy_revision&&row.selected_revision_id===row.segment_revision_id
    &&["selected","locked","rendering","ready"].includes(row.segment_state)
    &&row.branch_selected&&row.branch_archived_at===null&&row.start_retired_at===null&&(!row.end_boundary_id||row.end_retired_at===null)
    &&!row.committed&&!row.competing_attempt&&!row.banned&&row.effective_state==="clear"&&(!row.screen_expires_at||new Date(row.screen_expires_at).getTime()>Date.now())
    &&row.start_status&&["approved","published"].includes(row.start_status)&&Buffer.isBuffer(row.start_sha256)
    &&(!row.end_boundary_id||row.end_status&&["approved","published"].includes(row.end_status)&&Buffer.isBuffer(row.end_sha256))
    &&snapshotMatches(row)&&row.attempt_deadline_at.getTime()>Date.now());
}

async function privateImageUrls(storage,config,row){
  const startUrl=await getSignedUrl(storage,new GetObjectCommand({Bucket:config.bucket,Key:row.start_storage_key}),{expiresIn:3500});
  const endUrl=row.end_storage_key?await getSignedUrl(storage,new GetObjectCommand({Bucket:config.bucket,Key:row.end_storage_key}),{expiresIn:3500}):null;
  falInput(row.dispatch_snapshot,startUrl,endUrl);
  return {startUrl,endUrl};
}

async function startDispatch(pool,storage,config,message){
  const payload=message.payload&&typeof message.payload==="object"?message.payload:{};
  if(!UUID.test(message.aggregateId)||payload.jobId!==message.aggregateId||!UUID.test(payload.intentId??""))return finishStaleMessage(pool,message);
  const client=await begin(pool);let row;
  try{
    row=await dispatchContext(client,message.aggregateId);
    if(!row||row.intent_id!==payload.intentId||row.receipt_transaction_id!==payload.transactionId){await finishOutbox(client,message);await commit(client);return {stale:true};}
    if(row.dispatch_state==="submitting"){
      await client.query("UPDATE sloptogether.paid_turbo_dispatches SET state='uncertain',failure_code='dispatch_acknowledgement_lost',updated_at=now() WHERE id=$1 AND state='submitting'",[row.id]);
      await client.query("UPDATE sloptogether.paid_action_intents SET state='consumed_uncertain',state_reason='dispatch_acknowledgement_lost',updated_at=now() WHERE id=$1",[row.intent_id]);
      await client.query("UPDATE sloptogether.extension_bits_transactions SET settlement_state='consumed_uncertain' WHERE intent_id=$1",[row.intent_id]);
      await finishOutbox(client,message);await commit(client);return {uncertain:true};
    }
    if(row.dispatch_state!=="ready"){
      await finishOutbox(client,message);await commit(client);return {duplicate:true};
    }
    if(!config.paidBitsReady||!config.falKey||!dispatchEligible(row)){
      await setOutcome(client,row,"paid_unfulfilled",!config.paidBitsReady?"paid_dispatch_gates_disabled":!config.falKey?"fal_key_missing":"dispatch_preflight_not_current",{reopen:true});
      await finishOutbox(client,message);await commit(client);return {unfulfilled:true};
    }
    await client.query("UPDATE sloptogether.paid_turbo_dispatches SET state='submitting',dispatch_started_at=now(),updated_at=now() WHERE id=$1 AND state='ready'",[row.id]);
    await client.query("UPDATE sloptogether.job_attempts SET state='uncertain',claimed_at=now(),lease_expires_at=attempt_deadline_at WHERE id=$1 AND state='ready'",[row.attempt_id]);
    await client.query("UPDATE sloptogether.jobs SET state='uncertain' WHERE id=$1 AND state='ready'",[row.job_id]);
    await client.query("UPDATE sloptogether.funding_authorizations SET state='consumed_uncertain',consumed_at=coalesce(consumed_at,now()) WHERE id=$1 AND state='reserved'",[row.funding_id]);
    await client.query("UPDATE sloptogether.paid_action_intents SET state='consumed_uncertain',updated_at=now() WHERE id=$1 AND state='reserved'",[row.intent_id]);
    await client.query("UPDATE sloptogether.extension_bits_transactions SET settlement_state='consumed_uncertain' WHERE intent_id=$1",[row.intent_id]);
    await commit(client);
  }catch(error){await rollback(client);throw error;}

  let urls;
  try{urls=await privateImageUrls(storage,config,row);}
  catch{
    const failed=await begin(pool);
    try{
      const current=await dispatchContext(failed,row.job_id);
      if(current&&current.dispatch_state==="submitting")await setOutcome(failed,current,"paid_unfulfilled","fal_inputs_could_not_be_signed",{reopen:true});
      await finishOutbox(failed,message);await commit(failed);return {unfulfilled:true};
    }catch(problem){await rollback(failed);throw problem;}
  }
  const active=await begin(pool);
  try{
    await active.query("SELECT twitch_channel_id FROM sloptogether.channels WHERE twitch_channel_id=$1 FOR UPDATE",[row.twitch_channel_id]);
    const current=await dispatchContext(active,row.job_id);
    if(!current||current.dispatch_state!=="submitting"||current.attempt_state!=="uncertain"||current.job_state!=="uncertain"||!dispatchEligible({...current,dispatch_state:"ready",attempt_state:"ready",job_state:"ready",intent_state:"reserved",funding_state:"reserved",settlement_state:"reserved"})){
      if(current&&current.dispatch_state==="submitting")await setOutcome(active,current,"paid_unfulfilled","dispatch_cancelled_before_provider_acceptance",{reopen:true});
      await finishOutbox(active,message);await commit(active);return {unfulfilled:true};
    }
    let provider;
    try{provider=await submitFalTurbo(config.falKey,current.dispatch_snapshot,urls.startUrl,urls.endUrl);}
    catch(error){
      const code=String(error?.code??"fal_submit_failed");
      const outcome=falSubmitOutcome(code);const definitelyRejected=outcome==="paid_unfulfilled";
      if(definitelyRejected)
        await setOutcome(active,current,"paid_unfulfilled",code,{reopen:true});
      else{
        await active.query("UPDATE sloptogether.paid_turbo_dispatches SET state='uncertain',failure_code=$2,updated_at=now() WHERE id=$1",[current.id,code]);
        await active.query("UPDATE sloptogether.paid_action_intents SET state='consumed_uncertain',state_reason=$2,updated_at=now() WHERE id=$1",[current.intent_id,code]);
        await active.query("UPDATE sloptogether.extension_bits_transactions SET settlement_state='consumed_uncertain' WHERE intent_id=$1",[current.intent_id]);
      }
      await finishOutbox(active,message);await commit(active);return {uncertain:!definitelyRejected,unfulfilled:definitelyRejected};
    }
    await active.query("UPDATE sloptogether.paid_turbo_dispatches SET state='submitted',request_id=$2,updated_at=now() WHERE id=$1 AND state='submitting'",[current.id,provider.requestId]);
    await active.query("UPDATE sloptogether.job_attempts SET state='running',provider_request_id=$2,lease_expires_at=attempt_deadline_at WHERE id=$1 AND state='uncertain'",[current.attempt_id,provider.requestId]);
    await active.query("UPDATE sloptogether.jobs SET state='running' WHERE id=$1 AND state='uncertain'",[current.job_id]);
    await active.query("UPDATE sloptogether.paid_action_intents SET state='dispatching',updated_at=now() WHERE id=$1 AND state='consumed_uncertain'",[current.intent_id]);
    await active.query("UPDATE sloptogether.paid_turbo_dispatches SET poll_generation=1 WHERE id=$1",[current.id]);
    await schedulePoll(active,{attempt_id:current.attempt_id,request_id:provider.requestId},1);
    await finishOutbox(active,message);await commit(active);return {submitted:true};
  }catch(error){await rollback(active);throw error;}
}

async function readCdnVideo(config,videoUrl,directory,maxBytes){
  const token=await falCdnReadToken(config.falKey);
  const response=await fetch(videoUrl,{redirect:"error",signal:AbortSignal.timeout(120_000),headers:{Authorization:`Bearer ${token}`}})
    .catch(()=>{throw new Error("fal_cdn_download_uncertain");});
  if(!response.ok||!response.body)throw new FalTurboError(`fal_cdn_http_${response.status}`);
  if(((response.headers.get("content-type")??"").split(";",1)[0]??"").trim().toLowerCase()!=="video/mp4")throw new FalTurboError("fal_cdn_content_type_invalid");
  const length=Number(response.headers.get("content-length"));if(Number.isFinite(length)&&length>maxBytes)throw new FalTurboError("fal_video_too_large");
  const path=join(directory,"fal-result.mp4");let size=0;
  const meter=new Transform({transform(chunk,_encoding,callback){size+=chunk.length;if(size>maxBytes)return callback(new FalTurboError("fal_video_too_large"));callback(null,chunk);}});
  await pipeline((await import("node:stream")).Readable.fromWeb(response.body),meter,createWriteStream(path,{flags:"wx"}));
  if(size<12)throw new FalTurboError("fal_video_empty");
  return {path,size};
}

export function falHasAudio(probe){
  if(!probe||!Array.isArray(probe.streams))throw new FalTurboError("fal_input_probe_invalid");
  return probe.streams.some(stream=>stream?.codec_type==="audio");
}

export function falConformArgs(inputPath,outputPath,row,hasAudio){
  const width=Number(row.output_width),height=Number(row.output_height),fpsNum=Number(row.output_fps_num),fpsDen=Number(row.output_fps_den);
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<64||height<64||width%2||height%2||width*9!==height*16
    ||!Number.isSafeInteger(fpsNum)||!Number.isSafeInteger(fpsDen)||fpsNum<1||fpsDen<1||fpsNum/fpsDen>60)throw new FalTurboError("fal_output_profile_invalid");
  const filter=`scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fpsNum}/${fpsDen}`;
  const args=["-hide_banner","-nostdin","-y","-v","error","-i",inputPath];
  if(!hasAudio)args.push("-f","lavfi","-i","anullsrc=channel_layout=stereo:sample_rate=48000");
  args.push("-map","0:v:0","-map",hasAudio?"0:a:0":"1:a:0","-vf",filter,"-af","apad","-t","17","-shortest",
    "-c:v","libx264","-preset","veryfast","-pix_fmt","yuv420p","-c:a","aac","-ar","48000","-ac","2","-movflags","+faststart",outputPath);
  return args;
}

async function conformVideo(config,inputPath,outputPath,row){
  let hasAudio;
  try{
    const probe=await execFileAsync(config.ffprobe,["-v","error","-show_entries","stream=codec_type","-of","json",inputPath],{timeout:30_000,maxBuffer:1024*1024,windowsHide:true});
    hasAudio=falHasAudio(JSON.parse(probe.stdout));
  }catch(error){if(error instanceof FalTurboError)throw error;throw new FalTurboError("fal_input_probe_failed");}
  try{
    await execFileAsync(config.ffmpeg,falConformArgs(inputPath,outputPath,row,hasAudio),
      {timeout:120_000,maxBuffer:1024*1024,windowsHide:true});
  }catch(error){if(error?.code==="ENOENT")throw error;throw new FalTurboError("fal_output_conformance_failed");}
  const facts=await stat(outputPath);if(facts.size<12||facts.size>config.maxBytes)throw new FalTurboError("fal_output_size_invalid");
}

async function enqueueValidatedResult(pool,storage,config,dispatch,resultData){
  const video=falVideoResult(resultData,config.maxBytes),directory=await mkdtemp(join(tmpdir(),"sloptogether-fal-turbo-"));let objectKey=null;
  try{
    const source=await readCdnVideo(config,video.url,directory,config.maxBytes);
    const output=join(directory,"normalized.mp4");
    const row=await pool.query(`SELECT c.output_width,c.output_height,c.output_fps_num,c.output_fps_den,c.twitch_channel_id,
        j.id AS job_id,a.id AS attempt_id,j.planning_payload->>'inputScreenId' AS input_screen_id,j.segment_revision_id,j.state AS job_state,a.fence,a.state AS attempt_state,
        a.provider_request_id,d.id AS dispatch_id,d.state AS dispatch_state,d.request_id
      FROM sloptogether.paid_turbo_dispatches d JOIN sloptogether.jobs j ON j.id=d.job_id JOIN sloptogether.job_attempts a ON a.id=d.attempt_id
      JOIN sloptogether.channels c ON c.twitch_channel_id=j.twitch_channel_id WHERE d.id=$1`,[dispatch.id]);
    const current=row.rows[0];
    if(!current||current.dispatch_state!=="running"||current.request_id!==dispatch.request_id||current.provider_request_id!==dispatch.request_id){
      await pool.query("UPDATE sloptogether.outbox SET delivered_at=now(),leased_until=NULL WHERE id=$1 AND delivered_at IS NULL AND leased_until=$2",[dispatch.message.id,dispatch.message.leaseUntil]);
      return {stale:true};
    }
    await conformVideo(config,source.path,output,current);
    const outputBytes=await import("node:fs/promises").then(fs=>fs.readFile(output));
    const outputSha256=createHash("sha256").update(outputBytes).digest();
    const assetId=randomUUID();objectKey=`private/${current.twitch_channel_id}/artifacts/${assetId}/${randomUUID()}.mp4`;
    await storage.send(new PutObjectCommand({Bucket:config.bucket,Key:objectKey,Body:createReadStream(output),ContentLength:outputBytes.length,ContentType:"video/mp4"}));
    const client=await begin(pool);
    try{
      await client.query("SELECT twitch_channel_id FROM sloptogether.channels WHERE twitch_channel_id=$1 FOR UPDATE",[current.twitch_channel_id]);
      const live=await client.query(`SELECT d.id,d.state,d.intent_id,d.job_id,d.attempt_id,d.request_id,j.segment_revision_id,j.state AS job_state,
          a.state AS attempt_state,a.fence,a.provider_request_id,a.output_asset_id,j.planning_payload->>'inputScreenId' AS input_screen_id,
          c.policy_revision,c.is_enabled,i.policy_revision AS intent_policy_revision,i.state AS intent_state,s.selected_revision_id,s.state AS segment_state,
          EXISTS(SELECT 1 FROM sloptogether.program_items pi WHERE pi.segment_id=s.id AND pi.committed_at IS NOT NULL) AS committed
        FROM sloptogether.paid_turbo_dispatches d JOIN sloptogether.jobs j ON j.id=d.job_id JOIN sloptogether.job_attempts a ON a.id=d.attempt_id
        JOIN sloptogether.paid_action_intents i ON i.id=d.intent_id
        JOIN sloptogether.channels c ON c.twitch_channel_id=j.twitch_channel_id JOIN sloptogether.segment_revisions r ON r.id=j.segment_revision_id
        JOIN sloptogether.segments s ON s.id=r.segment_id WHERE d.id=$1 FOR UPDATE OF d,j,a,c,s`,[dispatch.id]);
      const liveRow=live.rows[0];
      if(liveRow?.state==="ingested"){
        await finishOutbox(client,dispatch.message);await commit(client);
        await storage.send(new DeleteObjectCommand({Bucket:config.bucket,Key:objectKey}));objectKey=null;return {duplicate:true};
      }
      if(!liveRow||liveRow.state!=="running"||liveRow.job_state!=="running"||liveRow.attempt_state!=="running"
        ||liveRow.provider_request_id!==dispatch.request_id||liveRow.request_id!==dispatch.request_id||liveRow.selected_revision_id!==liveRow.segment_revision_id
        ||!liveRow.is_enabled||liveRow.policy_revision!==liveRow.intent_policy_revision||liveRow.intent_state!=="dispatching"||liveRow.committed){
        if(liveRow&&["running","submitted","uncertain"].includes(liveRow.state))await setOutcome(client,{...liveRow,id:liveRow.id,job_id:liveRow.job_id,attempt_id:liveRow.attempt_id,intent_id:liveRow.intent_id},"consumed_failed","fal_result_arrived_after_fence");
        await finishOutbox(client,dispatch.message);await commit(client);
        await storage.send(new DeleteObjectCommand({Bucket:config.bucket,Key:objectKey}));objectKey=null;return {stale:true};
      }
      const reservationId=randomUUID(),stagingKey=`incoming/${current.twitch_channel_id}/${current.attempt_id}/${randomUUID()}.mp4`;
      await client.query(`INSERT INTO sloptogether.assets(id,twitch_channel_id,storage_key,sha256,media_kind,content_type,byte_size,status,uploaded_by_twitch_user_id)
        VALUES($1,$2,$3,$4,'video','video/mp4',$5,'quarantine',$6)`,[assetId,current.twitch_channel_id,objectKey,outputSha256,outputBytes.length,dispatch.requested_by]);
      await client.query(`INSERT INTO sloptogether.upload_reservations(id,attempt_id,fence,staging_key,max_bytes,content_type,expires_at,uploaded_bytes,source_sha256,immutable_snapshot_key,snapshot_sha256,state,completed_at,policy_revision)
        VALUES($1,$2,$3,$4,$5,'video/mp4',now()+interval '1 day',$5,$6,$7,$6,'snapshotted',now(),$8)`,
        [reservationId,current.attempt_id,Number(liveRow.fence),stagingKey,outputBytes.length,outputSha256,objectKey,liveRow.policy_revision]);
      const accepted=await client.query(`UPDATE sloptogether.job_attempts SET state='validating',output_asset_id=$3
        WHERE id=$1 AND fence=$2 AND state='running' AND output_asset_id IS NULL RETURNING id`,[current.attempt_id,liveRow.fence,assetId]);
      if(!accepted.rowCount)throw new Error("fal_attempt_fenced_before_admission");
      await client.query("UPDATE sloptogether.jobs SET state='validating' WHERE id=$1 AND state='running'",[current.job_id]);
      await client.query("UPDATE sloptogether.paid_turbo_dispatches SET state='ingested',result_sha256=$2,updated_at=now() WHERE id=$1 AND state='running'",[dispatch.id,outputSha256]);
      await client.query(`INSERT INTO sloptogether.outbox(event_kind,aggregate_id,payload,idempotency_key)
        VALUES('media.validate',$1,$2::jsonb,$3) ON CONFLICT(idempotency_key) DO NOTHING`,[assetId,JSON.stringify({assetId,attemptId:current.attempt_id,jobId:current.job_id,
          channelId:current.twitch_channel_id,fence:Number(liveRow.fence),storageKey:objectKey,sha256:outputSha256.toString("hex"),inputScreenId:current.input_screen_id,stage:"video_base"}),`validate-artifact:${assetId}`]);
      await client.query("INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,action,target_kind,target_id,after_state) VALUES($1,$2,'fal.turbo.output_ingested','asset',$3,$4::jsonb)",
        [current.twitch_channel_id,dispatch.requested_by,assetId,JSON.stringify({jobId:current.job_id,attemptId:current.attempt_id,sha256:outputSha256.toString("hex")})]);
      await finishOutbox(client,dispatch.message);await commit(client);objectKey=null;return {ingested:true,assetId};
    }catch(error){await rollback(client);throw error;}
  }catch(error){if(objectKey)await storage.send(new DeleteObjectCommand({Bucket:config.bucket,Key:objectKey})).catch(()=>undefined);throw error;}
  finally{await rm(directory,{recursive:true,force:true}).catch(()=>undefined);}
}

async function failProviderAttempt(pool,dispatch,reason){
  const client=await begin(pool);
  try{
    await client.query("SELECT twitch_channel_id FROM sloptogether.channels WHERE twitch_channel_id=$1 FOR UPDATE",[dispatch.twitch_channel_id]);
    const current=await dispatchContext(client,dispatch.job_id);
    if(current&&["submitted","running","uncertain"].includes(current.dispatch_state))
      await setOutcome(client,current,"consumed_failed",reason,{reopen:true});
    await commit(client);
  }catch(error){await rollback(client);throw error;}
}

async function finishFailedPoll(pool,message,dispatch,reason){
  await failProviderAttempt(pool,dispatch,reason);
  const client=await begin(pool);
  try{await finishOutbox(client,message);await commit(client);}catch(error){await rollback(client);throw error;}
  return {failed:true,code:reason};
}

async function pollPaidTurbo(pool,storage,config,message){
  if(!config.falKey)throw new Error("fal_key_missing_for_known_request");
  const payload=message.payload&&typeof message.payload==="object"?message.payload:{};
  if(!UUID.test(payload.attemptId??"")||!falRequestId(payload.requestId)||!Number.isSafeInteger(payload.generation))return finishStaleMessage(pool,message);
  const found=await pool.query(`SELECT d.id,d.state AS dispatch_state,d.request_id,d.poll_generation,d.intent_id,d.job_id,d.attempt_id,
      j.twitch_channel_id,j.requested_by
    FROM sloptogether.paid_turbo_dispatches d JOIN sloptogether.jobs j ON j.id=d.job_id WHERE d.attempt_id=$1`,[payload.attemptId]);
  const dispatch=found.rows[0];
  if(!dispatch||dispatch.request_id!==payload.requestId||dispatch.poll_generation!==payload.generation||!["submitted","running"].includes(dispatch.dispatch_state))return finishStaleMessage(pool,message);
  let status;
  try{status=await falTurboStatus(config.falKey,dispatch.request_id);}
  catch(error){
    const code=String(error?.code??"");
    if((/^fal_http_4\d\d$/.test(code)&&code!=="fal_http_408"&&code!=="fal_http_429")&&message.attempts>=3)
      return finishFailedPoll(pool,message,dispatch,code);
    if(code==="fal_status_invalid"&&message.attempts>=3)return finishFailedPoll(pool,message,dispatch,code);
    throw error;
  }
  if(status.status!=="COMPLETED"){
    const client=await begin(pool);
    try{
      const bumped=await client.query("UPDATE sloptogether.paid_turbo_dispatches SET state='running',poll_generation=poll_generation+1,updated_at=now() WHERE id=$1 AND request_id=$2 AND poll_generation=$3 AND state IN ('submitted','running') RETURNING poll_generation",
        [dispatch.id,dispatch.request_id,payload.generation]);
      if(bumped.rows[0])await schedulePoll(client,{...dispatch,poll_generation:bumped.rows[0].poll_generation},bumped.rows[0].poll_generation,10);
      await finishOutbox(client,message);await commit(client);return bumped.rows[0]?{running:true}:{stale:true};
    }catch(error){await rollback(client);throw error;}
  }
  if(status.error)return finishFailedPoll(pool,message,dispatch,"fal_model_failed");
  const transitioned=await pool.query("UPDATE sloptogether.paid_turbo_dispatches SET state='running',updated_at=now() WHERE id=$1 AND request_id=$2 AND poll_generation=$3 AND state IN ('submitted','running') RETURNING id",
    [dispatch.id,dispatch.request_id,payload.generation]);
  if(!transitioned.rowCount)return finishStaleMessage(pool,message);
  dispatch.dispatch_state="running";
  try{
    const result=await falTurboResult(config.falKey,dispatch.request_id);
    const admitted={...dispatch,message};
    return await enqueueValidatedResult(pool,storage,config,admitted,result);
  }catch(error){
    const code=String(error?.code??"");
    if(falResultErrorDisposition(code,message.attempts)==="failed"){
      return finishFailedPoll(pool,message,dispatch,code||"fal_result_invalid");
    }
    throw error;
  }
}

async function reconcileFalCancel(pool,config,message){
  const payload=message.payload&&typeof message.payload==="object"?message.payload:{};
  const attemptId=UUID.test(payload.attemptId??"")?payload.attemptId:message.aggregateId;
  const found=await pool.query(`SELECT d.id,d.request_id,d.intent_id,d.job_id,d.attempt_id,d.state AS dispatch_state,
      j.twitch_channel_id,j.requested_by
    FROM sloptogether.paid_turbo_dispatches d JOIN sloptogether.jobs j ON j.id=d.job_id WHERE d.attempt_id=$1`,[attemptId]);
  const dispatch=found.rows[0];
  if(!dispatch||!dispatch.request_id||dispatch.request_id!==payload.providerRequestId){
    const client=await begin(pool);try{await finishOutbox(client,message);await commit(client);return {stale:true};}catch(error){await rollback(client);throw error;}
  }
  if(!config.falKey)throw new Error("fal_key_missing_for_cancellation");
  if(!["submitted","running","uncertain"].includes(dispatch.dispatch_state))return finishStaleMessage(pool,message);
  const result=await cancelFalTurbo(config.falKey,dispatch.request_id);
  if(result.httpStatus===200&&result.status==="OK"){
    const client=await begin(pool);
    try{
      const current=await dispatchContext(client,dispatch.job_id);
      if(current&&["submitted","running","uncertain"].includes(current.dispatch_state)){
        await client.query("UPDATE sloptogether.paid_turbo_dispatches SET state='cancelled',poll_generation=poll_generation+1,completed_at=now(),updated_at=now() WHERE id=$1 AND state IN ('submitted','running','uncertain')",[dispatch.id]);
        await setOutcome(client,current,"paid_unfulfilled","fal_request_cancelled_before_execution");
      }
      await finishOutbox(client,message);await commit(client);return {cancelled:true};
    }catch(error){await rollback(client);throw error;}
  }
  const client=await begin(pool);
  try{
    const current=await dispatchContext(client,dispatch.job_id);
    if(current&&current.request_id&&["submitted","running","uncertain"].includes(current.dispatch_state)){
      const transition=await client.query("UPDATE sloptogether.paid_turbo_dispatches SET state='running',poll_generation=poll_generation+1,updated_at=now() WHERE id=$1 AND state IN ('submitted','running','uncertain') RETURNING poll_generation",[dispatch.id]);
      const generation=transition.rows[0]?.poll_generation;
      if(!generation){await finishOutbox(client,message);await commit(client);return {stale:true};}
      await schedulePoll(client,{...dispatch,poll_generation:generation},generation,3);
    }
    await finishOutbox(client,message);await commit(client);return {cancelRequested:true};
  }catch(error){await rollback(client);throw error;}
}

export async function processPaidTurboMessage({pool,storage,config,message}){
  if(message.eventKind==="paid.turbo.dispatch")return startDispatch(pool,storage,config,message);
  if(message.eventKind==="paid.turbo.poll")return pollPaidTurbo(pool,storage,config,message);
  if(message.eventKind==="provider.reconcile_cancel")return reconcileFalCancel(pool,config,message);
  return {stale:true};
}
