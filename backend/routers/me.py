"""Identity, settings, admin config, and diagnostic endpoints.

Single-user app — `/api/auth/me` is the "who am I + my settings" probe
the frontend uses on boot. Admin config is a back-compat shim now that
upstream-service URLs moved into per-addon settings.
"""
import os
import shutil
import sys
from pathlib import Path

from fastapi import APIRouter, Depends

from auth import get_current_user, get_admin_user
from database import (
    get_user_settings, update_user_settings,
    get_global_config, set_global_config,
)

router = APIRouter(tags=["me"])


@router.get("/api/health")
async def health():
    return {"status": "ok"}


_DEBUG_LOG_PATH = Path.home() / ".audimo" / "frontend-debug.log"
_DEBUG_LOG_TAG_MAX = 64
_DEBUG_LOG_MSG_MAX = 1024


@router.post("/api/_debug_log")
async def _debug_log(payload: dict, current_user: dict = Depends(get_current_user)):
    """Diagnostic sink — frontend POSTs free-form messages here so the
    debugger / addon log can correlate UI state with backend behavior.
    Auth-gated: in local-only mode `get_current_user` is a no-op, but
    when `AUDIMO_API_KEY` is set this prevents an unauthenticated
    write-to-disk endpoint from being exposed to the public internet.

    Hardened against accidental secret leakage:
      * tag/msg are length-capped so a runaway frontend log can't fill
        the disk
      * the log file is chmod 0600 on first write, so any user-level
        process snooping `~/.audimo` (e.g. an unrelated Electron app)
        can't read what's been logged
    """
    import time as _t
    tag = str(payload.get("tag", "frontend"))[:_DEBUG_LOG_TAG_MAX]
    msg = str(payload.get("msg", ""))[:_DEBUG_LOG_MSG_MAX]
    # Strip newlines so a single payload can't forge a fake log line.
    msg = msg.replace("\r", " ").replace("\n", " ")
    line = f"{_t.strftime('%H:%M:%S')} {tag}: {msg}"
    try:
        first_write = not _DEBUG_LOG_PATH.exists()
        with open(_DEBUG_LOG_PATH, "a") as f:
            f.write(line + "\n")
        if first_write:
            try:
                os.chmod(_DEBUG_LOG_PATH, 0o600)
            except Exception:
                pass
    except Exception:
        pass
    return {"ok": True}


# Audimo is a single-user-per-install desktop app — no register/login flow.
# `/api/auth/me` is preserved as a "who am I and what's my session config"
# probe for the frontend; it returns the synthetic single user.


@router.get("/api/auth/me")
async def get_me(current_user: dict = Depends(get_current_user)):
    settings = get_user_settings(current_user["id"])
    return {"user": current_user, "settings": settings}


@router.get("/api/boot-status")
async def boot_status(current_user: dict = Depends(get_current_user)):
    """Crash tripwire — one-shot signal that the previous backend
    session didn't exit cleanly. Frontend consumes on mount and shows
    a "want to copy the log?" prompt once per crash. Subsequent calls
    return ``previous_crashed=False`` so the prompt doesn't re-fire
    on every refresh.

    Zero phone-home: this state lives entirely on the user's disk in
    ``~/.audimo/last-boot.json``. We never report a crash anywhere.
    """
    from main import consume_crash_flag
    return {"previous_crashed": consume_crash_flag()}


@router.get("/api/system/ffmpeg-status")
async def ffmpeg_status():
    """Report whether ffmpeg is on PATH so the UI can show a one-time
    install hint. Unauthenticated: the answer is the same for every
    caller, and gating it would make the first-launch banner harder
    to wire (the probe runs before pairing). Returns the platform so
    the banner can show the right install command (brew/winget/apt).
    """
    path = shutil.which("ffmpeg")
    return {
        "installed": path is not None,
        "path": path,
        "platform": sys.platform,  # "darwin" | "win32" | "linux"
        # The Windows banner shows an "Install for me" button that
        # POSTs /api/system/install-ffmpeg. We don't auto-install on
        # macOS/Linux because brew/apt commands need sudo or a
        # pre-existing Homebrew install — too much to assume.
        "can_auto_install": sys.platform == "win32"
            and shutil.which("winget") is not None,
    }


@router.post("/api/system/install-ffmpeg")
async def install_ffmpeg():
    """Windows-only one-click ffmpeg install via winget. Runs the
    package install synchronously and returns once winget exits.
    Best-effort: failures (no winget, source-agreement decline,
    network error) surface as a 500 with stderr in the body so the
    banner can prompt for manual download.

    Unauthenticated for parity with /ffmpeg-status — the user already
    triggered this from a click in the local-only UI, and the only
    side-effect is installing an officially-published package.
    """
    import subprocess
    if sys.platform != "win32":
        return {"ok": False, "error": "auto-install only supported on Windows"}
    winget = shutil.which("winget")
    if not winget:
        return {"ok": False, "error": "winget not found on PATH"}
    try:
        # `Gyan.FFmpeg` is the canonical winget id (full ffmpeg build,
        # not the minimal `essentials` variant). --silent suppresses
        # interactive prompts; --accept-* avoids first-run agreement
        # blockers. CREATE_NO_WINDOW (0x08000000) keeps the install
        # from flashing a console — we're already running headless
        # inside the sidecar.
        proc = subprocess.run(
            [winget, "install", "--silent",
             "--accept-source-agreements",
             "--accept-package-agreements",
             "--id", "Gyan.FFmpeg"],
            capture_output=True, text=True, timeout=600,
            creationflags=0x08000000,
        )
        if proc.returncode == 0:
            return {"ok": True, "stdout": proc.stdout[-2000:]}
        return {
            "ok": False,
            "error": f"winget exited {proc.returncode}",
            "stdout": proc.stdout[-2000:],
            "stderr": proc.stderr[-2000:],
        }
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "winget timed out after 10 minutes"}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


@router.get("/api/auth/settings")
async def get_settings(current_user: dict = Depends(get_current_user)):
    return get_user_settings(current_user["id"])


@router.put("/api/auth/settings")
async def save_settings_endpoint(payload: dict, current_user: dict = Depends(get_current_user)):
    update_user_settings(current_user["id"], payload)
    return get_user_settings(current_user["id"])


# Legacy upstream-service URL store. The setter is a no-op now (those
# values moved into per-addon settings); the getter still exists so the
# in-app admin UI doesn't 404 on existing installs.
@router.get("/api/admin/config")
async def admin_get_config(current_user: dict = Depends(get_admin_user)):
    return get_global_config()


@router.put("/api/admin/config")
async def admin_set_config(payload: dict, current_user: dict = Depends(get_admin_user)):
    set_global_config(payload)
    return {"ok": True}
