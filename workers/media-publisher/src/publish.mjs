import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { InvalidMediaError, parseProbeJson, validateMediaMetadata } from "./metadata.mjs";
import { EndpointUnavailableError, extractAndScreenEndpoint } from "./endpoint.mjs";

const execFileAsync=promisify(execFile);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class InvalidPublishError extends Error{
  constructor(code,message=code){super(message);this.name="InvalidPublishError";this.code=code;}
}

export function requireEndpointFrame(endpoint){
  if(!Buffer.isBuffer(endpoint?.frameBytes)||!endpoint.imageDigests?.[0])
    throw new EndpointUnavailableError(endpoint?.unavailableCode??"endpoint_frame_unavailable");
  return endpoint;
}

export function normalizePublishPayload(value){
  if(!value||typeof value!=="object"||Array.isArray(value)||!UUID.test(value.assetId??""))throw new InvalidPublishError("publish_payload_invalid");
  return {assetId:value.assetId};
}

export function validateHlsProfile(value,options={}){
  const width=Number(value?.width),height=Number(value?.height);
  const fpsNum=Number(value?.fpsNum),fpsDen=Number(value?.fpsDen);
  const segmentSeconds=Number(options.segmentSeconds??2);
  const maxSegmentSeconds=Number(options.maxSegmentSeconds??6);
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<64||height<64||width%2||height%2||width*9!==height*16)
    throw new InvalidPublishError("publish_profile_dimensions_invalid");
  if(!Number.isSafeInteger(fpsNum)||!Number.isSafeInteger(fpsDen)||fpsNum<1||fpsDen<1||fpsNum/fpsDen<1||fpsNum/fpsDen>60)
    throw new InvalidPublishError("publish_profile_framerate_invalid");
  if(!Number.isFinite(segmentSeconds)||segmentSeconds<1||segmentSeconds>maxSegmentSeconds)
    throw new InvalidPublishError("publish_profile_segment_seconds_invalid");
  return {width,height,fpsNum,fpsDen,fps:fpsNum/fpsDen,segmentSeconds};
}

export function parseHlsPlaylist(text,options={}){
  if(typeof text!=="string"||text.length>256_000)throw new InvalidPublishError("hls_playlist_invalid");
  const lines=text.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  if(lines[0]!=="#EXTM3U")throw new InvalidPublishError("hls_playlist_invalid");
  const maxSegments=options.maxSegments??64;
  const segments=[];let pendingDuration=null;let endList=false;
  for(const line of lines.slice(1)){
    if(line==="#EXT-X-ENDLIST"){endList=true;continue;}
    if(line.startsWith("#EXTINF:")){
      const raw=line.slice("#EXTINF:".length).split(",",1)[0];
      const duration=Number(raw);
      if(!Number.isFinite(duration)||duration<=0||duration>20||pendingDuration!==null)throw new InvalidPublishError("hls_segment_duration_invalid");
      pendingDuration=duration;continue;
    }
    if(line.startsWith("#"))continue;
    if(endList)throw new InvalidPublishError("hls_playlist_invalid");
    if(!pendingDuration)throw new InvalidPublishError("hls_segment_uri_unexpected");
    if(line.includes("/")||line.includes("\\")||line==="."||line===".."||!/^[-A-Za-z0-9_.]+\.ts$/.test(line))
      throw new InvalidPublishError("hls_segment_uri_invalid");
    segments.push({sequence:segments.length,durationSeconds:pendingDuration,fileName:line});
    pendingDuration=null;
    if(segments.length>maxSegments)throw new InvalidPublishError("hls_segment_count_invalid");
  }
  if(pendingDuration!==null||!endList||segments.length<1)throw new InvalidPublishError("hls_playlist_incomplete");
  return segments;
}

function requiredConfig(config){
  if(!config||typeof config!=="object"||!config.bucket)throw new Error("publish_config_missing");
  return {
    bucket:config.bucket,
    ffmpeg:config.ffmpeg??"ffmpeg",
    ffprobe:config.ffprobe??"ffprobe",
    openAiKey:config.openAiKey??process.env.OPENAI_API_KEY,
    tempDir:config.tempDir??tmpdir(),
    maxBytes:Number.isSafeInteger(config.maxBytes)&&config.maxBytes>0?config.maxBytes:128*1024*1024,
    segmentSeconds:Number.isFinite(config.segmentSeconds)?config.segmentSeconds:2,
    maxDurationSeconds:Number.isFinite(config.maxDurationSeconds)?config.maxDurationSeconds:17,
    minDurationSeconds:Number.isFinite(config.minDurationSeconds)?config.minDurationSeconds:13,
    maxSegments:Number.isSafeInteger(config.maxSegments)&&config.maxSegments>0?config.maxSegments:64,
  };
}

async function downloadObject(storage,bucket,key,filePath,maxBytes){
  const response=await storage.send(new GetObjectCommand({Bucket:bucket,Key:key}),{abortSignal:AbortSignal.timeout(120_000)});
  if(!response.Body||typeof response.Body.pipe!=="function")throw new Error("r2_publish_body_unavailable");
  if(response.ContentLength!==undefined&&response.ContentLength>maxBytes)throw new InvalidPublishError("publish_video_too_large");
  const digest=createHash("sha256");let bytes=0;
  const measure=new Transform({transform(chunk,_encoding,callback){
    bytes+=chunk.length;if(bytes>maxBytes)return callback(new InvalidPublishError("publish_video_too_large"));
    digest.update(chunk);callback(null,chunk);
  }});
  await pipeline(response.Body,measure,createWriteStream(filePath,{flags:"wx"}));
  return {bytes,sha256:digest.digest()};
}

async function runFfprobe(ffprobe,file){
  try{
    const output=await execFileAsync(ffprobe,["-v","error","-count_frames","-show_entries","format=format_name,duration:stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,nb_frames,nb_read_frames,sample_rate,channels,channel_layout","-of","json",file],
      {timeout:30_000,maxBuffer:1024*1024,windowsHide:true});
    return parseProbeJson(output.stdout);
  }catch(error){
    if(error instanceof InvalidMediaError)throw error;
    if(error?.code==="ENOENT"||error?.code==="ETIMEDOUT"||error?.killed)throw error;
    throw new InvalidPublishError("publish_source_probe_failed","The approved MP4 can no longer be decoded.");
  }
}

async function decodeEntireFile(ffmpeg,file,options){
  try{
    await execFileAsync(ffmpeg,["-hide_banner","-nostdin","-v","error","-xerror","-i",file,"-map","0:v:0","-map","0:a:0","-f","null","-"],
      {timeout:options.decodeTimeoutMs??120_000,maxBuffer:1024*1024,windowsHide:true});
  }catch(error){
    if(error?.code==="ENOENT"||error?.code==="ETIMEDOUT"||error?.killed)throw error;
    const detail=String(error?.stderr??"");
    if(/cannot load|could not load|unknown decoder|unrecognized option/i.test(detail))throw error;
    throw new InvalidPublishError("publish_decode_failed","The approved MP4 did not decode cleanly from start to finish.");
  }
}

