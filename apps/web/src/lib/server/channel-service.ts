import { randomUUID } from "node:crypto";
import { contributionModeSchema,workerKeyScopes } from "@sloptogether/contracts";
import { transaction,transactionOnClient,query } from "./db";
import { ApiError,assertSameOrigin,readJson } from "./http";
import { currentSession } from "./session";
import { requestPrincipal } from "./principals";
import { findChannel,isBanned,listPublicChannels as publicChannelDirectory,requireChannelModerator,requireContentReviewer,requireStreamerController } from "./channels";
import { getModeratedChannelIds } from "./twitch-subs";
import { getPublicTimeline } from "./timeline";
import { publicRuntimeStatus } from "./env";
import { reservationUsd } from "./reservation";
import { hmacKeySecret,randomSecret } from "./crypto";
import { z } from "zod";
import { abandonStoryProducerPlans, lockRevokedWorkerSegments, retireRevokedWorkerJobs } from "./worker-revocation";
import { carryForwardTrustedExecutions,isSafeTrustedPolicyAudit,nonAuthoritySettings } from "./trusted-policy";
import { settingsFrom } from "./subscriber-service";

export async function sessionOverview(request:Request){
  const configured={twitchOAuth:publicRuntimeStatus().twitchOAuth};
  const session=await currentSession(request);
  if(!session)return {authenticated:false,user:null,channels:[],configured};
  const entries=new Map<string,{twitchChannelId:string;login:string;displayName:string;role:"broadcaster"|"moderator"}>();
  const own=await query<{twitch_channel_id:string;twitch_login:string;display_name:string}>(
    "SELECT twitch_channel_id,twitch_login,display_name FROM sloptogether.channels WHERE owner_twitch_user_id=$1 AND is_enabled=true ORDER BY created_at DESC",
    [session.twitchUserId]);
  for(const c of own.rows)entries.set(c.twitch_channel_id,{twitchChannelId:c.twitch_channel_id,login:c.twitch_login,displayName:c.display_name,role:"broadcaster"});
  if(session.scopes.includes("user:read:moderated_channels")){
    try{
      const ids=await getModeratedChannelIds(session.accessToken,session.twitchUserId);
      if(ids.size){
        const rows=await query<{twitch_channel_id:string;twitch_login:string;display_name:string}>(
          "SELECT twitch_channel_id,twitch_login,display_name FROM sloptogether.channels WHERE twitch_channel_id=ANY($1::text[]) AND is_enabled=true",
          [[...ids]]);
        for(const c of rows.rows)if(!entries.has(c.twitch_channel_id))entries.set(c.twitch_channel_id,{twitchChannelId:c.twitch_channel_id,login:c.twitch_login,displayName:c.display_name,role:"moderator"});
      }
    }catch{/* preserve valid owner access when optional moderator lookup is unavailable */}
  }
  return {authenticated:true,user:{twitchUserId:session.twitchUserId,login:session.twitchLogin,displayName:session.displayName},scopes:session.scopes,channels:[...entries.values()],configured};
}

export async function listPublicChannels(){
  return publicChannelDirectory(60);
}

export async function publicChannel(locator:string){
  const c=await findChannel(locator);
  return {channel:{twitchChannelId:c.twitch_channel_id,twitchLogin:c.twitch_login,displayName:c.display_name,visibility:c.visibility,contributionMode:c.contribution_mode}};
}

export async function timeline(locator:string,request:Request){
  const channel=await findChannel(locator);const principal=await requestPrincipal(request);
  return getPublicTimeline(channel,principal);
}

export function ownerBudgetSummary(capValue:number|string,committedValue:number|string,reservationUsd:number|null){
  const cap=Number(capValue),committed=Number(committedValue);
  const capUsd=Number.isFinite(cap)?Math.max(0,Number(cap.toFixed(4))):0;
  const ownerBudgetCommittedUsd=Number.isFinite(committed)?Math.max(0,Number(committed.toFixed(4))):0;
  const ownerBudgetRemainingUsd=Math.max(0,Number((capUsd-ownerBudgetCommittedUsd).toFixed(4)));
  const ownerBudgetRemainingAttempts=reservationUsd===null?null:Math.floor((ownerBudgetRemainingUsd+0.00000001)/reservationUsd);
  return {ownerBudgetCommittedUsd,ownerBudgetRemainingUsd,ownerGenerationAttemptReservationUsd:reservationUsd,ownerBudgetRemainingAttempts};
}

export async function createOwnedChannel(request:Request){
  assertSameOrigin(request);
  const session=await currentSession(request);
  if(!session)throw new ApiError(401,"login_required");
  const id=session.twitchUserId;
  const existing=await query<{twitch_login:string;display_name:string}>(
    "SELECT twitch_login,display_name FROM sloptogether.channels WHERE owner_twitch_user_id=$1 AND is_enabled=true",[id]);
  if(existing.rows[0])return {twitchChannelId:id,login:existing.rows[0].twitch_login,displayName:existing.rows[0].display_name,alreadyConnected:true};
  await transaction(async client=>{
    await client.query("INSERT INTO sloptogether.channels(twitch_channel_id,owner_twitch_user_id,twitch_login,display_name) VALUES($1,$1,$2,$3)",[id,session.twitchLogin,session.displayName]);
    await client.query("INSERT INTO sloptogether.memberships(twitch_user_id,twitch_channel_id,role,status) VALUES($1,$1,'broadcaster','active') ON CONFLICT DO NOTHING",[id]);
    await client.query("INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,action,target_kind,target_id) VALUES($1,$1,'channel.create','channel',$1)",[id]);
  });
  return {twitchChannelId:id,login:session.twitchLogin,displayName:session.displayName};
}

export async function readChannelSettings(locator:string,request:Request){
  const channel=await findChannel(locator);const principal=await requestPrincipal(request);
  await requireChannelModerator(channel,principal);
  const funding=await query<{committed:string}>(`SELECT coalesce(sum(greatest(reserved_usd,coalesce(actual_cost_usd,0))),0)::text AS committed
    FROM sloptogether.funding_authorizations WHERE twitch_channel_id=$1 AND source='owner_budget' AND state<>'released'`,[channel.twitch_channel_id]);
  const subscriptionAuth=await query<{authorized:boolean}>(`SELECT EXISTS(SELECT 1 FROM sloptogether.sessions WHERE twitch_user_id=$1 AND revoked_at IS NULL
    AND expires_at>now() AND granted_scopes @> ARRAY['channel:read:subscriptions']::text[]) AS authorized`,[channel.owner_twitch_user_id]);
  const budget=ownerBudgetSummary(channel.owner_budget_cap_usd,funding.rows[0]?.committed??"0",reservationUsd("SLOPTOGETHER_GENERATION_ATTEMPT_RESERVATION_USD"));
  return {
    twitchChannelId:channel.twitch_channel_id,login:channel.twitch_login,displayName:channel.display_name,
    contributionMode:channel.contribution_mode,contributorWhitelist:channel.contributor_whitelist,
    reviewerWhitelist:channel.reviewer_whitelist,uploadApprovalBypassIds:channel.upload_approval_bypass_ids,
    roleBasedUploadBypass:channel.role_based_upload_bypass,subscriberInterrupts:settingsFrom(channel.subscriber_interrupt_policy),
    storyWorldPrompt:channel.story_world_prompt,h3StyleProfile:channel.h3_style_profile,
    ownerBudgetCapUsd:Number(channel.owner_budget_cap_usd),...budget,policyRevision:channel.policy_revision,chatVotingEnabled:channel.chat_voting_enabled,
    subscriberAttemptReservationUsd:reservationUsd("SLOPTOGETHER_SUBSCRIBER_ATTEMPT_RESERVATION_USD"),
    subscriberEventSubAuthorized:Boolean(subscriptionAuth.rows[0]?.authorized),
    preairUpscaleEnabled:channel.preair_upscale_enabled,preairUpscaleWaitSeconds:channel.preair_upscale_wait_seconds,
  };
}

