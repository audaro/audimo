import sqlite3
import json
import os
from pathlib import Path
from contextlib import contextmanager

from cryptography.fernet import Fernet, InvalidToken

DB_PATH = Path.home() / ".audimo" / "audimo.db"
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

# Single-user-per-install: every user-scoped row pins to this id.
# Mirrors `auth.SINGLE_USER_ID`. Kept as a module-level constant here
# so `database.py` doesn't have to import from `auth.py`.
SINGLE_USER_ID = 1
SINGLE_USER_EMAIL = "owner@audimo.local"


# ── Addon-settings encryption ─────────────────────────────────────
#
# Per-user addon settings can hold credentials (API keys, session
# cookies, etc. — opaque to core). For a multi-user public deployment
# Audimo core is the trust boundary, so a DB leak should not expose those
# secrets in plaintext. We Fernet-encrypt the JSON blob before write and
# decrypt on read.
#
# Key resolution order:
#   1. $AUDIMO_SECRET_KEY  (set by the Tauri shell from OS keychain)
#   2. $TUNNEL_SECRET_KEY  (legacy env name — kept for back-compat)
#   3. ~/.audimo/secret.key (auto-generated on first boot for dev /
#      keychain-denied builds)
#
# Fernet keys are 32 raw bytes, base64url-encoded → 44 chars. Generate
# one with:
#   python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
#
# Storage move: the canonical key now lives in the OS keychain (macOS
# Keychain Services, Windows Credential Manager, Linux Secret Service)
# under app.audimo.desktop/db_secret_key. The Tauri shell mints on
# first boot and passes the value via env to the backend. The file
# fallback survives so a dev-mode `./venv/bin/uvicorn` (no shell) still
# boots.
#
# Migration: rows written before encryption was added are plaintext
# JSON. On read we try Fernet first, fall back to json.loads. The
# next write of that row re-encrypts it transparently.

_SECRET_PATH = Path.home() / ".audimo" / "secret.key"


def _load_or_create_key() -> bytes:
    for name in ("AUDIMO_SECRET_KEY", "TUNNEL_SECRET_KEY"):
        env_key = os.environ.get(name, "").strip()
        if env_key:
            # Validate by constructing a Fernet — fails fast on bad
            # keys rather than at first encrypt call.
            Fernet(env_key.encode())
            return env_key.encode()
    if _SECRET_PATH.exists():
        return _SECRET_PATH.read_bytes().strip()
    _SECRET_PATH.parent.mkdir(parents=True, exist_ok=True)
    key = Fernet.generate_key()
    _SECRET_PATH.write_bytes(key)
    # Owner-only — the file is the entire encryption key for every
    # user's addon settings, so leak protection matches DB protection.
    try:
        os.chmod(_SECRET_PATH, 0o600)
    except OSError:
        pass
    return key


_FERNET = Fernet(_load_or_create_key())


def _is_fernet_blob(s: str | None) -> bool:
    """Quick discriminator: Fernet ciphertext is base64url and starts with
    `gAAAAA` (version byte 0x80 + first 4 timestamp bytes), so anything
    starting with `{` or empty is definitely legacy plaintext."""
    return bool(s) and s.startswith("gAAAAA")


def _encrypt_settings(data: dict) -> str:
    return _FERNET.encrypt(json.dumps(data or {}).encode("utf-8")).decode("ascii")


def _decrypt_settings(blob: str | None) -> dict:
    """Decrypt a stored settings blob. Falls back to plain JSON parse for
    rows written before encryption was rolled out."""
    if not blob:
        return {}
    try:
        plaintext = _FERNET.decrypt(blob.encode("ascii"))
        return json.loads(plaintext) or {}
    except InvalidToken:
        # Legacy plaintext row. Will be re-encrypted on next save.
        try:
            return json.loads(blob) or {}
        except Exception:
            return {}
    except Exception:
        return {}


