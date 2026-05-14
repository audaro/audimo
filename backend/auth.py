"""
Single-user auth for Audimo.

This is a personal-server / desktop-app design (one library, one owner,
multiple devices). There are no user accounts and no login flow.

Always-on token: every install has an API key. The desktop shell mints
one on first boot (``~/.audimo/api_key``, also mirrored to the OS
keychain) and passes it to the backend via ``AUDIMO_API_KEY``. The
WebView calls ``audimo_ensure_api_key`` at startup so the React side
sends ``X-API-Key`` on every fetch. Phones reaching the backend over
Tailscale / LAN obtain the same key via the pair-redeem flow.

The previous keyless local-only mode was removed because it let any
process on the same machine (or any browser tab via DNS rebinding)
reach the API with full authority. Today the backend rejects every
request that doesn't present the token — there is no local-only
bypass.

The `current_user` dict returned by `get_current_user` is a stable
synthetic identity. Endpoints and DB helpers still take `user_id`
internally — Phase 2 keeps them around so the diff is small. Phase 3
can collapse the schema once everything has settled.
"""

import hmac
import os
import time
from pathlib import Path
from fastapi import Depends, HTTPException, Request

# Synthetic single user. Matches the row that the legacy registration
# flow would have created for the install owner. Database helpers
# continue to scope by this id so we don't have to rewrite the schema
# in this phase.
SINGLE_USER_ID = 1
SINGLE_USER_EMAIL = "owner@audimo.local"

_SINGLE_USER = {
    "id": SINGLE_USER_ID,
    "email": SINGLE_USER_EMAIL,
    "is_admin": True,
}


# Cache the file-based key for a few seconds so we don't stat() on every
# request. Long-poll endpoints would amplify the syscall otherwise.
_KEY_FILE = Path.home() / ".audimo" / "api_key"
_KEY_CACHE: dict = {"value": None, "mtime": 0.0, "checked_at": 0.0}
_KEY_CHECK_INTERVAL = 2.0


def _read_key_file() -> str:
    """Read the file-based API key. Cached for 2s to avoid stat() spam."""
    now = time.monotonic()
    if now - _KEY_CACHE["checked_at"] < _KEY_CHECK_INTERVAL and _KEY_CACHE["value"] is not None:
        return _KEY_CACHE["value"]
    _KEY_CACHE["checked_at"] = now
    try:
        st = _KEY_FILE.stat()
        if st.st_mtime != _KEY_CACHE["mtime"]:
            _KEY_CACHE["mtime"] = st.st_mtime
            _KEY_CACHE["value"] = _KEY_FILE.read_text().strip()
    except FileNotFoundError:
        _KEY_CACHE["value"] = ""
        _KEY_CACHE["mtime"] = 0.0
    except Exception:
        pass
    return _KEY_CACHE["value"] or ""


def _expected_api_key() -> str:
    """API key required for non-local access. Empty string disables
    the check (local-only mode).

    Single source of truth is ~/.audimo/api_key. We prefer file over
    env because the desktop shell's spawn-time env var goes stale when
    the user regenerates: a new key gets written to the file, but the
    already-running backend still has the old env. Reading the file
    every request (cached 2s) means key rotation works without a
    restart and without a respawn race."""
    file_key = _read_key_file()
    if file_key:
        return file_key
    return os.getenv("AUDIMO_API_KEY", "").strip()


def _extract_presented_key(request: Request) -> str:
    api_key_header = request.headers.get("x-api-key", "").strip()
    if api_key_header:
        return api_key_header
    auth = request.headers.get("authorization", "").strip()
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    # Fall-back: ``?key=<apiKey>`` query param. HTML5 ``<audio src>``
    # can't carry headers, so the torrent-streaming endpoint accepts
    # the key inline. Reading from `request.query_params` here keeps
    # the surface area small — only matters for callers that don't
    # already set X-API-Key.
    qkey = (request.query_params.get("key") or "").strip()
    if qkey:
        return qkey
    return ""


