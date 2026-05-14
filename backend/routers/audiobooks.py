"""Audiobook library CRUD + per-entry local-file streaming.

Audiobook *search* runs in the browser via `orchestrator.searchBooks`
— core no longer fans out `search.audiobooks` server-side. The routes
here are about persisting library rows and serving the on-disk files
the user has saved.
"""
import asyncio
import os
import re
import shutil
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response, StreamingResponse

from auth import get_current_user
from cache_state import _stream_cache, save_cache
from database import (
    get_audiobook_library, save_audiobook_entry, delete_audiobook_entry,
    set_audiobook_local_file, get_db,
    get_user_settings,
)
from file_store import safe_under_roots, file_serve_safe_roots, AUDIOBOOK_STORE
import chapter_detect_job
import download_job

router = APIRouter(tags=["audiobooks"])


@router.get("/api/audiobooks/library")
async def audiobook_library_list(user=Depends(get_current_user)):
    return {"books": get_audiobook_library(user["id"])}


# ── Chapters ─────────────────────────────────────────────────────
#
# M4B (and any MP4-container audiobook) embeds chapter metadata —
# ffprobe extracts it into a {title, start_s, end_s} list. Cached
# per (path, mtime) so we don't re-spawn ffprobe on every request.
import json as _json
import subprocess as _subprocess

_CHAPTERS_CACHE: dict[tuple[str, float], list[dict]] = {}


_AUDIO_EXT = {".mp3", ".m4a", ".m4b", ".mp4", ".flac", ".wav", ".ogg", ".opus", ".aac"}


def _natural_key(name: str) -> list:
    """Sort key that orders 'Chapter 2' before 'Chapter 10' by treating
    runs of digits as integers. Falls back to lowercased text for
    non-digit runs."""
    out = []
    cur = ""
    for c in name:
        if c.isdigit():
            cur += c
        else:
            if cur:
                out.append(int(cur)); cur = ""
            out.append(c.lower())
    if cur:
        out.append(int(cur))
    return out


def _ffprobe_duration(path: str) -> float:
    """Return seconds via ffprobe -show_format. 0.0 on any failure."""
    try:
        proc = _subprocess.run(
            ["ffprobe", "-v", "error", "-print_format", "json",
             "-show_format", "-i", path],
            capture_output=True, timeout=10,
        )
    except (FileNotFoundError, _subprocess.TimeoutExpired):
        return 0.0
    if proc.returncode != 0:
        return 0.0
    try:
        data = _json.loads(proc.stdout or b"{}")
        return float((data.get("format") or {}).get("duration") or 0)
    except (_json.JSONDecodeError, TypeError, ValueError):
        return 0.0


def _ffprobe_title(path: str) -> str:
    """Read the ID3/metadata title tag. Empty string if missing."""
    try:
        proc = _subprocess.run(
            ["ffprobe", "-v", "error", "-print_format", "json",
             "-show_format", "-i", path],
            capture_output=True, timeout=10,
        )
    except (FileNotFoundError, _subprocess.TimeoutExpired):
        return ""
    if proc.returncode != 0:
        return ""
    try:
        data = _json.loads(proc.stdout or b"{}")
        tags = (data.get("format") or {}).get("tags") or {}
        return (tags.get("title") or tags.get("TITLE") or "").strip()
    except _json.JSONDecodeError:
        return ""


def _filename_to_title(name: str) -> str:
    """Filename → human-friendly chapter title. Strips extension and
    leading track-number prefixes ('01 - ', '03_', '12. ', etc.)."""
    import re as _re
    base = os.path.splitext(name)[0]
    return _re.sub(r"^[0-9]{1,4}\s*[-._)\s]+\s*", "", base).strip() or base


def _detect_multifile_chapters(path: str) -> list[dict]:
    """When `path` is one file in a multi-file audiobook (e.g.
    '01 - Chapter One.mp3' alongside '02 - Chapter Two.mp3'), return
    a chapter list synthesized from the sibling files. Each chapter
    points at its own underlying audio file.

    We treat *any* directory containing 2+ audio files as multi-file
    — there's no clean way to distinguish a chaptered book from a
    folder of unrelated tracks, but for the audiobook-detail surface
    that's fine: the user navigated to a known book.
    """
    parent = os.path.dirname(path)
    if not parent or not os.path.isdir(parent):
        return []
    try:
        entries = os.listdir(parent)
    except OSError:
        return []
    files = sorted(
        [
            n for n in entries
            if os.path.splitext(n)[1].lower() in _AUDIO_EXT
            and os.path.isfile(os.path.join(parent, n))
        ],
        key=_natural_key,
    )
    if len(files) < 2:
        return []
    out = []
    cursor = 0.0
    for i, name in enumerate(files):
        full = os.path.join(parent, name)
        dur = _ffprobe_duration(full)
        title = _ffprobe_title(full) or _filename_to_title(name)
        out.append({
            "index": i + 1,
            "title": title,
            "start_s": cursor,
            "end_s": cursor + dur,
            # `path` is what the frontend opens for playback. Present
            # only on multi-file chapters; embedded-chapter rows
            # don't carry it (the player already has the book file).
            "path": full,
        })
        cursor += dur
    return out


