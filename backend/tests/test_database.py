"""Tests for backend/database.py — schema bootstrap + addon-settings
encryption + cache and playlist round-trips."""

import json

import pytest

import database


# ── Encryption primitives ────────────────────────────────────────


def test_encrypt_decrypt_roundtrip():
    plaintext = {"rd_api_key": "abc-123", "nested": {"x": 1}}
    blob = database._encrypt_settings(plaintext)
    assert blob != json.dumps(plaintext)  # not stored in plaintext
    assert database._is_fernet_blob(blob)
    assert database._decrypt_settings(blob) == plaintext


def test_decrypt_falls_back_to_legacy_plaintext():
    """Rows written before encryption was rolled out parse as JSON."""
    legacy = json.dumps({"k": "v"})
    assert database._decrypt_settings(legacy) == {"k": "v"}


def test_decrypt_garbage_returns_empty_dict():
    """Defensive: corrupted blob doesn't propagate an exception."""
    assert database._decrypt_settings("not-fernet-not-json") == {}


def test_decrypt_empty_returns_empty_dict():
    assert database._decrypt_settings("") == {}
    assert database._decrypt_settings(None) == {}


def test_is_fernet_blob_discriminates():
    assert database._is_fernet_blob("gAAAAAfoo") is True
    assert database._is_fernet_blob('{"plain": "json"}') is False
    assert database._is_fernet_blob("") is False
    assert database._is_fernet_blob(None) is False


def test_encrypt_handles_empty_dict():
    blob = database._encrypt_settings({})
    assert database._decrypt_settings(blob) == {}


# ── Schema bootstrap ─────────────────────────────────────────────


def test_init_db_creates_owner_row(tmp_db):
    """init_db must seed the synthetic single-user owner."""
    with database.get_db() as conn:
        row = conn.execute(
            "SELECT id, email, is_admin FROM users WHERE id = ?",
            (database.SINGLE_USER_ID,),
        ).fetchone()
    assert row is not None
    assert row["email"] == database.SINGLE_USER_EMAIL
    assert row["is_admin"] == 1


def test_init_db_is_idempotent(tmp_db):
    """Re-running init_db on an existing DB is safe."""
    database.init_db()
    database.init_db()
    with database.get_db() as conn:
        n = conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"]
    assert n == 1


def test_get_db_enables_foreign_keys(tmp_db):
    with database.get_db() as conn:
        fk = conn.execute("PRAGMA foreign_keys").fetchone()[0]
    assert fk == 1


# ── Addon settings round-trip ────────────────────────────────────


def test_save_and_get_addon_settings(tmp_db):
    uid = database.SINGLE_USER_ID
    database.save_addon_settings(uid, "audimo-indexers", {"rd_api_key": "abc"})
    assert database.get_addon_settings(uid, "audimo-indexers") == {"rd_api_key": "abc"}


def test_get_addon_settings_missing_returns_empty(tmp_db):
    assert database.get_addon_settings(database.SINGLE_USER_ID, "nope") == {}


def test_addon_settings_stored_encrypted_at_rest(tmp_db):
    """The on-disk blob must not contain the plaintext key."""
    uid = database.SINGLE_USER_ID
    database.save_addon_settings(uid, "audimo-indexers", {"rd_api_key": "REVEALED"})
    with database.get_db() as conn:
        raw = conn.execute(
            "SELECT data FROM addon_settings WHERE user_id = ? AND addon_id = ?",
            (uid, "audimo-indexers"),
        ).fetchone()["data"]
    assert "REVEALED" not in raw
    assert database._is_fernet_blob(raw)


def test_save_addon_settings_overwrites(tmp_db):
    uid = database.SINGLE_USER_ID
    database.save_addon_settings(uid, "audimo-indexers", {"k": "v1"})
    database.save_addon_settings(uid, "audimo-indexers", {"k": "v2"})
    assert database.get_addon_settings(uid, "audimo-indexers") == {"k": "v2"}


