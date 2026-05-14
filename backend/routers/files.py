"""File ingest, file serving, audio proxy, and cover serving.

The audio proxy strips the ``application/force-download`` headers debrid
CDNs return so the HTML5 audio element will play the bytes inline. The
local-files endpoint enforces a media-roots allowlist so it can't be
abused to serve arbitrary files the process can read. Cover images live
under ``backend/covers/`` and are content-addressed by md5(cache_key).
"""
import hashlib
import os
import re
import uuid
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile

from auth import get_current_user
from cache_state import (
    _stream_cache,
    save_cache,
)
from database import save_cache_entry
from file_store import (
    UPLOAD_AUDIO_EXTS, UPLOAD_MIME_MAP, UPLOAD_STORE,
)

router = APIRouter(tags=["files"])

# Covers live under backend/covers/. Anchor on the package dir so this
# works the same way regardless of which file the resolution happens in.
BACKEND_DIR = Path(__file__).resolve().parent.parent
COVERS_DIR = BACKEND_DIR / "covers"


@router.post("/api/uploads/audio")
async def upload_audio(file: UploadFile = File(...), current_user: dict = Depends(get_current_user)):
    """Accept a user-uploaded audio file and register it as a permanent local entry.

    The file is moved into the per-user upload store (``CACHE_DIR/uploads/<user_id>/``)
    and registered in the global stream cache as ``type='upload'`` with default
    metadata derived from the filename. Metadata can then be edited via the
    standard /api/cache/update endpoint exactly like any other cache entry.
    """
    filename = file.filename or "upload"
    ext = os.path.splitext(filename)[1].lower()
    if ext not in UPLOAD_AUDIO_EXTS:
        allowed = ", ".join(sorted(e.lstrip(".") for e in UPLOAD_AUDIO_EXTS))
        raise HTTPException(400, f"Unsupported audio format. Allowed: {allowed}")

    # Sanitize and store under the user's upload directory
    user_dir = UPLOAD_STORE / str(current_user["id"])
    user_dir.mkdir(parents=True, exist_ok=True)
    safe_base = re.sub(r"[^a-zA-Z0-9._ -]", "_", os.path.splitext(filename)[0])[:80] or "upload"
    # Make the on-disk name unique to avoid clobbering existing uploads
    unique = uuid.uuid4().hex[:8]
    dest_name = f"{safe_base}__{unique}{ext}"
    dest_path = user_dir / dest_name

    try:
        with open(dest_path, "wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)
    except Exception as e:
        try:
            if dest_path.exists():
                dest_path.unlink()
        except Exception:
            pass
        raise HTTPException(500, f"Failed to save upload: {e}")

    # Best-effort title derivation: "01 - Artist - Title.mp3" → "Artist - Title"
    base = os.path.splitext(filename)[0]
    base = re.sub(r"^[0-9]+\s*[\.\-_]\s*", "", base).strip()
    title = base
    artist = ""
    if " - " in base:
        parts = [p.strip() for p in base.split(" - ", 1)]
        if len(parts) == 2 and parts[0]:
            artist, title = parts[0], parts[1]

    entry = {
        "type": "upload",
        "local_file": str(dest_path),
        "filename": dest_name,
        "track_title": title,
        "track_artist": artist,
        "track_album": "",
        "albumCover": None,
        "mimeType": UPLOAD_MIME_MAP.get(ext, "audio/mpeg"),
        "source": "Upload",
    }
    # Keys must be unique per upload (different from artist|title hash) so
    # multiple uploads of the same song don't collide.
    key = hashlib.md5(f"upload|{current_user['id']}|{dest_name}".encode()).hexdigest()
    _stream_cache[key] = entry
    save_cache()
    save_cache_entry(current_user["id"], key, entry)

    return {
        "ok": True,
        "key": key,
        "entry": {
            "key": key,
            "track_title": entry["track_title"],
            "track_artist": entry["track_artist"],
            "track_album": entry["track_album"],
            "albumCover": entry["albumCover"],
            "filename": entry["filename"],
            "type": "upload",
            "source": "Upload",
            "local_file": entry["local_file"],
        },
    }


@router.get("/api/audio/proxy")
async def audio_proxy(
    request: Request,
    url: str = Query(...),
    exp: int = Query(0),
    t: str = Query(""),
):
    """Proxy an addon-supplied audio URL with rewritten headers so the
    HTML5 audio element will play it inline.

    Why this exists: some upstream CDNs return
    ``Content-Type: application/force-download`` +
    ``Content-Disposition: attachment``. Both signal "download to
    disk" — Chrome / Safari refuse to decode media with that
    combination. The bytes are valid mp3 / flac / etc., the browser
    just won't play them.

    We strip the bad headers, set Content-Type from the file
    extension, forward the client's Range header, and propagate the
    upstream 200/206 status. Adds one network hop but every byte
    still flows through the local backend, so latency is LAN-fast.

    Auth: HTML5 ``<audio src>`` can't carry an Authorization header,
    so we use an HMAC-signed token instead. ``exp`` + ``t`` must
    match ``proxy_token.mint(url)`` — only URLs the backend signed
    via an authenticated mint path (addon callback, audiobook save)
    will be fetched. This replaces the previous debrid-host-suffix
    allowlist (which was both addon-specific and bypassable via
    debrid-controlled subdomains).
    """
    from fastapi.responses import StreamingResponse, Response
    from proxy_token import verify as verify_token
    if len(url) > 4096:
        return Response(status_code=414, content=b"url too long")
    try:
        parsed = httpx.URL(url)
    except Exception:
        return Response(status_code=400)
    if parsed.scheme not in ("http", "https"):
        return Response(status_code=400, content=b"scheme not allowed")
    if not verify_token(url, exp, t):
        return Response(status_code=403, content=b"invalid or expired proxy token")
    last_dot = url.rfind(".")
    ext = url[last_dot + 1:].split("?")[0].lower() if last_dot >= 0 else "mp3"
    MIME = {
        "flac": "audio/flac", "mp3": "audio/mpeg", "ogg": "audio/ogg",
        "opus": "audio/opus", "m4a": "audio/mp4", "m4b": "audio/mp4",
        "aac": "audio/aac", "wav": "audio/wav",
    }
    mime = MIME.get(ext, "audio/mpeg")
    range_header = request.headers.get("range") or request.headers.get("Range")
    upstream_headers = {"Range": range_header} if range_header else {}

    # follow_redirects=False: the host-suffix allowlist above only
    # checks the FIRST hop. A 302 from a real debrid CDN to a private
    # host (LAN, loopback) would otherwise pivot SSRF. Surface 3xx as
    # 502 to the caller — debrid CDNs never legitimately redirect for
    # signed download URLs.
    client_in = httpx.AsyncClient(timeout=None, follow_redirects=False)
    try:
        # `send` + `stream=True`-equivalent so we can read status/headers
        # before yielding the body. Don't use the `async with` context;
        # the StreamingResponse generator owns the lifetime.
        req = client_in.build_request("GET", url, headers=upstream_headers)
        upstream = await client_in.send(req, stream=True)
    except Exception as e:
        await client_in.aclose()
        return Response(status_code=502, content=f"proxy connect error: {e}".encode())

    headers = {"Content-Type": mime, "Accept-Ranges": "bytes"}
    cl = upstream.headers.get("content-length")
    if cl: headers["Content-Length"] = cl
    cr = upstream.headers.get("content-range")
    if cr: headers["Content-Range"] = cr

    async def gen():
        try:
            async for chunk in upstream.aiter_bytes(chunk_size=64 * 1024):
                yield chunk
        finally:
            await upstream.aclose()
            await client_in.aclose()

    return StreamingResponse(
        gen(),
        status_code=upstream.status_code,
        headers=headers,
        media_type=mime,
    )


@router.get("/api/files/local")
async def files_local(request: Request, path: str = Query(...)):
    """Serve a local audio file by absolute path.

    No auth required — HTML5 ``<audio src>`` can't carry custom
    headers, so we can't require ``X-API-Key`` here. Same shape as
    the audiobook /stream endpoint below the path-traversal check.

    Defense in depth:
      * Host-allowlist middleware (main.py) restricts callers to
        loopback in local-only mode, or the user's explicit
        LAN/Tailscale hostname in remote mode. DNS-rebound browser
        tabs on attacker domains can't reach this endpoint.
      * ``_safe_under_roots`` realpath-checks the requested path
        against the user's known media roots (``~/Music/Audimo``,
        ``~/Audiobooks``, ``~/Podcasts``). Anything outside is 403.
      * Only known audio extensions get a non-default MIME type;
        non-audio extensions still serve but read as octet-stream.

    Worst case from a misconfigured remote: an attacker who knows
    the exact path to a file in the user's media roots can stream
    that file. Bounded.
    """
    from fastapi.responses import FileResponse, Response, StreamingResponse
    import shutil
    import asyncio
    from main import _safe_under_roots, _file_serve_safe_roots
    real = _safe_under_roots(path, _file_serve_safe_roots())
    if not real:
        return Response(status_code=403)
    if not os.path.exists(real):
        return Response(status_code=404)
    last_dot = real.rfind(".")
    ext = real[last_dot+1:].lower() if last_dot >= 0 else "mp3"
    MIME = {
        "flac": "audio/flac", "mp3": "audio/mpeg", "ogg": "audio/ogg",
        "opus": "audio/opus", "m4a": "audio/mp4", "m4b": "audio/mp4",
        "mp4": "audio/mp4", "aac": "audio/aac", "wav": "audio/wav",
    }
    mime = MIME.get(ext, "audio/mpeg")
    # FLAC is supported natively by every modern browser (Chrome,
    # Safari, Firefox, Edge). Transcoding it through ffmpeg adds 5+ s
    # to first-byte (long enough that the audio element times out)
    # AND degrades quality (lossless → 320 kbps mp3) for no benefit.
    # `m4b` is just an MP4 audio container with the audiobook
    # extension — every browser plays it the same as `m4a`. Without
    # this, multi-GB Harry-Potter-style audiobooks fell into the
    # ffmpeg transcoding path below, which returns a chunked
    # StreamingResponse with no Content-Length / no range support, so
    # the audio element couldn't read the end-of-file moov atom
    # (where M4B duration lives) and the buffering spinner spun
    # forever.
    BROWSER_NATIVE = {"mp3", "ogg", "opus", "m4a", "m4b", "mp4", "aac", "flac", "wav"}
    if ext not in BROWSER_NATIVE:
        ffmpeg_path = shutil.which("ffmpeg")
        if ffmpeg_path:
            async def transcode():
                proc = await asyncio.create_subprocess_exec(
                    ffmpeg_path, "-i", real, "-f", "mp3", "-ab", "320k", "-vn", "pipe:1",
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
                try:
                    while True:
                        chunk = await proc.stdout.read(65536)
                        if not chunk:
                            break
                        yield chunk
                finally:
                    try: proc.kill()
                    except Exception: pass
                    try: await proc.wait()
                    except Exception: pass
            return StreamingResponse(transcode(), media_type="audio/mpeg")

    # HTTP Range support. Without this, every seek in a multi-GB M4B
    # audiobook would re-download the whole file from byte 0 — the
    # M4B's `moov` atom (containing duration + sample tables) lives at
    # the *end* of the file, so iOS Safari / Chrome's first request
    # for an MP4 audio is "give me the last 256 KB" via Range. Without
    # 206 support that comes back as the full 3 GB, browser gives up.
    file_size = os.path.getsize(real)
    range_header = request.headers.get("range") or request.headers.get("Range")
    if range_header:
        m = re.match(r"bytes=(\d+)-(\d*)", range_header.strip())
        if m:
            start = int(m.group(1))
            end = int(m.group(2)) if m.group(2) else file_size - 1
            if start >= file_size:
                return Response(status_code=416, headers={"Content-Range": f"bytes */{file_size}"})
            end = min(end, file_size - 1)
            length = end - start + 1

            def _read_range():
                with open(real, "rb") as f:
                    f.seek(start)
                    remaining = length
                    while remaining > 0:
                        chunk = f.read(min(64 * 1024, remaining))
                        if not chunk:
                            break
                        remaining -= len(chunk)
                        yield chunk

            return StreamingResponse(
                _read_range(),
                status_code=206,
                media_type=mime,
                headers={
                    "Content-Length": str(length),
                    "Content-Range": f"bytes {start}-{end}/{file_size}",
                    "Accept-Ranges": "bytes",
                },
            )
    return FileResponse(
        real, media_type=mime,
        headers={"Accept-Ranges": "bytes", "Content-Length": str(file_size)},
    )


@router.get("/api/covers/{filename}")
async def serve_cover(filename: str):
    from fastapi.responses import FileResponse
    # Covers are written by `cache_upload_cover` as `<md5hex>.<ext>`. Anything
    # else — path separators, `..`, leading dots, unexpected extensions — is
    # rejected before touching the filesystem so a request like
    # `/api/covers/..%2F..%2Fetc%2Fpasswd` can't escape the covers dir.
    if not re.fullmatch(r"[0-9a-f]{32}\.[a-z0-9]{1,6}", filename or ""):
        raise HTTPException(404, "Cover not found")
    path = COVERS_DIR / filename
    if not path.exists():
        raise HTTPException(404, "Cover not found")
    return FileResponse(str(path))
