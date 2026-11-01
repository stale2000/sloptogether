import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { expectedArtifactDimensions, InvalidMediaError, parseProbeJson, trustedSystemApprovalCandidate, trustedUploaderApprovalPath, validateMediaMetadata } from "./metadata.mjs";
import { finishStale } from "./outbox-state.mjs";

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 30_000;
const DECODE_TIMEOUT_MS = 90_000;

export function validateOutboxPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidMediaError("media_payload_invalid");
  const payload = value;
  const isUuid = (item) => typeof item === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item);
  if (!isUuid(payload.assetId) || !isUuid(payload.attemptId) || !isUuid(payload.jobId)
    || typeof payload.channelId !== "string" || !/^\d{1,32}$/.test(payload.channelId)
    || !Number.isSafeInteger(Number(payload.fence)) || Number(payload.fence) < 1
    || typeof payload.storageKey !== "string" || payload.storageKey.length < 1 || payload.storageKey.length > 1024
    || typeof payload.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(payload.sha256)
    || typeof payload.inputScreenId !== "string" || !isUuid(payload.inputScreenId)
    || !["video_base", "video_upscale"].includes(payload.stage)) {
    throw new InvalidMediaError("media_payload_invalid");
  }
  const expectedPrefix=`private/${payload.channelId}/artifacts/${payload.assetId}/`;
  if(!payload.storageKey.startsWith(expectedPrefix)||!payload.storageKey.endsWith(".mp4")||payload.storageKey.split("/").includes(".."))
    throw new InvalidMediaError("media_payload_invalid");
  return { ...payload, fence: Number(payload.fence), sha256: payload.sha256.toLowerCase() };
}

async function currentAttempt(pool, payload) {
  const result = await pool.query(`SELECT a.id AS asset_id,a.storage_key,a.sha256,a.status AS asset_status,a.content_type,
      a.producer_key_id,a.uploaded_by_twitch_user_id,ja.id AS attempt_id,ja.fence,ja.state AS attempt_state,ja.output_asset_id,ja.input_sha256,ja.funding_id,ja.execution_binding_id,
      ja.attempt_deadline_at > clock_timestamp() AS attempt_deadline_active,
      j.id AS job_id,j.stage,j.state AS job_state,j.segment_revision_id,j.interrupt_id,j.planning_payload,j.requested_by,
      c.output_width,c.output_height,
      c.output_fps_num,c.output_fps_den,c.owner_twitch_user_id,c.upload_approval_bypass_ids,c.role_based_upload_bypass,c.policy_revision AS channel_policy_revision,
      ur.policy_revision AS upload_policy_revision,
      EXISTS(SELECT 1 FROM sloptogether.memberships m WHERE m.twitch_user_id=a.uploaded_by_twitch_user_id AND m.twitch_channel_id=j.twitch_channel_id
        AND m.role='moderator' AND m.status='active' AND m.checked_at>now()-interval '2 minutes') AS uploader_is_recent_moderator,
      te.key_id AS execution_key_id,te.execution_role,te.policy_revision AS execution_policy_revision,te.revoked_at AS execution_revoked_at,
      k.scopes AS execution_key_scopes,k.revoked_at AS key_revoked_at,k.expires_at AS key_expires_at,
      i.effective_state AS input_state,i.expires_at AS input_expires_at
    FROM sloptogether.assets a
    JOIN sloptogether.job_attempts ja ON ja.output_asset_id=a.id
    JOIN sloptogether.jobs j ON j.id=ja.job_id
    JOIN sloptogether.channels c ON c.twitch_channel_id=j.twitch_channel_id AND c.is_enabled
    JOIN sloptogether.upload_reservations ur ON ur.attempt_id=ja.id AND ur.immutable_snapshot_key=a.storage_key AND ur.state='snapshotted'
    LEFT JOIN sloptogether.trusted_executions te ON te.id=ja.execution_binding_id AND te.twitch_channel_id=j.twitch_channel_id
    LEFT JOIN sloptogether.application_keys k ON k.key_id=te.key_id AND k.twitch_channel_id=j.twitch_channel_id
    LEFT JOIN sloptogether.input_screens i ON i.id=$7 AND i.twitch_channel_id=j.twitch_channel_id
    WHERE a.id=$1 AND ja.id=$2 AND j.id=$3 AND j.twitch_channel_id=$4 AND ja.fence=$5
      AND a.sha256=$6 AND ja.state='validating' AND j.state='validating'
    LIMIT 1`, [payload.assetId, payload.attemptId, payload.jobId, payload.channelId, payload.fence, Buffer.from(payload.sha256, "hex"), payload.inputScreenId]);
  return result.rows[0] ?? null;
}

