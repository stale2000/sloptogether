import { createHash, createHmac, randomUUID } from "node:crypto";
import { compileH3StoryPrompt, jobInputSchema, type StoryProposal, type WorkerKeyScope } from "@sloptogether/contracts";
import { ApiError, assertSameOrigin, readJson } from "./http";
import { query, transaction } from "./db";
import { currentSession } from "./session";
import { requestPrincipal, requireKeyScope, type WorkerGrant } from "./principals";
import { canContribute, findChannel, isBanned, requireStreamerController, type ChannelRow } from "./channels";
import { getModeratedChannelIds } from "./twitch-subs";
import { hmacKeySecret, randomSecret, signUploadTicket } from "./crypto";
import { signedPrivateReadUrl } from "./storage";
import { screenPromptAndImages, type InputPreflightResult } from "./preflight";
import { trustedProxyClientIp } from "./proxy-client-ip";
import { abandonStoryProducerPlans } from "./worker-revocation";
import { reservationUsd } from "./reservation";
import { z } from "zod";
import type { PoolClient } from "pg";

const pairingRequest = z.object({
  installationId:z.string().uuid(), displayName:z.string().trim().min(1).max(100),
  platform:z.enum(["windows","wsl","linux"]), roles:z.array(z.enum(["generation","upscale"])).min(1).max(2),
  clientVersion:z.string().max(40).optional(),
}).strict();

async function ownerAttemptBudgetBlock(client:PoolClient,channelId:string,cap:string){
  const quote=reservationUsd("SLOPTOGETHER_GENERATION_ATTEMPT_RESERVATION_USD");
  if(quote===null||Number(cap)<=0)return "owner_generation_budget_unavailable";
  const spent=await client.query<{total:string}>(`SELECT coalesce(sum(greatest(reserved_usd,coalesce(actual_cost_usd,0))),0)::text AS total
    FROM sloptogether.funding_authorizations WHERE twitch_channel_id=$1 AND source='owner_budget' AND state<>'released'`,[channelId]);
  return Number(spent.rows[0]?.total??0)+quote>Number(cap) ? "owner_generation_budget_exhausted" : null;
}

const UPSCALE_RECIPE="sol-h3-upscale-pruna-fast";
const UPSCALE_RECIPE_SHA256="e0b4949fbbc02e31b0dc697fc2bedc5a7a1efe57d5d96fe908013d89a3bf8b8c";
const UPSCALE_OUTPUT_WIDTH=1920;
const UPSCALE_OUTPUT_HEIGHT=1080;

export async function requestClipUpscale(locator:string,request:Request){
  assertSameOrigin(request);
  const channel=await findChannel(locator);const principal=await requestPrincipal(request);
  const actor=await requireStreamerController(channel,principal);
  if(await isBanned(channel.twitch_channel_id,actor))throw new ApiError(403,"channel_ban_active");
  const body=await readJson(request,z.object({programItemId:z.string().uuid()}).strict());
  return transaction(async client=>{
    const locked=await client.query("SELECT twitch_channel_id FROM sloptogether.channels WHERE twitch_channel_id=$1 AND is_enabled FOR UPDATE",[channel.twitch_channel_id]);
    if(!locked.rowCount)throw new ApiError(404,"channel_not_found");
    const source=await client.query<{asset_id:string;segment_revision_id:string;prompt:string;sha256:Buffer;screen_id:string;width:number;height:number}>(
      `SELECT a.id AS asset_id,sr.id AS segment_revision_id,sr.prompt,a.sha256,aa.input_screen_id AS screen_id,a.width,a.height
       FROM sloptogether.program_items pi JOIN sloptogether.assets a ON a.id=pi.asset_id
       JOIN sloptogether.segments s ON s.id=pi.segment_id
       JOIN sloptogether.segment_revisions sr ON sr.id=s.selected_revision_id
       JOIN LATERAL(SELECT input_screen_id,decision FROM sloptogether.artifact_approvals aa
         WHERE aa.asset_id=a.id AND aa.sha256=a.sha256 ORDER BY aa.created_at DESC,aa.id DESC LIMIT 1) aa ON aa.decision='approved'
       JOIN sloptogether.input_screens i ON i.id=aa.input_screen_id AND i.twitch_channel_id=a.twitch_channel_id
         AND i.effective_state='clear' AND (i.expires_at IS NULL OR i.expires_at>now())
       WHERE pi.id=$1 AND pi.twitch_channel_id=$2 AND pi.item_kind='story' AND pi.committed_at IS NOT NULL
         AND a.status='published' AND a.sha256 IS NOT NULL AND a.media_kind='video'`,[body.programItemId,channel.twitch_channel_id]);
    const item=source.rows[0];if(!item)throw new ApiError(404,"approved_story_clip_not_found");
    if(item.width>=UPSCALE_OUTPUT_WIDTH||item.height>=UPSCALE_OUTPUT_HEIGHT)throw new ApiError(409,"clip_already_at_upscale_target","The approved upscale profile cannot enlarge this clip further.");
    const existing=await client.query<{id:string;state:string}>(`SELECT id,state FROM sloptogether.jobs
      WHERE twitch_channel_id=$1 AND stage='video_upscale' AND parent_asset_id=$2 AND state NOT IN ('failed','cancelled','expired')
      ORDER BY created_at DESC LIMIT 1`,[channel.twitch_channel_id,item.asset_id]);
    if(existing.rows[0])return {accepted:true,jobId:existing.rows[0].id,state:existing.rows[0].state,existing:true};
    const jobId=randomUUID(),attemptId=randomUUID();
    await client.query(`INSERT INTO sloptogether.jobs(id,twitch_channel_id,segment_revision_id,stage,execution_mode,state,recipe_id,recipe_sha256,input_sha256,requested_by,parent_asset_id,planning_payload,result_deadline_at)
      VALUES($1,$2,$3,'video_upscale','pull_worker','ready',$4,$5,$6,$7,$8,$9::jsonb,now()+interval '24 hours')`,
      [jobId,channel.twitch_channel_id,item.segment_revision_id,UPSCALE_RECIPE,Buffer.from(UPSCALE_RECIPE_SHA256,"hex"),item.sha256,actor,item.asset_id,JSON.stringify({inputScreenId:item.screen_id,outputWidth:UPSCALE_OUTPUT_WIDTH,outputHeight:UPSCALE_OUTPUT_HEIGHT})]);
    await client.query(`INSERT INTO sloptogether.job_attempts(id,job_id,attempt_number,fence,client_idempotency_key,state,attempt_deadline_at,input_sha256)
      VALUES($1,$2,1,1,$3,'ready',now()+interval '24 hours',$4)`,[attemptId,jobId,`job:${jobId}:attempt:1`,item.sha256]);
    await client.query("INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,action,target_kind,target_id,after_state) VALUES($1,$2,'upscale.requested','asset',$3,$4::jsonb)",
      [channel.twitch_channel_id,actor,item.asset_id,JSON.stringify({jobId,programItemId:body.programItemId,recipeId:UPSCALE_RECIPE})]);
    return {accepted:true,jobId,state:"ready",existing:false};
  });
}

function digest(value:string){return createHash("sha256").update(value).digest();}
function workerSecret(pairingId:string,pollSecret:string){
  const pepper=process.env.SLOPTOGETHER_KEY_HASH_PEPPER;
  if(!pepper||pepper.length<32)throw new ApiError(503,"worker_pairing_not_configured");
  return createHmac("sha256",pepper).update("worker-pair\0").update(pairingId).update("\0").update(pollSecret).digest("base64url");
}
function pairingCode(){
  const alphabet="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";const bytes=Buffer.from(randomSecret(12),"base64url");
  return [...bytes.subarray(0,8)].map(value=>alphabet[value%alphabet.length]).join("").replace(/(.{4})/,"$1-");
}

async function readApprovedBoundaryImage(channelId:string,boundaryId:string){
  const result=await query<{storage_key:string;content_type:string|null;byte_size:string|null;sha256:Buffer|null}>(`SELECT a.storage_key,a.content_type,a.byte_size,a.sha256
    FROM sloptogether.boundary_revisions b JOIN sloptogether.assets a ON a.id=b.asset_id
    WHERE b.id=$1 AND b.twitch_channel_id=$2 AND b.retired_at IS NULL AND a.status IN ('approved','published') AND a.media_kind='image'`,[boundaryId,channelId]);
  const row=result.rows[0];
  if(!row?.content_type||!["image/png","image/jpeg","image/webp"].includes(row.content_type))throw new ApiError(409,"story_start_boundary_not_approved");
  if(row.byte_size&&Number(row.byte_size)>16*1024*1024)throw new ApiError(413,"story_start_boundary_too_large");
  const response=await fetch(await signedPrivateReadUrl(row.storage_key,60),{cache:"no-store",signal:AbortSignal.timeout(8000)});
  if(!response.ok||!response.body)throw new ApiError(503,"story_start_boundary_unavailable");
  const reader=response.body.getReader();const chunks:Buffer[]=[];const digest=createHash("sha256");let length=0;
  try{for(;;){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>16*1024*1024){await reader.cancel();throw new ApiError(413,"story_start_boundary_too_large");}const bytes=Buffer.from(part.value);chunks.push(bytes);digest.update(bytes)}}finally{reader.releaseLock()}
  const bytes=Buffer.concat(chunks);
  if(!bytes.length||row.sha256&&!digest.digest().equals(row.sha256))throw new ApiError(409,"story_start_boundary_changed");
  return {bytes,contentType:row.content_type};
}

export async function createPairing(request:Request){
  const body=await readJson(request,pairingRequest);const id=randomUUID();const code=pairingCode();const pollSecret=randomSecret(32);
  const expiresAt=new Date(Date.now()+10*60_000);
  const sourceIp=trustedProxyClientIp(request)??"untrusted-proxy";
  const ipHash=digest(sourceIp.slice(0,128));
  await transaction(async client=>{
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('worker-pair-create',0))");
    const recent=await client.query<{n:string}>("SELECT count(*)::text AS n FROM sloptogether.worker_pairings WHERE request_ip_hash=$1 AND created_at>now()-interval '10 minutes'",[ipHash]);
    const active=await client.query<{n:string}>("SELECT count(*)::text AS n FROM sloptogether.worker_pairings WHERE approved_at IS NULL AND expires_at>now()");
    const install=await client.query<{n:string}>("SELECT count(*)::text AS n FROM sloptogether.worker_pairings WHERE requested_device->>'installationId'=$1 AND approved_at IS NULL AND expires_at>now()",[body.installationId]);
    if(Number(recent.rows[0]?.n??0)>=30||Number(active.rows[0]?.n??0)>=500)throw new ApiError(429,"pairing_rate_limited");
    if(Number(install.rows[0]?.n??0)>0)throw new ApiError(409,"pairing_already_pending");
    await client.query("DELETE FROM sloptogether.worker_pairings WHERE approved_at IS NULL AND expires_at<now()-interval '1 day'");
    await client.query("INSERT INTO sloptogether.worker_pairings(id,pairing_code_hash,polling_secret_hash,requested_device,requested_roles,expires_at,request_ip_hash) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7)",[
      id,hmacKeySecret("pair-code:"+code),digest(pollSecret),JSON.stringify({installationId:body.installationId,displayName:body.displayName,platform:body.platform,clientVersion:body.clientVersion??""}),body.roles,expiresAt,ipHash,
    ]);
  });
  const base=(process.env.PUBLIC_APP_URL??"https://www.clips.gg/sloptogether").replace(/\/$/,"");
  return {pairingId:id,pollSecret,userCode:code,verificationUri:`${base}/worker-pairing?pair=${encodeURIComponent(id)}`,expiresAt:expiresAt.toISOString()};
}

