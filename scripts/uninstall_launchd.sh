#!/usr/bin/env bash
# Unload + remove Audimo's dev launchd agents installed by
# scripts/install_launchd.sh.
#
# Addons live in their own repos under github.com/audimo-addons/* —
# this script only manages the native app's streaming sidecar.
#
# Usage:
#   scripts/uninstall_launchd.sh           # remove all
#   scripts/uninstall_launchd.sh streaming # remove just streaming

set -euo pipefail

LAUNCH_AGENTS="$HOME/Library/LaunchAgents"

declare -a TARGETS=(
    "streaming:com.audimo.streaming"
)

want="${1:-all}"

remove() {
    local label="$1"
    local plist="$LAUNCH_AGENTS/${label}.plist"
    if [[ -f "$plist" ]]; then
        launchctl unload "$plist" 2>/dev/null || true
        rm -f "$plist"
        echo "removed $label"
    fi
}

for entry in "${TARGETS[@]}"; do
    IFS=":" read -r short label <<< "$entry"
    if [[ "$want" == "all" || "$want" == "$short" ]]; then
        remove "$label"
    fi
done