export async function packageHls(ffmpeg,inputPath,workDir,profile,options){
  const playlistPath=join(workDir,"index.m3u8");
  const segmentPattern=join(workDir,"segment-%03d.ts");
  const gop=Math.max(1,Math.round(profile.fps*profile.segmentSeconds));
  const args=[
    "-hide_banner","-nostdin","-y","-v","error","-i",inputPath,
    "-map","0:v:0","-map","0:a?","-sn","-dn",
    "-vf",`scale=${profile.width}:${profile.height}:flags=lanczos,setsar=1`,"-r",`${profile.fpsNum}/${profile.fpsDen}`,"-fps_mode","cfr",
    "-c:v","libx264","-preset","veryfast","-pix_fmt","yuv420p","-g",String(gop),"-keyint_min",String(gop),"-sc_threshold","0",
    "-force_key_frames",`expr:gte(t,n_forced*${profile.segmentSeconds})`,
    "-c:a","aac","-b:a","128k","-ar","48000","-ac","2",
    "-f","hls","-hls_time",String(profile.segmentSeconds),"-hls_playlist_type","vod","-hls_segment_type","mpegts",
    "-hls_flags","independent_segments+temp_file","-hls_segment_filename",segmentPattern,playlistPath,
  ];
  try{
    await execFileAsync(ffmpeg,args,{timeout:options.ffmpegTimeoutMs??120_000,maxBuffer:1024*1024,windowsHide:true});
  }catch(error){
    if(error?.code==="ENOENT"||error?.code==="ETIMEDOUT"||error?.killed)throw error;
    const detail=String(error?.stderr??"");
    if(/unknown encoder|unrecognized option|no such filter|could not load|cannot load/i.test(detail))throw error;
    throw new InvalidPublishError("hls_transcode_failed","The approved clip could not be packaged for browser playback.");
  }
  const playlist=await readFile(playlistPath,"utf8");
  const segments=parseHlsPlaylist(playlist,{maxSegments:options.maxSegments});
  const total=segments.reduce((sum,item)=>sum+item.durationSeconds,0);
  if(total<options.minDurationSeconds-0.6||total>options.maxDurationSeconds+0.6)
    throw new InvalidPublishError("hls_duration_mismatch");
  return {segments,totalDurationSeconds:Number(total.toFixed(6))};
}

async function uploadSegments(storage,bucket,channelId,assetId,workDir,segments,profile,maxTotalBytes){
  const uploaded=[];let totalBytes=0;
  for(const segment of segments){
    const body=await readFile(join(workDir,segment.fileName));
    totalBytes+=body.length;if(totalBytes>maxTotalBytes)throw new InvalidPublishError("hls_output_too_large");
    if(body.length<188||body[0]!==0x47)throw new InvalidPublishError("hls_transport_stream_invalid");
    for(let offset=188;offset<body.length;offset+=188){if(body[offset]!==0x47)throw new InvalidPublishError("hls_transport_stream_invalid");}
    const digest=createHash("sha256").update(body).digest();
    const key=`private/${channelId}/hls/${assetId}/${String(segment.sequence).padStart(3,"0")}-${digest.toString("hex")}.ts`;
    await storage.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:body,ContentType:"video/mp2t"}));
    uploaded.push({...segment,key,sha256:digest,byteSize:body.length,width:profile.width,height:profile.height,fpsNum:profile.fpsNum,fpsDen:profile.fpsDen});
  }
  return uploaded;
}

// A derivative is eligible only for the exact still-approved parent and scene.
// This fragment is also used during the locked commit, after encoding.
function approvedPreAirParent(baseParameter){
  return `EXISTS(SELECT 1 FROM sloptogether.preair_upscale_requests pr
    JOIN sloptogether.assets base ON base.id=pr.base_asset_id AND base.twitch_channel_id=a.twitch_channel_id
    JOIN sloptogether.job_attempts base_attempt ON base_attempt.output_asset_id=base.id AND base_attempt.state='succeeded'
    JOIN sloptogether.jobs base_job ON base_job.id=base_attempt.job_id AND base_job.stage='video_base' AND base_job.state='succeeded'
      AND base_job.segment_revision_id=j.segment_revision_id AND base_job.twitch_channel_id=a.twitch_channel_id
    JOIN LATERAL(SELECT ba.decision,ba.input_screen_id FROM sloptogether.artifact_approvals ba
      WHERE ba.asset_id=base.id AND ba.sha256=base.sha256 ORDER BY ba.created_at DESC,ba.id DESC LIMIT 1) base_approval ON base_approval.decision='approved'
    JOIN sloptogether.input_screens base_screen ON base_screen.id=base_approval.input_screen_id
      AND base_screen.twitch_channel_id=a.twitch_channel_id AND base_screen.effective_state='clear'
    WHERE pr.base_asset_id=${baseParameter} AND pr.base_asset_id=j.parent_asset_id AND pr.upscale_job_id=j.id
      AND pr.twitch_channel_id=a.twitch_channel_id AND pr.segment_revision_id=j.segment_revision_id AND pr.state='pending' AND sr.planning_mode='continuation'
      AND pr.deadline_at>now() AND base.status='approved' AND base.sha256=pr.base_sha256 AND j.input_sha256=base.sha256
      AND base_job.input_sha256=sr.input_sha256
      AND base_screen.id=coalesce(NULLIF(base_job.planning_payload->>'inputScreenId','')::uuid,
        (SELECT proposal.input_screen_id FROM sloptogether.proposals proposal WHERE proposal.segment_revision_id=base_job.segment_revision_id AND proposal.input_screen_id IS NOT NULL ORDER BY proposal.created_at DESC LIMIT 1),
        (SELECT plan.screen_id FROM sloptogether.story_plan_attempts plan JOIN sloptogether.segment_revisions rs ON rs.segment_id=plan.resulting_segment_id
          WHERE rs.id=base_job.segment_revision_id AND plan.screen_id IS NOT NULL ORDER BY plan.created_at DESC LIMIT 1))
      AND j.planning_payload->>'inputScreenId'=base_approval.input_screen_id::text AND screen.id=base_approval.input_screen_id
      AND NOT EXISTS(SELECT 1 FROM sloptogether.bans bb WHERE bb.revoked_at IS NULL AND (bb.expires_at IS NULL OR bb.expires_at>now())
        AND (bb.scope='global' OR bb.twitch_channel_id=a.twitch_channel_id)
        AND bb.twitch_user_id IN (base_job.requested_by,coalesce(base.uploaded_by_twitch_user_id,''))))`;
}

async function loadPublishCandidate(pool,assetId,baseAssetId=null){
  const result=await pool.query(`SELECT a.id AS asset_id,a.twitch_channel_id,a.storage_key,a.sha256,a.content_type,a.byte_size,a.duration_seconds,a.status AS asset_status,a.uploaded_by_twitch_user_id,
      ja.id AS attempt_id,ja.state AS attempt_state,ja.fence,ja.funding_id AS attempt_funding_id,j.id AS job_id,j.stream_id,j.stage,j.state AS job_state,j.segment_revision_id,j.interrupt_id,j.requested_by,j.funding_id AS job_funding_id,
      coalesce(nullif(j.planning_payload->>'prompt',''),sr.prompt) AS prompt,sr.input_sha256,sr.planning_mode,
      ir.program_state AS interrupt_state,ir.expires_at AS interrupt_expires_at,se.twitch_actor_id AS interrupt_actor_id,
      s.id AS segment_id,b.stream_id,s.ordinal,s.state AS segment_state,s.selected_revision_id,s.protected_at,c.visibility,c.is_enabled,c.output_width,c.output_height,c.output_fps_num,c.output_fps_den,
      coalesce(nullif(j.planning_payload->>'outputWidth','')::int,c.output_width) AS source_width,
      coalesce(nullif(j.planning_payload->>'outputHeight','')::int,c.output_height) AS source_height,
      EXISTS(SELECT 1 FROM sloptogether.segments prior WHERE prior.branch_id=s.branch_id AND prior.ordinal<s.ordinal AND prior.state<>'retired'
        AND NOT EXISTS(SELECT 1 FROM sloptogether.program_items pi WHERE pi.segment_id=prior.id AND pi.committed_at IS NOT NULL)) AS predecessor_pending,
      approved.input_screen_id,screen.effective_state AS input_state,
      approved.approval_path,approved.trust_policy_revision
    FROM sloptogether.assets a
    JOIN sloptogether.job_attempts ja ON ja.output_asset_id=a.id AND ja.state IN ('validating','succeeded')
    JOIN sloptogether.jobs j ON j.id=ja.job_id AND j.state IN ('validating','succeeded')
    JOIN sloptogether.channels c ON c.twitch_channel_id=a.twitch_channel_id
    JOIN sloptogether.segment_revisions sr ON sr.id=j.segment_revision_id
    JOIN sloptogether.segments s ON s.id=sr.segment_id
    JOIN sloptogether.branches b ON b.id=s.branch_id AND b.twitch_channel_id=s.twitch_channel_id AND b.is_selected AND b.archived_at IS NULL
    LEFT JOIN sloptogether.interrupt_requests ir ON ir.id=j.interrupt_id AND ir.broadcaster_twitch_id=j.twitch_channel_id
    LEFT JOIN sloptogether.subscription_events se ON se.id=ir.trigger_event_id
    JOIN LATERAL(SELECT aa.input_screen_id,aa.approval_path,aa.trust_policy_revision,aa.decision
      FROM sloptogether.artifact_approvals aa WHERE aa.asset_id=a.id AND aa.sha256=a.sha256
      ORDER BY aa.created_at DESC,aa.id DESC LIMIT 1) approved ON approved.decision='approved'
    JOIN sloptogether.input_screens screen ON screen.id=approved.input_screen_id AND screen.twitch_channel_id=a.twitch_channel_id
    WHERE a.id=$1 AND a.media_kind='video' AND a.content_type='video/mp4' AND a.status IN ('approved','published') AND a.sha256 IS NOT NULL
      AND ((j.stage='video_base' AND $2::uuid IS NULL) OR (j.stage='video_upscale' AND $2::uuid IS NOT NULL AND ${approvedPreAirParent("$2")}))
      AND s.selected_revision_id=sr.id
      AND (j.interrupt_id IS NULL OR (ir.program_state='rendering' AND ir.expires_at>now() AND (c.subscriber_interrupt_policy->>'enabled')::boolean=true))
      AND approved.approval_path IN ('human_review','trusted_execution_policy','trusted_uploader_policy','streamer_override')
      AND screen.effective_state='clear'
      AND c.is_enabled AND c.visibility<>'private'
      AND (j.interrupt_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM sloptogether.program_items pi WHERE pi.segment_id=s.id AND pi.committed_at IS NOT NULL))
      AND NOT EXISTS(SELECT 1 FROM sloptogether.bans b WHERE b.revoked_at IS NULL AND (b.expires_at IS NULL OR b.expires_at>now())
        AND (b.scope='global' OR b.twitch_channel_id=a.twitch_channel_id) AND b.twitch_user_id IN (j.requested_by,coalesce(a.uploaded_by_twitch_user_id,''),coalesce(se.twitch_actor_id,'')))
    LIMIT 1`,[assetId,baseAssetId]);
  return result.rows[0]??null;
}

