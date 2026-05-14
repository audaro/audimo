"""Per-user provider settings.

Native streaming source extractors used to live here (SoundCloud /
YouTube / Bandcamp). They've been removed from core — those providers
are now exclusively handled by the optional ``audimo-streamers`` addon.
What's left is the ListenBrainz scrobbling settings + submit endpoint.
"""
from fastapi import APIRouter, Depends, HTTPException

from auth import get_current_user

router = APIRouter(tags=["streams"])


# ── ListenBrainz ───────────────────────────────────────────────────
#
# Opt-in scrobbling. Empty token = disabled. The token is a personal
# API token from listenbrainz.org/profile — single-user app so we
# don't need OAuth, the user just pastes it once.

@router.get("/api/settings/listenbrainz")
async def get_lb_setting(current_user: dict = Depends(get_current_user)):
    """Return ListenBrainz status. The token itself is never echoed
    back to the client (treat it as a write-only secret) — only an
    `enabled` flag and the resolved username if we have one."""
    from database import get_user_settings
    s = get_user_settings(current_user["id"])
    token = (s.get("listenbrainz_token") or "").strip()
    if not token:
        return {"enabled": False, "username": None}
    from listenbrainz import validate_token
    username = await validate_token(token)
    return {"enabled": bool(username), "username": username}


@router.post("/api/settings/listenbrainz")
async def set_lb_setting(payload: dict, current_user: dict = Depends(get_current_user)):
    """Save (or clear) the ListenBrainz token. Validates the new token
    against ListenBrainz before persisting so we don't store garbage."""
    from database import update_user_settings
    token = (payload.get("token") or "").strip()
    if not token:
        update_user_settings(current_user["id"], {"listenbrainz_token": ""})
        return {"enabled": False, "username": None}
    from listenbrainz import validate_token
    username = await validate_token(token)
    if not username:
        raise HTTPException(400, "Token rejected by ListenBrainz")
    update_user_settings(current_user["id"], {"listenbrainz_token": token})
    return {"enabled": True, "username": username}


# ── AssemblyAI API key ─────────────────────────────────────────
#
# Drives audiobook chapter detection. Stored opaquely in
# user_settings; never echoed back to the client (treat as
# write-only). Validated against AssemblyAI's account endpoint
# before persisting so junk keys don't land in storage.

@router.get("/api/settings/assemblyai")
async def get_assemblyai_setting(current_user: dict = Depends(get_current_user)):
    """Return whether an AssemblyAI key is configured. Doesn't echo
    the key itself."""
    from database import get_user_settings
    s = get_user_settings(current_user["id"])
    token = (s.get("assemblyai_api_key") or "").strip()
    return {"enabled": bool(token)}


@router.post("/api/settings/assemblyai")
async def set_assemblyai_setting(payload: dict, current_user: dict = Depends(get_current_user)):
    """Save (or clear) the AssemblyAI API key. Empty body clears."""
    from database import update_user_settings
    token = (payload.get("token") or "").strip()
    if not token:
        update_user_settings(current_user["id"], {"assemblyai_api_key": ""})
        return {"enabled": False}
    # Validate by calling /v2/transcript with an empty list filter
    # — cheapest authenticated GET that returns 200 on a real key
    # and 401 on a bad one.
    import httpx
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(
                "https://api.assemblyai.com/v2/transcript",
                headers={"Authorization": token},
                params={"limit": "1"},
            )
        if r.status_code == 401:
            raise HTTPException(400, "Token rejected by AssemblyAI")
        if r.status_code != 200:
            raise HTTPException(400, f"AssemblyAI returned {r.status_code}")
    except httpx.HTTPError as e:
        raise HTTPException(400, f"Could not reach AssemblyAI: {e}")
    update_user_settings(current_user["id"], {"assemblyai_api_key": token})
    return {"enabled": True}


# ── Auto-download toggle ───────────────────────────────────────
#
# When on, the Player fires-and-forgets a /api/cache/{key}/download
# call alongside playback so every track lands on disk eventually.
# Persisted per-user; default off so users don't accidentally fill
# disk by sampling music.

@router.get("/api/settings/auto_download")
async def get_auto_download_setting(current_user: dict = Depends(get_current_user)):
    from database import get_user_settings
    s = get_user_settings(current_user["id"])
    return {"enabled": bool(s.get("auto_download"))}


@router.post("/api/settings/auto_download")
async def set_auto_download_setting(payload: dict, current_user: dict = Depends(get_current_user)):
    from database import update_user_settings
    enabled = bool(payload.get("enabled"))
    update_user_settings(current_user["id"], {"auto_download": enabled})
    return {"enabled": enabled}


# LAN trust — when on, any request from a private IP is treated as
# authenticated, no pair token / API key required. Lets the phone on
# the same Wi-Fi skip the pairing dance entirely (the tradeoff is
# any device on that LAN can hit the API too, so it's opt-in).
#
# Stored in ~/.audimo/lan_trust.json (read on every authed request
# in auth.py; deliberately a plain file rather than the user-settings
# DB so the auth path doesn't have to take a DB connection).
def _lan_trust_path():
    from pathlib import Path
    return Path.home() / ".audimo" / "lan_trust.json"


def _read_lan_trust() -> bool:
    import json
    try:
        p = _lan_trust_path()
        if not p.exists():
            return False
        return bool(json.loads(p.read_text()).get("enabled"))
    except Exception:
        return False


def _write_lan_trust(enabled: bool) -> None:
    import json
    p = _lan_trust_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"enabled": bool(enabled)}))
    tmp.replace(p)


@router.get("/api/settings/lan_trust")
async def get_lan_trust(current_user: dict = Depends(get_current_user)):
    return {"enabled": _read_lan_trust()}


@router.post("/api/settings/lan_trust")
async def set_lan_trust(payload: dict, current_user: dict = Depends(get_current_user)):
    enabled = bool(payload.get("enabled"))
    _write_lan_trust(enabled)
    return {"enabled": enabled}


@router.post("/api/listens/submit")
async def submit_listen(payload: dict, current_user: dict = Depends(get_current_user)):
    """Submit a scrobble for the user. Frontend calls this when a
    track has played past the ListenBrainz threshold (>50% or 4 min).

    Reads the user's token from settings — never accepts a token from
    the request body so a compromised client can't impersonate someone
    else's ListenBrainz account.
    """
    from database import get_user_settings
    from listenbrainz import submit_listen as _submit
    s = get_user_settings(current_user["id"])
    token = (s.get("listenbrainz_token") or "").strip()
    if not token:
        return {"submitted": False, "reason": "disabled"}
    title = (payload.get("title") or "").strip()
    artist = (payload.get("artist") or "").strip()
    album = (payload.get("album") or "").strip()
    mbid = (payload.get("mbid") or "").strip()
    listened_at = payload.get("listened_at")
    if not isinstance(listened_at, int):
        listened_at = None
    ok = await _submit(
        token, title, artist,
        album=album, recording_mbid=mbid,
        listened_at=listened_at,
    )
    return {"submitted": ok}
