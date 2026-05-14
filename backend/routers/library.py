"""Library views and library-grooming callbacks.

The downloads-local listing aggregates everything physically on disk
(uploads + cached local files + audiobook library rows). The
debrid-cached callback is the second half of a frontend-driven sweep
that promotes torrent rows to debrid CDN URLs and (optionally) reclaims
the local copy.
"""
import hashlib
import os
from pathlib import Path
import platform
import re
import subprocess
import unicodedata

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import FileResponse

from auth import get_current_user
from cache_state import (
    _stream_cache, _user_caches,
    save_cache,
)
from database import save_cache_entry

router = APIRouter(tags=["library"])


@router.get("/api/downloads/local")
async def downloads_local(current_user: dict = Depends(get_current_user)):
    """Unified list of all locally-stored audio: cached entries with a
    ``local_file`` on disk, plus library audiobooks in
    ``AUDIOBOOK_STORE``. These live until the user explicitly removes
    them. Addons that download in their own process and expose
    progress can surface that via their own UI; core has no visibility
    into addon-side download state."""
    files = []
    seen_paths = set()

    # 1) Cached entries with a populated local_file (uploads and
    #    locally-cached SC/Soulseek rows).
    for key, val in _stream_cache.items():
        if val.get("type") not in ("upload", "slskd"):
            continue
        local_file = val.get("local_file", "")
        if not local_file or not os.path.exists(local_file):
            continue
        seen_paths.add(os.path.abspath(local_file))
        try:
            sz = os.path.getsize(local_file)
        except Exception:
            sz = 0
        kind = "upload" if val.get("type") == "upload" else "local"
        files.append({
            "id": f"cache:{key}",
            "kind": kind,
            "title": val.get("track_title") or os.path.basename(local_file),
            "artist": val.get("track_artist", ""),
            "album": val.get("track_album", ""),
            "albumCover": val.get("albumCover"),
            "filePath": local_file,
            "filename": os.path.basename(local_file),
            "size": sz,
            "bytesReady": sz,
            "downloadPct": 100,
            "status": "ready",
            "transient": False,
            "source": val.get("source", "Local"),
            "cacheKey": key,
        })

    # 2) Permanent audiobook library entries with a populated local_file
    try:
        from database import get_db
        with get_db() as conn:
            rows = conn.execute(
                "SELECT id, title, author, cover, local_file, format, size FROM audiobook_library "
                "WHERE user_id = ? AND local_file != ''",
                (current_user["id"],),
            ).fetchall()
        for row in rows:
            lf = row["local_file"]
            if not lf or not os.path.exists(lf):
                continue
            seen_paths.add(os.path.abspath(lf))
            try:
                sz = os.path.getsize(lf)
            except Exception:
                sz = 0
            files.append({
                "id": f"audiobook:{row['id']}",
                "kind": "audiobook",
                "title": row["title"],
                "artist": row["author"] or "",
                "album": "",
                "albumCover": row["cover"],
                "filePath": lf,
                "filename": os.path.basename(lf),
                "size": sz,
                "bytesReady": sz,
                "downloadPct": 100,
                "status": "ready",
                "transient": False,
                "source": "Audiobook",
                "audiobookId": row["id"],
            })
    except Exception as e:
        print(f"[downloads/local] audiobook lookup error: {e}")

    # In-progress fetches owned by addons aren't visible from core.

    # Sort: in-progress first, then permanent by title
    files.sort(key=lambda f: (
        0 if f["transient"] and f["status"] == "downloading" else
        1 if f["transient"] else
        2,
        f.get("title", "").lower(),
    ))
    return {"files": files, "count": len(files)}


# ── User-supplied artist + album image overrides ─────────────────
#
# Mirrors the frontend's canonicalArtistKey: NFC, strip a curated
# set of decoration codepoints, collapse whitespace, lowercase. Same
# canonicalisation means "☆LiL PEEP☆" and "Lil Peep" land on one
# override file — not two.
_DECORATION_CHARS = "★☆♡♥❤♪♫⚡✦✧✨✯✰✪◇◆●○■□▲△▼▽✿❀❁❃❋"
_DECORATION_RE = re.compile(f"[{re.escape(_DECORATION_CHARS)}]")


def _canon_artist(name: str) -> str:
    if not name:
        return ""
    s = unicodedata.normalize("NFC", name)
    s = _DECORATION_RE.sub("", s)
    s = re.sub(r"\s+", " ", s).strip().lower()
    return s


