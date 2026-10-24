BEGIN;

ALTER TABLE sloptogether.paid_action_intents
  ADD COLUMN dispatch_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN dispatch_snapshot_sha256 bytea CHECK (dispatch_snapshot_sha256 IS NULL OR octet_length(dispatch_snapshot_sha256)=32);
ALTER TABLE sloptogether.extension_bits_transactions
  ADD COLUMN settlement_state text NOT NULL DEFAULT 'pending' CHECK (settlement_state IN (
    'pending','reserved','development_ignored','consumed_uncertain','consumed_succeeded','consumed_failed','consumed_rejected','paid_unfulfilled'
  ));

CREATE TABLE sloptogether.paid_turbo_dispatches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id uuid NOT NULL UNIQUE REFERENCES sloptogether.paid_action_intents(id),
  job_id uuid NOT NULL UNIQUE REFERENCES sloptogether.jobs(id),
  attempt_id uuid NOT NULL UNIQUE REFERENCES sloptogether.job_attempts(id),
  snapshot_sha256 bytea NOT NULL CHECK (octet_length(snapshot_sha256)=32),
  state text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready','submitting','uncertain','submitted','running','ingested','failed','cancelled')),
  request_id text UNIQUE,
  poll_generation integer NOT NULL DEFAULT 0 CHECK (poll_generation>=0),
  result_sha256 bytea CHECK (result_sha256 IS NULL OR octet_length(result_sha256)=32),
  failure_code text NOT NULL DEFAULT '',
  dispatch_started_at timestamptz,
  submitted_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state IN ('submitted','running','ingested') AND request_id IS NOT NULL) OR state NOT IN ('submitted','running','ingested'))
);
CREATE INDEX paid_turbo_dispatch_ready ON sloptogether.paid_turbo_dispatches(updated_at) WHERE state IN ('ready','submitted','running');

REVOKE ALL ON ALL TABLES IN SCHEMA sloptogether FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT USAGE ON SCHEMA sloptogether TO service_role;
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA sloptogether TO service_role;
  END IF;
END;
$$;

COMMIT;