@contextmanager
def get_db():
    # timeout=30: SQLite's busy-handler retries write-lock acquisition
    # up to this many seconds when another connection is mid-write.
    # WAL mode lets readers proceed during writes, but two concurrent
    # writers (e.g. an addon-purge background task and a synchronous
    # cache.add) can still collide; without an explicit timeout, the
    # SECOND writer fails immediately with "database is locked" and
    # the request 500s. 30s is generous (real contention is sub-
    # second on a single-user desktop) but cheap.
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    # Make WAL durable enough for a desktop app without paying the
    # FULL fsync cost on every commit. NORMAL is the standard
    # recommendation for WAL: writes are crash-safe; only the most
    # recent unsynced transactions can be lost on power failure.
    conn.execute("PRAGMA synchronous=NORMAL")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    with get_db() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT UNIQUE NOT NULL COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                is_admin INTEGER DEFAULT 0,
                disabled INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS global_config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL DEFAULT ''
            );

            -- Pre-addon-architecture this table held per-user upstream
            -- service credentials. Those have moved into addon settings
            -- (encrypted via the addon_settings table). The only field
            -- that still lives here is the ListenBrainz scrobble token.
            CREATE TABLE IF NOT EXISTS user_settings (
                user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                listenbrainz_token TEXT DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS playlists (
                id TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS playlist_tracks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
                position INTEGER NOT NULL,
                track_data TEXT NOT NULL
            );

            -- Paired devices — purely for visibility. Single-user
            -- single-tenant means all devices share one API key, so
            -- "revoke" is implemented as "regenerate the key" (which
            -- forgets everything in this table on next pair).
            CREATE TABLE IF NOT EXISTS paired_devices (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL DEFAULT '',
                user_agent TEXT NOT NULL DEFAULT '',
                paired_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS user_cache (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                cache_key TEXT NOT NULL,
                entry_data TEXT NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, cache_key)
            );

            CREATE TABLE IF NOT EXISTS addons (
                id TEXT NOT NULL,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                url TEXT NOT NULL,
                manifest TEXT NOT NULL,
                enabled INTEGER DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, id)
            );

            -- Per-user × per-addon settings (one JSON blob per addon).
            -- Schema is whatever the addon declares in its manifest.settings_schema.
            CREATE TABLE IF NOT EXISTS addon_settings (
                user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                addon_id TEXT NOT NULL,
                data     TEXT NOT NULL DEFAULT '{}',
                PRIMARY KEY (user_id, addon_id)
            );

            CREATE TABLE IF NOT EXISTS audiobook_bookmarks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                book_id TEXT NOT NULL,
                position_s REAL NOT NULL,           -- seconds within the book
                chapter_index INTEGER DEFAULT NULL, -- 1-based chapter at the bookmarked time, optional
                title TEXT NOT NULL DEFAULT '',     -- user-provided label
                note TEXT NOT NULL DEFAULT '',      -- optional longer note
                created_at INTEGER NOT NULL         -- unix epoch seconds
            );
            CREATE INDEX IF NOT EXISTS idx_audiobook_bookmarks_user_book
                ON audiobook_bookmarks (user_id, book_id, position_s);

            CREATE TABLE IF NOT EXISTS play_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                played_at INTEGER NOT NULL,            -- unix epoch seconds
                track_title TEXT NOT NULL DEFAULT '',
                track_artist TEXT NOT NULL DEFAULT '',
                track_album TEXT NOT NULL DEFAULT '',
                album_cover TEXT NOT NULL DEFAULT '',
                source TEXT NOT NULL DEFAULT '',       -- e.g. RD CACHE, slskd, LIBRARY
                addon_id TEXT NOT NULL DEFAULT '',
                kind TEXT NOT NULL DEFAULT 'music',    -- 'music' | 'audiobook'
                duration_played_s INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_play_history_user_ts
                ON play_history (user_id, played_at DESC);

            CREATE TABLE IF NOT EXISTS audiobook_chapters (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                book_id TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'gemini',  -- gemini | silence | manual
                index_n INTEGER NOT NULL,               -- 1-based chapter index
                title TEXT NOT NULL DEFAULT '',
                start_s REAL NOT NULL,
                end_s REAL NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_audiobook_chapters_user_book
                ON audiobook_chapters (user_id, book_id, index_n);

            -- Podcasts (Phase 1a). Subscriptions are per-user RSS
            -- feeds; episodes are a snapshot of the feed at last
            -- refresh, refreshed lazily on detail-view fetch.
            CREATE TABLE IF NOT EXISTS podcasts (
                id TEXT NOT NULL,                     -- sha1(feed_url)[:16]
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                feed_url TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                author TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                artwork TEXT NOT NULL DEFAULT '',
                website TEXT NOT NULL DEFAULT '',
                last_refreshed INTEGER NOT NULL DEFAULT 0,  -- unix epoch
                subscribed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                auto_download INTEGER NOT NULL DEFAULT 0,   -- 0/1: download new episodes automatically
                auto_cleanup_played INTEGER NOT NULL DEFAULT 0,  -- 0/1: delete local file when episode is marked played
                last_opened_at INTEGER NOT NULL DEFAULT 0,  -- unix epoch when detail page was last viewed; episodes published after this count as "new"
                PRIMARY KEY (user_id, id)
            );

            CREATE TABLE IF NOT EXISTS podcast_episodes (
                id TEXT NOT NULL,                     -- sha1(podcast_id + guid)[:24]
                user_id INTEGER NOT NULL,
                podcast_id TEXT NOT NULL,
                guid TEXT NOT NULL DEFAULT '',
                title TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                audio_url TEXT NOT NULL DEFAULT '',
                pub_date INTEGER NOT NULL DEFAULT 0,  -- unix epoch
                duration_s INTEGER NOT NULL DEFAULT 0,
                artwork TEXT NOT NULL DEFAULT '',
                position_s REAL NOT NULL DEFAULT 0,   -- 0 = no progress (or fully replayed)
                played_at INTEGER NOT NULL DEFAULT 0, -- unix epoch of "completed" event; 0 = unplayed
                local_file TEXT NOT NULL DEFAULT '',  -- absolute path under PODCAST_STORE; '' = stream-only
                PRIMARY KEY (user_id, id),
                FOREIGN KEY (user_id, podcast_id) REFERENCES podcasts(user_id, id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_podcast_episodes_user_pod
                ON podcast_episodes (user_id, podcast_id, pub_date DESC);

            CREATE TABLE IF NOT EXISTS audiobook_library (
                id TEXT NOT NULL,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                author TEXT DEFAULT '',
                cover TEXT DEFAULT '',
                format TEXT DEFAULT '',
                size TEXT DEFAULT '',
                categories TEXT DEFAULT '[]',
                magnet TEXT DEFAULT '',
                detail_url TEXT DEFAULT '',
                local_file TEXT DEFAULT '',
                added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, id)
            );
        """)
        # Migrations for existing DBs
        for col, defn in [("is_admin", "INTEGER DEFAULT 0"), ("disabled", "INTEGER DEFAULT 0")]:
            try:
                conn.execute(f"ALTER TABLE users ADD COLUMN {col} {defn}")
            except Exception:
                pass
        try:
            conn.execute("ALTER TABLE audiobook_library ADD COLUMN local_file TEXT DEFAULT ''")
        except Exception:
            pass
        # Podcast played-state — added in Phase 1b. Older DBs already
        # have the table from 1a without these columns.
        for col, defn in [
            ("position_s", "REAL NOT NULL DEFAULT 0"),
            ("played_at", "INTEGER NOT NULL DEFAULT 0"),
            ("local_file", "TEXT NOT NULL DEFAULT ''"),
        ]:
            try:
                conn.execute(f"ALTER TABLE podcast_episodes ADD COLUMN {col} {defn}")
            except Exception:
                pass
        try:
            conn.execute("ALTER TABLE podcasts ADD COLUMN auto_download INTEGER NOT NULL DEFAULT 0")
        except Exception:
            pass
        try:
            conn.execute("ALTER TABLE podcasts ADD COLUMN auto_cleanup_played INTEGER NOT NULL DEFAULT 0")
        except Exception:
            pass
        try:
            conn.execute("ALTER TABLE podcasts ADD COLUMN last_opened_at INTEGER NOT NULL DEFAULT 0")
        except Exception:
            pass
        # Backfill: rows that pre-date this column have last_opened_at=0,
        # which would tag every historical episode as new. Seed to the
        # subscribed_at timestamp (or now if that's not parseable) so
        # the new badge starts at zero for already-followed shows.
        try:
            conn.execute(
                """UPDATE podcasts
                   SET last_opened_at = COALESCE(
                       CAST(strftime('%s', subscribed_at) AS INTEGER),
                       CAST(strftime('%s', 'now') AS INTEGER)
                   )
                   WHERE last_opened_at = 0"""
            )
        except Exception:
            pass
        # ListenBrainz scrobbling. Empty string = disabled (no submit
        # happens). Token is the user's ListenBrainz API token from
        # listenbrainz.org/profile — submitted to listenbrainz.org with
        # every scrobble. Single-user, so we don't need per-user
        # encryption beyond the SQLite file living under ~/.audimo.
        try:
            conn.execute("ALTER TABLE user_settings ADD COLUMN listenbrainz_token TEXT DEFAULT ''")
        except Exception:
            pass
        # Gemini API key — earlier experiment for chapter detection.
        # Pivoted to AssemblyAI because Gemini's audio LLM hallucinates
        # timestamps; the column lingers on existing DBs (sqlite can't
        # cheaply drop columns) and is now unread.
        try:
            conn.execute("ALTER TABLE user_settings ADD COLUMN gemini_api_key TEXT DEFAULT ''")
        except Exception:
            pass
        # AssemblyAI API key — drives the Auto Chapters flow on
        # downloaded audiobooks. Their ASR pipeline gives real
        # word-level timestamps, so chapter boundaries are grounded
        # in audio position rather than LLM guessing.
        try:
            conn.execute("ALTER TABLE user_settings ADD COLUMN assemblyai_api_key TEXT DEFAULT ''")
        except Exception:
            pass
        # Auto-download: when on, every play kicks off a parallel
        # disk download in the background. INTEGER (0/1) since
        # SQLite has no native bool. Default off — disk fills up
        # fast otherwise on heavy listeners.
        try:
            conn.execute("ALTER TABLE user_settings ADD COLUMN auto_download INTEGER DEFAULT 0")
        except Exception:
            pass
        # acoustid_api_key column was added in an earlier rev for the
        # AcoustID fingerprint-backfill flow. The flow itself was pulled;
        # the column lingers on existing DBs because SQLite can't drop
        # columns cheaply. Just stop reading/writing it — the data is
        # harmless dead weight.
        try:
            conn.execute("CREATE TABLE IF NOT EXISTS global_config (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')")
        except Exception:
            pass
        # Single-user install: ensure the synthetic owner row exists at
        # the well-known id=SINGLE_USER_ID so all the user-scoped
        # foreign keys have something to point at. The `password_hash`
        # column is required by the legacy schema but unused now (no
        # login flow), so we stash a placeholder.
        conn.execute(
            "INSERT OR IGNORE INTO users (id, email, password_hash, is_admin) VALUES (?, ?, '', 1)",
            (SINGLE_USER_ID, SINGLE_USER_EMAIL),
        )
        conn.execute(
            "UPDATE users SET is_admin = 1, disabled = 0 WHERE id = ?",
            (SINGLE_USER_ID,),
        )

    # One-shot migration: re-encrypt any addon_settings rows still in
    # plaintext from before encryption was rolled out. Idempotent — rows
    # already in Fernet form are skipped, and re-running this on a fully
    # migrated DB is a no-op.
    _migrate_plaintext_addon_settings()

    # One-shot migration: drop legacy SoundCloud / YouTube / Bandcamp
    # cache rows now that those source paths have been removed from the
    # native app. The matching JSON looks like `"type": "sc"` /
    # `"type": "youtube"` / `"type": "bandcamp"` with no `addon_id`.
    # Idempotent — once purged, future boots match nothing.
    _purge_legacy_streaming_cache_rows()


def _purge_legacy_streaming_cache_rows() -> None:
    with get_db() as conn:
        total = 0
        for type_token in ('"type": "sc"', '"type": "youtube"', '"type": "bandcamp"'):
            cur = conn.execute(
                "DELETE FROM user_cache WHERE entry_data LIKE ? AND entry_data NOT LIKE '%\"addon_id\"%'",
                (f"%{type_token}%",),
            )
            total += cur.rowcount or 0
        if total:
            print(f"[db] purged {total} legacy SC/YT/BC user_cache row(s)")


def _migrate_plaintext_addon_settings() -> None:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT user_id, addon_id, data FROM addon_settings"
        ).fetchall()
        migrated = 0
        for r in rows:
            data = r["data"]
            if _is_fernet_blob(data):
                continue
            try:
                parsed = json.loads(data) if data else {}
            except Exception:
                # Unparseable garbage — leave it alone, _decrypt_settings
                # will return {} for it on read.
                continue
            conn.execute(
                "UPDATE addon_settings SET data = ? WHERE user_id = ? AND addon_id = ?",
                (_encrypt_settings(parsed), r["user_id"], r["addon_id"]),
            )
            migrated += 1
        if migrated:
            print(f"[db] encrypted {migrated} legacy addon_settings row(s) at rest")


def get_user_by_email(email: str):
    with get_db() as conn:
        row = conn.execute("SELECT * FROM users WHERE email = ?", (email.lower().strip(),)).fetchone()
    return dict(row) if row else None


def get_user_by_id(user_id: int):
    with get_db() as conn:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return dict(row) if row else None


def create_user(email: str, password_hash: str) -> int:
    with get_db() as conn:
        existing_count = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        is_admin = 1 if existing_count == 0 else 0
        cursor = conn.execute(
            "INSERT INTO users (email, password_hash, is_admin) VALUES (?, ?, ?)",
            (email.lower().strip(), password_hash, is_admin)
        )
        user_id = cursor.lastrowid
        conn.execute("INSERT INTO user_settings (user_id) VALUES (?)", (user_id,))
    return user_id


def get_user_settings(user_id: int) -> dict:
    with get_db() as conn:
        row = conn.execute(
            """SELECT user_id, listenbrainz_token, gemini_api_key,
                      assemblyai_api_key, auto_download
               FROM user_settings WHERE user_id = ?""",
            (user_id,),
        ).fetchone()
    if row:
        d = dict(row)
        d["listenbrainz_token"] = d.get("listenbrainz_token") or ""
        d["gemini_api_key"] = d.get("gemini_api_key") or ""
        d["assemblyai_api_key"] = d.get("assemblyai_api_key") or ""
        d["auto_download"] = bool(d.get("auto_download") or 0)
        return d
    return {
        "user_id": user_id,
        "listenbrainz_token": "",
        "gemini_api_key": "",
        "assemblyai_api_key": "",
        "auto_download": False,
    }


def update_user_settings(user_id: int, settings: dict):
    # Hard-coded per-column branches (no f-string identifier
    # interpolation) so the SQL surface stays minimal and obviously
    # safe — the previous whitelist + dynamic-column dance was a
    # footgun. One branch per known column; unknown keys are ignored.
    known_columns = {"listenbrainz_token", "gemini_api_key", "assemblyai_api_key", "auto_download"}
    fields = {k: settings[k] for k in known_columns if k in settings}
    if not fields:
        return
    with get_db() as conn:
        conn.execute("INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)", (user_id,))
        if "listenbrainz_token" in fields:
            conn.execute(
                "UPDATE user_settings SET listenbrainz_token = ? WHERE user_id = ?",
                (fields["listenbrainz_token"], user_id),
            )
        if "gemini_api_key" in fields:
            conn.execute(
                "UPDATE user_settings SET gemini_api_key = ? WHERE user_id = ?",
                (fields["gemini_api_key"], user_id),
            )
        if "assemblyai_api_key" in fields:
            conn.execute(
                "UPDATE user_settings SET assemblyai_api_key = ? WHERE user_id = ?",
                (fields["assemblyai_api_key"], user_id),
            )
        if "auto_download" in fields:
            conn.execute(
                "UPDATE user_settings SET auto_download = ? WHERE user_id = ?",
                (1 if fields["auto_download"] else 0, user_id),
            )


# ── Admin ──────────────────────────────────────────────────────

def get_all_users() -> list:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, email, created_at, is_admin, disabled FROM users ORDER BY id"
        ).fetchall()
    return [dict(r) for r in rows]


def set_user_disabled(user_id: int, disabled: bool):
    with get_db() as conn:
        conn.execute("UPDATE users SET disabled = ? WHERE id = ?", (1 if disabled else 0, user_id))


def delete_user(user_id: int):
    with get_db() as conn:
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    # Evict in-memory cache if present
    try:
        from main import _user_caches
        _user_caches.pop(user_id, None)
    except Exception:
        pass


def get_global_config() -> dict:
    with get_db() as conn:
        rows = conn.execute("SELECT key, value FROM global_config").fetchall()
    return {r["key"]: r["value"] for r in rows}


def set_global_config(config: dict):
    # Pre-addon-architecture this stored upstream service URLs. Those
    # have moved into per-addon settings. The endpoint is kept as a
    # no-op write for backward-compat; nothing in core reads from
    # global_config anymore.
    return


# ── Playlists ─────────────────────────────────────────────────

def get_playlists(user_id: int) -> list:
    with get_db() as conn:
        playlists = conn.execute(
            "SELECT id, name, created_at FROM playlists WHERE user_id = ? ORDER BY created_at",
            (user_id,)
        ).fetchall()
        result = []
        for pl in playlists:
            tracks = conn.execute(
                "SELECT track_data FROM playlist_tracks WHERE playlist_id = ? ORDER BY position",
                (pl["id"],)
            ).fetchall()
            result.append({
                "id": pl["id"],
                "name": pl["name"],
                "tracks": [json.loads(t["track_data"]) for t in tracks],
            })
    return result


def create_playlist(user_id: int, playlist_id: str, name: str):
    with get_db() as conn:
        conn.execute(
            "INSERT INTO playlists (id, user_id, name) VALUES (?, ?, ?)",
            (playlist_id, user_id, name)
        )


def rename_playlist(user_id: int, playlist_id: str, name: str):
    with get_db() as conn:
        conn.execute(
            "UPDATE playlists SET name = ? WHERE id = ? AND user_id = ?",
            (name, playlist_id, user_id)
        )


def delete_playlist(user_id: int, playlist_id: str):
    with get_db() as conn:
        conn.execute(
            "DELETE FROM playlists WHERE id = ? AND user_id = ?",
            (playlist_id, user_id)
        )


def add_track_to_playlist(playlist_id: str, track: dict, position: int):
    with get_db() as conn:
        conn.execute(
            "INSERT INTO playlist_tracks (playlist_id, position, track_data) VALUES (?, ?, ?)",
            (playlist_id, position, json.dumps(track))
        )


def remove_track_from_playlist(playlist_id: str, track_key: str):
    with get_db() as conn:
        tracks = conn.execute(
            "SELECT id, track_data FROM playlist_tracks WHERE playlist_id = ? ORDER BY position",
            (playlist_id,)
        ).fetchall()
        to_delete = [t["id"] for t in tracks if json.loads(t["track_data"]).get("key") == track_key]
        for tid in to_delete:
            conn.execute("DELETE FROM playlist_tracks WHERE id = ?", (tid,))


def reorder_playlist_tracks(playlist_id: str, tracks: list):
    with get_db() as conn:
        conn.execute("DELETE FROM playlist_tracks WHERE playlist_id = ?", (playlist_id,))
        for i, track in enumerate(tracks):
            conn.execute(
                "INSERT INTO playlist_tracks (playlist_id, position, track_data) VALUES (?, ?, ?)",
                (playlist_id, i, json.dumps(track))
            )


# ── Paired devices ────────────────────────────────────────────
#
# Single-user single-tenant install means every device shares the
# same API key. We can't actually "revoke" a single device without
# rotating the key (which kicks all of them); what we CAN do is
# remember which devices have paired so the user has visibility, and
# expose a "regenerate API key" shortcut from the same UI.
#
# Schema:
#   id          — auto pk
#   user_id     — FK to users
#   name        — best-effort label (UA snippet or "Phone scanned at <ts>")
#   user_agent  — full UA string at pair time
#   paired_at   — when /api/pair/redeem fired
#   last_seen   — last request that included the API key with this UA

def add_paired_device(user_id: int, name: str, user_agent: str) -> int:
    """Record a paired device, deduplicating by user_agent so the same
    iPhone re-redeeming a reusable home-screen token doesn't pile up
    a fresh row on every launch. If a row with the same UA already
    exists, bump its last_seen + name instead of inserting."""
    with get_db() as conn:
        existing = conn.execute(
            """SELECT id FROM paired_devices
               WHERE user_id = ? AND user_agent = ?
               ORDER BY paired_at DESC LIMIT 1""",
            (user_id, user_agent),
        ).fetchone()
        if existing:
            conn.execute(
                "UPDATE paired_devices SET last_seen = CURRENT_TIMESTAMP, name = ? WHERE id = ?",
                (name, existing["id"]),
            )
            return existing["id"]
        cur = conn.execute(
            """INSERT INTO paired_devices (user_id, name, user_agent, paired_at, last_seen)
               VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)""",
            (user_id, name, user_agent),
        )
        return cur.lastrowid


def list_paired_devices(user_id: int) -> list[dict]:
    with get_db() as conn:
        rows = conn.execute(
            """SELECT id, name, user_agent, paired_at, last_seen
               FROM paired_devices WHERE user_id = ?
               ORDER BY paired_at DESC""",
            (user_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def forget_paired_device(user_id: int, device_id: int) -> bool:
    with get_db() as conn:
        cur = conn.execute(
            "DELETE FROM paired_devices WHERE user_id = ? AND id = ?",
            (user_id, device_id),
        )
        return cur.rowcount > 0


def remove_track_from_all_user_playlists(user_id: int, track_key: str) -> int:
    """Cascade-delete a track key from every playlist belonging to a
    user. Used when the user removes a song from their library — the
    playlists referencing it should drop the row rather than retain a
    dangling cache_key that resolves to nothing.

    Returns the number of playlist_tracks rows actually deleted.
    """
    with get_db() as conn:
        rows = conn.execute(
            """SELECT pt.id, pt.track_data
               FROM playlist_tracks pt
               JOIN playlists p ON p.id = pt.playlist_id
               WHERE p.user_id = ?""",
            (user_id,),
        ).fetchall()
        to_delete: list[int] = []
        for r in rows:
            try:
                if json.loads(r["track_data"]).get("key") == track_key:
                    to_delete.append(r["id"])
            except Exception:
                continue
        for tid in to_delete:
            conn.execute("DELETE FROM playlist_tracks WHERE id = ?", (tid,))
        return len(to_delete)


# ── Per-user cache ────────────────────────────────────────────

def load_user_cache(user_id: int) -> dict:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT cache_key, entry_data FROM user_cache WHERE user_id = ?", (user_id,)
        ).fetchall()
    return {row["cache_key"]: json.loads(row["entry_data"]) for row in rows}


def save_cache_entry(user_id: int, cache_key: str, entry_data: dict):
    with get_db() as conn:
        conn.execute(
            """INSERT OR REPLACE INTO user_cache (user_id, cache_key, entry_data, updated_at)
               VALUES (?, ?, ?, CURRENT_TIMESTAMP)""",
            (user_id, cache_key, json.dumps(entry_data))
        )


def delete_cache_entry(user_id: int, cache_key: str):
    with get_db() as conn:
        conn.execute(
            "DELETE FROM user_cache WHERE user_id = ? AND cache_key = ?",
            (user_id, cache_key)
        )


def delete_cache_entries(user_id: int, cache_keys: list[str]) -> int:
    """Bulk-delete `user_cache` rows by key. Returns rows affected.
    Used by the lazy-prune path in `/api/cache/list` so a backlog of
    legacy entries doesn't pay one round-trip per key."""
    if not cache_keys:
        return 0
    placeholders = ",".join("?" * len(cache_keys))
    with get_db() as conn:
        cur = conn.execute(
            f"DELETE FROM user_cache WHERE user_id = ? AND cache_key IN ({placeholders})",
            (user_id, *cache_keys),
        )
        return cur.rowcount or 0


def clear_user_cache(user_id: int):
    with get_db() as conn:
        conn.execute("DELETE FROM user_cache WHERE user_id = ?", (user_id,))


def count_cache_entries_by_addon_id(user_id: int, addon_id: str) -> int:
    """Count user_cache rows whose JSON ``entry_data`` is tagged with the given
    ``addon_id``. Used by the AddonsView confirmation dialog so the user sees
    how many library tracks will be removed before they disable or delete.
    """
    if not addon_id:
        return 0
    pattern = f'%"addon_id": "{addon_id}"%'
    with get_db() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS c FROM user_cache WHERE user_id = ? AND entry_data LIKE ?",
            (user_id, pattern),
        ).fetchone()
    return int(row["c"] or 0)


