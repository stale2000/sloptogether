import { createHash, randomUUID } from "node:crypto";
import { compileH3StoryPrompt, storyProposalSchema, type StoryProposal } from "@sloptogether/contracts";
import { ApiError, readJson } from "./http";
import { requireWorker } from "./worker-auth";
import { query, transaction } from "./db";
import { findChannel, isBanned, type ChannelRow } from "./channels";
import { signedPrivateReadUrl } from "./storage";
import { screenPromptAndImages, type InputPreflightResult } from "./preflight";
import { abandonStoryProducerPlans } from "./worker-revocation";
import { reservationUsd } from "./reservation";
import { BASE_GENERATION_SIZE, SUBSCRIBER_INTERRUPT_FRAME_COUNT } from "./generation-profile";
import { getStream } from "./stream-service";
import type { PoolClient } from "pg";

const SUBSCRIBER_INTERRUPT_RECIPE="fast-h3-trim-5step-vsa20-b1-10s";

async function ownerAttemptBudgetBlock(client:PoolClient,channelId:string,cap:string){
  const quote=reservationUsd("SLOPTOGETHER_GENERATION_ATTEMPT_RESERVATION_USD");
  if(quote===null||Number(cap)<=0)return "owner_generation_budget_unavailable";
  const spent=await client.query<{total:string}>(`SELECT coalesce(sum(greatest(reserved_usd,coalesce(actual_cost_usd,0))),0)::text AS total
    FROM sloptogether.funding_authorizations WHERE twitch_channel_id=$1 AND source='owner_budget' AND state<>'released'`,[channelId]);
  return Number(spent.rows[0]?.total??0)+quote>Number(cap) ? "owner_generation_budget_exhausted" : null;
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

export async function claimStoryProducer(locator:string,request:Request,streamSlug="main"){
  const channel=await findChannel(locator);const grant=await requireWorker(request,"story:write_future");
  const stream=await getStream(channel.twitch_channel_id,streamSlug);
  if(grant.channelId!==channel.twitch_channel_id||grant.issuingTwitchUserId!==channel.owner_twitch_user_id)throw new ApiError(403,"story_producer_owner_key_required");
  if(await isBanned(channel.twitch_channel_id,grant.issuingTwitchUserId))throw new ApiError(403,"channel_ban_active");
  return transaction(async client=>{
    const current=await client.query<{policy_revision:number;subscriber_interrupt_policy:Record<string,unknown>;owner_budget_cap_usd:string}>("SELECT policy_revision,subscriber_interrupt_policy,owner_budget_cap_usd FROM sloptogether.channels WHERE twitch_channel_id=$1 AND is_enabled FOR UPDATE",[channel.twitch_channel_id]);
    if(current.rows[0]?.policy_revision!==channel.policy_revision)throw new ApiError(409,"channel_policy_changed");
    const binding=await client.query<{id:string}>("SELECT id FROM sloptogether.trusted_executions WHERE twitch_channel_id=$1 AND key_id=$2 AND execution_role='story_producer' AND revoked_at IS NULL ORDER BY enabled_at DESC LIMIT 1",[channel.twitch_channel_id,grant.keyId]);
    if(!binding.rows[0])throw new ApiError(403,"story_producer_binding_revoked");
    const existing=await client.query<{id:string;fence:string;last_sequence:string;lease_expires_at:Date;execution_binding_id:string}>("SELECT id,fence,last_sequence,lease_expires_at,execution_binding_id FROM sloptogether.story_producers WHERE stream_id=$1 AND released_at IS NULL FOR UPDATE",[stream.id]);
    let leaseId:string;let fence:number;let sequence:number;
    if(existing.rows[0]&&existing.rows[0].lease_expires_at.getTime()>Date.now()){
      if(existing.rows[0].execution_binding_id!==binding.rows[0].id)throw new ApiError(409,"story_producer_already_active");
      leaseId=existing.rows[0].id;fence=Number(existing.rows[0].fence);sequence=Number(existing.rows[0].last_sequence)+1;
    }else{
      if(existing.rows[0])await abandonStoryProducerPlans(client,[existing.rows[0].id]);
      await client.query("UPDATE sloptogether.story_producers SET released_at=now() WHERE stream_id=$1 AND released_at IS NULL",[stream.id]);
      const prior=await client.query<{fence:string}>("SELECT coalesce(max(fence),0)::text AS fence FROM sloptogether.story_producers WHERE stream_id=$1",[stream.id]);
      fence=Number(prior.rows[0]!.fence)+1;leaseId=randomUUID();sequence=1;
      await client.query("INSERT INTO sloptogether.story_producers(id,twitch_channel_id,stream_id,execution_binding_id,fence,last_sequence,lease_expires_at) VALUES($1,$2,$3,$4,$5,0,now()+interval '90 seconds')",[leaseId,channel.twitch_channel_id,stream.id,binding.rows[0]!.id,fence]);
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
        coalesce((SELECT sr.prompt FROM sloptogether.segment_revisions sr JOIN sloptogether.segments s ON s.id=sr.segment_id JOIN sloptogether.branches b ON b.id=s.branch_id WHERE b.stream_id=$2 AND sr.state IN ('ready','played') ORDER BY s.ordinal DESC LIMIT 1),'' ) AS recent_story_summary,
        coalesce((SELECT sr.dialogue FROM sloptogether.segment_revisions sr JOIN sloptogether.segments s ON s.id=sr.segment_id JOIN sloptogether.branches b ON b.id=s.branch_id WHERE b.stream_id=$2 AND sr.state IN ('ready','played') ORDER BY s.ordinal DESC LIMIT 1),'') AS recent_dialogue
       FROM sloptogether.channels c WHERE c.twitch_channel_id=$1`,[channel.twitch_channel_id,stream.id]);
    const row=context.rows[0]!;
    const interrupt=await client.query<{id:string;subscriber_label:string;plan_payload:Record<string,unknown>}>(`SELECT ir.id,ir.subscriber_label,ir.plan_payload FROM sloptogether.interrupt_requests ir
      JOIN sloptogether.subscription_events se ON se.id=ir.trigger_event_id
      JOIN sloptogether.funding_authorizations f ON f.id=ir.funding_id AND f.state='reserved'
      WHERE ir.broadcaster_twitch_id=$1 AND ir.stream_id=$4 AND ir.program_state='queued' AND ir.expires_at>now()
        AND ($2::jsonb->>'enabled')::boolean=true
        AND EXISTS(SELECT 1 FROM sloptogether.sessions sess WHERE sess.twitch_user_id=$3 AND sess.revoked_at IS NULL AND sess.expires_at>now()
          AND sess.granted_scopes @> ARRAY['channel:read:subscriptions']::text[])
        AND (se.twitch_actor_id IS NULL OR NOT EXISTS(SELECT 1 FROM sloptogether.bans b WHERE b.twitch_user_id=se.twitch_actor_id
          AND b.revoked_at IS NULL AND (b.expires_at IS NULL OR b.expires_at>now()) AND (b.scope='global' OR b.twitch_channel_id=$1)))
      ORDER BY ir.created_at,ir.id LIMIT 1 FOR UPDATE OF ir SKIP LOCKED`,
      [channel.twitch_channel_id,JSON.stringify(current.rows[0]!.subscriber_interrupt_policy),channel.owner_twitch_user_id,stream.id]);
    const queued=interrupt.rows[0];
    if(!queued){
      const blocked=await ownerAttemptBudgetBlock(client,channel.twitch_channel_id,current.rows[0]!.owner_budget_cap_usd);
      if(blocked)throw new ApiError(409,blocked);
    }
    const inputPayload={theme:row.story_world_prompt,recentStorySummary:row.recent_story_summary,recentDialogue:row.recent_dialogue,sceneSeed,
      ...(queued?{interruptId:queued.id,subscriberLabel:queued.subscriber_label}:{} )};
    await client.query(`INSERT INTO sloptogether.story_plan_attempts(twitch_channel_id,stream_id,producer_id,producer_fence,sequence,idempotency_key,expected_channel_revision,input_payload,claim_token,claim_expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,now()+interval '60 seconds')`,[channel.twitch_channel_id,stream.id,leaseId,fence,sequence,idempotencyKey,channel.policy_revision,JSON.stringify(inputPayload),claimToken]);
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
    const lease=await client.query<{id:string;fence:string;lease_expires_at:Date;last_sequence:string;stream_id:string}>(
      "SELECT id,fence,lease_expires_at,last_sequence,stream_id FROM sloptogether.story_producers WHERE id=$1 AND twitch_channel_id=$2 AND released_at IS NULL FOR UPDATE",[body.leaseId,channel.twitch_channel_id]);
    const owner=lease.rows[0];
    if(!owner||Number(owner.fence)!==body.fence||owner.lease_expires_at.getTime()<=Date.now())throw new ApiError(409,"story_producer_lease_fenced");
    if(body.sequence<=Number(owner.last_sequence))throw new ApiError(409,"story_sequence_replayed");
    const planned=await client.query<{expected_channel_revision:number;input_payload:{interruptId?:string}}>(
      "SELECT expected_channel_revision,input_payload FROM sloptogether.story_plan_attempts WHERE producer_id=$1 AND producer_fence=$2 AND sequence=$3 AND idempotency_key=$4 AND claim_token=$5 AND claim_expires_at>now() AND status='planning' FOR UPDATE",
      [body.leaseId,body.fence,body.sequence,body.idempotencyKey,body.claimToken]);
    if(!planned.rows[0]||planned.rows[0].expected_channel_revision!==current.policy_revision||planned.rows[0].input_payload.interruptId!==interruptId)
      throw new ApiError(409,"story_plan_attempt_not_current");
    const request=await client.query<{funding_id:string;expires_at:Date;trigger_event_id:string;subscriber_label:string;event_actor_id:string|null;stream_id:string}>(
      `SELECT ir.funding_id,ir.expires_at,ir.trigger_event_id,ir.subscriber_label,ir.stream_id,se.twitch_actor_id AS event_actor_id
       FROM sloptogether.interrupt_requests ir JOIN sloptogether.subscription_events se ON se.id=ir.trigger_event_id
       JOIN sloptogether.funding_authorizations f ON f.id=ir.funding_id AND f.state='reserved' AND f.source='owner_budget'
       WHERE ir.id=$1 AND ir.broadcaster_twitch_id=$2 AND ir.stream_id=$3 AND ir.program_state='planning' AND ir.expires_at>now() FOR UPDATE OF ir,f`,[interruptId,channel.twitch_channel_id,owner.stream_id]);
    const alert=request.rows[0];if(!alert)throw new ApiError(409,"subscriber_interrupt_expired_or_unfunded");
    if(alert.event_actor_id&&await isBanned(channel.twitch_channel_id,alert.event_actor_id))throw new ApiError(403,"channel_ban_active");
    const boundary=await client.query<{boundary_id:string|null;resolution_id:string|null;revision_id:string;segment_id:string;frame_asset_id:string|null}>(`SELECT coalesce(r.requested_end_boundary_revision_id,er.resolved_end_boundary_revision_id) AS boundary_id,
        CASE WHEN r.requested_end_boundary_revision_id IS NULL THEN er.id ELSE NULL END AS resolution_id,r.id AS revision_id,s.id AS segment_id,frame.asset_id AS frame_asset_id
      FROM sloptogether.branches b JOIN sloptogether.segments s ON s.branch_id=b.id JOIN sloptogether.segment_revisions r ON r.id=s.selected_revision_id
      LEFT JOIN LATERAL(SELECT id,resolved_end_boundary_revision_id FROM sloptogether.endpoint_resolutions WHERE segment_revision_id=r.id AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1) er ON true
      LEFT JOIN sloptogether.boundary_revisions frame ON frame.id=coalesce(r.requested_end_boundary_revision_id,er.resolved_end_boundary_revision_id)
      WHERE b.twitch_channel_id=$1 AND b.stream_id=$2 AND b.is_selected AND b.archived_at IS NULL AND r.state IN ('selected','locked','ready','played')
      ORDER BY s.ordinal DESC LIMIT 1 FOR UPDATE OF s`,[channel.twitch_channel_id,owner.stream_id]);
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
      startFrameAssetId:latest.frame_asset_id,...BASE_GENERATION_SIZE,subscriberLabel:alert.subscriber_label,durationSeconds:10,frameCount:SUBSCRIBER_INTERRUPT_FRAME_COUNT};
    await client.query(`INSERT INTO sloptogether.jobs(id,twitch_channel_id,segment_revision_id,interrupt_id,stage,execution_mode,state,recipe_id,recipe_sha256,input_sha256,requested_by,funding_id,dependency_resolution_id,planning_payload,priority,result_deadline_at)
      VALUES($1,$2,$3,$4,'video_base','pull_worker','ready',$5,$6,$7,$8,$9,$10,$11::jsonb,100,$12)`,
      [jobId,channel.twitch_channel_id,latest.revision_id,interruptId,SUBSCRIBER_INTERRUPT_RECIPE,Buffer.from("9a2d5d19fb22b7e55d29c8e6048c4c421c5b73b044b7cc010188efe7df9ccaef","hex"),Buffer.from(screen.digest,"hex"),channel.owner_twitch_user_id,alert.funding_id,latest.resolution_id,JSON.stringify(planningPayload),alert.expires_at]);
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

export async function submitStoryProposal(locator:string,request:Request,streamSlug="main"){
  const channel=await findChannel(locator);const grant=await requireWorker(request,"story:write_future");
  const stream=await getStream(channel.twitch_channel_id,streamSlug);
  if(grant.channelId!==channel.twitch_channel_id||grant.issuingTwitchUserId!==channel.owner_twitch_user_id)throw new ApiError(403,"story_producer_owner_key_required");
  if(await isBanned(channel.twitch_channel_id,grant.issuingTwitchUserId))throw new ApiError(403,"channel_ban_active");
  const body=await readJson(request,storyProposalSchema);
  const canonicalPrompt=compileH3StoryPrompt(body.plan);
  if(body.compiledH3Prompt!==canonicalPrompt)throw new ApiError(400,"compiled_story_prompt_mismatch");
  const prompt=canonicalPrompt;
  const previewBoundary=await query<{boundary_id:string;resolution_id:string|null;source_revision_id:string;source_segment_id:string}>(`SELECT coalesce(r.requested_end_boundary_revision_id,er.resolved_end_boundary_revision_id) AS boundary_id,
      r.id AS source_revision_id,s.id AS source_segment_id,
      CASE WHEN r.requested_end_boundary_revision_id IS NULL THEN er.id ELSE NULL END AS resolution_id
    FROM sloptogether.branches b JOIN sloptogether.segments s ON s.branch_id=b.id JOIN sloptogether.segment_revisions r ON r.id=s.selected_revision_id
    LEFT JOIN LATERAL(SELECT id,resolved_end_boundary_revision_id FROM sloptogether.endpoint_resolutions WHERE segment_revision_id=r.id AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1) er ON true
    WHERE b.twitch_channel_id=$1 AND b.stream_id=$2 AND b.is_selected=true AND b.archived_at IS NULL AND r.state IN ('selected','locked','ready','played')
    ORDER BY s.ordinal DESC LIMIT 1`,[channel.twitch_channel_id,stream.id]);
  const previewBoundaryId=previewBoundary.rows[0]?.boundary_id;
  if(!previewBoundaryId)throw new ApiError(409,"story_start_boundary_missing");
  const startImage=await readApprovedBoundaryImage(channel.twitch_channel_id,previewBoundaryId);
  const screen=await screenPromptAndImages({channelId:channel.twitch_channel_id,prompt,images:[startImage]});
  if(screen.decision!=="clear")throw new ApiError(422,"story_plan_held");
  if(body.interruptId){
    if(!stream.is_default)throw new ApiError(409,"subscriber_interrupts_default_stream_only");
    return scheduleSubscriberInterrupt(channel,grant.issuingTwitchUserId,grant.keyId,body,prompt,screen,previewBoundary.rows[0]!);
  }
  return transaction(async client=>{
    const policy=await client.query<{policy_revision:number;owner_budget_cap_usd:string}>("SELECT policy_revision,owner_budget_cap_usd FROM sloptogether.channels WHERE twitch_channel_id=$1 AND is_enabled FOR UPDATE",[channel.twitch_channel_id]);
    const currentPolicy=policy.rows[0];if(!currentPolicy||currentPolicy.policy_revision!==channel.policy_revision)throw new ApiError(409,"channel_policy_changed");
    const lease=await client.query<{id:string;fence:string;lease_expires_at:Date;last_sequence:string;stream_id:string}>("SELECT id,fence,lease_expires_at,last_sequence,stream_id FROM sloptogether.story_producers WHERE id=$1 AND twitch_channel_id=$2 AND stream_id=$3 AND released_at IS NULL FOR UPDATE",[body.leaseId,channel.twitch_channel_id,stream.id]);
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
    const branch=await client.query<{id:string}>("SELECT id FROM sloptogether.branches WHERE twitch_channel_id=$1 AND stream_id=$2 AND is_selected=true AND archived_at IS NULL FOR UPDATE",[channel.twitch_channel_id,stream.id]);
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
      [jobId,channel.twitch_channel_id,revision.rows[0]!.id,Buffer.from("9a2d5d19fb22b7e55d29c8e6048c4c421c5b73b044b7cc010188efe7df9ccaef","hex"),Buffer.from(screen.digest,"hex"),grant.issuingTwitchUserId,fundingId,resolutionId,JSON.stringify({inputScreenId:screened.rows[0].id,...BASE_GENERATION_SIZE})]);
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