def test_legacy_plaintext_addon_settings_migrated_on_init(tmp_db):
    """A row written as plaintext before encryption rollout should be
    transparently re-encrypted by _migrate_plaintext_addon_settings."""
    uid = database.SINGLE_USER_ID
    legacy_json = json.dumps({"legacy": "data"})
    with database.get_db() as conn:
        conn.execute(
            "INSERT INTO addon_settings (user_id, addon_id, data) VALUES (?, ?, ?)",
            (uid, "old-addon", legacy_json),
        )
    database._migrate_plaintext_addon_settings()
    with database.get_db() as conn:
        raw = conn.execute(
            "SELECT data FROM addon_settings WHERE addon_id = ?", ("old-addon",),
        ).fetchone()["data"]
    assert database._is_fernet_blob(raw)
    assert database.get_addon_settings(uid, "old-addon") == {"legacy": "data"}


# ── Cache entries ────────────────────────────────────────────────


def test_cache_entry_save_load_delete(tmp_db):
    uid = database.SINGLE_USER_ID
    entry = {"addon_id": "audimo-aio", "stream_url": "http://x/y", "mime": "audio/mpeg"}
    database.save_cache_entry(uid, "track:abc", entry)

    loaded = database.load_user_cache(uid)
    assert loaded["track:abc"] == entry

    database.delete_cache_entry(uid, "track:abc")
    assert database.load_user_cache(uid) == {}


def test_count_cache_entries_by_addon(tmp_db):
    uid = database.SINGLE_USER_ID
    database.save_cache_entry(uid, "k1", {"addon_id": "audimo-aio"})
    database.save_cache_entry(uid, "k2", {"addon_id": "audimo-aio"})
    database.save_cache_entry(uid, "k3", {"addon_id": "audimo-indexers"})
    assert database.count_cache_entries_by_addon_id(uid, "audimo-aio") == 2
    assert database.count_cache_entries_by_addon_id(uid, "audimo-indexers") == 1
    assert database.count_cache_entries_by_addon_id(uid, "missing") == 0


def test_delete_cache_entries_by_addon_returns_keys(tmp_db):
    uid = database.SINGLE_USER_ID
    database.save_cache_entry(uid, "k1", {"addon_id": "audimo-aio"})
    database.save_cache_entry(uid, "k2", {"addon_id": "audimo-aio"})
    database.save_cache_entry(uid, "k3", {"addon_id": "audimo-indexers"})
    removed = database.delete_cache_entries_by_addon_id(uid, "audimo-aio")
    assert sorted(removed) == ["k1", "k2"]
    assert "k3" in database.load_user_cache(uid)


# ── Playlists ─────────────────────────────────────────────────────


def test_playlist_create_rename_delete(tmp_db):
    uid = database.SINGLE_USER_ID
    database.create_playlist(uid, "p1", "First")
    assert database.get_playlists(uid)[0]["name"] == "First"

    database.rename_playlist(uid, "p1", "Renamed")
    assert database.get_playlists(uid)[0]["name"] == "Renamed"

    database.delete_playlist(uid, "p1")
    assert database.get_playlists(uid) == []


def test_playlist_track_add_remove(tmp_db):
    uid = database.SINGLE_USER_ID
    database.create_playlist(uid, "p1", "P1")
    track = {"key": "t1", "title": "Song", "artist": "Artist"}
    database.add_track_to_playlist("p1", track, position=0)
    pls = database.get_playlists(uid)
    assert len(pls[0]["tracks"]) == 1
    assert pls[0]["tracks"][0]["title"] == "Song"

    database.remove_track_from_playlist("p1", "t1")
    assert database.get_playlists(uid)[0]["tracks"] == []


# ── Settings allowlist ──────────────────────────────────────────


def test_update_user_settings_ignores_unknown_keys(tmp_db):
    """Hard-coded SET clause: unknown keys never reach the SQL."""
    uid = database.SINGLE_USER_ID
    # Should silently drop the bogus column rather than raise.
    database.update_user_settings(uid, {"listenbrainz_token": "tok-1", "evil_col": "DROP TABLE"})
    settings = database.get_user_settings(uid)
    assert settings["listenbrainz_token"] == "tok-1"
    assert "evil_col" not in settings