/** Derive a provisional choice; commit rechecks it under channel/segment locks. */
export function classifyPreAirRequest(row){
  if(!row||row.state==="fallback")return {kind:"base"};
  if(row.state!=="pending")return {kind:"base"};
  if(row.binding_valid!==true){
    if(row.expired)return {kind:"invalid_fallback",reason:"binding_invalid"};
    return {kind:"waiting",reason:"binding_invalid"};
  }
  if(row.expired||["failed","cancelled","expired"].includes(row.job_state))return {kind:"fallback",reason:row.expired?"deadline_expired":`upscale_${row.job_state}`};
  if(row.output_banned)return {kind:"fallback",reason:"upscale_banned"};
  if(row.output_approval==="rejected"||row.output_approval==="revoked"||["rejected","retired"].includes(row.output_status))return {kind:"fallback",reason:"upscale_rejected"};
  if(row.output_screen_state&&row.output_screen_state!=="clear")return {kind:"fallback",reason:"upscale_input_held"};
  if(row.job_state==="succeeded"&&row.output_asset_id&&row.output_status==="approved"&&row.output_approval==="approved"&&row.output_screen_state==="clear")
    return {kind:"upscale",assetId:row.output_asset_id};
  return {kind:"waiting"};
}

async function preAirRequest(db,baseAssetId,{lock=false}={}){
  const result=await db.query(`SELECT p.state,p.upscale_job_id,p.deadline_at<=now() AS expired,j.state AS job_state,
      (j.twitch_channel_id=p.twitch_channel_id AND j.parent_asset_id=p.base_asset_id AND j.segment_revision_id=p.segment_revision_id
        AND j.stage='video_upscale' AND j.input_sha256=p.base_sha256 AND (
          (j.recipe_id='sol-h3-upscale-pruna-fast-1184-v1' AND j.recipe_sha256=decode('8bd316e466037db6e4ec4e9b0b3c6b010274020df16c1609e788bb97b8fd6848','hex')
            AND j.planning_payload->>'outputWidth'='1184' AND j.planning_payload->>'outputHeight'='666') OR
          (j.recipe_id='sol-h3-upscale-pruna-fast' AND j.recipe_sha256=decode('e0b4949fbbc02e31b0dc697fc2bedc5a7a1efe57d5d96fe908013d89a3bf8b8c','hex')
            AND j.planning_payload->>'outputWidth'='1920' AND j.planning_payload->>'outputHeight'='1080'))) AS binding_valid,
      finished.output_asset_id,output.status AS output_status,approval.decision AS output_approval,screen.effective_state AS output_screen_state,
      EXISTS(SELECT 1 FROM sloptogether.bans banned WHERE banned.revoked_at IS NULL AND (banned.expires_at IS NULL OR banned.expires_at>now())
        AND (banned.scope='global' OR banned.twitch_channel_id=p.twitch_channel_id)
        AND banned.twitch_user_id IN (j.requested_by,coalesce(output.uploaded_by_twitch_user_id,''))) AS output_banned
    FROM sloptogether.preair_upscale_requests p JOIN sloptogether.jobs j ON j.id=p.upscale_job_id
    LEFT JOIN LATERAL(SELECT ja.output_asset_id FROM sloptogether.job_attempts ja WHERE ja.job_id=j.id AND ja.state='succeeded'
      ORDER BY ja.attempt_number DESC LIMIT 1) finished ON true
    LEFT JOIN sloptogether.assets output ON output.id=finished.output_asset_id AND output.twitch_channel_id=p.twitch_channel_id
    LEFT JOIN LATERAL(SELECT aa.decision,aa.input_screen_id FROM sloptogether.artifact_approvals aa
      WHERE aa.asset_id=output.id AND aa.sha256=output.sha256 ORDER BY aa.created_at DESC,aa.id DESC LIMIT 1) approval ON true
    LEFT JOIN sloptogether.input_screens screen ON screen.id=approval.input_screen_id AND screen.twitch_channel_id=p.twitch_channel_id
    WHERE p.base_asset_id=$1 ${lock?"FOR UPDATE OF p,j":""}`,[baseAssetId]);
  return result.rows[0]??null;
}

async function recordPreAirFallback(client,baseAssetId,request,reason){
  const updated=await client.query("UPDATE sloptogether.preair_upscale_requests SET state='fallback',fallback_reason=$2,resolved_at=now() WHERE base_asset_id=$1 AND state='pending' RETURNING twitch_channel_id",[baseAssetId,reason]);
  if(updated.rowCount)await client.query(`INSERT INTO sloptogether.audit_log(twitch_channel_id,action,target_kind,target_id,after_state)
    VALUES($1,'upscale.preair_fallback','asset',$2,$3::jsonb)`,[updated.rows[0].twitch_channel_id,baseAssetId,JSON.stringify({jobId:request.upscale_job_id,reason})]);
}

async function markPreAirFallback(client,baseAssetId,request,reason){
  await client.query(`UPDATE sloptogether.job_attempts SET state='expired',fence=fence+1,lease_expires_at=now(),finished_at=coalesce(finished_at,now()),error_code='preair_fallback'
    WHERE job_id=$1 AND state IN ('ready','leased','running','uncertain','uploaded','validating')`,[request.upscale_job_id]);
  await client.query(`UPDATE sloptogether.upload_reservations SET state='expired',expires_at=now()
    WHERE attempt_id IN (SELECT id FROM sloptogether.job_attempts WHERE job_id=$1) AND state IN ('issued','uploaded')`,[request.upscale_job_id]);
  await client.query("UPDATE sloptogether.jobs SET state='expired',completed_at=coalesce(completed_at,now()) WHERE id=$1 AND state NOT IN ('succeeded','failed','cancelled','expired')",[request.upscale_job_id]);
  await recordPreAirFallback(client,baseAssetId,request,reason);
}