def _custom_image_filename(prefix: str, key: str, ext: str) -> str:
    safe_ext = (ext or ".jpg").lower()
    if safe_ext not in {".jpg", ".jpeg", ".png", ".webp", ".gif"}:
        safe_ext = ".jpg"
    digest = hashlib.md5(f"{prefix}|{key}".encode("utf-8")).hexdigest()
    return f"{prefix}_{digest}{safe_ext}"


def _find_existing_custom_image(prefix: str, key: str) -> str | None:
    """Return the filename of an already-uploaded image for this
    prefix+key, regardless of extension. Used by GET endpoints so we
    don't have to remember the exact ext from upload time.
    """
    from file_store import CUSTOM_IMAGES_DIR
    digest = hashlib.md5(f"{prefix}|{key}".encode("utf-8")).hexdigest()
    for ext in (".jpg", ".jpeg", ".png", ".webp", ".gif"):
        candidate = CUSTOM_IMAGES_DIR / f"{prefix}_{digest}{ext}"
        if candidate.exists():
            return candidate.name
    return None


@router.post("/api/library/artist-image")
async def upload_artist_image(request: Request, current_user: dict = Depends(get_current_user)):
    """Save a user-supplied artist image override. Form fields:
    `name` (artist display string), `file` (image). Replaces any
    previous override for the same canonical artist.
    """
    from file_store import CUSTOM_IMAGES_DIR
    form = await request.form()
    name = (form.get("name") or "").strip()
    file = form.get("file")
    if not name or not file:
        raise HTTPException(400, "name and file required")
    canon = _canon_artist(name)
    if not canon:
        raise HTTPException(400, "name normalised to empty")
    from file_store import safe_image_ext
    ext = safe_image_ext(getattr(file, "filename", "") or "")
    # Wipe stale variants first so a JPG → PNG re-upload doesn't leave
    # the old JPG hanging around.
    for old in (CUSTOM_IMAGES_DIR.glob(f"artist_{hashlib.md5(('artist|'+canon).encode()).hexdigest()}.*")):
        old.unlink(missing_ok=True)
    fname = _custom_image_filename("artist", canon, ext)
    out = CUSTOM_IMAGES_DIR / fname
    out.write_bytes(await file.read())
    return {"ok": True, "url": f"/api/library/custom-image/{fname}"}


@router.post("/api/library/album-image")
async def upload_album_image(request: Request, current_user: dict = Depends(get_current_user)):
    """Save a user-supplied album image override. Form fields:
    `album`, `artist`, `file`."""
    from file_store import CUSTOM_IMAGES_DIR
    form = await request.form()
    album = (form.get("album") or "").strip()
    artist = (form.get("artist") or "").strip()
    file = form.get("file")
    if not album or not file:
        raise HTTPException(400, "album and file required")
    canon = f"{album.lower().strip()}|{_canon_artist(artist)}"
    from file_store import safe_image_ext
    ext = safe_image_ext(getattr(file, "filename", "") or "")
    digest = hashlib.md5(("album|"+canon).encode()).hexdigest()
    for old in (CUSTOM_IMAGES_DIR.glob(f"album_{digest}.*")):
        old.unlink(missing_ok=True)
    fname = _custom_image_filename("album", canon, ext)
    out = CUSTOM_IMAGES_DIR / fname
    out.write_bytes(await file.read())
    return {"ok": True, "url": f"/api/library/custom-image/{fname}"}


# Browser cache lifetime for artist/album image lookups. The frontend
# also has an in-memory ``_artistPhotoMem`` to dedupe per-render
# fetches, but the browser cache survives page reloads and tab
# switches. 300s is short enough that a user-supplied override
# appears within minutes; the post handlers bump _artistPhotoVersion
# locally so the current session sees the swap immediately.
_IMAGE_LOOKUP_CACHE_HEADER = "public, max-age=300, stale-while-revalidate=600"


@router.get("/api/library/artist-image")
async def get_artist_image(
    response: Response,
    name: str = "",
    current_user: dict = Depends(get_current_user),
):
    """Return the URL of a user-supplied artist image override, or
    `{url: null}` if none exists. The frontend uses this as the
    first source in its avatar fallback chain (Custom → Wikipedia →
    monogram)."""
    canon = _canon_artist(name)
    fname = _find_existing_custom_image("artist", canon) if canon else None
    response.headers["Cache-Control"] = _IMAGE_LOOKUP_CACHE_HEADER
    return {"url": f"/api/library/custom-image/{fname}" if fname else None}


