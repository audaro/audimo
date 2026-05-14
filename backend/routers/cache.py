"""Stream cache CRUD.

The "cache" here is the user's library — every track they've ever played
or saved is recorded so it can be replayed on demand. Entries fall into
two buckets:

  * **upload** / legacy local — the bytes live on disk under the user's
    media roots; resolve hands back a /api/files/local URL.
  * **addon** — opaque addon-owned payload; resolve returns a
    ``delegate_addon`` envelope so the frontend orchestrator calls the
    addon directly for a fresh stream URL.

The on-disk save flow (torrent → ~/Music/Audimo) lives in main.py since
it talks to the bundled streaming server and rewrites cache entries
post-download.
"""
import asyncio
import hashlib
import os
import re as _re
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request

from auth import get_current_user
from cache_state import (
    _stream_cache, _user_caches,
    _cache_key,
    get_user_cache as _get_user_cache,
    get_cached_entry, set_cached,
    save_cache,
    _cache_lock,
)
from database import (
    save_cache_entry, delete_cache_entry, delete_cache_entries,
)
import download_job

router = APIRouter(tags=["cache"])

# Mirror routers/files.py — anchor covers under backend/ regardless of
# which router is asking.
BACKEND_DIR = Path(__file__).resolve().parent.parent
COVERS_DIR = BACKEND_DIR / "covers"


@router.post("/api/cache/check")
async def cache_check(payload: dict, current_user: dict = Depends(get_current_user)):
    """Check which tracks from a list are already cached.
    Returns dict keyed by 'artist|title' (lowercased) for easy frontend matching."""
    tracks = payload.get("tracks", [])
    result = {}
    for t in tracks:
        artist = t.get("artist", "").strip()
        title = t.get("title", "").strip()
        entry = get_cached_entry(artist, title)
        if not entry:
            continue
        # For slskd type, verify file still exists on disk
        if entry.get("type") == "slskd":
            local_file = entry.get("local_file", "")
            if local_file and not os.path.exists(local_file):
                continue
        # Use normalized string key so frontend can match without md5
        norm_key = f"{artist.lower()}|{title.lower()}"
        result[norm_key] = {
            "cache_key": _cache_key(artist, title),  # md5 for resolve call
            "type": entry.get("type"),
            "source": entry.get("source", ""),
        }
    return {"cached": result}


# ── Download progress tracking ─────────────────────────────────
# Progress for in-flight playback now lives entirely in the browser
# (SourcePicker tracks SSE events from the addon directly). This
# endpoint is preserved as an empty-shape stub so the
# CachedTracksView poller doesn't 404 on existing installs.
@router.get("/api/download/active")
async def get_active_downloads(current_user: dict = Depends(get_current_user)):
    """Legacy endpoint kept as an empty-shape stub for older clients
    polling at boot. New code uses /api/download/jobs."""
    return {"downloads": []}


@router.get("/api/download/jobs")
async def list_download_jobs(current_user: dict = Depends(get_current_user)):
    """Snapshot of all known download jobs (active + recently
    finished). Polled by the frontend's download-progress overlay."""
    return {"jobs": download_job.list_jobs()}


@router.post("/api/download/jobs/{job_id}/cancel")
async def cancel_download_job(job_id: str, current_user: dict = Depends(get_current_user)):
    """Cooperative cancel — the worker stops between chunks. The
    .part file is removed; partial bytes don't linger."""
    ok = download_job.cancel_job(job_id)
    if not ok:
        raise HTTPException(404, "job not found or already terminal")
    return {"cancelled": True}


# ── Cache management endpoints ────────────────────────────────
def _entry_is_unresolvable(val: dict) -> bool:
    """Return True for cache rows that can never produce a stream URL.
    Today the only known shape is a legacy ``type='addon'`` row written
    before the backend started enforcing ``addon_id`` — without an
    addon to delegate ``cache.resolve`` to, the entry is dead. Caller
    is expected to lazily prune these so they stop showing in the UI."""
    t = val.get("type")
    if t == "addon" and not val.get("addon_id"):
        return True
    return False


