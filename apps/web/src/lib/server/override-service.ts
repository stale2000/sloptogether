import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { streamerOverrideSchema, type StreamerOverride } from "@sloptogether/contracts";
import { transaction, query } from "./db";
import { ApiError, assertSameOrigin, readJson } from "./http";
import { findChannel, isBanned, requireChannelModerator, requireStreamerController } from "./channels";
import { requestPrincipal } from "./principals";
import { screenPromptAndImages, type InputPreflightResult } from "./preflight";
import { signedPrivateReadUrl } from "./storage";
import { abandonStoryProducerPlans, lockRevokedWorkerSegments, retireRevokedWorkerJobs } from "./worker-revocation";
import { cancelPendingInterrupts } from "./subscriber-service";
import { reservationUsd } from "./reservation";
import { BASE_GENERATION_SIZE } from "./generation-profile";
import { getDefaultStreamId } from "./stream-service";

type Segment = {id:string;branch_id:string;ordinal:string;state:string;selected_revision_id:string|null;protected_at:Date|null};
type Revision = {id:string;segment_id:string;revision:number;prompt:string;visual_prompt:string|null;dialogue:string|null;start_boundary_revision_id:string;requested_end_boundary_revision_id:string|null;planning_mode:"planned_anchors"|"continuation";provider_recipe_id:string;seed:string|null;target_funding_id:string|null;input_sha256:Buffer;state:string};
const contentActions=new Set(["select_proposal","replace_future_prompt","replace_future_boundary","unlock_future","hold","resume"]);
const fencingActions=new Set(["replace_future_prompt","replace_future_boundary","unlock_future","hold"]);

function commandFrom(raw:Record<string,unknown>):StreamerOverride{
  const aliases:Record<string,string>={replace_prompt:"replace_future_prompt",set_candidate:"select_proposal",override_vote:"select_proposal",hold_segment:"hold",skip_segment:"skip_program_item"};
  const value={...raw};
  if(value.timelineRevision===undefined&&value.expectedTimelineRevision!==undefined)value.timelineRevision=value.expectedTimelineRevision;
  delete value.expectedTimelineRevision;
  if(typeof value.action==="string")value.action=aliases[value.action]??value.action;
  return streamerOverrideSchema.parse(value);
}

function digest(value:unknown){return createHash("sha256").update(JSON.stringify(value)).digest();}

export async function schedulePulledGeneration(client:PoolClient,channelId:string,revisionId:string,requestedBy:string,inputScreenId:string,reserveOwnerBudget:boolean){
  const revision=await client.query<{segment_id:string;planning_mode:string;provider_recipe_id:string;input_sha256:Buffer;start_boundary_revision_id:string;requested_end_boundary_revision_id:string|null}>(
    "SELECT segment_id,planning_mode,provider_recipe_id,input_sha256,start_boundary_revision_id,requested_end_boundary_revision_id FROM sloptogether.segment_revisions WHERE id=$1 FOR UPDATE",[revisionId]);
  const row=revision.rows[0];if(!row)throw new ApiError(404,"generation_revision_not_found");
  if(row.planning_mode==="planned_anchors"&&!row.requested_end_boundary_revision_id)throw new ApiError(409,"end_boundary_required");
  const screen=await client.query("SELECT 1 FROM sloptogether.input_screens WHERE id=$1 AND twitch_channel_id=$2 AND effective_state='clear' AND (expires_at IS NULL OR expires_at>now())",[inputScreenId,channelId]);
  if(!screen.rowCount)throw new ApiError(409,"generation_input_not_clear");
  const boundaries=[...new Set([row.start_boundary_revision_id,...(row.requested_end_boundary_revision_id?[row.requested_end_boundary_revision_id]:[])])];
  const validFrames=await client.query<{count:string}>(`SELECT count(*)::text AS count FROM sloptogether.boundary_revisions b JOIN sloptogether.assets a ON a.id=b.asset_id
    WHERE b.id=ANY($1::uuid[]) AND b.twitch_channel_id=$2 AND b.retired_at IS NULL AND a.media_kind='image' AND a.status IN ('approved','published')`,[boundaries,channelId]);
  if(Number(validFrames.rows[0]?.count??0)!==boundaries.length)throw new ApiError(409,"generation_boundary_not_approved");
  const existing=await client.query<{id:string}>("SELECT id FROM sloptogether.jobs WHERE segment_revision_id=$1 AND stage='video_base' AND state NOT IN ('failed','cancelled','expired') LIMIT 1",[revisionId]);
  if(existing.rows[0]){
    await client.query("UPDATE sloptogether.segments SET state='rendering',protected_at=coalesce(protected_at,now()) WHERE id=$1 AND selected_revision_id=$2",[row.segment_id,revisionId]);
    return existing.rows[0].id;
  }
  const jobId=randomUUID();
  let fundingId:string|null=null;
  if(reserveOwnerBudget){
    const quote=reservationUsd("SLOPTOGETHER_GENERATION_ATTEMPT_RESERVATION_USD");
    const budget=await client.query<{cap:string}>("SELECT owner_budget_cap_usd::text AS cap FROM sloptogether.channels WHERE twitch_channel_id=$1 FOR UPDATE",[channelId]);
    if(quote===null||Number(budget.rows[0]?.cap??0)<=0)throw new ApiError(409,"owner_generation_budget_unavailable");
    const spent=await client.query<{total:string}>(`SELECT coalesce(sum(greatest(reserved_usd,coalesce(actual_cost_usd,0))),0)::text AS total FROM sloptogether.funding_authorizations
      WHERE twitch_channel_id=$1 AND source='owner_budget' AND state<>'released'`,[channelId]);
    if(Number(spent.rows[0]?.total??0)+quote>Number(budget.rows[0]!.cap))throw new ApiError(409,"owner_generation_budget_exhausted");
    fundingId=randomUUID();
    await client.query("INSERT INTO sloptogether.funding_authorizations(id,twitch_channel_id,source,purchaser_twitch_user_id,action_intent_id,reserved_usd,state) VALUES($1,$2,'owner_budget',$3,$4,$5,'reserved')",[fundingId,channelId,requestedBy,jobId,quote]);
  }
  const attemptId=randomUUID();
  const dependency=await client.query<{id:string}>("SELECT id FROM sloptogether.endpoint_resolutions WHERE resolved_end_boundary_revision_id=$1 AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1",[row.start_boundary_revision_id]);
  await client.query(`INSERT INTO sloptogether.jobs(id,twitch_channel_id,segment_revision_id,stage,execution_mode,state,recipe_id,recipe_sha256,input_sha256,requested_by,funding_id,dependency_resolution_id,planning_payload,result_deadline_at)
    VALUES($1,$2,$3,'video_base','pull_worker','ready',$4,$5,$6,$7,$8,$9,$10::jsonb,now()+interval '45 minutes')`,
    [jobId,channelId,revisionId,row.provider_recipe_id,Buffer.from("9a2d5d19fb22b7e55d29c8e6048c4c421c5b73b044b7cc010188efe7df9ccaef","hex"),row.input_sha256,requestedBy,fundingId,dependency.rows[0]?.id??null,JSON.stringify({inputScreenId,...BASE_GENERATION_SIZE})]);
  if(dependency.rows[0])await client.query("INSERT INTO sloptogether.endpoint_resolution_dependencies(resolution_id,dependent_job_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[dependency.rows[0].id,jobId]);
  await client.query(`INSERT INTO sloptogether.job_attempts(id,job_id,attempt_number,fence,client_idempotency_key,state,attempt_deadline_at,input_sha256,funding_id)
    VALUES($1,$2,1,1,$3,'ready',now()+interval '45 minutes',$4,$5)`,[attemptId,jobId,`job:${jobId}:attempt:1`,row.input_sha256,fundingId]);
  await client.query("UPDATE sloptogether.segments SET state='rendering',protected_at=coalesce(protected_at,now()) WHERE id=$1 AND selected_revision_id=$2",[row.segment_id,revisionId]);
  return jobId;
}

async function frame(channelId:string,boundaryId:string){
  const result=await query<{storage_key:string;content_type:string|null;byte_size:string|null}>(
    `SELECT a.storage_key,a.content_type,a.byte_size FROM sloptogether.boundary_revisions b
     JOIN sloptogether.assets a ON a.id=b.asset_id
     WHERE b.id=$1 AND b.twitch_channel_id=$2 AND b.retired_at IS NULL
       AND a.status IN ('validated','approved','published') AND a.media_kind='image'`,[boundaryId,channelId]);
  const row=result.rows[0];
  if(!row||!row.content_type||!["image/png","image/jpeg","image/webp"].includes(row.content_type))throw new ApiError(422,"boundary_image_not_validated");
  const limit=16*1024*1024;
  if(row.byte_size&&Number(row.byte_size)>limit)throw new ApiError(413,"image_too_large");
  const response=await fetch(await signedPrivateReadUrl(row.storage_key,60),{cache:"no-store",signal:AbortSignal.timeout(5000)});
  if(!response.ok||!response.body)throw new ApiError(503,"boundary_image_unavailable");
  const reader=response.body.getReader();const chunks:Buffer[]=[];let size=0;
  for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>limit){await reader.cancel();throw new ApiError(413,"image_too_large");}chunks.push(Buffer.from(next.value));}
  return {bytes:Buffer.concat(chunks),contentType:row.content_type};
}

