BEGIN;

ALTER TABLE sloptogether.extension_bits_transactions
  ADD COLUMN source text NOT NULL DEFAULT 'eventsub'
    CHECK (source IN ('eventsub','receipt_reconcile'));

ALTER TABLE sloptogether.paid_action_intents
  DROP CONSTRAINT IF EXISTS paid_action_intents_state_check;
ALTER TABLE sloptogether.paid_action_intents
  ADD CONSTRAINT paid_action_intents_state_check CHECK (state IN (
    'intent_open','receipt_seen','reserved','dispatching','consumed_uncertain',
    'consumed_succeeded','consumed_failed','consumed_rejected','paid_unfulfilled',
    'verified_unallocated','expired','cancelled'
  ));

CREATE TABLE sloptogether.extension_bits_eventsub_subscriptions (
  extension_client_id text NOT NULL,
  subscription_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('enabled','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (extension_client_id,subscription_id)
);
CREATE INDEX extension_bits_eventsub_ready
  ON sloptogether.extension_bits_eventsub_subscriptions(extension_client_id)
  WHERE state='enabled';
REVOKE ALL ON sloptogether.extension_bits_eventsub_subscriptions FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT USAGE ON SCHEMA sloptogether TO service_role;
    GRANT SELECT,INSERT,UPDATE,DELETE ON sloptogether.extension_bits_eventsub_subscriptions TO service_role;
  END IF;
END;
$$;

INSERT INTO sloptogether.outbox(event_kind,aggregate_id,payload,idempotency_key,available_at)
SELECT 'paid.bits.reconcile_receipt',intent.id::text,jsonb_build_object('intentId',intent.id),'bits-reconcile:'||intent.id::text,now()
FROM sloptogether.paid_action_intents intent
WHERE intent.state IN ('receipt_seen','expired','cancelled') AND intent.receipt_transaction_id IS NOT NULL
  AND intent.state_reason<>'development_transaction'
ON CONFLICT(idempotency_key) DO NOTHING;

COMMIT;