@router.get("/api/cache/list")
async def cache_list(current_user: dict = Depends(get_current_user)):
    """List all cached tracks with metadata. Lazily prunes entries we
    know can't be resolved (e.g. legacy ``type='addon'`` rows written
    before the ``addon_id`` enforcement landed).

    The iteration + heal-stale + prune-dead path is wrapped in
    ``_cache_lock`` so a concurrent ``cache_add`` / ``cache_remove`` /
    addon-purge can't mutate the dict mid-loop. ``save_cache()`` re-
    enters the same lock (RLock) without deadlocking.
    """
    entries = []
    dead_keys: list[str] = []
    with _cache_lock:
        for key, val in list(_stream_cache.items()):
            if _entry_is_unresolvable(val):
                dead_keys.append(key)
                continue
            # Heal stale local_file pointers — when the user deletes a
            # downloaded file from disk we want the Library row to flip
            # back to "needs download" instead of looking saved-and-broken.
            # Mutates the cache row so the next list call doesn't re-check.
            local_file = val.get("local_file") or ""
            if local_file and not os.path.isfile(local_file):
                val["local_file"] = ""
                local_file = ""
            entries.append({
                "key": key,
                "filename": val.get("filename"),
                "track_title": val.get("track_title") or val.get("filename", "").rsplit(".", 1)[0],
                "track_artist": val.get("track_artist", ""),
                "track_album": val.get("track_album", ""),
                "source": val.get("source"),
                "type": val.get("type", "unknown"),
                "albumCover": val.get("albumCover"),
                "local_file": local_file,
                # Sub-library tag (e.g. 'audiobook'). Music views
                # filter these OUT; AudiobooksView shows only rows
                # where category='audiobook'.
                "category": val.get("category", ""),
                # Surface mime / format + added_at so the Library design
                # can render the Quality and Added columns and the chip
                # filters (FLAC only, Added this week) can actually run.
                # Both fields are written by the cache.add path; older
                # rows may have neither — frontend treats missing as
                # "unknown" instead of erroring.
                "mime_type": val.get("mime_type") or val.get("mimeType") or "",
                "added_at": val.get("added_at"),
            })
        if dead_keys:
            for k in dead_keys:
                _stream_cache.pop(k, None)
            # Drop in-memory mirrors first, then issue one DELETE per user
            # for all dead keys at once instead of N round-trips per user.
            for uid, ucache in _user_caches.items():
                user_dead = [k for k in dead_keys if k in ucache]
                if not user_dead:
                    continue
                for k in user_dead:
                    ucache.pop(k, None)
                try:
                    delete_cache_entries(uid, user_dead)
                except Exception as e:
                    print(f"[cache.list] bulk delete failed for user {uid}: {e}")
            save_cache()
    return {"count": len(entries), "entries": entries}


