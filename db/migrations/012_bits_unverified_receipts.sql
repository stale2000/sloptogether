BEGIN;

ALTER TABLE sloptogether.paid_action_intents
  DROP CONSTRAINT IF EXISTS paid_action_intents_state_check;
ALTER TABLE sloptogether.paid_action_intents
  ADD CONSTRAINT paid_action_intents_state_check CHECK (state IN (
    'intent_open','receipt_seen','receipt_unverified','reserved','dispatching','consumed_uncertain',
    'consumed_succeeded','consumed_failed','consumed_rejected','paid_unfulfilled','verified_unallocated',
    'expired','cancelled'
  ));

DROP INDEX IF EXISTS sloptogether.one_open_paid_intent_per_viewer_sku;
CREATE UNIQUE INDEX one_open_paid_intent_per_viewer_sku
  ON sloptogether.paid_action_intents(twitch_channel_id,twitch_user_id,product_sku)
  WHERE state IN ('intent_open','receipt_seen','receipt_unverified');

DROP INDEX IF EXISTS sloptogether.one_open_paid_intent_per_revision;
CREATE UNIQUE INDEX one_open_paid_intent_per_revision
  ON sloptogether.paid_action_intents(twitch_channel_id,segment_revision_id)
  WHERE state IN ('intent_open','receipt_seen','receipt_unverified','reserved','dispatching','consumed_uncertain');

COMMIT;
