BEGIN;

ALTER TABLE sloptogether.channels
  ADD COLUMN chat_voting_enabled boolean NOT NULL DEFAULT false;

COMMIT;