@router.get("/api/library/album-image")
async def get_album_image(
    response: Response,
    album: str = "",
    artist: str = "",
    current_user: dict = Depends(get_current_user),
):
    canon = f"{album.lower().strip()}|{_canon_artist(artist)}"
    fname = _find_existing_custom_image("album", canon) if album else None
    response.headers["Cache-Control"] = _IMAGE_LOOKUP_CACHE_HEADER
    return {"url": f"/api/library/custom-image/{fname}" if fname else None}


@router.get("/api/library/custom-image/{filename}")
async def serve_custom_image(filename: str):
    """Serve a previously uploaded artist/album override. Path
    traversal is blocked the same way /api/covers/{filename} blocks
    it — by realpath-checking against CUSTOM_IMAGES_DIR. Long
    Cache-Control: filenames are content-hashed so a new override
    gets a new URL — the cached one is fine to keep forever."""
    from file_store import CUSTOM_IMAGES_DIR
    if "/" in filename or "\\" in filename or filename.startswith("."):
        raise HTTPException(400, "invalid filename")
    path = CUSTOM_IMAGES_DIR / filename
    if not path.exists():
        raise HTTPException(404, "not found")
    real = os.path.realpath(path)
    if not real.startswith(os.path.realpath(str(CUSTOM_IMAGES_DIR))):
        raise HTTPException(400, "invalid path")
    return FileResponse(
        real,
        headers={"Cache-Control": "public, max-age=86400, immutable"},
    )


@router.post("/api/library/open_folder")
async def open_folder(payload: dict, current_user: dict = Depends(get_current_user)):
    """Reveal a path in Finder / Explorer / xdg-open.

    Replaces the addon's /open-folder, which 404s on hosted aio
    deployments. Restricted to the two media roots so the endpoint
    can't be coaxed into opening arbitrary paths if a malicious
    page somehow makes it past auth.
    """
    from file_store import MEDIA_ROOT, AUDIOBOOK_STORE
    raw = (payload.get("path") or "").strip()
    if not raw:
        raise HTTPException(400, "path required")
    target = os.path.realpath(os.path.expanduser(raw))
    allowed = [
        os.path.realpath(str(MEDIA_ROOT)),
        os.path.realpath(str(AUDIOBOOK_STORE)),
    ]
    if target not in allowed:
        raise HTTPException(403, "path is not a known media root")
    if not os.path.isdir(target):
        # Auto-create if missing — first launch may not have written
        # anything yet, but the user expects "Open" to drop them into
        # an empty folder rather than hand back an error.
        os.makedirs(target, exist_ok=True)
    system = platform.system()
    try:
        if system == "Darwin":
            subprocess.Popen(["open", target])
        elif system == "Windows":
            os.startfile(target)  # type: ignore[attr-defined]
        else:
            subprocess.Popen(["xdg-open", target])
    except Exception as e:
        raise HTTPException(500, f"open failed: {e}")
    return {"ok": True, "path": target}


# ── Library backup ─────────────────────────────────────────────
#
# Streams a zip archive of the user's ``~/.audimo`` directory minus
# anything sensitive (encryption keys, API tokens, libtorrent state)
# or trivially reproducible (addon sidecar binaries, frontend
# debug log). The result is enough to restore the user's library,
# playlists, audiobook progress, podcast subscriptions, custom
# images, and history on a fresh install.
#
# What's excluded (and why):
#   secret.key           — DB encryption key, lives in keychain
#   api_key              — backend auth token, regenerable
#   lt_state/            — libtorrent DHT routing table cache
#   streaming/           — libtorrent transient cache (saved
#                          torrents would be huge; user re-saves)
#   addons/installed/    — addon sidecar binaries, ~50MB each
#   frontend-debug.log   — diagnostic log
#
# Per-file size budget keeps a runaway file from blowing the zip;
# we cap each member at 100 MB. Anything larger is skipped with a
# warning comment in the archive.

_BACKUP_EXCLUDE_NAMES = {
    "secret.key",
    "api_key",
    "frontend-debug.log",
    "sidecars-runtime.json",
}
_BACKUP_EXCLUDE_DIRS = {
    "lt_state",
    "streaming",
    "addons",
    ".cache",
}
_BACKUP_MAX_FILE_BYTES = 100 * 1024 * 1024


