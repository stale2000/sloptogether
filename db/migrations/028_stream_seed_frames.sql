BEGIN;

-- Explicitly associate reviewed starting images with their stream. These are
-- image inputs only; they do not create elections, jobs, or spending.
CREATE TABLE sloptogether.stream_seed_frames (
  stream_id uuid NOT NULL REFERENCES sloptogether.streams(id),
  boundary_revision_id uuid NOT NULL REFERENCES sloptogether.boundary_revisions(id),
  twitch_channel_id text NOT NULL REFERENCES sloptogether.channels(twitch_channel_id),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (stream_id, boundary_revision_id)
);

REVOKE ALL ON sloptogether.stream_seed_frames FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON sloptogether.stream_seed_frames FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON sloptogether.stream_seed_frames FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sloptogether_app') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON sloptogether.stream_seed_frames TO sloptogether_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON sloptogether.stream_seed_frames TO service_role;
  END IF;
END;
$$;

COMMIT;