const channelSettingsPatch=z.object({
  contributionMode:contributionModeSchema.optional(),
  contributorWhitelist:z.array(z.string().regex(/^\d{1,32}$/)).max(250).optional(),
  reviewerWhitelist:z.array(z.string().regex(/^\d{1,32}$/)).max(250).optional(),
  uploadApprovalBypassIds:z.array(z.string().regex(/^\d{1,32}$/)).max(250).optional(),
  roleBasedUploadBypass:z.array(z.enum(["broadcaster","moderator"])).max(2).optional(),
  storyWorldPrompt:z.string().trim().min(1).max(4000).optional(),
  h3StyleProfile:z.string().regex(/^[-a-zA-Z0-9_]{1,80}$/).optional(),
  ownerBudgetCapUsd:z.number().min(0).max(10000).optional(),
  chatVotingEnabled:z.boolean().optional(),
  preairUpscaleEnabled:z.boolean().optional(),
  preairUpscaleWaitSeconds:z.number().int().min(60).max(3600).optional(),
}).strict();

export async function updateChannelSettings(locator:string,request:Request){
  assertSameOrigin(request);const channel=await findChannel(locator);const principal=await requestPrincipal(request);
  const actor=await requireStreamerController(channel,principal);
  const patch=await readJson(request,channelSettingsPatch);
  const columns:Record<string,unknown>={};
  if(patch.contributionMode!==undefined)columns.contribution_mode=patch.contributionMode;
  if(patch.contributorWhitelist!==undefined)columns.contributor_whitelist=[...new Set(patch.contributorWhitelist)];
  if(patch.reviewerWhitelist!==undefined)columns.reviewer_whitelist=[...new Set(patch.reviewerWhitelist)];
  if(patch.uploadApprovalBypassIds!==undefined)columns.upload_approval_bypass_ids=[...new Set(patch.uploadApprovalBypassIds)];
  if(patch.roleBasedUploadBypass!==undefined)columns.role_based_upload_bypass=[...new Set(patch.roleBasedUploadBypass)];
  if(patch.storyWorldPrompt!==undefined)columns.story_world_prompt=patch.storyWorldPrompt;
  if(patch.h3StyleProfile!==undefined)columns.h3_style_profile=patch.h3StyleProfile;
  if(patch.ownerBudgetCapUsd!==undefined)columns.owner_budget_cap_usd=patch.ownerBudgetCapUsd;
  if(patch.chatVotingEnabled!==undefined)columns.chat_voting_enabled=patch.chatVotingEnabled;
  if(patch.preairUpscaleEnabled!==undefined)columns.preair_upscale_enabled=patch.preairUpscaleEnabled;
  if(patch.preairUpscaleWaitSeconds!==undefined)columns.preair_upscale_wait_seconds=patch.preairUpscaleWaitSeconds;
  const names=Object.keys(columns);
  if(!names.length)return readChannelSettings(locator,request);
  const values=names.map(name=>columns[name]);values.push(channel.twitch_channel_id);
  const assignments=names.map((name,index)=>name+"=$"+(index+1)).join(",");
  const persist=async(client:import("pg").PoolClient)=>{
    const updated=await client.query<{policy_revision:number}>("UPDATE sloptogether.channels SET "+assignments+",policy_revision=policy_revision+1,updated_at=now() WHERE twitch_channel_id=$"+values.length+" RETURNING policy_revision",values);
    if(!updated.rowCount)throw new ApiError(404,"channel_not_found");
    if(names.every(name=>nonAuthoritySettings.has(name))){
      await carryForwardTrustedExecutions(client,channel.twitch_channel_id,updated.rows[0]!.policy_revision);
    }
    if(patch.preairUpscaleEnabled===false){
      await client.query(`SELECT s.id FROM sloptogether.preair_upscale_requests p JOIN sloptogether.segment_revisions r ON r.id=p.segment_revision_id
        JOIN sloptogether.segments s ON s.id=r.segment_id WHERE p.twitch_channel_id=$1 AND p.state='pending' ORDER BY s.id FOR UPDATE OF s`,[channel.twitch_channel_id]);
      const pending=await client.query<{base_asset_id:string;verified_job_id:string|null}>(`SELECT p.base_asset_id,
        CASE WHEN j.twitch_channel_id=p.twitch_channel_id AND j.parent_asset_id=p.base_asset_id AND j.segment_revision_id=p.segment_revision_id
          AND j.stage='video_upscale' AND j.input_sha256=p.base_sha256 THEN j.id ELSE NULL END AS verified_job_id
        FROM sloptogether.preair_upscale_requests p JOIN sloptogether.jobs j ON j.id=p.upscale_job_id
        WHERE p.twitch_channel_id=$1 AND p.state='pending' ORDER BY p.base_asset_id FOR UPDATE OF p`,[channel.twitch_channel_id]);
      const jobs=pending.rows.map(row=>row.verified_job_id).filter((id):id is string=>Boolean(id)),assets=pending.rows.map(row=>row.base_asset_id);
      if(jobs.length){
        await client.query(`UPDATE sloptogether.job_attempts SET state='cancelled',fence=fence+1,lease_expires_at=now(),finished_at=coalesce(finished_at,now()),error_code='preair_disabled'
          WHERE job_id=ANY($1::uuid[]) AND state IN ('ready','leased','running','uncertain','uploaded','validating')`,[jobs]);
        await client.query(`UPDATE sloptogether.upload_reservations SET state='expired',expires_at=now() WHERE attempt_id IN
          (SELECT id FROM sloptogether.job_attempts WHERE job_id=ANY($1::uuid[])) AND state IN ('issued','uploaded')`,[jobs]);
        await client.query("UPDATE sloptogether.jobs SET state='cancelled',cancelled_at=now() WHERE id=ANY($1::uuid[]) AND state NOT IN ('succeeded','failed','cancelled','expired')",[jobs]);
      }
      if(assets.length){
        await client.query("UPDATE sloptogether.preair_upscale_requests SET state='fallback',fallback_reason='policy_disabled',resolved_at=now() WHERE base_asset_id=ANY($1::uuid[]) AND state='pending'",[assets]);
        await client.query("UPDATE sloptogether.outbox SET available_at=now() WHERE aggregate_id=ANY($1::text[]) AND event_kind='media.publish_requested' AND delivered_at IS NULL",[assets]);
      }
    }
    await client.query("INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,action,target_kind,target_id,policy_revision,after_state) VALUES($1,$2,'channel.settings.update','channel',$1,$3,$4::jsonb)",[channel.twitch_channel_id,actor,updated.rows[0].policy_revision,JSON.stringify(patch)]);
  };
  if(patch.chatVotingEnabled!==undefined){
    const {authorizeChatVoteSubscription,ensureChatVoteSubscription,disableChatVoteSubscription,withEventSubLifecycleLock}=await import("./subscriber-service");
    const chatSession=patch.chatVotingEnabled?await authorizeChatVoteSubscription(channel,request):null;
    await withEventSubLifecycleLock(channel.twitch_channel_id,async client=>{
      if(patch.chatVotingEnabled)await ensureChatVoteSubscription(channel,chatSession!,client);
      await transactionOnClient(client,persist);
      if(!patch.chatVotingEnabled)await disableChatVoteSubscription(channel,client);
    });
  }else await transaction(persist);
  return readChannelSettings(locator,request);
}

