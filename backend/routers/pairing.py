"""QR pairing — desktop mints a one-shot token bundling its API key
and addon list; mobile redeems it once to seed its localStorage.

Tokens are 256-bit random, single-use, default 5-minute TTL with a
``ttl_seconds`` override (capped at 7 days) for the "save URL for
home-screen icon" flow.

The token store is persisted to ~/.audimo/pair_tokens.json so a
backend restart doesn't invalidate tokens the user already minted
+ pasted into a home-screen bookmark. The file is rewritten on
every mint / redeem / GC pass; under the single-user, low-volume
churn of this surface, that's cheap enough not to need batching.
"""
import json
import secrets
import time
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request

from auth import get_current_user, _expected_api_key, _SINGLE_USER
from database import add_paired_device, list_paired_devices, forget_paired_device

router = APIRouter(tags=["pairing"])

_PAIR_TTL_SECONDS = 300
_PAIR_STORE_PATH = Path.home() / ".audimo" / "pair_tokens.json"


def _load_store() -> dict[str, dict]:
    try:
        if _PAIR_STORE_PATH.exists():
            data = json.loads(_PAIR_STORE_PATH.read_text())
            if isinstance(data, dict):
                # Drop anything already expired at load time so the
                # in-memory dict starts clean.
                now = time.time()
                return {k: v for k, v in data.items()
                        if isinstance(v, dict) and v.get("expires_at", 0) > now}
    except Exception as e:
        # Corrupt file shouldn't break boot; start fresh.
        print(f"[pairing] could not load token store: {e}")
    return {}


def _save_store() -> None:
    try:
        _PAIR_STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
        # Write to a sibling tempfile + rename so a crash mid-write
        # can't leave a half-written JSON file that breaks the next
        # boot.
        tmp = _PAIR_STORE_PATH.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(_pair_store))
        tmp.replace(_PAIR_STORE_PATH)
    except Exception as e:
        # Best-effort: a write failure means the token won't survive
        # a restart, but the in-memory copy still works for the
        # current process lifetime.
        print(f"[pairing] could not persist token store: {e}")


_pair_store: dict[str, dict] = _load_store()

# Rate-limit /api/pair/redeem so an attacker on the same network can't
# brute-force the 256-bit token. A 2**256 search space makes brute
# force infeasible anyway, but the limit also bounds the noise an
# accidental loop (broken QR scanner, polling script) can make.
# Per-IP bucket: max 10 redemptions per 60s window.
_REDEEM_BUCKET_WINDOW_S = 60
_REDEEM_BUCKET_MAX = 10
_redeem_buckets: dict[str, list[float]] = {}


def _pair_gc() -> None:
    now = time.time()
    expired = [t for t, v in _pair_store.items() if v["expires_at"] <= now]
    for t in expired:
        _pair_store.pop(t, None)
    if expired:
        _save_store()
    # Sweep bucket entries older than the window so the dict can't
    # grow unbounded under a stream of unique source IPs.
    cutoff = now - _REDEEM_BUCKET_WINDOW_S
    for ip in list(_redeem_buckets.keys()):
        kept = [t for t in _redeem_buckets[ip] if t > cutoff]
        if kept:
            _redeem_buckets[ip] = kept
        else:
            _redeem_buckets.pop(ip, None)


def _redeem_rate_limit(request: Request) -> None:
    """Raise HTTPException(429) if this peer has redeemed too many
    times in the rolling window. Source IP comes straight from the
    TCP peer — we don't trust X-Forwarded-For because there's no
    trusted proxy in the desktop / LAN deployment model."""
    ip = (request.client.host if request.client else "") or "unknown"
    now = time.time()
    cutoff = now - _REDEEM_BUCKET_WINDOW_S
    bucket = [t for t in _redeem_buckets.get(ip, []) if t > cutoff]
    if len(bucket) >= _REDEEM_BUCKET_MAX:
        raise HTTPException(
            429,
            f"Too many pair-redeem attempts. Wait {_REDEEM_BUCKET_WINDOW_S}s and try again.",
        )
    bucket.append(now)
    _redeem_buckets[ip] = bucket


