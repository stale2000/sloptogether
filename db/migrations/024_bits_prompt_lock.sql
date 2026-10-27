BEGIN;

ALTER TABLE sloptogether.paid_action_intents
  ADD COLUMN action_kind text NOT NULL DEFAULT 'turbo_render'
    CHECK (action_kind IN ('turbo_render','prompt_lock')),
  ADD COLUMN proposal_id uuid REFERENCES sloptogether.proposals(id),
  ADD COLUMN election_id uuid REFERENCES sloptogether.elections(id),
  ADD COLUMN stream_id uuid REFERENCES sloptogether.streams(id);

ALTER TABLE sloptogether.paid_action_intents
  ALTER COLUMN resolution DROP NOT NULL;

ALTER TABLE sloptogether.paid_action_intents
  ADD CONSTRAINT paid_action_kind_target_check CHECK (
    (action_kind='turbo_render' AND resolution IS NOT NULL AND proposal_id IS NULL AND election_id IS NULL AND stream_id IS NULL)
    OR
    (action_kind='prompt_lock' AND resolution IS NULL AND proposal_id IS NOT NULL AND election_id IS NOT NULL AND stream_id IS NOT NULL)
  );

CREATE UNIQUE INDEX one_active_prompt_lock_per_segment
  ON sloptogether.paid_action_intents(twitch_channel_id,segment_id)
  WHERE action_kind='prompt_lock'
    AND state IN ('intent_open','receipt_seen','verified_unallocated','reserved','dispatching','consumed_uncertain');

COMMIT;