export async function listReviewQueue(locator:string,request:Request,streamId?:string){
  const channel=await findChannel(locator);const principal=await requestPrincipal(request);
  await requireContentReviewer(channel,principal);
  const result=await query<{id:string;author_twitch_user_id:string;prompt:string;state:string;created_at:Date;asset_id:string|null;end_asset_id:string|null;effective_state:string|null;automated_state:string|null}>(
    "SELECT p.id,p.author_twitch_user_id,p.prompt,p.state,p.created_at,a.id AS asset_id,ea.id AS end_asset_id,sc.effective_state,sc.automated_state "+
    "FROM sloptogether.proposals p JOIN sloptogether.elections e ON e.id=p.election_id "+
    "JOIN sloptogether.segments s ON s.id=e.segment_id "+
    "LEFT JOIN sloptogether.boundary_revisions b ON b.id=p.start_boundary_revision_id "+
    "LEFT JOIN sloptogether.assets a ON a.id=b.asset_id "+
    "LEFT JOIN sloptogether.boundary_revisions eb ON eb.id=p.end_boundary_revision_id "+
    "LEFT JOIN sloptogether.assets ea ON ea.id=eb.asset_id "+
    "LEFT JOIN sloptogether.input_screens sc ON sc.id=p.input_screen_id "+
    "WHERE s.twitch_channel_id=$1 AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM sloptogether.branches b WHERE b.id=s.branch_id AND b.stream_id=$2)) AND p.state='pending' AND p.review_reason IS DISTINCT FROM 'awaiting_bits_payment' ORDER BY p.created_at LIMIT 150",
    [channel.twitch_channel_id,streamId??null]);
  const proposalItems=result.rows.map(row=>({id:row.id,kind:row.asset_id&&row.end_asset_id?"anchor_pair":row.asset_id?"start_frame":row.end_asset_id?"end_frame":"prompt",contributor:row.author_twitch_user_id,prompt:row.prompt??"",state:row.state,inputHeld:row.effective_state!=="clear",automatedState:row.automated_state,submittedAt:row.created_at.toISOString(),thumbnailUrl:row.asset_id?"/sloptogether/api/v1/media/"+row.asset_id+"/preview":undefined,endThumbnailUrl:row.end_asset_id?"/sloptogether/api/v1/media/"+row.end_asset_id+"/preview":undefined}));
  const artifacts=await query<{id:string;uploaded_by_twitch_user_id:string|null;prompt:string|null;stage:string;created_at:Date;effective_state:string|null;automated_state:string|null;screen_expires_at:Date|null;duration_seconds:string|null}>(
    `SELECT a.id,a.uploaded_by_twitch_user_id,coalesce(nullif(j.planning_payload->>'prompt',''),sr.prompt) AS prompt,j.stage,a.created_at,i.effective_state,i.automated_state,i.expires_at AS screen_expires_at,a.duration_seconds
     FROM sloptogether.assets a JOIN sloptogether.job_attempts ja ON ja.output_asset_id=a.id
     JOIN sloptogether.jobs j ON j.id=ja.job_id
     LEFT JOIN sloptogether.segment_revisions sr ON sr.id=j.segment_revision_id
     LEFT JOIN sloptogether.input_screens i ON i.id=coalesce(NULLIF(j.planning_payload->>'inputScreenId','')::uuid,
       (SELECT p.input_screen_id FROM sloptogether.proposals p WHERE p.segment_revision_id=j.segment_revision_id AND p.input_screen_id IS NOT NULL ORDER BY p.created_at DESC LIMIT 1),
       (SELECT sp.screen_id FROM sloptogether.story_plan_attempts sp JOIN sloptogether.segment_revisions rs ON rs.segment_id=sp.resulting_segment_id WHERE rs.id=j.segment_revision_id AND sp.screen_id IS NOT NULL ORDER BY sp.created_at DESC LIMIT 1))
     WHERE a.twitch_channel_id=$1 AND ($2::uuid IS NULL OR j.stream_id=$2) AND a.media_kind='video' AND a.status='validated' AND j.stage IN ('video_base','video_upscale')
       AND ja.state='validating' AND NOT EXISTS(SELECT 1 FROM sloptogether.artifact_approvals aa WHERE aa.asset_id=a.id AND aa.sha256=a.sha256 AND aa.decision IN ('approved','rejected'))
     ORDER BY a.created_at DESC LIMIT 100`,[channel.twitch_channel_id,streamId??null]);
  const artifactItems=artifacts.rows.map(row=>({id:row.id,kind:row.stage==="video_upscale"?"upscale":"base_video",contributor:row.uploaded_by_twitch_user_id??"trusted worker",prompt:row.prompt??"Generated clip",state:"validated",inputHeld:row.effective_state!=="clear",automatedState:row.automated_state,inputScreenExpired:Boolean(row.screen_expires_at&&row.screen_expires_at.getTime()<=Date.now()),submittedAt:row.created_at.toISOString(),videoUrl:"/sloptogether/api/v1/media/"+row.id+"/preview",durationSeconds:row.duration_seconds?Number(row.duration_seconds):undefined}));
  const endpoints=await query<{asset_id:string;boundary_id:string;input_screen_id:string;created_by:string;prompt:string;created_at:Date;effective_state:string;automated_state:string}>(
    "SELECT a.id AS asset_id,b.id AS boundary_id,i.id AS input_screen_id,b.created_by,sr.prompt,b.created_at,i.effective_state,i.automated_state "+
    "FROM sloptogether.boundary_revisions b JOIN sloptogether.assets a ON a.id=b.asset_id "+
    "JOIN sloptogether.input_screens i ON i.id=b.moderation_evidence_id "+
    "LEFT JOIN sloptogether.segment_revisions sr ON sr.id=b.source_revision_id "+
    "WHERE b.twitch_channel_id=$1 AND b.transformation->>'kind'='generated_endpoint_frame' AND a.status='quarantine' "+
    "AND i.effective_state IN ('held','pending') AND NOT EXISTS(SELECT 1 FROM sloptogether.endpoint_resolutions er WHERE er.resolved_end_boundary_revision_id=b.id AND er.retired_at IS NULL) "+
    "AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM sloptogether.segment_revisions sr JOIN sloptogether.segments s ON s.id=sr.segment_id JOIN sloptogether.branches br ON br.id=s.branch_id WHERE sr.id=b.source_revision_id AND br.stream_id=$2)) "+
    "ORDER BY b.created_at DESC LIMIT 50",[channel.twitch_channel_id,streamId??null]);
  const endpointItems=endpoints.rows.map(row=>({id:row.asset_id,kind:"end_frame",contributor:row.created_by,prompt:row.prompt??"Generated ending frame",state:"pending",inputHeld:true,automatedState:row.automated_state,submittedAt:row.created_at.toISOString(),thumbnailUrl:"/sloptogether/api/v1/media/"+row.asset_id+"/preview",endpointScreenId:row.input_screen_id}));
  return {items:[...proposalItems,...artifactItems,...endpointItems].sort((a,b)=>Date.parse(b.submittedAt)-Date.parse(a.submittedAt)).slice(0,150)};
}

