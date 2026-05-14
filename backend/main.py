from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import httpx
import os
import re
import json
from pathlib import Path
from dotenv import load_dotenv
import asyncio

from database import (
    init_db,
    save_cache_entry,
    delete_cache_entries_by_addon_id,
)
from cache_state import (
    _stream_cache, _user_caches,
    load_cache, save_cache,
    get_user_cache as _get_user_cache,
    _cache_lock,
)
from file_store import (
    MEDIA_ROOT, AUDIOBOOK_STORE,
    safe_under_roots as _safe_under_roots,
    file_serve_safe_roots as _file_serve_safe_roots,
    migrate_legacy_storage_paths,
    migrate_tunnel_to_audimo,
    backfill_audiobook_local_files,
)

# Run the Tunnel→Audimo rebrand migration FIRST, before any other code
# touches ~/.audimo/ (it might not exist yet — the migration creates
# it by renaming ~/.tunnel/ if present). Gated by the migrations
# ledger so it only fires once per install. The function itself is
# idempotent — the ledger is purely a perf + log-noise win.
from migrations import run_once as _migrate_once
_migrate_once("tunnel_to_audimo", migrate_tunnel_to_audimo)

# ── Stream cache (persisted to disk) ──────────────────────────
# Each entry persists enough metadata to re-resolve a fresh playable
# URL on the next play. Entries produced by an addon carry an
# ``addon_id`` and an opaque payload; core never inspects the inside
# of that payload — it just hands it back to the originating addon's
# ``cache.resolve`` capability when the user clicks play. Local-only
# entries (uploads) carry a ``local_file`` path and serve directly
# off disk via the generic /api/files/local endpoint.
#
# Entry format (minimum fields):
#   {
#     "type": "addon" | "upload",
#     "addon_id": "<addon-id>",   # for addon-produced entries
#     "filename": "track.mp3",
#     "mimeType": "audio/mpeg",
#     "albumCover": "https://...",
#     "track_title": "...",
#     "track_artist": "...",
#     "track_album": "...",
#     "source": "<addon's display label>",
#     # plus any addon-specific fields the addon needs for resolve.
#   }

# Cache state (`_stream_cache`, `_user_caches`, `set_cached`,
# `get_user_cache`, `_cache_key`, `load_cache`, `save_cache`) lives in
# `cache_state` — imported above. The original definitions used to sit
# here.


async def resolve_cached(
    entry: dict,
    title: str = "",
    user_id: int | None = None,
) -> dict | None:
    """
    Resolve a non-addon cache entry to a fresh playable stream URL.

    Addon-produced entries (anything with ``addon_id``) are NOT handled
    here — ``cache_resolve`` short-circuits those into a delegate
    envelope that the browser orchestrator unpacks against the addon
    directly. The only native-app source type left here is ``upload``
    (a user-uploaded local file served from disk).
    """
    if entry.get("type") == "upload":
        # User-uploaded file — serve directly from disk via the
        # generic local-files endpoint.
        import os, urllib.parse
        local_file = entry.get("local_file", "")
        if local_file and os.path.exists(local_file):
            encoded = urllib.parse.quote(local_file, safe="")
            stream_url = f"http://localhost:8000/api/files/local?path={encoded}"
            return {
                "streamUrl": stream_url,
                "filename": entry.get("filename", ""),
                "filesize": os.path.getsize(local_file),
                "mimeType": entry.get("mimeType", "audio/mpeg"),
                "source": entry.get("source", "Upload"),
                "seeders": 0,
                "albumCover": entry.get("albumCover"),
            }
        return None

    return None

load_cache()

load_dotenv()

init_db()


