import { z } from "zod";
import { findChannel, isBanned, requireContentReviewer, requireStreamerController } from "./channels";
import { query, transaction } from "./db";
import { ApiError, assertSameOrigin, readJson } from "./http";
import { requestPrincipal } from "./principals";
import { reservationUsd } from "./reservation";
import { getStream } from "./stream-service";

const batchRequest = z.object({ requestId: z.string().uuid() }).strict();
const CLIPS_PER_BATCH = 4;

type BatchRow = {
  id: string;
  requested_by: string;
  created_at: Date;
  scheduled: number;
  pending: number;
};

type BatchItemRow = {
  batch_id: string;
  item_id: string;
  position: number;
  state: string;
  prompt: string | null;
  dialogue: string | null;
  start_asset_id: string | null;
  end_asset_id: string | null;
  start_boundary_revision_id: string | null;
  candidate_revision: string | number;
  candidate_approved: boolean;
  can_approve: boolean;
  candidate_rejected: boolean;
  can_reject: boolean;
  can_replan: boolean;
  screen_blocked: boolean;
  can_retry_screen: boolean;
};

async function authorizeBroadcaster(locator: string, request: Request, streamSlug: string) {
  const channel = await findChannel(locator);
  const principal = await requestPrincipal(request);
  if (!principal) throw new ApiError(401, "login_required");
  if (principal.kind !== "session" || principal.session.twitchUserId !== channel.owner_twitch_user_id) {
    throw new ApiError(403, "streamer_control_required");
  }
  const actor = await requireStreamerController(channel, principal);
  const stream = await getStream(channel.twitch_channel_id, streamSlug);
  return { channel, stream, actor };
}

function batchSummary(row: BatchRow) {
  return {
    batchId: row.id,
    requested: CLIPS_PER_BATCH,
    scheduled: Number(row.scheduled),
    pending: Number(row.pending),
    createdAt: row.created_at.toISOString(),
  };
}

