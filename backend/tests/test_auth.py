"""Tests for backend/auth.py — single-user API-key gate."""

import time

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

import auth


def _make_app(client_host: str | None):
    """Build a FastAPI test app with one auth-gated endpoint. The
    middleware overrides `request.client.host` so we can simulate
    on-box vs off-box callers — TestClient's default 'testclient'
    host doesn't match either."""
    a = FastAPI()

    if client_host is not None:
        @a.middleware("http")
        async def spoof_host(request, call_next):
            request.scope["client"] = (client_host, 12345)
            return await call_next(request)

    @a.get("/whoami")
    async def whoami(user: dict = Depends(auth.get_current_user)):
        return user

    return a


@pytest.fixture
def local_app():
    return _make_app("127.0.0.1")


@pytest.fixture
def remote_app():
    return _make_app("10.0.0.1")


# ── No-key error path ────────────────────────────────────────────
#
# The previous keyless-local-only mode was removed in Phase 1: every
# install has a key minted by the desktop shell on first boot, so a
# request reaching the backend with NO key configured indicates a
# broken install. Both local and remote callers get 503 with a clear
# diagnostic.


def test_keyless_local_request_503(tmp_key_file, local_app):
    """No key configured → 503 with a hint about restarting the shell."""
    client = TestClient(local_app)
    r = client.get("/whoami")
    assert r.status_code == 503
    assert "API key" in r.json()["detail"]


def test_keyless_remote_request_503(tmp_key_file, remote_app):
    """Same 503 reaches off-box callers — the missing-key signal is
    the same regardless of where the request came from."""
    client = TestClient(remote_app)
    r = client.get("/whoami")
    assert r.status_code == 503


# ── Remote mode (key configured) ────────────────────────────────


def test_key_from_file_accepts_x_api_key_header(tmp_key_file, remote_app):
    tmp_key_file.write_text("s3cret-key\n")
    client = TestClient(remote_app)
    assert client.get("/whoami", headers={"X-API-Key": "s3cret-key"}).status_code == 200


def test_key_from_file_accepts_bearer(tmp_key_file, remote_app):
    tmp_key_file.write_text("s3cret-key")
    client = TestClient(remote_app)
    r = client.get("/whoami", headers={"Authorization": "Bearer s3cret-key"})
    assert r.status_code == 200


def test_key_mismatch_rejected(tmp_key_file, remote_app):
    tmp_key_file.write_text("real-key")
    client = TestClient(remote_app)
    assert client.get("/whoami", headers={"X-API-Key": "wrong-key"}).status_code == 401


def test_missing_credentials_rejected(tmp_key_file, remote_app):
    tmp_key_file.write_text("real-key")
    client = TestClient(remote_app)
    assert client.get("/whoami").status_code == 401


def test_file_key_takes_precedence_over_env(tmp_key_file, remote_app, monkeypatch):
    """Hot-rotation: file value wins over the spawn-time env var."""
    tmp_key_file.write_text("from-file")
    monkeypatch.setenv("AUDIMO_API_KEY", "from-env")
    client = TestClient(remote_app)
    assert client.get("/whoami", headers={"X-API-Key": "from-file"}).status_code == 200
    assert client.get("/whoami", headers={"X-API-Key": "from-env"}).status_code == 401


def test_env_key_used_when_no_file(tmp_key_file, remote_app, monkeypatch):
    """No file → env var is the source of truth."""
    monkeypatch.setenv("AUDIMO_API_KEY", "env-only")
    client = TestClient(remote_app)
    assert client.get("/whoami", headers={"X-API-Key": "env-only"}).status_code == 200


def test_key_rotation_picks_up_file_change(tmp_key_file, remote_app):
    """File-based key cache invalidates on mtime change so rotation
    works without a backend restart."""
    tmp_key_file.write_text("v1")
    client = TestClient(remote_app)
    assert client.get("/whoami", headers={"X-API-Key": "v1"}).status_code == 200

    # mtime needs a measurable bump on coarse-grained filesystems
    time.sleep(0.01)
    tmp_key_file.write_text("v2")
    auth._KEY_CACHE["checked_at"] = 0.0  # bypass the 2s read cache

    assert client.get("/whoami", headers={"X-API-Key": "v1"}).status_code == 401
    assert client.get("/whoami", headers={"X-API-Key": "v2"}).status_code == 200


def test_key_with_surrounding_whitespace_is_trimmed(tmp_key_file, remote_app):
    """Header values are stripped — `\\n` from `cat key | curl -H` works."""
    tmp_key_file.write_text("  padded-key  \n")
    client = TestClient(remote_app)
    r = client.get("/whoami", headers={"X-API-Key": "padded-key"})
    assert r.status_code == 200


# ── is_local_request helper ──────────────────────────────────────


@pytest.mark.parametrize("host,expected", [
    ("127.0.0.1", True),
    ("::1", True),
    ("localhost", True),
    ("10.0.0.1", False),
    ("192.168.1.1", False),
    ("", False),
])
def test_is_local_request_classification(host, expected):
    class _R:
        client = type("C", (), {"host": host})()
    assert auth.is_local_request(_R()) is expected


def test_is_local_request_handles_no_client():
    """Some ASGI scopes set request.client to None (test harnesses)."""
    class _R:
        client = None
    assert auth.is_local_request(_R()) is False