def _backfill_audiobook_category() -> None:
    """One-shot migration: any cache entry whose (artist, title) matches
    a row in `audiobook_library` gets tagged ``category='audiobook'`` if
    it isn't already. This lets the AudiobooksView filter
    ``/api/cache/list`` for category='audiobook' instead of running its
    own auth-gated fetch (which the frontend keeps losing the boot race
    against — see related apiKey-seeding fixes).
    """
    from database import (
        load_user_cache as _load_user_cache,
        save_cache_entry as _save_cache_entry,
        get_audiobook_library as _get_audiobook_library,
    )
    import sqlite3 as _sqlite3
    DB_PATH = Path.home() / ".audimo" / "audimo.db"
    if not DB_PATH.exists():
        return
    try:
        with _sqlite3.connect(DB_PATH) as conn:
            user_ids = [r[0] for r in conn.execute("SELECT id FROM users")]
    except Exception as e:
        print(f"[backfill] could not list users: {e}")
        return
    total = 0
    for uid in user_ids:
        try:
            ab = _get_audiobook_library(uid)
        except Exception:
            ab = []
        if not ab:
            continue
        wanted = {
            (b.get("title", "").lower().strip(),
             b.get("author", "").lower().strip())
            for b in ab if b.get("title")
        }
        cache = _load_user_cache(uid)
        for key, entry in cache.items():
            if not isinstance(entry, dict):
                continue
            if entry.get("category") == "audiobook":
                continue
            ident = (
                (entry.get("track_title", "") or "").lower().strip(),
                (entry.get("track_artist", "") or "").lower().strip(),
            )
            if ident in wanted:
                entry["category"] = "audiobook"
                _save_cache_entry(uid, key, entry)
                # Mirror to the global on-disk cache so /api/cache/list
                # (which reads _stream_cache) reflects the tag without a
                # restart.
                if key in _stream_cache:
                    _stream_cache[key]["category"] = "audiobook"
                total += 1
    if total:
        save_cache()
        print(f"[backfill] tagged {total} cache rows as category=audiobook")


_migrate_once("audiobook_category_backfill", _backfill_audiobook_category)

# `/docs`, `/redoc`, and `/openapi.json` fingerprint the entire route
# surface and shouldn't be reachable from the open internet on a
# remote-accessible install. They're also a separate problem when the
# OpenAPI schema generator crashes — the broken Swagger UI loads a 500
# from the same path, but we never see it. Gate behind AUDIMO_DEBUG.
_DEBUG = str(os.environ.get("AUDIMO_DEBUG", "")).lower() in {"1", "true", "yes"}
app = FastAPI(
    title="Audimo Music API",
    docs_url="/docs" if _DEBUG else None,
    redoc_url="/redoc" if _DEBUG else None,
    openapi_url="/openapi.json" if _DEBUG else None,
)

# Routers — extracted slices of the API surface. Each router file owns
# a self-contained chunk (playlists CRUD, addon CRUD, pairing flow);
# main.py keeps the routes that are entangled with the in-process
# stream cache + file-serving helpers.
from routers import addons as _addons_router
from routers import audiobooks as _audiobooks_router
from routers import cache as _cache_router
from routers import files as _files_router
from routers import history as _history_router
from routers import library as _library_router
from routers import me as _me_router
from routers import pairing as _pairing_router
from routers import playlists as _playlists_router
from routers import podcasts as _podcasts_router
from routers import search as _search_router
from routers import streams as _streams_router
from routers import torrent_stream as _torrent_stream_router
app.include_router(_addons_router.router)
app.include_router(_audiobooks_router.router)
app.include_router(_cache_router.router)
app.include_router(_files_router.router)
app.include_router(_history_router.router)
app.include_router(_library_router.router)
app.include_router(_me_router.router)
app.include_router(_pairing_router.router)
app.include_router(_playlists_router.router)
app.include_router(_podcasts_router.router)
app.include_router(_search_router.router)
app.include_router(_streams_router.router)
app.include_router(_torrent_stream_router.router)

# Track background tasks so we can cancel them on shutdown
_background_tasks: set[asyncio.Task] = set()


def create_background_task(coro):
    """Create a tracked background task that gets cancelled on shutdown."""
    task = asyncio.create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return task


# ── Crash tripwire ──────────────────────────────────────────────
#
# Write ``~/.audimo/last-boot.json`` with ``clean_exit=false`` on
# startup; flip to ``true`` in the shutdown hook. Next startup,
# if we observed a stale ``clean_exit=false``, the previous session
# crashed (or was force-killed) — surface to the user via
# ``/api/me/boot-status`` so the frontend can offer "copy log to
# clipboard" once per crash.
#
# Zero telemetry: this state lives entirely on the user's machine.
# We never report a crash anywhere automatically.

