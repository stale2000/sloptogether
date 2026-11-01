#!/usr/bin/env bash
set -euo pipefail
umask 077

service="sloptogether-media-publisher.service"
repo_root="$(cd "$(dirname "$0")/../../.." && pwd -P)"
script_path="$repo_root/workers/media-publisher/scripts/publisher-systemd.sh"
env_file="${SLOPTOGETHER_PUBLISHER_ENV_FILE:-$repo_root/workers/media-publisher/.env.production.local}"
node_bin="${SLOPTOGETHER_PUBLISHER_NODE:-$(command -v node || true)}"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
unit_path="$unit_dir/$service"

check_platform() {
  if [[ "$(uname -s)" != "Linux" ]]; then
    printf '%s\n' 'This installer manages a per-user Linux systemd service.' >&2
    exit 2
  fi
}

check_runtime() {
  if [[ ! -x "$node_bin" ]] || ! "$node_bin" -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major<20||(major===20&&minor<9)?1:0)'; then
    printf '%s\n' 'Node.js 20.9 or newer is required.' >&2
    exit 2
  fi
}

check_env_file() {
  python3 - "$env_file" <<'PY'
import os
import stat
import sys

path = sys.argv[1]
try:
    info = os.lstat(path)
except OSError:
    print("Publisher environment file is missing or inaccessible.", file=sys.stderr)
    raise SystemExit(2)
if not os.path.isabs(path) or not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
    print("Publisher environment file must be an absolute, regular file owned by this user and inaccessible to group/other users.", file=sys.stderr)
    raise SystemExit(2)
PY
}

render_unit() {
  python3 - "$repo_root" "$script_path" "$env_file" "$node_bin" <<'PY'
import os
import sys

repo, script, env_file, node = sys.argv[1:]
for path in (repo, script, env_file, node):
    if not os.path.isabs(path) or any(ord(c) < 32 or ord(c) == 127 for c in path):
        print("All service paths must be absolute and contain no control characters.", file=sys.stderr)
        raise SystemExit(2)
def quote(value, *, command=False):
    value = value.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%')
    if command:
        value = value.replace('$', '$$')
    return '"' + value + '"'
path = os.path.dirname(node) + ':/usr/local/bin:/usr/bin:/bin'
print('''[Unit]
Description=SlopTogether media publisher
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple''')
print('WorkingDirectory=' + quote(repo))
print('Environment=' + quote('PATH=' + path))
print('ExecStart=' + ' '.join(quote(arg, command=True) for arg in (script, 'run', env_file, node)))
print('''Restart=always
RestartSec=10
TimeoutStopSec=120
KillMode=mixed
NoNewPrivileges=yes
UMask=0077

[Install]
WantedBy=default.target''')
PY
}

install_service() {
  check_platform
  check_runtime
  check_env_file
  mkdir -p "$unit_dir"
  local temporary
  temporary="$(mktemp "$unit_dir/.${service}.XXXXXX")"
  trap 'rm -f "$temporary"' EXIT
  render_unit > "$temporary"
  chmod 600 "$temporary"
  mv -f "$temporary" "$unit_path"
  trap - EXIT
  systemctl --user daemon-reload
  systemctl --user enable --now "$service"
  printf '%s\n' 'Publisher user service installed and started.'
  printf '%s\n' 'For operation after logout/reboot, enable user lingering on the host.'
}

case "${1:-}" in
  install) install_service ;;
  uninstall)
    check_platform
    systemctl --user disable --now "$service"
    rm -f "$unit_path"
    systemctl --user daemon-reload
    printf '%s\n' 'Publisher service removed; environment file and logs were kept.'
    ;;
  status) check_platform; systemctl --user status "$service" --no-pager ;;
  health)
    check_platform
    check_runtime
    check_env_file
    systemctl --user is-active --quiet "$service"
    exec "$node_bin" "--env-file=$env_file" "$repo_root/workers/media-publisher/src/queue-health.mjs"
    ;;
  render-unit) check_runtime; render_unit ;;
  run)
    env_file="${2:?environment path required}"
    node_bin="${3:?node path required}"
    check_env_file
    exec "$node_bin" "--env-file=$env_file" "$repo_root/workers/media-publisher/src/index.mjs"
    ;;
  *) printf 'Usage: %s {install|uninstall|status|health|render-unit}\n' "$0" >&2; exit 2 ;;
esac