export async function approvePairing(pairingId:string,request:Request){
  assertSameOrigin(request);const session=await currentSession(request);if(!session)throw new ApiError(401,"login_required");
  const body=await readJson(request,z.object({code:z.string().trim().min(8).max(12),channelId:z.string().min(1).max(32)}).strict());
  const channel=await findChannel(body.channelId);const principal={kind:"session" as const,session};const actor=session.twitchUserId;
  if(await isBanned(channel.twitch_channel_id,actor))throw new ApiError(403,"channel_ban_active");
  if(!await canContribute(channel,principal))throw new ApiError(403,"contribution_not_allowed");
    const isBroadcaster=actor===channel.owner_twitch_user_id;
    const isModerator=!isBroadcaster&&session.scopes.includes("user:read:moderated_channels")
      ?(await getModeratedChannelIds(session.accessToken,actor)).has(channel.twitch_channel_id):false;
  return transaction(async client=>{
    const result=await client.query<{id:string;pairing_code_hash:Buffer;requested_roles:string[];expires_at:Date;approved_at:Date|null;requested_device:Record<string,unknown>}>(
      "SELECT id,pairing_code_hash,requested_roles,expires_at,approved_at,requested_device FROM sloptogether.worker_pairings WHERE id=$1 FOR UPDATE",[pairingId]);
    const row=result.rows[0];if(!row||row.expires_at.getTime()<=Date.now())throw new ApiError(404,"pairing_expired");
    if(!hmacKeySecret("pair-code:"+body.code).equals(row.pairing_code_hash))throw new ApiError(403,"pairing_code_invalid");
    if(row.approved_at)throw new ApiError(409,"pairing_already_approved");
    if(row.requested_roles.includes("story-producer")&&actor!==channel.owner_twitch_user_id)throw new ApiError(403,"story_producer_requires_broadcaster");
    const scopes:WorkerKeyScope[]=[];
    if(row.requested_roles.includes("generation"))scopes.push("worker:generation");
    if(row.requested_roles.includes("upscale"))scopes.push("worker:upscale");
    if(row.requested_roles.includes("story-producer"))scopes.push("story:write_future");
    const device=await client.query<{id:string}>(
      "INSERT INTO sloptogether.worker_devices(twitch_user_id,display_name,platform,roles,status) VALUES($1,$2,$3,$4,'paired') RETURNING id",
      [actor,String(row.requested_device.displayName??"Worker"),String(row.requested_device.platform??"windows"),row.requested_roles]);
    await client.query("UPDATE sloptogether.worker_pairings SET approved_by_twitch_user_id=$2,twitch_channel_id=$3,approved_at=now(),credential_hash=$4 WHERE id=$1",
      [pairingId,actor,channel.twitch_channel_id,digest(String(device.rows[0]!.id))]);
    if(isBroadcaster||isModerator)await client.query(`INSERT INTO sloptogether.memberships(twitch_user_id,twitch_channel_id,role,status)
      VALUES($1,$2,$3,'active') ON CONFLICT(twitch_user_id,twitch_channel_id) DO UPDATE SET role=EXCLUDED.role,status='active',checked_at=now()`,[actor,channel.twitch_channel_id,isBroadcaster?"broadcaster":"moderator"]);
    await client.query("INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,action,target_kind,target_id,after_state) VALUES($1,$2,'worker.pairing.approve','worker_pairing',$3,$4::jsonb)",
      [channel.twitch_channel_id,actor,pairingId,JSON.stringify({roles:row.requested_roles,deviceId:device.rows[0]!.id})]);
    return {pairingId,status:"approved",roles:row.requested_roles};
  });
}

export async function pollPairing(pairingId:string,request:Request){
  const body=await readJson(request,z.object({pollSecret:z.string().min(32).max(128)}).strict());
  return transaction(async client=>{
    const result=await client.query<{id:string;polling_secret_hash:Buffer;expires_at:Date;approved_at:Date|null;twitch_channel_id:string|null;approved_by_twitch_user_id:string|null;requested_device:Record<string,unknown>;requested_roles:string[];credential_hash:Buffer|null}>(
      "SELECT id,polling_secret_hash,expires_at,approved_at,twitch_channel_id,approved_by_twitch_user_id,requested_device,requested_roles,credential_hash FROM sloptogether.worker_pairings WHERE id=$1 FOR UPDATE",[pairingId]);
    const pair=result.rows[0];if(!pair||pair.expires_at.getTime()<=Date.now())return {status:"expired"};
    if(!digest(body.pollSecret).equals(pair.polling_secret_hash))throw new ApiError(403,"pairing_poll_secret_invalid");
    if(!pair.approved_at||!pair.twitch_channel_id||!pair.approved_by_twitch_user_id)return {status:"pending"};
    const scopes:WorkerKeyScope[]=[];
    if(pair.requested_roles.includes("generation"))scopes.push("worker:generation");
    if(pair.requested_roles.includes("upscale"))scopes.push("worker:upscale");
    if(pair.requested_roles.includes("story-producer"))scopes.push("story:write_future");
    const secret=workerSecret(pairingId,body.pollSecret);const key=`slw_${pairingId}.${secret}`;const storedHash=hmacKeySecret(key);
    await client.query(
      "INSERT INTO sloptogether.application_keys(key_id,secret_hash,key_prefix,issuing_twitch_user_id,twitch_channel_id,display_name,scopes,worker_roles) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(key_id) DO NOTHING",
      [pairingId,storedHash,`slw_${pairingId}`,pair.approved_by_twitch_user_id,pair.twitch_channel_id,String(pair.requested_device.displayName??"Paired worker"),scopes,pair.requested_roles]);
    for(const role of pair.requested_roles){
      const executionRole=role==="story-producer"?"story_producer":role;
      await client.query(`INSERT INTO sloptogether.trusted_executions(twitch_channel_id,key_id,issuer_twitch_user_id,execution_role,recipe_ids,policy_revision)
        SELECT $1,$2,$3,$4,$5,c.policy_revision FROM sloptogether.channels c WHERE c.twitch_channel_id=$1
        ON CONFLICT DO NOTHING`,[pair.twitch_channel_id,pairingId,pair.approved_by_twitch_user_id,executionRole,[]]);
    }
    const valid=await client.query("SELECT 1 FROM sloptogether.application_keys WHERE key_id=$1 AND secret_hash=$2 AND revoked_at IS NULL",[pairingId,storedHash]);
    if(!valid.rowCount)throw new ApiError(401,"worker_key_revoked");
    return {status:"approved",workerKey:key};
  });
}

async function requireWorker(request:Request,scope:string):Promise<WorkerGrant>{
  const principal=await requestPrincipal(request);
  if(!principal||principal.kind!=="worker-key")throw new ApiError(401,"worker_key_required");
  requireKeyScope(principal.worker,scope);return principal.worker;
}

