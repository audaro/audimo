"""External catalog search endpoints.

Deezer (artists / tracks / artist-info) is a clean public API and the
only catalog source the native app talks to directly. Streaming
sources (SoundCloud / YouTube / Bandcamp) used to live here too;
they're now exclusively handled by the optional ``audimo-streamers``
addon.
"""
import time as _time

import httpx
from fastapi import APIRouter, Depends, Query, Response

from auth import get_current_user

router = APIRouter(tags=["search"])

DZ_BASE = "https://api.deezer.com"

# Deezer artist-photo cache. 24h TTL — artist photos rarely change.
_ARTIST_PHOTO_CACHE: dict[str, tuple[str | None, float]] = {}
_ARTIST_PHOTO_TTL = 24 * 3600.0


async def _fetch_deezer_artist_photo(name: str) -> str | None:
    try:
        async with httpx.AsyncClient(timeout=6) as client:
            r = await client.get(
                f"{DZ_BASE}/search/artist",
                params={"q": name, "limit": 1},
            )
            if r.status_code != 200:
                return None
            data = (r.json() or {}).get("data") or []
            if not data:
                return None
            a = data[0]
            url = a.get("picture_xl") or a.get("picture_medium") or a.get("picture")
            return url if isinstance(url, str) and url.startswith("http") else None
    except Exception:
        return None


@router.get("/api/artist-photo")
async def artist_photo(
    response: Response,
    name: str = "",
    current_user: dict = Depends(get_current_user),
):
    """Resolve an artist name to a Deezer artist photo URL (picture_xl).
    Cache-Control: the in-memory ``_ARTIST_PHOTO_CACHE`` already
    dedupes per-process; the response header lets the browser skip
    the round-trip entirely for repeat lookups within the window."""
    key = (name or "").strip().lower()
    response.headers["Cache-Control"] = "public, max-age=3600, stale-while-revalidate=86400"
    if not key:
        return {"url": None}
    now = _time.time()
    cached = _ARTIST_PHOTO_CACHE.get(key)
    if cached and (now - cached[1]) < _ARTIST_PHOTO_TTL:
        return {"url": cached[0]}
    url = await _fetch_deezer_artist_photo(name)
    _ARTIST_PHOTO_CACHE[key] = (url, now)
    return {"url": url}


_AB_SEARCH_CACHE: dict[str, tuple[list, float]] = {}
_AB_SEARCH_TTL = 3600.0

_SKIP_PHRASES = {
    "collection", "omnibus", "box set", "complete works", "collected",
    "trilogy", "anthology", "bundle", "compendium", "selected works",
    "best of", "study guide", "book analysis", "summaries", "summary",
    "cliff notes", "sparknotes", "book review", "analysis of", "analysis",
    "guide for", "guide to", "part 2", "part ii", "part iii",
    "book 2", "book 3", "sequel", " edition",
}

import re as _re
_ASCII_RE = _re.compile(r'^[\x00-\x7F]+$')
_SEQUEL_RE = _re.compile(r'\s+(ii|iii|iv|2|3|4)\s*$')


_SMART_QUOTES = str.maketrans({
    "‘": "'",  # left single
    "’": "'",  # right single (iOS autocorrect default)
    "‚": "'",  # low-9
    "‛": "'",  # high-reversed
    "“": '"',  # left double
    "”": '"',  # right double
    "„": '"',
    "′": "'",  # prime
    "´": "'",  # acute accent
    "`": "'",  # grave accent
})


def _norm_title(t: str) -> str:
    # Smart-quote fold first: iOS autocorrects ' → ’ in queries, but
    # iTunes / ABB / etc. carry plain ASCII ' in their titles. Without
    # this, "I’m Glad My Mom Died" (curly) failed to match the result
    # "I'm Glad My Mom Died (Unabridged)" (straight) and the audiobook
    # search came back empty.
    t = (t or "").translate(_SMART_QUOTES).lower().strip()
    for article in ("the ", "a ", "an "):
        if t.startswith(article):
            t = t[len(article):]
    t = _re.split(r'\s*[:\-–]\s*', t)[0].strip()
    return t


async def _search_itunes_audiobooks(query: str, limit: int) -> list:
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            r = await client.get(
                "https://itunes.apple.com/search",
                params={
                    "term": query,
                    "entity": "audiobook",
                    # Fetch more than needed — filtering + dedup reduces the pool
                    "limit": 50,
                    "country": "us",
                },
            )
            if r.status_code != 200:
                return []
            results = (r.json() or {}).get("results") or []
            # Normalise query for relevance filtering
            norm_q = _norm_title(query)
            books = []
            seen_titles: set[str] = set()
            for item in results:
                title = (item.get("collectionName") or item.get("trackName") or "").strip()
                if not title:
                    continue
                # Drop non-English / non-ASCII titles and titles with brackets
                # (e.g. "Kamerat Napoleon [Animal Farm]" — foreign edition)
                if not _ASCII_RE.match(title) or "[" in title:
                    continue
                title_lower = title.lower()
                if any(w in title_lower for w in _SKIP_PHRASES):
                    continue
                norm = _norm_title(title)
                # Only keep titles that start with the query — filters out
                # "Bumpy Ride to Animal Farm", "Cold Comfort Farm", etc.
                if not norm.startswith(norm_q):
                    continue
                # Filter sequels: norm ends with " ii", " iii", " 2", etc.
                if _SEQUEL_RE.search(norm):
                    continue
                # Dedup by normalised title — collapses editions into the first
                # (most popular) iTunes result, which has the best cover.
                if norm in seen_titles:
                    continue
                seen_titles.add(norm)
                author = (item.get("artistName") or "").strip()
                cover = (item.get("artworkUrl100") or item.get("artworkUrl60") or "")
                if cover:
                    cover = cover.replace("100x100bb", "600x600bb").replace("60x60bb", "600x600bb")
                year = 0
                release = item.get("releaseDate") or ""
                if len(release) >= 4:
                    try:
                        year = int(release[:4])
                    except ValueError:
                        pass
                books.append({"title": title, "author": author, "cover": cover, "year": year})
                if len(books) >= limit:
                    break
            return books
    except Exception:
        return []


