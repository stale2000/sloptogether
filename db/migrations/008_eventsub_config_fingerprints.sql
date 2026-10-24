BEGIN;

CREATE TABLE sloptogether.eventsub_config_fingerprints (
  twitch_channel_id text NOT NULL REFERENCES sloptogether.channels(twitch_channel_id),
  registration_key text NOT NULL,
  config_fingerprint bytea NOT NULL CHECK (octet_length(config_fingerprint)=32),
  subscription_ids text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (twitch_channel_id,registration_key)
);
REVOKE ALL ON sloptogether.eventsub_config_fingerprints FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON sloptogether.eventsub_config_fingerprints TO service_role;
  END IF;
END $$;

COMMIT;