def _read_chapters(path: str) -> list[dict]:
    """Chapter list for an audiobook file. Two-step lookup:
       1. ffprobe -show_chapters reads embedded markers (M4B/MP4).
       2. If empty, look at sibling files in the same directory —
          multi-file MP3 audiobooks use one file per chapter.
    Cached per (path, mtime) so we don't re-spawn ffprobe per fetch.
    """
    try:
        st = os.stat(path)
    except OSError:
        return []
    key = (path, st.st_mtime)
    cached = _CHAPTERS_CACHE.get(key)
    if cached is not None:
        return cached

    # Step 1: embedded chapters.
    embedded: list[dict] = []
    try:
        proc = _subprocess.run(
            ["ffprobe", "-v", "error", "-print_format", "json",
             "-show_chapters", "-i", path],
            capture_output=True, timeout=10,
        )
        if proc.returncode == 0:
            data = _json.loads(proc.stdout or b"{}")
            for i, ch in enumerate(data.get("chapters") or []):
                try:
                    start = float(ch.get("start_time") or 0)
                    end = float(ch.get("end_time") or 0)
                except (TypeError, ValueError):
                    continue
                title = ((ch.get("tags") or {}).get("title") or "").strip()
                if not title:
                    title = f"Chapter {i + 1}"
                embedded.append({"index": i + 1, "title": title, "start_s": start, "end_s": end})
    except (FileNotFoundError, _subprocess.TimeoutExpired, _json.JSONDecodeError):
        pass

    if embedded:
        _CHAPTERS_CACHE[key] = embedded
        return embedded

    # Step 2: multi-file detection.
    multi = _detect_multifile_chapters(path)
    _CHAPTERS_CACHE[key] = multi
    return multi


def _audiobook_bookid_for(title: str, author: str) -> str:
    """Mirror the JS-side ``bookId(title, author)`` from AudiobooksView
    so cache-only books resolved by the frontend land on the same
    entry_id this endpoint receives. Without this the chapter
    endpoint 404s for any audiobook the user hasn't explicitly saved
    to ``audiobook_library`` — including every torrent click, since
    the SourcePicker writes to the cache but not to the library DB."""
    import base64, urllib.parse, re as _re
    raw = urllib.parse.quote(f"{title}|{author or ''}")
    b64 = base64.b64encode(raw.encode("utf-8")).decode("ascii")
    return _re.sub(r"[^a-z0-9]", "", b64, flags=_re.IGNORECASE)[:32]


