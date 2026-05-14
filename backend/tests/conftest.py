"""Test fixtures.

Reroutes the DB and the API-key file to per-test temp locations so
tests don't touch ~/.audimo/. Run with:

    cd backend && pip install -r requirements-dev.txt && pytest
"""

import pytest


@pytest.fixture
def tmp_db(tmp_path, monkeypatch):
    """Point the database module at a fresh sqlite file and initialise it."""
    import database

    db_path = tmp_path / "audimo.db"
    monkeypatch.setattr(database, "DB_PATH", db_path)
    database.init_db()
    yield db_path


@pytest.fixture
def tmp_key_file(tmp_path, monkeypatch):
    """Point auth._KEY_FILE at a temp file and reset the in-memory cache."""
    import auth

    key_file = tmp_path / "api_key"
    monkeypatch.setattr(auth, "_KEY_FILE", key_file)
    monkeypatch.setattr(
        auth, "_KEY_CACHE", {"value": None, "mtime": 0.0, "checked_at": 0.0}
    )
    monkeypatch.delenv("AUDIMO_API_KEY", raising=False)
    yield key_file
