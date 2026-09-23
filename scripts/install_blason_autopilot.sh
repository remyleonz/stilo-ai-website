#!/bin/zsh
# Installs the Blason autopilot wrapper where launchd can actually run it.
# launchd-spawned /bin/zsh is blocked by macOS TCC from reading anything under
# ~/Desktop ("Operation not permitted", job exits 127, verified 2026-09-23), while
# /opt/homebrew/bin/node is allowed. So the wrapper is copied OUT of the repo and
# the only Desktop reads it does go through node. Re-run after editing
# scripts/blason_autopilot.sh.
set -eu
SRC="$(cd "$(dirname "$0")" && pwd)/blason_autopilot.sh"
DST_DIR="$HOME/Library/Application Support/stilo"
mkdir -p "$DST_DIR"
sed -e 's#^CRON=$(grep .*#CRON=$(/opt/homebrew/bin/node -e '"'"'const e=require("fs").readFileSync(process.env.ENVF,"utf8");const m=e.match(/^CRON_SECRET="?([^"\\n]+)/m);process.stdout.write(m?m[1]:"")'"'"')#' \
    -e '2a\
# INSTALLED COPY: launchd runs THIS file (~/Library/Application Support/stilo/), not the repo copy.\
# Reason: launchd-spawned /bin/zsh cannot read anything under ~/Desktop (macOS TCC, exit 127),\
# while /opt/homebrew/bin/node can. Edit the repo copy, then re-run scripts/install_blason_autopilot.sh.
' "$SRC" > "$DST_DIR/blason_autopilot.sh"
chmod +x "$DST_DIR/blason_autopilot.sh"
for leg in sms email; do
  P="$HOME/Library/LaunchAgents/com.stilo.blason-$leg-daily.plist"
  [ -f "$P" ] || { echo "missing $P"; continue; }
  sed -i '' "s#/Users/remyleon/Desktop/AI Agency/sites/stilo-ai/scripts/blason_autopilot.sh#$DST_DIR/blason_autopilot.sh#" "$P"
  launchctl bootout "gui/$(id -u)/com.stilo.blason-$leg-daily" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$P"
done
echo "installed: $DST_DIR/blason_autopilot.sh"; launchctl list | grep com.stilo.blason