_BOOT_STATUS_PATH = Path.home() / ".audimo" / "last-boot.json"
_PREVIOUS_BOOT_CRASHED = False


def _read_boot_status() -> dict | None:
    try:
        return json.loads(_BOOT_STATUS_PATH.read_text())
    except FileNotFoundError:
        return None
    except Exception:
        return None


def _write_boot_status(payload: dict) -> None:
    try:
        _BOOT_STATUS_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = _BOOT_STATUS_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, indent=2))
        os.replace(tmp, _BOOT_STATUS_PATH)
    except Exception as e:
        print(f"[boot] could not write last-boot.json: {e}", flush=True)


_prev = _read_boot_status()
if _prev and _prev.get("clean_exit") is False:
    _PREVIOUS_BOOT_CRASHED = True
    print(
        f"[boot] previous session at {_prev.get('started_at')} did not exit cleanly — "
        f"crash tripwire flagged",
        flush=True,
    )

_write_boot_status({
    "started_at": int(__import__("time").time()),
    "clean_exit": False,
    "previous_crashed": _PREVIOUS_BOOT_CRASHED,
})


def consume_crash_flag() -> bool:
    """Return True ONCE if the previous boot crashed. Subsequent
    reads return False so the frontend's "want to copy the log?"
    prompt doesn't re-fire on every refresh."""
    global _PREVIOUS_BOOT_CRASHED
    if not _PREVIOUS_BOOT_CRASHED:
        return False
    _PREVIOUS_BOOT_CRASHED = False
    return True


@app.on_event("shutdown")
async def shutdown_event():
    """Cancel all background tasks on server shutdown."""
    print(f"[Server] Cancelling {len(_background_tasks)} background task(s)…")
    for task in list(_background_tasks):
        task.cancel()
    if _background_tasks:
        await asyncio.gather(*_background_tasks, return_exceptions=True)
    # Mark this session as clean-exit so the next boot doesn't fire
    # the crash tripwire. A real crash (segfault, OOM, kill -9)
    # never reaches this hook; that's exactly what we want.
    import time as _t
    _write_boot_status({
        "started_at": int(_t.time()),
        "clean_exit": True,
    })
    print("[Server] All background tasks cancelled")


# ── DNS-rebinding defense ────────────────────────────────────────
#
# Token-always auth (auth.py) means every request needs ``X-API-Key``,
# so a rebound browser tab without the token already fails at the auth
# gate. This middleware is belt-and-suspenders: reject any request
# whose ``Host:`` header isn't one we expect, BEFORE the auth check
# even runs. Stops attacker pages on ``http://anything.localhost.evil.com``
# (DNS A → 127.0.0.1) from probing the backend at all.
#
# Policy:
#   * Loopback (localhost / 127.0.0.1 / [::1]) always allowed.
#   * Remote mode (``AUDIMO_BACKEND_HOST=0.0.0.0``) also allows:
#       - any RFC-1918 / loopback IP literal (user's own LAN)
#       - hostnames ending in .local / .lan / .home / .ts.net
#         (mDNS-style + Tailscale MagicDNS)
#       - anything in ``AUDIMO_TRUSTED_HOSTS`` (comma-sep, e.g. for a
#         hosted deployment with a real domain).

_BIND_HOST = (os.environ.get("AUDIMO_BACKEND_HOST") or "127.0.0.1").strip()
_REMOTE_MODE = _BIND_HOST == "0.0.0.0"
_TRUSTED_HOSTS_ENV = {
    h.strip().lower()
    for h in (os.environ.get("AUDIMO_TRUSTED_HOSTS") or "").split(",")
    if h.strip()
}
_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
_REMOTE_HOST_RE = re.compile(
    r"^([\w-]+\.)*(local|lan|home)$|^([\w-]+\.)*ts\.net$|"
    r"^tail[\w-]+\.ts\.net$",
    re.IGNORECASE,
)