export async function resolveReviewInput(locator:string,itemId:string,request:Request){
  assertSameOrigin(request);const channel=await findChannel(locator);const principal=await requestPrincipal(request);
  const actor=await requireStreamerController(channel,principal);
  const body=await readJson(request,z.object({decision:z.enum(["clear","reject"]),reason:z.string().trim().min(1).max(500)}).strict());
  return transaction(async client=>{
    const item=await client.query<{input_screen_id:string;segment_id:string;state:string;asset_id:string|null;end_asset_id:string|null}>(`SELECT p.input_screen_id,e.segment_id,p.state,a.id AS asset_id,ea.id AS end_asset_id FROM sloptogether.proposals p
      JOIN sloptogether.elections e ON e.id=p.election_id JOIN sloptogether.segments s ON s.id=e.segment_id
      LEFT JOIN sloptogether.boundary_revisions b ON b.id=p.start_boundary_revision_id LEFT JOIN sloptogether.assets a ON a.id=b.asset_id
      LEFT JOIN sloptogether.boundary_revisions eb ON eb.id=p.end_boundary_revision_id LEFT JOIN sloptogether.assets ea ON ea.id=eb.asset_id
      WHERE p.id=$1 AND s.twitch_channel_id=$2 AND p.input_screen_id IS NOT NULL AND p.review_reason IS DISTINCT FROM 'awaiting_bits_payment' FOR UPDATE OF p,e,s`,[itemId,channel.twitch_channel_id]);
    const row=item.rows[0];if(!row)throw new ApiError(404,"review_item_not_found");
    if(row.state!=="pending")throw new ApiError(409,"review_item_already_decided");
    const {authorizeManualInputResolution}=await import("./preflight");
    await authorizeManualInputResolution(client,row.input_screen_id,actor,body.reason,body.decision);
    if(body.decision==="reject"){
      await client.query("UPDATE sloptogether.proposals SET state='rejected',reviewed_by=$2,reviewed_at=now(),review_reason=$3 WHERE id=$1",[itemId,actor,body.reason]);
      for(const assetId of [row.asset_id,row.end_asset_id].filter((value):value is string=>Boolean(value)))await client.query("UPDATE sloptogether.assets SET status='rejected' WHERE id=$1 AND status IN ('quarantine','validated')",[assetId]);
      await client.query("UPDATE sloptogether.segments SET state='open' WHERE id=$1 AND state IN ('open','voting')",[row.segment_id]);
    }
    await client.query("INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,action,target_kind,target_id,reason,after_state) VALUES($1,$2,$3,'proposal',$4,$5,$6::jsonb)",[
      channel.twitch_channel_id,actor,body.decision==="clear"?"input_screen.streamer_clear":"input_screen.streamer_reject",itemId,body.reason,JSON.stringify({inputScreenId:row.input_screen_id,decision:body.decision})]);
    return {proposalId:itemId,inputScreenId:row.input_screen_id,decision:body.decision,state:body.decision==="clear"?"pending":"rejected"};
  });
}

export async function resolveGeneratedEndpointInput(locator:string,inputScreenId:string,request:Request){
  assertSameOrigin(request);const channel=await findChannel(locator);const principal=await requestPrincipal(request);
  const body=await readJson(request,z.object({decision:z.enum(["clear","reject"]),reason:z.string().trim().min(1).max(500)}).strict());
  const actor=body.decision==="clear"?await requireStreamerController(channel,principal):await requireContentReviewer(channel,principal);
  return transaction(async client=>{
    const target=await client.query<{segment_id:string}>(`SELECT s.id AS segment_id FROM sloptogether.input_screens i
      JOIN sloptogether.boundary_revisions b ON b.moderation_evidence_id=i.id JOIN sloptogether.assets a ON a.id=b.asset_id
      JOIN sloptogether.segment_revisions sr ON sr.id=b.source_revision_id JOIN sloptogether.segments s ON s.id=sr.segment_id
      WHERE i.id=$1 AND b.twitch_channel_id=$2 AND b.transformation->>'kind'='generated_endpoint_frame' AND a.status='quarantine'`,[inputScreenId,channel.twitch_channel_id]);
    const segmentId=target.rows[0]?.segment_id;if(!segmentId)throw new ApiError(404,"endpoint_review_item_not_found");
    const segmentLock=await client.query<{selected_revision_id:string|null}>(`SELECT s.selected_revision_id FROM sloptogether.segments s
      JOIN sloptogether.branches b ON b.id=s.branch_id AND b.is_selected AND b.archived_at IS NULL
      WHERE s.id=$1 AND s.twitch_channel_id=$2 FOR UPDATE OF s,b`,[segmentId,channel.twitch_channel_id]);
    const selectedRevision=segmentLock.rows[0]?.selected_revision_id;
    const item=await client.query<{asset_id:string;boundary_id:string;source_revision_id:string;transformation:{sourceArtifactId?:string;sourceSha256?:string;sourceInputSha256?:string;approvalPath?:string};automated_state:string;effective_state:string}>(
      `SELECT a.id AS asset_id,b.id AS boundary_id,b.source_revision_id,b.transformation,i.automated_state,i.effective_state
       FROM sloptogether.input_screens i JOIN sloptogether.boundary_revisions b ON b.moderation_evidence_id=i.id
       JOIN sloptogether.assets a ON a.id=b.asset_id WHERE i.id=$1 AND b.twitch_channel_id=$2
         AND b.transformation->>'kind'='generated_endpoint_frame' AND a.status='quarantine' AND b.source_revision_id=$3
       FOR UPDATE OF i,b,a`,[inputScreenId,channel.twitch_channel_id,selectedRevision??null]);
    const row=item.rows[0];if(!row)throw new ApiError(409,"endpoint_revision_changed");
    if(row.effective_state==="clear")throw new ApiError(409,"endpoint_input_already_clear");
    const {authorizeManualInputResolution}=await import("./preflight");
    await authorizeManualInputResolution(client,inputScreenId,actor,body.reason,body.decision);
    if(body.decision==="reject"){
      await client.query("UPDATE sloptogether.assets SET status='rejected' WHERE id=$1 AND status='quarantine'",[row.asset_id]);
      await client.query("UPDATE sloptogether.boundary_revisions SET retired_at=now() WHERE id=$1 AND retired_at IS NULL",[row.boundary_id]);
    }else{
      const sourceSha=typeof row.transformation.sourceSha256==="string"&&/^[a-f0-9]{64}$/i.test(row.transformation.sourceSha256)?Buffer.from(row.transformation.sourceSha256,"hex"):null;
      const inputSha=typeof row.transformation.sourceInputSha256==="string"&&/^[a-f0-9]{64}$/i.test(row.transformation.sourceInputSha256)?Buffer.from(row.transformation.sourceInputSha256,"hex"):null;
      if(!sourceSha||!inputSha||!row.transformation.sourceArtifactId)throw new ApiError(409,"endpoint_source_evidence_missing");
      const source=await client.query(`SELECT 1 FROM sloptogether.assets a JOIN sloptogether.program_items pi ON pi.asset_id=a.id AND pi.committed_at IS NOT NULL
        WHERE a.id=$1 AND a.twitch_channel_id=$2 AND a.sha256=$3 AND a.status='published' AND pi.segment_id=$4 LIMIT 1`,[row.transformation.sourceArtifactId,channel.twitch_channel_id,sourceSha,segmentId]);
      if(!source.rowCount)throw new ApiError(409,"endpoint_source_not_committed");
      await client.query("UPDATE sloptogether.assets SET status='approved' WHERE id=$1 AND status='quarantine'",[row.asset_id]);
      await client.query(`INSERT INTO sloptogether.endpoint_resolutions(segment_revision_id,source_artifact_id,source_sha256,source_input_sha256,resolved_end_boundary_revision_id,approval_path)
        VALUES($1,$2,$3,$4,$5,'streamer_override') ON CONFLICT(segment_revision_id,source_artifact_id) DO NOTHING`,[row.source_revision_id,row.transformation.sourceArtifactId,sourceSha,inputSha,row.boundary_id]);
    }
    await client.query("INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,action,target_kind,target_id,reason,after_state) VALUES($1,$2,$3,'input_screen',$4,$5,$6::jsonb)",[channel.twitch_channel_id,actor,body.decision==="clear"?"endpoint.input_streamer_clear":"endpoint.input_reject",inputScreenId,body.reason,JSON.stringify({boundaryRevisionId:row.boundary_id,decision:body.decision})]);
    return {inputScreenId,boundaryRevisionId:row.boundary_id,decision:body.decision,state:body.decision==="clear"?"clear":"rejected"};
  });
}

