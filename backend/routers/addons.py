"""Addon registry endpoints.

Install / list / toggle / remove and per-addon settings. Addon URLs and
manifests live server-side as a back-compat shim for the
device-as-client migration; new flows read addons from the browser's
localStorage registry directly.

Cache-invalidation hooks (purge library entries when an addon is
removed/disabled) live in main.py because they need access to the
process-wide stream cache. They're imported lazily so this router can
be loaded before that state has been initialized.
"""
import base64
import json
import re
import time
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request

from auth import get_current_user
from database import (
    get_addons, save_addon, delete_addon, set_addon_enabled,
    get_addon_settings, save_addon_settings,
)
from safe_fetch import validate_url

router = APIRouter(tags=["addons"])


# ── SSRF defense for the manifest fetch ──────────────────────────
#
# Shared with every other server-side URL fetch via ``backend.safe_fetch``.
# Manifest URLs additionally have a 2 KB length cap and must end in a
# server-reachable base path — those checks stay local.


def _validated_addon_base(url: str) -> tuple[str, str, int, list[str]]:
    """Parse + validate an addon base URL. Returns
    ``(url, host, port, safe_ips)``. Allows loopback so users can
    install local addon sidecars in desktop mode."""
    return validate_url(url, max_len=2048)


async def _fetch_manifest(url: str) -> dict:
    """Fetch /manifest.json from a validated addon URL with the
    connection pinned to a pre-resolved safe IP (DNS-rebinding-proof).
    Errors raised here MUST NOT echo the user-supplied URL — addon
    URLs carry path-segment secrets and we don't want them in error
    bodies that flow back to the client."""
    base_url, host, port, safe_ips = _validated_addon_base(url)
    parts = urlsplit(base_url)
    last_err: Exception | None = None
    # Try each pre-cleared IP in turn. We don't fall back to DNS — if
    # the cleared list doesn't yield a connection, it's a hard fail.
    for safe_ip in safe_ips:
        # Bracket IPv6 literals so the URL parser doesn't mistake the
        # colons for port separators.
        ip_in_url = f"[{safe_ip}]" if ":" in safe_ip else safe_ip
        pinned_url = f"{parts.scheme}://{ip_in_url}:{port}{parts.path}/manifest.json"
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(connect=3.0, read=8.0, write=3.0, pool=3.0),
                follow_redirects=False,
                headers={"Host": host} if host else {},
            ) as client:
                r = await client.get(pinned_url)
                r.raise_for_status()
                return r.json()
        except Exception as e:
            last_err = e
            continue
    # Deliberately do not surface the URL or upstream error message —
    # both can leak the user's secret path segment.
    raise HTTPException(502, "Could not fetch addon manifest")


@router.get("/api/addons")
async def list_addons(current_user: dict = Depends(get_current_user)):
    return {"addons": get_addons(current_user["id"])}


@router.get("/api/addons/_export_for_device")
async def export_addons_for_device(
    request: Request,
    current_user: dict = Depends(get_current_user),
):
    """One-shot migration endpoint for the device-as-client cutover.

    The frontend's localStorage-backed addon registry calls this exactly
    once on first load post-upgrade (when its registry is empty AND the
    server still has rows). The returned shape matches what the registry
    expects so it can `replaceAll(rows)` and never hit any other addon
    endpoint after that.

    Sensitive: returns URLs that contain the user's secrets path
    segment, plus their decrypted addon_settings. Auth-gated.

    Host rewriting: the bundled addon is registered with
    `http://localhost:<port>/...` because the desktop installs it
    against itself. When a phone hits this endpoint over Tailscale or
    LAN, "localhost" on the phone means the phone — useless. Rewrite
    loopback hostnames to whatever the client used to reach the
    backend, so the addon URL is reachable from the same device.
    """
    rows = get_addons(current_user["id"])
    now_ms = int(time.time() * 1000)

    client_host = (request.url.hostname or "").lower()
    rewrite = client_host and client_host not in {"localhost", "127.0.0.1", "::1"}

    out = []
    for r in rows:
        url = r["url"]
        if rewrite and isinstance(url, str):
            try:
                from urllib.parse import urlsplit, urlunsplit
                parts = urlsplit(url)
                if parts.hostname and parts.hostname.lower() in {"localhost", "127.0.0.1", "::1"}:
                    new_netloc = client_host
                    if parts.port:
                        new_netloc = f"{client_host}:{parts.port}"
                    url = urlunsplit((parts.scheme, new_netloc, parts.path, parts.query, parts.fragment))
            except Exception:
                pass
        manifest = {k: v for k, v in r.items() if k not in {"id", "url", "enabled", "settings"}}
        out.append({
            "id":          r["id"],
            "url":         url,
            "manifest":    manifest,
            "enabled":     bool(r.get("enabled", True)),
            "settings":    r.get("settings") or {},
            "installedAt": now_ms,
            "updatedAt":   now_ms,
        })
    return {"addons": out}


