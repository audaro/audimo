"""Podcasts — Phase 1a thin slice.

Subscriptions are RSS feeds the user pastes in (paste-by-URL only for
now; iTunes search discovery lands in 1b). We parse RSS with stdlib
xml.etree to avoid pulling in feedparser — podcast feeds are well-formed
XML with a small, stable subset of tags (channel/item, plus the
``itunes:`` namespace for artwork + duration).

Endpoints:
  POST /api/podcasts/subscribe        body: {"feed_url": "..."}
  GET  /api/podcasts                  → {"podcasts": [...]}
  GET  /api/podcasts/{id}             → podcast + episodes (auto-refresh if stale)
  POST /api/podcasts/{id}/refresh     force-refresh feed
  DELETE /api/podcasts/{id}           unsubscribe (cascades episodes)

Playback piggybacks on the standard player: the episode's ``audio_url``
is the streamUrl. No download/played-state in this phase.
"""
import hashlib
import re
import time
# defusedxml.ElementTree mirrors xml.etree.ElementTree's API but
# blocks DTD/external-entity expansion. Python 3.7.1+'s stdlib
# ElementTree disables those by default, but defusedxml gives an
# explicit, audited belt-and-suspenders against malicious feeds —
# RSS/OPML payloads are user-supplied URLs, well within "untrusted
# XML" territory.
import defusedxml.ElementTree as ET
from email.utils import parsedate_to_datetime

import asyncio
from xml.sax.saxutils import escape as _xml_escape

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response

from auth import get_current_user
from database import (
    list_podcasts, get_podcast, upsert_podcast, delete_podcast,
    list_podcast_episodes, replace_podcast_episodes,
    set_podcast_episode_progress, get_podcast_episode,
    set_podcast_episode_local_file, set_podcast_auto_download,
    set_podcast_auto_cleanup, mark_podcast_seen,
    get_db as _get_db,
)
from file_store import PODCAST_STORE, _safe_slug
import download_job
import os
from pathlib import Path

router = APIRouter(tags=["podcasts"])

# Feeds get auto-refreshed when the user opens a podcast detail page
# more than this many seconds after the last refresh. Force-refresh
# (POST /refresh) ignores this and always fetches.
STALE_AFTER_S = 15 * 60

_NS = {
    "itunes": "http://www.itunes.com/dtds/podcast-1.0.dtd",
    "atom": "http://www.w3.org/2005/Atom",
    "content": "http://purl.org/rss/1.0/modules/content/",
}


def _pid(feed_url: str) -> str:
    return hashlib.sha1(feed_url.strip().encode("utf-8")).hexdigest()[:16]


def _eid(podcast_id: str, guid: str, fallback: str) -> str:
    seed = guid or fallback
    return hashlib.sha1(f"{podcast_id}|{seed}".encode("utf-8")).hexdigest()[:24]


def _text(el, tag: str, ns: dict | None = None) -> str:
    if el is None:
        return ""
    found = el.find(tag, ns) if ns else el.find(tag)
    if found is None:
        return ""
    return (found.text or "").strip()


def _parse_duration(s: str) -> int:
    """iTunes <itunes:duration> can be either an integer (seconds) or
    HH:MM:SS / MM:SS. Returns seconds, 0 on parse failure."""
    if not s:
        return 0
    s = s.strip()
    if s.isdigit():
        return int(s)
    parts = s.split(":")
    try:
        parts = [int(p) for p in parts]
    except ValueError:
        return 0
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    if len(parts) == 2:
        return parts[0] * 60 + parts[1]
    return 0


def _parse_pub_date(s: str) -> int:
    """RFC 2822 timestamp → unix epoch. 0 on parse failure."""
    if not s:
        return 0
    try:
        return int(parsedate_to_datetime(s).timestamp())
    except (TypeError, ValueError):
        return 0


_TAG_RE = re.compile(r"<[^>]+>")


def _strip_html(s: str) -> str:
    if not s:
        return ""
    return _TAG_RE.sub("", s).strip()