async function resolveExpiredElections(client:import("pg").PoolClient,channelId:string){
  const elections=await client.query<{id:string;segment_id:string}>(`SELECT e.id,e.segment_id FROM sloptogether.elections e
    JOIN sloptogether.segments s ON s.id=e.segment_id WHERE s.twitch_channel_id=$1 AND s.protected_at IS NULL
      AND s.state IN ('open','voting','selected') AND e.state='open' AND e.closes_at<=now()
    ORDER BY e.closes_at LIMIT 10 FOR UPDATE OF e,s SKIP LOCKED`,[channelId]);
  for(const election of elections.rows){
    const winner=await client.query<{proposal_id:string;revision_id:string;author_id:string;prompt:string;start_boundary_id:string;end_boundary_id:string|null;planning_mode:string;recipe_id:string;input_sha256:Buffer;input_screen_id:string}>(
      `SELECT p.id AS proposal_id,p.segment_revision_id AS revision_id,p.author_twitch_user_id AS author_id,
        r.prompt,r.start_boundary_revision_id AS start_boundary_id,r.requested_end_boundary_revision_id AS end_boundary_id,
        r.planning_mode,r.provider_recipe_id AS recipe_id,r.input_sha256,p.input_screen_id
       FROM sloptogether.proposals p JOIN sloptogether.segment_revisions r ON r.id=p.segment_revision_id
       JOIN sloptogether.input_screens i ON i.id=p.input_screen_id AND i.effective_state='clear' AND (i.expires_at IS NULL OR i.expires_at>now())
       WHERE p.election_id=$1 AND p.state='eligible'
         AND NOT EXISTS(SELECT 1 FROM sloptogether.bans b WHERE b.twitch_user_id=p.author_twitch_user_id AND b.revoked_at IS NULL
           AND (b.expires_at IS NULL OR b.expires_at>now()) AND (b.scope='global' OR b.twitch_channel_id=$2))
       ORDER BY (SELECT count(*) FROM sloptogether.ballots b WHERE b.election_id=p.election_id AND b.proposal_id=p.id) DESC,p.created_at,p.id LIMIT 1`,
      [election.id,channelId]);
    const selected=winner.rows[0];
    if(!selected){
      await client.query("UPDATE sloptogether.elections SET state='closed' WHERE id=$1 AND state='open'",[election.id]);
      await client.query("UPDATE sloptogether.segments SET state='open' WHERE id=$1 AND state='voting' AND selected_revision_id IS NULL",[election.segment_id]);
      continue;
    }
    await client.query("UPDATE sloptogether.elections SET state='selected',winner_proposal_id=$2 WHERE id=$1",[election.id,selected.proposal_id]);
    await client.query("UPDATE sloptogether.proposals SET state=CASE WHEN id=$2 THEN 'selected' WHEN state='eligible' THEN 'superseded' ELSE state END WHERE election_id=$1",[election.id,selected.proposal_id]);
    await client.query("UPDATE sloptogether.segment_revisions SET state='selected' WHERE id=$1 AND state IN ('proposal','selected')",[selected.revision_id]);
    const requiresEnd=selected.planning_mode==='planned_anchors';
    const canGenerate=Boolean(selected.start_boundary_id)&&(!requiresEnd||Boolean(selected.end_boundary_id));
    const boundaryAssets=canGenerate?await client.query(`SELECT 1 FROM sloptogether.boundary_revisions a
      JOIN sloptogether.assets aa ON aa.id=a.asset_id AND aa.status IN ('approved','published') AND aa.media_kind='image'
      WHERE a.id=$1 AND a.twitch_channel_id=$3 AND a.retired_at IS NULL
        AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM sloptogether.boundary_revisions b JOIN sloptogether.assets ba ON ba.id=b.asset_id
          WHERE b.id=$2 AND b.twitch_channel_id=$3 AND b.retired_at IS NULL AND ba.status IN ('approved','published') AND ba.media_kind='image'))`,
      [selected.start_boundary_id,requiresEnd?selected.end_boundary_id:null,channelId]):null;
    let jobId:string|null=null;
    if(boundaryAssets?.rowCount){
      const dependency=await client.query<{id:string}>("SELECT id FROM sloptogether.endpoint_resolutions WHERE resolved_end_boundary_revision_id=$1 AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1",[selected.start_boundary_id]);
      const existing=await client.query<{id:string}>("SELECT id FROM sloptogether.jobs WHERE segment_revision_id=$1 AND stage='video_base' AND state NOT IN ('failed','cancelled','expired') LIMIT 1",[selected.revision_id]);
      if(!existing.rows[0]){
        jobId=randomUUID();const attemptId=randomUUID();
        await client.query(`INSERT INTO sloptogether.jobs(id,twitch_channel_id,segment_revision_id,stage,execution_mode,state,recipe_id,recipe_sha256,input_sha256,requested_by,dependency_resolution_id,planning_payload,result_deadline_at)
          VALUES($1,$2,$3,'video_base','pull_worker','ready',$4,$5,$6,$7,$8,$9::jsonb,now()+interval '45 minutes')`,
          [jobId,channelId,selected.revision_id,selected.recipe_id,Buffer.from("9a2d5d19fb22b7e55d29c8e6048c4c421c5b73b044b7cc010188efe7df9ccaef","hex"),selected.input_sha256,selected.author_id,dependency.rows[0]?.id??null,JSON.stringify({inputScreenId:selected.input_screen_id})]);
        if(dependency.rows[0])await client.query("INSERT INTO sloptogether.endpoint_resolution_dependencies(resolution_id,dependent_job_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[dependency.rows[0].id,jobId]);
        await client.query(`INSERT INTO sloptogether.job_attempts(id,job_id,attempt_number,fence,client_idempotency_key,state,attempt_deadline_at,input_sha256)
          VALUES($1,$2,1,1,$3,'ready',now()+interval '45 minutes',$4)`,[attemptId,jobId,`job:${jobId}:attempt:1`,selected.input_sha256]);
      }else jobId=existing.rows[0].id;
    }
    await client.query("UPDATE sloptogether.segments SET selected_revision_id=$2,state=$3,protected_at=coalesce(protected_at,now()) WHERE id=$1 AND state NOT IN ('played','retired')",
      [election.segment_id,selected.revision_id,jobId?"rendering":"selected"]);
    await client.query("UPDATE sloptogether.channels SET layout_revision=layout_revision+1,updated_at=now() WHERE twitch_channel_id=$1",[channelId]);
    await client.query(`INSERT INTO sloptogether.audit_log(twitch_channel_id,action,target_kind,target_id,after_state)
      VALUES($1,'election.resolve','election',$2,$3::jsonb)`,[channelId,election.id,JSON.stringify({winnerProposalId:selected.proposal_id,revisionId:selected.revision_id,jobId,dispatchReady:Boolean(jobId)})]);
  }
}

export async function exchangeWorkerSession(request:Request){
  const worker=await requireWorker(request,"worker:generation");
  return {channelId:worker.channelId,issuingTwitchUserId:worker.issuingTwitchUserId,scopes:worker.scopes,roles:worker.roles};
}

export async function claimWorkerLease(request:Request){
  const url=new URL(request.url);const role=url.searchParams.get("role")??"generation";
  if(role!=="generation"&&role!=="upscale")throw new ApiError(400,"worker_role_invalid");
  const grant=await requireWorker(request,`worker:${role}`);
  if(grant.paired&&grant.platform==="windows")
    throw new ApiError(409,"worker_platform_unqualified","This paired Windows inference runtime is not qualified yet.");
  const grantChannel=await findChannel(grant.channelId);
  if(grant.paired&&!await canContribute(grantChannel,{kind:"worker-key",worker:grant}))throw new ApiError(403,"contribution_not_allowed");
  return transaction(async client=>{
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["worker-active:"+grant.issuingTwitchUserId]);
    // Election resolution also updates the channel row. Take the exclusive lock
    // before locking elections so concurrent claimers cannot deadlock while
    // trying to upgrade shared channel locks later in the transaction.
    const currentPolicy=await client.query<{policy_revision:number}>("SELECT policy_revision FROM sloptogether.channels WHERE twitch_channel_id=$1 AND is_enabled FOR UPDATE",[grant.channelId]);
    if(currentPolicy.rows[0]?.policy_revision!==grantChannel.policy_revision)throw new ApiError(409,"channel_policy_changed");
    // Serialize admission with revokeWorkerKey, which revokes this row before
    // fencing its attempts; otherwise an uncommitted lease can escape its sweep.
    const bindings=await client.query("SELECT id FROM sloptogether.trusted_executions WHERE twitch_channel_id=$1 AND key_id=$2 AND execution_role=$3 AND revoked_at IS NULL ORDER BY id FOR UPDATE",
      [grant.channelId,grant.keyId,role]);
    if(!bindings.rowCount)return {status:"empty"};
    await expireWorkerLeases(client,grant.channelId);
    if(role==="generation")await resolveExpiredElections(client,grant.channelId);
    const active=await client.query<{count:string}>(`SELECT count(*)::text AS count FROM sloptogether.job_attempts a
      JOIN sloptogether.trusted_executions te ON te.id=a.execution_binding_id
      JOIN sloptogether.jobs j ON j.id=a.job_id
      WHERE te.issuer_twitch_user_id=$1 AND a.state IN ('leased','running','uploaded','validating')
        AND a.lease_expires_at>now() AND a.attempt_deadline_at>now()`,[grant.issuingTwitchUserId]);
    if(Number(active.rows[0]?.count??0)>=2)return {status:"empty"};
    const result=await client.query<{id:string;twitch_channel_id:string;segment_revision_id:string|null;interrupt_id:string|null;stage:string;recipe_id:string;recipe_sha256:Buffer;input_sha256:Buffer;planning_payload:Record<string,unknown>;prompt:string|null;start_boundary_revision_id:string|null;start_frame_asset_id:string|null;end_boundary_revision_id:string|null;end_frame_asset_id:string|null;source_asset_id:string|null;funding_id:string|null;width:number;height:number;output_width:number;output_height:number;fps_num:number;fps_den:number;frame_count:number;attempt_id:string;fence:string;deadline:Date;execution_binding_id:string}>(
      `SELECT j.id,j.twitch_channel_id,j.segment_revision_id,j.interrupt_id,j.stage,j.recipe_id,j.recipe_sha256,j.input_sha256,j.planning_payload,j.funding_id,
          coalesce(j.planning_payload->>'prompt',sr.prompt) AS prompt,
          coalesce((j.planning_payload->>'startBoundaryRevisionId')::uuid,sr.start_boundary_revision_id) AS start_boundary_revision_id,
          coalesce((j.planning_payload->>'startFrameAssetId')::uuid,start_b.asset_id) AS start_frame_asset_id,
          CASE WHEN j.interrupt_id IS NULL THEN sr.requested_end_boundary_revision_id ELSE NULL END AS end_boundary_revision_id,
          j.parent_asset_id AS source_asset_id,
          CASE WHEN j.interrupt_id IS NULL THEN end_b.asset_id ELSE NULL END AS end_frame_asset_id,
          CASE WHEN j.stage='video_upscale' THEN (j.planning_payload->>'outputWidth')::int ELSE c.output_width END AS output_width,
          CASE WHEN j.stage='video_upscale' THEN (j.planning_payload->>'outputHeight')::int ELSE c.output_height END AS output_height,
          CASE WHEN j.stage='video_upscale' THEN 1920 ELSE c.output_width END AS width,
          CASE WHEN j.stage='video_upscale' THEN 1080 ELSE c.output_height END AS height,
          c.output_fps_num AS fps_num,c.output_fps_den AS fps_den,
          (c.output_fps_num*15/c.output_fps_den)::int AS frame_count,ja.id AS attempt_id,ja.fence,ja.attempt_deadline_at AS deadline,ja.execution_binding_id
       FROM sloptogether.jobs j JOIN sloptogether.channels c ON c.twitch_channel_id=j.twitch_channel_id
       LEFT JOIN sloptogether.segment_revisions sr ON sr.id=j.segment_revision_id
       LEFT JOIN sloptogether.boundary_revisions start_b ON start_b.id=coalesce((j.planning_payload->>'startBoundaryRevisionId')::uuid,sr.start_boundary_revision_id)
       LEFT JOIN sloptogether.boundary_revisions end_b ON end_b.id=sr.requested_end_boundary_revision_id
       JOIN LATERAL (SELECT a.id,a.fence,a.attempt_deadline_at,te.id AS execution_binding_id FROM sloptogether.job_attempts a
          JOIN sloptogether.trusted_executions te ON te.twitch_channel_id=j.twitch_channel_id AND te.key_id=$3 AND te.execution_role=$4 AND te.revoked_at IS NULL
            AND (cardinality(te.recipe_ids)=0 OR j.recipe_id=ANY(te.recipe_ids))
          WHERE a.job_id=j.id AND a.state='ready' AND (a.execution_binding_id IS NULL OR a.execution_binding_id=te.id)
          ORDER BY a.attempt_number LIMIT 1 FOR UPDATE OF a SKIP LOCKED) ja ON true
       WHERE j.twitch_channel_id=$1 AND j.state='ready' AND j.execution_mode='pull_worker'
         AND NOT EXISTS(SELECT 1 FROM sloptogether.bans b WHERE b.twitch_user_id=$5 AND b.revoked_at IS NULL
           AND (b.expires_at IS NULL OR b.expires_at>now()) AND (b.scope='global' OR b.twitch_channel_id=$1))
         AND NOT EXISTS(SELECT 1 FROM sloptogether.bans b WHERE b.twitch_user_id=j.requested_by AND b.revoked_at IS NULL
           AND (b.expires_at IS NULL OR b.expires_at>now()) AND (b.scope='global' OR b.twitch_channel_id=$1))
         AND NOT EXISTS(SELECT 1 FROM sloptogether.paid_action_intents intent WHERE intent.segment_revision_id=j.segment_revision_id
           AND intent.state IN ('intent_open','receipt_seen') AND intent.expires_at>now())
         AND (j.interrupt_id IS NULL OR NOT EXISTS(SELECT 1 FROM sloptogether.interrupt_requests ir JOIN sloptogether.subscription_events se ON se.id=ir.trigger_event_id
           JOIN sloptogether.bans b ON b.twitch_user_id=se.twitch_actor_id WHERE ir.id=j.interrupt_id AND b.revoked_at IS NULL
             AND (b.expires_at IS NULL OR b.expires_at>now()) AND (b.scope='global' OR b.twitch_channel_id=$1)))
         AND j.stage=$2 AND (j.result_deadline_at IS NULL OR j.result_deadline_at>now())
       ORDER BY j.priority DESC,j.created_at ASC LIMIT 1 FOR UPDATE OF j SKIP LOCKED`,
      [grant.channelId,role==="generation"?"video_base":"video_upscale",grant.keyId,role,grant.issuingTwitchUserId]);
    const job=result.rows[0];if(!job)return {status:"empty"};
    const fence=Number(job.fence);if(!Number.isSafeInteger(fence)||fence<1)throw new ApiError(500,"job_fence_invalid");
    const stage=role;const deadline=(job.deadline??new Date(Date.now()+30*60_000)).toISOString();
    const payload={jobId:job.id,channelId:job.twitch_channel_id,segmentRevisionId:job.segment_revision_id,stage,kind:job.interrupt_id?"subscriber_interrupt":"story",requireAudio:true,
      executionMode:"pull_worker",recipeId:job.recipe_id,recipeSha256:job.recipe_sha256.toString("hex"),inputSha256:job.input_sha256.toString("hex"),
      prompt:job.prompt??"",startFrameAssetId:job.start_frame_asset_id,requestedEndBoundaryRevisionId:job.end_boundary_revision_id,
      endFrameAssetId:job.end_frame_asset_id,endpointResolutionId:null,sourceAssetId:job.source_asset_id,
      width:role==="generation"?448:job.width,height:role==="generation"?256:job.height,outputWidth:job.output_width,outputHeight:job.output_height,
      fpsNum:job.fps_num,fpsDen:job.fps_den,frameCount:role==="generation"?362:job.frame_count,attemptId:job.attempt_id,fence,attemptDeadlineAt:deadline};
    jobInputSchema.parse(payload);
    await client.query("UPDATE sloptogether.job_attempts SET state='leased',execution_binding_id=$2,claimed_at=now(),lease_expires_at=least(now()+interval '60 seconds',attempt_deadline_at) WHERE id=$1 AND state='ready'",[job.attempt_id,job.execution_binding_id]);
    await client.query("UPDATE sloptogether.jobs SET state='leased' WHERE id=$1 AND state='ready'",[job.id]);
    if(job.funding_id)await client.query("UPDATE sloptogether.funding_authorizations SET state='consumed_uncertain',consumed_at=coalesce(consumed_at,now()) WHERE id=$1 AND state='reserved'",[job.funding_id]);
    await client.query("UPDATE sloptogether.worker_devices SET last_seen_at=now() WHERE twitch_user_id=$1 AND status='paired'",[grant.issuingTwitchUserId]);
    await client.query("INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,actor_key_id,action,target_kind,target_id,after_state) VALUES($1,$2,$3,'worker.lease.claim','job',$4,$5::jsonb)",
      [grant.channelId,grant.issuingTwitchUserId,grant.keyId,job.id,JSON.stringify({attemptId:job.attempt_id,fence,stage})]);
    return {status:"leased",leaseId:job.attempt_id,fence,sequence:1,job:{...payload,leaseId:job.attempt_id},leaseExpiresAt:new Date(Date.now()+60_000).toISOString(),attemptDeadlineAt:deadline};
  });
}