def delete_cache_entries_by_addon_id(user_id: int, addon_id: str) -> list[str]:
    """Delete every user_cache row tagged with ``addon_id``. Returns the list of
    removed ``cache_key`` values so callers can also evict the in-memory cache.
    """
    if not addon_id:
        return []
    pattern = f'%"addon_id": "{addon_id}"%'
    with get_db() as conn:
        rows = conn.execute(
            "SELECT cache_key FROM user_cache WHERE user_id = ? AND entry_data LIKE ?",
            (user_id, pattern),
        ).fetchall()
        if rows:
            conn.execute(
                "DELETE FROM user_cache WHERE user_id = ? AND entry_data LIKE ?",
                (user_id, pattern),
            )
    return [r["cache_key"] for r in rows]


# ── Addons ────────────────────────────────────────────────────

def get_addons(user_id: int) -> list:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, url, manifest, enabled FROM addons WHERE user_id = ? ORDER BY created_at",
            (user_id,)
        ).fetchall()
        # Fetch per-user settings so AddonsView can pre-fill the form.
        setting_rows = conn.execute(
            "SELECT addon_id, data FROM addon_settings WHERE user_id = ?",
            (user_id,)
        ).fetchall()
    settings_by_id = {s["addon_id"]: _decrypt_settings(s["data"]) for s in setting_rows}
    return [
        {
            "id": r["id"],
            "url": r["url"],
            "enabled": bool(r["enabled"]),
            "settings": settings_by_id.get(r["id"], {}),
            **json.loads(r["manifest"]),
        }
        for r in rows
    ]


