"""Process-wide stream cache state.

Two layers:

* ``_stream_cache`` — global ``key → entry`` dict, persisted to
  ``~/.audimo/stream_cache.json`` via ``save_cache``. Reads fastest;
  used by ``/api/cache/list``, ``/api/cache/check``, the audiobook
  upload save path, and any addon-id-based purge logic.

* ``_user_caches[user_id]`` — per-user mirror of the SQL ``user_cache``
  table, loaded lazily on first access via ``_get_user_cache``. The
  per-user table is the source of truth for cache rows that should
  outlive a process restart in a multi-user world; in the single-user
  install the two layers track each other closely.

Each entry's shape is documented at the top of ``main.py`` — core
treats addon-produced entries as opaque and only reads a small set of
universal fields (``filename``, ``track_*``, ``addon_id``).

This module is import-safe (no FastAPI symbols, no app-startup side
effects beyond ``CACHE_DIR.mkdir``). Routers and ``main`` import the
public helpers; the dicts are exposed by name so the few legitimate
mutators (the upload endpoint, addon-purge) can write directly.
"""
import hashlib
import json
import os
import shutil
import threading
from pathlib import Path

from database import load_user_cache, save_cache_entry

CACHE_DIR = Path.home() / ".audimo"
CACHE_DIR.mkdir(parents=True, exist_ok=True)
CACHE_FILE = CACHE_DIR / "stream_cache.json"

_stream_cache: dict[str, dict] = {}
_user_caches: dict[int, dict] = {}

# Serializes both the JSON cache write AND the mutation paths that
# touch ``_stream_cache``. Without this, two concurrent
# ``save_cache()`` calls (user click + background torrent-save
# callback) can interleave and produce a partially-written file that
# fails to parse on next boot; the iteration in ``/api/cache/list``
# can also race against ``cache_add`` / ``cache_remove`` /
# ``_purge_addon_library`` and observe a snapshot mid-write.
#
# RLock instead of Lock so a callsite can take the lock then call
# ``save_cache()`` (which also takes the lock) without deadlocking
# itself. Cheap because the critical sections are sub-millisecond.
_cache_lock = threading.RLock()
# Back-compat alias: existing callers reach for ``_save_lock``.
_save_lock = _cache_lock


def _cache_key(artist: str, title: str) -> str:
    return hashlib.md5(f"{artist.lower().strip()}|{title.lower().strip()}".encode()).hexdigest()


def load_cache() -> None:
    """Read the persisted JSON and migrate legacy rows into the
    addon-id-tagged shape. Idempotent: re-running on a fresh DB tags
    nothing further. Called once at app startup."""
    global _stream_cache
    # Migrate old cache file from project dir if it exists
    old_cache = Path(__file__).parent / "stream_cache.json"
    if old_cache.exists() and not CACHE_FILE.exists():
        try:
            shutil.copy(old_cache, CACHE_FILE)
            print(f"[Cache] Migrated cache from project dir to {CACHE_FILE}")
        except Exception:
            pass

    if not CACHE_FILE.exists():
        return
    try:
        raw = json.loads(CACHE_FILE.read_text())
        # One-shot purge of legacy SoundCloud / YouTube / Bandcamp cache
        # rows. Those source paths have been removed from the native app;
        # the entries can no longer be resolved or played, so dropping
        # them avoids dead rows in the user's library. Idempotent: on
        # subsequent boots there's nothing left to filter.
        legacy_types = ("sc", "youtube", "bandcamp")
        purged_legacy = [k for k, e in raw.items()
                         if isinstance(e, dict) and e.get("type") in legacy_types and not e.get("addon_id")]
        for k in purged_legacy:
            raw.pop(k, None)
        if purged_legacy:
            print(f"[Cache] Purged {len(purged_legacy)} legacy SC/YT/BC entries (no longer playable)")
        migrated = 0
        backfilled_addon = 0
        backfilled_added_at = 0
        import os as _os
        import re as _re
        import time as _time
        for key, entry in raw.items():
            if "track_title" not in entry:
                fn = entry.get("filename", "")
                clean = _re.sub(r"^[0-9]+[\.\-\s]+", "", fn)
                clean = _re.sub(r"\.[a-zA-Z0-9]{2,5}$", "", clean).strip()
                entry["track_title"] = clean or fn
                entry["track_artist"] = ""
                entry["track_album"] = ""
                migrated += 1
            # Legacy entries from before the addon architecture: tag
            # with the bundled addon's id so cache.resolve dispatches
            # correctly. The actual id is opaque to core.
            if not entry.get("addon_id") and entry.get("type") in (
                "rd", "addon_ephemeral", "slskd",
            ):
                entry["addon_id"] = "audimo-aio"
                if entry.get("local_file") and not entry.get("addon_local_file"):
                    entry["addon_local_file"] = entry["local_file"]
                backfilled_addon += 1
            # `added_at` was added to cache.add late — older rows lack
            # it. Prefer the underlying local_file mtime where we have
            # one (the user's actual download timestamp). For rows
            # without a local file (addon-streamed RD/Soulseek/etc.),
            # we have no historical timestamp; stamp now() so they
            # become anchored once and stay stable. Both fall back
            # paths persist via save_cache() below.
            if entry.get("added_at") is None:
                lf = entry.get("local_file") or entry.get("addon_local_file") or ""
                if lf:
                    try:
                        entry["added_at"] = int(_os.path.getmtime(lf))
                    except OSError:
                        entry["added_at"] = int(_time.time())
                else:
                    entry["added_at"] = int(_time.time())
                backfilled_added_at += 1
        if migrated:
            print(f"[Cache] Migrated {migrated} entries to new format")
        if backfilled_addon:
            print(f"[Cache] Backfilled addon_id on {backfilled_addon} entries")
        if backfilled_added_at:
            print(f"[Cache] Backfilled added_at on {backfilled_added_at} entries")
        # Mutate in place rather than rebinding — main.py and other
        # modules that did `from cache_state import _stream_cache` at
        # import time hold a reference to the original dict, and a
        # rebind here orphans those references (silently empty
        # /api/cache/list).
        _stream_cache.clear()
        _stream_cache.update(raw)
        print(f"[Cache] Loaded {len(_stream_cache)} cached tracks from {CACHE_FILE}")
        # Persist the backfill so subsequent boots short-circuit and
        # the timestamps stay anchored. Without this each restart
        # would re-stamp now() for cleared-mtime rows, defeating
        # "Added this week".
        if backfilled_added_at:
            try:
                save_cache()
            except Exception as e:
                print(f"[Cache] Backfill persist failed: {e}")
    except Exception as e:
        print(f"[Cache] Load error: {e}")
        _stream_cache.clear()