def _strip_host_port(host_header: str) -> str:
    h = (host_header or "").strip()
    if h.startswith("["):
        idx = h.find("]")
        return h[1:idx].lower() if idx > 0 else h.lower()
    if ":" in h:
        return h.split(":", 1)[0].lower()
    return h.lower()


def _host_allowed(host_header: str) -> bool:
    h = _strip_host_port(host_header)
    if not h:
        return False
    if h in _LOOPBACK_HOSTS:
        return True
    if h in _TRUSTED_HOSTS_ENV:
        return True
    if not _REMOTE_MODE:
        return False
    # Remote mode: accept LAN/Tailscale-shaped hostnames + private IPs.
    # 100.64.0.0/10 is CGNAT (Tailscale's address space); Python's
    # ``is_private`` doesn't include it, so we cover it explicitly.
    try:
        import ipaddress
        ip = ipaddress.ip_address(h)
        if ip.is_private or ip.is_loopback:
            return True
        if isinstance(ip, ipaddress.IPv4Address) and ip in ipaddress.IPv4Network("100.64.0.0/10"):
            return True
    except ValueError:
        pass
    return bool(_REMOTE_HOST_RE.match(h))


@app.middleware("http")
async def _host_allowlist(request, call_next):
    if not _host_allowed(request.headers.get("host", "")):
        from fastapi.responses import JSONResponse
        return JSONResponse(
            {"detail": "Host not allowed"},
            status_code=421,  # Misdirected Request — semantically correct
        )
    return await call_next(request)