def save_addon(user_id: int, addon_id: str, url: str, manifest: dict):
    with get_db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO addons (id, user_id, url, manifest) VALUES (?, ?, ?, ?)",
            (addon_id, user_id, url, json.dumps(manifest))
        )


def delete_addon(user_id: int, addon_id: str):
    with get_db() as conn:
        conn.execute("DELETE FROM addons WHERE user_id = ? AND id = ?", (user_id, addon_id))


def set_addon_enabled(user_id: int, addon_id: str, enabled: bool):
    with get_db() as conn:
        conn.execute(
            "UPDATE addons SET enabled = ? WHERE user_id = ? AND id = ?",
            (1 if enabled else 0, user_id, addon_id)
        )


def get_addon_settings(user_id: int, addon_id: str) -> dict:
    with get_db() as conn:
        row = conn.execute(
            "SELECT data FROM addon_settings WHERE user_id = ? AND addon_id = ?",
            (user_id, addon_id),
        ).fetchone()
    if not row:
        return {}
    return _decrypt_settings(row["data"])


def save_addon_settings(user_id: int, addon_id: str, data: dict):
    with get_db() as conn:
        conn.execute(
            """INSERT INTO addon_settings (user_id, addon_id, data) VALUES (?, ?, ?)
               ON CONFLICT(user_id, addon_id) DO UPDATE SET data = excluded.data""",
            (user_id, addon_id, _encrypt_settings(data)),
        )