async def _fetch_feed(url: str) -> str:
    # SSRF defense: the user pastes this URL. ``allow_loopback=False``
    # rules out feeds pointing at the user's own machine (no legitimate
    # podcast lives on 127.0.0.1). ``safe_get`` re-validates each 3xx
    # hop so an upstream 302 can't pivot to an internal host.
    from safe_fetch import safe_get
    headers = {"User-Agent": "Audimo/0.4 (+podcasts)"}
    r = await safe_get(
        url,
        headers=headers,
        timeout=20.0,
        follow_redirects=True,
        allow_loopback=False,
    )
    r.raise_for_status()
    return r.text


def _safe_http_url(url: str | None) -> str:
    """Return ``url`` if it's an http(s) URL with a host, otherwise "".
    Used to scrub user-supplied URLs from RSS feeds (``<link>``,
    ``itunes:image href``, enclosure URLs) before they flow into the
    frontend's ``<a href>`` / ``<img src>``. React does NOT block
    ``javascript:`` href URLs in production, so an unsanitized feed
    `<link>javascript:fetch(...)</link>` would execute under the app
    origin when the user clicks Website."""
    if not url or not isinstance(url, str):
        return ""
    s = url.strip()
    if not s:
        return ""
    # Reject anything that isn't a plain http(s) URL. Belt-and-suspenders
    # against ``javascript:``, ``data:``, ``file:``, ``vbscript:``, etc.
    low = s.lower()
    if not (low.startswith("http://") or low.startswith("https://")):
        return ""
    return s


def _parse_feed(xml_text: str, feed_url: str) -> tuple[dict, list[dict]]:
    """Returns (podcast_meta, episodes)."""
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as e:
        raise HTTPException(400, f"Feed is not valid XML: {e}")
    channel = root.find("channel")
    if channel is None:
        raise HTTPException(400, "Feed is missing <channel> — not an RSS podcast feed")

    podcast_id = _pid(feed_url)
    title = _text(channel, "title")
    if not title:
        raise HTTPException(400, "Feed is missing <title>")
    author = _text(channel, "itunes:author", _NS) or _text(channel, "author")
    description = _strip_html(
        _text(channel, "description") or _text(channel, "itunes:summary", _NS)
    )
    website = _safe_http_url(_text(channel, "link"))
    # itunes:image is a self-closing tag with href= attr; <image><url> is the
    # legacy form. Try both.
    artwork = ""
    img = channel.find("itunes:image", _NS)
    if img is not None:
        artwork = _safe_http_url(img.attrib.get("href", ""))
    if not artwork:
        legacy = channel.find("image/url")
        if legacy is not None:
            artwork = _safe_http_url(legacy.text or "")

    meta = {
        "id": podcast_id,
        "feed_url": feed_url,
        "title": title,
        "author": author,
        "description": description,
        "artwork": artwork,
        "website": website,
        "last_refreshed": int(time.time()),
    }

    episodes = []
    for item in channel.findall("item"):
        enclosure = item.find("enclosure")
        # Sanitize enclosure URL to http(s) only — same defense as
        # _safe_http_url for <link> / itunes:image. An enclosure
        # carrying ``javascript:`` or ``data:`` would flow into the
        # frontend's audio element and a download job's `_looks_like_safe_url`
        # already rejects it, but defending here too keeps the dead
        # entry out of the listing entirely.
        audio_url = _safe_http_url(enclosure.attrib.get("url", "")) if enclosure is not None else ""
        if not audio_url:
            continue
        guid = _text(item, "guid")
        ep_title = _text(item, "title")
        ep_desc = _strip_html(
            _text(item, "itunes:summary", _NS) or _text(item, "description")
        )
        pub = _parse_pub_date(_text(item, "pubDate"))
        duration = _parse_duration(_text(item, "itunes:duration", _NS))
        ep_art = ""
        ep_img = item.find("itunes:image", _NS)
        if ep_img is not None:
            ep_art = _safe_http_url(ep_img.attrib.get("href", ""))
        episodes.append({
            "id": _eid(podcast_id, guid, audio_url),
            "guid": guid,
            "title": ep_title,
            "description": ep_desc,
            "audio_url": audio_url,
            "pub_date": pub,
            "duration_s": duration,
            "artwork": ep_art or artwork,
        })

    return meta, episodes