async function finishStaleBase(pool,message,baseAssetId){
  const identity=await pool.query(`SELECT p.twitch_channel_id,r.segment_id FROM sloptogether.preair_upscale_requests p
    JOIN sloptogether.segment_revisions r ON r.id=p.segment_revision_id WHERE p.base_asset_id=$1 AND p.state='pending'`,[baseAssetId]);
  if(!identity.rows[0])return completeStale(pool,message);
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    await client.query("SELECT twitch_channel_id FROM sloptogether.channels WHERE twitch_channel_id=$1 FOR UPDATE",[identity.rows[0].twitch_channel_id]);
    await client.query("SELECT id FROM sloptogether.segments WHERE id=$1 AND twitch_channel_id=$2 FOR UPDATE",[identity.rows[0].segment_id,identity.rows[0].twitch_channel_id]);
    const lease=await client.query("SELECT id FROM sloptogether.outbox WHERE id=$1 AND delivered_at IS NULL AND leased_until=$2 FOR UPDATE",[message.id,message.leaseUntil]);
    if(!lease.rowCount){await client.query("ROLLBACK");return {status:"stale_lease"};}
    if(await loadPublishCandidate(client,baseAssetId)){
      await client.query("UPDATE sloptogether.outbox SET leased_until=NULL,available_at=now() WHERE id=$1 AND delivered_at IS NULL AND leased_until=$2",[message.id,message.leaseUntil]);
      await client.query("COMMIT");return {status:"retry"};
    }
    const request=await preAirRequest(client,baseAssetId,{lock:true});
    if(request?.state==="pending"){
      if(request.binding_valid===true)await markPreAirFallback(client,baseAssetId,request,"base_no_longer_eligible");
      else await recordPreAirFallback(client,baseAssetId,request,"binding_invalid");
    }
    await client.query("UPDATE sloptogether.outbox SET delivered_at=now(),leased_until=NULL WHERE id=$1 AND delivered_at IS NULL AND leased_until=$2",[message.id,message.leaseUntil]);
    await client.query("COMMIT");return {status:"stale"};
  }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release();}
}

async function completeStale(pool,message){
  await pool.query(`UPDATE sloptogether.outbox SET delivered_at=now(),leased_until=NULL WHERE id=$1 AND delivered_at IS NULL AND leased_until=$2`,[message.id,message.leaseUntil]);
  return {status:"stale"};
}

async function deferUntilPredecessor(pool,message){
  await pool.query(`UPDATE sloptogether.outbox SET leased_until=NULL,available_at=now()+interval '10 seconds'
    WHERE id=$1 AND delivered_at IS NULL AND leased_until=$2`,[message.id,message.leaseUntil]);
  return {status:"waiting_for_predecessor"};
}

async function deferUntilUpscale(pool,message){
  await pool.query(`UPDATE sloptogether.outbox SET leased_until=NULL,available_at=now()+interval '10 seconds'
    WHERE id=$1 AND delivered_at IS NULL AND leased_until=$2`,[message.id,message.leaseUntil]);
  return {status:"waiting_for_upscale"};
}

