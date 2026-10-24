BEGIN;

ALTER TABLE sloptogether.worker_pairings
  ADD COLUMN request_ip_hash bytea;

CREATE INDEX worker_pairing_ip_recent
  ON sloptogether.worker_pairings(request_ip_hash,created_at DESC)
  WHERE request_ip_hash IS NOT NULL;

COMMIT;