async function expireWorkerLeases(client:import("pg").PoolClient,channelId:string){
  const expired=await client.query<{id:string;job_id:string;segment_revision_id:string|null;interrupt_id:string|null;stage:string;execution_mode:string;attempt_number:number;fence:string;provider_request_id:string|null;funding_id:string|null;input_sha256:Buffer;requested_by:string;job_deadline:Date|null}>(`SELECT a.id,a.job_id,j.segment_revision_id,j.interrupt_id,j.stage,j.execution_mode,a.attempt_number,a.fence,a.provider_request_id,a.funding_id,a.input_sha256,j.requested_by,j.result_deadline_at AS job_deadline
    FROM sloptogether.job_attempts a JOIN sloptogether.jobs j ON j.id=a.job_id
    WHERE j.twitch_channel_id=$1 AND j.execution_mode='pull_worker' AND a.state IN ('leased','running','uploaded','validating')
      AND (a.state<>'validating' OR a.output_asset_id IS NULL)
      AND (a.lease_expires_at<=now() OR a.attempt_deadline_at<=now()) FOR UPDATE OF a,j SKIP LOCKED`,[channelId]);
  for(const attempt of expired.rows){
    // Pull workers record local Comfy prompt IDs; only queued remote-provider requests are uncertain billable submissions.
    const uncertain=attempt.execution_mode==="provider_queue"&&Boolean(attempt.provider_request_id);
    const nextState=uncertain?"uncertain":"expired";
    await client.query("UPDATE sloptogether.job_attempts SET state=$2,fence=fence+1,lease_expires_at=now(),finished_at=now(),error_code='worker_lease_expired' WHERE id=$1",[attempt.id,nextState]);
    await client.query("UPDATE sloptogether.upload_reservations SET state='expired',expires_at=now() WHERE attempt_id=$1 AND state IN ('issued','uploaded')",[attempt.id]);
    if(attempt.funding_id)await client.query("UPDATE sloptogether.funding_authorizations SET state=$2,consumed_at=coalesce(consumed_at,now()),settled_at=CASE WHEN $2='consumed_failed' THEN now() ELSE settled_at END WHERE id=$1 AND state IN ('reserved','consumed_uncertain')",[attempt.funding_id,uncertain?"consumed_uncertain":"consumed_failed"]);
    const canRetry=!attempt.funding_id&&attempt.attempt_number<3&&(!attempt.job_deadline||attempt.job_deadline.getTime()>Date.now());
    if(canRetry){
      const retryId=randomUUID();const retryNumber=attempt.attempt_number+1;const deadline=attempt.job_deadline??new Date(Date.now()+30*60_000);
      await client.query("INSERT INTO sloptogether.job_attempts(id,job_id,attempt_number,fence,client_idempotency_key,state,attempt_deadline_at,input_sha256) VALUES($1,$2,$3,1,$4,'ready',$5,$6)",[retryId,attempt.job_id,retryNumber,`job:${attempt.job_id}:attempt:${retryNumber}`,deadline,attempt.input_sha256]);
      await client.query("UPDATE sloptogether.jobs SET state='ready' WHERE id=$1 AND state NOT IN ('cancelled','succeeded','expired')",[attempt.job_id]);
    }else{
      await client.query("UPDATE sloptogether.jobs SET state='failed',completed_at=now() WHERE id=$1 AND state NOT IN ('cancelled','succeeded','expired')",[attempt.job_id]);
      if(attempt.interrupt_id){
        await client.query("UPDATE sloptogether.interrupt_requests SET program_state='failed' WHERE id=$1 AND program_state NOT IN ('played','cancelled','expired','skipped')",[attempt.interrupt_id]);
        await client.query("UPDATE sloptogether.subscription_events SET state='failed' WHERE interrupt_id=$1 AND state NOT IN ('played','cancelled','expired')",[attempt.interrupt_id]);
      }else if(attempt.stage==="video_base"&&attempt.segment_revision_id)await reopenFailedRevision(client,attempt.segment_revision_id,"Worker attempt expired.");
    }
  }
}

async function reopenFailedRevision(client:import("pg").PoolClient,revisionId:string,reason:string){
  await client.query(`UPDATE sloptogether.proposals p SET state='rejected',reviewed_at=now(),review_reason=$2
    WHERE p.segment_revision_id=$1 AND p.state='selected'
      AND EXISTS(SELECT 1 FROM sloptogether.segment_revisions r JOIN sloptogether.segments s ON s.id=r.segment_id
        WHERE r.id=$1 AND s.selected_revision_id=r.id AND s.state NOT IN ('played','retired')
          AND NOT EXISTS(SELECT 1 FROM sloptogether.program_items pi WHERE pi.segment_id=s.id AND pi.committed_at IS NOT NULL))`,[revisionId,reason]);
  await client.query(`UPDATE sloptogether.elections e SET state='closed',winner_proposal_id=NULL,closed_by=NULL
    WHERE e.state='selected' AND e.segment_id=(SELECT r.segment_id FROM sloptogether.segment_revisions r JOIN sloptogether.segments s ON s.id=r.segment_id
      WHERE r.id=$1 AND s.selected_revision_id=r.id AND s.state NOT IN ('played','retired')
        AND NOT EXISTS(SELECT 1 FROM sloptogether.program_items pi WHERE pi.segment_id=s.id AND pi.committed_at IS NOT NULL))`,[revisionId]);
  await client.query(`UPDATE sloptogether.segment_revisions r SET state='superseded' WHERE r.id=$1 AND r.state NOT IN ('played','superseded')
    AND EXISTS(SELECT 1 FROM sloptogether.segments s WHERE s.id=r.segment_id AND s.selected_revision_id=r.id
      AND s.state NOT IN ('played','retired')
      AND NOT EXISTS(SELECT 1 FROM sloptogether.program_items pi WHERE pi.segment_id=s.id AND pi.committed_at IS NOT NULL))`,[revisionId]);
  await client.query(`UPDATE sloptogether.segments s SET state='open',selected_revision_id=NULL,protected_at=NULL
    WHERE s.selected_revision_id=$1 AND s.state NOT IN ('played','retired')
      AND NOT EXISTS(SELECT 1 FROM sloptogether.program_items pi WHERE pi.segment_id=s.id AND pi.committed_at IS NOT NULL)`,[revisionId]);
}

function workerMediaGatewayUrl(){
  const configured=process.env.SLOPTOGETHER_UPLOAD_WORKER_ORIGIN??process.env.R2_UPLOAD_WORKER_ORIGIN;
  if(!configured)throw new ApiError(503,"upload_gateway_not_configured");
  let origin:URL;try{origin=new URL(configured)}catch{throw new ApiError(503,"upload_gateway_not_configured");}
  if(origin.protocol!=="https:"||origin.hostname!=="uploads.clips.gg"||origin.username||origin.password
    ||origin.pathname!=="/"&&origin.pathname!==""||origin.search||origin.hash)throw new ApiError(503,"upload_gateway_not_configured");
  return `${origin.origin}/worker-media`;
}

export async function downloadWorkerAsset(leaseId:string,assetId:string,request:Request){
  const principal=await requestPrincipal(request);if(!principal||principal.kind!=="worker-key")throw new ApiError(401,"worker_key_required");
  const grant=principal.worker;
  const fenceRaw=request.headers.get("x-lease-fence");const fence=Number(fenceRaw);
  if(!fenceRaw||!Number.isSafeInteger(fence)||fence<1)throw new ApiError(400,"lease_fence_required");
  const result=await query<{fence:string;attempt_state:string;lease_expires_at:Date|null;deadline:Date|null;channel_id:string;stage:string;key_id:string|null;binding_role:string|null;binding_revoked_at:Date|null;requested_by:string;interrupt_actor_id:string|null;parent_asset_id:string|null;start_asset_id:string|null;end_asset_id:string|null;asset_id:string;storage_key:string;content_type:string;byte_size:string;status:string;screen_clear:boolean}>(
    `SELECT a.fence,a.state AS attempt_state,a.lease_expires_at,a.attempt_deadline_at AS deadline,j.twitch_channel_id AS channel_id,j.stage,
      te.key_id,te.execution_role AS binding_role,te.revoked_at AS binding_revoked_at,j.requested_by,j.parent_asset_id,
      (SELECT se.twitch_actor_id FROM sloptogether.interrupt_requests ir JOIN sloptogether.subscription_events se ON se.id=ir.trigger_event_id WHERE ir.id=j.interrupt_id) AS interrupt_actor_id,
      start_b.asset_id AS start_asset_id,end_b.asset_id AS end_asset_id,asset.id AS asset_id,asset.storage_key,asset.content_type,asset.byte_size,asset.status,
      EXISTS(SELECT 1 FROM sloptogether.input_screens i WHERE i.twitch_channel_id=j.twitch_channel_id AND i.effective_state='clear'
        AND (i.expires_at IS NULL OR i.expires_at>now()) AND (i.id::text=j.planning_payload->>'inputScreenId'
          OR EXISTS(SELECT 1 FROM sloptogether.proposals p WHERE p.segment_revision_id=j.segment_revision_id AND p.input_screen_id=i.id))) AS screen_clear
     FROM sloptogether.job_attempts a JOIN sloptogether.jobs j ON j.id=a.job_id
     JOIN sloptogether.trusted_executions te ON te.id=a.execution_binding_id
     LEFT JOIN sloptogether.segment_revisions sr ON sr.id=j.segment_revision_id
     LEFT JOIN sloptogether.boundary_revisions start_b ON start_b.id=coalesce((j.planning_payload->>'startBoundaryRevisionId')::uuid,sr.start_boundary_revision_id)
     LEFT JOIN sloptogether.boundary_revisions end_b ON end_b.id=sr.requested_end_boundary_revision_id
     JOIN sloptogether.assets asset ON asset.id=$2 AND asset.twitch_channel_id=j.twitch_channel_id
     WHERE a.id=$1 AND j.twitch_channel_id=$3`,[leaseId,assetId,grant.channelId]);
  const row=result.rows[0];if(!row)throw new ApiError(404,"worker_asset_not_found");
  const expectedRole=row.stage==="video_base"?"generation":row.stage==="video_upscale"?"upscale":null;
  if(Number(row.fence)!==fence||row.attempt_state!=="running"&&row.attempt_state!=="leased"||!row.lease_expires_at||row.lease_expires_at.getTime()<=Date.now()||!row.deadline||row.deadline.getTime()<=Date.now())throw new ApiError(409,"worker_lease_expired_or_fenced");
  if(row.key_id!==grant.keyId||row.binding_revoked_at||row.binding_role!==expectedRole||!expectedRole||!grant.scopes.includes(`worker:${expectedRole}`))throw new ApiError(403,"worker_attempt_owner_required");
  if(await isBanned(row.channel_id,grant.issuingTwitchUserId)||await isBanned(row.channel_id,row.requested_by)||(row.interrupt_actor_id&&await isBanned(row.channel_id,row.interrupt_actor_id)))throw new ApiError(403,"channel_ban_active");
  if(!row.screen_clear)throw new ApiError(409,"worker_input_not_cleared");
  const allowed=row.stage==="video_base"?(assetId===row.start_asset_id||assetId===row.end_asset_id):assetId===row.parent_asset_id;
  if(!allowed||!row.content_type||!['image/png','image/jpeg','image/webp','video/mp4'].includes(row.content_type)||!['approved','published'].includes(row.status))throw new ApiError(403,"worker_asset_not_in_attempt");
  if(principal.worker.paired&&!await canContribute(await findChannel(row.channel_id),principal))throw new ApiError(403,"contribution_not_allowed");
  const byteSize=Number(row.byte_size);if(!Number.isSafeInteger(byteSize)||byteSize<1||byteSize>128*1024*1024)throw new ApiError(413,"worker_asset_size_invalid");
  const ticket=signUploadTicket({version:1,purpose:"worker_asset_read",channelId:row.channel_id,leaseId,assetId,fence,storageKey:row.storage_key,
    contentType:row.content_type,byteSize,expiresAt:new Date(Date.now()+60_000).toISOString()});
  return {url:workerMediaGatewayUrl(),ticket};
}