@router.post("/api/cache/resolve")
async def cache_resolve(payload: dict, current_user: dict = Depends(get_current_user)):
    """Resolve a cache entry by key to a fresh stream URL.

    When ``force`` is true, the debrid-CDN HEAD shortcut is skipped and
    addon-produced entries always delegate to the addon for a fresh
    extraction. Used by the client after a play failure / stall to
    bypass stale cached URLs that pass a HEAD probe but die on GET.
    Local-file entries are unaffected — disk truth is disk truth.
    """
    from main import (
        resolve_cached, _safe_under_roots, _file_serve_safe_roots,
        find_saved_library_file, _save_torrent_to_library, create_background_task,
    )
    key = payload.get("key")
    if not key:
        raise HTTPException(400, "key required")
    force = bool(payload.get("force"))
    user_id = current_user["id"]
    cache = _get_user_cache(user_id)
    entry = cache.get(key) or _stream_cache.get(key)
    if not entry:
        raise HTTPException(404, "Cache entry not found")

    # Heal user_cache rows whose ``local_file`` was set on _stream_cache
    # by a download job but never propagated. Without this, previously-
    # downloaded tracks fall through to addon delegation on every play
    # for the lifetime of the row.
    if not entry.get("local_file"):
        sc = _stream_cache.get(key) or {}
        sc_local = sc.get("local_file")
        if sc_local and os.path.exists(sc_local):
            entry["local_file"] = sc_local
            urow = cache.get(key)
            if urow is not None and not urow.get("local_file"):
                urow["local_file"] = sc_local
                try: save_cache_entry(user_id, key, urow)
                except Exception: pass

    # Inverse heal — file was deleted from disk after the row was
    # stamped. Clear the stale pointer in both stores so subsequent
    # cache.list / cache.resolve calls don't keep treating the row
    # as "saved" when it isn't.
    el = entry.get("local_file") or ""
    if el and not os.path.isfile(el):
        entry["local_file"] = ""
        sc = _stream_cache.get(key)
        if sc and sc.get("local_file"):
            sc["local_file"] = ""
            try: save_cache()
            except Exception: pass
        urow = cache.get(key)
        if urow and urow.get("local_file"):
            urow["local_file"] = ""
            try: save_cache_entry(user_id, key, urow)
            except Exception: pass

    # Local-file shortcut: if the entry has a `local_file` that still
    # exists on disk (e.g. saved into ~/Music/Audimo by the
    # bundled-streaming-server save flow, or by an addon's own
    # organize-into-library step), serve it directly and skip the
    # addon round-trip entirely. Without this, every replay of a
    # torrent-sourced track would re-peer via the addon delegation
    # path even though the bytes are sitting on disk.
    local_file = entry.get("local_file") or entry.get("addon_local_file")
    if local_file and _safe_under_roots(local_file, _file_serve_safe_roots()) \
            and os.path.exists(local_file):
        from urllib.parse import quote
        return {
            **entry,
            "key": key,
            "streamUrl": f"/api/files/local?path={quote(local_file)}",
            "local_file": local_file,
        }

    # Torrent-sourced row with no `local_file` stamp — probe the
    # deterministic library destination for a previously-saved file
    # before falling through to libtorrent delegation. Without this,
    # entries whose original _save_torrent_to_library never stamped the
    # cache row (engine reaped mid-save, older app version, etc.) keep
    # re-peering on every play even though the bytes are on disk. On
    # mobile that translates into a buffer-underrun pause/play loop.
    sp = entry.get("source_payload") or {}
    if not local_file and (sp.get("info_hash") or sp.get("infoHash")):
        found = find_saved_library_file(entry)
        if found and _safe_under_roots(found, _file_serve_safe_roots()):
            from urllib.parse import quote
            local_url = f"/api/files/local?path={quote(found)}"
            entry["local_file"] = found
            entry["streamUrl"] = local_url
            _stream_cache[key] = entry
            try: save_cache()
            except Exception: pass
            urow = cache.get(key)
            if urow is not None:
                urow["local_file"] = found
                urow["streamUrl"] = local_url
                try: save_cache_entry(user_id, key, urow)
                except Exception: pass
            return {**entry, "key": key, "streamUrl": local_url, "local_file": found}

        # No saved file yet — kick off a save in the background so
        # future plays heal even if this one still goes through
        # libtorrent. Idempotent (the save's own fast-path will
        # short-circuit once the file lands).
        ih_raw = sp.get("info_hash") or sp.get("infoHash") or ""
        ih = ih_raw.lower() if isinstance(ih_raw, str) else ""
        fi = sp.get("file_idx") if isinstance(sp.get("file_idx"), int) else sp.get("fileIdx")
        if len(ih) == 40 and isinstance(fi, int) and fi >= 0:
            create_background_task(_save_torrent_to_library(
                user_id=user_id, cache_key=key, info_hash=ih, file_idx=fi,
                title=(entry.get("track_title") or "").strip(),
                artist=(entry.get("track_artist") or "").strip(),
                album=(entry.get("track_album") or "").strip(),
                kind=entry.get("category") or "music",
            ))

    # Debrid-CDN shortcut: entries previously resolved through
    # /api/audio/proxy (e.g. RD-cached torrents) keep the raw CDN URL in
    # ``debrid_direct_url``. RD links typically last several days. HEAD
    # the saved URL before delegating to the addon — if it's still alive
    # we can replay through the same proxy URL the entry already has,
    # skipping a (potentially slow) addon redispatch that may fall
    # through to a libtorrent re-peer when the addon no longer holds
    # rd_link/torrent_id handles. Saves a 1-3 minute warm-up on every
    # replay of an RD-cached track whose original CDN URL is still good.
    #
    # SSRF defenses: the URL originates from an addon (semi-trusted),
    # so (1) restrict the host to the same debrid-CDN allowlist that
    # /api/audio/proxy enforces, and (2) disable redirect-following so
    # an attacker-controlled debrid host can't pivot the HEAD to an
    # internal service like 127.0.0.1:11471. Timeout is short — a dead
    # CDN URL adds this much wall-clock to every play of that track,
    # so we'd rather fall through to addon delegation quickly.
    direct = (entry.get("debrid_direct_url") or "").strip()
    saved_stream = (entry.get("streamUrl") or "").strip()
    if (not force
            and direct.startswith(("http://", "https://"))
            and saved_stream.startswith("/api/audio/proxy")):
        try:
            # Validate the proxied URL via the same SSRF helper used
            # by other server-side fetches (blocks private/loopback/
            # link-local). The previous gate was a debrid-host suffix
            # allowlist — addon-specific and bypassable via attacker-
            # controlled subdomains. Allow loopback so an addon-served
            # /api/files/local URL stays HEAD-checkable.
            from safe_fetch import validate_url
            validate_url(direct, allow_loopback=True)
            async with httpx.AsyncClient(timeout=1.5, follow_redirects=False) as client:
                r = await client.head(direct)
            if r.status_code == 200:
                return {**entry, "key": key}
        except Exception as e:
            print(f"[cache.resolve] HEAD on debrid_direct_url failed: {e}", flush=True)

    # Device-as-client cutover: addon-produced entries are resolved on the
    # caller's device, not here. We hand the raw entry back with a
    # ``delegate_addon`` envelope so the frontend's orchestrator can call
    # the addon's ``cache.resolve`` over the LAN/WAN directly. The
    # frontend's ``resolveCacheEntry()`` wrapper handles this transparently.
    if entry.get("addon_id"):
        return {
            "delegate_addon": entry["addon_id"],
            "key": key,
            "entry": {**entry, "key": key},
            "force": force,
        }

    # Local-source entries (uploads, legacy local-cached rows) still
    # resolve here — they depend only on filesystem state.
    result = await resolve_cached(entry, user_id=user_id)
    if not result:
        cache.pop(key, None)
        _stream_cache.pop(key, None)
        save_cache()
        raise HTTPException(404, "Cache entry expired — play the track again to re-cache")
    return result