async function proposedReplacement(channelId:string,body:StreamerOverride):Promise<{base:Revision;screen:InputPreflightResult;startBoundary:string;prompt:string}|null>{
  if(body.action!=="replace_future_prompt"&&body.action!=="replace_future_boundary")return null;
  const result=await query<Revision>(
    `SELECT sr.* FROM sloptogether.segment_revisions sr JOIN sloptogether.segments s ON s.id=sr.segment_id
     WHERE s.twitch_channel_id=$1 AND (($2::uuid IS NOT NULL AND sr.id=$2) OR ($2::uuid IS NULL AND s.id=$3 AND sr.id=s.selected_revision_id)) LIMIT 1`,
    [channelId,body.segmentRevisionId??null,body.targetSegmentId??null]);
  const base=result.rows[0];if(!base)throw new ApiError(422,"selected_revision_required","Select a reviewed scene with a start frame before replacing its input.");
  const prompt=body.action==="replace_future_prompt"?body.prompt:base.prompt;
  const startBoundary=body.action==="replace_future_boundary"?body.boundaryRevisionId:base.start_boundary_revision_id;
  if(!prompt)throw new ApiError(422,"replacement_prompt_required");
  if(!startBoundary)throw new ApiError(422,"replacement_boundary_required");
  const boundaries=[...new Set([startBoundary,base.requested_end_boundary_revision_id].filter((id):id is string=>Boolean(id)))];
  const images=await Promise.all(boundaries.map(id=>frame(channelId,id)));
  const screen=await screenPromptAndImages({channelId,prompt,images});
  if(screen.decision!=="clear")throw new ApiError(409,"replacement_input_held","The replacement input needs a moderation decision before it can be selected.");
  return {base,screen,startBoundary,prompt};
}

async function targetSegment(client:PoolClient,channelId:string,body:StreamerOverride):Promise<Segment|null>{
  const result=await client.query<Segment>(
    `SELECT s.id,s.branch_id,s.ordinal,s.state,s.selected_revision_id,s.protected_at FROM sloptogether.segments s
     WHERE s.twitch_channel_id=$1 AND (
       s.id=$2::uuid OR EXISTS(SELECT 1 FROM sloptogether.segment_revisions sr WHERE sr.id=$3::uuid AND sr.segment_id=s.id)
       OR EXISTS(SELECT 1 FROM sloptogether.proposals p JOIN sloptogether.elections e ON e.id=p.election_id WHERE p.id=$4::uuid AND e.segment_id=s.id)
       OR EXISTS(SELECT 1 FROM sloptogether.program_items pi WHERE pi.id=$5::uuid AND pi.segment_id=s.id)
       OR EXISTS(SELECT 1 FROM sloptogether.jobs j JOIN sloptogether.job_attempts ja ON ja.job_id=j.id WHERE ja.output_asset_id=$6::uuid AND j.segment_revision_id IN (SELECT id FROM sloptogether.segment_revisions WHERE segment_id=s.id))
     ) LIMIT 2 FOR UPDATE`,
    [channelId,body.targetSegmentId??null,body.segmentRevisionId??null,body.proposalId??null,body.itemId??null,body.assetId??null]);
  if(result.rows.length>1)throw new ApiError(422,"override_target_mismatch");
  return result.rows[0]??null;
}

async function fenceWork(client:PoolClient,channelId:string,revisionId:string|null){
  if(!revisionId)return {jobIds:[] as string[],providerRequests:[] as string[],dependentSegmentIds:[] as string[]};
  const affected=await client.query<{id:string;segment_revision_id:string|null}>(
    `WITH RECURSIVE affected(id) AS (
       SELECT id FROM sloptogether.jobs WHERE twitch_channel_id=$1 AND segment_revision_id=$2
       UNION SELECT d.dependent_job_id FROM affected a JOIN sloptogether.jobs upstream ON upstream.id=a.id
       JOIN sloptogether.endpoint_resolutions er ON er.segment_revision_id=upstream.segment_revision_id
       JOIN sloptogether.endpoint_resolution_dependencies d ON d.resolution_id=er.id
     ) SELECT j.id,j.segment_revision_id FROM affected a JOIN sloptogether.jobs j ON j.id=a.id WHERE j.twitch_channel_id=$1`,[channelId,revisionId]);
  const jobIds=affected.rows.map(row=>row.id);
  if(!jobIds.length)return {jobIds,providerRequests:[],dependentSegmentIds:[]};
  const immutable=await client.query(`SELECT 1 FROM sloptogether.jobs j JOIN sloptogether.segment_revisions sr ON sr.id=j.segment_revision_id
    JOIN sloptogether.segments s ON s.id=sr.segment_id WHERE j.id=ANY($1::uuid[]) AND
      (s.state IN ('played','retired') OR EXISTS(SELECT 1 FROM sloptogether.program_items pi WHERE pi.segment_id=s.id AND pi.committed_at IS NOT NULL)) LIMIT 1`,[jobIds]);
  if(immutable.rowCount)throw new ApiError(409,"dependent_program_history_immutable","This change reaches content already committed to the program. Use a program cut.");
  const attempts=await client.query<{id:string;provider_request_id:string|null}>(
    `UPDATE sloptogether.job_attempts SET state='cancelled',fence=fence+1,lease_expires_at=now(),finished_at=coalesce(finished_at,now()),error_code='streamer_override'
     WHERE job_id=ANY($1::uuid[]) AND state NOT IN ('succeeded','failed','rejected','expired','cancelled') RETURNING id,provider_request_id`,[jobIds]);
  await client.query("UPDATE sloptogether.jobs SET state='cancelled',cancelled_at=now() WHERE id=ANY($1::uuid[]) AND state NOT IN ('succeeded','failed','cancelled','expired')",[jobIds]);
  await client.query("UPDATE sloptogether.upload_reservations SET state='expired',expires_at=now() WHERE attempt_id=ANY($1::uuid[]) AND state IN ('issued','uploaded')",[attempts.rows.map(row=>row.id)]);
  await client.query("UPDATE sloptogether.endpoint_resolutions SET retired_at=now() WHERE segment_revision_id=ANY($1::uuid[]) AND retired_at IS NULL",[affected.rows.map(row=>row.segment_revision_id).filter(Boolean)]);
  await client.query(`UPDATE sloptogether.funding_authorizations SET state=CASE WHEN source='twitch_extension_bits' THEN 'paid_unfulfilled' ELSE 'released' END,settled_at=now()
    WHERE id IN (SELECT funding_id FROM sloptogether.jobs WHERE id=ANY($1::uuid[])) AND state='reserved'`,[jobIds]);
  const providerRequests=attempts.rows.flatMap(row=>row.provider_request_id?[row.provider_request_id]:[]);
  for(const attempt of attempts.rows)if(attempt.provider_request_id)await client.query(
    "INSERT INTO sloptogether.outbox(event_kind,aggregate_id,payload,idempotency_key) VALUES('provider.reconcile_cancel',$1,$2::jsonb,$3) ON CONFLICT(idempotency_key) DO NOTHING",
    [attempt.id,JSON.stringify({attemptId:attempt.id,providerRequestId:attempt.provider_request_id,reason:"streamer_override"}),"override-cancel:"+attempt.id]);
  const dependent=await client.query<{segment_id:string}>(
    `UPDATE sloptogether.segment_revisions SET state='superseded'
     WHERE id=ANY($1::uuid[]) AND id<>$2 AND state<>'superseded' RETURNING segment_id`,
    [affected.rows.map(row=>row.segment_revision_id).filter(Boolean),revisionId]);
  const dependentSegmentIds=[...new Set(dependent.rows.map(row=>row.segment_id))];
  if(dependentSegmentIds.length)await client.query("UPDATE sloptogether.segments SET state='open',selected_revision_id=NULL,protected_at=now() WHERE id=ANY($1::uuid[]) AND state NOT IN ('played','retired')",[dependentSegmentIds]);
  return {jobIds,providerRequests,dependentSegmentIds};
}