def save_cache() -> None:
    """Persist `_stream_cache` to disk atomically.

    Snapshots the dict under the lock (so concurrent mutators can't
    change shape mid-serialize), serializes outside the lock, then
    writes via temp-file + `os.replace` so a crash mid-write can't
    leave a half-written JSON that breaks the next boot.
    """
    with _cache_lock:
        # Shallow copy is enough — we only need a stable view of the
        # top-level mapping. Entry dicts are not mutated in-place
        # during normal flow.
        snapshot = dict(_stream_cache)
    try:
        payload = json.dumps(snapshot, indent=2)
        tmp = CACHE_FILE.with_suffix(CACHE_FILE.suffix + ".tmp")
        tmp.write_text(payload)
        os.replace(tmp, CACHE_FILE)
    except Exception as e:
        print(f"[Cache] Save error: {e}")


def get_user_cache(user_id: int) -> dict:
    """Return (and lazily load) the in-memory cache dict for a user.
    Tags any legacy un-addon-id-tagged ``slskd`` rows on first read so
    cache.resolve has something to dispatch on. Persisted back to SQL."""
    if user_id not in _user_caches:
        cache = load_user_cache(user_id)
        migrated = 0
        for key, entry in cache.items():
            if not isinstance(entry, dict):
                continue
            if not entry.get("addon_id") and entry.get("type") == "slskd":
                entry["addon_id"] = "audimo-aio"
                if entry.get("local_file") and not entry.get("addon_local_file"):
                    entry["addon_local_file"] = entry["local_file"]
                try:
                    save_cache_entry(user_id, key, entry)
                    migrated += 1
                except Exception as e:
                    print(f"[Cache] migrate save failed for {key}: {e}")
        if migrated:
            print(f"[Cache] Tagged {migrated} legacy entries with addon_id for user {user_id}")
        _user_caches[user_id] = cache
    return _user_caches[user_id]


def get_cached_entry(artist: str, title: str) -> dict | None:
    return _stream_cache.get(_cache_key(artist, title))


def set_cached(artist: str, title: str, data: dict) -> None:
    """Write a cache entry, refusing to overwrite a more durable row
    with a more transient one. The exact precedence is owned by addons;
    for legacy ``slskd`` entries we just refuse to clobber existing
    addon-served rows."""
    key = _cache_key(artist, title)
    existing = _stream_cache.get(key)
    if existing and existing.get("type") in ("rd", "addon") and data.get("type") == "slskd":
        print(f"[Cache] Skipping {data.get('type')} write — durable entry already exists for '{artist} - {title}'")
        return
    _stream_cache[key] = data
    save_cache()
    print(f"[Cache] Saved '{artist} - {title}' (type={data.get('type','?')})")
