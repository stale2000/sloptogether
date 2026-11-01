BEGIN;

ALTER TABLE sloptogether.extension_bits_eventsub_subscriptions
  DROP CONSTRAINT IF EXISTS extension_bits_eventsub_subscriptions_state_check;
ALTER TABLE sloptogether.extension_bits_eventsub_subscriptions
  ADD CONSTRAINT extension_bits_eventsub_subscriptions_state_check
  CHECK (state IN ('pending','enabled','revoked'));
ALTER TABLE sloptogether.extension_bits_eventsub_subscriptions
  ADD COLUMN IF NOT EXISTS config_fingerprint bytea;

COMMIT;