export async function failWorkerLease(leaseId:string,request:Request){
  const principal=await requestPrincipal(request);if(!principal||principal.kind!=="worker-key")throw new ApiError(401,"worker_key_required");
  const grant=principal.worker;const body=await readJson(request,z.object({fence:z.number().int().positive(),errorCode:z.string().trim().min(1).max(80)}).strict());
  return transaction(async client=>{
    const identity=await client.query<{stage:string;segment_revision_id:string|null;interrupt_id:string|null}>(`SELECT j.stage,j.segment_revision_id,j.interrupt_id
      FROM sloptogether.job_attempts a JOIN sloptogether.jobs j ON j.id=a.job_id
      WHERE a.id=$1 AND a.fence=$2 AND j.twitch_channel_id=$3`,[leaseId,body.fence,grant.channelId]);
    const jobIdentity=identity.rows[0];if(!jobIdentity)throw new ApiError(409,"worker_lease_expired_or_fenced");
    await client.query("SELECT twitch_channel_id FROM sloptogether.channels WHERE twitch_channel_id=$1 FOR SHARE",[grant.channelId]);
    if(jobIdentity.interrupt_id){
      await client.query("SELECT id FROM sloptogether.interrupt_requests WHERE id=$1 AND broadcaster_twitch_id=$2 FOR UPDATE",[jobIdentity.interrupt_id,grant.channelId]);
    }else if(jobIdentity.stage==="video_base"&&jobIdentity.segment_revision_id){
      await client.query(`SELECT s.id FROM sloptogether.segment_revisions r JOIN sloptogether.segments s ON s.id=r.segment_id
        WHERE r.id=$1 AND s.twitch_channel_id=$2 FOR UPDATE OF s`,[jobIdentity.segment_revision_id,grant.channelId]);
    }
    const result=await client.query<{attempt_number:number;funding_id:string|null;attempt_deadline_at:Date;input_sha256:Buffer;provider_request_id:string|null;execution_mode:string;job_id:string;stage:string;segment_revision_id:string|null;interrupt_id:string|null}>(`SELECT a.attempt_number,a.funding_id,a.attempt_deadline_at,a.input_sha256,a.provider_request_id,j.execution_mode,j.stage,j.segment_revision_id,j.interrupt_id,a.job_id
      FROM sloptogether.job_attempts a JOIN sloptogether.jobs j ON j.id=a.job_id JOIN sloptogether.trusted_executions te ON te.id=a.execution_binding_id
      WHERE a.id=$1 AND a.fence=$2 AND j.twitch_channel_id=$3 AND te.key_id=$4 AND te.revoked_at IS NULL AND a.state IN ('leased','running') FOR UPDATE OF a,j`,[leaseId,body.fence,grant.channelId,grant.keyId]);
    const attempt=result.rows[0];if(!attempt)throw new ApiError(409,"worker_lease_expired_or_fenced");
    const fenced=await client.query("UPDATE sloptogether.job_attempts SET state='failed',fence=fence+1,lease_expires_at=now(),finished_at=now(),error_code=$3 WHERE id=$1 AND fence=$2 RETURNING id",[leaseId,body.fence,body.errorCode]);
    if(!fenced.rowCount)throw new ApiError(409,"worker_lease_expired_or_fenced");
    await client.query("UPDATE sloptogether.upload_reservations SET state='expired',expires_at=now() WHERE attempt_id=$1 AND state IN ('issued','uploaded')",[leaseId]);
    const retry=attempt.execution_mode==="pull_worker"&&attempt.attempt_number<3&&!attempt.funding_id&&attempt.attempt_deadline_at.getTime()>Date.now();
    if(retry){
      const nextAttempt=attempt.attempt_number+1;const nextId=randomUUID();
      await client.query("INSERT INTO sloptogether.job_attempts(id,job_id,attempt_number,fence,client_idempotency_key,state,attempt_deadline_at,input_sha256) VALUES($1,$2,$3,1,$4,'ready',$5,$6)",[nextId,attempt.job_id,nextAttempt,`job:${attempt.job_id}:attempt:${nextAttempt}`,attempt.attempt_deadline_at,attempt.input_sha256]);
      await client.query("UPDATE sloptogether.jobs SET state='ready' WHERE id=$1 AND state NOT IN ('cancelled','succeeded','expired')",[attempt.job_id]);
    }else{
      await client.query("UPDATE sloptogether.jobs SET state='failed',completed_at=now() WHERE id=$1 AND state NOT IN ('cancelled','succeeded','expired')",[attempt.job_id]);
      if(attempt.interrupt_id){
        await client.query("UPDATE sloptogether.interrupt_requests SET program_state='failed' WHERE id=$1 AND program_state NOT IN ('played','cancelled','expired','skipped')",[attempt.interrupt_id]);
        await client.query("UPDATE sloptogether.subscription_events SET state='failed' WHERE interrupt_id=$1 AND state NOT IN ('played','cancelled','expired')",[attempt.interrupt_id]);
      }else if(attempt.stage==="video_base"&&attempt.segment_revision_id)await reopenFailedRevision(client,attempt.segment_revision_id,"Worker attempt failed.");
    }
    if(attempt.funding_id)await client.query("UPDATE sloptogether.funding_authorizations SET state='consumed_failed',consumed_at=coalesce(consumed_at,now()),settled_at=now() WHERE id=$1 AND state IN ('reserved','consumed_uncertain')",[attempt.funding_id]);
    return {accepted:true,retryScheduled:retry};
  });
}

export async function heartbeatWorkerLease(leaseId:string,request:Request){
  const principal=await requestPrincipal(request);if(!principal||principal.kind!=="worker-key")throw new ApiError(401,"worker_key_required");
  const grant=principal.worker;
  if(grant.paired&&!await canContribute(await findChannel(grant.channelId),principal))throw new ApiError(403,"contribution_not_allowed");
  if(grant.scopes.includes("worker:generation"))requireKeyScope(grant,"worker:generation");
  else requireKeyScope(grant,"worker:upscale");
  const body=await readJson(request,z.object({leaseId:z.string().uuid(),fence:z.number().int().positive(),phase:z.enum(["starting","running","uploading","validating"]),progress:z.number().min(0).max(1)}).strict());
  if(body.leaseId!==leaseId)throw new ApiError(400,"lease_id_mismatch");
  const result=await query<{state:string;lease_expires_at:Date;attempt_deadline_at:Date}>(
    `UPDATE sloptogether.job_attempts a SET state=CASE WHEN a.state='leased' THEN 'running' ELSE a.state END,
       lease_expires_at=least(now()+interval '60 seconds',a.attempt_deadline_at)
     FROM sloptogether.jobs j,sloptogether.trusted_executions te
     WHERE te.id=a.execution_binding_id AND te.key_id=$4 AND te.revoked_at IS NULL
       AND te.execution_role=CASE j.stage WHEN 'video_base' THEN 'generation' ELSE 'upscale' END
       AND a.id=$1 AND a.fence=$2 AND a.job_id=j.id AND j.twitch_channel_id=$3
       AND NOT EXISTS(SELECT 1 FROM sloptogether.bans b WHERE b.twitch_user_id=$5 AND b.revoked_at IS NULL AND (b.expires_at IS NULL OR b.expires_at>now()) AND (b.scope='global' OR b.twitch_channel_id=$3))
       AND (j.interrupt_id IS NULL OR NOT EXISTS(SELECT 1 FROM sloptogether.interrupt_requests ir JOIN sloptogether.subscription_events se ON se.id=ir.trigger_event_id
         JOIN sloptogether.bans b ON b.twitch_user_id=se.twitch_actor_id WHERE ir.id=j.interrupt_id AND b.revoked_at IS NULL
           AND (b.expires_at IS NULL OR b.expires_at>now()) AND (b.scope='global' OR b.twitch_channel_id=$3)))
       AND a.state IN ('leased','running','uploaded','validating') AND a.lease_expires_at>now() AND a.attempt_deadline_at>now()
     RETURNING a.state,a.lease_expires_at,a.attempt_deadline_at`,[leaseId,body.fence,grant.channelId,grant.keyId,grant.issuingTwitchUserId]);
  const row=result.rows[0];if(!row)throw new ApiError(409,"worker_lease_expired_or_fenced");
  await query("UPDATE sloptogether.jobs SET state='running' WHERE id=(SELECT job_id FROM sloptogether.job_attempts WHERE id=$1) AND state IN ('leased','running')",[leaseId]);
  return {state:row.state,leaseExpiresAt:row.lease_expires_at.toISOString(),attemptDeadlineAt:row.attempt_deadline_at.toISOString()};
}

export async function recordWorkerProviderRequest(leaseId:string,request:Request){
  const principal=await requestPrincipal(request);if(!principal||principal.kind!=="worker-key")throw new ApiError(401,"worker_key_required");
  const grant=principal.worker;const body=await readJson(request,z.object({fence:z.number().int().positive(),providerRequestId:z.string().trim().min(1).max(256)}).strict());
  if(grant.paired&&!await canContribute(await findChannel(grant.channelId),principal))throw new ApiError(403,"contribution_not_allowed");
  const result=await query<{provider_request_id:string|null}>(`UPDATE sloptogether.job_attempts a SET provider_request_id=coalesce(provider_request_id,$3)
    FROM sloptogether.jobs j,sloptogether.trusted_executions te
    WHERE te.id=a.execution_binding_id AND te.key_id=$4 AND te.revoked_at IS NULL AND a.id=$1 AND a.fence=$2 AND a.job_id=j.id
      AND j.twitch_channel_id=$5 AND a.state IN ('leased','running') AND a.lease_expires_at>now() AND a.attempt_deadline_at>now()
      AND NOT EXISTS(SELECT 1 FROM sloptogether.bans b WHERE b.twitch_user_id=$6 AND b.revoked_at IS NULL AND (b.expires_at IS NULL OR b.expires_at>now()) AND (b.scope='global' OR b.twitch_channel_id=$5))
      AND (j.interrupt_id IS NULL OR NOT EXISTS(SELECT 1 FROM sloptogether.interrupt_requests ir JOIN sloptogether.subscription_events se ON se.id=ir.trigger_event_id
        JOIN sloptogether.bans b ON b.twitch_user_id=se.twitch_actor_id WHERE ir.id=j.interrupt_id AND b.revoked_at IS NULL
          AND (b.expires_at IS NULL OR b.expires_at>now()) AND (b.scope='global' OR b.twitch_channel_id=$5)))
      RETURNING a.provider_request_id`,[leaseId,body.fence,body.providerRequestId,grant.keyId,grant.channelId,grant.issuingTwitchUserId]);
  const row=result.rows[0];if(!row)throw new ApiError(409,"worker_lease_expired_or_fenced");if(row.provider_request_id!==body.providerRequestId)throw new ApiError(409,"provider_request_id_immutable");
  return {recorded:true};
}

