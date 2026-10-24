BEGIN;

CREATE TABLE sloptogether.proposal_rate_reservations (
  id uuid PRIMARY KEY,
  twitch_channel_id text NOT NULL REFERENCES sloptogether.channels(twitch_channel_id),
  twitch_user_id text NOT NULL,
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','consumed','released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX proposal_rate_reservations_active
  ON sloptogether.proposal_rate_reservations(twitch_channel_id,twitch_user_id,expires_at)
  WHERE state='reserved';
REVOKE ALL ON sloptogether.proposal_rate_reservations FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON sloptogether.proposal_rate_reservations TO service_role;
  END IF;
END $$;

COMMIT;
