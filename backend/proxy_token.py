"""HMAC-signed tokens for /api/audio/proxy.

The audio proxy can't carry an Authorization header — HTML5 ``<audio
src>`` only does query strings. Instead each proxied URL is signed by
backend at mint time and verified at fetch time, so the proxy refuses
to fetch URLs the user didn't legitimately acquire through an
authenticated flow (addon callback, audiobook download, etc.).

Token format embedded as query params:
    ?url=<upstream>&exp=<unix_ts>&t=<hmac_b64url>

``t`` is the first 16 bytes of HMAC-SHA256(secret, url + "\\n" + exp)
base64url-encoded with no padding (22 chars). 128 bits is plenty —
collisions and brute force are both infeasible at that width.

The signing secret is derived from the install's Fernet key
(``AUDIMO_SECRET_KEY``) so it inherits the same keychain protection
without adding a second key to manage.

Token lifetime defaults to 24h. The addon callback that produced the
URL can refresh by hitting promote_stream_url again, which mints a
fresh token — short-lived enough that a leaked proxy URL stops
working within a day, long enough that the user doesn't notice their
library "expiring" between sessions."""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import time

_DEFAULT_TTL_S = 24 * 3600


def _signing_secret() -> bytes:
    """Derive the audio-proxy HMAC secret from the install's Fernet
    key. SHA256 with a fixed label so the secret can't be reused for
    other HMAC purposes if we ever add more."""
    base = (
        os.environ.get("AUDIMO_SECRET_KEY")
        or os.environ.get("TUNNEL_SECRET_KEY")
        or ""
    ).strip()
    if not base:
        # The Fernet key load path will have already raised if no key
        # exists; reaching here means a key was loaded but our process
        # doesn't have it in env any more. Fall back to a process-
        # ephemeral random secret so the proxy still works for the
        # current session.
        return _ephemeral_secret()
    return hashlib.sha256(b"audimo-audio-proxy\n" + base.encode()).digest()


_EPHEMERAL: bytes | None = None


def _ephemeral_secret() -> bytes:
    global _EPHEMERAL
    if _EPHEMERAL is None:
        _EPHEMERAL = os.urandom(32)
    return _EPHEMERAL


def _b64url_nopad(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def mint(url: str, ttl_s: int = _DEFAULT_TTL_S) -> tuple[str, int]:
    """Return ``(token, exp_unix_ts)`` for ``url``."""
    if not url:
        raise ValueError("url required")
    exp = int(time.time()) + max(60, int(ttl_s))
    msg = f"{url}\n{exp}".encode("utf-8")
    sig = hmac.new(_signing_secret(), msg, hashlib.sha256).digest()[:16]
    return _b64url_nopad(sig), exp


def verify(url: str, exp: int | str, token: str) -> bool:
    """True iff ``token`` is a valid HMAC for ``url`` + ``exp`` and the
    exp timestamp hasn't passed. Constant-time signature compare."""
    if not url or not token:
        return False
    try:
        exp_int = int(exp)
    except (TypeError, ValueError):
        return False
    if exp_int < int(time.time()):
        return False
    msg = f"{url}\n{exp_int}".encode("utf-8")
    expected = hmac.new(_signing_secret(), msg, hashlib.sha256).digest()[:16]
    expected_b64 = _b64url_nopad(expected)
    return hmac.compare_digest(expected_b64, token)


def proxy_url_for(upstream: str, ttl_s: int = _DEFAULT_TTL_S) -> str:
    """Build the full ``/api/audio/proxy?...`` URL the frontend's
    ``<audio src>`` consumes. Embeds upstream as a percent-encoded
    query param along with the HMAC token + expiry."""
    from urllib.parse import quote
    token, exp = mint(upstream, ttl_s=ttl_s)
    return (
        "/api/audio/proxy"
        f"?url={quote(upstream, safe='')}"
        f"&exp={exp}"
        f"&t={token}"
    )