async def _refresh(user_id: int, feed_url: str) -> dict:
    xml_text = await _fetch_feed(feed_url)
    meta, episodes = _parse_feed(xml_text, feed_url)
    # Snapshot the prior episode ids so we can detect what's new after
    # the rewrite. We do this BEFORE upsert/replace so the diff is
    # against the previous refresh, not against the row we just wrote.
    prior_ids = set()
    with _get_db() as conn:
        prior_ids = {
            r["id"] for r in conn.execute(
                "SELECT id FROM podcast_episodes WHERE user_id = ? AND podcast_id = ?",
                (user_id, meta["id"]),
            )
        }
    upsert_podcast(user_id, meta)
    replace_podcast_episodes(user_id, meta["id"], episodes)

    # Auto-download: if the user toggled it on for this show, kick off
    # background download jobs for any episodes that just appeared in
    # the feed. Skip on first-ever subscription (prior_ids is empty)
    # to avoid downloading a 500-ep back-catalog accidentally.
    pod = get_podcast(user_id, meta["id"])
    if pod and pod.get("auto_download") and prior_ids:
        for ep in episodes:
            if ep["id"] in prior_ids:
                continue
            if not ep.get("audio_url"):
                continue
            if download_job.find_active_for("podcast", ep["id"]):
                continue
            show_slug = _safe_slug(meta.get("title") or "Unknown Show")
            ep_slug = _safe_slug(ep.get("title") or "Untitled Episode")
            ext = _ext_from_url(ep["audio_url"])
            dest = str(PODCAST_STORE / show_slug / f"{ep_slug}{ext}")
            captured_eid = ep["id"]
            async def _on_finish(job, _eid=captured_eid):
                if job.status not in ("finalizing", "done"):
                    return
                set_podcast_episode_local_file(user_id, _eid, job.dest_path)
            download_job.start_download(
                kind="podcast",
                url=ep["audio_url"],
                dest_path=dest,
                label=f"{meta.get('title','')} — {ep.get('title','')}".strip(" —"),
                related_key=ep["id"],
                on_finish=_on_finish,
            )

    return meta


@router.post("/api/podcasts/subscribe")
async def subscribe(body: dict, user=Depends(get_current_user)):
    feed_url = (body.get("feed_url") or "").strip()
    if not feed_url or not feed_url.startswith(("http://", "https://")):
        raise HTTPException(400, "feed_url must be an http(s) URL")
    # First-time subscribe seeds last_opened_at to "now" so the entire
    # back-catalog doesn't get tagged as new. Re-subscribing an
    # existing row leaves the prior baseline alone.
    pid = _pid(feed_url)
    pre_existing = bool(get_podcast(user["id"], pid))
    try:
        meta = await _refresh(user["id"], feed_url)
    except httpx.HTTPError as e:
        raise HTTPException(400, f"Could not fetch feed: {e}")
    if not pre_existing:
        mark_podcast_seen(user["id"], pid)
    return {"podcast": get_podcast(user["id"], pid) or meta}


@router.get("/api/podcasts")
async def list_subs(user=Depends(get_current_user)):
    return {"podcasts": list_podcasts(user["id"])}


@router.get("/api/podcasts/search")
async def search(q: str, user=Depends(get_current_user)):
    """Podcast discovery via the iTunes Search API. Free, no key.
    Returns a flat list shaped for the SearchTab card grid; the
    important field is feedUrl, which a click on "Subscribe" feeds
    straight back into POST /subscribe."""
    q = (q or "").strip()
    if not q:
        return {"results": []}
    params = {"media": "podcast", "limit": 30, "term": q}
    headers = {"User-Agent": "Audimo/0.4 (+podcasts)"}
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(
                "https://itunes.apple.com/search",
                params=params, headers=headers,
            )
            r.raise_for_status()
            payload = r.json()
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Search failed: {e}")
    results = []
    for item in payload.get("results", []):
        feed = item.get("feedUrl")
        if not feed:
            continue
        results.append({
            "feed_url": feed,
            "title": item.get("collectionName") or item.get("trackName") or "",
            "author": item.get("artistName") or "",
            "artwork": item.get("artworkUrl600") or item.get("artworkUrl100") or "",
            "genre": item.get("primaryGenreName") or "",
            "track_count": item.get("trackCount") or 0,
            "itunes_id": item.get("collectionId"),
        })
    return {"results": results}


