"""HTTP proxy for the bundled libtorrent streaming sidecar.

The streaming sidecar listens on ``127.0.0.1:11471`` (configurable via
``AUDIMO_STREAMING_BASE``). Desktop / Tauri can talk to it directly,
but when the user is on their phone via LAN access ``127.0.0.1`` is
the phone's loopback, not the Mac's — there's nothing there.

These endpoints forward the streaming-server's small API surface
(``create`` / ``stats.json`` / ``select`` / ``<file_idx>``) under
``/api/torrent/*`` so the same flow works for both contexts. Auth is
the regular ``X-API-Key`` header for control endpoints; the byte-
streaming endpoint also accepts the api key as a ``?key=`` query
param so HTML5 ``<audio src>`` (which can't carry headers) still
authenticates.

This is intentionally NOT a generic HTTP proxy — the upstream is
hard-pinned to the configured ``AUDIMO_STREAMING_BASE`` and the
infohash path component is constrained to ``[0-9a-f]{40}``. Any
other input shape returns 400 without touching the upstream.
"""
from __future__ import annotations

import os
import re

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse

from auth import get_current_user, require_api_key_query


_STREAMING_BASE = os.environ.get("AUDIMO_STREAMING_BASE", "http://127.0.0.1:11471")
_INFOHASH_RE = re.compile(r"^[0-9a-f]{40}$")
_FILE_IDX_RE = re.compile(r"^\d{1,5}$")


def _validate_infohash(info_hash: str) -> str:
    h = (info_hash or "").lower()
    if not _INFOHASH_RE.match(h):
        raise HTTPException(status_code=400, detail="invalid info_hash")
    return h


router = APIRouter(tags=["torrent-stream"])


@router.post("/api/torrent/{info_hash}/create")
async def torrent_create(
    info_hash: str,
    request: Request,
    _user=Depends(get_current_user),
):
    """Forward engine-create to the streaming sidecar. Body is the
    same JSON the sidecar accepts: ``{magnet, sources, peers}``."""
    ih = _validate_infohash(info_hash)
    body = await request.body()
    async with httpx.AsyncClient(timeout=20) as client:
        try:
            r = await client.post(
                f"{_STREAMING_BASE}/{ih}/create",
                content=body,
                headers={"Content-Type": "application/json"},
            )
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"streaming server unreachable: {e}")
    return Response(content=r.content, status_code=r.status_code,
                    media_type=r.headers.get("content-type", "application/json"))


@router.get("/api/torrent/{info_hash}/stats.json")
async def torrent_stats(info_hash: str, _user=Depends(get_current_user)):
    ih = _validate_infohash(info_hash)
    async with httpx.AsyncClient(timeout=10) as client:
        try:
            r = await client.get(f"{_STREAMING_BASE}/{ih}/stats.json")
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"streaming server unreachable: {e}")
    return Response(content=r.content, status_code=r.status_code,
                    media_type=r.headers.get("content-type", "application/json"))


@router.post("/api/torrent/{info_hash}/select")
async def torrent_select(
    info_hash: str,
    request: Request,
    _user=Depends(get_current_user),
):
    """Tell the sidecar which file_idx the user picked. Body: ``{file_idx}``."""
    ih = _validate_infohash(info_hash)
    body = await request.body()
    async with httpx.AsyncClient(timeout=10) as client:
        try:
            r = await client.post(
                f"{_STREAMING_BASE}/{ih}/select",
                content=body,
                headers={"Content-Type": "application/json"},
            )
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"streaming server unreachable: {e}")
    return Response(content=r.content, status_code=r.status_code,
                    media_type=r.headers.get("content-type", "application/json"))


@router.get("/api/torrent/{info_hash}/{file_idx}")
async def torrent_stream(
    info_hash: str,
    file_idx: str,
    request: Request,
    _user=Depends(require_api_key_query),
):
    """Range-aware byte proxy from the streaming sidecar to the
    browser's ``<audio>`` element. Auth via ``?key=<apiKey>`` query
    param because HTML5 ``<audio src>`` can't carry headers.

    Forwards the client's ``Range`` header verbatim so seek + scrub
    work through the proxy. Status code (200 vs 206) and the upstream
    ``Content-Range`` / ``Content-Length`` get echoed.
    """
    ih = _validate_infohash(info_hash)
    if not _FILE_IDX_RE.match(file_idx):
        raise HTTPException(status_code=400, detail="invalid file_idx")

    range_header = request.headers.get("range") or request.headers.get("Range")
    upstream_headers = {"Range": range_header} if range_header else {}

    client_in = httpx.AsyncClient(timeout=None)
    try:
        req = client_in.build_request(
            "GET",
            f"{_STREAMING_BASE}/{ih}/{file_idx}",
            headers=upstream_headers,
        )
        upstream = await client_in.send(req, stream=True)
    except httpx.HTTPError as e:
        await client_in.aclose()
        raise HTTPException(status_code=502, detail=f"streaming server unreachable: {e}")

    headers = {"Accept-Ranges": "bytes"}
    ct = upstream.headers.get("content-type")
    if ct: headers["Content-Type"] = ct
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
        media_type=ct or "application/octet-stream",
    )