export async function decideReview(locator:string,itemId:string,request:Request){
  assertSameOrigin(request);const channel=await findChannel(locator);const principal=await requestPrincipal(request);
  const actor=await requireContentReviewer(channel,principal);
  const body=await readJson(request,z.object({decision:z.enum(["approve","reject"]),reason:z.string().trim().max(500)}).strict());
  return transaction(async client=>{
    const result=await client.query<{id:string;state:string;review_reason:string|null;election_id:string;election_state:string;closes_at:Date;segment_id:string;segment_state:string;selected_revision_id:string|null;protected_at:Date|null;segment_revision_id:string|null;input_screen_id:string|null;asset_id:string|null;asset_sha256:Buffer|null;asset_status:string|null;end_asset_id:string|null;end_asset_sha256:Buffer|null;end_asset_status:string|null;automated_state:string|null;effective_state:string|null;screen_expires_at:Date|null}>(
      "SELECT p.id,p.state,p.review_reason,p.election_id,e.state AS election_state,e.closes_at,e.segment_id,s.state AS segment_state,s.selected_revision_id,s.protected_at,p.segment_revision_id,p.input_screen_id,a.id AS asset_id,a.sha256 AS asset_sha256,a.status AS asset_status,ea.id AS end_asset_id,ea.sha256 AS end_asset_sha256,ea.status AS end_asset_status,sc.automated_state,sc.effective_state,sc.expires_at AS screen_expires_at FROM sloptogether.proposals p "+
      "JOIN sloptogether.elections e ON e.id=p.election_id JOIN sloptogether.segments s ON s.id=e.segment_id "+
      "LEFT JOIN sloptogether.boundary_revisions b ON b.id=p.start_boundary_revision_id LEFT JOIN sloptogether.assets a ON a.id=b.asset_id "+
      "LEFT JOIN sloptogether.boundary_revisions eb ON eb.id=p.end_boundary_revision_id LEFT JOIN sloptogether.assets ea ON ea.id=eb.asset_id "+
      "LEFT JOIN sloptogether.input_screens sc ON sc.id=p.input_screen_id "+
      "WHERE p.id=$1 AND s.twitch_channel_id=$2 FOR UPDATE OF p,e,s",[itemId,channel.twitch_channel_id]);
    const row=result.rows[0];if(!row)throw new ApiError(404,"review_item_not_found");
    if(row.review_reason==="awaiting_bits_payment")throw new ApiError(409,"bits_payment_pending");
    if(row.state!=="pending")throw new ApiError(409,"review_item_already_decided");
    if(body.decision==="approve"){
      if(row.election_state==="selected"||row.election_state==="superseded"||row.segment_state==="played"||row.segment_state==="retired"||row.segment_state==="rendering"||row.protected_at)
        throw new ApiError(409,"proposal_slot_already_resolved");
      if(!row.input_screen_id)throw new ApiError(409,"input_screen_evidence_missing");
      if(row.effective_state!=="clear")throw new ApiError(409,"input_screen_not_clear","This input is held by automated moderation and needs an explicit streamer resolution before approval.");
      if(row.screen_expires_at&&row.screen_expires_at.getTime()<=Date.now())throw new ApiError(409,"input_screen_expired","This input needs a fresh moderation check before approval.");
      for(const image of [{id:row.asset_id,sha:row.asset_sha256,status:row.asset_status},{id:row.end_asset_id,sha:row.end_asset_sha256,status:row.end_asset_status}])if(image.id){
        if(!image.sha||!['quarantine','validated','approved'].includes(image.status??""))throw new ApiError(409,"image_asset_not_reviewable");
        await client.query("UPDATE sloptogether.assets SET status='approved' WHERE id=$1 AND twitch_channel_id=$2 AND status IN ('quarantine','validated')",[image.id,channel.twitch_channel_id]);
        await client.query(`INSERT INTO sloptogether.artifact_approvals(asset_id,sha256,input_screen_id,approval_path,reviewer_twitch_user_id,trust_policy_revision,decision,reason)
          VALUES($1,$2,$3,'human_review',$4,$5,'approved',$6)`,[image.id,image.sha,row.input_screen_id,actor,channel.policy_revision,body.reason]);
      }
    }
    const state=body.decision==="approve"?"eligible":"rejected";
    await client.query("UPDATE sloptogether.proposals SET state=$2,reviewed_by=$3,reviewed_at=now(),review_reason=$4 WHERE id=$1",[itemId,state,actor,body.reason]);
    if(body.decision==="approve"){
      await client.query("UPDATE sloptogether.elections SET state='open',closes_at=now()+interval '120 seconds' WHERE id=$1 AND (state='closed' OR (state='open' AND closes_at<=now()))",[row.election_id]);
      await client.query("UPDATE sloptogether.segments SET state='voting' WHERE id=$1 AND state IN ('open','voting')",[row.segment_id]);
    }
    if(body.decision==="reject"){
      await client.query("UPDATE sloptogether.segments SET state='open' WHERE id=$1 AND state IN ('open','voting')",[row.segment_id]);
      for(const image of [{id:row.asset_id,sha:row.asset_sha256},{id:row.end_asset_id,sha:row.end_asset_sha256}])if(image.id){
        await client.query("UPDATE sloptogether.assets SET status='rejected' WHERE id=$1 AND status IN ('quarantine','validated')",[image.id]);
        if(image.sha&&row.input_screen_id)await client.query(`INSERT INTO sloptogether.artifact_approvals(asset_id,sha256,input_screen_id,approval_path,reviewer_twitch_user_id,trust_policy_revision,decision,reason)
          VALUES($1,$2,$3,'human_review',$4,$5,'rejected',$6)`,[image.id,image.sha,row.input_screen_id,actor,channel.policy_revision,body.reason]);
      }
    }
    await client.query("INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,action,target_kind,target_id,reason,after_state) VALUES($1,$2,$3,'proposal',$4,$5,$6::jsonb)",[channel.twitch_channel_id,actor,"proposal."+state,itemId,body.reason,JSON.stringify({state})]);
    return {id:itemId,state};
  });
}

