# audimo-purge.ps1
# Complete uninstall of Audimo (and everything it ever touched) from a
# Windows machine. Run from an *Administrator* PowerShell:
#
#   Set-ExecutionPolicy -Scope Process Bypass -Force
#   .\audimo-purge.ps1
#
# By default this also removes ~/Music/Audimo and ~/Audiobooks. Pass
# -KeepMedia to leave those folders intact if you have unrelated files
# in them. Pass -KeepFfmpeg to leave winget-installed ffmpeg alone.
#
#   .\audimo-purge.ps1 -KeepMedia -KeepFfmpeg

[CmdletBinding()]
param(
    [switch]$KeepMedia,
    [switch]$KeepFfmpeg
)

$ErrorActionPreference = "Continue"  # don't bail on first failure — keep purging

function Say($msg) { Write-Host "[purge] $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "[purge] $msg" -ForegroundColor Yellow }
function Done($msg) { Write-Host "[purge] $msg" -ForegroundColor Green }

# ── 1. Kill any running Audimo processes ────────────────────────────
# These hold file locks that would block the directory removals below.
# Cover the main app, both core sidecars, and any addon binary whose
# name contains "audimo".
Say "Killing running Audimo processes…"
$procNames = @("Audimo", "audimo-backend", "audimo-streaming")
foreach ($name in $procNames) {
    Get-Process -Name $name -ErrorAction SilentlyContinue | ForEach-Object {
        Say "  → killing $($_.ProcessName) (PID $($_.Id))"
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
}
# Any other addon sidecar binary that lives under the addons dir.
Get-Process | Where-Object {
    $_.Path -and $_.Path -like "*\.audimo\addons\*"
} | ForEach-Object {
    Say "  → killing addon $($_.ProcessName) (PID $($_.Id))"
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Milliseconds 500

# ── 2. Uninstall the MSI / NSIS package ─────────────────────────────
# winget knows about packages installed via either bundle format.
Say "Uninstalling Audimo via winget…"
$wingetOut = winget uninstall --silent --id app.audimo.desktop 2>&1
if ($LASTEXITCODE -eq 0) {
    Done "  winget uninstall ok"
} else {
    Warn "  winget didn't find app.audimo.desktop — falling back to registry scan"
    # Fallback: walk HKLM + HKCU Uninstall keys for a DisplayName match.
    $uninstallRoots = @(
        "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"
    )
    foreach ($root in $uninstallRoots) {
        Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
            $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
            if ($p.DisplayName -like "Audimo*") {
                Say "  → uninstalling $($p.DisplayName) via $($p.UninstallString)"
                if ($p.UninstallString -match '^msiexec') {
                    # MSI: append /qn to suppress UI.
                    Start-Process "msiexec.exe" -ArgumentList "/x $($p.PSChildName) /qn" -Wait
                } else {
                    Start-Process "cmd.exe" -ArgumentList "/c $($p.UninstallString) /S" -Wait
                }
            }
        }
    }
}

# ── 3. Wipe data directories ────────────────────────────────────────
# `.audimo` is the canonical state dir (DB, secrets, streaming cache,
# installed addons). `.audimo-indexers` is libtorrent state for the
# legacy indexers split. `.tunnel*` variants only exist on machines
# that pre-date the audaro→audimo rename.
Say "Removing data directories…"
$dataDirs = @(
    "$env:USERPROFILE\.audimo",
    "$env:USERPROFILE\.audimo-indexers",
    "$env:USERPROFILE\.tunnel",
    "$env:USERPROFILE\.tunnel-indexers",
    "$env:APPDATA\audimo",                                 # Tauri dirs::data_dir()
    "$env:LOCALAPPDATA\audimo",                            # Tauri logs / cache (if any)
    "$env:LOCALAPPDATA\Programs\Audimo",                   # NSIS user-scope install
    "$env:LOCALAPPDATA\app.audimo.desktop",                # Tauri WebView2 user data
    "${env:ProgramFiles}\Audimo"                           # MSI machine-scope install
)
foreach ($d in $dataDirs) {
    if (Test-Path $d) {
        Say "  → removing $d"
        Remove-Item -Path $d -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ── 4. Media folders (opt-out via -KeepMedia) ───────────────────────
# These hold user-visible files (saved music, downloaded audiobooks).
# The Audiobooks folder is risky — a user might have non-Audimo audio-
# books there. Default to removing for a true "fresh start", but the
# flag is the escape hatch.
if (-not $KeepMedia) {
    Say "Removing media directories (pass -KeepMedia to skip)…"
    $mediaDirs = @(
        "$env:USERPROFILE\Music\Audimo",
        "$env:USERPROFILE\Music\Tunnel",                   # legacy name
        "$env:USERPROFILE\Audiobooks"
    )
    foreach ($d in $mediaDirs) {
        if (Test-Path $d) {
            Say "  → removing $d"
            Remove-Item -Path $d -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
} else {
    Warn "Skipping media folders (-KeepMedia)"
}

# ── 5. Registry: deep-link handler ──────────────────────────────────
# Tauri's deep-link plugin registers an `audimo:` URL scheme under
# HKCU\Software\Classes. Uninstallers don't always clean these up.
Say "Cleaning registry entries…"
$regPaths = @(
    "HKCU:\Software\Classes\audimo",
    "HKCU:\Software\Classes\app.audimo.desktop",
    "HKLM:\Software\Classes\audimo"
)
foreach ($r in $regPaths) {
    if (Test-Path $r) {
        Say "  → removing $r"
        Remove-Item -Path $r -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ── 6. Start Menu shortcuts ─────────────────────────────────────────
# The uninstaller normally handles these, but stray shortcuts can
# survive a force-quit during install. Belt-and-suspenders.
Say "Removing Start Menu shortcuts…"
$shortcutGlobs = @(
    "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Audimo*",
    "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\Audimo*"
)
foreach ($g in $shortcutGlobs) {
    Get-Item $g -ErrorAction SilentlyContinue | ForEach-Object {
        Say "  → removing $($_.FullName)"
        Remove-Item -Path $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ── 7. ffmpeg (opt-out via -KeepFfmpeg) ─────────────────────────────
# We only know ffmpeg got installed *because of Audimo* if it came
# from our winget call (Gyan.FFmpeg). Don't touch a manually-installed
# ffmpeg — that would be surprising. Hence: winget-only removal.
if (-not $KeepFfmpeg) {
    Say "Uninstalling ffmpeg via winget (pass -KeepFfmpeg to skip)…"
    winget uninstall --silent --id Gyan.FFmpeg 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Done "  ffmpeg uninstalled"
    } else {
        Warn "  Gyan.FFmpeg not installed via winget — leaving any other ffmpeg alone"
    }
} else {
    Warn "Skipping ffmpeg (-KeepFfmpeg)"
}

# ── 8. Recycle Bin / temp leftovers ─────────────────────────────────
# PyInstaller extracts to %TEMP%\_MEI* on each launch. Sweep stragglers.
Say "Cleaning PyInstaller temp dirs…"
Get-ChildItem -Path $env:TEMP -Directory -Filter "_MEI*" -ErrorAction SilentlyContinue |
    ForEach-Object {
        Say "  → removing $($_.FullName)"
        Remove-Item -Path $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }

Done "All done. Audimo + addons + state are gone. Reboot recommended if any process refused to die."