@router.get("/api/podcasts/preview")
async def preview(feed_url: str, user=Depends(get_current_user)):
    """Fetch + parse a feed without persisting. Used by Search clicks
    so opening a result is a true 'preview' — no auto-subscribe, no
    Unsubscribe button hanging around afterwards. If the user is
    already subscribed to this feed, returns the persisted row + DB
    episodes (so played-state / progress / local_file all show), and
    flags `subscribed: true`."""
    url = (feed_url or "").strip()
    if not url or not url.startswith(("http://", "https://")):
        raise HTTPException(400, "feed_url must be an http(s) URL")
    pid = _pid(url)
    existing = get_podcast(user["id"], pid)
    if existing:
        return {
            "podcast": existing,
            "episodes": list_podcast_episodes(user["id"], pid),
            "subscribed": True,
        }
    # Not subscribed — fetch + parse live, return transiently.
    try:
        xml_text = await _fetch_feed(url)
    except httpx.HTTPError as e:
        raise HTTPException(400, f"Could not fetch feed: {e}")
    meta, episodes = _parse_feed(xml_text, url)
    # Episodes get the same id shape they would after subscribing, so
    # if the user then subscribes the per-episode IDs line up cleanly.
    return {"podcast": meta, "episodes": episodes, "subscribed": False}


@router.get("/api/podcasts/episodes/recent")
async def recent_episodes(user=Depends(get_current_user), limit: int = 10):
    """Latest unplayed episodes that dropped AFTER the user subscribed
    to the show — the back-catalog you signed up for doesn't belong on
    a 'New episodes' rail. Includes show metadata (title + artwork)
    so the row renders without a second round-trip."""
    limit = max(1, min(int(limit or 10), 50))
    with _get_db() as conn:
        rows = conn.execute(
            """SELECT e.id, e.podcast_id, e.title, e.audio_url, e.pub_date,
                      e.duration_s, e.position_s, e.played_at,
                      COALESCE(e.local_file, '') AS local_file,
                      p.title AS show_title,
                      COALESCE(e.artwork, p.artwork) AS artwork
               FROM podcast_episodes e
               JOIN podcasts p
                 ON p.user_id = e.user_id AND p.id = e.podcast_id
               WHERE e.user_id = ?
                 AND e.played_at = 0
                 AND e.pub_date > CAST(strftime('%s', p.subscribed_at) AS INTEGER)
               ORDER BY e.pub_date DESC
               LIMIT ?""",
            (user["id"], limit),
        ).fetchall()
    return {"episodes": [dict(r) for r in rows]}


@router.get("/api/podcasts/export.opml")
async def export_opml(user=Depends(get_current_user)):
    """Standard OPML 2.0 export. Drop into any podcast client (Pocket
    Casts, Overcast, AntennaPod, Apple Podcasts) to migrate
    subscriptions."""
    subs = list_podcasts(user["id"])
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<opml version="2.0">',
        '  <head><title>Audimo Podcast Subscriptions</title></head>',
        '  <body>',
    ]
    for p in subs:
        title = _xml_escape(p.get("title") or "Untitled")
        feed = _xml_escape(p["feed_url"])
        site = _xml_escape(p.get("website") or "")
        site_attr = f' htmlUrl="{site}"' if site else ""
        lines.append(
            f'    <outline type="rss" text="{title}" title="{title}" xmlUrl="{feed}"{site_attr}/>'
        )
    lines.extend(['  </body>', '</opml>', ''])
    body = "\n".join(lines)
    return Response(
        content=body,
        media_type="text/x-opml",
        headers={"Content-Disposition": 'attachment; filename="audimo-podcasts.opml"'},
    )