export async function listWindowsWorkerRelease(){
  const version=process.env.WINDOWS_WORKER_VERSION??"0.1.0";
  const url=process.env.WINDOWS_WORKER_DOWNLOAD_URL;
  const sha=process.env.WINDOWS_WORKER_SHA256;
  const releasedAt=process.env.WINDOWS_WORKER_RELEASED_AT;
  const windowsBuild=process.env.WINDOWS_WORKER_BUILD;
  const roles=(process.env.WINDOWS_WORKER_ROLES??"").split(",").map(role=>role.trim()).filter((role):role is "generation"|"upscale"=>role==="generation"||role==="upscale");
  const qualifiedGpus=(process.env.WINDOWS_WORKER_QUALIFIED_GPUS??"").split(",").map(name=>name.trim().slice(0,100)).filter(Boolean).slice(0,20);
  if(!url||!sha||!/^https:\/\//.test(url)||!/^[a-f0-9]{64}$/i.test(sha)||!releasedAt||!Number.isFinite(Date.parse(releasedAt))||!windowsBuild||!roles.length)
    return {available:false,reason:"worker_release_not_published"};
  return {version,downloadUrl:url,sha256:sha.toLowerCase(),platform:"windows-x64",available:true,releasedAt,windowsBuild,roles,qualifiedGpus,notes:["Verify the download SHA-256 before running it."]};
}

export async function claimStoryProducer(locator:string,request:Request){
  const channel=await findChannel(locator);const grant=await requireWorker(request,"story:write_future");
  if(grant.channelId!==channel.twitch_channel_id||grant.issuingTwitchUserId!==channel.owner_twitch_user_id)throw new ApiError(403,"story_producer_owner_key_required");
  if(await isBanned(channel.twitch_channel_id,grant.issuingTwitchUserId))throw new ApiError(403,"channel_ban_active");
  return transaction(async client=>{
    const current=await client.query<{policy_revision:number;subscriber_interrupt_policy:Record<string,unknown>;owner_budget_cap_usd:string}>("SELECT policy_revision,subscriber_interrupt_policy,owner_budget_cap_usd FROM sloptogether.channels WHERE twitch_channel_id=$1 AND is_enabled FOR UPDATE",[channel.twitch_channel_id]);
    if(current.rows[0]?.policy_revision!==channel.policy_revision)throw new ApiError(409,"channel_policy_changed");
    const binding=await client.query<{id:string}>("SELECT id FROM sloptogether.trusted_executions WHERE twitch_channel_id=$1 AND key_id=$2 AND execution_role='story_producer' AND revoked_at IS NULL ORDER BY enabled_at DESC LIMIT 1",[channel.twitch_channel_id,grant.keyId]);
    if(!binding.rows[0])throw new ApiError(403,"story_producer_binding_revoked");
    const existing=await client.query<{id:string;fence:string;last_sequence:string;lease_expires_at:Date;execution_binding_id:string}>("SELECT id,fence,last_sequence,lease_expires_at,execution_binding_id FROM sloptogether.story_producers WHERE twitch_channel_id=$1 AND released_at IS NULL FOR UPDATE",[channel.twitch_channel_id]);
    let leaseId:string;let fence:number;let sequence:number;
    if(existing.rows[0]&&existing.rows[0].lease_expires_at.getTime()>Date.now()){
      if(existing.rows[0].execution_binding_id!==binding.rows[0].id)throw new ApiError(409,"story_producer_already_active");
      leaseId=existing.rows[0].id;fence=Number(existing.rows[0].fence);sequence=Number(existing.rows[0].last_sequence)+1;
    }else{
      if(existing.rows[0])await abandonStoryProducerPlans(client,[existing.rows[0].id]);
      await client.query("UPDATE sloptogether.story_producers SET released_at=now() WHERE twitch_channel_id=$1 AND released_at IS NULL",[channel.twitch_channel_id]);
      const prior=await client.query<{fence:string}>("SELECT coalesce(max(fence),0)::text AS fence FROM sloptogether.story_producers WHERE twitch_channel_id=$1",[channel.twitch_channel_id]);
      fence=Number(prior.rows[0]!.fence)+1;leaseId=randomUUID();sequence=1;
      await client.query("INSERT INTO sloptogether.story_producers(id,twitch_channel_id,execution_binding_id,fence,last_sequence,lease_expires_at) VALUES($1,$2,$3,$4,0,now()+interval '90 seconds')",[leaseId,channel.twitch_channel_id,binding.rows[0]!.id,fence]);
    }
    const pending=await client.query<{id:string;idempotency_key:string;expected_channel_revision:number;input_payload:{theme?:string;recentStorySummary?:string;recentDialogue?:string;subscriberLabel?:string;interruptId?:string;sceneSeed?:string}}>("SELECT id,idempotency_key,expected_channel_revision,input_payload FROM sloptogether.story_plan_attempts WHERE producer_id=$1 AND producer_fence=$2 AND sequence=$3 AND status='planning' FOR UPDATE",[leaseId,fence,sequence]);
    if(pending.rows[0]){
      const context=pending.rows[0].input_payload;
      let currentAttempt=pending.rows[0].expected_channel_revision===current.rows[0]!.policy_revision;
      let interruptState:"queued"|"cancelled"|"expired"|"failed"|null=null;
      if(context.interruptId){
        const requestState=await client.query<{state:string;expires_at:Date;enabled:boolean;funding_state:string;owner_authorized:boolean}>(`SELECT ir.program_state AS state,ir.expires_at,
          (c.subscriber_interrupt_policy->>'enabled')::boolean AS enabled,f.state AS funding_state,
          EXISTS(SELECT 1 FROM sloptogether.sessions sess WHERE sess.twitch_user_id=c.owner_twitch_user_id AND sess.revoked_at IS NULL AND sess.expires_at>now()
            AND sess.granted_scopes @> ARRAY['channel:read:subscriptions']::text[]) AS owner_authorized
          FROM sloptogether.interrupt_requests ir JOIN sloptogether.channels c ON c.twitch_channel_id=ir.broadcaster_twitch_id
          LEFT JOIN sloptogether.funding_authorizations f ON f.id=ir.funding_id WHERE ir.id=$1 FOR UPDATE OF ir`,[context.interruptId]);
        const req=requestState.rows[0];
        const interruptCurrent=Boolean(req&&req.state==="planning"&&req.expires_at.getTime()>Date.now()&&req.enabled&&req.funding_state==="reserved"&&req.owner_authorized);
        currentAttempt=currentAttempt&&interruptCurrent;
        if(!currentAttempt){
          interruptState=!req||req.expires_at.getTime()<=Date.now()?"expired":!req.enabled||!req.owner_authorized?"cancelled":req.funding_state!=="reserved"?"failed":"queued";
          await client.query("UPDATE sloptogether.interrupt_requests SET program_state=$2 WHERE id=$1 AND program_state='planning'",[context.interruptId,interruptState]);
          await client.query("UPDATE sloptogether.subscription_events SET state=$2 WHERE interrupt_id=$1 AND state='queued'",[context.interruptId,interruptState]);
          await client.query("UPDATE sloptogether.outbox SET delivered_at=now(),leased_until=NULL WHERE aggregate_id=$1 AND event_kind='subscriber_interrupt.plan' AND delivered_at IS NULL",[context.interruptId]);
          if(interruptState!=="queued")await client.query(`UPDATE sloptogether.funding_authorizations SET state='released',settled_at=now() WHERE id=(SELECT funding_id FROM sloptogether.interrupt_requests WHERE id=$1)
            AND state='reserved' AND NOT EXISTS(SELECT 1 FROM sloptogether.job_attempts a WHERE a.funding_id=sloptogether.funding_authorizations.id AND a.claimed_at IS NOT NULL)`,[context.interruptId]);
        }
      }
      if(currentAttempt){
        if(!context.interruptId){
          const blocked=await ownerAttemptBudgetBlock(client,channel.twitch_channel_id,current.rows[0]!.owner_budget_cap_usd);
          if(blocked)throw new ApiError(409,blocked);
        }
        const claimToken=randomUUID();
        const sceneSeed=typeof context.sceneSeed==="string"?context.sceneSeed:pending.rows[0].idempotency_key;
        const claimed=await client.query<{claim_token:string}>(`UPDATE sloptogether.story_plan_attempts
          SET claim_token=$4,claim_expires_at=now()+interval '60 seconds',
              input_payload=CASE WHEN input_payload ? 'sceneSeed' THEN input_payload ELSE input_payload||jsonb_build_object('sceneSeed',$5::text) END,
              updated_at=now()
          WHERE id=$1 AND producer_id=$2 AND producer_fence=$3 AND status='planning'
            AND (claim_expires_at IS NULL OR claim_expires_at<=now())
          RETURNING claim_token`,[pending.rows[0].id,leaseId,fence,claimToken,sceneSeed]);
        if(!claimed.rows[0])return {status:"empty"};
        await client.query("UPDATE sloptogether.story_producers SET lease_expires_at=now()+interval '90 seconds' WHERE id=$1",[leaseId]);
        return {leaseId,fence,sequence,idempotencyKey:pending.rows[0].idempotency_key,claimToken:claimed.rows[0].claim_token,interruptId:context.interruptId,storyContext:{taskKind:context.interruptId?"subscriber_interrupt":"story",channelTheme:context.theme??"",recentStorySummary:context.recentStorySummary??"",recentDialogue:context.recentDialogue??"",subscriberLabel:context.subscriberLabel,sceneSeed}};
      }
      await client.query("UPDATE sloptogether.story_plan_attempts SET status='failed',claim_token=NULL,claim_expires_at=NULL,updated_at=now() WHERE producer_id=$1 AND producer_fence=$2 AND sequence=$3 AND status='planning'",[leaseId,fence,sequence]);
      await client.query("UPDATE sloptogether.story_producers SET last_sequence=$2,lease_expires_at=now()+interval '90 seconds' WHERE id=$1",[leaseId,sequence]);
      sequence++;
    }
    const idempotencyKey=randomUUID();const claimToken=randomUUID();const sceneSeed=randomUUID();
    const context=await client.query<{story_world_prompt:string;recent_story_summary:string;recent_dialogue:string}>(
      `SELECT c.story_world_prompt,
        coalesce((SELECT sr.prompt FROM sloptogether.segment_revisions sr JOIN sloptogether.segments s ON s.id=sr.segment_id WHERE s.twitch_channel_id=c.twitch_channel_id AND sr.state IN ('ready','played') ORDER BY s.ordinal DESC LIMIT 1),'' ) AS recent_story_summary,
        coalesce((SELECT sr.dialogue FROM sloptogether.segment_revisions sr JOIN sloptogether.segments s ON s.id=sr.segment_id WHERE s.twitch_channel_id=c.twitch_channel_id AND sr.state IN ('ready','played') ORDER BY s.ordinal DESC LIMIT 1),'') AS recent_dialogue
       FROM sloptogether.channels c WHERE c.twitch_channel_id=$1`,[channel.twitch_channel_id]);
    const row=context.rows[0]!;
    const interrupt=await client.query<{id:string;subscriber_label:string;plan_payload:Record<string,unknown>}>(`SELECT ir.id,ir.subscriber_label,ir.plan_payload FROM sloptogether.interrupt_requests ir
      JOIN sloptogether.subscription_events se ON se.id=ir.trigger_event_id
      JOIN sloptogether.funding_authorizations f ON f.id=ir.funding_id AND f.state='reserved'
      WHERE ir.broadcaster_twitch_id=$1 AND ir.program_state='queued' AND ir.expires_at>now()
        AND ($2::jsonb->>'enabled')::boolean=true
        AND EXISTS(SELECT 1 FROM sloptogether.sessions sess WHERE sess.twitch_user_id=$3 AND sess.revoked_at IS NULL AND sess.expires_at>now()
          AND sess.granted_scopes @> ARRAY['channel:read:subscriptions']::text[])
        AND (se.twitch_actor_id IS NULL OR NOT EXISTS(SELECT 1 FROM sloptogether.bans b WHERE b.twitch_user_id=se.twitch_actor_id
          AND b.revoked_at IS NULL AND (b.expires_at IS NULL OR b.expires_at>now()) AND (b.scope='global' OR b.twitch_channel_id=$1)))
      ORDER BY ir.created_at,ir.id LIMIT 1 FOR UPDATE OF ir SKIP LOCKED`,
      [channel.twitch_channel_id,JSON.stringify(current.rows[0]!.subscriber_interrupt_policy),channel.owner_twitch_user_id]);
    const queued=interrupt.rows[0];
    if(!queued){
      const blocked=await ownerAttemptBudgetBlock(client,channel.twitch_channel_id,current.rows[0]!.owner_budget_cap_usd);
      if(blocked)throw new ApiError(409,blocked);
    }
    const inputPayload={theme:row.story_world_prompt,recentStorySummary:row.recent_story_summary,recentDialogue:row.recent_dialogue,sceneSeed,
      ...(queued?{interruptId:queued.id,subscriberLabel:queued.subscriber_label}:{} )};
    await client.query(`INSERT INTO sloptogether.story_plan_attempts(twitch_channel_id,producer_id,producer_fence,sequence,idempotency_key,expected_channel_revision,input_payload,claim_token,claim_expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,now()+interval '60 seconds')`,[channel.twitch_channel_id,leaseId,fence,sequence,idempotencyKey,channel.policy_revision,JSON.stringify(inputPayload),claimToken]);
    if(queued){
      await client.query("UPDATE sloptogether.interrupt_requests SET program_state='planning' WHERE id=$1 AND program_state='queued'",[queued.id]);
      await client.query("UPDATE sloptogether.outbox SET delivered_at=now(),leased_until=NULL WHERE aggregate_id=$1 AND event_kind='subscriber_interrupt.plan' AND delivered_at IS NULL",[queued.id]);
    }
    await client.query("UPDATE sloptogether.story_producers SET lease_expires_at=now()+interval '90 seconds' WHERE id=$1",[leaseId]);
    return {leaseId,fence,sequence,idempotencyKey,claimToken,interruptId:queued?.id,storyContext:{taskKind:queued?"subscriber_interrupt":"story",channelTheme:row.story_world_prompt,recentStorySummary:row.recent_story_summary,recentDialogue:row.recent_dialogue,subscriberLabel:queued?.subscriber_label,sceneSeed}};
  });
}

async function scheduleSubscriberInterrupt(channel:ChannelRow,actor:string,keyId:string,body:StoryProposal,prompt:string,screen:InputPreflightResult,
  preview:{boundary_id:string;resolution_id:string|null;source_revision_id:string;source_segment_id:string}){
  const interruptId=body.interruptId;
  if(!interruptId)throw new ApiError(400,"subscriber_interrupt_id_required");
  return transaction(async client=>{
    const policy=await client.query<{policy_revision:number;subscriber_interrupt_policy:Record<string,unknown>;output_width:number;output_height:number}>(
      "SELECT policy_revision,subscriber_interrupt_policy,output_width,output_height FROM sloptogether.channels WHERE twitch_channel_id=$1 AND is_enabled FOR UPDATE",[channel.twitch_channel_id]);
    const current=policy.rows[0];
    if(!current||current.policy_revision!==channel.policy_revision)throw new ApiError(409,"channel_policy_changed");
    if(current.subscriber_interrupt_policy.enabled!==true)throw new ApiError(409,"subscriber_interrupts_disabled");
    const lease=await client.query<{id:string;fence:string;lease_expires_at:Date;last_sequence:string}>(
      "SELECT id,fence,lease_expires_at,last_sequence FROM sloptogether.story_producers WHERE id=$1 AND twitch_channel_id=$2 AND released_at IS NULL FOR UPDATE",[body.leaseId,channel.twitch_channel_id]);
    const owner=lease.rows[0];
    if(!owner||Number(owner.fence)!==body.fence||owner.lease_expires_at.getTime()<=Date.now())throw new ApiError(409,"story_producer_lease_fenced");
    if(body.sequence<=Number(owner.last_sequence))throw new ApiError(409,"story_sequence_replayed");
    const planned=await client.query<{expected_channel_revision:number;input_payload:{interruptId?:string}}>(
      "SELECT expected_channel_revision,input_payload FROM sloptogether.story_plan_attempts WHERE producer_id=$1 AND producer_fence=$2 AND sequence=$3 AND idempotency_key=$4 AND claim_token=$5 AND claim_expires_at>now() AND status='planning' FOR UPDATE",
      [body.leaseId,body.fence,body.sequence,body.idempotencyKey,body.claimToken]);
    if(!planned.rows[0]||planned.rows[0].expected_channel_revision!==current.policy_revision||planned.rows[0].input_payload.interruptId!==interruptId)
      throw new ApiError(409,"story_plan_attempt_not_current");
    const request=await client.query<{funding_id:string;expires_at:Date;trigger_event_id:string;subscriber_label:string;event_actor_id:string|null}>(
      `SELECT ir.funding_id,ir.expires_at,ir.trigger_event_id,ir.subscriber_label,se.twitch_actor_id AS event_actor_id
       FROM sloptogether.interrupt_requests ir JOIN sloptogether.subscription_events se ON se.id=ir.trigger_event_id
       JOIN sloptogether.funding_authorizations f ON f.id=ir.funding_id AND f.state='reserved' AND f.source='owner_budget'
       WHERE ir.id=$1 AND ir.broadcaster_twitch_id=$2 AND ir.program_state='planning' AND ir.expires_at>now() FOR UPDATE OF ir,f`,[interruptId,channel.twitch_channel_id]);
    const alert=request.rows[0];if(!alert)throw new ApiError(409,"subscriber_interrupt_expired_or_unfunded");
    if(alert.event_actor_id&&await isBanned(channel.twitch_channel_id,alert.event_actor_id))throw new ApiError(403,"channel_ban_active");
    const boundary=await client.query<{boundary_id:string|null;resolution_id:string|null;revision_id:string;segment_id:string;frame_asset_id:string|null}>(`SELECT coalesce(r.requested_end_boundary_revision_id,er.resolved_end_boundary_revision_id) AS boundary_id,
        CASE WHEN r.requested_end_boundary_revision_id IS NULL THEN er.id ELSE NULL END AS resolution_id,r.id AS revision_id,s.id AS segment_id,frame.asset_id AS frame_asset_id
      FROM sloptogether.branches b JOIN sloptogether.segments s ON s.branch_id=b.id JOIN sloptogether.segment_revisions r ON r.id=s.selected_revision_id
      LEFT JOIN LATERAL(SELECT id,resolved_end_boundary_revision_id FROM sloptogether.endpoint_resolutions WHERE segment_revision_id=r.id AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1) er ON true
      LEFT JOIN sloptogether.boundary_revisions frame ON frame.id=coalesce(r.requested_end_boundary_revision_id,er.resolved_end_boundary_revision_id)
      WHERE b.twitch_channel_id=$1 AND b.is_selected AND b.archived_at IS NULL AND r.state IN ('selected','locked','ready','played')
      ORDER BY s.ordinal DESC LIMIT 1 FOR UPDATE OF s`,[channel.twitch_channel_id]);
    const latest=boundary.rows[0];
    if(!latest?.boundary_id||latest.boundary_id!==preview.boundary_id||latest.resolution_id!==(preview.resolution_id??null)){
      await client.query("UPDATE sloptogether.story_plan_attempts SET status='failed',claim_token=NULL,claim_expires_at=NULL,updated_at=now() WHERE producer_id=$1 AND producer_fence=$2 AND sequence=$3 AND status='planning'",[body.leaseId,body.fence,body.sequence]);
      await client.query("UPDATE sloptogether.story_producers SET last_sequence=$2,lease_expires_at=now()+interval '90 seconds' WHERE id=$1",[body.leaseId,body.sequence]);
      await client.query("UPDATE sloptogether.interrupt_requests SET program_state='queued' WHERE id=$1 AND program_state='planning'",[interruptId]);
      return {accepted:false,retryable:true,reason:"story_boundary_changed"};
    }
    if(latest.revision_id!==preview.source_revision_id||latest.segment_id!==preview.source_segment_id)
      throw new ApiError(409,"story_boundary_changed");
    const input=await client.query<{id:string}>("SELECT id FROM sloptogether.input_screens WHERE twitch_channel_id=$1 AND input_sha256=$2 AND effective_state='clear' AND (expires_at IS NULL OR expires_at>now()) ORDER BY created_at DESC LIMIT 1",[channel.twitch_channel_id,Buffer.from(screen.digest,"hex")]);
    if(!input.rows[0])throw new ApiError(409,"story_input_screen_expired");
    const frame=await client.query(`SELECT 1 FROM sloptogether.boundary_revisions b JOIN sloptogether.assets a ON a.id=b.asset_id
      WHERE b.id=$1 AND b.twitch_channel_id=$2 AND b.retired_at IS NULL AND a.status IN ('approved','published') AND a.media_kind='image' FOR SHARE OF b,a`,[latest.boundary_id,channel.twitch_channel_id]);
    if(!frame.rowCount)throw new ApiError(409,"story_start_boundary_not_approved");
    const jobId=randomUUID(),attemptId=randomUUID();
    if(!latest.frame_asset_id)throw new ApiError(409,"story_start_boundary_not_approved");
    const planningPayload={inputScreenId:input.rows[0].id,prompt,startBoundaryRevisionId:latest.boundary_id,
      startFrameAssetId:latest.frame_asset_id,outputWidth:current.output_width,outputHeight:current.output_height,subscriberLabel:alert.subscriber_label};
    await client.query(`INSERT INTO sloptogether.jobs(id,twitch_channel_id,segment_revision_id,interrupt_id,stage,execution_mode,state,recipe_id,recipe_sha256,input_sha256,requested_by,funding_id,dependency_resolution_id,planning_payload,priority,result_deadline_at)
      VALUES($1,$2,$3,$4,'video_base','pull_worker','ready','fast-h3-trim-5step-vsa20-b1',$5,$6,$7,$8,$9,$10::jsonb,100,$11)`,
      [jobId,channel.twitch_channel_id,latest.revision_id,interruptId,Buffer.from("9a2d5d19fb22b7e55d29c8e6048c4c421c5b73b044b7cc010188efe7df9ccaef","hex"),Buffer.from(screen.digest,"hex"),channel.owner_twitch_user_id,alert.funding_id,latest.resolution_id,JSON.stringify(planningPayload),alert.expires_at]);
    if(latest.resolution_id)await client.query("INSERT INTO sloptogether.endpoint_resolution_dependencies(resolution_id,dependent_job_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[latest.resolution_id,jobId]);
    await client.query(`INSERT INTO sloptogether.job_attempts(id,job_id,attempt_number,fence,client_idempotency_key,state,attempt_deadline_at,input_sha256,funding_id)
      VALUES($1,$2,1,1,$3,'ready',$4,$5,$6)`,[attemptId,jobId,`job:${jobId}:attempt:1`,alert.expires_at,Buffer.from(screen.digest,"hex"),alert.funding_id]);
    await client.query("UPDATE sloptogether.interrupt_requests SET program_state='rendering',job_id=$2,plan_payload=$3::jsonb WHERE id=$1 AND program_state='planning'",[interruptId,jobId,JSON.stringify({kind:"subscriber_interrupt",prompt,plan:body.plan,subscriberLabel:alert.subscriber_label,screenId:input.rows[0].id})]);
    await client.query("UPDATE sloptogether.subscription_events SET state='rendering' WHERE id=$1 AND state='queued'",[alert.trigger_event_id]);
    await client.query("UPDATE sloptogether.story_producers SET last_sequence=$2,lease_expires_at=now()+interval '90 seconds' WHERE id=$1",[body.leaseId,body.sequence]);
    await client.query("UPDATE sloptogether.story_plan_attempts SET plan_payload=$2::jsonb,compiled_prompt=$3,screen_id=$4,status='rendering',claim_token=NULL,claim_expires_at=NULL,updated_at=now() WHERE producer_id=$1 AND sequence=$5 AND producer_fence=$6 AND claim_token=$7",
      [body.leaseId,JSON.stringify({...body.plan,plannerUsage:body.plannerUsage??null}),prompt,input.rows[0].id,body.sequence,body.fence,body.claimToken]);
    await client.query(`INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,actor_key_id,action,target_kind,target_id,after_state)
      VALUES($1,$2,$3,'subscriber_interrupt.render_requested','interrupt_request',$4,$5::jsonb)`,[channel.twitch_channel_id,actor,keyId,interruptId,JSON.stringify({jobId,sourceRevisionId:latest.revision_id,inputScreenId:input.rows[0].id})]);
    return {accepted:true,interruptId,jobId,state:"rendering"};
  });
}

export async function submitStoryProposal(locator:string,request:Request){
  const channel=await findChannel(locator);const grant=await requireWorker(request,"story:write_future");
  if(grant.channelId!==channel.twitch_channel_id||grant.issuingTwitchUserId!==channel.owner_twitch_user_id)throw new ApiError(403,"story_producer_owner_key_required");
  if(await isBanned(channel.twitch_channel_id,grant.issuingTwitchUserId))throw new ApiError(403,"channel_ban_active");
  const body=await readJson(request,(await import("@sloptogether/contracts")).storyProposalSchema);
  const canonicalPrompt=compileH3StoryPrompt(body.plan);
  if(body.compiledH3Prompt!==canonicalPrompt)throw new ApiError(400,"compiled_story_prompt_mismatch");
  const prompt=canonicalPrompt;
  const previewBoundary=await query<{boundary_id:string;resolution_id:string|null;source_revision_id:string;source_segment_id:string}>(`SELECT coalesce(r.requested_end_boundary_revision_id,er.resolved_end_boundary_revision_id) AS boundary_id,
      r.id AS source_revision_id,s.id AS source_segment_id,
      CASE WHEN r.requested_end_boundary_revision_id IS NULL THEN er.id ELSE NULL END AS resolution_id
    FROM sloptogether.branches b JOIN sloptogether.segments s ON s.branch_id=b.id JOIN sloptogether.segment_revisions r ON r.id=s.selected_revision_id
    LEFT JOIN LATERAL(SELECT id,resolved_end_boundary_revision_id FROM sloptogether.endpoint_resolutions WHERE segment_revision_id=r.id AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1) er ON true
    WHERE b.twitch_channel_id=$1 AND b.is_selected=true AND b.archived_at IS NULL AND r.state IN ('selected','locked','ready','played')
    ORDER BY s.ordinal DESC LIMIT 1`,[channel.twitch_channel_id]);
  const previewBoundaryId=previewBoundary.rows[0]?.boundary_id;
  if(!previewBoundaryId)throw new ApiError(409,"story_start_boundary_missing");
  const startImage=await readApprovedBoundaryImage(channel.twitch_channel_id,previewBoundaryId);
  const screen=await screenPromptAndImages({channelId:channel.twitch_channel_id,prompt,images:[startImage]});
  if(screen.decision!=="clear")throw new ApiError(422,"story_plan_held");
  if(body.interruptId)return scheduleSubscriberInterrupt(channel,grant.issuingTwitchUserId,grant.keyId,body,prompt,screen,previewBoundary.rows[0]!);
  return transaction(async client=>{
    const policy=await client.query<{policy_revision:number;owner_budget_cap_usd:string}>("SELECT policy_revision,owner_budget_cap_usd FROM sloptogether.channels WHERE twitch_channel_id=$1 AND is_enabled FOR UPDATE",[channel.twitch_channel_id]);
    const currentPolicy=policy.rows[0];if(!currentPolicy||currentPolicy.policy_revision!==channel.policy_revision)throw new ApiError(409,"channel_policy_changed");
    const lease=await client.query<{id:string;fence:string;lease_expires_at:Date;last_sequence:string}>("SELECT id,fence,lease_expires_at,last_sequence FROM sloptogether.story_producers WHERE id=$1 AND twitch_channel_id=$2 AND released_at IS NULL FOR UPDATE",[body.leaseId,channel.twitch_channel_id]);
    const row=lease.rows[0];if(!row||Number(row.fence)!==body.fence||row.lease_expires_at.getTime()<=Date.now())throw new ApiError(409,"story_producer_lease_fenced");
    if(body.sequence<=Number(row.last_sequence))throw new ApiError(409,"story_sequence_replayed");
    const planned=await client.query<{id:string;expected_channel_revision:number;input_payload:{interruptId?:string}}>("SELECT id,expected_channel_revision,input_payload FROM sloptogether.story_plan_attempts WHERE producer_id=$1 AND producer_fence=$2 AND sequence=$3 AND idempotency_key=$4 AND claim_token=$5 AND claim_expires_at>now() AND status='planning' FOR UPDATE",[body.leaseId,body.fence,body.sequence,body.idempotencyKey,body.claimToken]);
    if(!planned.rows[0]||planned.rows[0].expected_channel_revision!==currentPolicy.policy_revision)throw new ApiError(409,"story_plan_attempt_not_current");
    if(planned.rows[0].input_payload.interruptId)throw new ApiError(409,"story_plan_interrupt_binding_mismatch");
    const quote=reservationUsd("SLOPTOGETHER_GENERATION_ATTEMPT_RESERVATION_USD");
    if(quote===null||Number(currentPolicy.owner_budget_cap_usd)<=0)throw new ApiError(409,"owner_generation_budget_unavailable");
    const spent=await client.query<{total:string}>(`SELECT coalesce(sum(greatest(reserved_usd,coalesce(actual_cost_usd,0))),0)::text AS total
      FROM sloptogether.funding_authorizations WHERE twitch_channel_id=$1 AND source='owner_budget' AND state<>'released'`,[channel.twitch_channel_id]);
    if(Number(spent.rows[0]?.total??0)+quote>Number(currentPolicy.owner_budget_cap_usd))throw new ApiError(409,"owner_generation_budget_exhausted");
    const branch=await client.query<{id:string}>("SELECT id FROM sloptogether.branches WHERE twitch_channel_id=$1 AND is_selected=true AND archived_at IS NULL FOR UPDATE",[channel.twitch_channel_id]);
    if(!branch.rows[0])throw new ApiError(409,"selected_branch_unavailable");
    const last=await client.query<{id:string;ordinal:string;state:string;selected_revision_id:string|null;protected_at:Date|null}>("SELECT id,ordinal::text,state,selected_revision_id,protected_at FROM sloptogether.segments WHERE branch_id=$1 ORDER BY ordinal DESC LIMIT 1 FOR UPDATE",[branch.rows[0].id]);
    const tail=last.rows[0];let reuseSegmentId:string|null=null;let ordinal=Number(tail?.ordinal??-1)+1;
    if(tail&&(tail.state==="open"||tail.state==="voting")&&!tail.selected_revision_id&&!tail.protected_at){
      const proposals=await client.query<{count:string}>("SELECT count(*)::text AS count FROM sloptogether.proposals p JOIN sloptogether.elections e ON e.id=p.election_id WHERE e.segment_id=$1 AND p.state NOT IN ('rejected','withdrawn','superseded')",[tail.id]);
      if(Number(proposals.rows[0]?.count??0)>0)throw new ApiError(409,"story_slot_has_community_proposals","The next slot has community proposals; let its vote resolve before the story producer appends.");
      reuseSegmentId=tail.id;ordinal=Number(tail.ordinal);
    }else if(tail&&(tail.state==="open"||tail.state==="voting")&&!tail.selected_revision_id&&tail.protected_at){
      throw new ApiError(409,"story_slot_is_held","The broadcaster has held the next story slot.");
    }
    const endpoint=await client.query<{boundary_id:string|null;resolution_id:string|null}>(`SELECT coalesce(r.requested_end_boundary_revision_id,er.resolved_end_boundary_revision_id) AS boundary_id,
        CASE WHEN r.requested_end_boundary_revision_id IS NULL THEN er.id ELSE NULL END AS resolution_id
      FROM sloptogether.segments s JOIN sloptogether.segment_revisions r ON r.id=s.selected_revision_id
      LEFT JOIN LATERAL(SELECT id,resolved_end_boundary_revision_id FROM sloptogether.endpoint_resolutions WHERE segment_revision_id=r.id AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1) er ON true
      WHERE s.branch_id=$1 AND r.state IN ('selected','locked','ready','played') ORDER BY s.ordinal DESC LIMIT 1`,[branch.rows[0].id]);
    const startBoundary=endpoint.rows[0]?.boundary_id;const resolutionId=endpoint.rows[0]?.resolution_id??null;
    if(!startBoundary||startBoundary!==previewBoundaryId||resolutionId!==(previewBoundary.rows[0]?.resolution_id??null))throw new ApiError(409,"story_start_boundary_changed");
    const activeBoundary=await client.query(`SELECT 1 FROM sloptogether.boundary_revisions b JOIN sloptogether.assets a ON a.id=b.asset_id
      WHERE b.id=$1 AND b.twitch_channel_id=$2 AND b.retired_at IS NULL AND a.status IN ('approved','published') AND a.media_kind='image' FOR SHARE OF b,a`,[startBoundary,channel.twitch_channel_id]);
    if(!activeBoundary.rowCount)throw new ApiError(409,"story_start_boundary_not_approved");
    const segment=reuseSegmentId
      ?{rows:[{id:reuseSegmentId}]}
      :await client.query<{id:string}>("INSERT INTO sloptogether.segments(twitch_channel_id,branch_id,ordinal,state) VALUES($1,$2,$3,'selected') RETURNING id",[channel.twitch_channel_id,branch.rows[0].id,ordinal]);
    const revisionNumber=await client.query<{revision:number}>("SELECT coalesce(max(revision),0)+1 AS revision FROM sloptogether.segment_revisions WHERE segment_id=$1",[segment.rows[0]!.id]);
    const revision=await client.query<{id:string}>(
      "INSERT INTO sloptogether.segment_revisions(segment_id,revision,prompt,visual_prompt,dialogue,start_boundary_revision_id,planning_mode,provider_recipe_id,input_sha256,requested_by,state) VALUES($1,$2,$3,$4,$5,$6,'continuation','fast-h3-trim-5step-vsa20-b1',$7,$8,'locked') RETURNING id",
      [segment.rows[0]!.id,revisionNumber.rows[0]!.revision,prompt,body.plan.visualAction,body.plan.dialogue,startBoundary,Buffer.from(screen.digest,"hex"),grant.issuingTwitchUserId]);
    const screened=await client.query<{id:string}>("SELECT id FROM sloptogether.input_screens WHERE twitch_channel_id=$1 AND input_sha256=$2 AND effective_state='clear' AND (expires_at IS NULL OR expires_at>now()) ORDER BY created_at DESC LIMIT 1",[channel.twitch_channel_id,Buffer.from(screen.digest,"hex")]);
    if(!screened.rows[0])throw new ApiError(409,"story_input_screen_expired");
    const jobId=randomUUID();const fundingId=randomUUID();const attemptId=randomUUID();
    await client.query("INSERT INTO sloptogether.funding_authorizations(id,twitch_channel_id,source,purchaser_twitch_user_id,action_intent_id,reserved_usd,state) VALUES($1,$2,'owner_budget',$3,$4,$5,'reserved')",[fundingId,channel.twitch_channel_id,channel.owner_twitch_user_id,jobId,quote]);
    await client.query(`INSERT INTO sloptogether.jobs(id,twitch_channel_id,segment_revision_id,stage,execution_mode,state,recipe_id,recipe_sha256,input_sha256,requested_by,funding_id,dependency_resolution_id,planning_payload,result_deadline_at)
      VALUES($1,$2,$3,'video_base','pull_worker','ready','fast-h3-trim-5step-vsa20-b1',$4,$5,$6,$7,$8,$9::jsonb,now()+interval '45 minutes')`,
      [jobId,channel.twitch_channel_id,revision.rows[0]!.id,Buffer.from("9a2d5d19fb22b7e55d29c8e6048c4c421c5b73b044b7cc010188efe7df9ccaef","hex"),Buffer.from(screen.digest,"hex"),grant.issuingTwitchUserId,fundingId,resolutionId,JSON.stringify({inputScreenId:screened.rows[0].id})]);
    if(resolutionId)await client.query("INSERT INTO sloptogether.endpoint_resolution_dependencies(resolution_id,dependent_job_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[resolutionId,jobId]);
    await client.query(`INSERT INTO sloptogether.job_attempts(id,job_id,attempt_number,fence,client_idempotency_key,state,attempt_deadline_at,input_sha256,funding_id)
      VALUES($1,$2,1,1,$3,'ready',now()+interval '45 minutes',$4,$5)`,[attemptId,jobId,`job:${jobId}:attempt:1`,Buffer.from(screen.digest,"hex"),fundingId]);
    await client.query("UPDATE sloptogether.segments SET selected_revision_id=$2,state='rendering',protected_at=now() WHERE id=$1",[segment.rows[0]!.id,revision.rows[0]!.id]);
    await client.query("UPDATE sloptogether.story_producers SET last_sequence=$2,lease_expires_at=now()+interval '90 seconds' WHERE id=$1",[body.leaseId,body.sequence]);
    await client.query("UPDATE sloptogether.story_plan_attempts SET plan_payload=$2::jsonb,compiled_prompt=$3,screen_id=$4,resulting_segment_id=$5,status=$6,claim_token=NULL,claim_expires_at=NULL,updated_at=now() WHERE producer_id=$1 AND sequence=$7 AND producer_fence=$8 AND claim_token=$9",
      [body.leaseId,JSON.stringify({...body.plan,plannerUsage:body.plannerUsage??null}),prompt,screened.rows[0].id,segment.rows[0]!.id,"rendering",body.sequence,body.fence,body.claimToken]);
    await client.query("INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,actor_key_id,action,target_kind,target_id,after_state) VALUES($1,$2,$3,'story.producer.append','segment',$4,$5::jsonb)",[channel.twitch_channel_id,grant.issuingTwitchUserId,grant.keyId,segment.rows[0]!.id,JSON.stringify({revisionId:revision.rows[0]!.id,jobId,sequence:body.sequence})]);
    return {accepted:true,segmentId:segment.rows[0]!.id,revisionId:revision.rows[0]!.id,jobScheduled:Boolean(jobId)};
  });
}