export async function applyStreamerOverride(locator:string,request:Request){
  const channel=await findChannel(locator);const principal=await requestPrincipal(request);
  const streamId=await getDefaultStreamId(channel.twitch_channel_id);
  const actor=await requireStreamerController(channel,principal);
  if(await isBanned(channel.twitch_channel_id,actor))throw new ApiError(403,"channel_ban_active");
  if(principal?.kind==="session")assertSameOrigin(request);
  const body=commandFrom(await readJson(request,z.record(z.string(),z.unknown())));
  const requestDigest=digest(body).toString("hex");
  const existing=await query<{actor_twitch_user_id:string|null;after_state:{requestDigest?:string;result?:Record<string,unknown>}|null}>(
    "SELECT actor_twitch_user_id,after_state FROM sloptogether.audit_log WHERE twitch_channel_id=$1 AND idempotency_key=$2",[channel.twitch_channel_id,body.idempotencyKey]);
  if(existing.rows[0]){
    const saved=existing.rows[0];if(saved.actor_twitch_user_id!==actor||saved.after_state?.requestDigest!==requestDigest)throw new ApiError(409,"override_idempotency_conflict");
    return saved.after_state.result??{};
  }
  // Complete external moderation before opening the short database transaction.
  const replacement=await proposedReplacement(channel.twitch_channel_id,body);
  return transaction(async client=>{
    const locked=await client.query<{layout_revision:number}>("SELECT layout_revision FROM sloptogether.channels WHERE twitch_channel_id=$1 FOR UPDATE",[channel.twitch_channel_id]);
    const prior=await client.query<{actor_twitch_user_id:string|null;after_state:{requestDigest?:string;result?:Record<string,unknown>}|null}>(
      "SELECT actor_twitch_user_id,after_state FROM sloptogether.audit_log WHERE twitch_channel_id=$1 AND idempotency_key=$2",[channel.twitch_channel_id,body.idempotencyKey]);
    if(prior.rows[0]){
      const saved=prior.rows[0];if(saved.actor_twitch_user_id!==actor||saved.after_state?.requestDigest!==requestDigest)throw new ApiError(409,"override_idempotency_conflict");
      return saved.after_state.result??{};
    }
    const currentRevision=locked.rows[0]?.layout_revision;if(currentRevision!==body.timelineRevision)throw new ApiError(409,"timeline_revision_stale","Refresh the channel timeline before applying this override.");
    const segment=await targetSegment(client,channel.twitch_channel_id,body);
    if(contentActions.has(body.action)&&!segment)throw new ApiError(422,"target_segment_required");
    if(contentActions.has(body.action)&&segment){
      if(segment.state==="played"||segment.state==="retired")throw new ApiError(409,"segment_history_immutable");
      const committed=await client.query("SELECT 1 FROM sloptogether.program_items WHERE segment_id=$1 AND committed_at IS NOT NULL LIMIT 1",[segment.id]);
      if(committed.rowCount)throw new ApiError(409,"segment_already_committed","This scene is already in the continuous program. Use a playback cut or seek to change the output.");
    }
    const nextRevision=currentRevision+1;
    let effects:{jobIds:string[];providerRequests:string[];dependentSegmentIds:string[]}={jobIds:[],providerRequests:[],dependentSegmentIds:[]};
    let result:Record<string,unknown>={action:body.action,timelineRevision:nextRevision,targetSegmentId:segment?.id??null};
    if(segment&&contentActions.has(body.action)){
      if(fencingActions.has(body.action))effects=await fenceWork(client,channel.twitch_channel_id,segment.selected_revision_id);
      const writerLeases=await client.query<{id:string}>("SELECT id FROM sloptogether.story_producers WHERE twitch_channel_id=$1 AND released_at IS NULL FOR UPDATE",[channel.twitch_channel_id]);
      await abandonStoryProducerPlans(client,writerLeases.rows.map(row=>row.id));
      await client.query("UPDATE sloptogether.story_producers SET fence=fence+1,writer_hold_revision=$2,released_at=now(),lease_expires_at=now() WHERE twitch_channel_id=$1 AND released_at IS NULL",[channel.twitch_channel_id,nextRevision]);
      await client.query("UPDATE sloptogether.story_plan_attempts SET status='superseded',updated_at=now() WHERE resulting_segment_id=$1 AND status NOT IN ('played','failed','superseded')",[segment.id]);
    }
    if((body.action==="replace_future_prompt"||body.action==="replace_future_boundary")&&segment&&replacement){
      if(replacement.base.segment_id!==segment.id||(body.segmentRevisionId===undefined&&replacement.base.id!==segment.selected_revision_id))throw new ApiError(409,"selected_revision_stale");
      const id=randomUUID();
      const n=await client.query<{revision:number}>("SELECT coalesce(max(revision),0)+1 AS revision FROM sloptogether.segment_revisions WHERE segment_id=$1",[segment.id]);
      const inputHash=digest({prompt:replacement.prompt,startBoundary:replacement.startBoundary,endBoundary:replacement.base.requested_end_boundary_revision_id,recipeId:replacement.base.provider_recipe_id,screen:replacement.screen.digest});
      await client.query(`INSERT INTO sloptogether.segment_revisions(id,segment_id,revision,prompt,visual_prompt,dialogue,start_boundary_revision_id,requested_end_boundary_revision_id,planning_mode,provider_recipe_id,seed,target_funding_id,input_sha256,requested_by,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL,$12,$13,'selected')`,
        [id,segment.id,n.rows[0]!.revision,replacement.prompt,body.action==="replace_future_prompt"?null:replacement.base.visual_prompt,body.action==="replace_future_prompt"?null:replacement.base.dialogue,replacement.startBoundary,replacement.base.requested_end_boundary_revision_id,replacement.base.planning_mode,replacement.base.provider_recipe_id,replacement.base.seed,inputHash,actor]);
      await client.query("UPDATE sloptogether.segment_revisions SET state='superseded' WHERE segment_id=$1 AND id<>$2 AND state IN ('selected','locked','rendering','ready')",[segment.id,id]);
      await client.query("UPDATE sloptogether.elections SET state='superseded',closed_by=$2 WHERE segment_id=$1 AND state IN ('open','closed','selected')",[segment.id,actor]);
      const election=await client.query<{id:string}>("INSERT INTO sloptogether.elections(segment_id,state,closes_at,rule_snapshot,closed_by) VALUES($1,'selected',now(),$2::jsonb,$3) RETURNING id",[segment.id,JSON.stringify({source:"streamer_override",policyRevision:channel.policy_revision}),actor]);
      const screen=await client.query<{id:string}>("SELECT id FROM sloptogether.input_screens WHERE twitch_channel_id=$1 AND input_sha256=$2 AND effective_state='clear' ORDER BY created_at DESC LIMIT 1",[channel.twitch_channel_id,Buffer.from(replacement.screen.digest,"hex")]);
      if(!screen.rows[0])throw new ApiError(409,"replacement_screen_missing");
      const proposal=await client.query<{id:string}>(`INSERT INTO sloptogether.proposals(election_id,segment_revision_id,author_twitch_user_id,proposal_kind,prompt,start_boundary_revision_id,end_boundary_revision_id,input_screen_id,state,reviewed_by,reviewed_at,review_reason)
        VALUES($1,$2,$3,'scene',$4,$5,$6,$7,'selected',$3,now(),$8) RETURNING id`,[election.rows[0]!.id,id,actor,replacement.prompt,replacement.startBoundary,replacement.base.requested_end_boundary_revision_id,screen.rows[0].id,body.reason]);
      await client.query("UPDATE sloptogether.elections SET winner_proposal_id=$2 WHERE id=$1",[election.rows[0]!.id,proposal.rows[0]!.id]);
      await client.query("UPDATE sloptogether.segments SET selected_revision_id=$2,state='selected',protected_at=now() WHERE id=$1",[segment.id,id]);
      const jobId=await schedulePulledGeneration(client,channel.twitch_channel_id,id,actor,screen.rows[0].id,true);
      result={...result,segmentRevisionId:id,proposalId:proposal.rows[0]!.id,jobId,state:"rendering",requiresFreshFunding:true};
    }else if(body.action==="select_proposal"&&segment){
      const eligible=await client.query<{id:string;segment_revision_id:string;input_screen_id:string;election_id:string}>(
        `SELECT p.id,p.segment_revision_id,p.input_screen_id,p.election_id FROM sloptogether.proposals p
         JOIN sloptogether.elections e ON e.id=p.election_id JOIN sloptogether.segment_revisions sr ON sr.id=p.segment_revision_id
         JOIN sloptogether.input_screens sc ON sc.id=p.input_screen_id AND sc.effective_state='clear' AND (sc.expires_at IS NULL OR sc.expires_at>now())
         WHERE e.segment_id=$1 AND sr.state IN ('proposal','selected')
           AND (p.state IN ('eligible','selected') OR (p.state='superseded' AND e.state='selected'))
           AND NOT EXISTS(SELECT 1 FROM sloptogether.bans b WHERE b.twitch_user_id=p.author_twitch_user_id AND b.revoked_at IS NULL AND (b.expires_at IS NULL OR b.expires_at>now()) AND (b.scope='global' OR b.twitch_channel_id=$4))
           AND ($2::uuid IS NULL OR p.id=$2) AND ($3::uuid IS NULL OR sr.id=$3)
         ORDER BY p.created_at LIMIT 2`,[segment.id,body.proposalId??null,body.segmentRevisionId??(body.proposalId?null:segment.selected_revision_id)??null,channel.twitch_channel_id]);
      if(eligible.rows.length!==1)throw new ApiError(422,"proposal_required","Choose one reviewed proposal to override this vote.");
      const choice=eligible.rows[0]!;
      if(choice.segment_revision_id!==segment.selected_revision_id)effects=await fenceWork(client,channel.twitch_channel_id,segment.selected_revision_id);
      await client.query("UPDATE sloptogether.segment_revisions SET state='superseded' WHERE segment_id=$1 AND id<>$2 AND state IN ('selected','locked','rendering','ready')",[segment.id,choice.segment_revision_id]);
      if(choice.segment_revision_id!==segment.selected_revision_id)await client.query("UPDATE sloptogether.segment_revisions SET state='selected' WHERE id=$1",[choice.segment_revision_id]);
      await client.query("UPDATE sloptogether.elections SET state=CASE WHEN id=$2 THEN 'selected' ELSE 'superseded' END,winner_proposal_id=CASE WHEN id=$2 THEN $3::uuid ELSE winner_proposal_id END,closed_by=$4 WHERE segment_id=$1 AND state IN ('open','closed','selected')",[segment.id,choice.election_id,choice.id,actor]);
      await client.query("UPDATE sloptogether.proposals SET state='selected',reviewed_by=$2,reviewed_at=now(),review_reason=$3 WHERE id=$1",[choice.id,actor,body.reason]);
      await client.query("UPDATE sloptogether.segments SET selected_revision_id=$2,state=CASE WHEN selected_revision_id=$2 THEN state ELSE 'selected' END,protected_at=now() WHERE id=$1",[segment.id,choice.segment_revision_id]);
      const jobId=await schedulePulledGeneration(client,channel.twitch_channel_id,choice.segment_revision_id,actor,choice.input_screen_id,false);
      result={...result,proposalId:choice.id,segmentRevisionId:choice.segment_revision_id,jobId,state:"rendering"};
    }else if(body.action==="hold"&&segment){
      await client.query("UPDATE sloptogether.segments SET protected_at=now(),state=CASE WHEN selected_revision_id IS NULL THEN 'open' ELSE 'selected' END WHERE id=$1",[segment.id]);
      result={...result,held:true};
    }else if((body.action==="resume"||body.action==="unlock_future")&&segment){
      if(body.action==="unlock_future"){
        await client.query("UPDATE sloptogether.segment_revisions SET state='superseded' WHERE segment_id=$1 AND state IN ('selected','locked','rendering','ready')",[segment.id]);
        await client.query("UPDATE sloptogether.elections SET state='superseded',closed_by=$2 WHERE segment_id=$1 AND state IN ('open','closed','selected')",[segment.id,actor]);
        await client.query("UPDATE sloptogether.segments SET state='open',selected_revision_id=NULL,protected_at=NULL WHERE id=$1",[segment.id]);
      }else{
        await client.query("UPDATE sloptogether.segments SET protected_at=NULL,state=CASE WHEN selected_revision_id IS NULL THEN 'open' ELSE 'selected' END WHERE id=$1",[segment.id]);
        let resumedJobId:string|null=null;
        if(segment.selected_revision_id){
          const screen=await client.query<{id:string|null}>(`SELECT coalesce(
            (SELECT p.input_screen_id FROM sloptogether.proposals p WHERE p.segment_revision_id=$1 AND p.input_screen_id IS NOT NULL ORDER BY p.created_at DESC LIMIT 1),
            (SELECT spa.screen_id FROM sloptogether.story_plan_attempts spa JOIN sloptogether.segment_revisions sr ON sr.segment_id=spa.resulting_segment_id WHERE sr.id=$1 AND spa.screen_id IS NOT NULL ORDER BY spa.created_at DESC LIMIT 1)) AS id`,[segment.selected_revision_id]);
          const inputScreenId=screen.rows[0]?.id;
          if(!inputScreenId)throw new ApiError(409,"generation_input_screen_missing","This selected scene needs a current, cleared input screen before it can resume.");
          const funding=await client.query<{source:string;state:string}>(`SELECT DISTINCT fa.source,fa.state FROM sloptogether.jobs j
            JOIN sloptogether.funding_authorizations fa ON fa.id=j.funding_id WHERE j.segment_revision_id=$1`,[segment.selected_revision_id]);
          if(funding.rows.some(row=>row.source==="twitch_extension_bits"))throw new ApiError(409,"fresh_funding_required","This paid attempt was already consumed or released. New payment is required before it can be rendered again.");
          const reserveOwnerBudget=funding.rows.some(row=>row.source==="owner_budget");
          resumedJobId=await schedulePulledGeneration(client,channel.twitch_channel_id,segment.selected_revision_id,actor,inputScreenId,reserveOwnerBudget);
        }
        await client.query(`UPDATE sloptogether.elections e SET state='open',closes_at=now()+interval '120 seconds',winner_proposal_id=NULL,closed_by=NULL
          WHERE e.segment_id=$1 AND e.state='closed' AND EXISTS(SELECT 1 FROM sloptogether.proposals p JOIN sloptogether.input_screens i ON i.id=p.input_screen_id
            WHERE p.election_id=e.id AND p.state='eligible' AND i.effective_state='clear' AND (i.expires_at IS NULL OR i.expires_at>now())
              AND NOT EXISTS(SELECT 1 FROM sloptogether.bans b WHERE b.twitch_user_id=p.author_twitch_user_id AND b.revoked_at IS NULL AND (b.expires_at IS NULL OR b.expires_at>now()) AND (b.scope='global' OR b.twitch_channel_id=$2)))`,[segment.id,channel.twitch_channel_id]);
        result={...result,jobId:resumedJobId,state:resumedJobId?"rendering":"selected"};
      }
      result={...result,held:false};
    }else if(body.action==="approve_asset"||body.action==="reject_asset"){
      if(!body.assetId)throw new ApiError(422,"asset_required");
      const assets=await client.query<{id:string;status:string;sha256:Buffer|null;uploaded_by_twitch_user_id:string|null;screen_id:string|null;segment_revision_id:string|null;funding_id:string|null}>(
        `SELECT a.id,a.status,a.sha256,a.uploaded_by_twitch_user_id,j.segment_revision_id,ja.funding_id,
          coalesce((SELECT p.input_screen_id FROM sloptogether.proposals p WHERE p.segment_revision_id=j.segment_revision_id AND p.input_screen_id IS NOT NULL ORDER BY p.created_at DESC LIMIT 1),
            (SELECT spa.screen_id FROM sloptogether.story_plan_attempts spa JOIN sloptogether.segment_revisions sr ON sr.segment_id=spa.resulting_segment_id WHERE sr.id=j.segment_revision_id AND spa.screen_id IS NOT NULL ORDER BY spa.created_at DESC LIMIT 1)) AS screen_id
         FROM sloptogether.assets a LEFT JOIN sloptogether.job_attempts ja ON ja.output_asset_id=a.id LEFT JOIN sloptogether.jobs j ON j.id=ja.job_id
         WHERE a.id=$1 AND a.twitch_channel_id=$2 ORDER BY ja.created_at DESC LIMIT 1 FOR UPDATE OF a`,[body.assetId,channel.twitch_channel_id]);
      const asset=assets.rows[0];if(!asset||!asset.sha256)throw new ApiError(404,"validated_asset_not_found");
      if(asset.status==="published")throw new ApiError(409,"published_artifact_immutable","Use a program cut to change already committed output.");
      const approved=body.action==="approve_asset";
      if(approved&&!["validated","approved"].includes(asset.status))throw new ApiError(409,"asset_validation_required");
      if(!asset.screen_id)throw new ApiError(409,"asset_input_screen_missing");
      const screen=await client.query("SELECT 1 FROM sloptogether.input_screens WHERE id=$1 AND effective_state='clear'",[asset.screen_id]);
      if(approved&&!screen.rowCount)throw new ApiError(409,"asset_input_not_clear");
      await client.query("INSERT INTO sloptogether.artifact_approvals(asset_id,sha256,input_screen_id,approval_path,reviewer_twitch_user_id,uploader_twitch_user_id,trust_policy_revision,decision,reason) VALUES($1,$2,$3,'streamer_override',$4,$5,$6,$7,$8)",[asset.id,asset.sha256,asset.screen_id,actor,asset.uploaded_by_twitch_user_id,channel.policy_revision,approved?"approved":"rejected",body.reason]);
      await client.query("UPDATE sloptogether.assets SET status=$2 WHERE id=$1",[asset.id,approved?"approved":"rejected"]);
      if(approved)await client.query("INSERT INTO sloptogether.outbox(event_kind,aggregate_id,payload,idempotency_key) VALUES('media.publish_requested',$1,$2::jsonb,$3) ON CONFLICT(idempotency_key) DO NOTHING",[asset.id,JSON.stringify({assetId:asset.id,approvalPath:"streamer_override"}),"publish:"+asset.id+":"+asset.sha256.toString("hex")]);
      if(asset.funding_id){
        const outcome=approved?"consumed_succeeded":"consumed_rejected";
        await client.query("UPDATE sloptogether.funding_authorizations SET state=$2,consumed_at=coalesce(consumed_at,now()),settled_at=now() WHERE id=$1 AND paid_action_intent_id IS NOT NULL",[asset.funding_id,outcome]);
        await client.query("UPDATE sloptogether.paid_action_intents SET state=$2,state_reason=$3,updated_at=now() WHERE id=(SELECT paid_action_intent_id FROM sloptogether.funding_authorizations WHERE id=$1)",[asset.funding_id,outcome,approved?"streamer_approved":"streamer_rejected"]);
        await client.query("UPDATE sloptogether.extension_bits_transactions SET settlement_state=$2,processed_at=now() WHERE intent_id=(SELECT paid_action_intent_id FROM sloptogether.funding_authorizations WHERE id=$1)",[asset.funding_id,outcome]);
      }
      else{
        effects=await fenceWork(client,channel.twitch_channel_id,asset.segment_revision_id);
        await client.query("UPDATE sloptogether.funding_authorizations SET state='consumed_rejected',settled_at=now() WHERE id IN (SELECT funding_id FROM sloptogether.jobs WHERE segment_revision_id=$1) AND state IN ('consumed_uncertain','consumed_succeeded','consumed_failed')",[asset.segment_revision_id]);
        await client.query(`UPDATE sloptogether.paid_action_intents p SET state=CASE WHEN f.state='paid_unfulfilled' THEN 'paid_unfulfilled' ELSE 'consumed_rejected' END,
            state_reason='streamer_rejected',updated_at=now() FROM sloptogether.funding_authorizations f
          WHERE f.paid_action_intent_id=p.id AND f.id IN (SELECT funding_id FROM sloptogether.jobs WHERE segment_revision_id=$1)`,[asset.segment_revision_id]);
        await client.query(`UPDATE sloptogether.extension_bits_transactions t SET settlement_state=p.state,processed_at=now()
          FROM sloptogether.paid_action_intents p WHERE t.intent_id=p.id AND p.state IN ('paid_unfulfilled','consumed_rejected')
            AND p.id IN (SELECT paid_action_intent_id FROM sloptogether.funding_authorizations WHERE id IN (SELECT funding_id FROM sloptogether.jobs WHERE segment_revision_id=$1))`,[asset.segment_revision_id]);
        if(segment){await client.query("UPDATE sloptogether.segment_revisions SET state='rejected' WHERE id=$1",[asset.segment_revision_id]);await client.query("UPDATE sloptogether.segments SET state='open',selected_revision_id=NULL,protected_at=NULL WHERE id=$1 AND state<>'played'",[segment.id]);}
      }
      result={...result,assetId:asset.id,state:approved?"approved":"rejected",publicationPending:approved};
    }else if(body.action==="skip_program_item"||body.action==="seek_program_item"){
      const current=await client.query<{id:string;item_order:string;program_epoch:string;source_pts_start:string|null;duration_seconds:string}>(
        `SELECT pi.id,pi.item_order,pi.program_epoch,pi.source_pts_start,coalesce(a.duration_seconds,0)::text AS duration_seconds
         FROM sloptogether.program_items pi JOIN sloptogether.assets a ON a.id=pi.asset_id
         WHERE pi.stream_id=$1 AND pi.committed_at IS NOT NULL AND (pi.id=$2::uuid OR pi.segment_id=$3::uuid)
         ORDER BY pi.program_epoch DESC,pi.item_order DESC LIMIT 1`,[streamId,body.itemId??null,body.targetSegmentId??null]);
      let item=current.rows[0];if(!item)throw new ApiError(404,"program_item_not_found");
      if(body.action==="skip_program_item"){
        const next=await client.query<typeof item>(`SELECT pi.id,pi.item_order,pi.program_epoch,pi.source_pts_start,coalesce(a.duration_seconds,0)::text AS duration_seconds FROM sloptogether.program_items pi JOIN sloptogether.assets a ON a.id=pi.asset_id WHERE pi.stream_id=$1 AND pi.program_epoch=$2 AND pi.item_order>$3 AND pi.committed_at IS NOT NULL ORDER BY pi.item_order LIMIT 1`,[streamId,item.program_epoch,item.item_order]);
        if(!next.rows[0])throw new ApiError(409,"next_program_item_not_ready");item=next.rows[0];
      }
      const offset=body.action==="skip_program_item"?0:body.offsetSeconds??0;if(offset>Number(item.duration_seconds))throw new ApiError(422,"playback_position_out_of_range");
      const playback=await client.query<{controller_epoch:string}>("UPDATE sloptogether.playback_sessions SET active_item_id=$2,item_offset_seconds=$3,controller_user_id=$4,controller_epoch=controller_epoch+1,event_sequence=0,lease_expires_at=now(),updated_at=now() WHERE stream_id=$1 RETURNING controller_epoch",[streamId,item.id,offset,actor]);
      await client.query("INSERT INTO sloptogether.outbox(event_kind,aggregate_id,payload,idempotency_key) VALUES('playback.seek_requested',$1,$2::jsonb,$3) ON CONFLICT(idempotency_key) DO NOTHING",[channel.twitch_channel_id,JSON.stringify({itemId:item.id,offsetSeconds:offset,programEpoch:Number(item.program_epoch),controllerEpoch:Number(playback.rows[0]?.controller_epoch??1)}),"seek:"+body.idempotencyKey]);
      result={...result,itemId:item.id,offsetSeconds:offset,playbackCommandPending:true};
    }
    await client.query("UPDATE sloptogether.channels SET layout_revision=$2,updated_at=now() WHERE twitch_channel_id=$1",[channel.twitch_channel_id,nextRevision]);
    result={...result,affectedJobIds:effects.jobIds,providerReconciliationPending:effects.providerRequests.length,dependentSegmentIds:effects.dependentSegmentIds};
    await client.query("INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,actor_key_id,action,target_kind,target_id,policy_revision,reason,before_state,after_state,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11)",
      [channel.twitch_channel_id,actor,principal?.kind==="worker-key"?principal.worker.keyId:null,"streamer.override."+body.action,segment?"segment":"channel",segment?.id??channel.twitch_channel_id,channel.policy_revision,body.reason,JSON.stringify({timelineRevision:currentRevision,segment}),JSON.stringify({requestDigest,result}),body.idempotencyKey]);
    return result;
  });
}