@router.get("/api/audiobooks/library/{entry_id}/chapters")
async def audiobook_chapters(entry_id: str, user=Depends(get_current_user)):
    """Chapter list for an audiobook the user has either saved to
    ``audiobook_library`` or just played through the cache. Sources
    checked in order:

      1. ``audiobook_chapters`` DB rows — AssemblyAI-detected, manual,
         or silence-detected chapters that the user has explicitly
         asked us to find. These outrank embedded markers because
         they're a deliberate user choice.
      2. ffprobe ``-show_chapters`` for embedded markers (M4B chpl,
         MP3 ID3v2 CHAP).
      3. Multi-file detection: sibling audio files in the parent
         directory, treated as one chapter each.

    Each chapter row carries a stable `index` (1-based), a `source`
    tag for UI hinting, and a `multifile` flag — when true the
    player should hit /stream?ch=<index> instead of seeking within
    a single file."""
    books = get_audiobook_library(user["id"])
    book = next((b for b in books if b.get("id") == entry_id), None)
    # Cache-only fallback: torrent / debrid clicks stamp a category=
    # 'audiobook' row in _stream_cache but never create an
    # audiobook_library row, so the lookup above misses. Find the
    # matching cache row by reproducing the JS-side bookId hash and
    # use its local_file (or, for in-flight torrents that haven't
    # been mirrored to ~/Audiobooks yet, the streaming-engine save
    # path under ~/.audimo/streaming/<info_hash>/).
    local = ""
    if book:
        local = book.get("localFile") or ""
    else:
        cache_entry = None
        for entry in _stream_cache.values():
            if entry.get("category") != "audiobook":
                continue
            cid = _audiobook_bookid_for(
                entry.get("track_title") or "",
                entry.get("track_artist") or "",
            )
            if cid == entry_id:
                cache_entry = entry
                local = entry.get("local_file") or ""
                break
        if not cache_entry:
            raise HTTPException(404, "audiobook not found")
        # Torrent-streamed and not yet copied to ~/Audiobooks.
        # Look in the streaming sidecar's save dir for the chosen
        # file so chapters surface as soon as enough metadata +
        # head bytes are on disk for ffprobe to read the chpl atom.
        if not (local and os.path.isfile(local)):
            ih = (cache_entry.get("source_payload") or {}).get("info_hash") or ""
            stream_url = (cache_entry.get("streamUrl") or "").lower()
            if not ih and "/11471/" in stream_url:
                # /11471/<ih>/<file_idx> — pull the ih segment.
                try: ih = stream_url.split("/11471/", 1)[1].split("/", 1)[0]
                except Exception: ih = ""
            ih = (ih or "").lower().strip()
            if ih and len(ih) == 40:
                eng_dir = Path.home() / ".audimo" / "streaming" / ih
                if eng_dir.is_dir():
                    audio_exts = (".m4b", ".m4a", ".mp4", ".mp3", ".flac",
                                  ".aac", ".ogg", ".opus", ".wav")
                    candidate = next(
                        (p for p in eng_dir.rglob("*")
                         if p.is_file() and p.suffix.lower() in audio_exts),
                        None,
                    )
                    if candidate:
                        local = str(candidate)

    # 1. DB-stored chapters (if any).
    with get_db() as conn:
        rows = conn.execute(
            """SELECT index_n, title, start_s, end_s, source
               FROM audiobook_chapters
               WHERE user_id = ? AND book_id = ?
               ORDER BY index_n ASC""",
            (user["id"], entry_id),
        ).fetchall()
    if rows:
        return {
            "chapters": [
                {
                    "index": r["index_n"],
                    "title": r["title"],
                    "start_s": r["start_s"],
                    "end_s": r["end_s"],
                    "source": r["source"],
                    "multifile": False,
                }
                for r in rows
            ],
        }

    # 2a. HTTP multifile (e.g. Internet Archive multi-chapter
    # audiobooks). The addon stashes a `file_list` on the cache row
    # — one entry per remote audio file. Each becomes a virtual
    # multifile chapter; ?ch=N on /stream redirects to that URL.
    if not book:
        for entry in _stream_cache.values():
            if entry.get("category") != "audiobook":
                continue
            cid = _audiobook_bookid_for(
                entry.get("track_title") or "",
                entry.get("track_artist") or "",
            )
            if cid != entry_id:
                continue
            fl = entry.get("file_list") or []
            if fl:
                return {
                    "chapters": [
                        {
                            "index": int(c.get("index") or i + 1),
                            "title": c.get("title") or f"Chapter {i + 1}",
                            "start_s": 0,
                            "end_s": float(c.get("duration_s") or 0),
                            "source": "multifile",
                            "multifile": True,
                        }
                        for i, c in enumerate(fl)
                    ],
                }
            break

    # 2 + 3. File-derived chapters.
    if not local or not os.path.isfile(local):
        return {"chapters": []}
    chapters = _read_chapters(local)
    out = []
    for ch in chapters:
        out.append({
            "index": ch["index"],
            "title": ch["title"],
            "start_s": ch["start_s"],
            "end_s": ch["end_s"],
            "source": "embedded" if "path" not in ch else "multifile",
            "multifile": "path" in ch,
        })
    return {"chapters": out}


@router.post("/api/audiobooks/library/{entry_id}/detect-chapters")
async def audiobook_detect_chapters(entry_id: str, user=Depends(get_current_user)):
    """Kick off an AssemblyAI Auto-Chapters job. Returns a job id;
    progress polled via /api/download/jobs (kind='chapter-detect').

    Requires:
      • An AssemblyAI API key configured in user settings.
      • The book's local_file populated (so we have something to
        upload). Cache-only books need to Download first.
    """
    settings = get_user_settings(user["id"])
    api_key = (settings.get("assemblyai_api_key") or "").strip()
    if not api_key:
        raise HTTPException(400, "AssemblyAI API key not configured — paste one in Settings → Library & sync first")

    books = get_audiobook_library(user["id"])
    book = next((b for b in books if b.get("id") == entry_id), None)
    if not book:
        raise HTTPException(404, "audiobook not found in library")
    local = book.get("localFile") or ""
    if not local or not os.path.isfile(local):
        raise HTTPException(400, "audiobook has no local file — Download it first")

    # Don't double-spawn for the same book.
    existing = download_job.find_active_for("chapter-detect", entry_id)
    if existing:
        return {"job_id": existing.id, "already_running": True}

    job = chapter_detect_job.start_detect(
        user_id=user["id"],
        book_id=entry_id,
        file_path=local,
        api_key=api_key,
        label=f"Chapters for {book.get('title','')}",
    )
    return {"job_id": job.id}


# ── Bookmarks ────────────────────────────────────────────────────
#
# Stored per (user, book). Each row is a position + optional label/
# note. Frontend renders a panel on the audiobook detail page;
# clicking a bookmark seeks to its position. Chapter index is
# captured at create time so an old bookmark still tells you which
# chapter it was made in even if chapter detection later changes.

