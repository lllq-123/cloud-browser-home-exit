#!/usr/bin/env bash
# Full Chromium launcher for an isolated cloud browser profile.
set -euo pipefail
umask 077

XHS_CONFIG_DIR=${XHS_CONFIG_DIR:-"$HOME/.config/xhs-browser"}
declare -A XHS_OVERRIDES=()
for XHS_KEY in XHS_PROFILE_DIR XHS_PAC_FILE XHS_EXTENSION_DIR XHS_LOAD_EXTENSION \
  XHS_BROWSER_MODE XHS_CDP_PORT XHS_UA_MODE XHS_ACCEPT_LANG XHS_NO_SANDBOX \
  XHS_SMALL_SHM XHS_START_URL XHS_CHROME_BIN; do
  if [[ -v "$XHS_KEY" ]]; then XHS_OVERRIDES["$XHS_KEY"]=${!XHS_KEY}; fi
done
if [[ -f "$XHS_CONFIG_DIR/browser.env" ]]; then
  # This is the operator's own shell configuration, not a downloaded secret file.
  source "$XHS_CONFIG_DIR/browser.env"
fi
for XHS_KEY in "${!XHS_OVERRIDES[@]}"; do
  printf -v "$XHS_KEY" '%s' "${XHS_OVERRIDES[$XHS_KEY]}"
done
XHS_PROFILE_DIR=${XHS_PROFILE_DIR:-"$XHS_CONFIG_DIR/profile"}
XHS_PAC_FILE=${XHS_PAC_FILE:-"$XHS_CONFIG_DIR/proxy.pac"}
XHS_EXTENSION_DIR=${XHS_EXTENSION_DIR:-"$XHS_CONFIG_DIR/extension"}
XHS_LOAD_EXTENSION=${XHS_LOAD_EXTENSION:-1}
XHS_BROWSER_MODE=${XHS_BROWSER_MODE:-headless}
XHS_CDP_PORT=${XHS_CDP_PORT:-9222}
XHS_UA_MODE=${XHS_UA_MODE:-native}
XHS_ACCEPT_LANG=${XHS_ACCEPT_LANG:-zh-CN,zh,en-US,en}
XHS_NO_SANDBOX=${XHS_NO_SANDBOX:-0}
XHS_SMALL_SHM=${XHS_SMALL_SHM:-0}
XHS_START_URL=${XHS_START_URL:-about:blank}

fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ "$XHS_CDP_PORT" =~ ^[0-9]{4,5}$ ]] || fail 'XHS_CDP_PORT must be a nonzero port from 1024 to 65535.'
(( 10#$XHS_CDP_PORT >= 1024 && 10#$XHS_CDP_PORT <= 65535 )) || fail 'CDP port is out of range.'
for flag in "$XHS_LOAD_EXTENSION" "$XHS_NO_SANDBOX" "$XHS_SMALL_SHM"; do
  [[ "$flag" == 0 || "$flag" == 1 ]] || fail 'Boolean settings must be 0 or 1.'
done
[[ -r "$XHS_PAC_FILE" ]] || fail "Missing PAC file: $XHS_PAC_FILE"
if [[ -z "${XHS_CHROME_BIN:-}" ]]; then
  [[ -r "$XHS_CONFIG_DIR/chrome-path" ]] || fail 'Create chrome-path using the installation steps.'
  IFS= read -r XHS_CHROME_BIN < "$XHS_CONFIG_DIR/chrome-path"
fi
[[ -x "$XHS_CHROME_BIN" ]] || fail "Browser executable unavailable: $XHS_CHROME_BIN"
[[ "$XHS_CHROME_BIN" != *headless_shell* && "$XHS_CHROME_BIN" != *headless-shell* ]] || fail 'Use full Chromium, not headless shell.'

mkdir -p "$XHS_PROFILE_DIR"
if [[ "$XHS_LOAD_EXTENSION" == 1 ]]; then
  [[ -r "$XHS_EXTENSION_DIR/manifest.json" ]] || fail "Missing extension manifest: $XHS_EXTENSION_DIR"
  python3 - "$XHS_PROFILE_DIR" "$XHS_ACCEPT_LANG" <<'PY'
import json
from pathlib import Path
import sys
p = Path(sys.argv[1]) / 'Default' / 'Preferences'
p.parent.mkdir(parents=True, exist_ok=True)
if not p.exists():
    try:
        with p.open('x') as f:
            json.dump({'extensions': {'ui': {'developer_mode': True}},
                       'intl': {'accept_languages': sys.argv[2]}}, f)
    except FileExistsError:
        pass
data = json.loads(p.read_text())
if data.get('extensions', {}).get('ui', {}).get('developer_mode') is not True:
    raise SystemExit('Enable extension developer mode in this profile first; see the guide. Existing Preferences were not rewritten.')
PY
fi

XHS_PAC_URL=$(python3 - "$XHS_PAC_FILE" <<'PY'
import base64
from pathlib import Path
import sys
print('data:application/x-ns-proxy-autoconfig;base64,' +
      base64.b64encode(Path(sys.argv[1]).read_bytes()).decode('ascii'))
PY
)
XHS_ARGS=(
  "--user-data-dir=$XHS_PROFILE_DIR"
  "--remote-debugging-address=127.0.0.1"
  "--remote-debugging-port=$XHS_CDP_PORT"
  "--window-size=1920,1040" "--window-position=0,0"
  "--force-device-scale-factor=1"
  "--lang=zh-CN" "--accept-lang=$XHS_ACCEPT_LANG"
  "--proxy-pac-url=$XHS_PAC_URL"
  "--no-first-run" "--no-default-browser-check"
)
case "$XHS_BROWSER_MODE" in
  headless) XHS_ARGS+=("--headless=new" "--screen-info={0,0 1920x1080}") ;;
  headed) [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] || fail 'Headed mode needs an existing graphical desktop.' ;;
  *) fail 'XHS_BROWSER_MODE must be headless or headed.' ;;
esac
if [[ "$XHS_LOAD_EXTENSION" == 1 ]]; then
  XHS_ARGS+=("--load-extension=$XHS_EXTENSION_DIR" "--disable-extensions-except=$XHS_EXTENSION_DIR")
fi
case "$XHS_UA_MODE" in
  native) ;;
  linux-desktop)
    [[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || fail 'linux-desktop UA example is only for Linux x86_64.'
    XHS_VERSION=$("$XHS_CHROME_BIN" --version)
    [[ "$XHS_VERSION" =~ ([0-9]+)\.[0-9]+\.[0-9]+\.[0-9]+ ]] || fail 'Cannot read actual browser version.'
    XHS_MAJOR=${BASH_REMATCH[1]}
    XHS_ARGS+=("--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/$XHS_MAJOR.0.0.0 Safari/537.36")
    ;;
  *) fail 'XHS_UA_MODE must be native or linux-desktop.' ;;
esac
if [[ "$XHS_NO_SANDBOX" == 1 ]]; then
  printf '%s\n' 'Explicit compatibility setting: Chromium sandbox is disabled.' >&2
  XHS_ARGS+=("--no-sandbox")
fi
if [[ "$XHS_SMALL_SHM" == 1 ]]; then
  XHS_ARGS+=("--disable-dev-shm-usage")
fi
if [[ "${1:-}" == --print-args && $# == 1 ]]; then
  printf '%q ' "$XHS_CHROME_BIN" "${XHS_ARGS[@]}" "$XHS_START_URL"
  printf '\n'
  exit 0
fi
[[ $# == 0 ]] || fail 'Usage: start-browser.sh [--print-args]'
exec "$XHS_CHROME_BIN" "${XHS_ARGS[@]}" "$XHS_START_URL"
