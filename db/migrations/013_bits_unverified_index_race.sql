BEGIN;

DROP INDEX IF EXISTS sloptogether.one_open_paid_intent_per_viewer_sku;
CREATE UNIQUE INDEX one_open_paid_intent_per_viewer_sku
  ON sloptogether.paid_action_intents(twitch_channel_id,twitch_user_id,product_sku)
  WHERE state IN ('intent_open','receipt_seen');

DROP INDEX IF EXISTS sloptogether.one_open_paid_intent_per_revision;
CREATE UNIQUE INDEX one_open_paid_intent_per_revision
  ON sloptogether.paid_action_intents(twitch_channel_id,segment_revision_id)
  WHERE state IN ('intent_open','receipt_seen','reserved','dispatching','consumed_uncertain');

COMMIT;