@router.post("/api/podcasts/import.opml")
async def import_opml(request: Request, user=Depends(get_current_user)):
    """Bulk-subscribe from an OPML 2.0 (or 1.0) file. Walks every
    <outline> with an xmlUrl attribute. Subscribing is idempotent
    (sha1(feed_url) dedups against existing rows). Failures on a
    single feed don't abort the run — they accumulate into the
    response so the user can see what didn't take."""
    raw = await request.body()
    if not raw:
        raise HTTPException(400, "Empty OPML payload")
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as e:
        raise HTTPException(400, f"Invalid OPML XML: {e}")
    # Collect every outline xmlUrl anywhere in the tree — OPML clients
    # nest by folder so we walk the whole subtree rather than just
    # /opml/body/outline.
    feeds = []
    for outline in root.iter("outline"):
        url = outline.attrib.get("xmlUrl") or outline.attrib.get("xmlurl")
        if url and url.startswith(("http://", "https://")):
            feeds.append(url.strip())
    if not feeds:
        raise HTTPException(400, "No feeds found in OPML")

    added, failed = [], []
    # Fetch + parse feeds concurrently but bound the fan-out so we
    # don't slam the network with a 200-show OPML.
    sem = asyncio.Semaphore(4)
    async def _one(url):
        async with sem:
            try:
                meta = await _refresh(user["id"], url)
                added.append({"feed_url": url, "title": meta.get("title", "")})
            except Exception as e:
                failed.append({"feed_url": url, "error": str(e)[:200]})
    await asyncio.gather(*[_one(u) for u in feeds])
    return {"added": added, "failed": failed, "total": len(feeds)}


@router.get("/api/podcasts/{podcast_id}")
async def get_detail(podcast_id: str, user=Depends(get_current_user)):
    pod = get_podcast(user["id"], podcast_id)
    if not pod:
        raise HTTPException(404, "Not subscribed")
    if int(time.time()) - int(pod.get("last_refreshed") or 0) > STALE_AFTER_S:
        try:
            pod = await _refresh(user["id"], pod["feed_url"])
            pod = get_podcast(user["id"], podcast_id) or pod
        except httpx.HTTPError:
            # Serve stale on network failure rather than 500-ing.
            pass
    return {"podcast": pod, "episodes": list_podcast_episodes(user["id"], podcast_id)}


@router.post("/api/podcasts/{podcast_id}/refresh")
async def refresh(podcast_id: str, user=Depends(get_current_user)):
    pod = get_podcast(user["id"], podcast_id)
    if not pod:
        raise HTTPException(404, "Not subscribed")
    try:
        await _refresh(user["id"], pod["feed_url"])
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Refresh failed: {e}")
    return {"podcast": get_podcast(user["id"], podcast_id),
            "episodes": list_podcast_episodes(user["id"], podcast_id)}


def _maybe_cleanup_after_played(user_id: int, episode_id: str) -> None:
    """If the episode's show has auto_cleanup_played on, delete the
    local file and clear the pointer. No-op if the show is off or the
    file is already gone."""
    ep = get_podcast_episode(user_id, episode_id)
    if not ep or not ep.get("local_file"):
        return
    pod = get_podcast(user_id, ep["podcast_id"])
    if not pod or not pod.get("auto_cleanup_played"):
        return
    try:
        Path(ep["local_file"]).unlink(missing_ok=True)
    except OSError:
        pass
    set_podcast_episode_local_file(user_id, episode_id, "")


@router.post("/api/podcasts/episodes/{episode_id}/progress")
async def episode_progress(episode_id: str, body: dict, user=Depends(get_current_user)):
    """Player heartbeat. Body: {position_s, duration_s?, completed?}.
    Fired ~every 5s during playback, and once with completed=true
    when the episode hits 'ended' (or near-end on user skip)."""
    position_s = float(body.get("position_s") or 0)
    completed = bool(body.get("completed"))
    duration_s = body.get("duration_s")
    duration_s = int(duration_s) if duration_s else None
    ok = set_podcast_episode_progress(
        user["id"], episode_id, position_s, completed, duration_s,
    )
    if not ok:
        raise HTTPException(404, "Episode not found")
    if completed:
        _maybe_cleanup_after_played(user["id"], episode_id)
    return {"ok": True}


def _ext_from_url(url: str, default: str = ".mp3") -> str:
    path = url.split("?", 1)[0].split("#", 1)[0]
    ext = os.path.splitext(path)[1].lower()
    # Common podcast audio formats. Anything weirder we coerce to .mp3
    # since most enclosures are mp3 and the player will sniff anyway.
    if ext in (".mp3", ".m4a", ".mp4", ".ogg", ".opus", ".aac", ".flac", ".wav"):
        return ext
    return default


