BEGIN;

ALTER TABLE sloptogether.worker_devices
  DROP CONSTRAINT IF EXISTS worker_devices_platform_check;
ALTER TABLE sloptogether.worker_devices
  ADD CONSTRAINT worker_devices_platform_check CHECK (platform IN ('windows','wsl','linux','fal'));

COMMIT;
