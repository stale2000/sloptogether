BEGIN;

CREATE TABLE sloptogether.comfy_frame_generations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL,
  twitch_channel_id text NOT NULL REFERENCES sloptogether.channels(twitch_channel_id) ON DELETE CASCADE,
  requested_by text NOT NULL,
  prompt text NOT NULL CHECK (length(prompt) BETWEEN 1 AND 1000),
  prompt_sha256 bytea NOT NULL,
  workflow_version text NOT NULL,
  state text NOT NULL CHECK (state IN ('submitting','queued','running','succeeded','held','failed','uncertain')),
  provider_job_id text UNIQUE,
  output_asset_id text,
  error_code text,
  expires_at timestamptz NOT NULL DEFAULT (now()+interval '7 days'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (twitch_channel_id,requested_by,request_id),
  CHECK (state NOT IN ('queued','running','succeeded','held') OR provider_job_id IS NOT NULL),
  CHECK (state NOT IN ('succeeded','held') OR output_asset_id IS NOT NULL)
);

CREATE INDEX comfy_frame_generations_owner_recent
  ON sloptogether.comfy_frame_generations(requested_by,created_at DESC);
CREATE INDEX comfy_frame_generations_pending
  ON sloptogether.comfy_frame_generations(state,updated_at)
  WHERE state IN ('submitting','queued','running');

REVOKE ALL ON sloptogether.comfy_frame_generations FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT USAGE ON SCHEMA sloptogether TO service_role;
    GRANT SELECT,INSERT,UPDATE,DELETE ON sloptogether.comfy_frame_generations TO service_role;
  END IF;
END;
$$;

COMMIT;
