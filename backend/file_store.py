"""User-visible media roots + safe-path helpers.

Two split storage locations:

* ``CACHE_DIR`` (``~/.audimo``) — internal app state only (DB, keys,
  logs, addon scratch). Hidden because the user never needs to touch
  it. Owned by ``cache_state``.

* ``MEDIA_ROOT`` (``~/Music/Audimo``) — user-facing media (uploads,
  audiobook saves, anything they'll want to find in Finder, sync to
  a phone, or copy elsewhere).

Audiobook saves get their own top-level folder so they're trivial to
spot and import into other listening apps.

The ``_safe_under_roots`` helper is the path-traversal defense for
every endpoint that takes a user-supplied file path. ``commonpath`` on
the resolved (symlink-followed) absolute paths avoids the
``"…/foo/../bar"`` + ``/foo-evil`` prefix-match trap.
"""
import os
import re
import sqlite3
from pathlib import Path

# Pre-mkdir rebrand: rename Tunnel-era directories to Audimo paths
# BEFORE the mkdirs below would create empty Audimo dirs (which would
# block the rename's target-doesn't-exist check). Idempotent.
def _premigrate_tunnel_dirs() -> None:
    home = Path.home()
    pairs = [
        (home / ".tunnel",            home / ".audimo"),
        (home / "Music" / "Tunnel",   home / "Music" / "Audimo"),
        (home / ".tunnel-indexers",   home / ".audimo-indexers"),
    ]
    for legacy, new in pairs:
        if legacy.exists() and legacy.is_dir() and not new.exists():
            try:
                legacy.rename(new)
                print(f"[rebrand] {legacy} → {new}")
            except Exception as e:
                print(f"[rebrand] failed {legacy} → {new}: {e}")
_premigrate_tunnel_dirs()

CACHE_DIR = Path.home() / ".audimo"

MEDIA_ROOT = Path.home() / "Music" / "Audimo"
MEDIA_ROOT.mkdir(parents=True, exist_ok=True)

AUDIOBOOK_STORE = Path.home() / "Audiobooks"
AUDIOBOOK_STORE.mkdir(parents=True, exist_ok=True)

PODCAST_STORE = Path.home() / "Podcasts"
PODCAST_STORE.mkdir(parents=True, exist_ok=True)

UPLOAD_STORE = MEDIA_ROOT / "Uploads"
UPLOAD_STORE.mkdir(parents=True, exist_ok=True)

# User-supplied artist + album cover overrides. Lives under the data
# dir (not Music/Audimo) so it's clearly out-of-band from the actual
# audio files. Names are content-addressed (md5 of a normalised key)
# so re-uploading replaces in place; each artist/album has at most
# one override. If the file is missing the frontend silently falls
# back to its existing source (Wikipedia for artists, track-derived
# album art for albums).
CUSTOM_IMAGES_DIR = CACHE_DIR / "custom_images"
CUSTOM_IMAGES_DIR.mkdir(parents=True, exist_ok=True)

# Audio extensions accepted for music uploads. Excludes .m4b
# (audiobook) and .wma (poor browser support).
UPLOAD_AUDIO_EXTS = {".mp3", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".wav", ".alac"}
UPLOAD_MIME_MAP = {
    ".mp3":  "audio/mpeg",
    ".flac": "audio/flac",
    ".m4a":  "audio/mp4",
    ".aac":  "audio/aac",
    ".ogg":  "audio/ogg",
    ".opus": "audio/opus",
    ".wav":  "audio/wav",
    ".alac": "audio/mp4",
}


def safe_under_roots(user_path: str, roots: list[str]) -> str | None:
    """Return the resolved abs path if it lands inside one of the
    allow-listed roots, else ``None``. Returns ``None`` on any
    exception (malformed path, permissions, etc.)."""
    if not user_path:
        return None
    try:
        real = os.path.realpath(user_path)
        for root in roots:
            try:
                rroot = os.path.realpath(root)
                if os.path.commonpath([real, rroot]) == rroot:
                    return real
            except (ValueError, OSError):
                continue
    except Exception:
        return None
    return None