export async function listOverrideCandidates(locator:string,request:Request){
  const channel=await findChannel(locator);const principal=await requestPrincipal(request);
  await requireStreamerController(channel,principal);
  const segmentId=new URL(request.url).searchParams.get("segmentId")??"";
  if(!z.string().uuid().safeParse(segmentId).success)throw new ApiError(400,"segment_id_invalid");
  const result=await query<{proposal_id:string;segment_revision_id:string;start_boundary_revision_id:string;start_frame_asset_id:string;election_id:string;prompt:string;state:string;votes:string}>(
    `SELECT p.id AS proposal_id,p.segment_revision_id,sr.start_boundary_revision_id,a.id AS start_frame_asset_id,e.id AS election_id,p.prompt,p.state,count(b.twitch_user_id)::text AS votes
     FROM sloptogether.proposals p JOIN sloptogether.elections e ON e.id=p.election_id
     JOIN sloptogether.segments s ON s.id=e.segment_id
     JOIN sloptogether.segment_revisions sr ON sr.id=p.segment_revision_id AND sr.segment_id=s.id
     JOIN sloptogether.boundary_revisions bnd ON bnd.id=sr.start_boundary_revision_id AND bnd.twitch_channel_id=s.twitch_channel_id AND bnd.retired_at IS NULL
     JOIN sloptogether.assets a ON a.id=bnd.asset_id AND a.twitch_channel_id=s.twitch_channel_id AND a.media_kind='image' AND a.status IN ('approved','published')
     JOIN sloptogether.input_screens i ON i.id=p.input_screen_id AND i.effective_state='clear' AND (i.expires_at IS NULL OR i.expires_at>now())
     LEFT JOIN sloptogether.ballots b ON b.election_id=e.id AND b.proposal_id=p.id
     WHERE s.twitch_channel_id=$1 AND s.id=$2 AND sr.state IN ('proposal','selected')
       AND (p.state IN ('eligible','selected') OR (p.state='superseded' AND e.state='selected')) AND p.segment_revision_id IS NOT NULL
       AND NOT EXISTS(SELECT 1 FROM sloptogether.bans ban WHERE ban.twitch_user_id=p.author_twitch_user_id AND ban.revoked_at IS NULL
         AND (ban.expires_at IS NULL OR ban.expires_at>now()) AND (ban.scope='global' OR ban.twitch_channel_id=$1))
     GROUP BY p.id,e.id,sr.start_boundary_revision_id,a.id ORDER BY p.created_at,p.id`,[channel.twitch_channel_id,segmentId]);
  return {candidates:result.rows.map(row=>({proposalId:row.proposal_id,segmentRevisionId:row.segment_revision_id,startBoundaryRevisionId:row.start_boundary_revision_id,startFrameAssetId:row.start_frame_asset_id,electionId:row.election_id,title:row.prompt,votes:Number(row.votes),state:row.state}))};
}