@router.post("/api/podcasts/episodes/{episode_id}/download")
async def download_episode(episode_id: str, user=Depends(get_current_user)):
    """Spawn a background HTTP-to-disk job for an episode. Returns the
    job id; the frontend's useDownloadJobs poller picks up progress.
    Idempotent — calling twice while a job is active returns the
    existing job id rather than starting a second download."""
    ep = get_podcast_episode(user["id"], episode_id)
    if not ep:
        raise HTTPException(404, "Episode not found")
    if ep.get("local_file") and Path(ep["local_file"]).exists():
        return {"already_local": True, "local_file": ep["local_file"]}
    if not ep.get("audio_url"):
        raise HTTPException(400, "Episode has no audio URL")
    existing = download_job.find_active_for("podcast", episode_id)
    if existing:
        return {"job_id": existing.id, "already_running": True}

    pod = get_podcast(user["id"], ep["podcast_id"])
    show_slug = _safe_slug(pod.get("title") if pod else "Unknown Show")
    ep_slug = _safe_slug(ep.get("title") or "Untitled Episode")
    ext = _ext_from_url(ep["audio_url"])
    dest = str(PODCAST_STORE / show_slug / f"{ep_slug}{ext}")

    uid = user["id"]
    eid = episode_id

    async def _on_finish(job: download_job.DownloadJob):
        if job.status not in ("finalizing", "done"):
            return
        set_podcast_episode_local_file(uid, eid, job.dest_path)

    j = download_job.start_download(
        kind="podcast",
        url=ep["audio_url"],
        dest_path=dest,
        label=f"{(pod or {}).get('title', '')} — {ep.get('title', '')}".strip(" —"),
        related_key=episode_id,
        on_finish=_on_finish,
    )
    return {"job_id": j.id, "dest_path": dest}


@router.delete("/api/podcasts/episodes/{episode_id}/download")
async def delete_download(episode_id: str, user=Depends(get_current_user)):
    """Remove the local file for an episode (revert to streaming)."""
    ep = get_podcast_episode(user["id"], episode_id)
    if not ep:
        raise HTTPException(404, "Episode not found")
    local = ep.get("local_file") or ""
    if local:
        try:
            Path(local).unlink(missing_ok=True)
        except OSError:
            pass
    set_podcast_episode_local_file(user["id"], episode_id, "")
    return {"ok": True}


@router.post("/api/podcasts/episodes/{episode_id}/mark-played")
async def mark_played(episode_id: str, user=Depends(get_current_user)):
    if not get_podcast_episode(user["id"], episode_id):
        raise HTTPException(404, "Episode not found")
    set_podcast_episode_progress(user["id"], episode_id, 0.0, True)
    _maybe_cleanup_after_played(user["id"], episode_id)
    return {"ok": True}


@router.post("/api/podcasts/episodes/{episode_id}/mark-unplayed")
async def mark_unplayed(episode_id: str, user=Depends(get_current_user)):
    """Clear played_at and reset position. The reverse of mark-played."""
    if not get_podcast_episode(user["id"], episode_id):
        raise HTTPException(404, "Episode not found")
    # set_podcast_episode_progress with completed=False + position=0
    # leaves played_at alone. Reach for a small dedicated UPDATE.
    from database import get_db as _get_db
    with _get_db() as conn:
        conn.execute(
            """UPDATE podcast_episodes SET position_s = 0, played_at = 0
               WHERE user_id = ? AND id = ?""",
            (user["id"], episode_id),
        )
    return {"ok": True}


@router.post("/api/podcasts/{podcast_id}/mark-seen")
async def mark_seen(podcast_id: str, user=Depends(get_current_user)):
    """Bump last_opened_at to now. Fired by the detail view on mount
    so the card badge clears once the user has opened the show. The
    detail view should already have captured the previous baseline
    in its initial GET, so per-episode NEW pips persist for the
    current view."""
    if not mark_podcast_seen(user["id"], podcast_id):
        raise HTTPException(404, "Not subscribed")
    return {"ok": True}


@router.post("/api/podcasts/{podcast_id}/auto-cleanup")
async def toggle_auto_cleanup(podcast_id: str, body: dict, user=Depends(get_current_user)):
    """Per-show: delete the local file after the episode is marked
    played. Triggers on mark-played + progress(completed=true)."""
    enabled = bool(body.get("enabled"))
    if not set_podcast_auto_cleanup(user["id"], podcast_id, enabled):
        raise HTTPException(404, "Not subscribed")
    return {"ok": True, "auto_cleanup_played": enabled}