async function rejectInvalidPublish(pool,message,candidate,error){
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const channelLock=await client.query("SELECT twitch_channel_id FROM sloptogether.channels WHERE twitch_channel_id=$1 AND is_enabled FOR UPDATE",[candidate.twitch_channel_id]);
    if(!channelLock.rowCount){await client.query("ROLLBACK");return completeStale(pool,message)}
    const segmentLock=await client.query(`SELECT s.id FROM sloptogether.segments s JOIN sloptogether.branches b ON b.id=s.branch_id
      WHERE s.id=$1 AND s.twitch_channel_id=$2 AND b.twitch_channel_id=s.twitch_channel_id AND b.is_selected AND b.archived_at IS NULL FOR UPDATE OF s,b`,[candidate.segment_id,candidate.twitch_channel_id]);
    if(!segmentLock.rowCount){await client.query("ROLLBACK");return completeStale(pool,message)}
    const lease=await client.query("SELECT id FROM sloptogether.outbox WHERE id=$1 AND delivered_at IS NULL AND leased_until=$2 FOR UPDATE",[message.id,message.leaseUntil]);
    if(!lease.rowCount){await client.query("ROLLBACK");return {status:"stale_lease"}}
    if(candidate.interrupt_id){
      const code=String(error?.code??"publish_invalid").slice(0,80);
      const current=await client.query(`SELECT a.id,ja.id AS attempt_id,ja.fence,ja.funding_id,j.id AS job_id,ir.funding_id AS interrupt_funding_id,
          ir.trigger_event_id,ir.program_state,c.owner_twitch_user_id
        FROM sloptogether.assets a JOIN sloptogether.job_attempts ja ON ja.output_asset_id=a.id JOIN sloptogether.jobs j ON j.id=ja.job_id
        JOIN sloptogether.interrupt_requests ir ON ir.id=j.interrupt_id AND ir.broadcaster_twitch_id=j.twitch_channel_id
        JOIN sloptogether.channels c ON c.twitch_channel_id=j.twitch_channel_id
        WHERE a.id=$1 AND a.sha256=$2 AND j.id=$3 AND ja.id=$4 AND j.interrupt_id=$5 AND ja.fence=$6
          AND a.status IN ('approved','published') AND ja.state IN ('validating','succeeded') AND j.state IN ('validating','succeeded')
          AND ir.program_state='rendering' AND c.is_enabled AND c.visibility<>'private'
        FOR UPDATE OF a,ja,j,ir,c`,[candidate.asset_id,candidate.sha256,candidate.job_id,candidate.attempt_id,candidate.interrupt_id,candidate.fence]);
      const row=current.rows[0];
      if(!row){await client.query("UPDATE sloptogether.outbox SET delivered_at=now(),leased_until=NULL WHERE id=$1 AND delivered_at IS NULL AND leased_until=$2",[message.id,message.leaseUntil]);await client.query("COMMIT");return {status:"stale"}}
      await client.query("UPDATE sloptogether.assets SET status='rejected' WHERE id=$1 AND sha256=$2 AND status IN ('approved','published')",[candidate.asset_id,candidate.sha256]);
      await client.query("UPDATE sloptogether.artifact_approvals SET decision='revoked',reason=$3 WHERE asset_id=$1 AND sha256=$2 AND decision='approved'",[candidate.asset_id,candidate.sha256,"Subscriber publication validation failed: "+code]);
      await client.query("UPDATE sloptogether.job_attempts SET state='rejected',finished_at=coalesce(finished_at,now()),error_code=$3 WHERE id=$1 AND fence=$2",[candidate.attempt_id,candidate.fence,code]);
      await client.query("UPDATE sloptogether.jobs SET state='failed',completed_at=coalesce(completed_at,now()) WHERE id=$1",[candidate.job_id]);
      await client.query("UPDATE sloptogether.interrupt_requests SET program_state='failed' WHERE id=$1 AND program_state='rendering'",[candidate.interrupt_id]);
      await client.query("UPDATE sloptogether.subscription_events SET state='failed' WHERE id=$1 AND state='rendering'",[row.trigger_event_id]);
      const fundingId=row.interrupt_funding_id??row.funding_id;
      if(fundingId)await client.query("UPDATE sloptogether.funding_authorizations SET state='consumed_failed',consumed_at=coalesce(consumed_at,now()),settled_at=now() WHERE id=$1 AND state IN ('reserved','consumed_uncertain')",[fundingId]);
      await client.query("INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,action,target_kind,target_id,after_state) VALUES($1,$2,'subscriber_interrupt.publication_rejected','asset',$3,$4::jsonb)",
        [candidate.twitch_channel_id,row.owner_twitch_user_id,candidate.asset_id,JSON.stringify({interruptId:candidate.interrupt_id,jobId:candidate.job_id,code})]);
      await client.query("UPDATE sloptogether.outbox SET delivered_at=now(),leased_until=NULL WHERE id=$1 AND delivered_at IS NULL AND leased_until=$2",[message.id,message.leaseUntil]);
      await client.query("COMMIT");return {status:"rejected",code};
    }
    if(candidate.stage==="video_upscale"){
      const request=await preAirRequest(client,candidate.base_asset_id,{lock:true});
      if(request?.state!=="pending"||request.binding_valid!==true){
        await client.query("UPDATE sloptogether.outbox SET leased_until=NULL,available_at=now() WHERE id=$1 AND delivered_at IS NULL AND leased_until=$2",[message.id,message.leaseUntil]);
        await client.query("COMMIT");return {status:"retry"};
      }
      const current=await client.query(`SELECT j.id FROM sloptogether.preair_upscale_requests p
        JOIN sloptogether.jobs j ON j.id=p.upscale_job_id AND j.parent_asset_id=p.base_asset_id
        JOIN sloptogether.job_attempts ja ON ja.job_id=j.id AND ja.output_asset_id=$2
        JOIN sloptogether.assets a ON a.id=ja.output_asset_id AND a.twitch_channel_id=p.twitch_channel_id
        WHERE p.base_asset_id=$1 AND p.state='pending' AND j.id=$3 AND j.state='succeeded'
          AND ja.id=$4 AND ja.fence=$5 AND ja.state='succeeded' AND a.sha256=$6 AND a.status='approved'
        FOR UPDATE OF p,j,ja,a`,[candidate.base_asset_id,candidate.asset_id,candidate.job_id,candidate.attempt_id,candidate.fence,candidate.sha256]);
      if(current.rowCount){
        const code=String(error?.code??"publish_invalid").slice(0,80);
        await client.query("UPDATE sloptogether.assets SET status='rejected' WHERE id=$1 AND sha256=$2 AND status='approved'",[candidate.asset_id,candidate.sha256]);
        await client.query("UPDATE sloptogether.artifact_approvals SET decision='revoked',reason=$3 WHERE asset_id=$1 AND sha256=$2 AND decision='approved'",[candidate.asset_id,candidate.sha256,"Upscale publication validation failed: "+code]);
        await client.query("UPDATE sloptogether.job_attempts SET state='rejected',finished_at=coalesce(finished_at,now()),error_code=$3 WHERE id=$1 AND fence=$2",[candidate.attempt_id,candidate.fence,code]);
        await client.query("UPDATE sloptogether.jobs SET state='failed',completed_at=coalesce(completed_at,now()) WHERE id=$1",[candidate.job_id]);
        await markPreAirFallback(client,candidate.base_asset_id,request,"upscale_publication_invalid");
      }
      // The outbox belongs to the approved base, which must be reconsidered.
      await client.query("UPDATE sloptogether.outbox SET leased_until=NULL,available_at=now() WHERE id=$1 AND delivered_at IS NULL AND leased_until=$2",[message.id,message.leaseUntil]);
      await client.query("COMMIT");return {status:"upscale_fallback"};
    }
    const current=await client.query(`SELECT a.id,a.sha256,a.status,ja.id AS attempt_id,ja.fence,ja.funding_id AS attempt_funding_id,
        j.id AS job_id,j.funding_id AS job_funding_id,j.stage,j.segment_revision_id,s.id AS segment_id,s.selected_revision_id
      FROM sloptogether.assets a JOIN sloptogether.job_attempts ja ON ja.output_asset_id=a.id JOIN sloptogether.jobs j ON j.id=ja.job_id
      JOIN sloptogether.segment_revisions sr ON sr.id=j.segment_revision_id JOIN sloptogether.segments s ON s.id=sr.segment_id
      JOIN LATERAL(SELECT aa.decision,aa.input_screen_id FROM sloptogether.artifact_approvals aa WHERE aa.asset_id=a.id AND aa.sha256=a.sha256
        ORDER BY aa.created_at DESC,aa.id DESC LIMIT 1) approved ON approved.decision='approved'
      JOIN sloptogether.input_screens screen ON screen.id=approved.input_screen_id AND screen.twitch_channel_id=a.twitch_channel_id
      WHERE a.id=$1 AND a.sha256=$2 AND a.status='approved' AND ja.id=$3 AND j.id=$4 AND ja.fence=$5
        AND ja.state IN ('validating','succeeded') AND j.state IN ('validating','succeeded') AND j.stage='video_base'
        AND s.selected_revision_id=sr.id AND screen.effective_state='clear'
        AND s.state NOT IN ('played','retired')
        AND NOT EXISTS(SELECT 1 FROM sloptogether.program_items pi WHERE pi.segment_id=s.id AND pi.committed_at IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM sloptogether.bans b WHERE b.revoked_at IS NULL AND (b.expires_at IS NULL OR b.expires_at>now())
          AND (b.scope='global' OR b.twitch_channel_id=a.twitch_channel_id) AND b.twitch_user_id IN (j.requested_by,coalesce(a.uploaded_by_twitch_user_id,'')))
      FOR UPDATE OF a,ja,j,s,screen`,[candidate.asset_id,candidate.sha256,candidate.attempt_id,candidate.job_id,candidate.fence]);
    const row=current.rows[0];
    if(!row){
      await client.query("UPDATE sloptogether.outbox SET delivered_at=now(),leased_until=NULL WHERE id=$1 AND delivered_at IS NULL AND leased_until=$2",[message.id,message.leaseUntil]);
      await client.query("COMMIT");return {status:"stale"};
    }
    const code=String(error?.code??"publish_invalid").slice(0,80);
    await client.query("UPDATE sloptogether.assets SET status='rejected' WHERE id=$1 AND sha256=$2 AND status='approved'",[candidate.asset_id,candidate.sha256]);
    await client.query("UPDATE sloptogether.artifact_approvals SET decision='revoked',reason=$3 WHERE asset_id=$1 AND sha256=$2 AND decision='approved'",[candidate.asset_id,candidate.sha256,"Publication validation failed: "+code]);
    await client.query("UPDATE sloptogether.job_attempts SET state='rejected',finished_at=coalesce(finished_at,now()),error_code=$3 WHERE id=$1 AND fence=$2",[candidate.attempt_id,candidate.fence,code]);
    await client.query("UPDATE sloptogether.jobs SET state='failed',completed_at=coalesce(completed_at,now()) WHERE id=$1",[candidate.job_id]);
    // The approved video could not be made into a valid live artifact. End this
    // immutable selection and consume its funding; never reopen the old ballot
    // or create an unfunded replacement render from the same payment.
    await client.query("UPDATE sloptogether.segment_revisions SET state='rejected' WHERE id=$1 AND state NOT IN ('played','superseded')",[candidate.segment_revision_id]);
    await client.query("UPDATE sloptogether.proposals SET state='rejected',reviewed_at=now(),review_reason=$2 WHERE segment_revision_id=$1 AND state='selected'",[candidate.segment_revision_id,code]);
    await client.query(`UPDATE sloptogether.elections e SET state='closed',winner_proposal_id=NULL,closed_by=NULL
      WHERE e.segment_id=$1 AND e.state='selected' AND EXISTS(SELECT 1 FROM sloptogether.segments s WHERE s.id=e.segment_id AND s.selected_revision_id=$2 AND s.state NOT IN ('played','retired')
        AND NOT EXISTS(SELECT 1 FROM sloptogether.program_items pi WHERE pi.segment_id=s.id AND pi.committed_at IS NOT NULL))`,[candidate.segment_id,candidate.segment_revision_id]);
    await client.query(`UPDATE sloptogether.segments s SET state='open',selected_revision_id=NULL,protected_at=NULL
      WHERE s.id=$1 AND s.selected_revision_id=$2 AND s.state NOT IN ('played','retired')
        AND NOT EXISTS(SELECT 1 FROM sloptogether.program_items pi WHERE pi.segment_id=s.id AND pi.committed_at IS NOT NULL)`,[candidate.segment_id,candidate.segment_revision_id]);
    const fundingId=candidate.attempt_funding_id??candidate.job_funding_id;
    if(fundingId)await client.query("UPDATE sloptogether.funding_authorizations SET state='consumed_failed',consumed_at=coalesce(consumed_at,now()),settled_at=now() WHERE id=$1 AND state IN ('reserved','consumed_uncertain')",[fundingId]);
    await client.query(`INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,action,target_kind,target_id,after_state)
      VALUES($1,$2,'artifact.publication_rejected','asset',$3,$4::jsonb)`,[candidate.twitch_channel_id,candidate.requested_by,candidate.asset_id,JSON.stringify({jobId:candidate.job_id,code})]);
    await client.query("UPDATE sloptogether.outbox SET delivered_at=now(),leased_until=NULL WHERE id=$1 AND delivered_at IS NULL AND leased_until=$2",[message.id,message.leaseUntil]);
    await client.query("COMMIT");return {status:"rejected",code};
  }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release()}
}

