import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError, assertSameOrigin, readJson } from "./http";
import { query, transaction } from "./db";
import { requestPrincipal, type RequestPrincipal } from "./principals";
import { canContribute, canReviewContent, findChannel, isBanned, principalTwitchId } from "./channels";
import { constantTimeEqual, signUploadTicket } from "./crypto";
import { copyToImmutableSnapshot, createQuarantineObjectKey, signedDirectUploadUrl, signedPrivateReadUrl } from "./storage";

const IMAGE_LIMIT=16*1024*1024;
const VIDEO_LIMIT=128*1024*1024;
const imageTypes=["image/png","image/jpeg","image/webp"] as const;
const frameGrantSchema=z.object({fileName:z.string().min(1).max(240),contentType:z.enum(imageTypes),size:z.number().int().positive().max(IMAGE_LIMIT),purpose:z.enum(["proposal_start_frame","proposal_end_frame"])}).strict();
const workerGrantSchema=z.object({fence:z.number().int().positive(),contentType:z.literal("video/mp4"),fileName:z.string().min(1).max(240),byteSize:z.number().int().positive().max(VIDEO_LIMIT),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const completionSchema=z.object({fence:z.number().int().positive().optional(),sha256:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict();

interface WorkerAttempt {
  id:string;job_id:string;fence:string;state:string;worker_device_id:string|null;execution_binding_id:string|null;
  output_asset_id:string|null;lease_expires_at:Date|null;attempt_deadline_at:Date|null;upload_grace_deadline_at:Date|null;
  twitch_channel_id:string;stage:string;job_state:string;key_id:string|null;binding_revoked_at:Date|null;
  input_screen_id:string|null;input_state:string|null;interrupt_actor_id:string|null;
}

const attemptSql=`SELECT a.id,a.job_id,a.fence,a.state,a.worker_device_id,a.execution_binding_id,a.output_asset_id,
  a.lease_expires_at,a.attempt_deadline_at,a.upload_grace_deadline_at,j.twitch_channel_id,j.stage,j.state AS job_state,
  (SELECT se.twitch_actor_id FROM sloptogether.interrupt_requests ir JOIN sloptogether.subscription_events se ON se.id=ir.trigger_event_id WHERE ir.id=j.interrupt_id) AS interrupt_actor_id,
  te.key_id,te.revoked_at AS binding_revoked_at,screen.id AS input_screen_id,screen.effective_state AS input_state
  FROM sloptogether.job_attempts a JOIN sloptogether.jobs j ON j.id=a.job_id
  LEFT JOIN sloptogether.trusted_executions te ON te.id=a.execution_binding_id AND te.twitch_channel_id=j.twitch_channel_id
  LEFT JOIN LATERAL(SELECT s.id,s.effective_state FROM sloptogether.input_screens s
    WHERE s.twitch_channel_id=j.twitch_channel_id AND (s.expires_at IS NULL OR s.expires_at>now()) AND
      (s.id::text=(j.planning_payload->>'inputScreenId') OR EXISTS(
        SELECT 1 FROM sloptogether.proposals p WHERE p.segment_revision_id=j.segment_revision_id AND p.input_screen_id=s.id)
        OR EXISTS(SELECT 1 FROM sloptogether.story_plan_attempts sp WHERE sp.resulting_segment_id=(SELECT segment_id FROM sloptogether.segment_revisions WHERE id=j.segment_revision_id) AND sp.screen_id=s.id))
    ORDER BY s.created_at DESC LIMIT 1) screen ON true`;

function requireLiveAttempt(attempt:WorkerAttempt,fence:number) {
  if(Number(attempt.fence)!==fence)throw new ApiError(409,"lease_fence_stale");
  if(!["leased","running","uploaded","validating"].includes(attempt.state)||!["leased","running","uploaded","validating"].includes(attempt.job_state))throw new ApiError(409,"attempt_not_active");
  const now=Date.now();
  if(!attempt.attempt_deadline_at||attempt.attempt_deadline_at.getTime()<=now)throw new ApiError(409,"attempt_deadline_exceeded");
  if(!attempt.lease_expires_at||attempt.lease_expires_at.getTime()<=now)throw new ApiError(409,"lease_expired");
  if(attempt.input_state!=="clear"||!attempt.input_screen_id)throw new ApiError(409,"input_screen_not_clear");
}

async function requireAttemptOwner(attempt:WorkerAttempt,principal:RequestPrincipal) {
  const actor=principalTwitchId(principal);
  if(!actor||await isBanned(attempt.twitch_channel_id,actor)||(attempt.interrupt_actor_id&&await isBanned(attempt.twitch_channel_id,attempt.interrupt_actor_id)))throw new ApiError(403,"channel_ban_active");
  const role=attempt.stage==="video_base"?"generation":attempt.stage==="video_upscale"?"upscale":null;
  if(!role)throw new ApiError(409,"attempt_has_no_media_upload");
  if(principal.kind==="worker-device"){
    if(principal.deviceId!==attempt.worker_device_id||!principal.roles.includes(role))throw new ApiError(403,"attempt_owner_required");
    if(!await canContribute(await findChannel(attempt.twitch_channel_id),principal))throw new ApiError(403,"contribution_not_allowed");
    return actor;
  }
  if(principal.kind!=="worker-key"||principal.worker.channelId!==attempt.twitch_channel_id||principal.worker.keyId!==attempt.key_id||attempt.binding_revoked_at||!principal.worker.scopes.includes("worker:"+role))throw new ApiError(403,"attempt_owner_required");
  if(principal.worker.paired&&!await canContribute(await findChannel(attempt.twitch_channel_id),principal))throw new ApiError(403,"contribution_not_allowed");
  return actor;
}

function gatewayOrigin() {
  const configured=process.env.SLOPTOGETHER_UPLOAD_WORKER_ORIGIN??process.env.R2_UPLOAD_WORKER_ORIGIN;
  if(!configured)throw new ApiError(503,"upload_gateway_not_configured","Private media uploads are being configured.");
  const url=new URL(configured);
  if(url.protocol!=="https:"||url.username||url.password||url.search||url.hash)throw new ApiError(503,"upload_gateway_not_configured");
  return url.toString().replace(/\/$/,"");
}

function uploadResponse(input:{id:string;assetId?:string;channelId:string;storageKey:string;contentType:string;maxBytes:number;expiresAt:Date;leaseId?:string;fence?:number},directUrl?:string) {
  const ticket=directUrl?null:signUploadTicket({version:1,uploadId:input.id,channelId:input.channelId,storageKey:input.storageKey,contentType:input.contentType,maxBytes:input.maxBytes,expiresAt:input.expiresAt.toISOString(),leaseId:input.leaseId??null,fence:input.fence??null});
  return {uploadId:input.id,assetId:input.assetId,method:"PUT" as const,
    uploadUrl:directUrl??`${gatewayOrigin()}/uploads/${encodeURIComponent(input.id)}?ticket=${encodeURIComponent(ticket!)}`,
    requiredHeaders:{"Content-Type":input.contentType},maxBytes:input.maxBytes,expiresAt:input.expiresAt.toISOString()};
}

export async function issueAssetUpload(locator:string,request:Request) {
  const principal=await requestPrincipal(request);if(!principal)throw new ApiError(401,"login_required");
  const workerPath=new URL(request.url).pathname.includes("/workers/leases/");
  if(workerPath){
    const body=await readJson(request,workerGrantSchema);
    const found=await query<WorkerAttempt>(attemptSql+" WHERE a.id=$1",[locator]);
    const attempt=found.rows[0];if(!attempt)throw new ApiError(404,"attempt_not_found");
    await requireAttemptOwner(attempt,principal);requireLiveAttempt(attempt,body.fence);
    const attemptChannel=await findChannel(attempt.twitch_channel_id);
    if(principal.kind==="worker-key"&&principal.worker.paired&&!await canContribute(attemptChannel,principal))throw new ApiError(403,"contribution_not_allowed");
    if(attempt.output_asset_id)throw new ApiError(409,"attempt_output_already_submitted");
    const direct=principal.kind==="worker-key"&&principal.worker.scopes.includes("artifact:system_approve");
    if(!direct){gatewayOrigin();signUploadTicket({configurationCheck:true});}
    const expiresAt=new Date(Math.min(Date.now()+90_000,attempt.attempt_deadline_at!.getTime(),attempt.lease_expires_at!.getTime()));
    if(expiresAt.getTime()<Date.now()+5000)throw new ApiError(409,"upload_window_too_short");
    const reservation=await transaction(async client=>{
      const policy=await client.query<{policy_revision:number}>("SELECT policy_revision FROM sloptogether.channels WHERE twitch_channel_id=$1 AND is_enabled FOR SHARE",[attempt.twitch_channel_id]);
      if(policy.rows[0]?.policy_revision!==attemptChannel.policy_revision)throw new ApiError(409,"channel_policy_changed");
      const active=await client.query(`SELECT a.id FROM sloptogether.job_attempts a JOIN sloptogether.jobs j ON j.id=a.job_id
        WHERE a.id=$1 AND a.fence=$2 AND a.state IN ('leased','running') AND j.state IN ('leased','running')
          AND a.output_asset_id IS NULL AND a.lease_expires_at>now() AND a.attempt_deadline_at>now() FOR UPDATE OF a,j`,[attempt.id,body.fence]);
      if(!active.rowCount)throw new ApiError(409,"attempt_not_active");
      const count=await client.query<{n:string}>("SELECT count(*) AS n FROM sloptogether.upload_reservations WHERE attempt_id=$1 AND state='issued' AND expires_at>now()",[attempt.id]);
      if(Number(count.rows[0]?.n??0)>=2)throw new ApiError(429,"outstanding_upload_limit");
      const id=randomUUID();const key=createQuarantineObjectKey(attempt.twitch_channel_id,attempt.id,"mp4");
      await client.query(`INSERT INTO sloptogether.upload_reservations(id,attempt_id,fence,staging_key,max_bytes,content_type,expires_at,source_sha256,policy_revision)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,attempt.id,body.fence,key,body.byteSize,body.contentType,expiresAt,Buffer.from(body.sha256,"hex"),policy.rows[0]!.policy_revision]);
      await client.query(`INSERT INTO sloptogether.outbox(event_kind,aggregate_id,payload,idempotency_key,available_at)
        VALUES('storage.delete_staging',$1,$2::jsonb,$3,$4) ON CONFLICT DO NOTHING`,[id,JSON.stringify({storageKey:key}),"cleanup-worker:"+id,expiresAt]);
      return {id,key};
    });
    const directUrl=direct?await signedDirectUploadUrl(reservation.key,body.contentType,body.byteSize,Math.max(5,Math.floor((expiresAt.getTime()-Date.now())/1000))):undefined;
    return uploadResponse({id:reservation.id,channelId:attempt.twitch_channel_id,storageKey:reservation.key,contentType:body.contentType,maxBytes:body.byteSize,expiresAt,leaseId:attempt.id,fence:body.fence},directUrl);
  }
  if(principal.kind!=="session")throw new ApiError(403,"browser_session_required");
  assertSameOrigin(request);const channel=await findChannel(locator);
  if(!await canContribute(channel,principal))throw new ApiError(403,"contribution_not_allowed");
  const actor=principal.session.twitchUserId;const body=await readJson(request,frameGrantSchema);
  // Check configuration before persisting an unusable upload reservation.
  gatewayOrigin();
  const expiresAt=new Date(Date.now()+180_000);const id=randomUUID();const assetId=randomUUID();
  const extension=body.contentType==="image/png"?"png":body.contentType==="image/jpeg"?"jpg":"webp";
  const key=createQuarantineObjectKey(channel.twitch_channel_id,id,extension);
  const grant=uploadResponse({id,assetId,channelId:channel.twitch_channel_id,storageKey:key,contentType:body.contentType,maxBytes:body.size,expiresAt});
  await transaction(async client=>{
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["asset-upload-user:"+actor]);
    const policy=await client.query<{policy_revision:number}>("SELECT policy_revision FROM sloptogether.channels WHERE twitch_channel_id=$1 AND is_enabled FOR UPDATE",[channel.twitch_channel_id]);
    if(policy.rows[0]?.policy_revision!==channel.policy_revision)throw new ApiError(409,"channel_policy_changed");
    const count=await client.query<{n:string;total:string}>(`SELECT count(*) AS n,coalesce(sum(max_bytes),0) AS total FROM sloptogether.asset_upload_reservations
      WHERE twitch_user_id=$1 AND state='issued' AND expires_at>now()`,[actor]);
    if(Number(count.rows[0]?.n??0)>=3||Number(count.rows[0]?.total??0)+body.size>32*1024*1024)throw new ApiError(429,"outstanding_upload_limit");
    const recent=await client.query<{n:string}>("SELECT count(*) AS n FROM sloptogether.asset_upload_reservations WHERE twitch_user_id=$1 AND created_at>now()-interval '1 hour'",[actor]);
    if(Number(recent.rows[0]?.n??0)>=30)throw new ApiError(429,"upload_rate_limited");
    await client.query(`INSERT INTO sloptogether.assets(id,twitch_channel_id,storage_key,media_kind,content_type,byte_size,status,uploaded_by_twitch_user_id)
      VALUES($1,$2,$3,'image',$4,$5,'uploading',$6)`,[assetId,channel.twitch_channel_id,key,body.contentType,body.size,actor]);
    await client.query(`INSERT INTO sloptogether.asset_upload_reservations(id,asset_id,twitch_channel_id,twitch_user_id,staging_key,content_type,expected_bytes,max_bytes,expires_at,policy_revision)
      VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$9)`,[id,assetId,channel.twitch_channel_id,actor,key,body.contentType,body.size,expiresAt,policy.rows[0]!.policy_revision]);
    await client.query(`INSERT INTO sloptogether.outbox(event_kind,aggregate_id,payload,idempotency_key,available_at)
      VALUES('storage.delete_staging',$1,$2::jsonb,$3,$4) ON CONFLICT DO NOTHING`,[id,JSON.stringify({storageKey:key}),"cleanup-frame:"+id,expiresAt]);
  });
  return grant;
}

interface ObjectFacts {bytes:number;sha256:Buffer;etag:string;prefix:Buffer;contentType:string}
async function inspectObject(key:string,maxBytes:number,expectedType:string):Promise<ObjectFacts> {
  const response=await fetch(await signedPrivateReadUrl(key,120),{cache:"no-store",signal:AbortSignal.timeout(45_000)});
  if(!response.ok||!response.body)throw new ApiError(409,"upload_object_unavailable");
  const etag=response.headers.get("etag");if(!etag)throw new ApiError(503,"storage_object_version_unavailable");
  const contentType=(response.headers.get("content-type")??"").split(";",1)[0]!.toLowerCase();
  if(contentType!==expectedType)throw new ApiError(415,"uploaded_content_type_mismatch");
  const length=Number(response.headers.get("content-length"));
  if(Number.isFinite(length)&&length>maxBytes)throw new ApiError(413,"uploaded_object_too_large");
  const digest=createHash("sha256");let bytes=0;let kept=0;const prefix:Buffer[]=[];const reader=response.body.getReader();
  try {for(;;){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;
    if(bytes>maxBytes){await reader.cancel();throw new ApiError(413,"uploaded_object_too_large");}
    digest.update(chunk.value);if(kept<524288){const part=Buffer.from(chunk.value.subarray(0,524288-kept));prefix.push(part);kept+=part.length;}}}
  finally {reader.releaseLock();}
  if(bytes<1)throw new ApiError(422,"uploaded_object_empty");
  return {bytes,sha256:digest.digest(),etag,prefix:Buffer.concat(prefix),contentType};
}

function imageDimensions(data:Buffer,type:string) {
  let width=0;let height=0;
  if(type==="image/png"&&data.length>=24&&data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&data.toString("ascii",12,16)==="IHDR"){
    width=data.readUInt32BE(16);height=data.readUInt32BE(20);
  }else if(type==="image/jpeg"&&data[0]===255&&data[1]===216){
    let offset=2;
    while(offset+4<=data.length){if(data[offset]!==255)break;while(data[offset]===255)offset++;const marker=data[offset++]!;
      if(marker===217||marker===218)break;if(marker===216||marker===1||(marker>=208&&marker<=215))continue;
      if(offset+2>data.length)break;const length=data.readUInt16BE(offset);if(length<2||offset+length>data.length)break;
      if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)&&length>=7){height=data.readUInt16BE(offset+3);width=data.readUInt16BE(offset+5);break;}offset+=length;}
  }else if(type==="image/webp"&&data.length>=30&&data.toString("ascii",0,4)==="RIFF"&&data.toString("ascii",8,12)==="WEBP"){
    const format=data.toString("ascii",12,16);
    if(format==="VP8X"){width=1+data.readUIntLE(24,3);height=1+data.readUIntLE(27,3);}
    else if(format==="VP8 "&&data.length>=30&&data[23]===157&&data[24]===1&&data[25]===42){width=data.readUInt16LE(26)&16383;height=data.readUInt16LE(28)&16383;}
    else if(format==="VP8L"&&data[20]===47){const bits=data.readUInt32LE(21);width=(bits&16383)+1;height=((bits>>>14)&16383)+1;}
  }
  if(width<64||height<64||width>8192||height>8192||width*height>32_000_000)throw new ApiError(422,"invalid_image_dimensions");
  return {width,height};
}

async function snapshotObject(stagingKey:string,snapshotKey:string,maxBytes:number,type:string,expectedSha?:Buffer) {
  const source=await inspectObject(stagingKey,maxBytes,type);
  if(expectedSha&&!source.sha256.equals(expectedSha))throw new ApiError(409,"uploaded_digest_mismatch");
  await copyToImmutableSnapshot(stagingKey,snapshotKey,source.etag);
  const snapshot=await inspectObject(snapshotKey,maxBytes,type);
  if(source.bytes!==snapshot.bytes||!source.sha256.equals(snapshot.sha256))throw new ApiError(409,"snapshot_digest_mismatch");
  return snapshot;
}

async function scheduleSnapshotCleanup(channelId:string,storageKey:string) {
  const id=randomUUID();
  const result=await query<{id:string}>(`INSERT INTO sloptogether.outbox(event_kind,aggregate_id,payload,idempotency_key,available_at)
    VALUES('storage.cleanup_snapshot_candidate',$1,$2::jsonb,$3,now()+interval '1 day') RETURNING id`,
  [id,JSON.stringify({channelId,storageKey}),`cleanup-snapshot:${storageKey}`]);
  const candidate=result.rows[0];if(!candidate)throw new ApiError(500,"snapshot_cleanup_schedule_failed");
  return candidate.id;
}

async function keepSnapshot(client:import("pg").PoolClient,candidateId:string) {
  await client.query("UPDATE sloptogether.outbox SET delivered_at=now() WHERE id=$1 AND event_kind='storage.cleanup_snapshot_candidate' AND delivered_at IS NULL",[candidateId]);
}

export async function completeAssetUpload(locator:string,request:Request) {
  const principal=await requestPrincipal(request);if(!principal)throw new ApiError(401,"login_required");
  if(principal.kind==="session")assertSameOrigin(request);
  const body=await readJson(request,completionSchema);
  const frames=await query<{id:string;asset_id:string;twitch_channel_id:string;twitch_user_id:string;staging_key:string;content_type:string;expected_bytes:string;max_bytes:string;expires_at:Date;state:string;snapshot_sha256:Buffer|null;policy_revision:number}>(
    "SELECT * FROM sloptogether.asset_upload_reservations WHERE id=$1 OR asset_id=$1",[locator]);
  const frame=frames.rows[0];
  if(frame){
    if(principal.kind!=="session"||principal.session.twitchUserId!==frame.twitch_user_id)throw new ApiError(403,"upload_owner_required");
    const channel=await findChannel(frame.twitch_channel_id);if(frame.policy_revision!==channel.policy_revision)throw new ApiError(409,"channel_policy_changed");if(!await canContribute(channel,principal))throw new ApiError(403,"contribution_not_allowed");
    if(frame.state==="snapshotted"){
      if(body.sha256&&body.sha256!==frame.snapshot_sha256?.toString("hex"))throw new ApiError(409,"uploaded_digest_mismatch");
      return {accepted:true,uploadId:frame.id,assetId:frame.asset_id,sha256:frame.snapshot_sha256?.toString("hex"),state:"quarantine"};
    }
    if(frame.state!=="issued"||frame.expires_at.getTime()<=Date.now())throw new ApiError(409,"upload_expired");
    const key=`private/${frame.twitch_channel_id}/images/${frame.asset_id}/${randomUUID()}`;
    const cleanupCandidateId=await scheduleSnapshotCleanup(frame.twitch_channel_id,key);
    const facts=await snapshotObject(frame.staging_key,key,Number(frame.max_bytes),frame.content_type,body.sha256?Buffer.from(body.sha256,"hex"):undefined);
    if(facts.bytes!==Number(frame.expected_bytes))throw new ApiError(409,"uploaded_size_mismatch");
    const dimensions=imageDimensions(facts.prefix,frame.content_type);
    await transaction(async client=>{
      const policy=await client.query<{policy_revision:number}>("SELECT policy_revision FROM sloptogether.channels WHERE twitch_channel_id=$1 AND is_enabled FOR SHARE",[frame.twitch_channel_id]);
      if(policy.rows[0]?.policy_revision!==channel.policy_revision)throw new ApiError(409,"channel_policy_changed");
      const claim=await client.query(`UPDATE sloptogether.asset_upload_reservations SET state='snapshotted',snapshot_key=$2,snapshot_sha256=$3,completed_at=now()
        WHERE id=$1 AND state='issued' AND expires_at>now() RETURNING id`,[frame.id,key,facts.sha256]);
      if(!claim.rowCount)throw new ApiError(409,"upload_already_finalized_or_expired");
      const banned=await client.query(`SELECT 1 FROM sloptogether.bans WHERE twitch_user_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())
        AND (scope='global' OR twitch_channel_id=$2)`,[frame.twitch_user_id,frame.twitch_channel_id]);
      if(banned.rowCount)throw new ApiError(403,"channel_ban_active");
      await client.query(`UPDATE sloptogether.assets SET storage_key=$2,sha256=$3,byte_size=$4,width=$5,height=$6,status='quarantine'
        WHERE id=$1 AND status='uploading'`,[frame.asset_id,key,facts.sha256,facts.bytes,dimensions.width,dimensions.height]);
      await client.query(`INSERT INTO sloptogether.outbox(event_kind,aggregate_id,payload,idempotency_key,available_at)
        VALUES('storage.delete_staging',$1,$2::jsonb,$3,$4) ON CONFLICT DO NOTHING`,[frame.id,JSON.stringify({storageKey:frame.staging_key}),"cleanup-frame:"+frame.id,frame.expires_at]);
      await keepSnapshot(client,cleanupCandidateId);
    });
    return {accepted:true,uploadId:frame.id,assetId:frame.asset_id,sha256:facts.sha256.toString("hex"),state:"quarantine",width:dimensions.width,height:dimensions.height};
  }
  const reservations=await query<{id:string;attempt_id:string;fence:string;staging_key:string;max_bytes:string;content_type:string;expires_at:Date;state:string;snapshot_sha256:Buffer|null;source_sha256:Buffer|null;policy_revision:number}>("SELECT * FROM sloptogether.upload_reservations WHERE id=$1",[locator]);
  const reservation=reservations.rows[0];if(!reservation)throw new ApiError(404,"upload_not_found");
  const attempts=await query<WorkerAttempt>(attemptSql+" WHERE a.id=$1",[reservation.attempt_id]);
  const attempt=attempts.rows[0];if(!attempt)throw new ApiError(404,"attempt_not_found");
  const actor=await requireAttemptOwner(attempt,principal);
  const attemptChannel=await findChannel(attempt.twitch_channel_id);
  if(reservation.policy_revision!==attemptChannel.policy_revision)throw new ApiError(409,"channel_policy_changed");
  if(principal.kind==="worker-key"&&principal.worker.paired&&!await canContribute(attemptChannel,principal))throw new ApiError(403,"contribution_not_allowed");
  if(body.fence===undefined||body.fence!==Number(reservation.fence))throw new ApiError(409,"lease_fence_stale");
  if(reservation.state==="snapshotted"&&attempt.output_asset_id){
    if(!["validating","succeeded"].includes(attempt.state))throw new ApiError(409,"attempt_result_no_longer_current");
    if(body.sha256&&body.sha256!==reservation.snapshot_sha256?.toString("hex"))throw new ApiError(409,"uploaded_digest_mismatch");
    return {accepted:true,artifactId:attempt.output_asset_id,sha256:reservation.snapshot_sha256?.toString("hex"),approvalPath:attempt.state==="succeeded"?"admitted":"pending_validation"};
  }
  requireLiveAttempt(attempt,body.fence);
  if(reservation.state!=="issued"||reservation.expires_at.getTime()<=Date.now())throw new ApiError(409,"upload_expired");
  const assetId=randomUUID();const key=`private/${attempt.twitch_channel_id}/artifacts/${assetId}/${randomUUID()}.mp4`;
  const cleanupCandidateId=await scheduleSnapshotCleanup(attempt.twitch_channel_id,key);
  const expected=body.sha256?Buffer.from(body.sha256,"hex"):reservation.source_sha256??undefined;
  if(reservation.source_sha256&&expected&&!reservation.source_sha256.equals(expected))throw new ApiError(409,"declared_digest_mismatch");
  const facts=await snapshotObject(reservation.staging_key,key,Number(reservation.max_bytes),reservation.content_type,expected);
  if(facts.prefix.length<12||facts.prefix.toString("ascii",4,8)!=="ftyp")throw new ApiError(422,"invalid_mp4_container");
  if(principal.kind==="worker-key"&&principal.worker.paired&&!await canContribute(await findChannel(attempt.twitch_channel_id),principal))throw new ApiError(403,"contribution_not_allowed");
  await transaction(async client=>{
    const policy=await client.query<{policy_revision:number}>("SELECT policy_revision FROM sloptogether.channels WHERE twitch_channel_id=$1 AND is_enabled FOR SHARE",[attempt.twitch_channel_id]);
    if(policy.rows[0]?.policy_revision!==reservation.policy_revision)throw new ApiError(409,"channel_policy_changed");
    if(principal.kind==="worker-key"){
      const authority=await client.query(`SELECT 1 FROM sloptogether.application_keys k JOIN sloptogether.trusted_executions te
        ON te.key_id=k.key_id AND te.id=$2 AND te.revoked_at IS NULL
        JOIN sloptogether.channels c ON c.twitch_channel_id=k.twitch_channel_id AND c.is_enabled
        WHERE k.key_id=$1 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>now())
          AND k.twitch_channel_id=$3 AND $4=ANY(k.scopes) FOR SHARE OF k,te,c`,[principal.worker.keyId,attempt.execution_binding_id,attempt.twitch_channel_id,"worker:"+(attempt.stage==="video_base"?"generation":"upscale")]);
      if(!authority.rowCount)throw new ApiError(403,"worker_authority_revoked");
    }else if(principal.kind==="worker-device"){
      const authority=await client.query(`SELECT 1 FROM sloptogether.worker_devices d JOIN sloptogether.channels c ON c.twitch_channel_id=$2 AND c.is_enabled
        WHERE d.id=$1 AND d.status='paired' AND d.revoked_at IS NULL AND
        (c.contribution_mode='any_non_banned_twitch_user' OR
          (c.contribution_mode IN ('explicit_allowlist','combined') AND d.twitch_user_id=ANY(c.contributor_whitelist)) OR
          EXISTS(SELECT 1 FROM sloptogether.memberships m WHERE m.twitch_user_id=d.twitch_user_id AND m.twitch_channel_id=c.twitch_channel_id AND m.status='active'
            AND (m.role IN ('broadcaster','moderator') OR (m.role='reviewer' AND c.contribution_mode IN ('explicit_allowlist','combined')))))
        FOR SHARE OF d,c`,[principal.deviceId,attempt.twitch_channel_id]);
      if(!authority.rowCount)throw new ApiError(403,"worker_authority_revoked");
    }
    await client.query(`INSERT INTO sloptogether.assets(id,twitch_channel_id,storage_key,sha256,media_kind,content_type,byte_size,status,producer_key_id,worker_device_id,uploaded_by_twitch_user_id)
      VALUES($1,$2,$3,$4,'video',$5,$6,'quarantine',$7,$8,$9)`,[assetId,attempt.twitch_channel_id,key,facts.sha256,reservation.content_type,facts.bytes,
      principal.kind==="worker-key"?principal.worker.keyId:null,principal.kind==="worker-device"?principal.deviceId:null,actor]);
    const live=await client.query(`UPDATE sloptogether.job_attempts SET state='validating',output_asset_id=$3
      WHERE id=$1 AND fence=$2 AND state IN ('leased','running','uploaded') AND lease_expires_at>now()
        AND attempt_deadline_at>now() AND output_asset_id IS NULL RETURNING id`,[attempt.id,body.fence,assetId]);
    if(!live.rowCount)throw new ApiError(409,"attempt_changed_before_admission");
    const claimed=await client.query(`UPDATE sloptogether.upload_reservations SET state='snapshotted',uploaded_bytes=$2,
      immutable_snapshot_key=$3,snapshot_sha256=$4,completed_at=now() WHERE id=$1 AND state='issued' AND expires_at>now() RETURNING id`,
      [reservation.id,facts.bytes,key,facts.sha256]);
    if(!claimed.rowCount)throw new ApiError(409,"upload_already_finalized_or_expired");
    await client.query("UPDATE sloptogether.jobs SET state='validating' WHERE id=$1 AND state IN ('leased','running','uploaded')",[attempt.job_id]);
    const ban=await client.query(`SELECT 1 FROM sloptogether.bans WHERE twitch_user_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())
      AND (scope='global' OR twitch_channel_id=$2)`,[actor,attempt.twitch_channel_id]);
    if(ban.rowCount)throw new ApiError(403,"channel_ban_active");
    await client.query(`INSERT INTO sloptogether.outbox(event_kind,aggregate_id,payload,idempotency_key)
      VALUES('media.validate',$1,$2::jsonb,$3) ON CONFLICT DO NOTHING`,[assetId,JSON.stringify({assetId,attemptId:attempt.id,jobId:attempt.job_id,
        channelId:attempt.twitch_channel_id,fence:body.fence,storageKey:key,sha256:facts.sha256.toString("hex"),inputScreenId:attempt.input_screen_id,stage:attempt.stage}),"validate-artifact:"+assetId]);
    await client.query(`INSERT INTO sloptogether.outbox(event_kind,aggregate_id,payload,idempotency_key,available_at)
      VALUES('storage.delete_staging',$1,$2::jsonb,$3,$4) ON CONFLICT DO NOTHING`,[reservation.id,JSON.stringify({storageKey:reservation.staging_key}),"cleanup-worker:"+reservation.id,reservation.expires_at]);
    await keepSnapshot(client,cleanupCandidateId);
    await client.query(`INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,action,target_kind,target_id,after_state)
      VALUES($1,$2,'artifact.snapshot','asset',$3,$4::jsonb)`,[attempt.twitch_channel_id,actor,assetId,JSON.stringify({attemptId:attempt.id,fence:body.fence,sha256:facts.sha256.toString("hex"),state:"pending_validation"})]);
  });
  return {accepted:true,artifactId:assetId,sha256:facts.sha256.toString("hex"),approvalPath:"pending_validation"};
}

export async function getApprovedMediaAsset(assetId:string,request?:Request) {
  const publicAsset=await query<{storage_key:string;content_type:string}>(`SELECT a.storage_key,a.content_type FROM sloptogether.assets a
    WHERE a.id=$1 AND (
      (a.status='published' AND (
        EXISTS(SELECT 1 FROM sloptogether.program_items pi WHERE pi.asset_id=a.id AND pi.committed_at IS NOT NULL
          AND EXISTS(SELECT 1 FROM sloptogether.artifact_approvals aa WHERE aa.asset_id=a.id AND aa.sha256=a.sha256 AND aa.decision='approved'))
        OR EXISTS(SELECT 1 FROM sloptogether.program_media_segments ms JOIN sloptogether.program_items pi ON pi.id=ms.program_item_id
          JOIN sloptogether.assets parent ON parent.id=pi.asset_id AND parent.status='published'
          WHERE ms.media_asset_id=a.id AND ms.sha256=a.sha256 AND pi.committed_at IS NOT NULL
            AND EXISTS(SELECT 1 FROM sloptogether.artifact_approvals aa WHERE aa.asset_id=parent.id AND aa.sha256=parent.sha256 AND aa.decision='approved'))))
      OR (a.status='approved' AND EXISTS(
        SELECT 1 FROM sloptogether.jobs j JOIN sloptogether.job_attempts ja ON ja.job_id=j.id AND ja.output_asset_id=a.id
        JOIN sloptogether.program_items pi ON pi.asset_id=j.parent_asset_id AND pi.item_kind='story' AND pi.committed_at IS NOT NULL
        JOIN sloptogether.assets parent ON parent.id=pi.asset_id AND parent.status='published'
        JOIN LATERAL(SELECT decision FROM sloptogether.artifact_approvals aa WHERE aa.asset_id=a.id AND aa.sha256=a.sha256 ORDER BY aa.created_at DESC,aa.id DESC LIMIT 1) approved ON approved.decision='approved'
        WHERE j.stage='video_upscale' AND j.state='succeeded' AND j.parent_asset_id IS NOT NULL
          AND parent.twitch_channel_id=a.twitch_channel_id
          AND EXISTS(SELECT 1 FROM sloptogether.artifact_approvals aa WHERE aa.asset_id=parent.id AND aa.sha256=parent.sha256 AND aa.decision='approved'))))
      AND EXISTS(SELECT 1 FROM sloptogether.channels c WHERE c.twitch_channel_id=a.twitch_channel_id AND c.is_enabled AND c.visibility<>'private')`,[assetId]);
  if(publicAsset.rows[0])return {url:await signedPrivateReadUrl(publicAsset.rows[0].storage_key,120),contentType:publicAsset.rows[0].content_type};
  if(request){
    const principal=await requestPrincipal(request);
    if(principal){
      const candidate=await query<{storage_key:string;content_type:string;twitch_channel_id:string;uploaded_by_twitch_user_id:string|null}>(`SELECT storage_key,content_type,twitch_channel_id,uploaded_by_twitch_user_id
        FROM sloptogether.assets WHERE id=$1 AND status IN ('quarantine','validated','approved','published')`,[assetId]);
      const asset=candidate.rows[0];
      if(asset){const channel=await findChannel(asset.twitch_channel_id);const actor=principalTwitchId(principal);
        const ownInteractiveUpload=principal.kind==="session"&&actor===asset.uploaded_by_twitch_user_id;
        const scopedReviewer=principal.kind!=="worker-device"&&principal.kind!=="chat"
          &&(principal.kind!=="extension"||principal.extension.channelId===channel.twitch_channel_id)
          &&await canReviewContent(channel,principal);
        if(actor&&!await isBanned(channel.twitch_channel_id,actor)&&(ownInteractiveUpload||scopedReviewer))return {url:await signedPrivateReadUrl(asset.storage_key,60),contentType:asset.content_type};}
    }
  }
  throw new ApiError(404,"media_not_found");
}

export async function authorizeUploadGateway(uploadId:string,request:Request) {
  const secret=process.env.SLOPTOGETHER_UPLOAD_GATEWAY_SECRET;
  const supplied=request.headers.get("x-upload-gateway-secret")??"";
  if(!secret||secret.length<32||!constantTimeEqual(createHash("sha256").update(secret).digest(),createHash("sha256").update(supplied).digest()))throw new ApiError(401,"upload_gateway_unauthorized");
  const frames=await query<{staging_key:string;max_bytes:string;content_type:string;expires_at:Date}>(`SELECT r.staging_key,r.max_bytes,r.content_type,r.expires_at FROM sloptogether.asset_upload_reservations r
    JOIN sloptogether.channels c ON c.twitch_channel_id=r.twitch_channel_id AND c.is_enabled AND c.policy_revision=r.policy_revision
    WHERE r.id=$1 AND r.state='issued' AND r.expires_at>now()
      AND (c.contribution_mode='any_non_banned_twitch_user' OR
        (c.contribution_mode IN ('explicit_allowlist','combined') AND r.twitch_user_id=ANY(c.contributor_whitelist)) OR
        EXISTS(SELECT 1 FROM sloptogether.memberships m WHERE m.twitch_user_id=r.twitch_user_id AND m.twitch_channel_id=c.twitch_channel_id AND m.status='active'
          AND (m.role IN ('broadcaster','moderator') OR (m.role='reviewer' AND c.contribution_mode IN ('explicit_allowlist','combined')))))
      AND NOT EXISTS(
      SELECT 1 FROM sloptogether.bans b WHERE b.twitch_user_id=r.twitch_user_id AND b.revoked_at IS NULL
        AND (b.expires_at IS NULL OR b.expires_at>now()) AND (b.scope='global' OR b.twitch_channel_id=r.twitch_channel_id))`,[uploadId]);
  const frame=frames.rows[0];if(frame)return {authorized:true,storageKey:frame.staging_key,maxBytes:Number(frame.max_bytes),contentType:frame.content_type,expiresAt:frame.expires_at.toISOString()};
  const workers=await query<{staging_key:string;max_bytes:string;content_type:string;expires_at:Date}>(`SELECT r.staging_key,r.max_bytes,r.content_type,r.expires_at FROM sloptogether.upload_reservations r
    JOIN sloptogether.job_attempts a ON a.id=r.attempt_id JOIN sloptogether.jobs j ON j.id=a.job_id
    JOIN sloptogether.channels c ON c.twitch_channel_id=j.twitch_channel_id AND c.policy_revision=r.policy_revision AND c.is_enabled
    LEFT JOIN sloptogether.worker_devices d ON d.id=a.worker_device_id AND d.status='paired' AND d.revoked_at IS NULL
    LEFT JOIN sloptogether.trusted_executions te ON te.id=a.execution_binding_id AND te.revoked_at IS NULL AND te.twitch_channel_id=j.twitch_channel_id
    LEFT JOIN sloptogether.application_keys k ON k.key_id=te.key_id AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>now())
    WHERE r.id=$1 AND r.state='issued' AND r.expires_at>now() AND a.fence=r.fence AND a.lease_expires_at>now()
      AND a.attempt_deadline_at>now() AND a.state IN ('leased','running','uploaded') AND j.state IN ('leased','running','uploaded')
      AND (d.id IS NOT NULL OR k.key_id IS NOT NULL) AND NOT EXISTS(
        SELECT 1 FROM sloptogether.bans b WHERE b.twitch_user_id=coalesce(d.twitch_user_id,k.issuing_twitch_user_id) AND b.revoked_at IS NULL
          AND (b.expires_at IS NULL OR b.expires_at>now()) AND (b.scope='global' OR b.twitch_channel_id=j.twitch_channel_id))
      AND ((k.key_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM sloptogether.worker_pairings wp WHERE wp.id=k.key_id AND wp.approved_at IS NOT NULL))
        OR c.contribution_mode='any_non_banned_twitch_user'
        OR (c.contribution_mode IN ('explicit_allowlist','combined') AND coalesce(d.twitch_user_id,k.issuing_twitch_user_id)=ANY(c.contributor_whitelist))
        OR coalesce(d.twitch_user_id,k.issuing_twitch_user_id)=c.owner_twitch_user_id
        OR EXISTS(SELECT 1 FROM sloptogether.memberships m WHERE m.twitch_user_id=coalesce(d.twitch_user_id,k.issuing_twitch_user_id) AND m.twitch_channel_id=c.twitch_channel_id AND m.status='active'
          AND (m.role IN ('broadcaster','moderator') OR (m.role='reviewer' AND c.contribution_mode IN ('explicit_allowlist','combined')))))`,[uploadId]);
  const worker=workers.rows[0];if(!worker)throw new ApiError(409,"upload_capability_inactive");
  return {authorized:true,storageKey:worker.staging_key,maxBytes:Number(worker.max_bytes),contentType:worker.content_type,expiresAt:worker.expires_at.toISOString()};
}
