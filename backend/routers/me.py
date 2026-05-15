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
    }


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