async function commitProgramItem(pool,message,candidate,segments,duration,endpoint){
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const channelLock=await client.query("SELECT twitch_channel_id FROM sloptogether.channels WHERE twitch_channel_id=$1 AND is_enabled AND visibility<>'private' FOR UPDATE",[candidate.twitch_channel_id]);
    if(!channelLock.rowCount){await client.query("ROLLBACK");return completeStale(pool,message)}
    if(candidate.interrupt_id){
      const alert=await client.query(`SELECT ir.program_state,ir.expires_at,(c.subscriber_interrupt_policy->>'enabled')::boolean AS enabled,se.twitch_actor_id
        FROM sloptogether.interrupt_requests ir JOIN sloptogether.channels c ON c.twitch_channel_id=ir.broadcaster_twitch_id
        JOIN sloptogether.subscription_events se ON se.id=ir.trigger_event_id
        WHERE ir.id=$1 AND ir.broadcaster_twitch_id=$2 FOR UPDATE OF ir`,[candidate.interrupt_id,candidate.twitch_channel_id]);
      const row=alert.rows[0];
      const banned=row?.twitch_actor_id?await client.query(`SELECT 1 FROM sloptogether.bans WHERE twitch_user_id=$1 AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at>now()) AND (scope='global' OR twitch_channel_id=$2)`,[row.twitch_actor_id,candidate.twitch_channel_id]):null;
      if(!row||row.program_state!=="rendering"||row.expires_at.getTime()<=Date.now()||!row.enabled||banned?.rowCount){
        await client.query("UPDATE sloptogether.outbox SET delivered_at=now(),leased_until=NULL WHERE id=$1 AND delivered_at IS NULL AND leased_until=$2",[message.id,message.leaseUntil]);
        await client.query("COMMIT");return {status:"stale"};
      }
    }
    const segmentLock=await client.query(`SELECT s.id FROM sloptogether.segments s JOIN sloptogether.branches b ON b.id=s.branch_id
      WHERE s.id=$1 AND s.twitch_channel_id=$2 AND b.twitch_channel_id=s.twitch_channel_id AND b.is_selected AND b.archived_at IS NULL FOR UPDATE OF s,b`,[candidate.segment_id,candidate.twitch_channel_id]);
    if(!segmentLock.rowCount){await client.query("ROLLBACK");return completeStale(pool,message)}
    const lease=await client.query("SELECT id FROM sloptogether.outbox WHERE id=$1 AND delivered_at IS NULL AND leased_until=$2 FOR UPDATE",[message.id,message.leaseUntil]);
    if(!lease.rowCount){await client.query("ROLLBACK");return {status:"stale_lease"}}
    const predecessor=await client.query(`SELECT EXISTS(SELECT 1 FROM sloptogether.segments s
      JOIN sloptogether.branches b ON b.id=s.branch_id AND b.is_selected AND b.archived_at IS NULL
      JOIN sloptogether.segments prior ON prior.branch_id=s.branch_id AND prior.ordinal<s.ordinal AND prior.state<>'retired'
      WHERE s.id=$1 AND NOT EXISTS(SELECT 1 FROM sloptogether.program_items pi WHERE pi.segment_id=prior.id AND pi.committed_at IS NOT NULL)) AS waiting`,[candidate.segment_id]);
    if(predecessor.rows[0]?.waiting){
      await client.query(`UPDATE sloptogether.outbox SET leased_until=NULL,available_at=now()+interval '10 seconds' WHERE id=$1 AND delivered_at IS NULL AND leased_until=$2`,[message.id,message.leaseUntil]);
      await client.query("COMMIT");return {status:"waiting_for_predecessor"};
    }
    const pending=await preAirRequest(client,candidate.base_asset_id,{lock:true});
    let choice=classifyPreAirRequest(pending);
    if(choice.kind==="invalid_fallback"){
      // A corrupted binding might point at another channel's job. Record the
      // bounded fallback without modifying any unverified job or attempt.
      await recordPreAirFallback(client,candidate.base_asset_id,pending,choice.reason);
      choice={kind:"base"};
    }
    if(choice.kind==="fallback"){
      // Fence unfinished attempts before the base can be committed; a late GPU
      // result may not replace already-aired history.
      await markPreAirFallback(client,candidate.base_asset_id,pending,choice.reason);
      choice={kind:"base"};
    }
    if(choice.kind==="waiting"||(choice.kind==="upscale"&&candidate.asset_id!==choice.assetId)
      ||(choice.kind==="base"&&candidate.asset_id!==candidate.base_asset_id)){
      await client.query("UPDATE sloptogether.outbox SET leased_until=NULL,available_at=now()+interval '10 seconds' WHERE id=$1 AND delivered_at IS NULL AND leased_until=$2",[message.id,message.leaseUntil]);
      await client.query("COMMIT");return {status:"waiting_for_upscale"};
    }
    if(candidate.stage==="video_upscale"){
      await client.query(`SELECT base.id FROM sloptogether.assets base
        JOIN sloptogether.job_attempts ba ON ba.output_asset_id=base.id JOIN sloptogether.jobs bj ON bj.id=ba.job_id
        WHERE base.id=$1 AND base.twitch_channel_id=$2 FOR UPDATE OF base,ba,bj`,[candidate.base_asset_id,candidate.twitch_channel_id]);
    }
    const current=await client.query(`SELECT a.id,a.sha256,a.status,j.stage,j.segment_revision_id,j.interrupt_id,j.state AS job_state,ja.id AS attempt_id,ja.state AS attempt_state,ja.fence,
        s.id AS segment_id,s.state AS segment_state,s.selected_revision_id,c.output_width,c.output_height,c.output_fps_num,c.output_fps_den,
        coalesce(nullif(j.planning_payload->>'outputWidth','')::int,c.output_width) AS source_width,
        coalesce(nullif(j.planning_payload->>'outputHeight','')::int,c.output_height) AS source_height,
        ir.program_state AS interrupt_state,ir.expires_at AS interrupt_expires_at,se.twitch_actor_id AS interrupt_actor_id,
        approved.input_screen_id,screen.effective_state,screen.expires_at,approved.approval_path,approved.decision
      FROM sloptogether.assets a JOIN sloptogether.job_attempts ja ON ja.output_asset_id=a.id JOIN sloptogether.jobs j ON j.id=ja.job_id
      JOIN sloptogether.segment_revisions sr ON sr.id=j.segment_revision_id JOIN sloptogether.segments s ON s.id=sr.segment_id
      JOIN sloptogether.channels c ON c.twitch_channel_id=a.twitch_channel_id
      LEFT JOIN sloptogether.interrupt_requests ir ON ir.id=j.interrupt_id AND ir.broadcaster_twitch_id=j.twitch_channel_id
      LEFT JOIN sloptogether.subscription_events se ON se.id=ir.trigger_event_id
      JOIN LATERAL(SELECT aa.input_screen_id,aa.decision,aa.approval_path FROM sloptogether.artifact_approvals aa WHERE aa.asset_id=a.id AND aa.sha256=a.sha256
        ORDER BY aa.created_at DESC,aa.id DESC LIMIT 1) approved ON approved.decision='approved'
      JOIN sloptogether.input_screens screen ON screen.id=approved.input_screen_id AND screen.twitch_channel_id=a.twitch_channel_id
      WHERE a.id=$1 AND a.sha256=$2 AND j.id=$3 AND ja.id=$4 AND j.twitch_channel_id=$5 AND ja.fence=$6
        AND a.status IN ('approved','published') AND ((j.stage='video_base' AND a.id=$7) OR (j.stage='video_upscale' AND ${approvedPreAirParent("$7")})) AND s.selected_revision_id=sr.id
        AND ja.state IN ('validating','succeeded') AND j.state IN ('validating','succeeded')
        AND (j.interrupt_id IS NULL OR (ir.program_state='rendering' AND ir.expires_at>now() AND (c.subscriber_interrupt_policy->>'enabled')::boolean=true))
        AND screen.effective_state='clear'
        AND (j.interrupt_id IS NOT NULL OR s.state NOT IN ('played','retired')) AND c.is_enabled AND c.visibility<>'private'
        AND (j.interrupt_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM sloptogether.program_items pi WHERE pi.segment_id=s.id AND pi.committed_at IS NOT NULL))
        AND NOT EXISTS(SELECT 1 FROM sloptogether.bans b WHERE b.revoked_at IS NULL AND (b.expires_at IS NULL OR b.expires_at>now())
          AND (b.scope='global' OR b.twitch_channel_id=c.twitch_channel_id) AND b.twitch_user_id IN (j.requested_by,coalesce(a.uploaded_by_twitch_user_id,''),coalesce(se.twitch_actor_id,'')))
      FOR UPDATE OF a,ja,j,s,c,screen`,[candidate.asset_id,candidate.sha256,candidate.job_id,candidate.attempt_id,candidate.twitch_channel_id,candidate.fence,candidate.base_asset_id]);
    const row=current.rows[0];
    if(!row){
      if(pending?.state==="pending"){
        await client.query("UPDATE sloptogether.outbox SET leased_until=NULL,available_at=now() WHERE id=$1 AND delivered_at IS NULL AND leased_until=$2",[message.id,message.leaseUntil]);
        await client.query("COMMIT");return {status:"retry"};
      }
      await client.query("UPDATE sloptogether.outbox SET delivered_at=now(),leased_until=NULL WHERE id=$1 AND delivered_at IS NULL AND leased_until=$2",[message.id,message.leaseUntil]);
      await client.query("COMMIT");return {status:"stale"};
    }
    // Packaging happened outside the transaction. Retry with a fresh profile if
    // channel settings or the job's source profile changed during encoding.
    if(["output_width","output_height","output_fps_num","output_fps_den","source_width","source_height"]
      .some(key=>Number(row[key])!==Number(candidate[key]))){
      await client.query("UPDATE sloptogether.outbox SET leased_until=NULL,available_at=now() WHERE id=$1 AND delivered_at IS NULL AND leased_until=$2",[message.id,message.leaseUntil]);
      await client.query("COMMIT");return {status:"profile_changed"};
    }
    await client.query("INSERT INTO sloptogether.program_manifests(twitch_channel_id,stream_id,program_epoch,manifest_revision) VALUES($1,$2,1,0) ON CONFLICT DO NOTHING",[candidate.twitch_channel_id,candidate.stream_id]);
    const manifest=await client.query(
      "SELECT program_epoch,manifest_revision,channel_duration_seconds FROM sloptogether.program_manifests WHERE stream_id=$1 ORDER BY program_epoch DESC LIMIT 1 FOR UPDATE",[candidate.stream_id]);
    const epoch=Number(manifest.rows[0]?.program_epoch??1);
    const order=await client.query("SELECT coalesce(max(item_order),-1)+1 AS item_order FROM sloptogether.program_items WHERE stream_id=$1 AND program_epoch=$2",[candidate.stream_id,epoch]);
    const itemId=randomUUID();
    if(candidate.stage==="video_upscale"){
      const selected=await client.query("UPDATE sloptogether.preair_upscale_requests SET state='selected',selected_asset_id=$2,resolved_at=now() WHERE base_asset_id=$1 AND state='pending' RETURNING base_asset_id",[candidate.base_asset_id,candidate.asset_id]);
      if(!selected.rowCount)throw new Error("preair_selection_changed");
    }
    if(candidate.interrupt_id)await client.query(`INSERT INTO sloptogether.program_items(id,twitch_channel_id,stream_id,item_kind,interrupt_id,asset_id,item_order,source_pts_start,source_pts_end,program_epoch,discontinuity_before,committed_at)
      VALUES($1,$2,$3,'subscriber_interrupt',$4,$5,$6,0,$7,$8,true,now())`,[itemId,candidate.twitch_channel_id,candidate.stream_id,candidate.interrupt_id,candidate.asset_id,order.rows[0].item_order,duration,epoch]);
    else await client.query(`INSERT INTO sloptogether.program_items(id,twitch_channel_id,stream_id,item_kind,segment_id,asset_id,item_order,source_pts_start,source_pts_end,program_epoch,committed_at)
      VALUES($1,$2,$3,'story',$4,$5,$6,0,$7,$8,now())`,[itemId,candidate.twitch_channel_id,candidate.stream_id,candidate.segment_id,candidate.asset_id,order.rows[0].item_order,duration,epoch]);
    let sourceStart=0;
    for(const segment of segments){
      const hlsAssetId=randomUUID();
      await client.query(`INSERT INTO sloptogether.assets(id,twitch_channel_id,storage_key,sha256,media_kind,content_type,byte_size,width,height,fps_num,fps_den,duration_seconds,status,validated_at)
        VALUES($1,$2,$3,$4,'hls_segment','video/mp2t',$5,$6,$7,$8,$9,$10,'published',now())`,
      [hlsAssetId,candidate.twitch_channel_id,segment.key,segment.sha256,segment.byteSize,segment.width,segment.height,segment.fpsNum,segment.fpsDen,segment.durationSeconds]);
      const sourceEnd=sourceStart+segment.durationSeconds;
      await client.query(`INSERT INTO sloptogether.program_media_segments(program_item_id,media_asset_id,media_sequence,duration_seconds,source_pts_start,source_pts_end,sha256)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[itemId,hlsAssetId,segment.sequence,segment.durationSeconds,sourceStart,sourceEnd,segment.sha256]);
      sourceStart=sourceEnd;
    }
    if(endpoint?.frameBytes&&endpoint.digest&&endpoint.promptDigest&&endpoint.imageDigests?.[0]){
      const screenId=randomUUID();const frameAssetId=randomUUID();const boundaryId=randomUUID();
      const clear=endpoint.decision==="clear";
      const automatedState=clear?"clear":endpoint.decision==="held"?"held":"error";
      const effectiveState=clear?"clear":endpoint.decision==="held"?"held":"pending";
      const imageHash=Buffer.from(endpoint.imageDigests[0],"hex");
      await client.query(`INSERT INTO sloptogether.input_screens(id,twitch_channel_id,input_sha256,prompt_sha256,image_sha256s,moderation_model,moderation_policy_revision,
        provider_result_id,category_flags,applied_input_types,automated_state,effective_state,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,1,$7,$8::jsonb,$9::jsonb,$10,$11,now()+interval '1 day')`,[
        screenId,candidate.twitch_channel_id,Buffer.from(endpoint.digest,"hex"),Buffer.from(endpoint.promptDigest,"hex"),endpoint.imageDigests,endpoint.model,endpoint.moderationId??null,
        JSON.stringify(endpoint.categories??{}),JSON.stringify(endpoint.appliedInputTypes??{}),automatedState,effectiveState]);
      await client.query(`INSERT INTO sloptogether.assets(id,twitch_channel_id,storage_key,sha256,media_kind,content_type,byte_size,width,height,status,uploaded_by_twitch_user_id)
        VALUES($1,$2,$3,$4,'image','image/jpeg',$5,$6,$7,$8,$9)`,[
        frameAssetId,candidate.twitch_channel_id,endpoint.storageKey,imageHash,endpoint.byteSize,endpoint.width,endpoint.height,clear?"approved":"quarantine",candidate.uploaded_by_twitch_user_id??candidate.requested_by]);
      await client.query(`INSERT INTO sloptogether.boundary_revisions(id,twitch_channel_id,asset_id,source_revision_id,transformation,created_by,moderation_evidence_id)
        VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)`,[boundaryId,candidate.twitch_channel_id,frameAssetId,candidate.segment_revision_id,
        JSON.stringify({kind:"generated_endpoint_frame",sourceArtifactId:candidate.asset_id,sourceSha256:candidate.sha256.toString("hex"),sourceInputSha256:candidate.input_sha256.toString("hex"),decision:effectiveState}),candidate.uploaded_by_twitch_user_id??candidate.requested_by,screenId]);
      if(clear)await client.query(`INSERT INTO sloptogether.endpoint_resolutions(segment_revision_id,source_artifact_id,source_sha256,source_input_sha256,resolved_end_boundary_revision_id,approval_path)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(segment_revision_id,source_artifact_id) DO NOTHING`,[
        candidate.segment_revision_id,candidate.asset_id,candidate.sha256,candidate.input_sha256,boundaryId,candidate.approval_path]);
      else await client.query(`INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,action,target_kind,target_id,after_state)
        VALUES($1,$2,'endpoint.input_held','input_screen',$3,$4::jsonb)`,[candidate.twitch_channel_id,candidate.requested_by,screenId,JSON.stringify({sourceArtifactId:candidate.asset_id,decision:effectiveState,code:endpoint.unavailableCode??null})]);
    }
    await client.query("UPDATE sloptogether.assets SET status='published' WHERE id=$1 AND sha256=$2 AND status IN ('approved','published')",[candidate.asset_id,candidate.sha256]);
    await client.query("UPDATE sloptogether.job_attempts SET state='succeeded',finished_at=coalesce(finished_at,now()) WHERE id=$1 AND fence=$2 AND state IN ('validating','succeeded')",[candidate.attempt_id,candidate.fence]);
    await client.query("UPDATE sloptogether.jobs SET state='succeeded',completed_at=coalesce(completed_at,now()) WHERE id=$1 AND state IN ('validating','succeeded')",[candidate.job_id]);
    if(!candidate.interrupt_id){
      await client.query("UPDATE sloptogether.segment_revisions SET state='ready' WHERE id=$1 AND state IN ('selected','locked','rendering','ready')",[candidate.segment_revision_id]);
      await client.query("UPDATE sloptogether.segments SET state='ready',source_pts_start=0,source_pts_end=$2 WHERE id=$1 AND selected_revision_id=$3 AND state NOT IN ('played','retired')",[candidate.segment_id,duration,candidate.segment_revision_id]);
    }else{
      await client.query("UPDATE sloptogether.interrupt_requests SET program_state='ready',asset_id=$2 WHERE id=$1 AND program_state='rendering'",[candidate.interrupt_id,candidate.asset_id]);
      await client.query("UPDATE sloptogether.subscription_events SET state='ready' WHERE interrupt_id=$1 AND state='rendering'",[candidate.interrupt_id]);
    }
    const fundingId=candidate.attempt_funding_id??candidate.job_funding_id;
    if(fundingId)await client.query("UPDATE sloptogether.funding_authorizations SET state='consumed_succeeded',consumed_at=coalesce(consumed_at,now()),settled_at=now() WHERE id=$1 AND state IN ('reserved','consumed_uncertain')",[fundingId]);
    await client.query(`UPDATE sloptogether.program_manifests SET manifest_revision=manifest_revision+1,channel_duration_seconds=channel_duration_seconds+$3,updated_at=now()
      WHERE stream_id=$1 AND program_epoch=$2`,[candidate.stream_id,epoch,duration]);
    await client.query("UPDATE sloptogether.channels SET layout_revision=layout_revision+1,updated_at=now() WHERE twitch_channel_id=$1",[candidate.twitch_channel_id]);
    if(!candidate.interrupt_id)await client.query(`INSERT INTO sloptogether.segments(twitch_channel_id,branch_id,ordinal,state)
      SELECT s.twitch_channel_id,s.branch_id,s.ordinal+1,'open' FROM sloptogether.segments s WHERE s.id=$1
      ON CONFLICT(branch_id,ordinal) DO NOTHING`,[candidate.segment_id]);
    await client.query("UPDATE sloptogether.outbox SET delivered_at=now(),leased_until=NULL WHERE id=$1 AND delivered_at IS NULL AND leased_until=$2",[message.id,message.leaseUntil]);
    await client.query("COMMIT");
    return {status:"published",programItemId:itemId,programEpoch:epoch,segmentCount:segments.length};
  }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release()}
}

export async function processPublishRequested({pool,storage,config,message}){
  if(!pool||typeof pool.connect!=="function"||!storage||typeof storage.send!=="function")throw new Error("publish_dependencies_missing");
  let options=requiredConfig(config);
  let payload;
  try{payload=normalizePublishPayload(message?.payload)}catch{return completeStale(pool,message)}
  const base=await loadPublishCandidate(pool,payload.assetId);
  if(!base)return finishStaleBase(pool,message,payload.assetId);
  // Subscriber alerts are short-lived and must not wait on the optional story upscale queue.
  const interrupt=Boolean(base.interrupt_id);
  if(interrupt)options={...options,minDurationSeconds:9.5,maxDurationSeconds:10.5};
  const choice=interrupt?{kind:"base"}:classifyPreAirRequest(await preAirRequest(pool,payload.assetId));
  if(choice.kind==="waiting")return deferUntilUpscale(pool,message);
  const candidate=choice.kind==="upscale"?await loadPublishCandidate(pool,choice.assetId,payload.assetId):base;
  // A revoked or held derivative is never substituted; wait until its bounded
  // deadline so the transaction below can fence it before publishing the base.
  if(!candidate)return deferUntilUpscale(pool,message);
  candidate.base_asset_id=payload.assetId;
  if(!candidate.sha256||!candidate.storage_key||!candidate.segment_id||!candidate.segment_revision_id)
    return completeStale(pool,message);
  if(candidate.predecessor_pending)return deferUntilPredecessor(pool,message);
  let profile,sourceProfile;
  try{
    profile=validateHlsProfile({width:candidate.output_width,height:candidate.output_height,fpsNum:candidate.output_fps_num,fpsDen:candidate.output_fps_den},{segmentSeconds:options.segmentSeconds});
    sourceProfile=validateHlsProfile({width:candidate.source_width,height:candidate.source_height,fpsNum:candidate.output_fps_num,fpsDen:candidate.output_fps_den},{segmentSeconds:options.segmentSeconds});
  }
  catch(error){if(error instanceof InvalidPublishError)return rejectInvalidPublish(pool,message,candidate,error);throw error;}
  const directory=await mkdtemp(join(options.tempDir,"sloptogether-publish-"));
  try{
    const inputPath=join(directory,"approved.mp4");
    const source=await downloadObject(storage,options.bucket,candidate.storage_key,inputPath,options.maxBytes);
    if(!source.sha256.equals(candidate.sha256))throw new InvalidPublishError("publish_sha256_mismatch");
    const probe=await runFfprobe(options.ffprobe,inputPath);
    const metadata=validateMediaMetadata(probe,sourceProfile,source.bytes,{maxBytes:options.maxBytes,minDurationSeconds:options.minDurationSeconds,maxDurationSeconds:options.maxDurationSeconds});
    if(Math.abs(metadata.durationSeconds-Number(candidate.duration_seconds))>0.25)throw new InvalidPublishError("publish_duration_changed");
    await decodeEntireFile(options.ffmpeg,inputPath,options);
    let endpoint=null;
    if(!candidate.interrupt_id&&candidate.planning_mode==="continuation"){
      endpoint=await extractAndScreenEndpoint({videoPath:inputPath,prompt:candidate.prompt,config:{ffmpeg:options.ffmpeg,ffprobe:options.ffprobe,tempDir:options.tempDir},apiKey:options.openAiKey});
      requireEndpointFrame(endpoint);
      endpoint.storageKey=`private/${candidate.twitch_channel_id}/endpoints/${candidate.asset_id}/${endpoint.imageDigests[0]}.jpg`;
      await storage.send(new PutObjectCommand({Bucket:options.bucket,Key:endpoint.storageKey,Body:endpoint.frameBytes,ContentType:"image/jpeg"}));
    }
    const packaged=await packageHls(options.ffmpeg,inputPath,directory,profile,options);
    const segments=await uploadSegments(storage,options.bucket,candidate.twitch_channel_id,candidate.asset_id,directory,packaged.segments,profile,options.maxBytes);
    return await commitProgramItem(pool,message,candidate,segments,packaged.totalDurationSeconds,endpoint);
  }catch(error){
    if(error instanceof InvalidPublishError||error instanceof InvalidMediaError)return await rejectInvalidPublish(pool,message,candidate,error);
    throw error;
  }finally{await rm(directory,{recursive:true,force:true}).catch(()=>undefined)}
}
