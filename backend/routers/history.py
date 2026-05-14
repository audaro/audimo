"""Local play history.

Stores one row per "meaningful play" event — fired by the frontend
when a track has been listened to past the scrobble threshold (>50%
or 4 minutes), the same gate ListenBrainz uses. Audiobook plays use
the same threshold but are tagged kind='audiobook' so the Today rail
can split them out.

This is purely local. ListenBrainz scrobbling stays orthogonal —
both run from the same Player effect; the user can have either or
both enabled.
"""
from __future__ import annotations

import time

from fastapi import APIRouter, Depends, HTTPException

from auth import get_current_user
from database import get_db

router = APIRouter(tags=["history"])


def _clean_str(v, max_len: int = 240) -> str:
    """Best-effort string coercion with a length cap. Front-end is
    trusted in the single-user case but capping keeps a runaway
    payload from blowing up the DB."""
    if v is None:
        return ""
    s = str(v)
    return s[:max_len]


@router.post("/api/history/log")
async def log_play(payload: dict, current_user: dict = Depends(get_current_user)):
    """Append a play-history row. Frontend fires this once per track
    after the scrobble threshold is met. We don't dedupe — repeated
    listens of the same track are real listening behavior and should
    show up multiple times in stats."""
    title = _clean_str(payload.get("title"))
    if not title:
        raise HTTPException(400, "title is required")
    duration = int(payload.get("duration_played_s") or 0)
    if duration < 0 or duration > 24 * 3600:
        # Clamp; we don't want a bug to insert a 99h play.
        duration = max(0, min(duration, 24 * 3600))
    row = {
        "user_id": current_user["id"],
        "played_at": int(time.time()),
        "track_title": title,
        "track_artist": _clean_str(payload.get("artist")),
        "track_album": _clean_str(payload.get("album")),
        "album_cover": _clean_str(payload.get("album_cover"), max_len=2048),
        "source": _clean_str(payload.get("source"), max_len=64),
        "addon_id": _clean_str(payload.get("addon_id"), max_len=128),
        "kind": "audiobook" if payload.get("kind") == "audiobook" else "music",
        "duration_played_s": duration,
    }
    with get_db() as conn:
        conn.execute(
            """INSERT INTO play_history
               (user_id, played_at, track_title, track_artist, track_album,
                album_cover, source, addon_id, kind, duration_played_s)
               VALUES (:user_id, :played_at, :track_title, :track_artist,
                       :track_album, :album_cover, :source, :addon_id, :kind,
                       :duration_played_s)""",
            row,
        )
    return {"logged": True, "played_at": row["played_at"]}


@router.get("/api/history")
async def list_history(limit: int = 200, current_user: dict = Depends(get_current_user)):
    """Recent plays, newest first. `limit` is clamped to 500 to keep
    the response bounded."""
    limit = max(1, min(int(limit), 500))
    with get_db() as conn:
        rows = conn.execute(
            """SELECT played_at, track_title, track_artist, track_album,
                      album_cover, source, addon_id, kind, duration_played_s
               FROM play_history
               WHERE user_id = ?
               ORDER BY played_at DESC
               LIMIT ?""",
            (current_user["id"], limit),
        ).fetchall()
    return {
        "count": len(rows),
        "entries": [dict(r) for r in rows],
    }


@router.get("/api/history/top")
async def history_top(
    days: int = 30,
    limit: int = 10,
    current_user: dict = Depends(get_current_user),
):
    """Smart-playlist data: most-played tracks in the last ``days``
    days, by play count. ``days`` is clamped to [1, 365]. Returns
    one row per (track_title, track_artist) with the play_count and
    the most-recent cover/source.
    """
    days = max(1, min(int(days), 365))
    limit = max(1, min(int(limit), 50))
    import time as _t
    cutoff = int(_t.time()) - days * 86400
    with get_db() as conn:
        rows = conn.execute(
            """SELECT track_title, track_artist,
                      MAX(album_cover) AS album_cover,
                      MAX(source)      AS source,
                      MAX(addon_id)    AS addon_id,
                      MAX(track_album) AS track_album,
                      COUNT(*)         AS play_count,
                      MAX(played_at)   AS last_played_at
               FROM play_history
               WHERE user_id = ? AND played_at >= ?
                 AND track_title <> ''
               GROUP BY LOWER(TRIM(track_title)), LOWER(TRIM(track_artist))
               ORDER BY play_count DESC, last_played_at DESC
               LIMIT ?""",
            (current_user["id"], cutoff, limit),
        ).fetchall()
    return {
        "window_days": days,
        "count": len(rows),
        "tracks": [dict(r) for r in rows],
    }