@router.post("/api/podcasts/{podcast_id}/download-next")
async def download_next(podcast_id: str, user=Depends(get_current_user), n: int = 5):
    """Bulk-download the next N unplayed-and-not-yet-local episodes,
    most-recent first. Returns the list of episode ids that started
    downloading (rows already local or already downloading are skipped)."""
    n = max(1, min(int(n or 5), 25))
    pod = get_podcast(user["id"], podcast_id)
    if not pod:
        raise HTTPException(404, "Not subscribed")
    started: list[str] = []
    for ep in list_podcast_episodes(user["id"], podcast_id):
        if len(started) >= n:
            break
        if ep.get("played_at"):
            continue
        if ep.get("local_file"):
            continue
        if not ep.get("audio_url"):
            continue
        if download_job.find_active_for("podcast", ep["id"]):
            continue
        show_slug = _safe_slug(pod.get("title") or "Unknown Show")
        ep_slug = _safe_slug(ep.get("title") or "Untitled Episode")
        ext = _ext_from_url(ep["audio_url"])
        dest = str(PODCAST_STORE / show_slug / f"{ep_slug}{ext}")
        uid = user["id"]
        eid = ep["id"]
        async def _on_finish(job, _eid=eid, _uid=uid):
            if job.status not in ("finalizing", "done"):
                return
            set_podcast_episode_local_file(_uid, _eid, job.dest_path)
        download_job.start_download(
            kind="podcast",
            url=ep["audio_url"],
            dest_path=dest,
            label=f"{pod.get('title','')} — {ep.get('title','')}".strip(" —"),
            related_key=eid,
            on_finish=_on_finish,
        )
        started.append(eid)
    return {"started": started, "count": len(started)}


@router.post("/api/podcasts/{podcast_id}/mark-all-played")
async def mark_all_played(podcast_id: str, user=Depends(get_current_user)):
    pod = get_podcast(user["id"], podcast_id)
    if not pod:
        raise HTTPException(404, "Not subscribed")
    import time as _time
    now_ts = int(_time.time())
    with _get_db() as conn:
        cur = conn.execute(
            """UPDATE podcast_episodes
               SET position_s = 0, played_at = ?
               WHERE user_id = ? AND podcast_id = ? AND played_at = 0""",
            (now_ts, user["id"], podcast_id),
        )
        updated = cur.rowcount or 0
    # Cleanup pass — if the show wants local files deleted on play,
    # the just-completed episodes need their files unlinked too.
    if pod.get("auto_cleanup_played"):
        for ep in list_podcast_episodes(user["id"], podcast_id):
            if ep.get("local_file") and ep.get("played_at"):
                try:
                    Path(ep["local_file"]).unlink(missing_ok=True)
                except OSError:
                    pass
                set_podcast_episode_local_file(user["id"], ep["id"], "")
    return {"updated": updated}


@router.post("/api/podcasts/{podcast_id}/mark-all-unplayed")
async def mark_all_unplayed(podcast_id: str, user=Depends(get_current_user)):
    if not get_podcast(user["id"], podcast_id):
        raise HTTPException(404, "Not subscribed")
    with _get_db() as conn:
        cur = conn.execute(
            """UPDATE podcast_episodes SET position_s = 0, played_at = 0
               WHERE user_id = ? AND podcast_id = ?""",
            (user["id"], podcast_id),
        )
        updated = cur.rowcount or 0
    return {"updated": updated}


@router.post("/api/podcasts/{podcast_id}/auto-download")
async def toggle_auto_download(podcast_id: str, body: dict, user=Depends(get_current_user)):
    """Flip per-show auto-download. When enabled, /refresh fans out
    download jobs for any newly-appeared episodes. First-ever
    subscribe skips this so we don't start downloading a 500-episode
    back-catalog."""
    enabled = bool(body.get("enabled"))
    if not set_podcast_auto_download(user["id"], podcast_id, enabled):
        raise HTTPException(404, "Not subscribed")
    return {"ok": True, "auto_download": enabled}


@router.delete("/api/podcasts/{podcast_id}")
async def unsubscribe(podcast_id: str, user=Depends(get_current_user)):
    if not get_podcast(user["id"], podcast_id):
        raise HTTPException(404, "Not subscribed")
    delete_podcast(user["id"], podcast_id)
    return {"ok": True}
