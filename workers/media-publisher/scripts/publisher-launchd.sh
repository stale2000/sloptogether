#!/usr/bin/env bash
set -euo pipefail

label="com.clipsgg.sloptogether.media-publisher"
repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
node_bin="$(command -v node || true)"
env_file="${SLOPTOGETHER_PUBLISHER_ENV_FILE:-$repo_root/workers/media-publisher/.env.production.local}"
launch_agents="$HOME/Library/LaunchAgents"
log_dir="$HOME/Library/Logs/SlopTogether"
plist_path="$launch_agents/$label.plist"
domain="gui/$(id -u)"

render_plist() {
  python3 - "$label" "$node_bin" "$repo_root" "$env_file" "$log_dir" <<'PY'
import plistlib
import sys
from pathlib import Path

label, node, repo, env_file, log_dir = sys.argv[1:]
node_path = Path(node)
repo_path = Path(repo)
env_path = Path(env_file)
log_path = Path(log_dir)
data = {
    "Label": label,
    "ProgramArguments": [str(node_path), f"--env-file={env_path}", str(repo_path / "workers/media-publisher/src/index.mjs")],
    "WorkingDirectory": str(repo_path),
    "EnvironmentVariables": {"PATH": f"{node_path.parent}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", "HOME": str(Path.home())},
    "RunAtLoad": True,
    "KeepAlive": True,
    "ThrottleInterval": 10,
    "ExitTimeOut": 120,
    "StandardOutPath": str(log_path / "media-publisher.log"),
    "StandardErrorPath": str(log_path / "media-publisher-error.log"),
}
sys.stdout.buffer.write(plistlib.dumps(data, fmt=plistlib.FMT_XML, sort_keys=True))
PY
}

check_platform() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    printf '%s\n' 'This installer manages a per-user macOS LaunchAgent.' >&2
    exit 2
  fi
}

check_runtime() {
  if [[ -z "$node_bin" ]]; then
    printf '%s\n' 'Node.js was not found on PATH.' >&2
    exit 2
  fi
  if ! "$node_bin" -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major<20||(major===20&&minor<9)?1:0)'; then
    printf '%s\n' 'Node.js 20.9 or newer is required.' >&2
    exit 2
  fi
}

check_env_file() {
  if [[ ! -f "$env_file" ]]; then
    printf '%s\n' 'Publisher environment file not found. Set SLOPTOGETHER_PUBLISHER_ENV_FILE to its path.' >&2
    exit 2
  fi
  python3 - "$env_file" <<'PY'
import os
import stat
import sys

path = sys.argv[1]
info = os.stat(path)
if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
    print("Publisher environment file must be owned by this user and inaccessible to group/other users.", file=sys.stderr)
    raise SystemExit(2)
PY
}

install_agent() {
  check_platform
  check_runtime
  check_env_file
  mkdir -p -m 700 "$launch_agents" "$log_dir"
  chmod 700 "$log_dir"
  render_plist > "$plist_path"
  chmod 600 "$plist_path"
  plutil -lint "$plist_path" >/dev/null
  launchctl bootout "$domain" "$plist_path" >/dev/null 2>&1 || true
  launchctl bootstrap "$domain" "$plist_path"
  launchctl kickstart "$domain/$label"
  printf '%s\n' 'Publisher LaunchAgent installed and started.'
  printf '%s\n' 'Logs: ~/Library/Logs/SlopTogether/media-publisher*.log'
}

remove_agent() {
  check_platform
  launchctl bootout "$domain" "$plist_path" >/dev/null 2>&1 || true
  rm -f "$plist_path"
  printf '%s\n' 'Publisher LaunchAgent removed. The environment file and logs were kept.'
}

show_status() {
  check_platform
  if launchctl print "$domain/$label" >/dev/null 2>&1; then
    launchctl list | awk -v label="$label" '$3 == label { print; found=1 } END { if (!found) exit 1 }'
  else
    printf '%s\n' 'Publisher LaunchAgent is not loaded.'
    exit 1
  fi
}

case "${1:-}" in
  install) install_agent ;;
  uninstall) remove_agent ;;
  status) show_status ;;
  render-plist) check_platform; check_runtime; render_plist ;;
  *) printf 'Usage: %s {install|uninstall|status|render-plist}\n' "$0" >&2; exit 2 ;;
esac
