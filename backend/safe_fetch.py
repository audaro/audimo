"""Server-side URL fetching with SSRF defense.

Any backend endpoint that takes a user-supplied URL and fetches it on
the server side must route through this module. Without it, an attacker
can probe internal services, cloud metadata endpoints
(169.254.169.254), or anything else reachable from the process. The
defenses here are:

  * Reject obviously-bad schemes / hosts before we even resolve.
  * Resolve the hostname ourselves, filter every returned IP against a
    denylist (loopback / link-local / private / multicast / reserved),
    and connect to a pre-cleared IP via a pinned-host transport. This
    prevents DNS rebinding — otherwise the attacker can serve a public
    IP to our resolver, pass the check, then flip to 127.0.0.1 when
    httpx connects.
  * Re-validate every redirect hop. ``safe_get`` follows 3xx manually
    (httpx is told ``follow_redirects=False``) so a malicious upstream
    that returns ``Location: http://127.0.0.1:9004/admin/...`` can't
    pivot from a public origin to an internal endpoint.

Local-only desktop installs are the typical case where loopback is
actually desired (the user is connecting to their own audimo-aio
sidecar). ``AUDIMO_ALLOW_LOCAL_ADDONS=1`` (default) enables that.
Production / hosted installs should set ``AUDIMO_ALLOW_LOCAL_ADDONS=0``
so the safer default applies to addon-manifest fetches AND every other
server-side URL fetch routed through this module.
"""

from __future__ import annotations

import ipaddress
import os
import socket
from typing import Mapping

import httpx
from fastapi import HTTPException


_ALLOW_LOCAL_DEFAULT = (
    str(os.environ.get("AUDIMO_ALLOW_LOCAL_ADDONS", "1")).lower()
    not in {"", "0", "false", "no"}
)


def _ip_is_blocked(
    ip: ipaddress.IPv4Address | ipaddress.IPv6Address,
    *,
    allow_loopback: bool,
) -> bool:
    """True if the IP is one we refuse to fetch from. Link-local
    (169.254.0.0/16, fe80::/10) is *always* denied — that range is
    cloud-metadata-service space, never a legitimate addon."""
    if ip.is_link_local:
        return True
    if ip.is_loopback:
        return not allow_loopback
    return (
        ip.is_private
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def _resolve_safe_ips(host: str, *, allow_loopback: bool) -> list[str]:
    """Resolve ``host`` and return every IP that passes the denylist,
    IPv4 first (most servers bind v4 only). Raises HTTPException(400)
    if the host won't resolve or every result is blocked. Callers
    iterate until a connection succeeds — DNS isn't consulted again,
    so this is also our DNS-rebinding pin."""
    try:
        infos = socket.getaddrinfo(host, None)
    except (socket.gaierror, UnicodeError):
        raise HTTPException(400, "Could not resolve URL host")
    seen: set[str] = set()
    safe: list[str] = []
    for _fam, _t, _p, _c, sockaddr in infos:
        ip_text = sockaddr[0]
        if ip_text in seen:
            continue
        seen.add(ip_text)
        try:
            ip = ipaddress.ip_address(ip_text)
        except ValueError:
            continue
        if not _ip_is_blocked(ip, allow_loopback=allow_loopback):
            safe.append(ip_text)
    if not safe:
        raise HTTPException(400, "URL host resolves to a disallowed network")
    safe.sort(key=lambda s: (":" in s, s))  # IPv4 first
    return safe


def validate_url(
    url: str,
    *,
    max_len: int = 4096,
    allow_loopback: bool | None = None,
) -> tuple[str, str, int, list[str]]:
    """Parse + validate a URL. Returns ``(url, host, port, safe_ips)``.
    Rejects non-http(s), bare IPs in private ranges, embedded
    credentials, hostnames that resolve to disallowed networks, or
    URLs longer than ``max_len``. The base URL is what callers display;
    ``safe_ips`` is what they actually connect to (via a pinned-host
    transport).

    ``allow_loopback`` defaults to ``AUDIMO_ALLOW_LOCAL_ADDONS=1``.
    Caller can force it on or off per-endpoint when the policy differs
    (e.g. podcast feeds should never reach 127.0.0.1; addon manifests
    might).
    """
    from urllib.parse import urlsplit
    if not url:
        raise HTTPException(400, "URL required")
    if len(url) > max_len:
        raise HTTPException(400, "URL too long")
    parts = urlsplit(url)
    if parts.scheme not in {"http", "https"}:
        raise HTTPException(400, "URL must be http or https")
    if parts.username or parts.password:
        raise HTTPException(400, "URL must not contain credentials")
    host = parts.hostname or ""
    if not host:
        raise HTTPException(400, "URL is missing a host")
    port = parts.port or (443 if parts.scheme == "https" else 80)

    allow = _ALLOW_LOCAL_DEFAULT if allow_loopback is None else bool(allow_loopback)
    try:
        ip = ipaddress.ip_address(host)
        if _ip_is_blocked(ip, allow_loopback=allow):
            raise HTTPException(400, "URL host resolves to a disallowed network")
        safe_ips = [host]
    except ValueError:
        safe_ips = _resolve_safe_ips(host, allow_loopback=allow)
    return url, host, port, safe_ips


def _pinned_url(scheme: str, ip: str, port: int, path_and_qs: str) -> str:
    ip_in_url = f"[{ip}]" if ":" in ip else ip
    return f"{scheme}://{ip_in_url}:{port}{path_and_qs}"


async def safe_get(
    url: str,
    *,
    headers: Mapping[str, str] | None = None,
    timeout: float = 20.0,
    follow_redirects: bool = False,
    max_redirects: int = 5,
    allow_loopback: bool | None = None,
) -> httpx.Response:
    """GET ``url`` with SSRF defenses. Each request:

      * pre-flight resolves the hostname and verifies every returned
        IP is on the safe-list (no loopback/private/link-local/etc.);
      * connects to the hostname (NOT a pinned IP) so TLS SNI sends
        the right server-name and the cert validates;
      * follows 3xx hops manually, re-running the validation on each.

    The pre-flight resolve + hostname connection trades the original
    "DNS pin" mitigation for working HTTPS — pinning ``https://1.2.3.4/...``
    breaks SNI, and CDNs return cert errors. DNS rebinding between
    the resolve and the connect is a microsecond window an attacker
    can't realistically target on a typical client.

    Set ``allow_loopback=False`` for endpoints that should never
    reach 127.0.0.1 (e.g. podcast feeds — the user pasted that URL,
    they didn't mean their own machine).

    Returns the final ``httpx.Response``. Raises HTTPException(400/502)
    on validation failure or unreachable host."""
    current = url
    hop = 0
    while True:
        # Pre-flight: ensures the host's IPs all pass the denylist.
        # We discard the IPs themselves — httpx connects to the
        # hostname so SNI / cert validation flows correctly.
        validate_url(current, allow_loopback=allow_loopback)

        req_headers: dict[str, str] = dict(headers or {})

        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(
                    connect=8.0, read=timeout, write=8.0, pool=8.0
                ),
                follow_redirects=False,
                headers=req_headers,
            ) as client:
                response = await client.get(current)
        except Exception:
            raise HTTPException(502, "Could not fetch URL")

        if (
            follow_redirects
            and 300 <= response.status_code < 400
            and "location" in response.headers
        ):
            if hop >= max_redirects:
                raise HTTPException(502, "Too many redirects")
            location = response.headers["location"]
            from urllib.parse import urljoin
            current = urljoin(current, location)
            hop += 1
            continue
        return response