@router.get("/api/search/audiobooks")
async def search_audiobooks(
    q: str = "",
    limit: int = 10,
    current_user: dict = Depends(get_current_user),
):
    key = f"{(q or '').strip().lower()}:{limit}"
    if not key.rstrip(":0"):
        return {"books": []}
    now = _time.time()
    cached = _AB_SEARCH_CACHE.get(key)
    if cached and (now - cached[1]) < _AB_SEARCH_TTL:
        return {"books": cached[0]}
    books = await _search_itunes_audiobooks((q or "").strip(), limit)
    _AB_SEARCH_CACHE[key] = (books, now)
    return {"books": books}


@router.get("/api/search/artists")
async def search_artists(
    q: str = Query(...),
    limit: int = 12,
    current_user: dict = Depends(get_current_user),
):
    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"{DZ_BASE}/search/artist",
            params={"q": q, "limit": limit},
            timeout=10,
        )
        r.raise_for_status()
        data = r.json()
        artists = []
        for a in data.get("data", []):
            artists.append({
                "id": str(a.get("id")),
                "name": a.get("name"),
                "picture": a.get("picture_medium") or a.get("picture"),
                "nb_fan": a.get("nb_fan", 0),
                "nb_album": a.get("nb_album", 0),
                "tracklist": a.get("tracklist"),
            })
        return {"artists": artists, "total": data.get("total", 0)}


@router.get("/api/search/tracks")
async def search_tracks(
    q: str = Query(...),
    limit: int = 30,
    current_user: dict = Depends(get_current_user),
):
    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"{DZ_BASE}/search/track",
            params={"q": q, "limit": limit},
            timeout=10,
        )
        r.raise_for_status()
        data = r.json()
        tracks = []
        for t in data.get("data", []):
            tracks.append({
                "id": str(t.get("id")),
                "title": t.get("title"),
                "artist": t.get("artist", {}).get("name", ""),
                "artist_id": str(t.get("artist", {}).get("id", "")),
                "album": t.get("album", {}).get("title", ""),
                "album_cover": t.get("album", {}).get("cover_medium") or t.get("album", {}).get("cover"),
                "duration": t.get("duration", 0),
                "preview": t.get("preview"),
                "rank": t.get("rank", 0),
            })
        return {"tracks": tracks, "total": data.get("total", 0)}


@router.get("/api/artist/{artist_id}/tracks")
async def artist_tracks(artist_id: str, limit: int = 50, current_user: dict = Depends(get_current_user)):
    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"{DZ_BASE}/artist/{artist_id}/top",
            params={"limit": limit},
            timeout=10,
        )
        r.raise_for_status()
        data = r.json()
        tracks = []
        for t in data.get("data", []):
            tracks.append({
                "id": str(t.get("id")),
                "title": t.get("title"),
                "artist": t.get("artist", {}).get("name", ""),
                "artist_id": str(t.get("artist", {}).get("id", "")),
                "album": t.get("album", {}).get("title", ""),
                "album_cover": t.get("album", {}).get("cover_medium") or t.get("album", {}).get("cover"),
                "duration": t.get("duration", 0),
                "preview": t.get("preview"),
                "rank": t.get("rank", 0),
            })
        return {"tracks": tracks, "total": len(tracks)}


@router.get("/api/artist/{artist_id}/albums")
async def artist_albums(artist_id: str, limit: int = 50, current_user: dict = Depends(get_current_user)):
    """Discography for an artist. Used by the artist detail page to
    render the albums grid alongside top tracks."""
    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"{DZ_BASE}/artist/{artist_id}/albums",
            params={"limit": limit},
            timeout=10,
        )
        r.raise_for_status()
        data = r.json()
        albums = []
        for a in data.get("data", []):
            albums.append({
                "id": str(a.get("id")),
                "title": a.get("title"),
                "cover": a.get("cover_medium") or a.get("cover"),
                "release_date": a.get("release_date", ""),
                "nb_tracks": a.get("nb_tracks", 0),
                "type": a.get("record_type", ""),
            })
        return {"albums": albums, "total": len(albums)}


@router.get("/api/artist/{artist_id}/info")
async def artist_info(artist_id: str, current_user: dict = Depends(get_current_user)):
    async with httpx.AsyncClient() as client:
        r = await client.get(f"{DZ_BASE}/artist/{artist_id}", timeout=10)
        r.raise_for_status()
        a = r.json()
        return {
            "id": str(a.get("id")),
            "name": a.get("name"),
            "picture": a.get("picture_xl") or a.get("picture_medium"),
            "nb_fan": a.get("nb_fan", 0),
            "nb_album": a.get("nb_album", 0),
        }


