BEGIN;

CREATE UNIQUE INDEX one_pending_prompt_lock_per_stream
  ON sloptogether.paid_action_intents(twitch_channel_id,stream_id)
  WHERE action_kind='prompt_lock'
    AND state IN ('intent_open','receipt_seen','verified_unallocated','receipt_unverified');

COMMIT;