@router.get("/api/audiobooks/library/{entry_id}/bookmarks")
async def list_bookmarks(entry_id: str, user=Depends(get_current_user)):
    """Bookmarks for a book, oldest-first."""
    with get_db() as conn:
        rows = conn.execute(
            """SELECT id, position_s, chapter_index, title, note, created_at
               FROM audiobook_bookmarks
               WHERE user_id = ? AND book_id = ?
               ORDER BY position_s ASC""",
            (user["id"], entry_id),
        ).fetchall()
    return {"bookmarks": [dict(r) for r in rows]}


@router.post("/api/audiobooks/library/{entry_id}/bookmarks")
async def create_bookmark(entry_id: str, body: dict, user=Depends(get_current_user)):
    """Create a bookmark at the given position. `position_s` is the
    only required field; title/note default to empty."""
    import time as _time
    try:
        pos = float(body.get("position_s") or 0)
    except (TypeError, ValueError):
        raise HTTPException(400, "position_s must be a number")
    if pos < 0:
        raise HTTPException(400, "position_s must be non-negative")
    title = (body.get("title") or "").strip()[:240]
    note = (body.get("note") or "").strip()[:2000]
    chapter_index = body.get("chapter_index")
    try:
        chapter_index = int(chapter_index) if chapter_index is not None else None
    except (TypeError, ValueError):
        chapter_index = None
    with get_db() as conn:
        cur = conn.execute(
            """INSERT INTO audiobook_bookmarks
               (user_id, book_id, position_s, chapter_index, title, note, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (user["id"], entry_id, pos, chapter_index, title, note, int(_time.time())),
        )
        return {"id": cur.lastrowid}


@router.patch("/api/audiobooks/library/{entry_id}/bookmarks/{bookmark_id}")
async def update_bookmark(entry_id: str, bookmark_id: int, body: dict, user=Depends(get_current_user)):
    """Update a bookmark's title/note. Position is intentionally
    immutable — to move it, delete and re-create at the new position."""
    fields = []
    params: list = []
    if "title" in body:
        fields.append("title = ?")
        params.append((body.get("title") or "").strip()[:240])
    if "note" in body:
        fields.append("note = ?")
        params.append((body.get("note") or "").strip()[:2000])
    if not fields:
        return {"updated": 0}
    params.extend([user["id"], entry_id, bookmark_id])
    with get_db() as conn:
        cur = conn.execute(
            f"""UPDATE audiobook_bookmarks SET {', '.join(fields)}
                WHERE user_id = ? AND book_id = ? AND id = ?""",
            params,
        )
        return {"updated": cur.rowcount}


# ── Auto-download to disk ───────────────────────────────────────
#
# Promotes a streamed-only audiobook (cache row, no localFile) to a
# disk-resident library entry. Same machinery as music — fetch the
# stream URL, write to ~/Audiobooks/<author>/<title>/<title>.<ext>,
# update audiobook_library.local_file when done.

_INVALID_FILENAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _safe_filename(name: str, max_len: int = 120) -> str:
    s = _INVALID_FILENAME_CHARS.sub("", name or "").strip().rstrip(".")
    s = re.sub(r"\s+", " ", s)
    return s[:max_len] or "Unknown"


def _resolve_proxy_url(url: str) -> str:
    """Strip Audimo's /api/audio/proxy?url=... wrapper to get the
    real upstream URL for our server-side fetch."""
    try:
        p = urlparse(url)
        if "/api/audio/proxy" in p.path:
            inner = parse_qs(p.query).get("url", [""])[0]
            if inner:
                return unquote(inner)
    except Exception:
        pass
    return url


def _ext_from_url_or_mime(url: str, mime: str) -> str:
    try:
        p = urlparse(url)
        ext = os.path.splitext(p.path)[1].lower()
        if ext and 2 <= len(ext) <= 6:
            return ext
    except Exception:
        pass
    return {
        "audio/mpeg": ".mp3",
        "audio/flac": ".flac",
        "audio/wav": ".wav",
        "audio/aac": ".aac",
        "audio/mp4": ".m4a",
        "audio/ogg": ".ogg",
        "audio/opus": ".opus",
    }.get((mime or "").lower(), ".m4a")


def _book_normkey(title: str, author: str) -> str:
    return f"{(author or '').lower().strip()}|{(title or '').lower().strip()}"


@router.post("/api/audiobooks/library/{entry_id}/download")
async def audiobook_download(entry_id: str, body: dict | None = None, user=Depends(get_current_user)):
    """Start a background HTTP download of the book's audio file
    into ~/Audiobooks/<author>/<title>/. Two source patterns:

      • If `audiobook_library` already has the row (with magnet/
        sourceLink), the addon-side flow already covers torrent
        downloads — don't double-fetch. This endpoint only handles
        the streamed-only case where `localFile` is empty.
      • If the row's localFile is empty AND there's a matching cache
        entry with a streamUrl (e.g. user played an audiobook via
        debrid stream), use that URL.

    Body may carry an explicit `url` to override (frontend can pass
    the resolved stream URL for non-cache cases like fresh search
    results). Falls back to the cache lookup."""
    body = body or {}
    books = get_audiobook_library(user["id"])
    book = next((b for b in books if b.get("id") == entry_id), None)
    if not book:
        raise HTTPException(404, "audiobook not found in library")

    if book.get("localFile") and os.path.isfile(book["localFile"]):
        return {"already_local": True, "local_file": book["localFile"]}

    # Source URL discovery: explicit override → matching cache row → bust.
    url = (body.get("url") or "").strip()
    cache_local = ""
    if not url:
        nk = _book_normkey(book.get("title", ""), book.get("author", ""))
        for entry in _stream_cache.values():
            if entry.get("category") != "audiobook":
                continue
            if _book_normkey(entry.get("track_title") or "", entry.get("track_artist") or "") == nk:
                url = entry.get("stream_url") or entry.get("streamUrl") or ""
                cache_local = entry.get("local_file") or ""
                break
    url = _resolve_proxy_url(url)

    # Already-local fast path. Two routes get us here:
    #   1. The cache row knows about a downloaded copy (cache_local).
    #   2. The "streamUrl" is /api/files/local?path=<P> — Audimo's own
    #      local-file serve URL. Strip the path query and treat as
    #      a local file directly.
    local_hint = cache_local
    if not local_hint and url.startswith("/api/files/local"):
        try:
            qs = parse_qs(urlparse(url).query).get("path", [""])[0]
            local_hint = unquote(qs) if qs else ""
        except Exception:
            local_hint = ""
    if local_hint and os.path.isfile(local_hint):
        # Stamp it into audiobook_library so subsequent loads of the
        # detail page show the file as saved.
        try:
            with get_db() as conn:
                conn.execute(
                    "UPDATE audiobook_library SET local_file = ? WHERE user_id = ? AND id = ?",
                    (local_hint, user["id"], entry_id),
                )
        except Exception:
            pass
        return {"already_local": True, "local_file": local_hint}

    if not url:
        raise HTTPException(
            400,
            "no source URL — start playback once so the addon resolves a stream first",
        )

    # If the URL points at the bundled libtorrent streaming sidecar,
    # there's already a download in flight (the file is being peered
    # into ``~/.audimo/streaming/<ih>/``) and ``_save_torrent_to_library``
    # in main.py copies it into ``~/Audiobooks/<author>/<title>/`` with
    # the source's real extension once playback completes. HTTP-fetching
    # over the same engine would duplicate the bytes and — because this
    # endpoint's URL has no path extension and falls back to the
    # mime→.m4a default — silently produce a parallel ``.m4a`` next to
    # the correct ``.m4b``. Tell the caller to wait for the libtorrent
    # path to finish instead.
    from urllib.parse import urlparse as _urlparse
    _u = _urlparse(url)
    _streaming_hosts = {"127.0.0.1:11471", "localhost:11471"}
    if (_u.netloc in _streaming_hosts):
        raise HTTPException(
            409,
            "torrent already downloading via the bundled streaming server — "
            "the file will appear in your Audiobooks folder when peering completes",
        )

    existing = download_job.find_active_for("audiobook", entry_id)
    if existing:
        return {"job_id": existing.id, "already_running": True}

    author = _safe_filename(book.get("author") or "Unknown Author")
    title = _safe_filename(book.get("title") or "Unknown")
    ext = _ext_from_url_or_mime(url, "")
    dest = str(AUDIOBOOK_STORE / author / title / f"{title}{ext}")

    async def _on_finish(job: download_job.DownloadJob):
        # _run calls us during the "finalizing" phase before flipping
        # to "done"; accept either as the success signal.
        if job.status not in ("finalizing", "done"):
            return
        # Update audiobook_library.local_file so /stream + the
        # detail page pick up the disk-resident copy from now on.
        try:
            with get_db() as conn:
                conn.execute(
                    "UPDATE audiobook_library SET local_file = ? WHERE user_id = ? AND id = ?",
                    (job.dest_path, user["id"], entry_id),
                )
        except Exception as e:
            # Don't bury — the on_finish exception handler in
            # download_job downgrades status to error.
            raise

    j = download_job.start_download(
        kind="audiobook",
        url=url,
        dest_path=dest,
        label=f"{book.get('author','')} — {book.get('title','')}".strip(" —"),
        related_key=entry_id,
        on_finish=_on_finish,
    )
    return {"job_id": j.id, "dest_path": dest}


@router.delete("/api/audiobooks/library/{entry_id}/bookmarks/{bookmark_id}")
async def delete_bookmark(entry_id: str, bookmark_id: int, user=Depends(get_current_user)):
    with get_db() as conn:
        cur = conn.execute(
            """DELETE FROM audiobook_bookmarks
               WHERE user_id = ? AND book_id = ? AND id = ?""",
            (user["id"], entry_id, bookmark_id),
        )
        return {"deleted": cur.rowcount}


@router.post("/api/audiobooks/library")
async def audiobook_library_save(body: dict, user=Depends(get_current_user)):
    """Add or update a book in the library. Requires at least 'id' and 'title'."""
    if not body.get("id") or not body.get("title"):
        raise HTTPException(400, "id and title are required")
    save_audiobook_entry(user["id"], body)
    return {"ok": True}


@router.delete("/api/audiobooks/library/{entry_id}")
async def audiobook_library_delete(entry_id: str, user=Depends(get_current_user)):
    # Also delete local file if it exists; clean up the (now-empty)
    # parent directory so leftover folders don't accumulate.
    books = get_audiobook_library(user["id"])
    for b in books:
        if b["id"] == entry_id and b.get("localFile"):
            try:
                lf = b["localFile"]
                if os.path.exists(lf):
                    os.remove(lf)
                    parent = os.path.dirname(lf)
                    if os.path.isdir(parent) and not os.listdir(parent):
                        os.rmdir(parent)
            except Exception:
                pass
    delete_audiobook_entry(user["id"], entry_id)
    return {"ok": True}


@router.api_route("/api/audiobooks/library/{entry_id}/stream", methods=["GET", "HEAD"])
async def audiobook_library_stream(entry_id: str, request: Request):
    """Stream a locally-stored audiobook file with full Range support.
    No auth required — the audio element can't send custom headers.
    The entry_id scopes access; this endpoint only serves files inside
    the user-visible media roots.

    Optional `?ch=N` (1-indexed) opens the Nth chapter for multi-file
    audiobooks (one file per chapter). Without `ch`, the book's
    primary `local_file` is served (single-file or first chapter)."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT local_file FROM audiobook_library WHERE id = ?", (entry_id,)
        ).fetchone()
    local_file = row["local_file"] if row else ""
    safe_real = safe_under_roots(local_file, file_serve_safe_roots()) if local_file else None

    # HTTP multifile path. When there's no on-disk file but the cache
    # row holds a ``file_list`` (one HTTP URL per chapter — IA's
    # multi-chapter audiobook items, etc.), 302 to the requested
    # chapter's URL so the audio element streams it directly. Without
    # this, multifile-streamed books 404'd on the first click because
    # there's no local file to seek into.
    if not safe_real or not os.path.exists(safe_real):
        ch_param = request.query_params.get("ch")
        cache_entry = None
        for entry in _stream_cache.values():
            if entry.get("category") != "audiobook":
                continue
            cid = _audiobook_bookid_for(
                entry.get("track_title") or "",
                entry.get("track_artist") or "",
            )
            if cid == entry_id:
                cache_entry = entry
                break
        fl = (cache_entry or {}).get("file_list") or []
        if fl:
            try:
                ch_idx = int(ch_param) - 1 if ch_param else 0
            except ValueError:
                raise HTTPException(400, "ch must be an integer")
            if ch_idx < 0 or ch_idx >= len(fl):
                raise HTTPException(404, "chapter out of range")
            target = (fl[ch_idx].get("url") or "").strip()
            if not target:
                raise HTTPException(404, "chapter has no URL")
            return Response(status_code=302, headers={"Location": target})
        raise HTTPException(404, "Local file not found — re-download the audiobook")
    local_file = safe_real

    # Multi-file chapter: resolve via the same chapter list the
    # frontend renders. Re-validate the chapter file is under our
    # safe media roots to keep the "no path traversal" invariant
    # — `_read_chapters` already only walks the parent directory
    # of `local_file`, but checking again here is cheap insurance.
    ch_param = request.query_params.get("ch")
    if ch_param:
        try:
            ch_idx = int(ch_param) - 1
        except ValueError:
            raise HTTPException(400, "ch must be an integer")
        chapters = _read_chapters(local_file)
        if ch_idx < 0 or ch_idx >= len(chapters):
            raise HTTPException(404, "chapter out of range")
        ch_path = chapters[ch_idx].get("path")
        if not ch_path:
            # Embedded-chapter book: ?ch is meaningless. Just serve
            # the main file — frontend should seek to start_s instead.
            pass
        else:
            ch_safe = safe_under_roots(ch_path, file_serve_safe_roots())
            if not ch_safe or not os.path.isfile(ch_safe):
                raise HTTPException(404, "chapter file not found")
            local_file = ch_safe

    file_size = os.path.getsize(local_file)
    ext = os.path.splitext(local_file)[1].lower()
    _mime_map = {
        ".mp3": "audio/mpeg", ".flac": "audio/flac", ".aac": "audio/aac",
        ".m4a": "audio/mp4",  ".m4b": "audio/mp4",  ".mp4": "audio/mp4",
        ".ogg": "audio/ogg",  ".opus": "audio/opus", ".wav": "audio/wav",
    }
    mime = _mime_map.get(ext, "audio/mpeg")

    range_header = request.headers.get("range", "")
    start, end = 0, file_size - 1
    status_code = 200
    if range_header:
        m = re.match(r"bytes=(\d*)-(\d*)", range_header)
        if m:
            rs, re_ = m.group(1), m.group(2)
            start = int(rs) if rs else 0
            end   = int(re_) if re_ else file_size - 1
            end   = min(end, file_size - 1)
            # Reject malformed ranges like ``bytes=1000-100`` so we
            # don't stream a negative content_length downstream.
            if start < 0 or end < start or start >= file_size:
                return Response(
                    status_code=416,
                    headers={"Content-Range": f"bytes */{file_size}"},
                )
            status_code = 206

    content_length = end - start + 1
    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(content_length),
        "Cache-Control": "no-cache",
    }
    if status_code == 206:
        headers["Content-Range"] = f"bytes {start}-{end}/{file_size}"

    # HEAD: respond with metadata only. The frontend HEAD-probes this
    # endpoint to verify the file is still on disk before falling back
    # to redownload, so the body must be skipped without 404'ing.
    if request.method == "HEAD":
        return Response(status_code=status_code, media_type=mime, headers=headers)

    async def generate():
        with open(local_file, "rb") as f:
            f.seek(start)
            remaining = content_length
            while remaining > 0:
                chunk = f.read(min(65536, remaining))
                if not chunk:
                    break
                yield chunk
                remaining -= len(chunk)

    return StreamingResponse(generate(), status_code=status_code, media_type=mime, headers=headers)