# Allowlist for user-uploaded image extensions (album covers, artist /
# album image overrides). SVG is excluded deliberately — the cover serve
# regex matches any [a-z0-9]{1,6} ext, and SVG can carry inline <script>
# that would then execute under the backend origin.
_IMAGE_EXT_ALLOWLIST = frozenset({".jpg", ".jpeg", ".png", ".webp", ".gif"})


def safe_image_ext(filename: str | None) -> str:
    """Return a safe extension for an uploaded image, raising
    HTTPException(415) for anything outside the allowlist. Returns the
    extension WITH the leading dot, lowercased. Defaults to ``.jpg`` if
    the filename has no extension."""
    from fastapi import HTTPException
    import os as _os
    ext = _os.path.splitext((filename or "").lower())[1]
    if not ext:
        return ".jpg"
    if ext == ".jpe":
        ext = ".jpeg"
    if ext not in _IMAGE_EXT_ALLOWLIST:
        raise HTTPException(
            415,
            f"Image type {ext!r} not allowed — use jpg / png / webp / gif",
        )
    return ext


def file_serve_safe_roots() -> list[str]:
    """Roots that file-serving endpoints are allowed to read from.
    Mirrors the user-visible media locations Audimo writes to."""
    roots = []
    try: roots.append(str(MEDIA_ROOT))
    except Exception: pass
    try: roots.append(str(AUDIOBOOK_STORE))
    except Exception: pass
    try: roots.append(str(PODCAST_STORE))
    except Exception: pass
    return roots


