#!/usr/bin/env bash
# Run the audimo streaming server natively (dev mode). The Tauri shell
# spawns this in dev when no PyInstaller binary is present at
# binaries/audimo-streaming. Mirrors the audimo addon repos'
# run_native.sh: venv on first run, libtorrent from Homebrew, uvicorn
# with --reload.

set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -d .venv ]]; then
  echo "Creating venv (.venv/)..."
  python3 -m venv .venv
  .venv/bin/pip install --quiet --upgrade pip
  .venv/bin/pip install --quiet -r requirements.txt
fi

LT_GLOB="/opt/homebrew/Cellar/libtorrent-rasterbar/*/lib/python3.*/site-packages"
LT_SITE_PACKAGES="$(ls -d $LT_GLOB 2>/dev/null | tail -1 || true)"
if [[ -n "${LT_SITE_PACKAGES}" ]]; then
  PY_VERSION="$(.venv/bin/python -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")')"
  LT_PY_VERSION="$(basename "$(dirname "$LT_SITE_PACKAGES")")"
  if [[ "python${PY_VERSION}" == "${LT_PY_VERSION}" ]]; then
    export PYTHONPATH="${LT_SITE_PACKAGES}:${PYTHONPATH:-}"
    echo "[run] libtorrent: ${LT_SITE_PACKAGES}"
  else
    echo "[run] WARN: libtorrent ${LT_PY_VERSION} != venv python${PY_VERSION} — libtorrent disabled"
  fi
else
  echo "[run] WARN: libtorrent-rasterbar not installed — libtorrent disabled"
fi

export AUDIMO_STREAMING_DIR="${AUDIMO_STREAMING_DIR:-$HOME/.audimo/streaming}"
mkdir -p "${AUDIMO_STREAMING_DIR}"

PORT="${AUDIMO_STREAMING_PORT:-11471}"
echo "[run] data dir: ${AUDIMO_STREAMING_DIR}"
echo "[run] starting audimo-streaming on http://127.0.0.1:${PORT}"

exec .venv/bin/uvicorn server:app \
  --host 127.0.0.1 \
  --port "${PORT}" \
  --no-access-log \
  --reload \
  --reload-dir "$(pwd)"