@router.post("/api/pair/mint")
async def pair_mint(payload: dict, current_user: dict = Depends(get_current_user)):
    """Desktop-only. Returns a one-shot token that mobile can redeem
    to receive the API key + addon list. Caller passes the addon list
    because the backend never persists addons (device-as-client).

    Optional ``ttl_seconds`` overrides the default 5-minute lifetime,
    clamped to [60, 604800] (7 days). The longer TTL is for the
    "save URL for home screen" flow — the user mints once, adds the
    URL to their iPhone home screen, then opens it some time later
    when the standalone PWA boots with empty storage. 5 minutes is
    fine for "show QR and scan it now," 7 days for "bookmark it for
    later first launch."
    """
    api_key = _expected_api_key()
    if not api_key:
        raise HTTPException(400, "Remote access is not enabled")
    addons = payload.get("addons") or []
    if not isinstance(addons, list):
        raise HTTPException(400, "addons must be a list")
    reusable = bool(payload.get("reusable"))
    requested_ttl = payload.get("ttl_seconds")
    if reusable:
        # "Save URL for home screen" tokens: durable, repeatedly
        # redeemable. iOS standalone PWAs wipe storage on certain
        # OS updates / cache evictions; a single-use token leaves
        # the user with a broken icon they have to re-pair. Reusable
        # tokens are revocable from Settings → Connected devices.
        # 100-year TTL is effectively no expiry — easier than a
        # nullable field across the GC code path.
        ttl = 100 * 365 * 24 * 60 * 60
    elif requested_ttl is None:
        ttl = _PAIR_TTL_SECONDS
    else:
        try:
            ttl = int(requested_ttl)
        except (TypeError, ValueError):
            raise HTTPException(400, "ttl_seconds must be an integer")
        ttl = max(60, min(ttl, 7 * 24 * 60 * 60))
    _pair_gc()
    token = secrets.token_urlsafe(32)
    expires_at = time.time() + ttl
    _pair_store[token] = {
        "api_key": api_key,
        "addons": addons,
        "expires_at": expires_at,
        "reusable": reusable,
    }
    _save_store()
    return {
        "token": token,
        "expires_at": int(expires_at),
        "ttl_seconds": ttl,
        "reusable": reusable,
    }


@router.post("/api/pair/redeem")
async def pair_redeem(payload: dict, request: Request):
    """Public. Redeems a token minted by /api/pair/mint.

    Tokens minted with ``reusable=true`` (the home-screen flow) can
    be redeemed any number of times — the bookmark URL keeps working
    across cache evictions and OS resets. Single-use tokens (default,
    used by the QR pair flow) are consumed on first redeem.
    """
    _pair_gc()
    _redeem_rate_limit(request)
    token = (payload.get("token") or "").strip()
    if not token:
        raise HTTPException(400, "token required")
    # Peek before mutating so the reusable branch doesn't lose the
    # record on a transient timing window.
    entry = _pair_store.get(token)
    if not entry:
        raise HTTPException(404, "Invalid or expired token")
    if entry["expires_at"] <= time.time():
        # Don't leave expired single-use records lying around.
        _pair_store.pop(token, None)
        _save_store()
        raise HTTPException(410, "Token expired")
    if not entry.get("reusable"):
        # Single-use: consume now.
        _pair_store.pop(token, None)
    _save_store()
    # Rewrite loopback addon URLs to the hostname the phone used to
    # reach us. Desktop registered addons as http://localhost:<port>/...
    # which means "the phone" on the phone — useless. The redeem request
    # carries the actual hostname the phone resolves us at.
    client_host = (request.url.hostname or "").lower()
    rewrite = client_host and client_host not in {"localhost", "127.0.0.1", "::1"}
    addons_out = entry["addons"]
    if rewrite and isinstance(addons_out, list):
        from urllib.parse import urlsplit, urlunsplit
        rewritten = []
        for a in addons_out:
            if not isinstance(a, dict):
                rewritten.append(a)
                continue
            a = dict(a)
            url = a.get("url")
            if isinstance(url, str):
                try:
                    parts = urlsplit(url)
                    if parts.hostname and parts.hostname.lower() in {"localhost", "127.0.0.1", "::1"}:
                        netloc = client_host if not parts.port else f"{client_host}:{parts.port}"
                        a["url"] = urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))
                except Exception:
                    pass
            rewritten.append(a)
        addons_out = rewritten
    # Record the device for the Settings → Connected devices list.
    # Best-effort UA sniffing for the label — most phones identify
    # as iPhone / iPad / Android, falling back to "Device".
    try:
        ua = (request.headers.get("user-agent") or "").strip()
        label = "Device"
        ua_lower = ua.lower()
        if "iphone" in ua_lower:      label = "iPhone"
        elif "ipad" in ua_lower:      label = "iPad"
        elif "android" in ua_lower:   label = "Android"
        elif "macintosh" in ua_lower: label = "Mac"
        elif "windows" in ua_lower:   label = "Windows"
        add_paired_device(_SINGLE_USER["id"], label, ua)
    except Exception as e:
        print(f"[pair.redeem] device record failed: {e}")
    return {
        "api_key": entry["api_key"],
        "addons": addons_out,
        "reusable": bool(entry.get("reusable")),
    }


@router.get("/api/devices")
async def list_devices(current_user: dict = Depends(get_current_user)):
    """List devices that have paired with this Audimo install. The
    backend doesn't track per-device sessions (every device shares the
    same API key) — this is purely a visibility surface. Use
    POST /api/auth/regenerate-key to invalidate every device at once."""
    return {"devices": list_paired_devices(current_user["id"])}


@router.delete("/api/devices/{device_id}")
async def forget_device(device_id: int, current_user: dict = Depends(get_current_user)):
    """Forget a device from the visibility list. Doesn't actually
    revoke its access — the device still has the API key. Use
    /api/auth/regenerate-key for a real revoke."""
    ok = forget_paired_device(current_user["id"], device_id)
    if not ok:
        raise HTTPException(404, "device not found")
    return {"ok": True}