async function downloadSnapshot(storage, bucket, key, directory, maxBytes) {
  const response = await storage.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(120_000) });
  if (!response.Body || typeof response.Body.pipe !== "function") throw new Error("r2_snapshot_body_unavailable");
  if (response.ContentLength !== undefined && response.ContentLength > maxBytes) {
    throw new InvalidMediaError("media_size_invalid", "The MP4 exceeds the validator's byte limit.");
  }
  if (response.ContentType && response.ContentType.split(";", 1)[0].trim().toLowerCase() !== "video/mp4") {
    throw new InvalidMediaError("media_content_type_invalid", "The snapshot is not stored as video/mp4.");
  }

  const file = join(directory, "snapshot.mp4");
  const hash = createHash("sha256");
  let bytes = 0;
  const digestStream = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) return callback(new InvalidMediaError("media_size_invalid", "The MP4 exceeds the validator's byte limit."));
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(response.Body, digestStream, createWriteStream(file, { flags: "wx" }));
  if (bytes < 12) throw new InvalidMediaError("media_container_invalid", "The snapshot is empty or truncated.");
  const sha256 = hash.digest("hex");
  return { file, bytes, sha256 };
}

async function probeFile(ffprobe, file) {
  try {
    const result = await execFileAsync(ffprobe, [
      "-v", "error",
      "-count_frames","-show_entries", "format=format_name,duration:stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,nb_frames,nb_read_frames",
      "-of", "json", file,
    ], { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true });
    return parseProbeJson(result.stdout);
  } catch (error) {
    if (error instanceof InvalidMediaError) throw error;
    if (error?.code === "ENOENT" || error?.code === "ETIMEDOUT" || error?.killed) throw error;
    throw new InvalidMediaError("media_probe_failed", "ffprobe could not decode the uploaded MP4.");
  }
}

async function decodeMedia(ffmpeg,file){
  try{
    await execFileAsync(ffmpeg,["-v","error","-xerror","-nostdin","-i",file,"-map","0:v:0","-map","0:a:0","-f","null","-"],
      {timeout:DECODE_TIMEOUT_MS,maxBuffer:1024*1024,windowsHide:true});
  }catch(error){
    if(error?.code==="ENOENT"||error?.code==="ETIMEDOUT"||error?.killed)throw error;
    throw new InvalidMediaError("media_decode_failed","The complete audio/video streams could not be decoded.");
  }
}

function sameDigest(left, right) {
  return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.length === right.length && left.equals(right);
}



