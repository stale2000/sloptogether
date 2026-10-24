BEGIN;

ALTER TABLE sloptogether.upload_reservations
  ADD COLUMN policy_revision integer NOT NULL DEFAULT 1 CHECK (policy_revision>0);
UPDATE sloptogether.upload_reservations r SET policy_revision=c.policy_revision
  FROM sloptogether.job_attempts a JOIN sloptogether.jobs j ON j.id=a.job_id
  JOIN sloptogether.channels c ON c.twitch_channel_id=j.twitch_channel_id
  WHERE r.attempt_id=a.id;

ALTER TABLE sloptogether.asset_upload_reservations
  ADD COLUMN policy_revision integer NOT NULL DEFAULT 1 CHECK (policy_revision>0);
UPDATE sloptogether.asset_upload_reservations r SET policy_revision=c.policy_revision
  FROM sloptogether.channels c WHERE c.twitch_channel_id=r.twitch_channel_id;

COMMIT;
