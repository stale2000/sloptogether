#!/usr/bin/env bash
set -euo pipefail

# This script creates and drops a random scratch database on the dedicated
# local demo cluster. It never reads production environment variables.
repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
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
test_db="sloptogether_publisher_health_${suffix}"
env -i "PATH=$PATH" PGSSLMODE=disable PGCONNECT_TIMEOUT=3 createdb -h 127.0.0.1 -p "$pg_port" -U postgres "$test_db"
assert_scratch_database() {
  local identity
  identity="$(env -i "PATH=$PATH" PGSSLMODE=disable PGCONNECT_TIMEOUT=3 psql -h 127.0.0.1 -p "$pg_port" -U postgres -d "$test_db" -Atq -v ON_ERROR_STOP=1 -c \
    "select json_build_object('databaseName',current_database(),'dataDirectory',current_setting('data_directory'),'serverAddress',host(inet_server_addr()),'serverPort',inet_server_port(),'guardMarker',(select marker from public.sloptogether_publisher_health_test_guard limit 1))")"
  env -i "PATH=$PATH" "HEALTH_IDENTITY=$identity" "REPO_ROOT=$repo_root" node --input-type=module - "$test_db" "$marker" <<'NODE'
import { pathToFileURL } from 'node:url';
const { assertLocalDemoDatabase } = await import(pathToFileURL(`${process.env.REPO_ROOT}/scripts/local-demo-guard.mjs`));
const [expectedDb, expectedMarker] = process.argv.slice(2);
const identity = JSON.parse(process.env.HEALTH_IDENTITY);
if(identity.databaseName!==expectedDb||identity.guardMarker!==expectedMarker
  ||!/^sloptogether_publisher_health_[a-f0-9]{16}$/.test(expectedDb)||!/^[a-f0-9]{48}$/.test(expectedMarker))
  throw new Error('publisher_health_scratch_database_identity_not_allowed');
assertLocalDemoDatabase({...identity,databaseName:'sloptogether'});
NODE
}
cleanup() {
  if assert_local_server && assert_scratch_database; then
    env -i "PATH=$PATH" PGSSLMODE=disable PGCONNECT_TIMEOUT=3 dropdb -h 127.0.0.1 -p "$pg_port" -U postgres --if-exists "$test_db"
  else
    printf '%s\n' 'Local database identity or scratch marker changed; leaving the scratch database untouched.' >&2
    return 1
  fi
}
trap cleanup EXIT
printf "create table public.sloptogether_publisher_health_test_guard(marker text not null); insert into public.sloptogether_publisher_health_test_guard values ('%s');\n" "$marker" |
  env -i "PATH=$PATH" PGSSLMODE=disable PGCONNECT_TIMEOUT=3 psql -h 127.0.0.1 -p "$pg_port" -U postgres -d "$test_db" -v ON_ERROR_STOP=1 -q >/dev/null
assert_scratch_database
env -i "PATH=$PATH" PGSSLMODE=disable PGCONNECT_TIMEOUT=3 psql -h 127.0.0.1 -p "$pg_port" -U postgres -d "$test_db" -v ON_ERROR_STOP=1 -q <<'SQL' >/dev/null
CREATE SCHEMA sloptogether;
CREATE TABLE sloptogether.outbox (
  event_kind text NOT NULL, available_at timestamptz NOT NULL,
  leased_until timestamptz, attempts integer NOT NULL, delivered_at timestamptz
);
SQL
cd "$repo_root"
env -i "PATH=$PATH" "SLOPTOGETHER_PUBLISHER_HEALTH_TEST_URL=postgresql://postgres@127.0.0.1:${pg_port}/${test_db}" \
  "SLOPTOGETHER_PUBLISHER_HEALTH_TEST_MARKER=$marker" \
  node --test workers/media-publisher/tests/queue-health.postgres.test.mjs