async function recordFailure(pool, message, payload, code) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const jobMeta=payload.stage==="video_base"?await client.query("SELECT interrupt_id FROM sloptogether.jobs WHERE id=$1 AND twitch_channel_id=$2",[payload.jobId,payload.channelId]):null;
    const interruptId=jobMeta?.rows[0]?.interrupt_id??null;
    if(interruptId){
      await client.query("SELECT twitch_channel_id FROM sloptogether.channels WHERE twitch_channel_id=$1 FOR SHARE",[payload.channelId]);
      await client.query("SELECT id FROM sloptogether.interrupt_requests WHERE id=$1 AND broadcaster_twitch_id=$2 FOR UPDATE",[interruptId,payload.channelId]);
    }else if(payload.stage==="video_base")await client.query(`SELECT s.id FROM sloptogether.job_attempts ja
      JOIN sloptogether.jobs j ON j.id=ja.job_id JOIN sloptogether.segment_revisions sr ON sr.id=j.segment_revision_id
      JOIN sloptogether.segments s ON s.id=sr.segment_id WHERE ja.id=$1 AND j.id=$2 AND ja.fence=$3 FOR UPDATE OF s`,[payload.attemptId,payload.jobId,payload.fence]);
    const outbox = await client.query(`SELECT id FROM sloptogether.outbox WHERE id=$1 AND delivered_at IS NULL AND leased_until=$2 FOR UPDATE`, [message.id, message.leaseUntil]);
    if (!outbox.rowCount) { await client.query("ROLLBACK"); return false; }
    const attempt = await client.query(`SELECT ja.id,ja.funding_id,f.paid_action_intent_id,j.segment_revision_id,j.interrupt_id,j.stage,j.twitch_channel_id,j.requested_by,
        j.state AS job_state,a.status AS asset_status
      FROM sloptogether.job_attempts ja JOIN sloptogether.jobs j ON j.id=ja.job_id
      LEFT JOIN sloptogether.funding_authorizations f ON f.id=ja.funding_id
      JOIN sloptogether.assets a ON a.id=ja.output_asset_id
      WHERE ja.id=$1 AND j.id=$2 AND a.id=$3 AND j.twitch_channel_id=$4 AND ja.fence=$5
        AND ja.state='validating' AND j.state='validating' AND a.status='quarantine'
      FOR UPDATE OF ja,j,a`, [payload.attemptId, payload.jobId, payload.assetId, payload.channelId, payload.fence]);
    const row = attempt.rows[0];
    if (row) {
      await client.query("UPDATE sloptogether.assets SET status='rejected' WHERE id=$1 AND status='quarantine'", [payload.assetId]);
      await client.query("UPDATE sloptogether.job_attempts SET state='rejected',finished_at=now(),error_code=$2 WHERE id=$1 AND fence=$3", [payload.attemptId, code.slice(0, 80), payload.fence]);
      await client.query("UPDATE sloptogether.jobs SET state='failed',completed_at=now() WHERE id=$1 AND state='validating'", [payload.jobId]);
      if(row.interrupt_id&&row.stage==="video_base"){
        await client.query("UPDATE sloptogether.interrupt_requests SET program_state='failed' WHERE id=$1 AND program_state NOT IN ('played','cancelled','expired','skipped')",[row.interrupt_id]);
        await client.query("UPDATE sloptogether.subscription_events SET state='failed' WHERE interrupt_id=$1 AND state NOT IN ('played','cancelled','expired')",[row.interrupt_id]);
      }else if (row.segment_revision_id && row.stage === "video_base") {
        // A bad result consumes this exact attempt. Close the old vote and
        // require a new proposal/funding decision; do not make the same paid
        // selection eligible for an unfunded automatic retry.
        await client.query(`UPDATE sloptogether.segment_revisions r SET state='rejected' WHERE r.id=$1 AND r.state NOT IN ('played','superseded')
          AND EXISTS(SELECT 1 FROM sloptogether.segments s WHERE s.id=r.segment_id AND s.selected_revision_id=r.id AND s.state NOT IN ('played','retired')
            AND NOT EXISTS(SELECT 1 FROM sloptogether.program_items pi WHERE pi.segment_id=s.id AND pi.committed_at IS NOT NULL))`, [row.segment_revision_id]);
        await client.query(`UPDATE sloptogether.proposals p SET state='rejected',reviewed_at=now(),review_reason=$2 WHERE p.segment_revision_id=$1 AND p.state='selected'
          AND EXISTS(SELECT 1 FROM sloptogether.segments s WHERE s.selected_revision_id=p.segment_revision_id AND s.state NOT IN ('played','retired')
            AND NOT EXISTS(SELECT 1 FROM sloptogether.program_items pi WHERE pi.segment_id=s.id AND pi.committed_at IS NOT NULL))`, [row.segment_revision_id,code.slice(0,500)]);
        await client.query(`UPDATE sloptogether.elections e SET state='closed',winner_proposal_id=NULL,closed_by=NULL
          FROM sloptogether.segments s WHERE e.segment_id=s.id AND s.selected_revision_id=$1 AND e.state='selected'
            AND s.state NOT IN ('played','retired')
            AND NOT EXISTS(SELECT 1 FROM sloptogether.program_items pi WHERE pi.segment_id=s.id AND pi.committed_at IS NOT NULL)`, [row.segment_revision_id]);
        await client.query(`UPDATE sloptogether.segments s SET state='open',selected_revision_id=NULL,protected_at=NULL
          WHERE s.selected_revision_id=$1 AND s.state NOT IN ('played','retired')
            AND NOT EXISTS(SELECT 1 FROM sloptogether.program_items pi WHERE pi.segment_id=s.id AND pi.committed_at IS NOT NULL)`, [row.segment_revision_id]);
      }
      if (row.funding_id) await client.query(`UPDATE sloptogether.funding_authorizations SET state='consumed_failed',consumed_at=coalesce(consumed_at,now()),settled_at=now()
        WHERE id=$1 AND state IN ('reserved','consumed_uncertain')`, [row.funding_id]);
      if(row.paid_action_intent_id){
        await client.query("UPDATE sloptogether.paid_action_intents SET state='consumed_failed',state_reason=$2,updated_at=now() WHERE id=$1",[row.paid_action_intent_id,code.slice(0,500)]);
        await client.query("UPDATE sloptogether.extension_bits_transactions SET settlement_state='consumed_failed',processed_at=now() WHERE intent_id=$1",[row.paid_action_intent_id]);
        await client.query("UPDATE sloptogether.paid_turbo_dispatches SET state='failed',poll_generation=poll_generation+1,failure_code=$2,completed_at=now(),updated_at=now() WHERE attempt_id=$1 AND state IN ('submitted','running','ingested')",[payload.attemptId,code.slice(0,80)]);
      }
      await client.query(`INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,action,target_kind,target_id,after_state)
        VALUES($1,$2,'artifact.validation_rejected','asset',$3,$4::jsonb)`, [row.twitch_channel_id, row.requested_by, payload.assetId, JSON.stringify({ attemptId: payload.attemptId, code })]);
    }
    await client.query("UPDATE sloptogether.outbox SET delivered_at=now(),leased_until=NULL WHERE id=$1 AND delivered_at IS NULL AND leased_until=$2", [message.id, message.leaseUntil]);
    await client.query("COMMIT");
    return Boolean(row);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function commitValidation(pool, message, payload, metadata, trustedBinding) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const channelState=await client.query("SELECT policy_revision FROM sloptogether.channels WHERE twitch_channel_id=$1 AND is_enabled FOR UPDATE",[payload.channelId]);
    if(!channelState.rowCount){await client.query("ROLLBACK");await finishStale(pool,message);return false}
    let lockedSegment=null;
    if(["video_base","video_upscale"].includes(payload.stage)){
      const segment=await client.query(`SELECT s.id,s.selected_revision_id,s.state,sr.id AS revision_id,j.interrupt_id FROM sloptogether.job_attempts ja
        JOIN sloptogether.jobs j ON j.id=ja.job_id JOIN sloptogether.segment_revisions sr ON sr.id=j.segment_revision_id
        JOIN sloptogether.segments s ON s.id=sr.segment_id WHERE ja.id=$1 AND ja.fence=$2 AND j.stage=$3 FOR UPDATE OF s`,[payload.attemptId,payload.fence,payload.stage]);
      lockedSegment=segment.rows[0]??null;
      if(payload.stage==="video_base"&&lockedSegment?.interrupt_id){
        const interrupt=await client.query(`SELECT ir.program_state,ir.expires_at,(c.subscriber_interrupt_policy->>'enabled')::boolean AS enabled
          FROM sloptogether.interrupt_requests ir JOIN sloptogether.channels c ON c.twitch_channel_id=ir.broadcaster_twitch_id
          WHERE ir.id=$1 AND ir.broadcaster_twitch_id=$2 FOR UPDATE OF ir`,[lockedSegment.interrupt_id,payload.channelId]);
        const state=interrupt.rows[0];
        if(!state||state.program_state!=="rendering"||!state.enabled||state.expires_at.getTime()<=Date.now()){
          await client.query("ROLLBACK");return recordFailure(pool,message,payload,"subscriber_interrupt_no_longer_eligible");
        }
      }else if(payload.stage==="video_base"&&(!lockedSegment||lockedSegment.selected_revision_id!==lockedSegment.revision_id||["played","retired"].includes(lockedSegment.state))){
        await client.query("ROLLBACK");
        return recordFailure(pool,message,payload,"trusted_artifact_revision_stale");
      }
    }
    const outbox = await client.query(`SELECT id FROM sloptogether.outbox WHERE id=$1 AND delivered_at IS NULL AND leased_until=$2 FOR UPDATE`, [message.id, message.leaseUntil]);
    if (!outbox.rowCount) { await client.query("ROLLBACK"); return false; }
    let systemApproved=false;
    if(trustedBinding?.kind==="trusted_execution"&&trustedBinding?.executionBindingId&&trustedBinding?.keyId){
      const authority=await client.query(`SELECT te.execution_role,te.policy_revision,c.policy_revision AS channel_policy_revision,k.scopes,te.revoked_at,k.revoked_at AS key_revoked_at,k.expires_at
        FROM sloptogether.trusted_executions te JOIN sloptogether.application_keys k ON k.key_id=te.key_id
        JOIN sloptogether.channels c ON c.twitch_channel_id=te.twitch_channel_id
        WHERE te.id=$1 AND te.key_id=$2 AND te.twitch_channel_id=$3 AND c.is_enabled
        FOR SHARE OF c,te,k`,[trustedBinding.executionBindingId,trustedBinding.keyId,payload.channelId]);
      const row=authority.rows[0];
      systemApproved=Boolean(row&&row.revoked_at===null&&row.key_revoked_at===null&&(!row.expires_at||row.expires_at.getTime()>Date.now())
        &&row.policy_revision===trustedBinding.channelPolicyRevision&&row.policy_revision===row.channel_policy_revision&&row.scopes.includes("artifact:system_approve")
        &&row.execution_role===(payload.stage==="video_base"?"generation":"upscale"));
    }
    const attempt = await client.query(`SELECT ja.id,ja.funding_id,ja.attempt_deadline_at > clock_timestamp() AS attempt_deadline_active,
        f.paid_action_intent_id,j.segment_revision_id,j.interrupt_id,j.twitch_channel_id,j.requested_by,
        (SELECT se.twitch_actor_id FROM sloptogether.interrupt_requests ir JOIN sloptogether.subscription_events se ON se.id=ir.trigger_event_id WHERE ir.id=j.interrupt_id) AS interrupt_actor_id,
        a.status AS asset_status,a.storage_key,a.sha256,a.byte_size,a.producer_key_id,a.uploaded_by_twitch_user_id,
        c.owner_twitch_user_id,c.upload_approval_bypass_ids,c.role_based_upload_bypass,c.policy_revision AS channel_policy_revision,
        ur.policy_revision AS upload_policy_revision,
        EXISTS(SELECT 1 FROM sloptogether.memberships m WHERE m.twitch_user_id=a.uploaded_by_twitch_user_id AND m.twitch_channel_id=j.twitch_channel_id
          AND m.role='moderator' AND m.status='active' AND m.checked_at>now()-interval '2 minutes') AS uploader_is_recent_moderator,
        i.effective_state AS input_state,i.expires_at AS input_expires_at
      FROM sloptogether.job_attempts ja JOIN sloptogether.jobs j ON j.id=ja.job_id
      JOIN sloptogether.assets a ON a.id=ja.output_asset_id
      LEFT JOIN sloptogether.funding_authorizations f ON f.id=ja.funding_id
      JOIN sloptogether.channels c ON c.twitch_channel_id=j.twitch_channel_id AND c.is_enabled
      JOIN sloptogether.upload_reservations ur ON ur.attempt_id=ja.id AND ur.immutable_snapshot_key=a.storage_key AND ur.state='snapshotted'
      JOIN sloptogether.input_screens i ON i.id=$7 AND i.twitch_channel_id=j.twitch_channel_id
      WHERE ja.id=$1 AND j.id=$2 AND a.id=$3 AND j.twitch_channel_id=$4 AND ja.fence=$5
        AND ja.state='validating' AND j.state='validating' AND a.status='quarantine' AND a.sha256=$6
      FOR UPDATE OF ja,j,a FOR SHARE OF c,i`, [payload.attemptId, payload.jobId, payload.assetId, payload.channelId, payload.fence, Buffer.from(payload.sha256, "hex"), payload.inputScreenId]);
    const row = attempt.rows[0];
    if (!row || row.storage_key !== payload.storageKey || !sameDigest(row.sha256, Buffer.from(payload.sha256, "hex"))) {
      await client.query("UPDATE sloptogether.outbox SET delivered_at=now(),leased_until=NULL WHERE id=$1 AND delivered_at IS NULL AND leased_until=$2", [message.id, message.leaseUntil]);
      await client.query("COMMIT");
      return false;
    }
    if(row.attempt_deadline_active!==true){
      await client.query("ROLLBACK");
      return await recordFailure(pool,message,payload,"worker_attempt_expired")?"expired":false;
    }
    if (row.input_state !== "clear") {
      await client.query("ROLLBACK");
      return recordFailure(pool, message, payload, "media_input_screen_not_clear");
    }
    if(systemApproved&&row.producer_key_id!==trustedBinding.keyId)systemApproved=false;
    let uploaderApproved=false;
    if(trustedBinding?.kind==="trusted_uploader"){
      const uploaderPath=trustedUploaderApprovalPath(row);
      uploaderApproved=Boolean(uploaderPath&&row.upload_policy_revision===row.channel_policy_revision&&row.upload_policy_revision===trustedBinding.channelPolicyRevision);
    }
    const autoApproved=systemApproved||uploaderApproved;
    const approvalPath=systemApproved?"trusted_execution_policy":uploaderApproved?"trusted_uploader_policy":null;
    const boundExecutionId=systemApproved?trustedBinding.executionBindingId:null;
    const currentPolicyRevision=systemApproved?trustedBinding.channelPolicyRevision:row.channel_policy_revision;
    const banned=await client.query(`SELECT 1 FROM sloptogether.bans WHERE twitch_user_id=ANY($1::text[]) AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at>now()) AND (scope='global' OR twitch_channel_id=$2) LIMIT 1`,[[row.uploaded_by_twitch_user_id,row.requested_by,row.interrupt_actor_id].filter(Boolean),payload.channelId]);
    if(banned.rowCount){await client.query("ROLLBACK");return recordFailure(pool,message,payload,"channel_ban_active")}
    const updated = await client.query(`UPDATE sloptogether.assets SET status=$2,width=$3,height=$4,fps_num=$5,fps_den=$6,
      frame_count=$7,duration_seconds=$8,validated_at=now() WHERE id=$1 AND status='quarantine' AND sha256=$9
        AND EXISTS(SELECT 1 FROM sloptogether.job_attempts ja WHERE ja.id=$10 AND ja.fence=$11 AND ja.state='validating' AND ja.attempt_deadline_at>clock_timestamp()) RETURNING id`,
    [payload.assetId,autoApproved?"approved":"validated",metadata.width, metadata.height, metadata.fpsNum, metadata.fpsDen, metadata.frameCount, metadata.durationSeconds, Buffer.from(payload.sha256, "hex"),payload.attemptId,payload.fence]);
    if (!updated.rowCount) {
      const deadline=await client.query("SELECT attempt_deadline_at>clock_timestamp() AS active FROM sloptogether.job_attempts WHERE id=$1 AND fence=$2 AND state='validating'",[payload.attemptId,payload.fence]);
      await client.query("ROLLBACK");
      if(deadline.rows[0]?.active!==true)return await recordFailure(pool,message,payload,"worker_attempt_expired")?"expired":false;
      return false;
    }
    if(autoApproved){
      await client.query(`INSERT INTO sloptogether.artifact_approvals(asset_id,sha256,input_screen_id,approval_path,execution_binding_id,uploader_twitch_user_id,trust_policy_revision,decision,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,'approved',$8)`,[payload.assetId,Buffer.from(payload.sha256,"hex"),payload.inputScreenId,approvalPath,boundExecutionId,row.uploaded_by_twitch_user_id,currentPolicyRevision,approvalPath==="trusted_execution_policy"?"Verified trusted worker policy":"Verified channel upload-bypass policy"]);
      await client.query("UPDATE sloptogether.job_attempts SET state='succeeded',finished_at=now() WHERE id=$1 AND state='validating'",[payload.attemptId]);
      await client.query("UPDATE sloptogether.jobs SET state='succeeded',completed_at=now() WHERE id=$1 AND state='validating'",[payload.jobId]);
      if(row.funding_id)await client.query("UPDATE sloptogether.funding_authorizations SET state='consumed_succeeded',consumed_at=coalesce(consumed_at,now()),settled_at=now() WHERE id=$1 AND state IN ('reserved','consumed_uncertain')",[row.funding_id]);
      if(row.paid_action_intent_id){
        await client.query("UPDATE sloptogether.paid_action_intents SET state='consumed_succeeded',state_reason='trusted_artifact_approved',updated_at=now() WHERE id=$1",[row.paid_action_intent_id]);
        await client.query("UPDATE sloptogether.extension_bits_transactions SET settlement_state='consumed_succeeded',processed_at=now() WHERE intent_id=$1",[row.paid_action_intent_id]);
      }
      if(row.segment_revision_id&&payload.stage==="video_base"&&!row.interrupt_id){
        await client.query("UPDATE sloptogether.segment_revisions SET state='ready' WHERE id=$1 AND state IN ('selected','locked','rendering','ready')",[row.segment_revision_id]);
        await client.query("UPDATE sloptogether.segments SET state='ready' WHERE id=$1 AND selected_revision_id=$2 AND state NOT IN ('played','retired')",[lockedSegment.id,row.segment_revision_id]);
      }
      if(payload.stage==="video_base"){
        await client.query("SELECT sloptogether.schedule_preair_upscale($1)",[payload.assetId]);
        await client.query(`INSERT INTO sloptogether.outbox(event_kind,aggregate_id,payload,idempotency_key)
          VALUES('media.publish_requested',$1,$2::jsonb,$3) ON CONFLICT(idempotency_key) DO NOTHING`,[payload.assetId,JSON.stringify({assetId:payload.assetId,approvalPath}),"publish:"+payload.assetId+":"+payload.sha256]);
      }
    }
    await client.query(`INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,action,target_kind,target_id,after_state)
      VALUES($1,$2,$3,'asset',$4,$5::jsonb)`, [row.twitch_channel_id, row.requested_by,autoApproved?"artifact.trusted_approved":"artifact.validated",payload.assetId, JSON.stringify({ attemptId: payload.attemptId, sha256: payload.sha256, approvalPath, ...metadata })]);
    await client.query("UPDATE sloptogether.outbox SET delivered_at=now(),leased_until=NULL WHERE id=$1 AND delivered_at IS NULL AND leased_until=$2", [message.id, message.leaseUntil]);
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function validateOne(pool, storage, config, message) {
  let payload;
  try {
    payload = validateOutboxPayload(message.payload);
  } catch (error) {
    await finishStale(pool, message);
    return { status: "discarded", code: error.code || "media_payload_invalid" };
  }

  const current = await currentAttempt(pool, payload);
  if (!current || current.asset_status !== "quarantine" || current.storage_key !== payload.storageKey
    || !sameDigest(current.sha256, Buffer.from(payload.sha256, "hex")) || current.stage !== payload.stage
    || current.output_asset_id !== payload.assetId || Number(current.fence) !== payload.fence) {
    await finishStale(pool, message);
    return { status: "stale" };
  }
  // Outbox delivery can lag; the attempt deadline remains authoritative until commit.
  if(current.attempt_deadline_active!==true){
    const rejected=await recordFailure(pool,message,payload,"worker_attempt_expired");
    return rejected?{status:"rejected",code:"worker_attempt_expired"}:{status:"stale"};
  }
  if (current.input_state !== "clear") {
    await recordFailure(pool, message, payload, "media_input_screen_not_clear");
    return { status: "rejected", code: "media_input_screen_not_clear" };
  }

  const directory = await mkdtemp(join(tmpdir(), "sloptogether-media-"));
  try {
    const snapshot = await downloadSnapshot(storage, config.bucket, current.storage_key, directory, config.maxBytes);
    if (snapshot.sha256 !== payload.sha256 || !sameDigest(current.sha256, Buffer.from(snapshot.sha256, "hex"))) {
      throw new InvalidMediaError("media_digest_mismatch", "The uploaded bytes do not match the admitted artifact digest.");
    }
    const probe = await probeFile(config.ffprobe, snapshot.file);
    const metadata = validateMediaMetadata(probe, {
      ...expectedArtifactDimensions(current),
      fpsNum: Number(current.output_fps_num),
      fpsDen: Number(current.output_fps_den),
    }, snapshot.bytes, {
      maxBytes: config.maxBytes,
      minDurationSeconds: current.interrupt_id ? 9.5 : config.minDuration,
      maxDurationSeconds: current.interrupt_id ? 10.5 : config.maxDuration,
    });
    await decodeMedia(config.ffmpeg,snapshot.file);
    const trustedBinding=trustedSystemApprovalCandidate(current)
      ?{kind:"trusted_execution",executionBindingId:current.execution_binding_id,keyId:current.execution_key_id,channelPolicyRevision:current.channel_policy_revision,segmentRevisionId:current.segment_revision_id}
      :trustedUploaderApprovalPath(current)
        ?{kind:"trusted_uploader",approvalPath:trustedUploaderApprovalPath(current),channelPolicyRevision:current.channel_policy_revision,segmentRevisionId:current.segment_revision_id}
        :null;
    const accepted = await commitValidation(pool, message, payload, metadata, trustedBinding);
    if(accepted==="expired")return {status:"rejected",code:"worker_attempt_expired"};
    return { status: accepted ? "validated" : "stale" };
  } catch (error) {
    if (error instanceof InvalidMediaError) {
      await recordFailure(pool, message, payload, error.code);
      return { status: "rejected", code: error.code };
    }
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
