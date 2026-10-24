BEGIN;

ALTER TABLE sloptogether.story_plan_attempts
  ADD COLUMN claim_token uuid,
  ADD COLUMN claim_expires_at timestamptz,
  ADD CONSTRAINT story_plan_claim_pair CHECK ((claim_token IS NULL) = (claim_expires_at IS NULL));

CREATE INDEX story_plan_claim_expiry
  ON sloptogether.story_plan_attempts(claim_expires_at)
  WHERE status='planning' AND claim_expires_at IS NOT NULL;

COMMIT;
