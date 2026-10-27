#!/usr/bin/env bash
set -euo pipefail

# Run the PostgreSQL EventSub integration test against a disposable database
# on the dedicated local demo cluster. No cloud credentials or services used.
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
pg_port=56432
assert_local_server() {
  local identity
  identity="$(env -i "PATH=$PATH" PGSSLMODE=disable PGCONNECT_TIMEOUT=3 psql -h 127.0.0.1 -p "$pg_port" -U postgres -d sloptogether -Atq -v ON_ERROR_STOP=1 -c \
    "select json_build_object('databaseName',current_database(),'dataDirectory',current_setting('data_directory'),'serverAddress',host(inet_server_addr()),'serverPort',inet_server_port())")"
  printf '%s' "$identity" | env -i "PATH=$PATH" node "$repo_root/scripts/bits-local-db-guard.mjs"
}
assert_local_server
suffix="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(8).toString("hex"))')"
marker="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
test_db="sloptogether_preair_test_${suffix}"
env -i "PATH=$PATH" PGSSLMODE=disable PGCONNECT_TIMEOUT=3 createdb -h 127.0.0.1 -p "$pg_port" -U postgres "$test_db"
assert_scratch_database() {
  local identity
  identity="$(env -i "PATH=$PATH" PGSSLMODE=disable PGCONNECT_TIMEOUT=3 psql -h 127.0.0.1 -p "$pg_port" -U postgres -d "$test_db" -Atq -v ON_ERROR_STOP=1 -c \
    "select json_build_object('databaseName',current_database(),'dataDirectory',current_setting('data_directory'),'serverAddress',host(inet_server_addr()),'serverPort',inet_server_port(),'guardMarker',(select marker from public.sloptogether_eventsub_test_guard limit 1))")"
  env -i "PATH=$PATH" "EVENTSUB_IDENTITY=$identity" "REPO_ROOT=$repo_root" node --input-type=module - "$test_db" "$marker" <<'NODE'
import { pathToFileURL } from 'node:url';
const { assertLocalDemoDatabase } = await import(pathToFileURL(`${process.env.REPO_ROOT}/scripts/local-demo-guard.mjs`));
const [expectedDb, expectedMarker] = process.argv.slice(2);
const identity = JSON.parse(process.env.EVENTSUB_IDENTITY);
if (identity.databaseName !== expectedDb || identity.guardMarker !== expectedMarker
  || !/^sloptogether_preair_test_[a-f0-9]{16}$/.test(expectedDb)
  || !/^[a-f0-9]{48}$/.test(expectedMarker)) throw new Error('eventsub_scratch_database_identity_not_allowed');
assertLocalDemoDatabase({ ...identity, databaseName: 'sloptogether' });
NODE
}
cleanup() {
  if assert_local_server && assert_scratch_database; then
    env -i "PATH=$PATH" PGSSLMODE=disable PGCONNECT_TIMEOUT=3 dropdb -h 127.0.0.1 -p "$pg_port" -U postgres --if-exists "$test_db"
  else
    printf '%s\n' 'Local database identity changed; leaving the scratch database untouched.' >&2
  fi
}
trap cleanup EXIT
printf "create table public.sloptogether_eventsub_test_guard(marker text not null); insert into public.sloptogether_eventsub_test_guard values ('%s');\n" "$marker" |
  env -i "PATH=$PATH" PGSSLMODE=disable PGCONNECT_TIMEOUT=3 psql -h 127.0.0.1 -p "$pg_port" -U postgres -d "$test_db" -v ON_ERROR_STOP=1 -q >/dev/null
assert_scratch_database
for migration in "$repo_root"/db/migrations/[0-9][0-9][0-9]_*.sql; do
  case "$(basename "$migration")" in
    018_*|019_*|023_*) continue ;;
    0[0-1][0-9]_*|020_*|021_*|022_*) ;;
    *) continue ;;
  esac
  env -i "PATH=$PATH" PGSSLMODE=disable PGCONNECT_TIMEOUT=3 psql -h 127.0.0.1 -p "$pg_port" -U postgres -d "$test_db" -v ON_ERROR_STOP=1 -q -f "$migration" >/dev/null
done
cd "$repo_root/apps/web"
env -i "PATH=$PATH" "TMPDIR=${TMPDIR:-/tmp}" NODE_ENV=test \
  "SLOPTOGETHER_POLICY_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:${pg_port}/${test_db}" \
  "SLOPTOGETHER_EVENTSUB_TEST_GUARD_MARKER=${marker}" \
  "$repo_root/node_modules/.bin/vitest" run src/lib/server/subscriber-policy.postgres.test.ts src/lib/server/extension-worker-flow.postgres.test.ts
cd "$repo_root"
env -i "PATH=$PATH" "TMPDIR=${TMPDIR:-/tmp}" NODE_ENV=test \
  "SLOPTOGETHER_PREAIR_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:${pg_port}/${test_db}" \
  node --test workers/media-publisher/tests/preair.postgres.test.mjs workers/media-publisher/tests/validation.postgres.test.mjs
