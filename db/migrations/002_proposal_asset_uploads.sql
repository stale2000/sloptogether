BEGIN;

-- A ballot selects the exact immutable generation revision that was reviewed.
ALTER TABLE sloptogether.proposals
  ADD COLUMN segment_revision_id uuid REFERENCES sloptogether.segment_revisions(id),
  ADD COLUMN planning_mode text NOT NULL DEFAULT 'continuation'
    CHECK (planning_mode IN ('planned_anchors','continuation'));
CREATE UNIQUE INDEX proposal_generation_revision ON sloptogether.proposals(segment_revision_id)
  WHERE segment_revision_id IS NOT NULL;

-- Browser frame uploads do not have a GPU attempt. Keep their one-use grants
-- separate from worker attempt reservations and never publish a staging key.
CREATE TABLE sloptogether.asset_upload_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL UNIQUE REFERENCES sloptogether.assets(id),
  twitch_channel_id text NOT NULL REFERENCES sloptogether.channels(twitch_channel_id),
  twitch_user_id text NOT NULL,
  staging_key text NOT NULL UNIQUE,
  content_type text NOT NULL CHECK (content_type IN ('image/png','image/jpeg','image/webp')),
  expected_bytes bigint NOT NULL CHECK (expected_bytes > 0 AND expected_bytes <= 16777216),
  max_bytes bigint NOT NULL CHECK (max_bytes > 0 AND max_bytes <= 16777216),
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'issued' CHECK (state IN ('issued','snapshotted','expired','rejected')),
  snapshot_key text UNIQUE,
  snapshot_sha256 bytea,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX asset_upload_user_outstanding
  ON sloptogether.asset_upload_reservations(twitch_user_id,created_at) WHERE state='issued';
REVOKE ALL ON sloptogether.asset_upload_reservations FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON sloptogether.asset_upload_reservations TO service_role;
  END IF;
END $$;

COMMIT;