export async function decideArtifactReview(locator:string,assetId:string,request:Request){
  assertSameOrigin(request);const channel=await findChannel(locator);const principal=await requestPrincipal(request);
  const actor=await requireContentReviewer(channel,principal);
  const body=await readJson(request,z.object({decision:z.enum(["approve","reject"]),reason:z.string().trim().max(500)}).strict());
  if(body.decision==="reject"&&!body.reason)throw new ApiError(400,"review_reason_required");
  return transaction(async client=>{
    const channelLock=await client.query("SELECT twitch_channel_id FROM sloptogether.channels WHERE twitch_channel_id=$1 AND is_enabled FOR UPDATE",[channel.twitch_channel_id]);
    if(!channelLock.rowCount)throw new ApiError(404,"channel_not_found");
    const segmentLock=await client.query<{id:string;selected_revision_id:string|null;state:string;revision_id:string}>(`SELECT s.id,s.selected_revision_id,s.state,sr.id AS revision_id
      FROM sloptogether.assets a JOIN sloptogether.job_attempts ja ON ja.output_asset_id=a.id
      JOIN sloptogether.jobs j ON j.id=ja.job_id JOIN sloptogether.segment_revisions sr ON sr.id=j.segment_revision_id
      JOIN sloptogether.segments s ON s.id=sr.segment_id
      WHERE a.id=$1 AND a.twitch_channel_id=$2 AND j.stage IN ('video_base','video_upscale') FOR UPDATE OF s`,[assetId,channel.twitch_channel_id]);
    const lockedSegment=segmentLock.rows[0];
    const result=await client.query<{id:string;sha256:Buffer|null;status:string;uploaded_by_twitch_user_id:string|null;input_screen_id:string|null;effective_state:string|null;screen_expires_at:Date|null;stage:string;job_id:string;attempt_id:string;segment_revision_id:string|null;segment_id:string|null;interrupt_id:string|null;funding_id:string|null;preair_pending:boolean}>(
      `SELECT a.id,a.sha256,a.status,a.uploaded_by_twitch_user_id,i.id AS input_screen_id,i.effective_state,i.expires_at AS screen_expires_at,
        j.stage,j.id AS job_id,ja.id AS attempt_id,j.segment_revision_id,sr.segment_id,j.interrupt_id,coalesce(ja.funding_id,j.funding_id) AS funding_id,
        EXISTS(SELECT 1 FROM sloptogether.preair_upscale_requests p WHERE p.upscale_job_id=j.id AND p.state='pending' AND p.deadline_at>now()) AS preair_pending
       FROM sloptogether.assets a JOIN sloptogether.job_attempts ja ON ja.output_asset_id=a.id
       JOIN sloptogether.jobs j ON j.id=ja.job_id LEFT JOIN sloptogether.segment_revisions sr ON sr.id=j.segment_revision_id
       LEFT JOIN sloptogether.input_screens i ON i.id=coalesce(NULLIF(j.planning_payload->>'inputScreenId','')::uuid,
         (SELECT p.input_screen_id FROM sloptogether.proposals p WHERE p.segment_revision_id=j.segment_revision_id AND p.input_screen_id IS NOT NULL ORDER BY p.created_at DESC LIMIT 1),
         (SELECT sp.screen_id FROM sloptogether.story_plan_attempts sp JOIN sloptogether.segment_revisions rs ON rs.segment_id=sp.resulting_segment_id WHERE rs.id=j.segment_revision_id AND sp.screen_id IS NOT NULL ORDER BY sp.created_at DESC LIMIT 1))
       WHERE a.id=$1 AND a.twitch_channel_id=$2 AND a.media_kind='video' AND ja.state='validating' AND j.stage IN ('video_base','video_upscale')
       FOR UPDATE OF a,ja,j`,[assetId,channel.twitch_channel_id]);
    const row=result.rows[0];if(!row||row.status!=="validated"||!row.sha256)throw new ApiError(404,"validated_video_not_found");
    if(row.stage==="video_base"&&!lockedSegment)throw new ApiError(409,"artifact_segment_missing");
    if(body.decision==="approve"&&row.stage==="video_base"&&!row.interrupt_id&&lockedSegment?.selected_revision_id!==row.segment_revision_id)
      throw new ApiError(409,"artifact_revision_no_longer_selected","This clip no longer belongs to the selected scene revision.");
    if(body.decision==="approve"&&row.stage==="video_base"&&!row.interrupt_id&&["played","retired"].includes(lockedSegment?.state??""))
      throw new ApiError(409,"artifact_program_history_immutable");
    if(body.decision==="approve"&&row.interrupt_id){
      const interrupt=await client.query<{program_state:string;expires_at:Date;enabled:boolean}>(`SELECT ir.program_state,ir.expires_at,(c.subscriber_interrupt_policy->>'enabled')::boolean AS enabled
        FROM sloptogether.interrupt_requests ir JOIN sloptogether.channels c ON c.twitch_channel_id=ir.broadcaster_twitch_id
        WHERE ir.id=$1 AND ir.broadcaster_twitch_id=$2 FOR UPDATE OF ir`,[row.interrupt_id,channel.twitch_channel_id]);
      const current=interrupt.rows[0];
      if(!current||current.program_state!=="rendering"||!current.enabled||current.expires_at.getTime()<=Date.now())
        throw new ApiError(409,"subscriber_interrupt_no_longer_eligible");
    }
    if(!row.input_screen_id)throw new ApiError(409,"asset_input_screen_missing");
    // Worker upload admission already required a clear, unexpired screen at dispatch
    // and upload time. Keep that exact screen evidence for human review even if its
    // short-lived dispatch TTL expires while the clip waits in the moderation queue.
    if(body.decision==="approve"&&row.effective_state!=="clear")
      throw new ApiError(409,"asset_input_not_clear","This clip's source input is held and cannot be approved.");
    await client.query(`INSERT INTO sloptogether.artifact_approvals(asset_id,sha256,input_screen_id,approval_path,reviewer_twitch_user_id,uploader_twitch_user_id,trust_policy_revision,decision,reason)
      VALUES($1,$2,$3,'human_review',$4,$5,$6,$7,$8)`,[assetId,row.sha256,row.input_screen_id,actor,row.uploaded_by_twitch_user_id,channel.policy_revision,body.decision==="approve"?"approved":"rejected",body.reason]);
    const approved=body.decision==="approve";
    await client.query("UPDATE sloptogether.assets SET status=$2 WHERE id=$1 AND status='validated'",[assetId,approved?"approved":"rejected"]);
    await client.query("UPDATE sloptogether.job_attempts SET state=$2,finished_at=now(),error_code=$3 WHERE id=$1 AND state='validating'",[row.attempt_id,approved?"succeeded":"rejected",approved?null:"artifact_rejected"]);
    await client.query("UPDATE sloptogether.jobs SET state=$2,completed_at=now() WHERE id=$1 AND state='validating'",[row.job_id,approved?"succeeded":"failed"]);
    if(row.funding_id){
      const outcome=approved?"consumed_succeeded":"consumed_rejected";
      await client.query("UPDATE sloptogether.funding_authorizations SET state=$2,consumed_at=coalesce(consumed_at,now()),settled_at=now() WHERE id=$1 AND state IN ('reserved','consumed_uncertain')",[row.funding_id,outcome]);
      await client.query("UPDATE sloptogether.paid_action_intents SET state=$2,state_reason=$3,updated_at=now() WHERE id=(SELECT paid_action_intent_id FROM sloptogether.funding_authorizations WHERE id=$1)",[row.funding_id,outcome,approved?"artifact_approved":"artifact_rejected"]);
      await client.query("UPDATE sloptogether.extension_bits_transactions SET settlement_state=$2,processed_at=now() WHERE intent_id=(SELECT paid_action_intent_id FROM sloptogether.funding_authorizations WHERE id=$1)",[row.funding_id,outcome]);
    }
    if(row.interrupt_id&&row.stage==="video_base"){
      await client.query("UPDATE sloptogether.interrupt_requests SET program_state=$2 WHERE id=$1 AND program_state='rendering'",[row.interrupt_id,approved?"rendering":"failed"]);
      if(!approved)await client.query("UPDATE sloptogether.subscription_events SET state='failed' WHERE interrupt_id=$1 AND state NOT IN ('played','cancelled','expired')",[row.interrupt_id]);
    }else if(row.segment_revision_id&&row.stage==="video_base"){
      if(approved){
        await client.query("UPDATE sloptogether.segment_revisions SET state='ready' WHERE id=$1 AND state IN ('selected','locked','rendering','ready')",[row.segment_revision_id]);
        await client.query("UPDATE sloptogether.segments SET state='ready' WHERE id=$1 AND selected_revision_id=$2 AND state NOT IN ('played','retired')",[row.segment_id,row.segment_revision_id]);
      }else{
        await client.query("UPDATE sloptogether.segment_revisions SET state='rejected' WHERE id=$1 AND state NOT IN ('played','superseded')",[row.segment_revision_id]);
        await client.query("UPDATE sloptogether.proposals SET state='rejected',reviewed_by=$2,reviewed_at=now(),review_reason=$3 WHERE segment_revision_id=$1 AND state IN ('eligible','selected','superseded')",[row.segment_revision_id,actor,body.reason||"Generated clip rejected by moderator"]);
        await client.query("UPDATE sloptogether.segments SET state='open',selected_revision_id=NULL,protected_at=NULL WHERE id=$1 AND selected_revision_id=$2 AND state NOT IN ('played','retired')",[row.segment_id,row.segment_revision_id]);
      }
    }
    const publicationPending=approved&&row.stage==="video_base";
    if(publicationPending){
      await client.query("SELECT sloptogether.schedule_preair_upscale($1)",[assetId]);
      await client.query(`INSERT INTO sloptogether.outbox(event_kind,aggregate_id,payload,idempotency_key)
        VALUES('media.publish_requested',$1,$2::jsonb,$3) ON CONFLICT(idempotency_key) DO NOTHING`,[assetId,JSON.stringify({assetId,approvalPath:"human_review"}),"publish:"+assetId+":"+row.sha256.toString("hex")]);
    }
    await client.query("INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,action,target_kind,target_id,reason,after_state) VALUES($1,$2,$3,'asset',$4,$5,$6::jsonb)",[
      channel.twitch_channel_id,actor,approved?"artifact.approved":"artifact.rejected",assetId,body.reason,JSON.stringify({jobId:row.job_id,attemptId:row.attempt_id,stage:row.stage,sha256:row.sha256.toString("hex")})]);
    return {assetId,state:approved?"approved":"rejected",publicationPending,preairPending:approved&&row.stage==="video_upscale"&&row.preair_pending};
  });
}