@router.post("/api/addons")
async def install_addon(payload: dict, current_user: dict = Depends(get_current_user)):
    url = (payload.get("url") or "").strip()
    if not url:
        raise HTTPException(400, "url required")
    # Tolerate users pasting the full manifest URL — the addon's /configure
    # page generates `…/{cfg}/manifest.json`, and copy/paste habit dies hard.
    if url.endswith("/manifest.json"):
        url = url[: -len("/manifest.json")]
    url = url.rstrip("/")
    manifest = await _fetch_manifest(url)
    addon_id = manifest.get("id")
    if not addon_id:
        raise HTTPException(400, "Manifest missing 'id'")
    # Restrict to a-z, 0-9, dash, underscore, dot — same allowlist the
    # Rust catalog installer applies as `safe_id` in
    # frontend/src-tauri/src/addon_sidecars.rs:268. Without this an
    # adversarial manifest could return ``"id": "../../etc/passwd"``
    # which would then flow into URL construction and on-disk lookups.
    if not isinstance(addon_id, str) or not re.fullmatch(r"[a-zA-Z0-9._-]{1,64}", addon_id):
        raise HTTPException(400, "Manifest 'id' must be 1-64 chars of [a-zA-Z0-9._-]")
    # Stremio-style install URL with a path-segmented config blob:
    # split secrets (kept in URL) from non-secret toggles (DB).
    parsed, base_url = _parse_install_config_segment(url)
    secret_keys = _manifest_secret_keys(manifest)
    secrets: dict = {}
    non_secrets: dict = {}
    if parsed:
        for k, v in parsed.items():
            (secrets if k in secret_keys else non_secrets)[k] = v
    final_url = _reattach_secret_segment(base_url, secrets) if secrets else base_url
    save_addon(current_user["id"], addon_id, final_url, manifest)
    save_addon_settings(current_user["id"], addon_id, non_secrets)
    return {"ok": True, "id": addon_id, "name": manifest.get("name", addon_id)}


def _manifest_secret_keys(manifest: dict) -> set[str]:
    """Walk a manifest's (possibly sectioned) settings_schema and return
    the set of keys whose fields are secrets. A field is secret if it
    has ``"secret": true`` OR ``type: "password"`` — the latter covers
    older addons that haven't adopted the explicit flag."""
    out: set[str] = set()
    def _walk(items):
        if not isinstance(items, list):
            return
        for f in items:
            if not isinstance(f, dict):
                continue
            if f.get("type") == "section":
                _walk(f.get("fields") or [])
                continue
            key = f.get("key")
            if not key:
                continue
            if f.get("secret") is True or f.get("type") == "password":
                out.add(str(key))
    _walk(manifest.get("settings_schema") or [])
    return out


def _reattach_secret_segment(base_url: str, secrets: dict) -> str:
    raw = json.dumps(secrets, separators=(",", ":"), sort_keys=True).encode("utf-8")
    seg = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    return f"{base_url.rstrip('/')}/{seg}"