/** Queue four future story slots. Retrying the same request ID never creates more. */
export async function createStoryBatch(locator: string, request: Request, streamSlug = "main") {
  assertSameOrigin(request);
  const { channel, stream, actor } = await authorizeBroadcaster(locator, request, streamSlug);
  const body = await readJson(request, batchRequest);
  return transaction(async client => {
    // Serialize with policy changes, producer admission, and simultaneous clicks.
    const locked = await client.query<{ owner_twitch_user_id: string }>(
      "SELECT owner_twitch_user_id FROM sloptogether.channels WHERE twitch_channel_id=$1 AND is_enabled FOR UPDATE",
      [channel.twitch_channel_id],
    );
    if (!locked.rows[0]) throw new ApiError(404, "channel_not_found");
    if (locked.rows[0].owner_twitch_user_id !== actor) throw new ApiError(403, "streamer_control_required");
    if (await isBanned(channel.twitch_channel_id, actor, client)) throw new ApiError(403, "channel_ban_active");
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO sloptogether.story_batches(twitch_channel_id,stream_id,requested_by,request_id)
       VALUES($1,$2,$3,$4) ON CONFLICT (stream_id,request_id) DO NOTHING RETURNING id`,
      [channel.twitch_channel_id, stream.id, actor, body.requestId],
    );
    if (inserted.rows[0]) {
      await client.query(
        "INSERT INTO sloptogether.story_batch_items(batch_id,position) SELECT $1,position FROM generate_series(0,3) AS position",
        [inserted.rows[0].id],
      );
      await client.query(
        `INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,action,target_kind,target_id,after_state)
         VALUES($1,$2,'story.batch.requested','story_batch',$3,$4::jsonb)`,
        [channel.twitch_channel_id, actor, inserted.rows[0].id, JSON.stringify({ streamId: stream.id, requested: CLIPS_PER_BATCH })],
      );
    }
    const result = await client.query<BatchRow>(
      `SELECT b.id,b.requested_by,b.created_at,
        count(i.id) FILTER (WHERE i.state='scheduled')::int AS scheduled,
        count(i.id) FILTER (WHERE i.state IN ('pending','planned'))::int AS pending
       FROM sloptogether.story_batches b JOIN sloptogether.story_batch_items i ON i.batch_id=b.id
       WHERE b.stream_id=$1 AND b.twitch_channel_id=$2 AND b.request_id=$3
       GROUP BY b.id,b.requested_by,b.created_at`,
      [stream.id, channel.twitch_channel_id, body.requestId],
    );
    const row = result.rows[0];
    if (!row || row.requested_by !== actor || row.scheduled + row.pending !== CLIPS_PER_BATCH) {
      throw new ApiError(409, "story_batch_request_conflict");
    }
    return batchSummary(row);
  });
}

export async function listStoryBatches(locator: string, request: Request, streamSlug = "main") {
  const channel = await findChannel(locator);
  const principal = await requestPrincipal(request);
  await requireContentReviewer(channel, principal);
  const canGenerate = principal?.kind === "session" && principal.session.twitchUserId === channel.owner_twitch_user_id;
  const stream = await getStream(channel.twitch_channel_id, streamSlug);
  const [result, availability] = await Promise.all([query<BatchRow>(
    `SELECT b.id,b.requested_by,b.created_at,
      count(i.id) FILTER (WHERE i.state='scheduled')::int AS scheduled,
      count(i.id) FILTER (WHERE i.state IN ('pending','planned'))::int AS pending
     FROM sloptogether.story_batches b JOIN sloptogether.story_batch_items i ON i.batch_id=b.id
     WHERE b.stream_id=$1 AND b.twitch_channel_id=$2
     GROUP BY b.id,b.requested_by,b.created_at ORDER BY b.created_at DESC,b.id DESC LIMIT 20`,
    [stream.id, channel.twitch_channel_id],
  ), query<{ producer_lease_active: boolean; has_approved_start: boolean; committed: string }>(
    `SELECT EXISTS(SELECT 1 FROM sloptogether.story_producers p
       WHERE p.stream_id=$1 AND p.twitch_channel_id=$2 AND p.released_at IS NULL AND p.lease_expires_at>now()) AS producer_lease_active,
       EXISTS(SELECT 1 FROM sloptogether.branches b
         JOIN sloptogether.segments s ON s.branch_id=b.id
         JOIN sloptogether.segment_revisions r ON r.id=s.selected_revision_id AND r.state IN ('ready','played')
         LEFT JOIN LATERAL(SELECT resolved_end_boundary_revision_id FROM sloptogether.endpoint_resolutions
           WHERE segment_revision_id=r.id AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1) er ON true
         JOIN sloptogether.boundary_revisions boundary ON boundary.id=coalesce(r.requested_end_boundary_revision_id,er.resolved_end_boundary_revision_id)
           AND boundary.twitch_channel_id=$2 AND boundary.retired_at IS NULL
         JOIN sloptogether.assets a ON a.id=boundary.asset_id AND a.twitch_channel_id=$2 AND a.media_kind='image' AND a.status IN ('approved','published')
         WHERE b.stream_id=$1 AND b.twitch_channel_id=$2 AND b.is_selected AND b.archived_at IS NULL) AS has_approved_start,
       coalesce((SELECT sum(greatest(f.reserved_usd,coalesce(f.actual_cost_usd,0)))
         FROM sloptogether.funding_authorizations f WHERE f.twitch_channel_id=$2 AND f.source='owner_budget' AND f.state<>'released'),0)::text AS committed`,
    [stream.id, channel.twitch_channel_id],
  )]);
  const quote = reservationUsd("SLOPTOGETHER_GENERATION_ATTEMPT_RESERVATION_USD");
  const cap = Number(channel.owner_budget_cap_usd);
  const committed = Number(availability.rows[0]?.committed);
  const budget = quote === null || !Number.isFinite(cap) || cap <= 0 || !Number.isFinite(committed)
    ? "unavailable" : committed + quote > cap ? "exhausted" : "available";
  const batchIds = result.rows.map(row => row.id);
  const details = batchIds.length ? await query<BatchItemRow>(
    `/* story_batch_items_details */
     SELECT b.id AS batch_id,i.id AS item_id,i.position,i.candidate_revision,i.pair_screen_blocked AS screen_blocked,
       (i.state='planned' AND draft_branch.id IS NOT NULL AND i.candidate_revision>=1
         AND i.approved_at IS NOT NULL AND i.approved_candidate_revision=i.candidate_revision
         AND selected_asset.id IS NOT NULL AND i.pair_screen_blocked
         AND (i.pair_screen_token IS NULL OR i.pair_screen_expires_at<=now())) AS can_retry_screen,
       CASE WHEN selected_asset.id IS NOT NULL AND ((i.state='planned' AND draft_branch.id IS NOT NULL) OR (i.state='scheduled' AND branch.id IS NOT NULL)) THEN i.start_boundary_revision_id ELSE NULL END AS start_boundary_revision_id,
       (i.approved_at IS NOT NULL AND i.approved_candidate_revision=i.candidate_revision AND selected_asset.id IS NOT NULL
         AND ((i.state='planned' AND draft_branch.id IS NOT NULL) OR (i.state='scheduled' AND branch.id IS NOT NULL))) AS candidate_approved,
       (i.rejected_at IS NOT NULL) AS candidate_rejected,
       (i.state='planned' AND i.candidate_revision>=1 AND draft_branch.id IS NOT NULL AND i.candidate_plan IS NOT NULL AND i.candidate_prompt IS NOT NULL AND i.approved_at IS NULL AND i.rejected_at IS NULL) AS can_reject,
       (i.state='planned' AND i.candidate_revision>=1 AND draft_branch.id IS NOT NULL AND i.rejected_at IS NOT NULL AND i.approved_at IS NULL AND i.job_id IS NULL
         AND NOT EXISTS(SELECT 1 FROM sloptogether.segment_revisions prior_revision
           JOIN sloptogether.jobs prior_job ON prior_job.segment_revision_id=prior_revision.id
           LEFT JOIN sloptogether.job_attempts prior_attempt ON prior_attempt.job_id=prior_job.id
           LEFT JOIN sloptogether.funding_authorizations prior_funding ON prior_funding.id=prior_job.funding_id
           WHERE prior_revision.segment_id=i.segment_id AND (prior_attempt.claimed_at IS NOT NULL
             OR prior_attempt.provider_request_id IS NOT NULL OR prior_funding.consumed_at IS NOT NULL
             OR coalesce(prior_funding.actual_cost_usd,0)>0
             OR prior_job.state NOT IN ('cancelled','failed','expired')))
         AND NOT EXISTS(SELECT 1 FROM sloptogether.program_items history
           WHERE history.segment_id=i.segment_id AND history.committed_at IS NOT NULL)) AS can_replan,
       (i.state='planned' AND i.candidate_revision>=1 AND draft_branch.id IS NOT NULL AND i.candidate_plan IS NOT NULL AND i.candidate_prompt IS NOT NULL
         AND i.rejected_at IS NULL AND i.approved_at IS NULL) AS can_approve,
       CASE WHEN i.state='pending' THEN 'pending'
         WHEN i.state='planned' AND draft_branch.id IS NULL THEN 'superseded'
         WHEN i.state='planned' AND i.rejected_at IS NOT NULL THEN 'rejected'
         WHEN i.state='planned' AND i.approved_at IS NOT NULL AND selected_asset.id IS NULL THEN 'blocked'
         WHEN i.state='planned' THEN 'planned'
         WHEN j.id IS NULL OR s.id IS NULL OR branch.id IS NULL THEN 'superseded'
         WHEN s.state='played' THEN 'played'
         WHEN j.state='ready' AND (i.approved_at IS NULL OR i.approved_candidate_revision IS DISTINCT FROM i.candidate_revision
           OR selected_asset.id IS NULL OR next_asset.id IS NULL
           OR r.start_boundary_revision_id IS DISTINCT FROM i.start_boundary_revision_id
           OR r.requested_end_boundary_revision_id IS DISTINCT FROM next_item.start_boundary_revision_id) THEN 'blocked'
         WHEN j.state='ready' AND (attempt.id IS NULL OR attempt.state<>'ready' OR attempt.attempt_deadline_at IS NULL
           OR input_screen.id IS NULL OR input_screen.effective_state<>'clear') THEN 'blocked'
         WHEN j.state='ready' AND (j.result_deadline_at<=now() OR attempt.attempt_deadline_at<=now()
           OR (input_screen.expires_at IS NOT NULL AND input_screen.expires_at<=now())) THEN 'expired'
         WHEN j.state IN ('leased','running','uploaded') AND
           (attempt.id IS NULL OR attempt.attempt_deadline_at IS NULL OR attempt.lease_expires_at IS NULL
             OR attempt.attempt_deadline_at<=now() OR attempt.lease_expires_at<=now()) THEN 'expired'
         WHEN j.state='validating' AND attempt.id IS NULL THEN 'blocked'
         ELSE j.state END AS state,
       CASE WHEN i.state='planned' AND draft_branch.id IS NOT NULL THEN coalesce(nullif(i.candidate_plan->>'visualAction',''),i.candidate_prompt)
         WHEN branch.id IS NOT NULL THEN coalesce(nullif(i.candidate_plan->>'visualAction',''),nullif(r.visual_prompt,''),r.prompt) ELSE NULL END AS prompt,
       CASE WHEN i.state='planned' AND draft_branch.id IS NOT NULL THEN nullif(i.candidate_plan->>'dialogue','')
         WHEN branch.id IS NOT NULL THEN coalesce(nullif(i.candidate_plan->>'dialogue',''),nullif(r.dialogue,'')) ELSE NULL END AS dialogue,
       CASE WHEN i.state='planned' AND draft_branch.id IS NOT NULL THEN selected_asset.id WHEN branch.id IS NOT NULL THEN coalesce(selected_asset.id,a.id) ELSE NULL END AS start_asset_id,
       CASE WHEN i.state='pending' OR (i.state='planned' AND draft_branch.id IS NOT NULL) OR branch.id IS NOT NULL THEN next_asset.id ELSE NULL END AS end_asset_id
     FROM sloptogether.story_batches b
     JOIN sloptogether.story_batch_items i ON i.batch_id=b.id
     LEFT JOIN sloptogether.segments draft_segment ON draft_segment.id=i.segment_id AND draft_segment.twitch_channel_id=b.twitch_channel_id
       AND draft_segment.state NOT IN ('played','retired')
       AND NOT EXISTS(SELECT 1 FROM sloptogether.program_items draft_history WHERE draft_history.segment_id=draft_segment.id AND draft_history.committed_at IS NOT NULL)
     LEFT JOIN sloptogether.branches draft_branch ON draft_branch.id=draft_segment.branch_id AND draft_branch.stream_id=b.stream_id
       AND draft_branch.twitch_channel_id=b.twitch_channel_id AND draft_branch.is_selected AND draft_branch.archived_at IS NULL
     LEFT JOIN sloptogether.jobs j ON j.id=i.job_id AND j.twitch_channel_id=b.twitch_channel_id
     LEFT JOIN sloptogether.segment_revisions r ON r.id=j.segment_revision_id AND r.segment_id=i.segment_id
     LEFT JOIN sloptogether.segments s ON s.id=i.segment_id AND s.twitch_channel_id=b.twitch_channel_id AND s.selected_revision_id=r.id AND s.state<>'retired'
     LEFT JOIN sloptogether.branches branch ON branch.id=s.branch_id AND branch.stream_id=b.stream_id
       AND branch.twitch_channel_id=b.twitch_channel_id AND branch.is_selected AND branch.archived_at IS NULL
     LEFT JOIN LATERAL(SELECT id,state,attempt_deadline_at,lease_expires_at FROM sloptogether.job_attempts
       WHERE job_id=j.id ORDER BY attempt_number DESC LIMIT 1) attempt ON true
     LEFT JOIN sloptogether.input_screens input_screen ON input_screen.id::text=j.planning_payload->>'inputScreenId'
       AND input_screen.twitch_channel_id=b.twitch_channel_id
     LEFT JOIN sloptogether.boundary_revisions selected_boundary ON selected_boundary.id=i.start_boundary_revision_id
       AND selected_boundary.twitch_channel_id=b.twitch_channel_id AND selected_boundary.retired_at IS NULL
     LEFT JOIN sloptogether.assets selected_asset ON selected_asset.id=selected_boundary.asset_id AND selected_asset.twitch_channel_id=b.twitch_channel_id
       AND selected_asset.media_kind='image' AND selected_asset.status IN ('approved','published')
     LEFT JOIN LATERAL(SELECT neighbor.segment_id,neighbor.start_boundary_revision_id,neighbor.candidate_revision,neighbor.approved_candidate_revision,neighbor.approved_at
       FROM sloptogether.story_batches next_batch JOIN sloptogether.story_batch_items neighbor ON neighbor.batch_id=next_batch.id
       WHERE next_batch.stream_id=b.stream_id AND next_batch.twitch_channel_id=b.twitch_channel_id
         AND (next_batch.created_at,next_batch.id,neighbor.position)>(b.created_at,b.id,i.position)
       ORDER BY next_batch.created_at,next_batch.id,neighbor.position LIMIT 1) next_item ON true
     LEFT JOIN sloptogether.segments next_segment ON next_segment.id=next_item.segment_id AND next_segment.twitch_channel_id=b.twitch_channel_id AND next_segment.state<>'retired'
     LEFT JOIN sloptogether.branches next_branch ON next_branch.id=next_segment.branch_id AND next_branch.stream_id=b.stream_id
       AND next_branch.twitch_channel_id=b.twitch_channel_id AND next_branch.is_selected AND next_branch.archived_at IS NULL
     LEFT JOIN sloptogether.boundary_revisions next_boundary ON next_boundary.id=next_item.start_boundary_revision_id
       AND next_boundary.twitch_channel_id=b.twitch_channel_id AND next_boundary.retired_at IS NULL
       AND next_branch.id IS NOT NULL AND next_item.approved_at IS NOT NULL AND next_item.approved_candidate_revision=next_item.candidate_revision
     LEFT JOIN sloptogether.assets next_asset ON next_asset.id=next_boundary.asset_id AND next_asset.twitch_channel_id=b.twitch_channel_id
       AND next_asset.media_kind='image' AND next_asset.status IN ('approved','published')
     LEFT JOIN sloptogether.boundary_revisions boundary ON boundary.id=r.start_boundary_revision_id
       AND boundary.twitch_channel_id=b.twitch_channel_id AND boundary.retired_at IS NULL
     LEFT JOIN sloptogether.assets a ON a.id=boundary.asset_id AND a.twitch_channel_id=b.twitch_channel_id
       AND a.media_kind='image' AND a.status IN ('approved','published')
     WHERE b.stream_id=$1 AND b.twitch_channel_id=$2 AND b.id=ANY($3::uuid[])
     ORDER BY b.created_at DESC,b.id DESC,i.position`,
    [stream.id, channel.twitch_channel_id, batchIds],
  ) : { rows: [] };
  const itemsByBatch = new Map<string, Array<{itemId:string;position:number;state:string;prompt:string|null;dialogue:string|null;startFrameUrl:string|null;endFrameUrl:string|null;startBoundaryRevisionId:string|null;candidateRevision:number;candidateApproved:boolean;candidateRejected:boolean;canApprove:boolean;canReject:boolean;canReplan:boolean;screenBlocked:boolean;canRetryScreen:boolean}>>();
  for (const item of details.rows) {
    const candidateRevision=Number(item.candidate_revision);
    if (!Number.isSafeInteger(candidateRevision) || candidateRevision<0) throw new ApiError(500,"story_candidate_revision_invalid");
    const items = itemsByBatch.get(item.batch_id) ?? [];
    items.push({itemId:item.item_id,position:item.position,state:item.state,prompt:item.prompt,dialogue:item.dialogue,
      startFrameUrl:item.start_asset_id ? `/sloptogether/api/v1/media/${encodeURIComponent(item.start_asset_id)}/preview` : null,
      endFrameUrl:item.end_asset_id ? `/sloptogether/api/v1/media/${encodeURIComponent(item.end_asset_id)}/preview` : null,
      startBoundaryRevisionId:item.start_boundary_revision_id,candidateRevision,candidateApproved:item.candidate_approved,candidateRejected:item.candidate_rejected,canApprove:item.can_approve,canReject:item.can_reject,canReplan:item.can_replan,screenBlocked:item.screen_blocked,canRetryScreen:item.can_retry_screen});
    itemsByBatch.set(item.batch_id,items);
  }
  return { canGenerate, batches: result.rows.map(row => ({...batchSummary(row),items:itemsByBatch.get(row.id) ?? []})), availability: {
    producerLeaseActive: availability.rows[0]?.producer_lease_active === true,
    hasApprovedStart: availability.rows[0]?.has_approved_start === true,
    budget: canGenerate ? budget : null,
  } };
}
