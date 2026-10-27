BEGIN;

-- Planning is separate from rendering: each requested clip has its own prompt,
-- chosen start frame, and explicit human approval before a worker can claim it.
ALTER TABLE sloptogether.story_batch_items
  ADD COLUMN candidate_plan jsonb,
  ADD COLUMN candidate_prompt text,
  ADD COLUMN candidate_revision bigint NOT NULL DEFAULT 0 CHECK (candidate_revision >= 0),
  ADD COLUMN start_boundary_revision_id uuid REFERENCES sloptogether.boundary_revisions(id),
  ADD COLUMN legacy_job_id uuid REFERENCES sloptogether.jobs(id),
  ADD COLUMN approved_by text,
  ADD COLUMN approved_at timestamptz,
  ADD COLUMN approved_candidate_revision bigint,
  ADD COLUMN rejected_by text,
  ADD COLUMN rejected_at timestamptz,
  ADD COLUMN rejection_reason text,
  ADD COLUMN pair_screen_token uuid,
  ADD COLUMN pair_screen_expires_at timestamptz,
  ADD COLUMN pair_screen_blocked boolean NOT NULL DEFAULT false;

ALTER TABLE sloptogether.story_batch_items DROP CONSTRAINT story_batch_items_state_check;
ALTER TABLE sloptogether.story_batch_items DROP CONSTRAINT story_batch_items_check;
ALTER TABLE sloptogether.story_batch_items ADD CONSTRAINT story_batch_items_state_check
  CHECK (state IN ('pending', 'planned', 'scheduled'));
ALTER TABLE sloptogether.story_batch_items ADD CONSTRAINT story_batch_items_shape_check
  CHECK ((state = 'pending' AND job_id IS NULL AND candidate_plan IS NULL AND candidate_prompt IS NULL)
      OR (state = 'planned' AND job_id IS NULL AND candidate_plan IS NOT NULL AND candidate_prompt IS NOT NULL AND candidate_revision>=1)
      OR (state = 'scheduled' AND segment_id IS NOT NULL AND job_id IS NOT NULL));
ALTER TABLE sloptogether.story_batch_items ADD CONSTRAINT story_batch_items_approval_check
  CHECK ((approved_by IS NULL AND approved_at IS NULL AND approved_candidate_revision IS NULL)
      OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND state IN ('planned','scheduled')
          AND candidate_plan IS NOT NULL AND candidate_prompt IS NOT NULL AND start_boundary_revision_id IS NOT NULL
          AND approved_candidate_revision IS NOT NULL AND approved_candidate_revision = candidate_revision));
ALTER TABLE sloptogether.story_batch_items ADD CONSTRAINT story_batch_items_rejection_check
  CHECK ((rejected_by IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL)
      OR (state='planned' AND rejected_by IS NOT NULL AND rejected_at IS NOT NULL
          AND rejection_reason IS NOT NULL AND length(trim(rejection_reason))>0 AND approved_at IS NULL));
ALTER TABLE sloptogether.story_batch_items ADD CONSTRAINT story_batch_items_screen_claim_check
  CHECK ((pair_screen_token IS NULL AND pair_screen_expires_at IS NULL)
      OR (state='planned' AND pair_screen_token IS NOT NULL AND pair_screen_expires_at IS NOT NULL AND NOT pair_screen_blocked));

-- Preserve the already-held, unclaimed continuation as an unapproved draft.
-- Never recycle a spent, claimed, running, or committed attempt. The existing
-- segment remains held; no approval, new job, or funding is created here.
UPDATE sloptogether.story_batch_items item
SET state='planned', legacy_job_id=item.job_id, job_id=NULL,
    candidate_plan=plan.plan_payload - 'plannerUsage', candidate_prompt=plan.compiled_prompt,
    candidate_revision=1, start_boundary_revision_id=revision.start_boundary_revision_id
FROM sloptogether.jobs job
JOIN sloptogether.job_attempts attempt ON attempt.job_id=job.id AND attempt.funding_id=job.funding_id
JOIN sloptogether.funding_authorizations funding ON funding.id=job.funding_id
JOIN sloptogether.segment_revisions revision ON revision.id=job.segment_revision_id
JOIN sloptogether.segments segment ON segment.id=revision.segment_id AND segment.selected_revision_id=revision.id
JOIN sloptogether.story_plan_attempts plan ON plan.resulting_segment_id=segment.id
WHERE item.job_id=job.id AND item.segment_id=segment.id AND item.state='scheduled'
  AND plan.input_payload->>'batchItemId'=item.id::text AND jsonb_typeof(plan.plan_payload)='object'
  AND plan.compiled_prompt=revision.prompt
  AND job.state='cancelled' AND attempt.state='cancelled' AND attempt.claimed_at IS NULL
  AND attempt.provider_request_id IS NULL AND attempt.output_asset_id IS NULL
  AND funding.source='owner_budget' AND funding.state='released' AND funding.consumed_at IS NULL
  AND coalesce(funding.actual_cost_usd,0)=0 AND segment.protected_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sloptogether.job_attempts other WHERE other.job_id=job.id AND other.id<>attempt.id)
  AND NOT EXISTS (SELECT 1 FROM sloptogether.story_plan_attempts other WHERE other.resulting_segment_id=segment.id
    AND other.input_payload->>'batchItemId'=item.id::text AND other.compiled_prompt=revision.prompt AND other.id<>plan.id)
  AND NOT EXISTS (SELECT 1 FROM sloptogether.program_items p WHERE p.segment_id=segment.id AND p.committed_at IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM sloptogether.paid_action_intents p WHERE p.segment_revision_id=revision.id);

COMMIT;