export async function listActiveBans(locator:string,request:Request){
  const channel=await findChannel(locator);const principal=await requestPrincipal(request);
  const actor=await requireChannelModerator(channel,principal);
  if(await isBanned(channel.twitch_channel_id,actor))throw new ApiError(403,"channel_ban_active");
  const result=await query<{id:string;twitch_user_id:string;scope:string;reason:string;issued_at:Date;expires_at:Date|null}>(
    "SELECT id,twitch_user_id,scope,reason,issued_at,expires_at FROM sloptogether.bans WHERE (twitch_channel_id=$1 OR scope='global') AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) ORDER BY issued_at DESC LIMIT 250",[channel.twitch_channel_id]);
  return {bans:result.rows.map(row=>({id:row.id,twitchUserId:row.twitch_user_id,scope:row.scope,reason:row.reason,issuedAt:row.issued_at.toISOString(),expiresAt:row.expires_at?.toISOString()??null}))};
}

export async function createChannelBan(locator:string,request:Request){
  const channel=await findChannel(locator);const principal=await requestPrincipal(request);
  const actor=await requireChannelModerator(channel,principal);
  if(await isBanned(channel.twitch_channel_id,actor))throw new ApiError(403,"channel_ban_active");
  if(principal?.kind==="session")assertSameOrigin(request);
  const body=await readJson(request,z.object({twitchUserId:z.string().regex(/^\d{1,32}$/),reason:z.string().trim().min(1).max(500),expiresAt:z.string().datetime().nullable().optional()}).strict());
  if(body.twitchUserId===channel.owner_twitch_user_id)throw new ApiError(409,"cannot_ban_channel_owner");
  if(body.expiresAt&&Date.parse(body.expiresAt)<=Date.now())throw new ApiError(400,"ban_expiry_must_be_future");
  return transaction(async client=>{
    const channelLock=await client.query("SELECT twitch_channel_id FROM sloptogether.channels WHERE twitch_channel_id=$1 AND is_enabled FOR UPDATE",[channel.twitch_channel_id]);
    if(!channelLock.rowCount)throw new ApiError(404,"channel_not_found");
    const inserted=await client.query<{id:string}>(`INSERT INTO sloptogether.bans(twitch_user_id,twitch_channel_id,scope,reason,issued_by,expires_at)
      VALUES($1,$2,'channel',$3,$4,$5) RETURNING id`,[body.twitchUserId,channel.twitch_channel_id,body.reason,actor,body.expiresAt??null]);
    // Lock every still-uncommitted output segment before fencing its attempts.
    // This matches the media validator's segment→attempt order and closes the
    // approval race for GPU donors who did not author the selected prompt.
    await client.query(`SELECT s.id FROM sloptogether.segments s JOIN sloptogether.segment_revisions sr ON sr.segment_id=s.id
      JOIN sloptogether.jobs j ON j.segment_revision_id=sr.id JOIN sloptogether.job_attempts ja ON ja.job_id=j.id
      JOIN sloptogether.assets a ON a.id=ja.output_asset_id
      WHERE s.twitch_channel_id=$1 AND a.uploaded_by_twitch_user_id=$2 AND a.status IN ('quarantine','validated','approved','published')
        AND NOT EXISTS(SELECT 1 FROM sloptogether.program_items pi WHERE pi.asset_id=a.id AND pi.committed_at IS NOT NULL)
      ORDER BY s.id FOR UPDATE OF s`,[channel.twitch_channel_id,body.twitchUserId]);
    await cancelPendingInterrupts(client,channel.twitch_channel_id,false,body.twitchUserId);
    const bannedOutputs=await client.query<{id:string;sha256:Buffer|null;job_id:string;attempt_id:string;funding_id:string|null;stage:string;segment_revision_id:string|null;segment_id:string|null;interrupt_id:string|null}>(`UPDATE sloptogether.assets a SET status='rejected'
      FROM sloptogether.job_attempts ja JOIN sloptogether.jobs j ON j.id=ja.job_id
      LEFT JOIN sloptogether.segment_revisions sr ON sr.id=j.segment_revision_id
      LEFT JOIN sloptogether.segments s ON s.id=sr.segment_id
      WHERE ja.output_asset_id=a.id AND j.twitch_channel_id=$1 AND a.uploaded_by_twitch_user_id=$2
        AND a.status IN ('quarantine','validated','approved','published')
        AND NOT EXISTS(SELECT 1 FROM sloptogether.program_items pi WHERE pi.asset_id=a.id AND pi.committed_at IS NOT NULL)
      RETURNING a.id,a.sha256,j.id AS job_id,ja.id AS attempt_id,coalesce(ja.funding_id,j.funding_id) AS funding_id,j.stage,j.segment_revision_id,s.id AS segment_id,j.interrupt_id`,[channel.twitch_channel_id,body.twitchUserId]);
    const bannedAssetIds=bannedOutputs.rows.map(row=>row.id);
    const bannedJobIds=[...new Set(bannedOutputs.rows.map(row=>row.job_id))];
    const bannedAttemptIds=bannedOutputs.rows.map(row=>row.attempt_id);
    if(bannedAssetIds.length){
      await client.query("UPDATE sloptogether.artifact_approvals SET decision='revoked',reason='Uploader banned before program commit' WHERE asset_id=ANY($1::uuid[]) AND decision='approved'",[bannedAssetIds]);
      await client.query("UPDATE sloptogether.outbox SET delivered_at=now(),leased_until=NULL WHERE aggregate_id=ANY($1::text[]) AND event_kind IN ('media.validate','media.publish_requested') AND delivered_at IS NULL",[bannedAssetIds]);
    }
    if(bannedAttemptIds.length)await client.query(`UPDATE sloptogether.job_attempts SET state='rejected',fence=fence+1,lease_expires_at=now(),finished_at=coalesce(finished_at,now()),error_code='uploader_banned'
      WHERE id=ANY($1::uuid[]) AND state NOT IN ('failed','rejected','expired','cancelled')`,[bannedAttemptIds]);
    if(bannedJobIds.length)await client.query("UPDATE sloptogether.jobs SET state='failed',completed_at=coalesce(completed_at,now()) WHERE id=ANY($1::uuid[]) AND state NOT IN ('failed','cancelled','expired')",[bannedJobIds]);
    const bannedFundingIds=[...new Set(bannedOutputs.rows.map(row=>row.funding_id).filter((id):id is string=>Boolean(id)))];
    if(bannedFundingIds.length)await client.query("UPDATE sloptogether.funding_authorizations SET state='consumed_rejected',settled_at=now() WHERE id=ANY($1::uuid[]) AND state IN ('reserved','consumed_uncertain','consumed_succeeded','consumed_failed')",[bannedFundingIds]);
    for(const output of bannedOutputs.rows)if(output.stage==="video_base"&&output.interrupt_id){
      await client.query("UPDATE sloptogether.interrupt_requests SET program_state='failed' WHERE id=$1 AND program_state NOT IN ('played','cancelled','expired','skipped')",[output.interrupt_id]);
      await client.query("UPDATE sloptogether.subscription_events SET state='failed' WHERE interrupt_id=$1 AND state NOT IN ('played','cancelled','expired')",[output.interrupt_id]);
    }else if(output.stage==="video_base"&&output.segment_revision_id&&output.segment_id){
      await client.query("UPDATE sloptogether.segment_revisions SET state='rejected' WHERE id=$1 AND state NOT IN ('played','superseded')",[output.segment_revision_id]);
      await client.query("UPDATE sloptogether.proposals SET state='rejected',reviewed_at=now(),review_reason=$2 WHERE segment_revision_id=$1 AND state='selected'",[output.segment_revision_id,"Uploader banned before program commit: "+body.reason]);
      await client.query(`UPDATE sloptogether.elections e SET state='closed',winner_proposal_id=NULL
        FROM sloptogether.segments s WHERE e.segment_id=s.id AND s.id=$1 AND s.selected_revision_id=$2 AND e.state='selected'
          AND s.state NOT IN ('played','retired') AND NOT EXISTS(SELECT 1 FROM sloptogether.program_items pi WHERE pi.segment_id=s.id AND pi.committed_at IS NOT NULL)`,[output.segment_id,output.segment_revision_id]);
      await client.query(`UPDATE sloptogether.segments SET state='open',selected_revision_id=NULL,protected_at=NULL
        WHERE id=$1 AND selected_revision_id=$2 AND state NOT IN ('played','retired')
          AND NOT EXISTS(SELECT 1 FROM sloptogether.program_items pi WHERE pi.segment_id=$1 AND pi.committed_at IS NOT NULL)`,[output.segment_id,output.segment_revision_id]);
    }
    const affected=await client.query<{id:string;segment_revision_id:string|null;segment_id:string;election_id:string;input_screen_id:string|null}>(`SELECT p.id,p.segment_revision_id,s.id AS segment_id,e.id AS election_id,p.input_screen_id
      FROM sloptogether.proposals p JOIN sloptogether.elections e ON e.id=p.election_id JOIN sloptogether.segments s ON s.id=e.segment_id
      WHERE s.twitch_channel_id=$1 AND p.author_twitch_user_id=$2 AND p.state IN ('pending','eligible','selected')
        AND NOT EXISTS(SELECT 1 FROM sloptogether.program_items pi WHERE pi.segment_id=s.id AND pi.committed_at IS NOT NULL)
      FOR UPDATE OF p,e,s`,[channel.twitch_channel_id,body.twitchUserId]);
    for(const proposal of affected.rows){
      await client.query("UPDATE sloptogether.proposals SET state='rejected',reviewed_by=$2,reviewed_at=now(),review_reason=$3 WHERE id=$1",[proposal.id,actor,"Contributor banned: "+body.reason]);
      if(proposal.segment_revision_id){
        await client.query("UPDATE sloptogether.segment_revisions SET state='superseded' WHERE id=$1 AND state NOT IN ('played','superseded')",[proposal.segment_revision_id]);
        const attempts=await client.query<{id:string;provider_request_id:string|null;job_id:string}>(`UPDATE sloptogether.job_attempts a SET state='cancelled',fence=fence+1,lease_expires_at=now(),finished_at=now(),error_code='proposal_author_banned'
          FROM sloptogether.jobs j WHERE a.job_id=j.id AND j.segment_revision_id=$1 AND a.state NOT IN ('succeeded','failed','rejected','expired','cancelled') RETURNING a.id,a.provider_request_id,a.job_id`,[proposal.segment_revision_id]);
        const jobs=[...new Set(attempts.rows.map(row=>row.job_id))];
        if(jobs.length)await client.query("UPDATE sloptogether.jobs SET state='cancelled',cancelled_at=now() WHERE id=ANY($1::uuid[]) AND state NOT IN ('succeeded','failed','expired','cancelled')",[jobs]);
        if(jobs.length)await client.query("UPDATE sloptogether.funding_authorizations SET state='released',settled_at=now() WHERE id IN (SELECT funding_id FROM sloptogether.jobs WHERE id=ANY($1::uuid[])) AND state='reserved'",[jobs]);
        const rejectedAssets=await client.query<{id:string}>(`UPDATE sloptogether.assets a SET status='rejected'
          FROM sloptogether.job_attempts ja JOIN sloptogether.jobs j ON j.id=ja.job_id
          WHERE j.segment_revision_id=$1 AND a.id=ja.output_asset_id AND a.status IN ('quarantine','validated','approved') RETURNING a.id`,[proposal.segment_revision_id]);
        const rejectedAssetIds=rejectedAssets.rows.map(row=>row.id);
        if(rejectedAssetIds.length){
          await client.query("UPDATE sloptogether.artifact_approvals SET decision='revoked',reason='Uploader banned before program commit' WHERE asset_id=ANY($1::uuid[]) AND decision='approved'",[rejectedAssetIds]);
          await client.query("UPDATE sloptogether.outbox SET delivered_at=now() WHERE aggregate_id=ANY($1::text[]) AND event_kind IN ('media.validate','media.publish_requested') AND delivered_at IS NULL",[rejectedAssetIds]);
        }
        await client.query("UPDATE sloptogether.upload_reservations SET state='expired',expires_at=now() WHERE attempt_id=ANY($1::uuid[]) AND state IN ('issued','uploaded')",[attempts.rows.map(row=>row.id)]);
        for(const attempt of attempts.rows)if(attempt.provider_request_id)await client.query("INSERT INTO sloptogether.outbox(event_kind,aggregate_id,payload,idempotency_key) VALUES('provider.reconcile_cancel',$1,$2::jsonb,$3) ON CONFLICT(idempotency_key) DO NOTHING",[attempt.id,JSON.stringify({attemptId:attempt.id,providerRequestId:attempt.provider_request_id,reason:"proposal_author_banned"}),"ban-proposal:"+attempt.id]);
      }
      if(proposal.input_screen_id)await client.query("UPDATE sloptogether.assets SET status='rejected' WHERE id IN (SELECT asset_id FROM sloptogether.boundary_revisions WHERE moderation_evidence_id=$1) AND status='quarantine'",[proposal.input_screen_id]);
      await client.query("INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,action,target_kind,target_id,reason,after_state) VALUES($1,$2,'proposal.reject_banned_author','proposal',$3,$4,$5::jsonb)",[channel.twitch_channel_id,actor,proposal.id,body.reason,JSON.stringify({banId:inserted.rows[0]!.id})]);
    }
    const affectedElectionIds=[...new Set(affected.rows.map(row=>row.election_id))];
    const affectedRevisionIds=affected.rows.map(row=>row.segment_revision_id).filter((id):id is string=>Boolean(id));
    for(const electionId of affectedElectionIds){
      const current=await client.query<{state:string;winner_proposal_id:string|null;segment_id:string;protected_at:Date|null;selected_revision_id:string|null}>(`SELECT e.state,e.winner_proposal_id,s.id AS segment_id,s.protected_at,s.selected_revision_id
        FROM sloptogether.elections e JOIN sloptogether.segments s ON s.id=e.segment_id WHERE e.id=$1 FOR UPDATE OF e,s`,[electionId]);
      const row=current.rows[0];if(!row||!['open','closed','selected'].includes(row.state))continue;
      const winnerRemoved=Boolean(row.winner_proposal_id&&affected.rows.some(item=>item.election_id===electionId&&item.id===row.winner_proposal_id));
      if(row.state==='selected'&&!winnerRemoved)continue;
      if(row.state==='selected'&&winnerRemoved)await client.query(`UPDATE sloptogether.proposals p SET state='eligible'
        FROM sloptogether.input_screens i WHERE p.input_screen_id=i.id AND p.election_id=$1 AND p.state='superseded'
          AND i.effective_state='clear' AND (i.expires_at IS NULL OR i.expires_at>now())
          AND NOT EXISTS(SELECT 1 FROM sloptogether.bans b WHERE b.twitch_user_id=p.author_twitch_user_id AND b.revoked_at IS NULL AND (b.expires_at IS NULL OR b.expires_at>now()) AND (b.scope='global' OR b.twitch_channel_id=$2))`,[electionId,channel.twitch_channel_id]);
      const remaining=await client.query<{has_eligible:boolean}>(`SELECT EXISTS(SELECT 1 FROM sloptogether.proposals p JOIN sloptogether.input_screens i ON i.id=p.input_screen_id
        WHERE p.election_id=$1 AND p.state='eligible' AND i.effective_state='clear' AND (i.expires_at IS NULL OR i.expires_at>now())
          AND NOT EXISTS(SELECT 1 FROM sloptogether.bans b WHERE b.twitch_user_id=p.author_twitch_user_id AND b.revoked_at IS NULL AND (b.expires_at IS NULL OR b.expires_at>now()) AND (b.scope='global' OR b.twitch_channel_id=$2))) AS has_eligible`,[electionId,channel.twitch_channel_id]);
      const hold=await client.query<{held:boolean}>(`SELECT coalesce((SELECT action='streamer.override.hold' FROM sloptogether.audit_log
        WHERE twitch_channel_id=$1 AND target_kind='segment' AND target_id=$2 ORDER BY id DESC LIMIT 1),false) AS held`,[channel.twitch_channel_id,row.segment_id]);
      const manuallyHeld=Boolean(hold.rows[0]?.held);
      const reopen=Boolean(remaining.rows[0]?.has_eligible)&&!manuallyHeld;
      await client.query("UPDATE sloptogether.elections SET state=$2,winner_proposal_id=NULL,closed_by=$3,closes_at=CASE WHEN $2='open' THEN now()+interval '120 seconds' ELSE closes_at END WHERE id=$1",[electionId,reopen?"open":"closed",actor]);
      const selectedRevisionRemoved=Boolean(row.selected_revision_id&&affectedRevisionIds.includes(row.selected_revision_id));
      if(selectedRevisionRemoved)await client.query("UPDATE sloptogether.segments SET state=CASE WHEN $3 THEN 'voting' ELSE 'open' END,selected_revision_id=NULL,protected_at=CASE WHEN $4 THEN protected_at ELSE NULL END WHERE id=$1 AND selected_revision_id=$2 AND state NOT IN ('played','retired')",[row.segment_id,row.selected_revision_id,reopen,manuallyHeld]);
      else if(!remaining.rows[0]?.has_eligible)await client.query("UPDATE sloptogether.segments SET state='open',protected_at=CASE WHEN $2 THEN protected_at ELSE NULL END WHERE id=$1 AND state IN ('open','voting') AND selected_revision_id IS NULL",[row.segment_id,manuallyHeld]);
    }
    const revoked=await client.query<{key_id:string}>(`UPDATE sloptogether.application_keys SET revoked_at=coalesce(revoked_at,now()),key_revision=key_revision+1
      WHERE twitch_channel_id=$1 AND issuing_twitch_user_id=$2 AND revoked_at IS NULL RETURNING key_id`,[channel.twitch_channel_id,body.twitchUserId]);
    const keyIds=revoked.rows.map(row=>row.key_id);
    if(keyIds.length){
      const bindings=await client.query<{id:string}>(`UPDATE sloptogether.trusted_executions SET revoked_at=coalesce(revoked_at,now())
        WHERE key_id=ANY($1::uuid[]) AND revoked_at IS NULL RETURNING id`,[keyIds]);
      const bindingIds=bindings.rows.map(row=>row.id);
      if(bindingIds.length){
        await lockRevokedWorkerSegments(client,bindingIds,channel.twitch_channel_id);
        const attempts=await client.query<{id:string;job_id:string;provider_request_id:string|null;funding_id:string|null}>(`UPDATE sloptogether.job_attempts SET state='cancelled',fence=fence+1,lease_expires_at=now(),finished_at=now(),error_code='channel_user_banned'
          WHERE execution_binding_id=ANY($1::uuid[]) AND state NOT IN ('succeeded','failed','rejected','expired','cancelled') RETURNING id,job_id,provider_request_id,funding_id`,[bindingIds]);
        const jobIds=[...new Set(attempts.rows.map(row=>row.job_id))];
        if(jobIds.length)await client.query("UPDATE sloptogether.jobs SET state='cancelled',cancelled_at=now() WHERE id=ANY($1::uuid[]) AND state NOT IN ('succeeded','failed','cancelled','expired')",[jobIds]);
        await retireRevokedWorkerJobs(client,jobIds,"Worker access was revoked before the clip was uploaded.");
        for(const attempt of attempts.rows)if(attempt.provider_request_id)await client.query("INSERT INTO sloptogether.outbox(event_kind,aggregate_id,payload,idempotency_key) VALUES('provider.reconcile_cancel',$1,$2::jsonb,$3) ON CONFLICT(idempotency_key) DO NOTHING",[attempt.id,JSON.stringify({attemptId:attempt.id,providerRequestId:attempt.provider_request_id,reason:"channel_ban"}),"ban-cancel:"+attempt.id]);
        await client.query("UPDATE sloptogether.upload_reservations SET state='expired' WHERE attempt_id=ANY($1::uuid[]) AND state='issued'",[attempts.rows.map(row=>row.id)]);
      }
    }
    // Device identity is global; this channel ban is enforced per channel at claim and upload time.
    await client.query("INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,action,target_kind,target_id,reason,after_state) VALUES($1,$2,'user.ban','ban',$3,$4,$5::jsonb)",[channel.twitch_channel_id,actor,inserted.rows[0]!.id,body.reason,JSON.stringify({twitchUserId:body.twitchUserId,revokedWorkerKeys:keyIds.length})]);
    return {banId:inserted.rows[0]!.id,twitchUserId:body.twitchUserId,revokedWorkerKeys:keyIds.length};
  });
}

export async function revokeChannelBan(locator:string,banId:string,request:Request){
  const channel=await findChannel(locator);const principal=await requestPrincipal(request);
  const actor=await requireChannelModerator(channel,principal);
  if(await isBanned(channel.twitch_channel_id,actor))throw new ApiError(403,"channel_ban_active");
  if(principal?.kind==="session")assertSameOrigin(request);
  const result=await query("UPDATE sloptogether.bans SET revoked_at=now() WHERE id=$1 AND twitch_channel_id=$2 AND scope='channel' AND revoked_at IS NULL",[banId,channel.twitch_channel_id]);
  if(!result.rowCount)throw new ApiError(404,"active_ban_not_found");
  await query("INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,action,target_kind,target_id) VALUES($1,$2,'user.unban','ban',$3)",[channel.twitch_channel_id,actor,banId]);
  return {banId,revoked:true,requiresNewWorkerPairing:true};
}