# ── Audiobook Library ─────────────────────────────────────────

def get_audiobook_library(user_id: int) -> list:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM audiobook_library WHERE user_id = ? ORDER BY added_at DESC",
            (user_id,)
        ).fetchall()
    return [{
        "id": r["id"],
        "title": r["title"],
        "author": r["author"],
        "cover": r["cover"],
        "format": r["format"],
        "size": r["size"],
        "categories": json.loads(r["categories"] or "[]"),
        "magnet": r["magnet"],
        "detailUrl": r["detail_url"],
        "localFile": r["local_file"] or "",
        "addedAt": r["added_at"],
    } for r in rows]


def save_audiobook_entry(user_id: int, entry: dict):
    """Upsert an audiobook into the library. entry must have at least 'id' and 'title'."""
    with get_db() as conn:
        conn.execute(
            """INSERT INTO audiobook_library
               (id, user_id, title, author, cover, format, size, categories, magnet, detail_url, local_file)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(user_id, id) DO UPDATE SET
                 title=excluded.title, author=excluded.author, cover=excluded.cover,
                 format=excluded.format, size=excluded.size, categories=excluded.categories,
                 magnet=excluded.magnet, detail_url=excluded.detail_url,
                 local_file=CASE WHEN excluded.local_file != '' THEN excluded.local_file ELSE local_file END
            """,
            (
                entry["id"], user_id,
                entry.get("title", ""),
                entry.get("author", ""),
                entry.get("cover", ""),
                entry.get("format", ""),
                entry.get("size", ""),
                json.dumps(entry.get("categories", [])),
                entry.get("magnet", ""),
                entry.get("detailUrl", ""),
                entry.get("localFile", ""),
            )
        )


