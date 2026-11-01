import { createHmac } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import pg from "pg";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { moderationKeyFrom } from "./endpoint.mjs";
import { processPublishRequested } from "./publish.mjs";
import { processPaidTurboMessage } from "./paid-turbo.mjs";
import { processBitsReconcileMessage } from "./bits-reconcile.mjs";
import { processComfyFrameExpiry } from "./comfy-frame-expiry.mjs";
import { finishStale } from "./outbox-state.mjs";
import { validateOne } from "./validation.mjs";
export { validateOne, validateOutboxPayload } from "./validation.mjs";

const { Pool } = pg;
const LEASE_MINUTES = 5;
const PAID_TURBO_ENABLED = process.env.NODE_ENV === "test";
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
    paidBitsReady: PAID_TURBO_ENABLED && env.SLOPTOGETHER_BITS_TURBO_ENABLED === "true" && env.SLOPTOGETHER_BITS_POLICY_APPROVED === "true"
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
  const pool = new Pool({
    ...databasePoolOptions(databaseUrl),
    max: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    application_name: "sloptogether-media-validator",
  });
  observePoolErrors(pool);
  return pool;
}

export function observePoolErrors(pool, logger = console) {
  pool.on("error", (error) => {
    // pg emits this for errors on idle clients. Keep the process alive; Pool
    // removes the failed client and a later query can establish a replacement.
    logger.error(JSON.stringify({
      event: "media_validator_database_connection_error",
      code: error?.code || error?.name || "unknown_error",
    }));
  });
  return pool;
}

export function databaseRetryDelayMs(attempt) {
  const safeAttempt = Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 1;
  return Math.min(30_000, 1_000 * (2 ** Math.min(safeAttempt - 1, 5)));
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

async function releaseForRetry(pool, message) {
  const delay = Math.min(900, 5 * 2 ** Math.min(Math.max(message.attempts - 1, 0), 7));
  await pool.query(`UPDATE sloptogether.outbox SET leased_until=NULL,available_at=now()+($3::int*interval '1 second')
    WHERE id=$1 AND delivered_at IS NULL AND leased_until=$2`, [message.id, message.leaseUntil, delay]);
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
    let databaseFailureCount = 0;
    while (!stopping) {
      try {
        const result = await runOnce();
        databaseFailureCount = 0;
        if (result === null && !stopping) await new Promise((resolve) => setTimeout(resolve, config.pollMs));
      } catch (error) {
        databaseFailureCount += 1;
        const delayMs = databaseRetryDelayMs(databaseFailureCount);
        const code = error instanceof Error ? (error.code || error.name) : "unknown_error";
        console.error(JSON.stringify({ event: "media_validator_database_retry", code, attempt: databaseFailureCount, delayMs }));
        if (!stopping) await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
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
