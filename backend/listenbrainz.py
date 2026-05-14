"""ListenBrainz scrobble submission.

Opt-in: only submits when the user has set a token in user_settings
(empty token = silent no-op). The token is whatever the user copies
out of https://listenbrainz.org/profile — passed through verbatim as
``Authorization: Token <token>``.

ListenBrainz spec: a "single" listen should be submitted once a user
has played >50% of a track or >4 minutes, whichever comes first. The
threshold check lives in the frontend; this module just submits what
it's given.

Scope of this module: best-effort, never raises. All errors get logged
and swallowed so a failed scrobble can't break playback.
"""

from __future__ import annotations

import time
from typing import Optional

import httpx

_LB_BASE = "https://api.listenbrainz.org/1"
# Static User-Agent — no user identifiers, no install-specific tokens.
# Bumped to match the user-facing app version. Matches ListenBrainz
# guidelines: "Set a User-Agent like AppName/Version (contact-info)"
# so they can reach out about an abusive client without needing to
# fingerprint individual users.
_USER_AGENT = "Audimo/0.4 ( https://github.com/audaro/audimo )"


def _track_metadata(
    title: str,
    artist: str,
    album: str = "",
    recording_mbid: str = "",
) -> dict:
    """Build the track_metadata dict ListenBrainz expects.

    `additional_info.recording_mbid` is a strong-match signal for
    ListenBrainz's track-resolution pipeline (so listens credit the
    right recording even when title/artist strings vary slightly).
    """
    md: dict = {
        "track_name": title,
        "artist_name": artist,
    }
    if album:
        md["release_name"] = album
    if recording_mbid:
        md["additional_info"] = {"recording_mbid": recording_mbid}
    return md


async def submit_listen(
    token: str,
    title: str,
    artist: str,
    *,
    album: str = "",
    recording_mbid: str = "",
    listened_at: Optional[int] = None,
    timeout: float = 8.0,
) -> bool:
    """Submit a "single" listen. Returns True on success, False on any
    error (including missing token, missing required fields)."""
    token = (token or "").strip()
    title = (title or "").strip()
    artist = (artist or "").strip()
    if not token or not title or not artist:
        return False
    if listened_at is None:
        listened_at = int(time.time())
    payload = {
        "listen_type": "single",
        "payload": [
            {
                "listened_at": listened_at,
                "track_metadata": _track_metadata(
                    title, artist, album, recording_mbid
                ),
            }
        ],
    }
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.post(
                f"{_LB_BASE}/submit-listens",
                json=payload,
                headers={
                    "Authorization": f"Token {token}",
                    "User-Agent": _USER_AGENT,
                },
            )
        if r.status_code != 200:
            print(
                f"[listenbrainz] submit failed: HTTP {r.status_code} — {r.text[:200]}",
                flush=True,
            )
            return False
        return True
    except Exception as e:
        print(f"[listenbrainz] submit error: {e}", flush=True)
        return False


async def validate_token(token: str, *, timeout: float = 6.0) -> Optional[str]:
    """Verify a token by hitting ListenBrainz's `validate-token` endpoint.

    Returns the user's ListenBrainz username on success, None on a bad
    token or any error. Used by the settings UI to give immediate
    feedback when the user pastes a token.
    """
    token = (token or "").strip()
    if not token:
        return None
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.get(
                f"{_LB_BASE}/validate-token",
                headers={
                    "Authorization": f"Token {token}",
                    "User-Agent": _USER_AGENT,
                },
            )
        if r.status_code != 200:
            return None
        data = r.json() or {}
        if not data.get("valid"):
            return None
        return data.get("user_name") or None
    except Exception:
        return None
