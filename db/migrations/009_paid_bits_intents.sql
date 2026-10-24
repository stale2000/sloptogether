BEGIN;

CREATE TABLE sloptogether.paid_action_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  twitch_channel_id text NOT NULL REFERENCES sloptogether.channels(twitch_channel_id) ON DELETE CASCADE,
  extension_client_id text NOT NULL,
  twitch_user_id text NOT NULL,
  opaque_user_id text NOT NULL,
  product_sku text NOT NULL,
  amount_bits integer NOT NULL CHECK (amount_bits > 0),
  resolution text NOT NULL CHECK (resolution IN ('480P','768P','1080P')),
  reserved_usd numeric(12,4) NOT NULL CHECK (reserved_usd > 0),
  segment_id uuid NOT NULL REFERENCES sloptogether.segments(id),
  segment_revision_id uuid NOT NULL REFERENCES sloptogether.segment_revisions(id),
  input_screen_id uuid NOT NULL REFERENCES sloptogether.input_screens(id),
  input_sha256 bytea NOT NULL CHECK (octet_length(input_sha256)=32),
  policy_revision integer NOT NULL,
  state text NOT NULL DEFAULT 'intent_open' CHECK (state IN (
    'intent_open','receipt_seen','reserved','dispatching','consumed_uncertain',
    'consumed_succeeded','consumed_failed','consumed_rejected','paid_unfulfilled','expired','cancelled'
  )),
  receipt_transaction_id text UNIQUE,
  receipt_timestamp timestamptz,
  purchase_window_started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  state_reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > purchase_window_started_at)
);

CREATE UNIQUE INDEX one_open_paid_intent_per_viewer_sku
  ON sloptogether.paid_action_intents(twitch_channel_id,twitch_user_id,product_sku)
  WHERE state IN ('intent_open','receipt_seen');
CREATE UNIQUE INDEX one_open_paid_intent_per_revision
  ON sloptogether.paid_action_intents(twitch_channel_id,segment_revision_id)
  WHERE state IN ('intent_open','receipt_seen','reserved','dispatching','consumed_uncertain');
ALTER TABLE sloptogether.funding_authorizations
  ADD COLUMN paid_action_intent_id uuid UNIQUE REFERENCES sloptogether.paid_action_intents(id);

CREATE TABLE sloptogether.extension_bits_transactions (
  transaction_id text PRIMARY KEY,
  eventsub_message_id text NOT NULL UNIQUE,
  extension_client_id text NOT NULL,
  broadcaster_twitch_id text NOT NULL REFERENCES sloptogether.channels(twitch_channel_id),
  purchaser_twitch_user_id text NOT NULL,
  product_sku text NOT NULL,
  amount_bits integer NOT NULL CHECK (amount_bits > 0),
  is_in_development boolean NOT NULL,
  occurred_at timestamptz NOT NULL,
  intent_id uuid REFERENCES sloptogether.paid_action_intents(id),
  state text NOT NULL CHECK (state IN ('verified_unallocated','reserved','paid_unfulfilled','development_ignored')),
  transaction_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX extension_bits_transactions_pending
  ON sloptogether.extension_bits_transactions(broadcaster_twitch_id,received_at)
  WHERE state='verified_unallocated';

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