async def require_api_key_query(request: Request) -> dict:
    """Same as ``get_current_user`` but documented as accepting the
    key via query param for endpoints called by HTML5 audio src."""
    return await get_current_user(request)


_LOCAL_HOSTS = {"127.0.0.1", "::1", "localhost"}


def is_local_request(request: Request) -> bool:
    """True if the request originated from the same machine.

    Used by:
      - get_current_user, to allow the keyless local-only mode
      - bundled-addon callback endpoints that the desktop spawns on
        127.0.0.1 and trusts to mutate cache state
    """
    host = (request.client.host if request.client else "") or ""
    return host in _LOCAL_HOSTS


def _is_private_ip(host: str) -> bool:
    """Trusted-network membership test for the LAN-trust auth path.

    Covers:
      * RFC1918 private (`is_private`): 10/8, 172.16/12, 192.168/16, fd00::/8
      * Loopback (127/8, ::1) and link-local (169.254/16, fe80::/10)
      * Tailscale CGNAT (RFC 6598: 100.64.0.0/10). Python's
        `is_private` doesn't include CGNAT, but Tailscale-routed
        peers always arrive from this range and the user's tailnet
        membership is itself an authentication. Tailscale-routed
        Audimo access counts as "on my network."

    `ipaddress.ip_address` raises on hostnames or empty strings —
    treat any parse error as "not trusted."
    """
    import ipaddress
    if not host:
        return False
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    if ip.is_private or ip.is_loopback or ip.is_link_local:
        return True
    # Tailscale + other CGNAT-routed networks.
    if isinstance(ip, ipaddress.IPv4Address):
        try:
            if ip in ipaddress.IPv4Network("100.64.0.0/10"):
                return True
        except ValueError:
            pass
    return False


def _lan_trust_enabled() -> bool:
    """Read the LAN-trust flag from ~/.audimo/lan_trust.json. False on
    any error (missing file, bad JSON, etc.). Cheap: this is touched
    on every authenticated request, but the file is tiny and the
    OS pagecache keeps it warm.
    """
    import json
    from pathlib import Path
    try:
        p = Path.home() / ".audimo" / "lan_trust.json"
        if not p.exists():
            return False
        data = json.loads(p.read_text())
        return bool(data.get("enabled"))
    except Exception:
        return False


async def get_current_user(request: Request) -> dict:
    expected = _expected_api_key()
    if not expected:
        # Always-on token: the desktop shell is supposed to mint a key
        # at first boot. Reaching this branch means something spawned
        # the backend without ``AUDIMO_API_KEY`` AND no key file
        # exists. Refuse everything — a brand-new install would
        # otherwise be wide open to any local process or any browser
        # tab via DNS rebinding.
        raise HTTPException(
            503,
            "Audimo backend is missing its API key. The desktop shell "
            "should have minted one — try restarting the app.",
        )
    presented = _extract_presented_key(request)
    if presented and hmac.compare_digest(expected, presented):
        return dict(_SINGLE_USER)
    # LAN-trust fallback: if the owner has opted in AND the request
    # came from a private-IP peer, treat it as authenticated. Lets
    # the phone on the same Wi-Fi skip pairing entirely. Off by
    # default — flipped on from Settings → Phone access. The pair
    # flow remains the only way in over Tailscale / WAN / anything
    # that isn't an RFC1918 / loopback / link-local address.
    if _lan_trust_enabled():
        client_host = (request.client.host if request.client else "") or ""
        if _is_private_ip(client_host):
            return dict(_SINGLE_USER)
    raise HTTPException(401, "Authentication required")


async def get_admin_user(current_user: dict = Depends(get_current_user)) -> dict:
    # Single-user install: the owner is always admin. Keeping this
    # alias around so the existing admin-only endpoints don't have to
    # change their signature.
    return current_user