def _parse_install_config_segment(url: str) -> tuple[dict | None, str]:
    """If `url`'s last path segment is base64url(JSON), return (parsed,
    url-without-segment). Otherwise return (None, url) untouched."""
    try:
        u = httpx.URL(url)
        path = u.path.strip("/")
    except Exception:
        return None, url
    if not path:
        return None, url
    parts = path.split("/")
    last = parts[-1]
    if len(last) < 4 or not re.match(r"^[A-Za-z0-9_-]+$", last):
        return None, url
    try:
        pad = "=" * (-len(last) % 4)
        decoded = base64.urlsafe_b64decode(last + pad).decode("utf-8")
        obj = json.loads(decoded)
    except Exception:
        return None, url
    if not isinstance(obj, dict):
        return None, url
    new_path = "/" + "/".join(parts[:-1]) if len(parts) > 1 else ""
    base = f"{u.scheme}://{u.host}"
    if u.port and not (
        (u.scheme == "https" and u.port == 443)
        or (u.scheme == "http" and u.port == 80)
    ):
        base += f":{u.port}"
    return obj, base + new_path


def _purge_via_main(user_id: int, addon_id: str) -> int:
    """Defer to main.py's stream-cache-aware purge. Late-import to
    avoid a circular dependency at module load time."""
    from main import _purge_addon_library
    return _purge_addon_library(user_id, addon_id)


def _addon_library_count_via_main(user_id: int, addon_id: str) -> int:
    from main import _addon_library_count
    return _addon_library_count(user_id, addon_id)


@router.get("/api/addons/{addon_id}/library_count")
async def addon_library_count(addon_id: str, current_user: dict = Depends(get_current_user)):
    """How many library entries this addon has produced for the current user.
    Used by the disable/remove confirmation dialog so the user knows the blast
    radius before they wipe."""
    return {"count": _addon_library_count_via_main(current_user["id"], addon_id)}


@router.delete("/api/addons/{addon_id}")
async def remove_addon(addon_id: str, current_user: dict = Depends(get_current_user)):
    purged = _purge_via_main(current_user["id"], addon_id)
    delete_addon(current_user["id"], addon_id)
    return {"ok": True, "library_purged": purged}


@router.post("/api/addons/{addon_id}/toggle")
async def toggle_addon(addon_id: str, payload: dict, current_user: dict = Depends(get_current_user)):
    enabled = bool(payload.get("enabled", True))
    set_addon_enabled(current_user["id"], addon_id, enabled)
    # Disabling means nothing can resolve this addon's library entries any
    # more — purge them so the user doesn't see broken rows in My Music.
    purged = 0 if enabled else _purge_via_main(current_user["id"], addon_id)
    return {"ok": True, "library_purged": purged}


@router.get("/api/addons/{addon_id}/settings")
async def get_addon_settings_endpoint(addon_id: str, current_user: dict = Depends(get_current_user)):
    """Return this user's saved settings for the addon (an opaque JSON
    blob matching the addon's ``settings_schema``). Returns ``{}`` if unset."""
    return {"settings": get_addon_settings(current_user["id"], addon_id)}


@router.put("/api/addons/{addon_id}/settings")
async def put_addon_settings(addon_id: str, payload: dict, current_user: dict = Depends(get_current_user)):
    """Persist this user's settings for an addon. Secrets (per the
    manifest's settings_schema) are stripped here as defense-in-depth:
    the in-app panel doesn't render them as inputs, but a stale or
    hostile client could still POST them. Secrets only live in the
    install URL — this endpoint refuses to write them to the DB."""
    addons = get_addons(current_user["id"])
    addon = next((a for a in addons if a.get("id") == addon_id), None)
    if not addon:
        raise HTTPException(404, "Addon not installed")
    secret_keys = _manifest_secret_keys(addon)
    incoming = payload or {}
    cleaned = {k: v for k, v in incoming.items() if k not in secret_keys}
    save_addon_settings(current_user["id"], addon_id, cleaned)
    return {"ok": True}
