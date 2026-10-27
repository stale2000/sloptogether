import { z } from "zod";
import { findChannel, isBanned, requireStreamerController } from "./channels";
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
        count(i.id) FILTER (WHERE i.state='pending')::int AS pending
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
  const { channel, stream } = await authorizeBroadcaster(locator, request, streamSlug);
  const [result, availability] = await Promise.all([query<BatchRow>(
    `SELECT b.id,b.requested_by,b.created_at,
      count(i.id) FILTER (WHERE i.state='scheduled')::int AS scheduled,
      count(i.id) FILTER (WHERE i.state='pending')::int AS pending
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
  return { batches: result.rows.map(batchSummary), availability: {
    producerLeaseActive: availability.rows[0]?.producer_lease_active === true,
    hasApprovedStart: availability.rows[0]?.has_approved_start === true,
    budget,
  } };
}
