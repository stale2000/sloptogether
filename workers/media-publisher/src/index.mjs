import { createHash, createHmac } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import pg from "pg";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { InvalidMediaError, parseProbeJson, trustedSystemApprovalCandidate, trustedUploaderApprovalPath, validateMediaMetadata } from "./metadata.mjs";
import { moderationKeyFrom } from "./endpoint.mjs";
import { processPublishRequested } from "./publish.mjs";
import { processPaidTurboMessage } from "./paid-turbo.mjs";
import { processBitsReconcileMessage } from "./bits-reconcile.mjs";
import { processComfyFrameExpiry } from "./comfy-frame-expiry.mjs";

const { Pool } = pg;
const execFileAsync = promisify(execFile);
const LEASE_MINUTES = 5;
const PROBE_TIMEOUT_MS = 30_000;
const DECODE_TIMEOUT_MS = 90_000;
const MAX_OUTBOX_BYTES = 128 * 1024 * 1024;

export function requiredEnvironment(env) {
  const mediaGatewayUrl = env.SLOPTOGETHER_MEDIA_GATEWAY_URL || null;
  const required = ["DATABASE_URL", "R2_BUCKET_NAME", ...(mediaGatewayUrl ? ["SLOPTOGETHER_UPLOAD_TICKET_KEY"] : ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"])];
  for (const name of required) if (!env[name]) throw new Error(`${name}_required`);
  if(mediaGatewayUrl){
    let endpoint;try{endpoint=new URL(mediaGatewayUrl);}catch{throw new Error("SLOPTOGETHER_MEDIA_GATEWAY_URL_invalid");}
    if(endpoint.protocol!=="https:"||endpoint.hostname!=="uploads.clips.gg"||endpoint.pathname!=="/worker-media"||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)
      throw new Error("SLOPTOGETHER_MEDIA_GATEWAY_URL_invalid");
  }
  return {
    databaseUrl: env.DATABASE_URL,
    publicAppUrl: env.PUBLIC_APP_URL || null,
    accountId: env.R2_ACCOUNT_ID || null,
    localS3Endpoint: env.SLOPTOGETHER_LOCAL_S3_ENDPOINT || null,
    accessKeyId: env.R2_ACCESS_KEY_ID || null,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY || null,
    bucket: env.R2_BUCKET_NAME,
    mediaGatewayUrl,
    uploadTicketKey: env.SLOPTOGETHER_UPLOAD_TICKET_KEY || null,
    ffmpeg: env.FFMPEG_PATH || "ffmpeg",
    ffprobe: env.FFPROBE_PATH || "ffprobe",
    pollMs: positiveInteger(env.MEDIA_VALIDATOR_POLL_MS, 1500, 100, 60_000),
    maxBytes: positiveInteger(env.MEDIA_VALIDATOR_MAX_BYTES, MAX_OUTBOX_BYTES, 1, MAX_OUTBOX_BYTES),
    minDuration: positiveNumber(env.MEDIA_VALIDATOR_MIN_SECONDS, 13, 1, 60),
    maxDuration: positiveNumber(env.MEDIA_VALIDATOR_MAX_SECONDS, 17, 1, 60),
    openAiKey: moderationKeyFrom(env),
    falKey: env.FAL_KEY || null,
    bitsReconcileUrl: env.SLOPTOGETHER_BITS_RECONCILE_URL || null,
    bitsReconcileSecret: env.SLOPTOGETHER_BITS_RECONCILE_SECRET || null,
    paidBitsReady: env.SLOPTOGETHER_BITS_TURBO_ENABLED === "true" && env.SLOPTOGETHER_BITS_POLICY_APPROVED === "true"
      && env.SLOPTOGETHER_BITS_EVENTSUB_READY === "true" && env.SLOPTOGETHER_BITS_DISPATCH_READY === "true",
  };
}

function positiveInteger(raw, fallback, minimum, maximum) {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function positiveNumber(raw, fallback, minimum, maximum) {
  const value = Number(raw);
  return Number.isFinite(value) && value >= minimum && value <= maximum ? value : fallback;
}

export function assertDatabaseTarget(databaseUrl, env = process.env) {
  const url = new URL(databaseUrl);
  if (!url.protocol.startsWith("postgres")) throw new Error("DATABASE_URL_must_use_PostgreSQL");
  const clipsDatabaseUsers={
    "db.lkyaaokrpbqucjrnhrps.supabase.co":"sloptogether_app",
    "aws-1-us-east-2.pooler.supabase.com":"sloptogether_app.lkyaaokrpbqucjrnhrps",
  };
  const expectedUser=clipsDatabaseUsers[url.hostname.toLowerCase()];
  if (expectedUser && (env.SLOPTOGETHER_USE_CLIPSGG_DATABASE !== "true" || url.username !== expectedUser)) {
    throw new Error("The Clips.gg database requires the explicit opt-in and schema-scoped sloptogether_app login.");
  }
  return url;
}

export function databasePoolOptions(databaseUrl,env=process.env){
  const url=assertDatabaseTarget(databaseUrl,env);
  const clipsDatabaseUsers={
    "db.lkyaaokrpbqucjrnhrps.supabase.co":"sloptogether_app",
    "aws-1-us-east-2.pooler.supabase.com":"sloptogether_app.lkyaaokrpbqucjrnhrps",
  };
  const sharedClipsDb=Object.hasOwn(clipsDatabaseUsers,url.hostname.toLowerCase());
  const ca=env.SLOPTOGETHER_DATABASE_SSL_CA?.replace(/\\n/g,"\n").trim();
  if(sharedClipsDb&&!ca)throw new Error("SLOPTOGETHER_DATABASE_SSL_CA_required_for_shared_ClipsGG_database");
  if(ca&&!ca.includes("-----BEGIN CERTIFICATE-----"))throw new Error("SLOPTOGETHER_DATABASE_SSL_CA_invalid");
  const connectionUrl=new URL(databaseUrl);
  if(ca)connectionUrl.searchParams.delete("sslmode");
  return {connectionString:ca?connectionUrl.toString():databaseUrl,...(ca?{ssl:{ca,rejectUnauthorized:true}}:{})};
}

function makePool(databaseUrl) {
  return new Pool({
    ...databasePoolOptions(databaseUrl),
    max: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    application_name: "sloptogether-media-validator",
  });
}

function makeStorageClient(config) {
  if(config.mediaGatewayUrl)return createMediaGatewayStorage(config);
  return new S3Client({
    region: config.localS3Endpoint ? "us-east-1" : "auto",
    endpoint: config.localS3Endpoint || `https://${config.accountId}.r2.cloudflarestorage.com`,
    forcePathStyle: Boolean(config.localS3Endpoint),
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    maxAttempts: 3,
  });
}

function mediaChannelId(key){
  const match=/^(?:private|incoming)\/([0-9]{1,32})\//.exec(key);
  if(!match||key.length>1024||key.split("/").includes("..")||key.includes("\\")||/[\0-\x1f\x7f]/.test(key))throw new Error("media_gateway_key_invalid");
  return match[1];
}

export function createMediaGatewayStorage(config){
  const secret=config.uploadTicketKey;
  if(typeof secret!=="string"||secret.length<32||!config.mediaGatewayUrl)throw new Error("media_gateway_not_configured");
  async function send(command,options={}){
    if(command.input?.Bucket!==config.bucket)throw new Error("media_gateway_bucket_invalid");
    const key=command.input?.Key;
    if(typeof key!=="string")throw new Error("media_gateway_key_invalid");
    const channelId=mediaChannelId(key);
    const put=command instanceof PutObjectCommand;
    const get=command instanceof GetObjectCommand;
    const del=command instanceof DeleteObjectCommand;
    if(!put&&!get&&!del)throw new Error("media_gateway_operation_unsupported");
    const body=put?command.input.Body:null;
    let byteSize=128*1024*1024;
    let contentType="application/octet-stream";
    if(put){
      if(!Buffer.isBuffer(body)&&!(body instanceof Uint8Array))throw new Error("media_gateway_body_unsupported");
      byteSize=body.byteLength;
      contentType=String(command.input.ContentType??"").split(";",1)[0].trim().toLowerCase();
      if(!["image/jpeg","image/png","video/mp4","video/mp2t"].includes(contentType))throw new Error("media_gateway_content_type_invalid");
      if(!Number.isSafeInteger(byteSize)||byteSize<1||byteSize>128*1024*1024)throw new Error("media_gateway_size_invalid");
    }
    const operation=put?"put":get?"get":"delete";
    if(del){byteSize=0;}
    const payload={version:1,purpose:"media_publisher",operation,channelId,storageKey:key,contentType,byteSize,expiresAt:new Date(Date.now()+60_000).toISOString()};
    const encoded=Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature=createHmac("sha256",secret).update(encoded).digest("base64url");
    const headers={"X-Worker-Artifact-Ticket":`${encoded}.${signature}`,"User-Agent":"SlopTogether-Worker/0.1"};
    if(put)headers["Content-Type"]=contentType;
    const init={method:put?"PUT":get?"GET":"DELETE",headers,...(put?{body}:{}),...(options.abortSignal?{signal:options.abortSignal}:{})};
    const response=await fetch(config.mediaGatewayUrl,init);
    if(!response.ok){
      const data=await response.json().catch(()=>({}));
      const error=new Error(`media_gateway_http_${response.status}`);
      error.code=typeof data.error==="string"?data.error:`media_gateway_http_${response.status}`;
      throw error;
    }
    if(get){
      const length=Number(response.headers.get("content-length"));
      if(!Number.isSafeInteger(length)||length<1||length>byteSize||!response.body)throw new Error("media_gateway_response_invalid");
      return {Body:Readable.fromWeb(response.body),ContentLength:length,ContentType:response.headers.get("content-type")??undefined};
    }
    const result=await response.json().catch(()=>({}));
    return {ETag:typeof result.etag==="string"?result.etag:undefined};
  }
  return {send,destroy:async()=>{}};
}

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

async function claimOutbox(pool,eventKinds=["media.validate","media.publish_requested","storage.delete_staging","storage.cleanup_snapshot_candidate","paid.bits.reconcile_receipt","paid.turbo.dispatch","paid.turbo.poll","provider.reconcile_cancel","comfy.frame_generation.expire"]) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = await client.query(`SELECT id,event_kind,aggregate_id,payload,attempts FROM sloptogether.outbox
      WHERE event_kind=ANY($1::text[]) AND delivered_at IS NULL AND available_at<=now()
        AND (leased_until IS NULL OR leased_until<=now())
      ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,[eventKinds]);
    const message = row.rows[0];
    if (!message) { await client.query("COMMIT"); return null; }
    const claimed = await client.query(`UPDATE sloptogether.outbox SET leased_until=date_trunc('milliseconds',now()+($2::int*interval '1 minute')),attempts=attempts+1
      WHERE id=$1 AND delivered_at IS NULL RETURNING leased_until,attempts`, [message.id, LEASE_MINUTES]);
    await client.query("COMMIT");
    const state = claimed.rows[0];
    if (!state) return null;
    return { id: message.id,eventKind:message.event_kind,aggregateId:message.aggregate_id,payload: message.payload, attempts: Number(state.attempts), leaseUntil: state.leased_until };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function currentAttempt(pool, payload) {
  const result = await pool.query(`SELECT a.id AS asset_id,a.storage_key,a.sha256,a.status AS asset_status,a.content_type,
      a.producer_key_id,a.uploaded_by_twitch_user_id,ja.id AS attempt_id,ja.fence,ja.state AS attempt_state,ja.output_asset_id,ja.input_sha256,ja.funding_id,ja.execution_binding_id,
      j.id AS job_id,j.stage,j.state AS job_state,j.segment_revision_id,j.planning_payload,j.requested_by,
      coalesce(nullif(j.planning_payload->>'outputWidth','')::int,c.output_width) AS output_width,
      coalesce(nullif(j.planning_payload->>'outputHeight','')::int,c.output_height) AS output_height,
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

async function finishStale(pool, message) {
  await pool.query(`UPDATE sloptogether.outbox SET delivered_at=now(),leased_until=NULL
    WHERE id=$1 AND delivered_at IS NULL AND leased_until=$2`, [message.id, message.leaseUntil]);
}

export function validStagingKey(key,channelId){
  return typeof key==="string"&&key.length<=1024&&key.startsWith(`incoming/${channelId}/`)
    &&!key.split("/").some(part=>part==="."||part==="..")&&!key.includes("\\");
}

async function deleteStagingObject(pool,storage,bucket,message){
  const payload=message.payload;
  const requestedKey=payload&&typeof payload==="object"&&!Array.isArray(payload)?payload.storageKey:null;
  if(typeof requestedKey!=="string")return finishStale(pool,message);
  const reservation=await pool.query(`SELECT j.twitch_channel_id,r.staging_key FROM sloptogether.upload_reservations r
    JOIN sloptogether.job_attempts a ON a.id=r.attempt_id JOIN sloptogether.jobs j ON j.id=a.job_id WHERE r.id=$1
    UNION ALL SELECT twitch_channel_id,staging_key FROM sloptogether.asset_upload_reservations WHERE id=$1 LIMIT 1`,[message.aggregateId]);
  const row=reservation.rows[0];
  if(!row||row.staging_key!==requestedKey||!validStagingKey(row.staging_key,row.twitch_channel_id))return finishStale(pool,message);
  await storage.send(new DeleteObjectCommand({Bucket:bucket,Key:row.staging_key}));
  await pool.query("UPDATE sloptogether.outbox SET delivered_at=now(),leased_until=NULL WHERE id=$1 AND delivered_at IS NULL AND leased_until=$2",[message.id,message.leaseUntil]);
  return {status:"staging_deleted"};
}

export function validSnapshotCandidateKey(key,channelId){
  if(typeof key!=="string"||typeof channelId!=="string"||!/^[0-9]{1,32}$/.test(channelId)||key.length>1024||key.includes("\\")||key.split("/").some(part=>part==="."||part===".."))return false;
  const parts=key.split("/");
  return parts.length===5&&parts[0]==="private"&&parts[1]===channelId
    &&((parts[2]==="images"&&/^[0-9a-f-]{36}$/i.test(parts[3])&&/^[0-9a-f-]{36}$/i.test(parts[4]))
      ||(parts[2]==="artifacts"&&/^[0-9a-f-]{36}$/i.test(parts[3])&&/^[0-9a-f-]{36}\.mp4$/i.test(parts[4])));
}

async function deleteUnreferencedSnapshotCandidate(pool,storage,bucket,message){
  const payload=message.payload;
  const channelId=payload&&typeof payload==="object"&&!Array.isArray(payload)?payload.channelId:null;
  const storageKey=payload&&typeof payload==="object"&&!Array.isArray(payload)?payload.storageKey:null;
  if(typeof channelId!=="string"||typeof storageKey!=="string"||!validSnapshotCandidateKey(storageKey,channelId))return finishStale(pool,message);
  const result=await pool.query(`SELECT
      EXISTS(SELECT 1 FROM sloptogether.assets WHERE twitch_channel_id=$1 AND storage_key=$2)
      OR EXISTS(SELECT 1 FROM sloptogether.asset_upload_reservations WHERE twitch_channel_id=$1 AND snapshot_key=$2)
      OR EXISTS(SELECT 1 FROM sloptogether.upload_reservations r JOIN sloptogether.job_attempts a ON a.id=r.attempt_id
        JOIN sloptogether.jobs j ON j.id=a.job_id WHERE j.twitch_channel_id=$1 AND r.immutable_snapshot_key=$2) AS referenced`,[channelId,storageKey]);
  if(result.rows[0]?.referenced)return finishStale(pool,message);
  await storage.send(new DeleteObjectCommand({Bucket:bucket,Key:storageKey}));
  await finishStale(pool,message);
  return {status:"unreferenced_snapshot_deleted"};
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
    const channelState=await client.query("SELECT policy_revision FROM sloptogether.channels WHERE twitch_channel_id=$1 AND is_enabled FOR SHARE",[payload.channelId]);
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
    const attempt = await client.query(`SELECT ja.id,ja.funding_id,f.paid_action_intent_id,j.segment_revision_id,j.interrupt_id,j.twitch_channel_id,j.requested_by,
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
      frame_count=$7,duration_seconds=$8,validated_at=now() WHERE id=$1 AND status='quarantine' AND sha256=$9 RETURNING id`,
    [payload.assetId,autoApproved?"approved":"validated",metadata.width, metadata.height, metadata.fpsNum, metadata.fpsDen, metadata.frameCount, metadata.durationSeconds, Buffer.from(payload.sha256, "hex")]);
    if (!updated.rowCount) {
      await client.query("ROLLBACK");
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
      if(payload.stage==="video_base")await client.query(`INSERT INTO sloptogether.outbox(event_kind,aggregate_id,payload,idempotency_key)
        VALUES('media.publish_requested',$1,$2::jsonb,$3) ON CONFLICT(idempotency_key) DO NOTHING`,[payload.assetId,JSON.stringify({assetId:payload.assetId,approvalPath}),"publish:"+payload.assetId+":"+payload.sha256]);
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

async function releaseForRetry(pool, message) {
  const delay = Math.min(900, 5 * 2 ** Math.min(Math.max(message.attempts - 1, 0), 7));
  await pool.query(`UPDATE sloptogether.outbox SET leased_until=NULL,available_at=now()+($3::int*interval '1 second')
    WHERE id=$1 AND delivered_at IS NULL AND leased_until=$2`, [message.id, message.leaseUntil, delay]);
}

async function validateOne(pool, storage, config, message) {
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
      width: Number(current.output_width),
      height: Number(current.output_height),
      fpsNum: Number(current.output_fps_num),
      fpsDen: Number(current.output_fps_den),
    }, snapshot.bytes, {
      maxBytes: config.maxBytes,
      minDurationSeconds: config.minDuration,
      maxDurationSeconds: config.maxDuration,
    });
    await decodeMedia(config.ffmpeg,snapshot.file);
    const trustedBinding=trustedSystemApprovalCandidate(current)
      ?{kind:"trusted_execution",executionBindingId:current.execution_binding_id,keyId:current.execution_key_id,channelPolicyRevision:current.channel_policy_revision,segmentRevisionId:current.segment_revision_id}
      :trustedUploaderApprovalPath(current)
        ?{kind:"trusted_uploader",approvalPath:trustedUploaderApprovalPath(current),channelPolicyRevision:current.channel_policy_revision,segmentRevisionId:current.segment_revision_id}
        :null;
    const accepted = await commitValidation(pool, message, payload, metadata, trustedBinding);
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

export function createMediaValidator(env = process.env) {
  const config = requiredEnvironment(env);
  const pool = makePool(config.databaseUrl);
  const storage = makeStorageClient(config);
  let stopping = false;
  const stop = () => { stopping = true; };

  async function runOnce() {
    const gatewayEvents=["media.validate","media.publish_requested","storage.delete_staging","storage.cleanup_snapshot_candidate","comfy.frame_generation.expire"];
    const message = await claimOutbox(pool,config.mediaGatewayUrl?gatewayEvents:undefined);
    if (!message) return null;
    try {
      const result = message.eventKind==="storage.delete_staging"
        ?await deleteStagingObject(pool,storage,config.bucket,message)
        :message.eventKind==="storage.cleanup_snapshot_candidate"
        ?await deleteUnreferencedSnapshotCandidate(pool,storage,config.bucket,message)
        :message.eventKind==="paid.bits.reconcile_receipt"
        ?await processBitsReconcileMessage({config,message})
        :message.eventKind==="comfy.frame_generation.expire"
        ?await processComfyFrameExpiry(pool,message)
        :message.eventKind==="media.validate"
        ?await validateOne(pool, storage, config, message)
        :["paid.turbo.dispatch","paid.turbo.poll","provider.reconcile_cancel"].includes(message.eventKind)
        ?await processPaidTurboMessage({pool,storage,config,message})
        :await processPublishRequested({pool,storage,config:{...config,minDurationSeconds:config.minDuration,maxDurationSeconds:config.maxDuration},message});
      console.info(JSON.stringify({ event: "media_pipeline_event_complete", outboxId: message.id, eventKind:message.eventKind, ...result }));
      return result;
    } catch (error) {
      await releaseForRetry(pool, message).catch(() => undefined);
      const code = error instanceof Error ? (error.code || error.name) : "unknown_error";
      console.error(JSON.stringify({ event: "media_pipeline_retry", outboxId: message.id, eventKind:message.eventKind, code }));
      return { status: "retry", code };
    }
  }

  async function start() {
    while (!stopping) {
      const result = await runOnce();
      if (result === null && !stopping) await new Promise((resolve) => setTimeout(resolve, config.pollMs));
    }
    await storage.destroy();
    await pool.end();
  }

  return { runOnce, start, stop };
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  let worker;
  try {
    worker = createMediaValidator();
  } catch (error) {
    console.error(JSON.stringify({ event: "media_validator_configuration_error", code: error?.message || "configuration_error" }));
    process.exitCode = 1;
  }
  if (worker) {
    process.on("SIGINT", worker.stop);
    process.on("SIGTERM", worker.stop);
    worker.start().catch((error) => {
      console.error(JSON.stringify({ event: "media_validator_fatal", code: error?.code || error?.name || "unknown_error" }));
      process.exitCode = 1;
    });
  }
}
