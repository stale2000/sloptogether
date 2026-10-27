BEGIN;

-- One streamer request represents exactly four ordered story continuation slots.
-- A slot becomes scheduled only when the normal story pipeline creates its job.
CREATE TABLE sloptogether.story_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  twitch_channel_id text NOT NULL REFERENCES sloptogether.channels(twitch_channel_id) ON DELETE CASCADE,
  stream_id uuid NOT NULL REFERENCES sloptogether.streams(id) ON DELETE CASCADE,
  requested_by text NOT NULL,
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (stream_id, request_id)
);

CREATE INDEX story_batches_stream_order ON sloptogether.story_batches(stream_id, created_at, id);

CREATE TABLE sloptogether.story_batch_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES sloptogether.story_batches(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 3),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'scheduled')),
  segment_id uuid REFERENCES sloptogether.segments(id),
  job_id uuid REFERENCES sloptogether.jobs(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (batch_id, position),
  CHECK ((state = 'pending' AND segment_id IS NULL AND job_id IS NULL)
      OR (state = 'scheduled' AND segment_id IS NOT NULL AND job_id IS NOT NULL))
);

CREATE INDEX story_batch_items_pending ON sloptogether.story_batch_items(batch_id, position) WHERE state = 'pending';
REVOKE ALL ON sloptogether.story_batches, sloptogether.story_batch_items FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sloptogether_app') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON sloptogether.story_batches,sloptogether.story_batch_items TO sloptogether_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON sloptogether.story_batches,sloptogether.story_batch_items TO service_role;
  END IF;
END;
$$;

COMMIT;
