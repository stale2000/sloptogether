import { z } from "zod";
import { createHash } from "node:crypto";
import { findChannel, isBanned, requireContentReviewer } from "./channels";
import { query, transaction } from "./db";
import { ApiError, assertSameOrigin, readJson } from "./http";
import { requestPrincipal } from "./principals";
import { getStream } from "./stream-service";
import { resolveCandidateElections } from "./candidate-election";

const approvalInput = z.object({
  boundaryRevisionId: z.string().uuid(),
  expectedCandidateRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict();
const rejectionInput = z.object({
  expectedCandidateRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  reason: z.string().trim().min(1).max(500),
}).strict();
const replanInput = z.object({
  expectedCandidateRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  requestId: z.string().uuid(),
}).strict();

// A boundary belongs to a stream only when existing stream content or an
// approved candidate references it. Channel membership alone is not enough.
export const streamBoundary = `(
  EXISTS(SELECT 1 FROM sloptogether.stream_seed_frames sf
    JOIN sloptogether.streams seed_stream ON seed_stream.id=sf.stream_id AND seed_stream.twitch_channel_id=sf.twitch_channel_id
    WHERE sf.stream_id=$2 AND sf.twitch_channel_id=$1 AND sf.boundary_revision_id=b.id)
  OR EXISTS(SELECT 1 FROM sloptogether.segments s
    JOIN sloptogether.branches branch ON branch.id=s.branch_id AND branch.stream_id=$2
      AND branch.twitch_channel_id=$1 AND branch.is_selected AND branch.archived_at IS NULL
    JOIN sloptogether.segment_revisions r ON r.segment_id=s.id
    LEFT JOIN sloptogether.endpoint_resolutions er ON er.segment_revision_id=r.id AND er.retired_at IS NULL
    WHERE s.twitch_channel_id=$1 AND (r.start_boundary_revision_id=b.id
      OR r.requested_end_boundary_revision_id=b.id OR er.resolved_end_boundary_revision_id=b.id))
  OR EXISTS(SELECT 1 FROM sloptogether.proposals p
    JOIN sloptogether.elections e ON e.id=p.election_id
    JOIN sloptogether.segments s ON s.id=e.segment_id
    JOIN sloptogether.branches branch ON branch.id=s.branch_id AND branch.stream_id=$2
      AND branch.twitch_channel_id=$1 AND branch.is_selected AND branch.archived_at IS NULL
    WHERE s.twitch_channel_id=$1 AND p.state IN ('eligible','selected')
      AND (p.start_boundary_revision_id=b.id OR p.end_boundary_revision_id=b.id))
  OR EXISTS(SELECT 1 FROM sloptogether.story_batch_items i
    JOIN sloptogether.story_batches batch ON batch.id=i.batch_id
    WHERE batch.stream_id=$2 AND batch.twitch_channel_id=$1
      AND i.start_boundary_revision_id=b.id AND i.approved_at IS NOT NULL
      AND i.approved_candidate_revision=i.candidate_revision
      AND EXISTS(SELECT 1 FROM sloptogether.segments candidate_segment
        JOIN sloptogether.branches candidate_branch ON candidate_branch.id=candidate_segment.branch_id
          AND candidate_branch.stream_id=batch.stream_id AND candidate_branch.twitch_channel_id=batch.twitch_channel_id
          AND candidate_branch.is_selected AND candidate_branch.archived_at IS NULL
        WHERE candidate_segment.id=i.segment_id AND candidate_segment.twitch_channel_id=batch.twitch_channel_id))
)`;
export const candidateStream = `EXISTS(SELECT 1 FROM sloptogether.segments s
  JOIN sloptogether.branches branch ON branch.id=s.branch_id AND branch.stream_id=batch.stream_id
    AND branch.twitch_channel_id=batch.twitch_channel_id AND branch.is_selected AND branch.archived_at IS NULL
  WHERE s.id=i.segment_id AND s.twitch_channel_id=batch.twitch_channel_id AND s.state NOT IN ('played','retired')
    AND NOT EXISTS(SELECT 1 FROM sloptogether.program_items pi WHERE pi.segment_id=s.id AND pi.committed_at IS NOT NULL))`;

async function authorizeReviewer(locator: string, request: Request, streamSlug: string) {
  const channel = await findChannel(locator);
  const principal = await requestPrincipal(request);
  if (!principal) throw new ApiError(401, "login_required");
  if (principal.kind !== "session") throw new ApiError(403, "reviewer_session_required");
  const actor = await requireContentReviewer(channel, principal);
  const stream = await getStream(channel.twitch_channel_id, streamSlug);
  return { channel, stream, actor };
}

/** List approved images already attached to this stream. */
export async function listStoryCandidateFrames(locator: string, request: Request, streamSlug = "main") {
  const { channel, stream } = await authorizeReviewer(locator, request, streamSlug);
  const result = await query<{ id: string; asset_id: string; created_at: Date }>(
    `SELECT b.id,b.asset_id,b.created_at
     FROM sloptogether.boundary_revisions b JOIN sloptogether.assets a ON a.id=b.asset_id
     WHERE b.twitch_channel_id=$1 AND b.retired_at IS NULL AND a.twitch_channel_id=$1
       AND a.media_kind='image' AND a.status IN ('approved','published') AND a.sha256 IS NOT NULL
       AND ${streamBoundary}
     ORDER BY b.created_at DESC,b.id DESC LIMIT 100`,
    [channel.twitch_channel_id, stream.id],
  );
  return { frames: result.rows.map(row => ({
    boundaryRevisionId: row.id, assetId: row.asset_id,
    previewUrl: `/sloptogether/api/v1/media/${encodeURIComponent(row.asset_id)}/preview`,
    createdAt: row.created_at.toISOString(),
  })) };
}

type Candidate = {
  id: string;
  state: string;
  candidate_revision: string;
  candidate_prompt: string | null;
  candidate_plan: unknown;
  start_boundary_revision_id: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  approved_candidate_revision: string | null;
  rejected_by: string | null;
  rejected_at: Date | null;
  rejection_reason: string | null;
};

/** Approve this candidate independently; the following candidate may not exist yet. */
export async function approveStoryCandidate(locator: string, itemId: string, request: Request, streamSlug = "main") {
  assertSameOrigin(request);
  if (!z.string().uuid().safeParse(itemId).success) throw new ApiError(400, "story_candidate_id_invalid");
  const { channel, stream, actor } = await authorizeReviewer(locator, request, streamSlug);
  const body = await readJson(request, approvalInput);
  // Commit the election result separately so a stale approval revision cannot
  // roll back the winner; the reviewer can refresh and approve the new prompt.
  await transaction(async client=>{
    const lock=await client.query<{policy_revision:number}>("SELECT policy_revision FROM sloptogether.channels WHERE twitch_channel_id=$1 AND is_enabled FOR UPDATE",[channel.twitch_channel_id]);
    if(lock.rows[0]?.policy_revision!==channel.policy_revision)throw new ApiError(409,"channel_policy_changed");
    if(await isBanned(channel.twitch_channel_id,actor,client))throw new ApiError(403,"channel_ban_active");
    const candidate=await client.query<{segment_id:string}>(`SELECT i.segment_id FROM sloptogether.story_batch_items i
      JOIN sloptogether.story_batches b ON b.id=i.batch_id WHERE i.id=$1 AND b.twitch_channel_id=$2 AND b.stream_id=$3`,[itemId,channel.twitch_channel_id,stream.id]);
    if(candidate.rows[0]?.segment_id)await resolveCandidateElections(client,channel.twitch_channel_id,candidate.rows[0].segment_id);
  });
  return transaction(async client => {
    const channelLock = await client.query<{policy_revision:number}>("SELECT policy_revision FROM sloptogether.channels WHERE twitch_channel_id=$1 AND is_enabled FOR UPDATE", [channel.twitch_channel_id]);
    if (!channelLock.rowCount) throw new ApiError(404, "channel_not_found");
    if (channelLock.rows[0]?.policy_revision !== channel.policy_revision) throw new ApiError(409, "channel_policy_changed");
    if (await isBanned(channel.twitch_channel_id, actor, client)) throw new ApiError(403, "channel_ban_active");
    const candidateSegment=await client.query<{segment_id:string}>(`SELECT i.segment_id FROM sloptogether.story_batch_items i
      JOIN sloptogether.story_batches b ON b.id=i.batch_id WHERE i.id=$1 AND b.twitch_channel_id=$2 AND b.stream_id=$3`,[itemId,channel.twitch_channel_id,stream.id]);
    if(candidateSegment.rows[0]?.segment_id){
      const election=await client.query("SELECT 1 FROM sloptogether.elections WHERE segment_id=$1 AND state='open' LIMIT 1",[candidateSegment.rows[0].segment_id]);
      if(election.rowCount)throw new ApiError(409,"story_candidate_vote_open");
    }
    const item = await client.query<Candidate>(`SELECT i.id,i.state,i.candidate_revision::text,i.candidate_prompt,i.candidate_plan,
      i.start_boundary_revision_id,i.approved_by,i.approved_at,i.approved_candidate_revision::text,
      i.rejected_by,i.rejected_at,i.rejection_reason
      FROM sloptogether.story_batch_items i JOIN sloptogether.story_batches batch ON batch.id=i.batch_id
      WHERE i.id=$1 AND batch.twitch_channel_id=$2 AND batch.stream_id=$3 AND ${candidateStream} FOR UPDATE OF i`,
      [itemId, channel.twitch_channel_id, stream.id]);
    const current = item.rows[0];
    if (!current) throw new ApiError(404, "story_candidate_not_found");
    const revision = Number(current.candidate_revision);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new ApiError(409, "story_candidate_not_planned");
    if (current.state !== "planned" || !current.candidate_prompt || !current.candidate_plan)
      throw new ApiError(409, "story_candidate_not_planned");
    if (current.rejected_at) throw new ApiError(409, "story_candidate_rejected");
    if (current.approved_at !== null) {
      if (current.approved_by === actor && current.start_boundary_revision_id === body.boundaryRevisionId
          && Number(current.approved_candidate_revision) === revision && revision === body.expectedCandidateRevision + 1)
        return { itemId, state: "planned", candidateRevision: revision, approved: true, startBoundaryRevisionId: body.boundaryRevisionId };
      throw new ApiError(409, "story_candidate_already_approved");
    }
    if (revision !== body.expectedCandidateRevision) throw new ApiError(409, "story_candidate_changed");
    const frame = await client.query<{ id: string }>(`SELECT b.id
      FROM sloptogether.boundary_revisions b JOIN sloptogether.assets a ON a.id=b.asset_id
      WHERE b.twitch_channel_id=$1 AND b.retired_at IS NULL AND a.twitch_channel_id=$1
        AND a.media_kind='image' AND a.status IN ('approved','published') AND a.sha256 IS NOT NULL
        AND ${streamBoundary} AND b.id=$3 FOR SHARE OF b,a`,
      [channel.twitch_channel_id, stream.id, body.boundaryRevisionId]);
    if (!frame.rowCount) throw new ApiError(409, "story_start_frame_not_approved");
    const changed = await client.query<{ candidate_revision: string }>(`UPDATE sloptogether.story_batch_items
      SET start_boundary_revision_id=$2,candidate_revision=candidate_revision+1,
        approved_by=$3,approved_at=now(),approved_candidate_revision=candidate_revision+1
      WHERE id=$1 AND state='planned' AND approved_at IS NULL AND rejected_at IS NULL AND candidate_revision=$4
      RETURNING candidate_revision::text`, [itemId, body.boundaryRevisionId, actor, revision]);
    if (!changed.rows[0]) throw new ApiError(409, "story_candidate_changed");
    const nextRevision = Number(changed.rows[0].candidate_revision);
    await client.query(`INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,action,target_kind,target_id,after_state)
      VALUES($1,$2,'story.candidate.approved','story_batch_item',$3,$4::jsonb)`,
      [channel.twitch_channel_id, actor, itemId, JSON.stringify({ streamId: stream.id, candidateRevision: nextRevision, startBoundaryRevisionId: body.boundaryRevisionId })]);
    return { itemId, state: "planned", candidateRevision: nextRevision, approved: true, startBoundaryRevisionId: body.boundaryRevisionId };
  });
}

/** Reject an unapproved draft without creating or consuming a render attempt. */
export async function rejectStoryCandidate(locator: string, itemId: string, request: Request, streamSlug = "main") {
  assertSameOrigin(request);
  if (!z.string().uuid().safeParse(itemId).success) throw new ApiError(400, "story_candidate_id_invalid");
  const { channel, stream, actor } = await authorizeReviewer(locator, request, streamSlug);
  const body = await readJson(request, rejectionInput);
  return transaction(async client => {
    const channelLock = await client.query<{policy_revision:number}>("SELECT policy_revision FROM sloptogether.channels WHERE twitch_channel_id=$1 AND is_enabled FOR UPDATE", [channel.twitch_channel_id]);
    if (!channelLock.rowCount) throw new ApiError(404, "channel_not_found");
    if (channelLock.rows[0]?.policy_revision !== channel.policy_revision) throw new ApiError(409, "channel_policy_changed");
    if (await isBanned(channel.twitch_channel_id, actor, client)) throw new ApiError(403, "channel_ban_active");
    const item = await client.query<Candidate>(`SELECT i.id,i.state,i.candidate_revision::text,i.candidate_prompt,i.candidate_plan,
      i.start_boundary_revision_id,i.approved_by,i.approved_at,i.approved_candidate_revision::text,
      i.rejected_by,i.rejected_at,i.rejection_reason
      FROM sloptogether.story_batch_items i JOIN sloptogether.story_batches batch ON batch.id=i.batch_id
      WHERE i.id=$1 AND batch.twitch_channel_id=$2 AND batch.stream_id=$3 AND ${candidateStream} FOR UPDATE OF i`,
      [itemId, channel.twitch_channel_id, stream.id]);
    const current = item.rows[0];
    if (!current) throw new ApiError(404, "story_candidate_not_found");
    const revision = Number(current.candidate_revision);
    if (!Number.isSafeInteger(revision) || revision < 1 || current.state !== "planned" || !current.candidate_prompt || !current.candidate_plan)
      throw new ApiError(409, "story_candidate_not_planned");
    if (current.rejected_at) {
      if (current.rejected_by === actor && current.rejection_reason === body.reason && revision === body.expectedCandidateRevision + 1)
        return { itemId, state: "planned", candidateRevision: revision, rejected: true };
      throw new ApiError(409, "story_candidate_rejected");
    }
    if (current.approved_at) throw new ApiError(409, "story_candidate_already_approved");
    if (revision !== body.expectedCandidateRevision) throw new ApiError(409, "story_candidate_changed");
    const changed = await client.query<{candidate_revision:string}>(`UPDATE sloptogether.story_batch_items
      SET candidate_revision=candidate_revision+1,rejected_by=$2,rejected_at=now(),rejection_reason=$3
      WHERE id=$1 AND state='planned' AND approved_at IS NULL AND rejected_at IS NULL AND candidate_revision=$4
      RETURNING candidate_revision::text`,[itemId,actor,body.reason,revision]);
    if (!changed.rows[0]) throw new ApiError(409,"story_candidate_changed");
    const nextRevision=Number(changed.rows[0].candidate_revision);
    await client.query(`INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,action,target_kind,target_id,reason,after_state)
      VALUES($1,$2,'story.candidate.rejected','story_batch_item',$3,$4,$5::jsonb)`,
      [channel.twitch_channel_id,actor,itemId,body.reason,JSON.stringify({streamId:stream.id,candidateRevision:nextRevision})]);
    return {itemId,state:"planned",candidateRevision:nextRevision,rejected:true};
  });
}

/** Explicitly reopen only an unspent rejected candidate for a new plan. */
export async function replanStoryCandidate(locator: string, itemId: string, request: Request, streamSlug = "main") {
  assertSameOrigin(request);
  if (!z.string().uuid().safeParse(itemId).success) throw new ApiError(400, "story_candidate_id_invalid");
  const { channel, stream, actor } = await authorizeReviewer(locator, request, streamSlug);
  const body = await readJson(request, replanInput);
  const idempotencyKey = `story-candidate-replan:${body.requestId}`;
  return transaction(async client => {
    const channelLock = await client.query<{policy_revision:number}>("SELECT policy_revision FROM sloptogether.channels WHERE twitch_channel_id=$1 AND is_enabled FOR UPDATE",[channel.twitch_channel_id]);
    if (!channelLock.rowCount) throw new ApiError(404,"channel_not_found");
    if (channelLock.rows[0]?.policy_revision !== channel.policy_revision) throw new ApiError(409,"channel_policy_changed");
    if (await isBanned(channel.twitch_channel_id,actor,client)) throw new ApiError(403,"channel_ban_active");
    const prior=await client.query<{action:string;actor_twitch_user_id:string;target_id:string;after_state:{streamId:string;expectedCandidateRevision:number;candidateRevision:number}}>(
      "SELECT action,actor_twitch_user_id,target_id,after_state FROM sloptogether.audit_log WHERE twitch_channel_id=$1 AND idempotency_key=$2",[channel.twitch_channel_id,idempotencyKey]);
    if(prior.rows[0]){
      const saved=prior.rows[0];
      if(saved.action!=="story.candidate.replan" || saved.actor_twitch_user_id!==actor || saved.target_id!==itemId || saved.after_state?.streamId!==stream.id
        || saved.after_state?.expectedCandidateRevision!==body.expectedCandidateRevision)
        throw new ApiError(409,"story_candidate_replan_idempotency_conflict");
      return {itemId,state:"pending",candidateRevision:saved.after_state.candidateRevision};
    }
    const item=await client.query<Candidate & {segment_id:string|null;job_id:string|null}>(`SELECT i.id,i.state,i.candidate_revision::text,i.candidate_prompt,i.candidate_plan,
      i.start_boundary_revision_id,i.approved_by,i.approved_at,i.approved_candidate_revision::text,
      i.rejected_by,i.rejected_at,i.rejection_reason,i.segment_id,i.job_id
      FROM sloptogether.story_batch_items i JOIN sloptogether.story_batches batch ON batch.id=i.batch_id
      WHERE i.id=$1 AND batch.twitch_channel_id=$2 AND batch.stream_id=$3 AND ${candidateStream} FOR UPDATE OF i`,[itemId,channel.twitch_channel_id,stream.id]);
    const current=item.rows[0];if(!current)throw new ApiError(404,"story_candidate_not_found");
    const revision=Number(current.candidate_revision);
    if(!Number.isSafeInteger(revision) || revision!==body.expectedCandidateRevision)throw new ApiError(409,"story_candidate_changed");
    if(current.state!=="planned" || !current.rejected_at || current.approved_at || current.job_id)
      throw new ApiError(409,"story_candidate_not_replannable");
    if(current.segment_id){
      const spent=await client.query(`SELECT 1 FROM sloptogether.segment_revisions r
        JOIN sloptogether.jobs j ON j.segment_revision_id=r.id
        LEFT JOIN sloptogether.job_attempts a ON a.job_id=j.id
        LEFT JOIN sloptogether.funding_authorizations f ON f.id=j.funding_id
        WHERE r.segment_id=$1 AND (a.claimed_at IS NOT NULL OR a.provider_request_id IS NOT NULL
          OR f.consumed_at IS NOT NULL OR coalesce(f.actual_cost_usd,0)>0
          OR j.state NOT IN ('cancelled','failed','expired')) LIMIT 1`,[current.segment_id]);
      const history=await client.query("SELECT 1 FROM sloptogether.program_items WHERE segment_id=$1 AND committed_at IS NOT NULL LIMIT 1",[current.segment_id]);
      if(spent.rowCount||history.rowCount)throw new ApiError(409,"story_candidate_attempt_already_used");
    }
    const changed=await client.query<{candidate_revision:string}>(`UPDATE sloptogether.story_batch_items SET state='pending',
      candidate_plan=NULL,candidate_prompt=NULL,candidate_revision=candidate_revision+1,start_boundary_revision_id=NULL,
      rejected_by=NULL,rejected_at=NULL,rejection_reason=NULL,pair_screen_blocked=false,pair_screen_token=NULL,pair_screen_expires_at=NULL
      WHERE id=$1 AND state='planned' AND rejected_at IS NOT NULL AND approved_at IS NULL AND job_id IS NULL AND candidate_revision=$2
      RETURNING candidate_revision::text`,[itemId,revision]);
    if(!changed.rows[0])throw new ApiError(409,"story_candidate_changed");
    const nextRevision=Number(changed.rows[0].candidate_revision);
    const previousPromptSha256=createHash("sha256").update(current.candidate_prompt??"").digest("hex");
    await client.query(`INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,action,target_kind,target_id,reason,before_state,after_state,idempotency_key)
      VALUES($1,$2,'story.candidate.replan','story_batch_item',$3,$4,$5::jsonb,$6::jsonb,$7)`,
      [channel.twitch_channel_id,actor,itemId,current.rejection_reason??"",JSON.stringify({previousPromptSha256,rejectedBy:current.rejected_by}),
        JSON.stringify({streamId:stream.id,expectedCandidateRevision:revision,candidateRevision:nextRevision}),idempotencyKey]);
    return {itemId,state:"pending",candidateRevision:nextRevision};
  });
}

/** Explicitly retry an unavailable or held pair screen without changing either approval. */
export async function retryStoryCandidateScreen(locator: string, itemId: string, request: Request, streamSlug = "main") {
  assertSameOrigin(request);
  if (!z.string().uuid().safeParse(itemId).success) throw new ApiError(400,"story_candidate_id_invalid");
  const {channel,stream,actor}=await authorizeReviewer(locator,request,streamSlug);
  const body=await readJson(request,replanInput);
  const idempotencyKey=`story-candidate-screen-retry:${body.requestId}`;
  return transaction(async client=>{
    const channelLock=await client.query<{policy_revision:number}>("SELECT policy_revision FROM sloptogether.channels WHERE twitch_channel_id=$1 AND is_enabled FOR UPDATE",[channel.twitch_channel_id]);
    if(!channelLock.rowCount)throw new ApiError(404,"channel_not_found");
    if(channelLock.rows[0]?.policy_revision!==channel.policy_revision)throw new ApiError(409,"channel_policy_changed");
    if(await isBanned(channel.twitch_channel_id,actor,client))throw new ApiError(403,"channel_ban_active");
    const prior=await client.query<{action:string;actor_twitch_user_id:string;target_id:string;after_state:{streamId:string;candidateRevision:number}}>(
      "SELECT action,actor_twitch_user_id,target_id,after_state FROM sloptogether.audit_log WHERE twitch_channel_id=$1 AND idempotency_key=$2",[channel.twitch_channel_id,idempotencyKey]);
    if(prior.rows[0]){
      const saved=prior.rows[0];
      if(saved.action!=="story.candidate.screen_retry"||saved.actor_twitch_user_id!==actor||saved.target_id!==itemId
        ||saved.after_state?.streamId!==stream.id||saved.after_state?.candidateRevision!==body.expectedCandidateRevision)
        throw new ApiError(409,"story_candidate_screen_retry_idempotency_conflict");
      return {itemId,state:"planned",candidateRevision:body.expectedCandidateRevision,screenRetryRequested:true};
    }
    const item=await client.query<Candidate & {pair_screen_blocked:boolean;screen_active:boolean}>(`SELECT i.id,i.state,i.candidate_revision::text,i.candidate_prompt,i.candidate_plan,
      i.start_boundary_revision_id,i.approved_by,i.approved_at,i.approved_candidate_revision::text,i.rejected_by,i.rejected_at,i.rejection_reason,
      i.pair_screen_blocked,(i.pair_screen_token IS NOT NULL AND (i.pair_screen_expires_at IS NULL OR i.pair_screen_expires_at>now())) AS screen_active
      FROM sloptogether.story_batch_items i JOIN sloptogether.story_batches batch ON batch.id=i.batch_id
      WHERE i.id=$1 AND batch.twitch_channel_id=$2 AND batch.stream_id=$3 AND ${candidateStream} FOR UPDATE OF i`,[itemId,channel.twitch_channel_id,stream.id]);
    const current=item.rows[0];if(!current)throw new ApiError(404,"story_candidate_not_found");
    const revision=Number(current.candidate_revision);
    if(!Number.isSafeInteger(revision)||revision!==body.expectedCandidateRevision)throw new ApiError(409,"story_candidate_changed");
    if(current.state!=="planned"||!current.approved_at||current.rejected_at||!current.start_boundary_revision_id
      ||Number(current.approved_candidate_revision)!==revision||!current.pair_screen_blocked||current.screen_active)
      throw new ApiError(409,"story_candidate_screen_not_retryable");
    const changed=await client.query(`UPDATE sloptogether.story_batch_items SET pair_screen_blocked=false,pair_screen_token=NULL,pair_screen_expires_at=NULL
      WHERE id=$1 AND state='planned' AND approved_at IS NOT NULL AND rejected_at IS NULL
        AND approved_candidate_revision=candidate_revision AND candidate_revision=$2 AND pair_screen_blocked
        AND (pair_screen_token IS NULL OR pair_screen_expires_at<=now()) RETURNING id`,[itemId,revision]);
    if(!changed.rowCount)throw new ApiError(409,"story_candidate_screen_not_retryable");
    await client.query(`INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,action,target_kind,target_id,after_state,idempotency_key)
      VALUES($1,$2,'story.candidate.screen_retry','story_batch_item',$3,$4::jsonb,$5)`,
      [channel.twitch_channel_id,actor,itemId,JSON.stringify({streamId:stream.id,candidateRevision:revision}),idempotencyKey]);
    return {itemId,state:"planned",candidateRevision:revision,screenRetryRequested:true};
  });
}