def migrate_tunnel_to_audimo() -> None:
    """One-shot rebrand migration from Tunnel → Audimo.

    Moves user data from Tunnel-era paths to Audimo-era paths and
    rewrites stale references in the SQLite DB + stream_cache.json so
    the user keeps their library, addons, and saved files across the
    rename.

    Idempotent: each step checks for the old path's existence before
    doing anything. Re-running with nothing to migrate is a no-op.

    Steps:
      1. ~/.tunnel/ → ~/.audimo/  (DB, keys, addon settings, etc.)
      2. ~/Music/Tunnel/ → ~/Music/Audimo/  (saved music files)
      3. ~/.tunnel-indexers/ → ~/.audimo-indexers/  (libtorrent state)
      4. SQLite: REPLACE local_file '/Music/Tunnel/' → '/Music/Audimo/'
      5. SQLite: REPLACE addon_id 'tunnel-*' → 'audimo-*'
      6. stream_cache.json: same rewrites as above
      7. ~/.audimo/tunnel.db → ~/.audimo/audimo.db  (DB filename)
    """
    import json, shutil
    home = Path.home()

    # 1. ~/.tunnel/ → ~/.audimo/
    legacy_data = home / ".tunnel"
    new_data = home / ".audimo"
    if legacy_data.exists() and legacy_data.is_dir() and not new_data.exists():
        try:
            legacy_data.rename(new_data)
            print(f"[rebrand] {legacy_data} → {new_data}")
        except Exception as e:
            print(f"[rebrand] failed to rename {legacy_data}: {e}")

    # 2. ~/Music/Tunnel/ → ~/Music/Audimo/
    legacy_music = home / "Music" / "Tunnel"
    new_music = home / "Music" / "Audimo"
    if legacy_music.exists() and legacy_music.is_dir() and not new_music.exists():
        try:
            legacy_music.rename(new_music)
            print(f"[rebrand] {legacy_music} → {new_music}")
        except Exception as e:
            print(f"[rebrand] failed to rename {legacy_music}: {e}")

    # 3. ~/.tunnel-indexers/ → ~/.audimo-indexers/
    legacy_indexers = home / ".tunnel-indexers"
    new_indexers = home / ".audimo-indexers"
    if legacy_indexers.exists() and not new_indexers.exists():
        try:
            legacy_indexers.rename(new_indexers)
            print(f"[rebrand] {legacy_indexers} → {new_indexers}")
        except Exception as e:
            print(f"[rebrand] failed to rename {legacy_indexers}: {e}")

    # 7. DB filename rename: tunnel.db → audimo.db
    legacy_db = new_data / "tunnel.db"
    new_db = new_data / "audimo.db"
    if legacy_db.exists() and not new_db.exists():
        try:
            legacy_db.rename(new_db)
            print(f"[rebrand] {legacy_db} → {new_db}")
        except Exception as e:
            print(f"[rebrand] DB rename failed: {e}")

    # 4 + 5. SQLite path/addon_id rewrites
    db = new_data / "audimo.db"
    if db.exists():
        try:
            with sqlite3.connect(db) as conn:
                # Rewrite local_file paths
                for table in ("audiobook_library",):
                    try:
                        conn.execute(
                            f"UPDATE {table} SET local_file = REPLACE(local_file, ?, ?) "
                            "WHERE local_file LIKE ?",
                            (str(legacy_music), str(new_music), f"{legacy_music}%"),
                        )
                    except sqlite3.OperationalError:
                        pass  # table may not exist
                # Rewrite user_cache JSON entries: addon_id and local_file
                rewrites_json = (
                    ("/Music/Tunnel/", "/Music/Audimo/"),
                    ('"addon_id": "tunnel-aio"', '"addon_id": "audimo-aio"'),
                    ('"addon_id": "tunnel-indexers"', '"addon_id": "audimo-indexers"'),
                    ('"addon_id": "tunnel-slskd"', '"addon_id": "audimo-slskd"'),
                    ('"id": "tunnel-aio"', '"id": "audimo-aio"'),
                    ('"id": "tunnel-indexers"', '"id": "audimo-indexers"'),
                    ('"id": "tunnel-slskd"', '"id": "audimo-slskd"'),
                )
                for old, new in rewrites_json:
                    try:
                        conn.execute(
                            "UPDATE user_cache SET entry_data = REPLACE(entry_data, ?, ?) "
                            "WHERE entry_data LIKE ?",
                            (old, new, f"%{old}%"),
                        )
                    except sqlite3.OperationalError:
                        pass
                # addons table: rewrite addon_id column directly
                for old, new in (
                    ("tunnel-aio", "audimo-aio"),
                    ("tunnel-indexers", "audimo-indexers"),
                    ("tunnel-slskd", "audimo-slskd"),
                ):
                    try:
                        conn.execute("UPDATE addons SET id = ? WHERE id = ?", (new, old))
                    except sqlite3.OperationalError:
                        pass
                conn.commit()
            print(f"[rebrand] DB local_file + addon_id rewrites complete")
        except Exception as e:
            print(f"[rebrand] DB rewrite failed: {e}")

    # 6. stream_cache.json — same kind of rewrites as the DB JSON cells.
    cache_json = new_data / "stream_cache.json"
    if cache_json.exists():
        try:
            text = cache_json.read_text(encoding='utf-8')
            for old, new in (
                ("/Music/Tunnel/", "/Music/Audimo/"),
                ('"tunnel-aio"', '"audimo-aio"'),
                ('"tunnel-indexers"', '"audimo-indexers"'),
                ('"tunnel-slskd"', '"audimo-slskd"'),
            ):
                text = text.replace(old, new)
            cache_json.write_text(text, encoding='utf-8')
            print(f"[rebrand] stream_cache.json rewritten")
        except Exception as e:
            print(f"[rebrand] stream_cache.json rewrite failed: {e}")

    # 8. Remove stale rebrand stragglers. The DB rename in step 7 leaves
    # tunnel.db-{shm,wal} sidecar files; SQLite recreates them from
    # audimo.db on first open, so the old ones are dead bytes. The
    # tunnel-*.log files are pre-rebrand logs the new addons aren't
    # writing to any more. Deleting these is purely cosmetic but keeps
    # `ls ~/.audimo/` from showing pre-rename ghosts forever.
    #
    # We DO NOT auto-delete `legacy-credentials-*.bak.txt` — that's the
    # plaintext-credential backup from an even earlier migration; the
    # user should review and delete it themselves. Print a reminder
    # instead.
    for stale in ("tunnel.db-shm", "tunnel.db-wal",
                  "tunnel-aio.log", "tunnel-slskd.log"):
        p = new_data / stale
        if p.exists():
            try:
                p.unlink()
                print(f"[rebrand] removed stale {p.name}")
            except Exception as e:
                print(f"[rebrand] failed to remove {p.name}: {e}")
    for cred_bak in new_data.glob("legacy-credentials-*.bak.txt"):
        print(f"[rebrand] NOTE: plaintext-credentials backup still on "
              f"disk: {cred_bak}. Review and delete manually.")


