# Windows equivalent of run_native.sh — runs the audimo streaming
# server natively in dev mode. The Tauri shell invokes this on Windows
# when no PyInstaller binary is present at binaries/audimo-streaming.exe.
#
# libtorrent on Windows comes from the pip wheel (`pip install
# libtorrent`) installed straight into the venv — no PYTHONPATH dance.

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

if (-not (Test-Path ".venv")) {
    Write-Host "Creating venv (.venv\)..."
    python -m venv .venv
    .\.venv\Scripts\python.exe -m pip install --quiet --upgrade pip
    .\.venv\Scripts\python.exe -m pip install --quiet -r requirements.txt
    # libtorrent wheel is pulled in via requirements.txt on Windows.
    # If it isn't listed there, install it explicitly:
    .\.venv\Scripts\python.exe -m pip install --quiet libtorrent 2>$null
}

if (-not $env:AUDIMO_STREAMING_DIR) {
    $env:AUDIMO_STREAMING_DIR = Join-Path $env:USERPROFILE ".audimo\streaming"
}
New-Item -ItemType Directory -Force -Path $env:AUDIMO_STREAMING_DIR | Out-Null

$port = if ($env:AUDIMO_STREAMING_PORT) { $env:AUDIMO_STREAMING_PORT } else { "11471" }
Write-Host "[run] data dir: $env:AUDIMO_STREAMING_DIR"
Write-Host "[run] starting audimo-streaming on http://127.0.0.1:$port"

& .\.venv\Scripts\python.exe -m uvicorn server:app `
    --host 127.0.0.1 `
    --port $port `
    --no-access-log `
    --reload `
    --reload-dir (Get-Location).Path
