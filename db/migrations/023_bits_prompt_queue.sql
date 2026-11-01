BEGIN;

ALTER TABLE sloptogether.paid_action_intents
  ADD COLUMN IF NOT EXISTS action_kind text NOT NULL DEFAULT 'turbo_render',
  ADD COLUMN IF NOT EXISTS proposal_id uuid,
  ADD COLUMN IF NOT EXISTS election_id uuid,
  ADD COLUMN IF NOT EXISTS stream_id uuid;

ALTER TABLE sloptogether.paid_action_intents
  ALTER COLUMN resolution DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS paid_action_intents_action_kind_check,
  DROP CONSTRAINT IF EXISTS paid_action_kind_target_check;

ALTER TABLE sloptogether.paid_action_intents
  ADD CONSTRAINT paid_action_intents_action_kind_check
    CHECK (action_kind = ANY (ARRAY['turbo_render'::text,'prompt_lock'::text])),
  ADD CONSTRAINT paid_action_kind_target_check CHECK (
    (action_kind='turbo_render' AND resolution IS NOT NULL AND proposal_id IS NULL AND election_id IS NULL AND stream_id IS NULL)
    OR
    (action_kind='prompt_lock' AND resolution IS NULL AND proposal_id IS NOT NULL AND election_id IS NOT NULL AND stream_id IS NOT NULL)
  );

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='paid_action_intents_proposal_id_fkey') THEN
    ALTER TABLE sloptogether.paid_action_intents ADD CONSTRAINT paid_action_intents_proposal_id_fkey
      FOREIGN KEY (proposal_id) REFERENCES sloptogether.proposals(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='paid_action_intents_election_id_fkey') THEN
    ALTER TABLE sloptogether.paid_action_intents ADD CONSTRAINT paid_action_intents_election_id_fkey
      FOREIGN KEY (election_id) REFERENCES sloptogether.elections(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='paid_action_intents_stream_id_fkey') THEN
    ALTER TABLE sloptogether.paid_action_intents ADD CONSTRAINT paid_action_intents_stream_id_fkey
      FOREIGN KEY (stream_id) REFERENCES sloptogether.streams(id);
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS pending_paid_prompt_intents
  ON sloptogether.paid_action_intents(twitch_channel_id,created_at)
  WHERE action_kind='prompt_lock' AND state='intent_open';
CREATE UNIQUE INDEX IF NOT EXISTS one_paid_prompt_intent_per_proposal
  ON sloptogether.paid_action_intents(proposal_id)
  WHERE action_kind='prompt_lock' AND proposal_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_prompt_lock_per_stream
  ON sloptogether.paid_action_intents(twitch_channel_id,stream_id)
  WHERE action_kind='prompt_lock' AND state=ANY(ARRAY['intent_open','receipt_seen','verified_unallocated','receipt_unverified']::text[]);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_prompt_lock_per_segment
  ON sloptogether.paid_action_intents(twitch_channel_id,segment_id)
  WHERE action_kind='prompt_lock' AND state=ANY(ARRAY['intent_open','receipt_seen','verified_unallocated','reserved','dispatching','consumed_uncertain']::text[]);

REVOKE ALL ON ALL TABLES IN SCHEMA sloptogether FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sloptogether_app') THEN
    GRANT USAGE ON SCHEMA sloptogether TO sloptogether_app;
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA sloptogether TO sloptogether_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT USAGE ON SCHEMA sloptogether TO service_role;
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA sloptogether TO service_role;
  END IF;
END;
$$;

COMMIT;