@router.get("/api/library/export.zip")
async def library_export(current_user: dict = Depends(get_current_user)):
    """Download the user's portable library + settings as a zip."""
    import io
    import zipfile
    from datetime import datetime
    from fastapi.responses import StreamingResponse

    root = Path.home() / ".audimo"
    if not root.is_dir():
        raise HTTPException(404, "No Audimo data to back up yet.")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for dirpath, dirnames, filenames in os.walk(root):
            # Prune excluded dirs in-place so os.walk doesn't descend.
            rel = os.path.relpath(dirpath, root)
            parts = [] if rel in (".", "") else rel.split(os.sep)
            if parts and parts[0] in _BACKUP_EXCLUDE_DIRS:
                dirnames[:] = []
                continue
            dirnames[:] = [d for d in dirnames if d not in _BACKUP_EXCLUDE_DIRS]
            for f in filenames:
                if f in _BACKUP_EXCLUDE_NAMES:
                    continue
                src = os.path.join(dirpath, f)
                try:
                    sz = os.path.getsize(src)
                except OSError:
                    continue
                arcname = os.path.relpath(src, root)
                if sz > _BACKUP_MAX_FILE_BYTES:
                    zf.writestr(
                        arcname + ".SKIPPED.txt",
                        f"Skipped (file is {sz} bytes; max is {_BACKUP_MAX_FILE_BYTES}).",
                    )
                    continue
                try:
                    zf.write(src, arcname)
                except OSError as e:
                    zf.writestr(arcname + ".SKIPPED.txt", f"Skipped: {e}")

    buf.seek(0)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    filename = f"audimo-backup-{stamp}.zip"

    def gen():
        # Stream in 64K chunks so a huge zip doesn't blow memory on
        # transfer. The BytesIO already has the whole archive — this
        # is purely chunked send.
        while True:
            chunk = buf.read(64 * 1024)
            if not chunk:
                break
            yield chunk

    return StreamingResponse(
        gen(),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Length": str(buf.getbuffer().nbytes),
            "Cache-Control": "no-store",
        },
    )


@router.post("/api/library/reveal_file")
async def reveal_file(payload: dict, current_user: dict = Depends(get_current_user)):
    """Select a specific file in Finder / Explorer (or open its
    parent directory on Linux). Used by the "Reveal in Finder"
    button next to locally-downloaded tracks.

    Restricted to file paths that resolve under the user's known
    media roots — uploads, music, audiobooks. Prevents the endpoint
    from being abused to open arbitrary files on disk.
    """
    from main import _safe_under_roots, _file_serve_safe_roots
    raw = (payload.get("path") or "").strip()
    if not raw:
        raise HTTPException(400, "path required")
    real = _safe_under_roots(raw, _file_serve_safe_roots())
    if not real:
        raise HTTPException(403, "path not under a known media root")
    if not os.path.isfile(real):
        raise HTTPException(404, "file not found")
    system = platform.system()
    try:
        if system == "Darwin":
            # `open -R <path>` selects the file in Finder rather than
            # opening it. Same UX as right-clicking and choosing
            # "Show in Finder".
            subprocess.Popen(["open", "-R", real])
        elif system == "Windows":
            # `explorer /select,<path>` highlights the file. The
            # leading comma+no-space is the actual switch syntax.
            subprocess.Popen(["explorer", f"/select,{real}"])
        else:
            # Most Linux file managers don't support file selection
            # via xdg-open. Best effort: open the parent directory.
            subprocess.Popen(["xdg-open", os.path.dirname(real)])
    except Exception as e:
        raise HTTPException(500, f"reveal failed: {e}")
    return {"ok": True, "path": real}


@router.get("/api/library/dead_tracks")
async def dead_tracks(current_user: dict = Depends(get_current_user)):
    """List cache rows whose ``local_file`` points at a path that no
    longer exists on disk. Used by Settings → "Scan for dead tracks."

    Previously this lived behind the addon's /library/check, but
    that endpoint is unreachable when the user has the hosted
    flavour of audimo-aio installed (different filesystem, different
    URL config) and 404s. The check only needs the local cache
    table + os.path.exists, both of which the backend already has.
    Streaming-only entries (no local_file) are excluded — we have no
    way to verify a remote URL from here.
    """
    out = []
    for key, entry in _stream_cache.items():
        local = (entry.get("local_file") or "").strip()
        if not local:
            continue
        path = os.path.expanduser(local)
        if os.path.exists(path):
            continue
        out.append({
            "key": key,
            "track_title": entry.get("track_title") or "",
            "track_artist": entry.get("track_artist") or "",
            "track_album": entry.get("track_album") or "",
            "filename": entry.get("filename") or "",
            "local_file": local,
        })
    return {"dead": out, "count": len(out)}


