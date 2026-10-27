#!/usr/bin/env bash
set -euo pipefail

# Create and remove only a new synthetic database on the local test cluster.
# No production credentials, external services, or production test mode are used.
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
bits_port=56432
if [[ "${SLOPTOGETHER_LOCAL_POSTGRES_PORT:-$bits_port}" != "$bits_port" ]]; then
  printf '%s\n' 'Bits integration requires the dedicated local PostgreSQL port 56432.' >&2
  exit 1
fi
assert_local_server() {
  local bits_identity
  bits_identity="$(env -i "PATH=$PATH" PGSSLMODE=disable PGCONNECT_TIMEOUT=3 psql -h 127.0.0.1 -p "$bits_port" -U postgres -d sloptogether -Atq -v ON_ERROR_STOP=1 -c \
    "select json_build_object('databaseName',current_database(),'dataDirectory',current_setting('data_directory'),'serverAddress',host(inet_server_addr()),'serverPort',inet_server_port())")"
  printf '%s' "$bits_identity" | env -i "PATH=$PATH" node "$repo_root/scripts/bits-local-db-guard.mjs"
}
env -i "PATH=$PATH" node --test "$repo_root/scripts/bits-local-db-guard.test.mjs"
assert_local_server
bits_suffix="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(8).toString("hex"))')"
bits_marker="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
bits_db_name="sloptogether_bits_test_${bits_suffix}"
env -i "PATH=$PATH" PGSSLMODE=disable PGCONNECT_TIMEOUT=3 createdb -h 127.0.0.1 -p "$bits_port" -U postgres "$bits_db_name"
assert_scratch_database() {
  local bits_identity
  bits_identity="$(env -i "PATH=$PATH" PGSSLMODE=disable PGCONNECT_TIMEOUT=3 psql -h 127.0.0.1 -p "$bits_port" -U postgres -d "$bits_db_name" -Atq -v ON_ERROR_STOP=1 -c \
    "select json_build_object('databaseName',current_database(),'dataDirectory',current_setting('data_directory'),'serverAddress',host(inet_server_addr()),'serverPort',inet_server_port(),'guardMarker',(select marker from public.sloptogether_bits_test_guard limit 1))")"
  printf '%s' "$bits_identity" | env -i "PATH=$PATH" node "$repo_root/scripts/bits-local-db-guard.mjs" scratch "$bits_db_name" "$bits_marker"
}
cleanup() {
  if assert_local_server && assert_scratch_database; then
    env -i "PATH=$PATH" PGSSLMODE=disable PGCONNECT_TIMEOUT=3 dropdb -h 127.0.0.1 -p "$bits_port" -U postgres --if-exists "$bits_db_name"
  else
    printf '%s\n' 'Local database identity changed; leaving the scratch database untouched.' >&2
  fi
}
trap cleanup EXIT

printf "create table public.sloptogether_bits_test_guard(marker text not null); insert into public.sloptogether_bits_test_guard values ('%s');\n" "$bits_marker" |
  env -i "PATH=$PATH" PGSSLMODE=disable PGCONNECT_TIMEOUT=3 psql -h 127.0.0.1 -p "$bits_port" -U postgres -d "$bits_db_name" -v ON_ERROR_STOP=1 -q >/dev/null
assert_scratch_database

for migration in "$repo_root"/db/migrations/[0-9][0-9][0-9]_*.sql; do
  # These two migrations change a cluster-wide role; the test runs as the
  # isolated database owner and does not need those grants.
  case "$(basename "$migration")" in
    018_*|019_*) continue ;;
    0[0-1][0-9]_*|020_*|021_*|024_*|025_*) ;;
    *) continue ;;
  esac
  env -i "PATH=$PATH" PGSSLMODE=disable PGCONNECT_TIMEOUT=3 psql -h 127.0.0.1 -p "$bits_port" -U postgres -d "$bits_db_name" -v ON_ERROR_STOP=1 -q -f "$migration" >/dev/null
done

cd "$repo_root/apps/web"
env -i "PATH=$PATH" "TMPDIR=${TMPDIR:-/tmp}" NODE_ENV=test \
  "SLOPTOGETHER_BITS_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:${bits_port}/${bits_db_name}" \
  "SLOPTOGETHER_BITS_TEST_GUARD_MARKER=${bits_marker}" \
  "$repo_root/node_modules/.bin/vitest" run src/lib/server/paid-bits-local.postgres.test.ts