# ── /stream/transcoded — fallback for browser-incompatible codecs ──
#
# When the native /stream endpoint serves a file in a codec the
# browser can't decode (E-AC3, AC-3, ALAC, multi-channel surround, …)
# the audio element fails with MediaError code 4. The frontend
# automatically retries against this endpoint, which pipes the file
# through ffmpeg → 2-channel 128 kbps AAC (ADTS framing) and streams
# the result. ffmpeg is required at runtime (it's a documented prereq);
# absence is surfaced as a 500 with a clear message.
#
# Limitations of the streamed-pipe approach:
#  • No HTTP Range support. The browser plays linearly from `start`.
#  • Resume positions are honoured via the `?start=` query param;
#    ffmpeg seeks before transcoding so playback begins at that point.
#    The audio element's `currentTime` is relative to `start`, so the
#    frontend stamps the offset on the track and adds it to the
#    displayed position.
#  • The `ffmpeg` subprocess keeps running until the client disconnects
#    or the file finishes, whichever comes first.
_AUDIOBOOK_BITRATE = "128k"


def _ffmpeg_path() -> str:
    return shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"


@router.api_route(
    "/api/audiobooks/library/{entry_id}/stream/transcoded",
    methods=["GET", "HEAD"],
)
async def audiobook_library_stream_transcoded(
    entry_id: str, request: Request, start: float = 0.0,
):
    # Source resolution: prefer a local file (the library row, then
    # the cache row's stamped path). Fall back to the cache row's
    # streamUrl — ffmpeg can read straight from an HTTP URL, which
    # lets us transcode cache-only audiobooks (Internet Archive,
    # debrid streams) that the browser refuses to decode natively.
    with get_db() as conn:
        row = conn.execute(
            "SELECT local_file FROM audiobook_library WHERE id = ?", (entry_id,)
        ).fetchone()
    local_file = (row["local_file"] if row else "") or ""
    safe_real = safe_under_roots(local_file, file_serve_safe_roots()) if local_file else None
    http_src = ""
    if not safe_real or not os.path.exists(safe_real):
        # Cache-row fallback. Match by the JS-side bookId hash so
        # this lines up with how /chapters resolves the same id.
        for entry in _stream_cache.values():
            if entry.get("category") != "audiobook":
                continue
            cid = _audiobook_bookid_for(
                entry.get("track_title") or "",
                entry.get("track_artist") or "",
            )
            if cid != entry_id:
                continue
            cl = entry.get("local_file") or ""
            cl_safe = safe_under_roots(cl, file_serve_safe_roots()) if cl else None
            if cl_safe and os.path.exists(cl_safe):
                safe_real = cl_safe
                break
            url_candidate = (entry.get("stream_url")
                             or entry.get("streamUrl")
                             or "").strip()
            if url_candidate.startswith(("http://", "https://")):
                http_src = url_candidate
                break
    if not safe_real and not http_src:
        raise HTTPException(
            404,
            "no source to transcode — local file missing and no streaming URL on file"
        )

    headers = {
        "Cache-Control": "no-cache",
    }
    media_type = "audio/mpeg"

    if request.method == "HEAD":
        return Response(status_code=200, media_type=media_type, headers=headers)

    ffmpeg = _ffmpeg_path()
    if not os.path.exists(ffmpeg):
        raise HTTPException(500,
            "ffmpeg not found — install it (brew install ffmpeg) and retry")

    # MP3 (libmp3lame) is the most universally browser-compatible
    # container/codec combo for an unbounded HTTP stream. Raw ADTS-AAC
    # works for the first few seconds in Chromium but the decoder
    # stalls past ~2 s when there's no Content-Length and no MOOV /
    # MP4 init segment. MP3 has self-describing frames and streams
    # cleanly.
    #
    # `-ss` BEFORE `-i` is input-side seek (fast, keyframe-accurate
    # for audio). `-vn` drops video tracks if any (some M4Bs ship
    # a cover image as a video stream). `-ac 2` forces stereo so
    # 5.1 surround down-mixes cleanly. `-re` paces output at the
    # input's real-time rate so we don't fill the kernel pipe buffer
    # in the first 200 ms and then sit idle for the rest of the file.
    # For local files ffmpeg reads the path directly. For HTTP sources
    # we fetch in Python (httpx handles Internet Archive's required
    # Range-on-full-body quirk; ffmpeg's libavformat HTTP demuxer
    # doesn't, and IA returns 500 on Range-less GETs to large files)
    # and pipe the bytes into ffmpeg's stdin.
    args = [ffmpeg, "-hide_banner", "-loglevel", "warning"]
    if safe_real:
        args += [
            "-ss", str(max(0.0, float(start))),
            "-i", safe_real,
        ]
    else:
        # stdin input; -ss after -i is output-side seek (slower, but
        # required when the input is unseekable like a pipe). Most
        # audiobook resumes are within the first few minutes so the
        # extra cost is small.
        args += [
            "-i", "pipe:0",
            "-ss", str(max(0.0, float(start))),
        ]
    args += [
        "-vn",
        "-ac", "2",
        "-c:a", "libmp3lame",
        "-b:a", _AUDIOBOOK_BITRATE,
        "-f", "mp3",
        "pipe:1",
    ]
    stdin_pipe = asyncio.subprocess.PIPE if http_src else None
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdin=stdin_pipe,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    # When pulling from HTTP, run a parallel feeder coroutine that
    # streams bytes from the source into ffmpeg's stdin. Range:
    # bytes=0- coaxes IA's CDN past its no-Range 500.
    feeder_task = None
    if http_src:
        async def feeder():
            import httpx
            try:
                async with httpx.AsyncClient(timeout=httpx.Timeout(30, read=120), follow_redirects=True) as client:
                    headers = {
                        "User-Agent": (
                            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                            "AppleWebKit/605.1.15 (KHTML, like Gecko) "
                            "Version/17.0 Safari/605.1.15"
                        ),
                        "Range": "bytes=0-",
                        "Accept": "*/*",
                    }
                    async with client.stream("GET", http_src, headers=headers) as r:
                        if r.status_code >= 400:
                            print(f"[transcoded] upstream {http_src[:80]} status={r.status_code}", flush=True)
                            return
                        async for chunk in r.aiter_bytes(chunk_size=65536):
                            try:
                                proc.stdin.write(chunk)
                                await proc.stdin.drain()
                            except (BrokenPipeError, ConnectionResetError):
                                return
            except Exception as e:
                print(f"[transcoded] feeder error: {type(e).__name__}: {e}", flush=True)
            finally:
                try:
                    proc.stdin.close()
                except Exception:
                    pass
        feeder_task = asyncio.create_task(feeder())

    async def generate():
        try:
            while True:
                chunk = await proc.stdout.read(65536)
                if not chunk:
                    break
                yield chunk
        finally:
            if feeder_task and not feeder_task.done():
                feeder_task.cancel()
            if proc.returncode is None:
                try:
                    proc.kill()
                    await proc.wait()
                except Exception:
                    pass

    return StreamingResponse(generate(), status_code=200, media_type=media_type, headers=headers)


@router.post("/api/audiobooks/library/{entry_id}/set_file")
async def audiobook_library_set_file(entry_id: str, body: dict, user=Depends(get_current_user)):
    """Manually set (or clear) the local_file path for a library entry."""
    local_file = body.get("localFile", "")
    set_audiobook_local_file(user["id"], entry_id, local_file)
    return {"ok": True}


@router.post("/api/audiobooks/library/{entry_id}/save_download")
async def audiobook_library_save_download(entry_id: str, body: dict, user=Depends(get_current_user)):
    """Permanent-save snapshotting is owned by addons now — when an
    addon completes a permanent-mode fetch the resulting on-disk file
    is referenced by the cache entry's ``addon_local_file`` field and
    core serves it via the standard library/stream path. This endpoint
    is a stub kept for legacy-client compatibility."""
    return {"ok": False, "queued": False,
            "note": "Permanent download copy is owned by addons; nothing to do here."}