def _normalize_for_dedup(s: str | None) -> str:
    """Aggressive normalization for duplicate detection. Strips
    whitespace, diacritics, punctuation, and case so "Café Tacuba"
    and "cafe tacuba!" collide. Tradeoff: a few real distinct tracks
    that differ only in punctuation get false-positive grouped —
    the UI's "review before delete" flow handles that."""
    if not s:
        return ""
    import unicodedata
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    out = []
    for c in s.lower():
        if c.isalnum():
            out.append(c)
    return "".join(out)


@router.get("/api/library/duplicates")
async def find_duplicates(current_user: dict = Depends(get_current_user)):
    """Group cache rows that look like the same track under different
    spellings ("Cafe Tacvba" vs "Café Tacuba!"). The user reviews
    each group in Settings and picks which to keep. We don't
    auto-delete — fuzzy match is noisy and the dedup pass is
    inherently destructive.

    Group key is ``normalize(title) + '|' + normalize(artist)``.
    Single-row groups are not included.
    """
    groups: dict[str, list[dict]] = {}
    for key, entry in _stream_cache.items():
        title = entry.get("track_title") or entry.get("filename") or ""
        artist = entry.get("track_artist") or ""
        norm = f"{_normalize_for_dedup(title)}|{_normalize_for_dedup(artist)}"
        if not norm or norm == "|":
            continue
        groups.setdefault(norm, []).append({
            "key": key,
            "title": title,
            "artist": artist,
            "album": entry.get("track_album") or "",
            "source": entry.get("source") or "",
            "local_file": entry.get("local_file") or "",
            "added_at": entry.get("added_at"),
        })
    dupes = [rows for rows in groups.values() if len(rows) > 1]
    # Sort each group by added_at desc — most recent first reads
    # like "you saved this one again recently, here are the others".
    for rows in dupes:
        rows.sort(key=lambda r: r.get("added_at") or 0, reverse=True)
    return {"groups": dupes, "total_extras": sum(len(g) - 1 for g in dupes)}


@router.get("/api/library/cleanup_candidates")
async def cleanup_candidates(current_user: dict = Depends(get_current_user)):
    """List cache rows that have a local file on disk AND a torrent
    info_hash + addon_id (i.e. they came from a torrent flow and might
    now be cached on debrid). Used by the frontend to drive a sweep:
    for each candidate, ask the addon /debrid_cache_check; if cached,
    fire /api/library/_addon_callback/debrid_cached with delete_local
    to reclaim the disk.

    Sanitized: only the fields the orchestrator needs to drive the
    sweep, no addon credentials.
    """
    out = []
    for key, entry in _stream_cache.items():
        local = entry.get("local_file") or ""
        if not local or not os.path.exists(local):
            continue
        sp = entry.get("source_payload") or {}
        ih = (sp.get("info_hash") or "").strip().lower()
        if len(ih) != 40:
            continue
        addon_id = entry.get("addon_id") or sp.get("addon_id") or ""
        if not addon_id:
            continue
        # ``local_file_size`` lets the frontend compute MB freed
        # after a successful sweep. Best-effort: os.path.getsize can
        # race the file going away (the user deleted it manually
        # between cache-load and now) — fall back to 0 in that case.
        try:
            local_size = os.path.getsize(local)
        except OSError:
            local_size = 0
        out.append({
            "key": key,
            "title": entry.get("track_title") or entry.get("filename") or "",
            "artist": entry.get("track_artist") or "",
            "addon_id": addon_id,
            "info_hash": ih,
            "local_file": local,
            "local_file_size": local_size,
        })
    return {"count": len(out), "candidates": out}