export async function issueWorkerKey(locator:string,request:Request){
  assertSameOrigin(request);const channel=await findChannel(locator);const principal=await requestPrincipal(request);
  const issuer=await requireStreamerController(channel,principal);
  const body=await readJson(request,z.object({
    displayName:z.string().trim().min(1).max(80),
    scopes:z.array(z.enum(workerKeyScopes)).min(1).max(workerKeyScopes.length),
  }).strict());
  if(body.scopes.includes("streamer:control")&&issuer!==channel.owner_twitch_user_id)throw new ApiError(403,"only_broadcaster_can_grant_streamer_control");
  const secret=randomSecret(32);const id=randomUUID();const value="slw_"+id+"."+secret;
  await transaction(async client=>{
    await client.query(
      "INSERT INTO sloptogether.application_keys(key_id,secret_hash,key_prefix,issuing_twitch_user_id,twitch_channel_id,display_name,scopes,worker_roles,recipe_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [id,hmacKeySecret(value),"slw_"+id,issuer,channel.twitch_channel_id,body.displayName,[...new Set(body.scopes)],body.scopes.filter(scope=>scope.startsWith("worker:")).map(scope=>scope.slice(7)),[]],
    );
    for(const scope of new Set(body.scopes)){
      const executionRole=scope==="worker:generation"?"generation":scope==="worker:upscale"?"upscale":scope==="story:write_future"?"story_producer":scope==="streamer:control"?"streamer_control":null;
      if(executionRole)await client.query(`INSERT INTO sloptogether.trusted_executions(twitch_channel_id,key_id,issuer_twitch_user_id,execution_role,recipe_ids,policy_revision)
        VALUES($1,$2,$3,$4,$5,$6)`,[channel.twitch_channel_id,id,issuer,executionRole,[],channel.policy_revision]);
    }
    await client.query("INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,actor_key_id,action,target_kind,target_id,after_state) VALUES($1,$2,$3,'worker_key.issue','application_key',$5,$4::jsonb)",[channel.twitch_channel_id,issuer,id,JSON.stringify({displayName:body.displayName,scopes:body.scopes}),id]);
  });
  return {keyId:id,secret:value,displayName:body.displayName,scopes:body.scopes};
}