def set_audiobook_local_file(user_id: int, entry_id: str, local_file: str):
    """Set (or clear) the local_file path for a library entry."""
    with get_db() as conn:
        conn.execute(
            "UPDATE audiobook_library SET local_file = ? WHERE user_id = ? AND id = ?",
            (local_file, user_id, entry_id)
        )


def delete_audiobook_entry(user_id: int, entry_id: str):
    with get_db() as conn:
        conn.execute(
            "DELETE FROM audiobook_library WHERE user_id = ? AND id = ?",
            (user_id, entry_id)
        )


# ── Podcasts ──────────────────────────────────────────────────

def list_podcasts(user_id: int) -> list[dict]:
    """Subscriptions plus a `new_count` per show: episodes that are
    both unplayed AND published after the user last opened the show's
    detail page. Opening the show resets the baseline (`last_opened_at`
    bumps to now), which is what makes the badge clear from one
    interaction. First-time subscribe seeds last_opened_at to the
    subscription time so the user only sees badges for episodes that
    drop AFTER they followed, not the entire back catalog."""
    with get_db() as conn:
        rows = conn.execute(
            """SELECT p.id, p.feed_url, p.title, p.author, p.description, p.artwork,
                      p.website, p.last_refreshed, p.subscribed_at,
                      p.auto_download, p.auto_cleanup_played, p.last_opened_at,
                      COALESCE(SUM(CASE
                          WHEN e.played_at = 0 AND e.pub_date > p.last_opened_at
                          THEN 1 ELSE 0
                      END), 0) AS new_count
               FROM podcasts p
               LEFT JOIN podcast_episodes e
                 ON e.user_id = p.user_id AND e.podcast_id = p.id
               WHERE p.user_id = ?
               GROUP BY p.id
               ORDER BY p.subscribed_at DESC""",
            (user_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def get_podcast(user_id: int, podcast_id: str) -> dict | None:
    with get_db() as conn:
        row = conn.execute(
            """SELECT id, feed_url, title, author, description, artwork,
                      website, last_refreshed, subscribed_at,
                      auto_download, auto_cleanup_played, last_opened_at
               FROM podcasts WHERE user_id = ? AND id = ?""",
            (user_id, podcast_id),
        ).fetchone()
    return dict(row) if row else None


def set_podcast_auto_download(user_id: int, podcast_id: str, enabled: bool) -> bool:
    with get_db() as conn:
        cur = conn.execute(
            "UPDATE podcasts SET auto_download = ? WHERE user_id = ? AND id = ?",
            (1 if enabled else 0, user_id, podcast_id),
        )
        return cur.rowcount > 0


def mark_podcast_seen(user_id: int, podcast_id: str) -> bool:
    """Stamp last_opened_at to now. Used when the user opens the show
    detail page; clears the card badge from that interaction on. The
    detail view captures the prior value (returned to it via
    get_podcast / list_podcasts) so per-episode NEW pips persist for
    the current view."""
    import time as _time
    with get_db() as conn:
        cur = conn.execute(
            "UPDATE podcasts SET last_opened_at = ? WHERE user_id = ? AND id = ?",
            (int(_time.time()), user_id, podcast_id),
        )
        return cur.rowcount > 0


def set_podcast_auto_cleanup(user_id: int, podcast_id: str, enabled: bool) -> bool:
    with get_db() as conn:
        cur = conn.execute(
            "UPDATE podcasts SET auto_cleanup_played = ? WHERE user_id = ? AND id = ?",
            (1 if enabled else 0, user_id, podcast_id),
        )
        return cur.rowcount > 0


def upsert_podcast(user_id: int, podcast: dict):
    with get_db() as conn:
        conn.execute(
            """INSERT INTO podcasts
               (id, user_id, feed_url, title, author, description, artwork, website, last_refreshed)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(user_id, id) DO UPDATE SET
                 feed_url=excluded.feed_url,
                 title=excluded.title,
                 author=excluded.author,
                 description=excluded.description,
                 artwork=excluded.artwork,
                 website=excluded.website,
                 last_refreshed=excluded.last_refreshed""",
            (
                podcast["id"], user_id,
                podcast["feed_url"],
                podcast.get("title", ""),
                podcast.get("author", ""),
                podcast.get("description", ""),
                podcast.get("artwork", ""),
                podcast.get("website", ""),
                int(podcast.get("last_refreshed", 0)),
            ),
        )


def delete_podcast(user_id: int, podcast_id: str):
    with get_db() as conn:
        conn.execute(
            "DELETE FROM podcasts WHERE user_id = ? AND id = ?",
            (user_id, podcast_id),
        )


def list_podcast_episodes(user_id: int, podcast_id: str) -> list[dict]:
    with get_db() as conn:
        rows = conn.execute(
            """SELECT id, guid, title, description, audio_url, pub_date,
                      duration_s, artwork, position_s, played_at, local_file
               FROM podcast_episodes
               WHERE user_id = ? AND podcast_id = ?
               ORDER BY pub_date DESC""",
            (user_id, podcast_id),
        ).fetchall()
    return [dict(r) for r in rows]


def get_podcast_episode(user_id: int, episode_id: str) -> dict | None:
    with get_db() as conn:
        row = conn.execute(
            """SELECT id, podcast_id, guid, title, audio_url, pub_date,
                      duration_s, position_s, played_at, local_file
               FROM podcast_episodes WHERE user_id = ? AND id = ?""",
            (user_id, episode_id),
        ).fetchone()
    return dict(row) if row else None


def set_podcast_episode_local_file(user_id: int, episode_id: str, local_file: str):
    with get_db() as conn:
        conn.execute(
            "UPDATE podcast_episodes SET local_file = ? WHERE user_id = ? AND id = ?",
            (local_file, user_id, episode_id),
        )


def set_podcast_episode_progress(
    user_id: int, episode_id: str,
    position_s: float, completed: bool, duration_s: int | None = None,
) -> bool:
    """Heartbeat from the player. `completed=True` stamps played_at and
    zeroes position_s so the next play starts fresh. Otherwise just
    updates position. Returns True if a row was actually updated."""
    import time as _time
    with get_db() as conn:
        if completed:
            cur = conn.execute(
                """UPDATE podcast_episodes
                   SET position_s = 0, played_at = ?
                   WHERE user_id = ? AND id = ?""",
                (int(_time.time()), user_id, episode_id),
            )
        elif duration_s is not None:
            cur = conn.execute(
                """UPDATE podcast_episodes
                   SET position_s = ?, duration_s = CASE WHEN duration_s = 0 THEN ? ELSE duration_s END
                   WHERE user_id = ? AND id = ?""",
                (float(position_s), int(duration_s), user_id, episode_id),
            )
        else:
            cur = conn.execute(
                """UPDATE podcast_episodes SET position_s = ?
                   WHERE user_id = ? AND id = ?""",
                (float(position_s), user_id, episode_id),
            )
        return cur.rowcount > 0


def replace_podcast_episodes(user_id: int, podcast_id: str, episodes: list[dict]):
    """Refresh the episode list, preserving per-episode listen state
    (position_s + played_at) across the wipe. Episodes that vanished
    from the feed drop their state too — which is fine, they're gone.
    """
    with get_db() as conn:
        prior = conn.execute(
            """SELECT id, position_s, played_at, local_file FROM podcast_episodes
               WHERE user_id = ? AND podcast_id = ?""",
            (user_id, podcast_id),
        ).fetchall()
        state_by_id = {
            r["id"]: (r["position_s"], r["played_at"], r["local_file"] or "")
            for r in prior
        }
        conn.execute(
            "DELETE FROM podcast_episodes WHERE user_id = ? AND podcast_id = ?",
            (user_id, podcast_id),
        )
        for ep in episodes:
            pos, played, local = state_by_id.get(ep["id"], (0.0, 0, ""))
            conn.execute(
                """INSERT INTO podcast_episodes
                   (id, user_id, podcast_id, guid, title, description,
                    audio_url, pub_date, duration_s, artwork,
                    position_s, played_at, local_file)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    ep["id"], user_id, podcast_id,
                    ep.get("guid", ""),
                    ep.get("title", ""),
                    ep.get("description", ""),
                    ep.get("audio_url", ""),
                    int(ep.get("pub_date", 0)),
                    int(ep.get("duration_s", 0)),
                    ep.get("artwork", ""),
                    float(pos), int(played), local,
                ),
            )
