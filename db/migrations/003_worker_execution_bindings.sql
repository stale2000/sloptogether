BEGIN;

-- A scoped application key can have one active binding per executable role.
-- Revoked grants remain as append-only evidence while replacement keys receive
-- new identities and therefore new grant rows.
CREATE UNIQUE INDEX trusted_execution_key_role
  ON sloptogether.trusted_executions(key_id,execution_role)
  WHERE key_id IS NOT NULL;

COMMIT;