# ── Auto-download to disk ─────────────────────────────────────────
#
# A track that's playing fine via stream URL still benefits from a
# disk copy: resume across long gaps doesn't depend on RD URL
# expiry, offline playback works, and chapter detection unlocks
# (audiobooks). This endpoint takes a cache key, derives a target
# path under ~/Music/Audimo, and spawns a background download job.
# When done, the cache row's ``local_file`` is populated so future
# resolves prefer disk.

_INVALID_FILENAME_CHARS = _re.compile(r'[<>:"/\\|?*\x00-\x1f]')

# Codecs that Safari / macOS WKWebView decodes natively. Anything else
# (notably Opus + Vorbis from YouTube's ANDROID_VR client) needs a
# transcode pass after download or the desktop app silently skips the
# track on play.
_SAFARI_AUDIO_CODECS = {
    "mp3", "aac", "alac", "flac", "pcm_s16le", "pcm_s24le", "pcm_s32le",
}


async def _ensure_safari_compatible(path: str) -> str:
    """If ``path`` holds an audio stream Safari can't decode, transcode
    to 192k AAC/M4A in place (rename happens here too: the source
    file is removed, the new ``.m4a`` takes its slot in the album
    folder). Returns the path of the file that should be persisted —
    same as input on no-op, or the new ``.m4a`` after transcode."""
    import asyncio, shutil
    if not os.path.isfile(path):
        return path
    ffprobe = shutil.which("ffprobe")
    ffmpeg = shutil.which("ffmpeg")
    if not ffprobe or not ffmpeg:
        return path
    try:
        proc = await asyncio.create_subprocess_exec(
            ffprobe, "-v", "error",
            "-select_streams", "a:0",
            "-show_entries", "stream=codec_name",
            "-of", "default=nw=1:nk=1",
            path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        out, _ = await proc.communicate()
        codec = (out or b"").decode().strip().lower()
    except Exception:
        return path
    if not codec or codec in _SAFARI_AUDIO_CODECS:
        return path

    base, _ext = os.path.splitext(path)
    out_path = base + ".m4a"
    tmp_path = out_path + ".tmp.m4a"
    try:
        proc = await asyncio.create_subprocess_exec(
            ffmpeg, "-y", "-loglevel", "error",
            "-i", path,
            "-vn",                      # drop any embedded art video stream
            "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+faststart",  # moov atom up front for fast seek
            tmp_path,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _, err = await proc.communicate()
        if proc.returncode != 0:
            print(f"[cache.download] transcode failed for {path}: "
                  f"{(err or b'').decode(errors='replace')[:200]}")
            try: os.remove(tmp_path)
            except OSError: pass
            return path
    except Exception as e:
        print(f"[cache.download] transcode threw for {path}: {e}")
        try: os.remove(tmp_path)
        except OSError: pass
        return path

    try:
        os.replace(tmp_path, out_path)
        if out_path != path:
            try: os.remove(path)
            except OSError: pass
    except OSError:
        return path
    return out_path


def _safe_filename(name: str, max_len: int = 120) -> str:
    """Sanitize a string for use as a filename component. Drops the
    set of characters Windows + macOS + Linux can't handle; trims
    to a sane max length to avoid path-too-long errors on encrypted
    filesystems / older APIs."""
    s = _INVALID_FILENAME_CHARS.sub("", name or "").strip().rstrip(".")
    s = _re.sub(r"\s+", " ", s)
    return s[:max_len] or "Unknown"


_MIME_EXT_MAP = {
    "audio/mpeg": ".mp3",
    "audio/flac": ".flac",
    "audio/wav": ".wav",
    "audio/aac": ".aac",
    "audio/mp4": ".m4a",
    "audio/ogg": ".ogg",
    "audio/opus": ".opus",
    "audio/webm": ".webm",
}


def _ext_from_url_or_mime(url: str, mime: str) -> str:
    """Best-effort audio extension. Priority order:
       1. ``/api/audio/proxy`` wrapper — recurse on the inner URL.
       2. googlevideo / similar query strings carrying ``mime=audio/X``
          — preferred over the path because YouTube's path is just
          ``/videoplayback`` regardless of codec, and using ``.mp3``
          for an Opus stream gave Safari/WKWebView (Audimo's desktop
          shell) an unplayable file labelled with the wrong codec.
       3. URL path extension.
       4. Caller-supplied mime."""
    try:
        p = urlparse(url)
        if p.path.endswith("/api/audio/proxy") or p.path == "/api/audio/proxy":
            inner = parse_qs(p.query).get("url", [""])[0]
            if inner:
                return _ext_from_url_or_mime(unquote(inner), mime)
        # YouTube googlevideo: ?mime=audio%2Fwebm or ?mime=audio%2Fmp4
        q = parse_qs(p.query)
        url_mime = (q.get("mime") or q.get("ctype") or [""])[0].lower()
        if url_mime in _MIME_EXT_MAP:
            return _MIME_EXT_MAP[url_mime]
        ext = os.path.splitext(p.path)[1].lower()
        if ext and 2 <= len(ext) <= 6:
            return ext
    except Exception:
        pass
    return _MIME_EXT_MAP.get((mime or "").lower(), ".mp3")


def _resolve_proxy_url(url: str) -> str:
    """Audimo's /api/audio/proxy?url=... wraps the upstream URL so
    the audio element can ride through the backend's CORS + Range
    plumbing. For our own server-side fetch we want the direct
    upstream URL — extract it."""
    try:
        p = urlparse(url)
        if "/api/audio/proxy" in p.path:
            inner = parse_qs(p.query).get("url", [""])[0]
            if inner:
                return unquote(inner)
    except Exception:
        pass
    return url


@router.post("/api/cache/{key}/download")
async def cache_download(key: str, payload: dict | None = None, current_user: dict = Depends(get_current_user)):
    """Start an HTTP download of the cache row's underlying audio
    URL into ~/Music/Audimo/<artist>/<album>/<title>.<ext>. Returns
    the job id; progress polled via /api/download/jobs.

    Optional body: ``{"stream_url": "..."}`` overrides the cached
    URL. The frontend re-resolves via the addon orchestrator before
    posting so we don't fetch a stale (e.g. expired YouTube) URL."""
    from file_store import MEDIA_ROOT
    val = _stream_cache.get(key)
    if not val:
        raise HTTPException(404, "cache entry not found")
    if val.get("local_file") and os.path.isfile(val["local_file"]):
        # Already on disk — no-op.
        return {"already_local": True, "local_file": val["local_file"]}

    # Prefer a freshly-resolved URL from the caller — addon-delegated
    # rows (YouTube, RD, etc.) hold short-lived URLs in stream_cache.
    override = ""
    if isinstance(payload, dict):
        override = (payload.get("stream_url") or payload.get("streamUrl") or "").strip()
    raw_url = override or val.get("stream_url") or val.get("streamUrl") or ""
    raw_url = _resolve_proxy_url(raw_url)
    if not raw_url:
        raise HTTPException(400, "cache row has no stream URL — play it once first to populate")

    # Don't double-spawn. If the user fat-fingers Download twice,
    # return the existing job rather than racing two writers.
    existing = download_job.find_active_for("music", key)
    if existing:
        return {"job_id": existing.id, "already_running": True}

    artist = _safe_filename(val.get("track_artist") or "Unknown Artist")
    album = _safe_filename(val.get("track_album") or "Singles")
    title = _safe_filename(val.get("track_title") or val.get("filename") or "Unknown")
    ext = _ext_from_url_or_mime(raw_url, val.get("mime_type") or val.get("mimeType") or "")
    dest = str(MEDIA_ROOT / artist / album / f"{title}{ext}")

    user_id = current_user["id"]
    async def _on_finish(job: download_job.DownloadJob):
        # _run calls us during the "finalizing" phase before flipping
        # to "done" — so accept either as a success signal. Skip on
        # error / cancelled.
        if job.status not in ("finalizing", "done"):
            return
        # Safari / WKWebView (Audimo's desktop shell) doesn't decode
        # Opus or Vorbis. YouTube's ANDROID_VR client URLs hand us
        # Opus/WebM, so a freshly-downloaded YouTube track plays in
        # Chrome but skips silently in the desktop app. Probe the
        # finished file; if the codec is non-Safari-friendly,
        # transcode to AAC/M4A in place and update dest_path.
        final_path = await _ensure_safari_compatible(job.dest_path)
        if final_path != job.dest_path:
            job.dest_path = final_path

        cur = _stream_cache.get(key)
        if cur:
            cur["local_file"] = job.dest_path
            save_cache()
        ucache = _get_user_cache(user_id)
        urow = ucache.get(key)
        if urow:
            urow["local_file"] = job.dest_path
            save_cache_entry(user_id, key, urow)

    j = download_job.start_download(
        kind="music",
        url=raw_url,
        dest_path=dest,
        label=f"{val.get('track_artist','')} — {val.get('track_title','')}".strip(" —"),
        related_key=key,
        on_finish=_on_finish,
    )
    return {"job_id": j.id, "dest_path": dest}


@router.delete("/api/cache/clear")
async def cache_clear(current_user: dict = Depends(get_current_user)):
    """Clear all cached streams."""
    _stream_cache.clear()
    save_cache()
    return {"cleared": True}


@router.delete("/api/cache/{artist}/{title}")
async def cache_delete(artist: str, title: str, current_user: dict = Depends(get_current_user)):
    """Remove a specific track from cache."""
    key = _cache_key(artist, title)
    removed = _stream_cache.pop(key, None)
    if removed:
        save_cache()
    return {"removed": bool(removed)}


@router.delete("/api/cache/remove")
async def cache_remove(payload: dict, current_user: dict = Depends(get_current_user)):
    """Remove a cache entry by key, and also delete the on-disk audio
    file if one is referenced by the entry.

    Removes from BOTH the global ``_stream_cache`` (which
    ``/api/cache/list`` reads from and which most write paths populate
    via ``set_cached``) AND the per-user cache + DB. If we only
    removed from one, the entry would reappear in the listing or
    leave a duplicate behind on re-add.
    """
    from file_store import MEDIA_ROOT, AUDIOBOOK_STORE
    key = payload.get("key")
    if not key:
        raise HTTPException(400, "key required")
    user_id = current_user["id"]
    cache = _get_user_cache(user_id)

    # Pull entry from whichever cache has it (prefer per-user, fall back to global)
    entry = cache.pop(key, None) or _stream_cache.get(key)
    if not entry:
        raise HTTPException(404, "Cache entry not found")

    # Always wipe from the global cache + on-disk JSON so /api/cache/list reflects it
    _stream_cache.pop(key, None)
    save_cache()
    # Also wipe from the per-user DB row (no-op if it was only in the global cache)
    delete_cache_entry(user_id, key)

    # Wipe the local audio file too. "Delete from library" should
    # mean "I don't want this anymore," not "hide from list but keep
    # file silently on disk." We check every known local-file slot —
    # ``local_file`` for legacy entries and uploads, plus
    # ``addon_local_file`` for addon-produced permanent saves.
    candidate_paths = [
        entry.get("local_file") or "",
        entry.get("addon_local_file") or "",
    ]
    # Roots we'll walk up to (but not delete). Anything outside these
    # gets only the file removed — no parent walking, for safety.
    safe_roots = [
        os.path.realpath(MEDIA_ROOT),
        os.path.realpath(AUDIOBOOK_STORE),
    ]
    for p in candidate_paths:
        if not p or not os.path.exists(p):
            continue
        try:
            os.remove(p)
            # Walk up empty parent dirs. The addon now lays files out
            # as {Artist}/{Album}/{Title}.ext (music) and
            # {Author}/{Title}/{Title}.ext (audiobooks); deleting just
            # the file would leave the per-track Album folder, then
            # the Artist folder, behind. Walk up to (but not past)
            # the user-visible library root.
            cur = os.path.realpath(os.path.dirname(p))
            for _ in range(4):  # cap walk depth
                if not any(cur.startswith(root + os.sep) for root in safe_roots):
                    break
                if not os.path.isdir(cur) or os.listdir(cur):
                    break
                try:
                    os.rmdir(cur)
                except OSError:
                    break
                cur = os.path.dirname(cur)
        except Exception:
            pass
    return {"ok": True}


@router.post("/api/cache/add")
async def cache_add(payload: dict, current_user: dict = Depends(get_current_user)):
    """Add a track to the cache. Used by uploads + addon paths."""
    source_type = payload.get("type")
    title = payload.get("title", "").strip()
    artist = payload.get("artist", "").strip()
    if not title or not source_type:
        raise HTTPException(400, "type and title required")
    user_id = current_user["id"]
    # `source` MUST be a string label — the UI renders it directly
    # (<span>{entry.source}</span>). Coerce here so a misbehaving
    # caller can't poison the cache with a dict/list and crash the
    # whole UI on next render.
    src_in = payload.get("source")
    src = src_in if isinstance(src_in, str) else (source_type.upper() if source_type else "")
    import time as _time
    entry = {
        "type": source_type,
        "streamUrl": payload.get("streamUrl", ""),
        "filename": title,
        "track_title": title,
        "track_artist": artist,
        "track_album": payload.get("album", ""),
        "source": src,
        "albumCover": payload.get("albumCover"),
        "mimeType": payload.get("mimeType") or "audio/mpeg",
        # Unix epoch seconds; consumed by the Library "Added" column
        # and the "Added this week" filter chip. Older rows added
        # before this field landed read as missing — frontend treats
        # missing as "before we started tracking" rather than crashing.
        "added_at": int(_time.time()),
    }
    # Optional category tag used to scope cache rows to a sub-library
    # (today the only known value is "audiobook"). The Audiobooks view
    # filters /api/cache/list on this so it doesn't need a separate
    # fetch — same plumbing the music view already uses.
    if payload.get("category"):
        entry["category"] = payload["category"]
    # Addon-produced entries: persist enough metadata that the
    # delegate envelope returned by /api/cache/resolve carries
    # everything the addon's own cache.resolve needs to re-materialize
    # a fresh stream URL on the next play. Keyed off ``addon_id`` (not
    # ``type``) because cached-source entries come back tagged with the
    # backend-of-record's type label but still need delegation.
    addon_id = payload.get("addon_id") or ""
    if addon_id:
        entry["addon_id"] = addon_id
        # Opaque passthrough: anything in the payload that core
        # doesn't already know about gets carried into the cache row
        # so the addon can read it back from cache.resolve later.
        # Core does not interpret these fields.
        CORE_FIELDS = {
            "type", "title", "artist", "album", "category", "addon_id",
            "streamUrl", "source", "albumCover", "mimeType",
        }
        for k, v in payload.items():
            if k not in CORE_FIELDS and v is not None:
                entry[k] = v
        # Also expose ``addon_local_file`` as ``local_file`` (the
        # generic on-disk path field) so the listings endpoint and
        # /api/files/local can find it without addon-specific reads.
        if entry.get("addon_local_file") and not entry.get("local_file"):
            entry["local_file"] = entry["addon_local_file"]
    # Every addon-produced row must declare which addon owns it so
    # cache.resolve knows where to delegate.
    if source_type == "addon" and not addon_id:
        raise HTTPException(400, "addon_id required for type=addon")
    key = _cache_key(artist, title)
    set_cached(artist, title, entry)
    save_cache_entry(user_id, key, entry)
    # Bundled streaming-server torrents have ephemeral URLs. Kick off a
    # background save so this entry survives the engine reaper and
    # future plays serve from the user's library on disk. No-op for any
    # source without info_hash + file_idx (SC/YT, slskd, RD-direct,
    # etc.) — those URLs are already persistent on the upstream.
    sp = payload.get("source_payload") or {}
    ih_raw = sp.get("info_hash") or sp.get("infoHash") or ""
    ih = ih_raw.lower() if isinstance(ih_raw, str) else ""
    fi = sp.get("file_idx") if isinstance(sp.get("file_idx"), int) else sp.get("fileIdx")
    if len(ih) == 40 and isinstance(fi, int) and fi >= 0:
        from main import _save_torrent_to_library, create_background_task
        # Tracked via main's `_background_tasks` set so the shutdown
        # handler can cancel + await it; raw `asyncio.create_task` got
        # detached and could leave a half-written file on shutdown.
        create_background_task(_save_torrent_to_library(
            user_id=user_id, cache_key=key, info_hash=ih, file_idx=fi,
            title=title, artist=artist,
            album=payload.get("album", "").strip(),
            kind=payload.get("category", "music"),
        ))
    return {"ok": True, "key": key}


@router.patch("/api/cache/update")
async def cache_update(payload: dict, current_user: dict = Depends(get_current_user)):
    """Update fields on an existing cache entry.

    Two flavors:
      * Track metadata edits from the UI: title/artist/album/cover.
      * Source upgrades from the addon ``cache_hint`` flow: when an
        addon promotes an entry's ``streamUrl`` + ``source`` from an
        ephemeral handle to a persistent URL, those edits arrive
        through this endpoint along with any addon-specific fields
        the addon wants carried forward into the cache row.
    """
    key = payload.get("key")
    if not key:
        raise HTTPException(400, "key required")
    user_id = current_user["id"]
    cache = _get_user_cache(user_id)
    entry = cache.get(key) or _stream_cache.get(key)
    if not entry:
        raise HTTPException(404, "Cache entry not found")
    # Editable + upgradeable fields. The first set is the minimum
    # core-known shape; anything else in the payload is treated as
    # opaque addon-passthrough and persisted as-is.
    CORE_EDITABLE = {
        "track_title", "track_artist", "track_album", "albumCover",
        "streamUrl", "source", "mimeType", "type",
    }
    PROTECTED = {"key", "addon_id"}  # never overwritable via this endpoint
    for field, value in payload.items():
        if field in PROTECTED:
            continue
        if field in CORE_EDITABLE or field not in entry or entry.get("addon_id"):
            entry[field] = value
    cache[key] = entry
    # Also keep the global cache in sync so /api/cache/list reflects the
    # upgrade immediately (My Music re-renders with the new badge).
    _stream_cache[key] = entry
    save_cache()
    save_cache_entry(user_id, key, entry)
    return {"ok": True, "entry": {**entry, "key": key}}


@router.post("/api/cache/upload-cover")
async def cache_upload_cover(request: Request, current_user: dict = Depends(get_current_user)):
    """Upload an album cover image and return its URL."""
    form = await request.form()
    key = form.get("key", "")
    file = form.get("file")
    if not file or not key:
        raise HTTPException(400, "key and file required")
    user_id = current_user["id"]
    COVERS_DIR.mkdir(exist_ok=True)
    safe_key = hashlib.md5(key.encode()).hexdigest()
    from file_store import safe_image_ext
    ext = safe_image_ext(getattr(file, "filename", "") or "")
    out_path = COVERS_DIR / f"{safe_key}{ext}"
    content = await file.read()
    out_path.write_bytes(content)
    cover_url = f"/api/covers/{safe_key}{ext}"
    cache = _get_user_cache(user_id)
    if key in cache:
        cache[key]["albumCover"] = cover_url
        save_cache_entry(user_id, key, cache[key])
    return {"ok": True, "albumCover": cover_url}