async def _do_promote_stream_url(payload: dict) -> dict:
    """Shared implementation for the addon-callback that promotes a
    cache row from its local-file URL to an addon-supplied stream URL
    (and optionally deletes the local copy).

    The payload contract is addon-agnostic:
        cache_key:      required, identifies the entry
        stream_url:     required, the URL to route the audio element at
        source_label:   optional, becomes entry["source"] for the badge
        mime_type:      optional, copied into entry["mimeType"]
        delete_local:   bool, drops the on-disk file under MEDIA_ROOT
                        when set
    Legacy fields ``debrid_url`` and ``debrid_label`` are accepted as
    fallbacks for the deprecated /_addon_callback/debrid_cached path."""
    from main import _safe_under_roots, _file_serve_safe_roots
    from file_store import MEDIA_ROOT
    cache_key = (payload.get("cache_key") or "").strip()
    stream_url = (payload.get("stream_url") or payload.get("debrid_url") or "").strip()
    source_label = (payload.get("source_label") or payload.get("debrid_label") or "").strip()
    delete_local = bool(payload.get("delete_local"))
    if not cache_key or not stream_url:
        raise HTTPException(400, "cache_key + stream_url required")
    entry = _stream_cache.get(cache_key)
    if not entry:
        return {"ok": False, "reason": "cache entry not found"}
    # Route through /api/audio/proxy so the browser audio element
    # plays the bytes inline. Some upstream CDNs return
    # Content-Disposition: attachment + application/force-download
    # which Chrome / Safari refuse to decode. The proxy URL is
    # HMAC-signed by ``proxy_token.proxy_url_for`` so audio_proxy
    # refuses to fetch URLs that didn't come through an authenticated
    # mint path. Token lifetime: 24h.
    from proxy_token import proxy_url_for
    entry["streamUrl"] = proxy_url_for(stream_url)
    # ``debrid_direct_url`` kept for back-compat with the audio_proxy
    # path that consults it; can be renamed once the proxy is HMAC-
    # gated (P4.53).
    entry["debrid_direct_url"] = stream_url
    if source_label:
        entry["source"] = source_label
    if payload.get("mime_type"):
        entry["mimeType"] = payload["mime_type"]
    local_path = entry.get("local_file") or ""
    deleted = False
    if delete_local and local_path:
        safe = _safe_under_roots(local_path, _file_serve_safe_roots())
        if safe and os.path.exists(safe):
            try:
                os.remove(safe)
                deleted = True
                print(f"[promote-stream] removed local copy: {safe}", flush=True)
                # Walk up empty parents under MEDIA_ROOT so the library
                # tree stays tidy.
                cur = os.path.dirname(safe)
                root = str(MEDIA_ROOT.resolve())
                for _ in range(3):
                    if cur == root or not cur.startswith(root + os.sep): break
                    try:
                        if os.listdir(cur): break
                        os.rmdir(cur)
                    except OSError: break
                    cur = os.path.dirname(cur)
            except Exception as e:
                print(f"[promote-stream] delete failed: {e}", flush=True)
        entry["local_file"] = ""
    _stream_cache[cache_key] = entry
    save_cache()
    # Find the user this entry belongs to (single-user assumption — but
    # the table is keyed by user_id) and persist back.
    for uid, ucache in _user_caches.items():
        if cache_key in ucache:
            ucache[cache_key] = entry
            save_cache_entry(uid, cache_key, entry)
    return {"ok": True, "deleted_local": deleted}


@router.post("/api/library/_addon_callback/{addon_id}/promote_stream_url")
async def addon_callback_promote_stream_url(
    addon_id: str,
    payload: dict,
    request: Request,
    current_user: dict = Depends(get_current_user),
):
    """Generic addon → backend callback that promotes a cache row's
    streamUrl to an addon-supplied URL (typically a debrid CDN) and
    optionally deletes the local file.

    Replaces the legacy /_addon_callback/debrid_cached endpoint. The
    ``addon_id`` path segment is the calling addon's manifest id; we
    don't currently scope mutations by it, but having it on the route
    leaves room for per-addon authorization in the future. Tightens
    the same character allowlist that ``install_addon`` uses so a
    crafted id can't path-traverse.
    """
    if not re.fullmatch(r"[a-zA-Z0-9._-]{1,64}", addon_id):
        raise HTTPException(400, "Invalid addon_id")
    return await _do_promote_stream_url(payload)


@router.post("/api/library/_addon_callback/debrid_cached")
async def addon_callback_debrid_cached(
    payload: dict,
    request: Request,
    current_user: dict = Depends(get_current_user),
):
    """Deprecated alias for /_addon_callback/{addon_id}/promote_stream_url.
    Kept for 0.4 so addons that already ship the old URL keep working.
    Remove in 0.6 once every shipped addon has been updated."""
    return await _do_promote_stream_url(payload)