app.add_middleware(
    CORSMiddleware,
    # Allowed origins:
    #   • http://localhost[:port], http://127.0.0.1[:port]   — Vite dev,
    #     phone over LAN reaching the desktop, generic browser.
    #   • http://tauri.localhost                              — Tauri 2
    #     Windows/Linux WebView2 / WebKitGTK custom scheme.
    #   • tauri://localhost, tauri://<anything>.localhost     — Tauri 2
    #     macOS WKWebView default scheme. The custom subdomain form
    #     started appearing in Tauri 2.x and the original regex didn't
    #     catch it, breaking every fetch to the backend after a Tauri
    #     update or `--features devtools` rebuild.
    #   • app://localhost, app://<anything>.localhost         — fallback
    #     for builds that opt into the alternative scheme.
    #   • https://<lan/.local/.home/.ts.net> hosts             — covers
    #     LAN access from a phone or reverse-proxied access via
    #     Tailscale.
    #
    # `allow_credentials=False`: the API uses bearer/api-key headers,
    # never cookies. With credentials off, the subdomain-wildcard
    # regex below isn't a credential-exfil vector — auth-bearing
    # responses are gated by the explicit Authorization / X-API-Key
    # header which CORS doesn't auto-attach.
    allow_origin_regex=(
        r"^(https?://(localhost|127\.0\.0\.1|\[::1\]|tauri\.localhost)(:\d+)?"
        r"|(tauri|app)://([\w-]+\.)?localhost"
        r"|https?://([\w-]+\.)?(local|lan|home|tail[\w-]+\.ts\.net))$"
    ),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

DZ_BASE = "https://api.deezer.com"




# Audiobook library CRUD + per-entry stream endpoint live in
# `routers/audiobooks`. Audiobook search runs in the browser via
# `orchestrator.searchBooks`.

# One-shot moves of files from the old hidden ``~/.audimo`` locations
# into the new user-visible media folders. Both functions check
# whether work is needed and no-op when not; the migrations ledger
# stops them from re-running every boot.
_migrate_once("legacy_storage_paths", migrate_legacy_storage_paths)
_migrate_once("audiobook_local_file_backfill", backfill_audiobook_local_files)


# Device-as-client: the backend has no addon-traffic path of its own.
# `cache_resolve` returns a `delegate_addon` envelope (see below) so
# the frontend orchestrator (`frontend/src/addons/orchestrator.js`)
# fetches the playable URL from the addon directly.


# ── Library save (torrent → ~/Music/Audimo) ─────────────────────
#
# Bundled-streaming-server torrents have ephemeral URLs:
# `http://127.0.0.1:11471/<infohash>/<file_idx>` is only valid while
# the streaming server's engine for that infohash is alive (idle reaper
# kills it after 30 min and rmtrees the save dir). For the user's
# library to survive across sessions, we copy the chosen file into
# ~/Music/Audimo/{Artist}/{Album}/{Title}.{ext} once it's fully
# downloaded, then rewrite the cache entry's streamUrl to a persistent
# /api/files/local URL that doesn't depend on libtorrent.
#
# Auto-triggered from cache_add when the source_payload carries an
# info_hash + file_idx. Fire-and-forget background task; if save fails
# the cache entry keeps its streaming-server URL (still plays as long
# as the engine is alive).

_STREAMING_BASE = os.environ.get("AUDIMO_STREAMING_BASE", "http://127.0.0.1:11471")
_FS_INVALID = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _safe_slug(s: str) -> str:
    s = _FS_INVALID.sub("_", (s or "").strip()).strip(" .")
    return s[:150] or "Unknown"


def _library_dest(kind: str, title: str, artist: str, album: str, ext: str) -> Path:
    title_s = _safe_slug(title or "Unknown Title")
    if kind == "audiobook":
        author_s = _safe_slug(artist or "Unknown Author")
        return AUDIOBOOK_STORE / author_s / title_s / f"{title_s}{ext}"
    artist_s = _safe_slug(artist or "Unknown Artist")
    album_s = _safe_slug(album or "Unknown Album")
    return MEDIA_ROOT / artist_s / album_s / f"{title_s}{ext}"


# Extensions a torrent-saved track might land under. Ordered by how
# commonly we see them on music releases — first hit wins so a true
# library file isn't shadowed by a coincidentally-named file in another
# format.
_LIBRARY_AUDIO_EXTS = (".mp3", ".flac", ".m4a", ".m4b", ".opus", ".ogg", ".aac", ".wav", ".mp4")


def find_saved_library_file(entry: dict) -> str | None:
    """Probe the deterministic library destination for a torrent-sourced
    cache entry whose ``local_file`` field is missing or empty.

    Resolve does the local-file shortcut when an entry has ``local_file``
    set. But _save_torrent_to_library can fail to stamp that field —
    the engine may have been reaped before the file completed, the user
    may have added the row in an older app version, or the save task
    may simply still be running. In any of those cases ``local_file``
    is empty but the file may still be sitting on disk at the
    deterministic ``_library_dest`` path from a prior successful save.

    Returns the absolute path or None.
    """
    sp = entry.get("source_payload") or {}
    ih = (sp.get("info_hash") or sp.get("infoHash") or "")
    if not (isinstance(ih, str) and len(ih) == 40):
        return None
    title = (entry.get("track_title") or "").strip()
    if not title:
        return None
    artist = (entry.get("track_artist") or "").strip()
    album = (entry.get("track_album") or "").strip()
    kind = entry.get("category") or entry.get("type") or "music"
    if kind not in ("music", "audiobook"):
        kind = "music"
    for ext in _LIBRARY_AUDIO_EXTS:
        dest = _library_dest(kind, title, artist, album, ext)
        try:
            if dest.is_file() and dest.stat().st_size > 0:
                return str(dest)
        except OSError:
            continue
    return None


async def _save_torrent_to_library(
    user_id: int, cache_key: str, info_hash: str, file_idx: int,
    title: str, artist: str, album: str, kind: str,
):
    """Wait for the streaming server to finish downloading the chosen
    file, copy it into the user's library, and rewrite the cache
    entry's streamUrl to a persistent local URL.

    Idempotent against the cache entry — if save runs again for the
    same row the destination is overwritten. Polls every 2s up to 1h;
    if the engine gets reaped or the file never completes, gives up
    quietly and leaves the cache entry on the streaming-server URL.
    """
    import shutil
    from urllib.parse import quote

    # Fast path: an earlier save already wrote the file to the
    # deterministic library destination. Stamp the cache row and skip
    # the streaming-server round-trip + 1h-deadline poll entirely. This
    # is what saves users on a mobile replay where re-peering libtorrent
    # would otherwise stall the audio element into a pause/play loop.
    probe_entry = {
        "track_title": title, "track_artist": artist, "track_album": album,
        "category": kind, "source_payload": {"info_hash": info_hash},
    }
    existing = find_saved_library_file(probe_entry)
    if existing:
        local_url = f"/api/files/local?path={quote(existing)}"
        cache = _get_user_cache(user_id)
        entry = cache.get(cache_key) or _stream_cache.get(cache_key)
        if entry and (entry.get("local_file") != existing or entry.get("streamUrl") != local_url):
            entry["streamUrl"] = local_url
            entry["local_file"] = existing
            cache[cache_key] = entry
            _stream_cache[cache_key] = entry
            save_cache()
            save_cache_entry(user_id, cache_key, entry)
            print(f"[lib-save] {info_hash[:12]} healed → {existing}")
        return

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            cr = await client.post(f"{_STREAMING_BASE}/{info_hash}/create", json={})
            if cr.status_code >= 400:
                print(f"[lib-save] {info_hash[:12]} create failed HTTP {cr.status_code}")
                return
            save_path = (cr.json() or {}).get("save_path")
            if not save_path:
                return

            file_rel_path = None
            for _ in range(1800):  # 1h @ 2s
                await asyncio.sleep(2)
                try:
                    sr = await client.get(f"{_STREAMING_BASE}/{info_hash}/stats.json")
                    stats = sr.json()
                except Exception:
                    continue
                if not stats.get("active"):
                    print(f"[lib-save] {info_hash[:12]} engine gone before file completed")
                    return
                if not stats.get("has_metadata"):
                    continue
                files = stats.get("files") or []
                if file_idx < 0 or file_idx >= len(files):
                    print(f"[lib-save] {info_hash[:12]} bad file_idx={file_idx}")
                    return
                f = files[file_idx]
                file_rel_path = f["path"]
                expected_size = f["size"]
                # libtorrent pre-allocates files at full size before
                # any bytes arrive, so getsize() == expected_size is
                # true immediately and IS NOT a completion signal.
                # Use the bytes_done field the streaming server now
                # exposes (lt's handle.file_progress()) to know when
                # OUR file's pieces have actually been downloaded.
                if int(f.get("bytes_done") or 0) >= expected_size and expected_size > 0:
                    break
            else:
                print(f"[lib-save] {info_hash[:12]} timed out waiting for file_idx={file_idx}")
                return

            ext = os.path.splitext(file_rel_path)[1].lower() or ".mp3"
            src = os.path.join(save_path, file_rel_path)
            dest = _library_dest(kind, title, artist, album, ext)
            dest.parent.mkdir(parents=True, exist_ok=True)
            # If a non-empty file already exists at the destination,
            # KEEP it. Replaying / re-saving the same library entry from
            # a different source (different rip, different codec) used
            # to silently overwrite the user's working file with one
            # the browser may not be able to decode (e.g. an E-AC3
            # audiobook clobbering an AAC one). Library files are
            # immutable once written; explicit delete + re-save is
            # required to swap them.
            if dest.exists() and dest.stat().st_size > 0:
                print(f"[lib-save] {info_hash[:12]} → {dest} (exists, keeping)")
            else:
                # Copy not move — the streaming server may keep seeding
                # this file and removing it would confuse libtorrent.
                shutil.copy2(src, dest)
                print(f"[lib-save] {info_hash[:12]} → {dest}")

            local_url = f"/api/files/local?path={quote(str(dest))}"
            cache = _get_user_cache(user_id)
            entry = cache.get(cache_key) or _stream_cache.get(cache_key)
            if entry:
                entry["streamUrl"] = local_url
                entry["local_file"] = str(dest)
                cache[cache_key] = entry
                _stream_cache[cache_key] = entry
                save_cache()
                save_cache_entry(user_id, cache_key, entry)
    except Exception as e:
        print(f"[lib-save] {info_hash[:12]} error: {type(e).__name__}: {e}")


# ── Addons ────────────────────────────────────────────────────
# Endpoint definitions live in routers/addons.py; the helpers below
# stay here because they read the process-wide stream cache.


def _purge_addon_library(user_id: int, addon_id: str) -> int:
    """Wipe every library entry tagged with ``addon_id`` from BOTH the
    per-user ``user_cache`` rows and the global ``_stream_cache`` JSON.
    Evicts the matching keys from the in-memory ``_user_caches[user_id]``
    too. Returns the total number of distinct entries removed.

    Called when an addon is disabled or removed so the user's library
    can't contain entries that nothing knows how to resolve any more.

    Wrapped in ``_cache_lock`` so a concurrent ``/api/cache/list`` or
    ``cache_add`` can't observe a partial purge (or be blown over by
    ours mid-iteration).
    """
    removed_keys: set[str] = set(delete_cache_entries_by_addon_id(user_id, addon_id))
    with _cache_lock:
        cache = _user_caches.get(user_id)
        if cache:
            for key in list(cache.keys()):
                if (cache[key] or {}).get("addon_id") == addon_id:
                    cache.pop(key, None)
                    removed_keys.add(key)

        # Global stream cache (behind /api/cache/list / Music view)
        global_removed = 0
        for key in list(_stream_cache.keys()):
            if (_stream_cache.get(key) or {}).get("addon_id") == addon_id:
                _stream_cache.pop(key, None)
                removed_keys.add(key)
                global_removed += 1
        if global_removed:
            save_cache()

    if removed_keys:
        print(f"[Addons] Purged {len(removed_keys)} library entries for "
              f"addon {addon_id!r} (user {user_id})")
    return len(removed_keys)


def _addon_library_count(user_id: int, addon_id: str) -> int:
    """How many library entries this addon has produced for ``user_id``.
    Counts both per-user rows and the global stream cache, deduped by
    cache_key. Imported by routers/addons.py via late binding."""
    keys: set[str] = set()
    cache = _get_user_cache(user_id)
    for key, val in cache.items():
        if (val or {}).get("addon_id") == addon_id:
            keys.add(key)
    for key, val in _stream_cache.items():
        if (val or {}).get("addon_id") == addon_id:
            keys.add(key)
    return len(keys)


# Addon endpoints live in routers/addons.py. The two helpers above plus
# `_purge_addon_library` are kept here because they read the
# process-wide stream cache; the router calls them via late import to
# avoid a circular dependency.


# ── Static frontend (phone access) ────────────────────────────
#
# The desktop shell loads the React app via the Tauri webview
# (`frontend/dist` packaged into the .app bundle). Phones reach the
# backend over Tailscale or LAN and need the same UI served from
# `/` — that's what this mount does.
#
# Resolution order:
#   1. $AUDIMO_FRONTEND_DIST — explicit override the desktop shell
#      sets when running a packaged build.
#   2. ../frontend/dist relative to this file (the convention the
#      repo uses).
#
# `html=True` makes StaticFiles serve `index.html` for any path that
# doesn't match a real file — required for the SPA's client-side
# routing. It also won't shadow the explicit `/api/*` routes above
# because Starlette evaluates explicit routes before mounts.

def _resolve_frontend_dist() -> Path | None:
    env_dir = os.environ.get("AUDIMO_FRONTEND_DIST", "").strip()
    if env_dir:
        p = Path(env_dir).expanduser()
        return p if p.is_dir() else None
    here = Path(__file__).resolve().parent
    candidate = here.parent / "frontend" / "dist"
    return candidate if candidate.is_dir() else None


_frontend_dist = _resolve_frontend_dist()
if _frontend_dist is not None:
    print(f"[Server] Serving frontend from {_frontend_dist}")

    # Serve index.html with no-cache so WKWebView always fetches the
    # latest build after a dist swap (avoids stale JS on app relaunch).
    @app.get("/", include_in_schema=False)
    async def _spa_root():
        from fastapi.responses import FileResponse
        return FileResponse(
            str(_frontend_dist / "index.html"),
            headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
        )

    app.mount("/", StaticFiles(directory=str(_frontend_dist), html=True), name="frontend")
else:
    print("[Server] No frontend/dist found — phone access will 404. Run `npm run build` in frontend/.")