/** Reaffirm an existing trust scope only after audited, non-authority changes. */
export async function reaffirmWorkerTrust(locator:string,keyId:string,request:Request){
  assertSameOrigin(request);
  if(!z.string().uuid().safeParse(keyId).success)throw new ApiError(400,"worker_key_invalid");
  const channel=await findChannel(locator);const principal=await requestPrincipal(request);
  if(principal?.kind!=="session"||principal.session.twitchUserId!==channel.owner_twitch_user_id)
    throw new ApiError(403,"broadcaster_session_required");
  const actor=principal.session.twitchUserId;
  const body=await readJson(request,z.object({reason:z.string().trim().min(10).max(500)}).strict());
  return transaction(async client=>{
    const locked=await client.query<{owner_twitch_user_id:string;policy_revision:number}>(
      "SELECT owner_twitch_user_id,policy_revision FROM sloptogether.channels WHERE twitch_channel_id=$1 AND is_enabled FOR UPDATE",[channel.twitch_channel_id]);
    const current=locked.rows[0];
    if(!current||current.owner_twitch_user_id!==actor)throw new ApiError(403,"broadcaster_session_required");
    if(await isBanned(channel.twitch_channel_id,actor,client))throw new ApiError(403,"channel_ban_active");
    const keys=await client.query<{issuing_twitch_user_id:string;scopes:string[]}>(`SELECT issuing_twitch_user_id,scopes
      FROM sloptogether.application_keys WHERE key_id=$1 AND twitch_channel_id=$2 AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at>now()) FOR UPDATE`,[keyId,channel.twitch_channel_id]);
    const key=keys.rows[0];
    if(!key||!key.scopes.includes("artifact:system_approve"))throw new ApiError(404,"trusted_worker_key_not_found");
    if(await isBanned(channel.twitch_channel_id,key.issuing_twitch_user_id,client))throw new ApiError(403,"channel_ban_active");
    const bindings=await client.query<{id:string;execution_role:string;policy_revision:number;issuer_twitch_user_id:string}>(`SELECT id,execution_role,policy_revision,issuer_twitch_user_id
      FROM sloptogether.trusted_executions WHERE key_id=$1 AND twitch_channel_id=$2 AND revoked_at IS NULL
        AND execution_role IN ('generation','upscale') FOR UPDATE`,[keyId,channel.twitch_channel_id]);
    if(!bindings.rows.length||bindings.rows.some(binding=>binding.issuer_twitch_user_id!==key.issuing_twitch_user_id
      ||!key.scopes.includes(`worker:${binding.execution_role}`)||binding.policy_revision>current.policy_revision))
      throw new ApiError(409,"trusted_worker_binding_invalid");
    const stale=bindings.rows.filter(binding=>binding.policy_revision<current.policy_revision);
    if(!stale.length)return {keyId,state:"current"};
    const earliest=Math.min(...stale.map(binding=>binding.policy_revision));
    if(current.policy_revision-earliest>100)throw new ApiError(409,"trusted_worker_reaffirmation_unavailable","Trust history is too old. Revoke and issue a new trusted worker key.");
    const history=await client.query<{policy_revision:number;action:string;after_state:unknown}>(`SELECT policy_revision,action,after_state
      FROM sloptogether.audit_log WHERE twitch_channel_id=$1 AND action IN ('channel.settings.update','subscriber_interrupt.settings','eventsub.revoked')
        AND policy_revision>$2 AND policy_revision<=$3 ORDER BY policy_revision`,[channel.twitch_channel_id,earliest,current.policy_revision]);
    const safe=new Set<number>();
    for(const entry of history.rows){
      if(safe.has(entry.policy_revision)||!isSafeTrustedPolicyAudit(entry.action,entry.after_state))
        throw new ApiError(409,"trusted_worker_reaffirmation_unavailable","Trust cannot be reaffirmed after an authorization or access change. Revoke and issue a new trusted worker key.");
      safe.add(entry.policy_revision);
    }
    for(let revision=earliest+1;revision<=current.policy_revision;revision++)if(!safe.has(revision))
      throw new ApiError(409,"trusted_worker_reaffirmation_unavailable","Trust history is incomplete. Revoke and issue a new trusted worker key.");
    const ids=stale.map(binding=>binding.id);
    await client.query("UPDATE sloptogether.trusted_executions SET policy_revision=$2 WHERE id=ANY($1::uuid[]) AND revoked_at IS NULL",[ids,current.policy_revision]);
    await client.query(`INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,action,target_kind,target_id,reason,policy_revision,after_state)
      VALUES($1,$2,'worker_key.trust_reaffirmed','application_key',$3,$4,$5,$6::jsonb)`,
      [channel.twitch_channel_id,actor,keyId,body.reason,current.policy_revision,JSON.stringify({bindingIds:ids,previousRevisions:stale.map(binding=>binding.policy_revision)})]);
    return {keyId,state:"reaffirmed"};
  });
}

export async function listWorkerKeys(locator:string,request:Request){
  const channel=await findChannel(locator);const principal=await requestPrincipal(request);
  await requireStreamerController(channel,principal);
  const result=await query<{key_id:string;display_name:string;scopes:string[];created_at:Date;expires_at:Date|null;last_used_at:Date|null}>(
    "SELECT key_id,display_name,scopes,created_at,expires_at,last_used_at FROM sloptogether.application_keys WHERE twitch_channel_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 100",[channel.twitch_channel_id]);
  return {keys:result.rows.map(row=>({keyId:row.key_id,displayName:row.display_name,scopes:row.scopes,createdAt:row.created_at.toISOString(),expiresAt:row.expires_at?.toISOString()??null,lastUsedAt:row.last_used_at?.toISOString()??null}))};
}

export async function revokeWorkerKey(locator:string,keyId:string,request:Request){
  assertSameOrigin(request);const channel=await findChannel(locator);const principal=await requestPrincipal(request);
  const actor=await requireStreamerController(channel,principal);
  return transaction(async client=>{
    const key=await client.query<{key_id:string;display_name:string}>("UPDATE sloptogether.application_keys SET revoked_at=coalesce(revoked_at,now()),key_revision=key_revision+1 WHERE key_id=$1 AND twitch_channel_id=$2 AND revoked_at IS NULL RETURNING key_id,display_name",[keyId,channel.twitch_channel_id]);
    if(!key.rows[0])throw new ApiError(404,"active_worker_key_not_found");
    const bindings=await client.query<{id:string}>("UPDATE sloptogether.trusted_executions SET revoked_at=coalesce(revoked_at,now()) WHERE key_id=$1 AND revoked_at IS NULL RETURNING id",[keyId]);
    const ids=bindings.rows.map(row=>row.id);
    let affectedJobs:string[]=[];let abandonedStoryPlans:string[]=[];let requeuedInterrupts:string[]=[];
    if(ids.length){
      await lockRevokedWorkerSegments(client,ids,channel.twitch_channel_id);
      const producers=await client.query<{id:string}>("SELECT id FROM sloptogether.story_producers WHERE execution_binding_id=ANY($1::uuid[]) AND released_at IS NULL FOR UPDATE",[ids]);
      const abandoned=await abandonStoryProducerPlans(client,producers.rows.map(row=>row.id));
      abandonedStoryPlans=abandoned.planIds;requeuedInterrupts=abandoned.interruptIds;
      const producerIds=producers.rows.map(row=>row.id);
      if(producerIds.length)await client.query("UPDATE sloptogether.story_producers SET fence=fence+1,released_at=now(),lease_expires_at=now() WHERE id=ANY($1::uuid[]) AND released_at IS NULL",[producerIds]);
      const attempts=await client.query<{id:string;job_id:string;provider_request_id:string|null}>(`UPDATE sloptogether.job_attempts SET state='cancelled',fence=fence+1,lease_expires_at=now(),finished_at=now(),error_code='worker_key_revoked'
        WHERE execution_binding_id=ANY($1::uuid[]) AND state NOT IN ('succeeded','failed','rejected','expired','cancelled') RETURNING id,job_id,provider_request_id`,[ids]);
      affectedJobs=[...new Set(attempts.rows.map(row=>row.job_id))];
      if(affectedJobs.length)await client.query("UPDATE sloptogether.jobs SET state='cancelled',cancelled_at=now() WHERE id=ANY($1::uuid[]) AND state NOT IN ('succeeded','failed','cancelled','expired')",[affectedJobs]);
      await client.query("UPDATE sloptogether.upload_reservations SET state='expired' WHERE attempt_id=ANY($1::uuid[]) AND state='issued'",[attempts.rows.map(row=>row.id)]);
      for(const attempt of attempts.rows)if(attempt.provider_request_id)await client.query("INSERT INTO sloptogether.outbox(event_kind,aggregate_id,payload,idempotency_key) VALUES('provider.reconcile_cancel',$1,$2::jsonb,$3) ON CONFLICT(idempotency_key) DO NOTHING",[attempt.id,JSON.stringify({attemptId:attempt.id,providerRequestId:attempt.provider_request_id,reason:"worker_key_revoked"}),"key-revoke:"+attempt.id]);
      await retireRevokedWorkerJobs(client,affectedJobs,"Worker access was revoked before the clip was uploaded.");
    }
    await client.query("INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,actor_key_id,action,target_kind,target_id,after_state) VALUES($1,$2,$3,'worker_key.revoke','application_key',$4,$5::jsonb)",[channel.twitch_channel_id,actor,principal?.kind==="worker-key"?principal.worker.keyId:null,keyId,JSON.stringify({displayName:key.rows[0]!.display_name,affectedJobs,abandonedStoryPlans,requeuedInterrupts})]);
    return {keyId,revoked:true,affectedJobs,abandonedStoryPlans,requeuedInterrupts};
  });
}