def migrate_legacy_storage_paths() -> None:
    """One-shot move of files from the old hidden ``~/.audimo/{audiobooks,uploads}``
    locations to the new visible ones. Updates DB ``local_file``
    pointers atomically so cached entries keep playing after the move.
    Idempotent — re-running with nothing to migrate is a no-op."""
    legacy_audiobooks = CACHE_DIR / "audiobooks"
    legacy_uploads = CACHE_DIR / "uploads"
    moved = 0
    if legacy_audiobooks.exists() and legacy_audiobooks.is_dir():
        for item in legacy_audiobooks.iterdir():
            target = AUDIOBOOK_STORE / item.name
            if target.exists():
                continue
            try:
                item.rename(target)
                moved += 1
            except Exception as e:
                print(f"[storage-migrate] {item} → {target}: {e}")
    if legacy_uploads.exists() and legacy_uploads.is_dir():
        for item in legacy_uploads.iterdir():
            target = UPLOAD_STORE / item.name
            if target.exists():
                continue
            try:
                item.rename(target)
                moved += 1
            except Exception as e:
                print(f"[storage-migrate] {item} → {target}: {e}")
    if moved == 0:
        return

    # Rewrite stale local_file pointers in audiobook_library so cached
    # entries keep playing after the move. Cache rows store local_file
    # inside JSON; rewriting those is more involved — we accept that
    # the next play of an old cache row will fail, the addon will
    # redispatch, and the file will be re-downloaded into the new
    # location.
    db = CACHE_DIR / "audimo.db"
    if not db.exists():
        return
    rewrites = [
        (str(legacy_audiobooks), str(AUDIOBOOK_STORE)),
        (str(legacy_uploads), str(UPLOAD_STORE)),
    ]
    with sqlite3.connect(db) as conn:
        for old, new in rewrites:
            try:
                conn.execute(
                    "UPDATE audiobook_library "
                    "SET local_file = REPLACE(local_file, ?, ?) "
                    "WHERE local_file LIKE ?",
                    (old, new, f"{old}%"),
                )
            except Exception as e:
                print(f"[storage-migrate] audiobook_library rewrite failed: {e}")
        conn.commit()
    print(f"[storage-migrate] moved {moved} item(s) to visible folders ({MEDIA_ROOT}, {AUDIOBOOK_STORE})")


_AUDIO_EXTS = {".m4b", ".m4a", ".mp3", ".aac", ".flac", ".ogg", ".opus", ".wav"}
_FS_INVALID = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _safe_slug(s: str) -> str:
    s = _FS_INVALID.sub("_", (s or "").strip()).strip(" .")
    return s[:150] or "Unknown"


def backfill_audiobook_local_files() -> None:
    """Walk ``~/Audiobooks/{author}/{title}/`` and write back ``local_file``
    pointers for any ``audiobook_library`` row whose file is on disk but
    not yet recorded.

    Background: the pre-rebrand download path (and some addon flows)
    completed without writing the resulting ``local_file`` back to the
    DB row, so saved books displayed "no source file" even though the
    audio was on disk. This scan reconciles that on every boot.
    Idempotent — rows whose local_file is already set or whose file is
    missing are left alone.
    """
    db = CACHE_DIR / "audimo.db"
    if not db.exists():
        return
    with sqlite3.connect(db) as conn:
        conn.row_factory = sqlite3.Row
        rows = list(conn.execute(
            "SELECT user_id, id, title, author FROM audiobook_library "
            "WHERE local_file IS NULL OR local_file = ''"
        ))
        fixed = 0
        for r in rows:
            author_dir = AUDIOBOOK_STORE / _safe_slug(r["author"] or "Unknown Author")
            title_dir = author_dir / _safe_slug(r["title"] or "Unknown Title")
            if not title_dir.exists() or not title_dir.is_dir():
                continue
            found = None
            for p in sorted(title_dir.rglob("*")):
                if p.is_file() and p.suffix.lower() in _AUDIO_EXTS:
                    found = p
                    break
            if not found:
                continue
            conn.execute(
                "UPDATE audiobook_library SET local_file = ? "
                "WHERE user_id = ? AND id = ?",
                (str(found), r["user_id"], r["id"]),
            )
            fixed += 1
        if fixed:
            conn.commit()
            print(f"[audiobook-backfill] linked {fixed} on-disk file(s) to library rows")