@router.get("/api/history/stats")
async def history_stats(current_user: dict = Depends(get_current_user)):
    """Aggregations for the Today right rail. Computed on the fly —
    play_history is small enough (one row per played track, single
    user) that we don't bother caching. If the table ever grows past
    a few hundred thousand rows, materialize a daily roll-up."""
    user_id = current_user["id"]
    now = int(time.time())
    seven_days_ago = now - 7 * 86400
    thirty_days_ago = now - 30 * 86400

    with get_db() as conn:
        # Past 7 days, bucketed by local-day-of-week. Sun=0..Sat=6
        # in strftime('%w'); the rail labels Mon..Sun so we shift on
        # the client.
        weekly = conn.execute(
            """SELECT strftime('%w', played_at, 'unixepoch', 'localtime') AS dow,
                      COALESCE(SUM(duration_played_s), 0) AS secs
               FROM play_history
               WHERE user_id = ? AND played_at >= ?
               GROUP BY dow""",
            (user_id, seven_days_ago),
        ).fetchall()
        weekly_by_dow = {int(r["dow"]): int(r["secs"]) for r in weekly}
        # Mon=1 .. Sat=6, Sun=0 → Mon..Sun ordering for the rail.
        weekly_hours = [
            round(weekly_by_dow.get(d, 0) / 3600, 1)
            for d in (1, 2, 3, 4, 5, 6, 0)
        ]
        hours_this_week = round(sum(weekly_by_dow.values()) / 3600, 1)

        top = conn.execute(
            """SELECT track_artist AS name,
                      COALESCE(SUM(duration_played_s), 0) AS secs
               FROM play_history
               WHERE user_id = ? AND played_at >= ? AND track_artist != ''
               GROUP BY track_artist
               ORDER BY secs DESC
               LIMIT 5""",
            (user_id, thirty_days_ago),
        ).fetchall()
        top_artists = [
            {"name": r["name"], "hours": round(r["secs"] / 3600, 1)}
            for r in top if r["secs"] > 0
        ]

        mix = conn.execute(
            """SELECT COALESCE(NULLIF(source, ''), 'Local') AS name,
                      COALESCE(SUM(duration_played_s), 0) AS secs
               FROM play_history
               WHERE user_id = ? AND played_at >= ?
               GROUP BY name
               ORDER BY secs DESC""",
            (user_id, thirty_days_ago),
        ).fetchall()
        mix_total = sum(r["secs"] for r in mix) or 1
        source_mix = [
            {
                "name": r["name"],
                "hours": round(r["secs"] / 3600, 1),
                "pct": round(r["secs"] * 100 / mix_total),
            }
            for r in mix if r["secs"] > 0
        ]

        # Day streak — consecutive days with a play, counting back
        # from today. Cap at 365 to keep the loop bounded.
        today_local = conn.execute(
            "SELECT strftime('%Y-%m-%d', 'now', 'localtime') AS d"
        ).fetchone()["d"]
        day_set = {
            r["d"] for r in conn.execute(
                """SELECT DISTINCT strftime('%Y-%m-%d', played_at, 'unixepoch', 'localtime') AS d
                   FROM play_history
                   WHERE user_id = ?""",
                (user_id,),
            ).fetchall()
        }
        streak = 0
        if today_local in day_set:
            from datetime import date, timedelta
            d = date.fromisoformat(today_local)
            for _ in range(365):
                if d.isoformat() not in day_set:
                    break
                streak += 1
                d -= timedelta(days=1)

        totals = conn.execute(
            """SELECT COALESCE(SUM(duration_played_s), 0) AS secs,
                      COUNT(*) AS plays
               FROM play_history
               WHERE user_id = ?""",
            (user_id,),
        ).fetchone()

    return {
        "hours_this_week": hours_this_week,
        "weekly_hours": weekly_hours,
        "top_artists": top_artists,
        "source_mix": source_mix,
        "day_streak": streak,
        "total_hours": round(totals["secs"] / 3600, 1),
        "total_plays": int(totals["plays"]),
    }


@router.delete("/api/history/clear")
async def clear_history(current_user: dict = Depends(get_current_user)):
    """Wipe local play history for the current user. Doesn't touch
    ListenBrainz — those scrobbles live on the LB side and need to be
    deleted from listenbrainz.org."""
    with get_db() as conn:
        cur = conn.execute("DELETE FROM play_history WHERE user_id = ?", (current_user["id"],))
        return {"cleared": cur.rowcount}
