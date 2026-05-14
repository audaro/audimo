#!/usr/bin/env bash
# Render + install Audimo's dev launchd agents.
#
# The plist in streaming_server/ is checked in as a *.plist.template
# file with __REPO_ROOT__ / __HOME__ placeholders so it works on any
# developer's machine. This script substitutes the right paths and
# copies the rendered plist into ~/Library/LaunchAgents, then loads it
# with launchctl.
#
# Addons live in their own repos under github.com/audimo-addons/* —
# each carries its own plist template alongside the addon's source.
# This script no longer manages them.
#
# Usage:
#   scripts/install_launchd.sh           # install all
#   scripts/install_launchd.sh streaming # install just streaming server
#
# Pair with scripts/uninstall_launchd.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"

mkdir -p "$LAUNCH_AGENTS"

# (label, source-template) pairs.
declare -a TARGETS=(
    "streaming:com.audimo.streaming:$REPO_ROOT/streaming_server/com.audimo.streaming.plist.template"
)

want="${1:-all}"

render_and_install() {
    local short="$1" label="$2" template="$3"
    if [[ ! -f "$template" ]]; then
        echo "skip $label — template not found at $template" >&2
        return 0
    fi
    local out="$LAUNCH_AGENTS/${label}.plist"
    sed -e "s|__REPO_ROOT__|$REPO_ROOT|g" \
        -e "s|__HOME__|$HOME|g" \
        "$template" > "$out"
    # Reload: unload first (ignore errors if not loaded), then load.
    launchctl unload "$out" 2>/dev/null || true
    launchctl load "$out"
    echo "installed $label → $out"
}

for entry in "${TARGETS[@]}"; do
    IFS=":" read -r short label template <<< "$entry"
    if [[ "$want" == "all" || "$want" == "$short" ]]; then
        render_and_install "$short" "$label" "$template"
    fi
done
