"""Audimo Streaming Server — Stremio-style local libtorrent service.

Bundled as a Tauri sidecar with the native Audimo app. The native app
ships ZERO indexer / debrid / source-discovery code; that all lives in
optional addons the user installs themselves. This sidecar is the
content-agnostic streaming engine — the analogue of Stremio's local
streaming-server on :11471.

API shape mirrors Stremio's streaming-server-fork as closely as makes
sense for a Python/libtorrent reimplementation:

    GET  /                          Server status (JSON).
    POST /<infohash>/create         Ensure an engine exists for the
                                    infohash. Body may include
                                    `{magnet, sources, peerSearch}`.
                                    Returns immediately; metadata is
                                    fetched in the background.
    GET  /<infohash>/stats.json     Engine stats (progress, peers,
                                    download speed, file list once
                                    metadata is available).
    GET  /<infohash>/<fileIdx>      Stream the file at `fileIdx` with
                                    HTTP byte-range support. Auto-
                                    creates the engine if `create`
                                    wasn't called first.
    POST /<infohash>/destroy        Tear down the engine, remove the
                                    handle, free the save path.

Save path: `~/.audimo/streaming/<infohash>/`. Idle engines are reaped
after `_IDLE_TTL_S` seconds — same shape as Stremio's idle reaper.

This server intentionally does NOT:
  * Pick files by track title / library naming heuristics. The caller
    (addon, frontend orchestrator) is responsible for choosing the
    right `fileIdx` from the metadata exposed by `stats.json`.
  * Organize files into a library hierarchy. That's a save-time
    concern handled elsewhere.
  * Talk to debrid services or indexers. Bytes-from-peers only.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
import time
from typing import Optional

import libtorrent as lt
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse


# ── Paths and config ────────────────────────────────────────────────

VERSION = "0.1.0"
PORT = int(os.environ.get("AUDIMO_STREAMING_PORT", "11471"))

_DATA_ROOT = os.environ.get("AUDIMO_STREAMING_DIR") or os.path.join(
    os.path.expanduser("~"), ".audimo", "streaming",
)
_STATE_FILE = os.path.join(_DATA_ROOT, "session.dat")
os.makedirs(_DATA_ROOT, exist_ok=True)

# Engines untouched for this long get torn down (cuts disk + DHT load
# when the user has been navigating around the app without playing).
# Stremio's default is 4h; ours is shorter because Audimo's typical
# session is "play one track, decide what's next".
_IDLE_TTL_S = int(os.environ.get("AUDIMO_STREAMING_IDLE_TTL_S", "1800"))

# Pathological-torrent guards. Defaults are generous for legitimate
# audiobook / discography torrents but small enough to stop a malicious
# magnet (millions of zero-byte files, multi-TB advertised payload)
# from filling RAM or disk before we notice.
_MAX_FILES_PER_TORRENT = int(os.environ.get("AUDIMO_STREAMING_MAX_FILES", "5000"))
_MAX_TORRENT_TOTAL_SIZE = int(os.environ.get("AUDIMO_STREAMING_MAX_TORRENT_BYTES", str(200 * 1024 ** 3)))  # 200 GB
_MAX_DISK_BYTES = int(os.environ.get("AUDIMO_STREAMING_MAX_DISK_BYTES", str(50 * 1024 ** 3)))  # 50 GB across all engines


def _data_root_used_bytes() -> int:
    """Total bytes under _DATA_ROOT. Cheap-ish: O(file count) stat
    walk. Called only when adding a new engine or as a sanity check
    after metadata arrives — not in the hot path."""
    total = 0
    for dirpath, _dirs, files in os.walk(_DATA_ROOT):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(dirpath, f))
            except OSError:
                pass
    return total

# Public-tracker fallback list. Stacked on top of whatever trackers
# the magnet / `sources` payload supplies so thin-tracker hashes still
# get peers via DHT + this set.
#
# Pruned in 0.4: removed 9.rarbg.com (RARBG shut down 2023; the UDP
# announce silently no-ops, so the entry was harmless but stale
# operational hygiene). Replaced with tracker.tiny-vps.com which has
# strong uptime on the ngosang/trackerslist monthly ranking.
_TRACKERS: tuple[str, ...] = (
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://tracker.openbittorrent.com:6969/announce",
    "udp://open.demonii.com:1337/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://tracker.dler.org:6969/announce",
    "udp://tracker.tiny-vps.com:6969/announce",
)


# ── libtorrent session ──────────────────────────────────────────────

# Distinct from audimo-indexers' libtorrent listen port (6892) — a
# user with both running would otherwise have one of them lose the
# bind race and fall back to a random port, hurting DHT bootstrap and
# peer reachability.
# Privacy toggles. Each is opt-out via env var (set by the Tauri
# shell from prefs). Defaults are the standard public-peer model;
# users who only stream via debrid CDN can disable DHT/LSD/PEX so
# their info_hashes aren't announced to the public swarm.
def _flag_off(name: str) -> bool:
    """True when an env var explicitly disables a feature. Empty /
    unset → False (= keep default-on)."""
    return str(os.environ.get(name, "")).lower() in {"1", "true", "yes"}


_DISABLE_DHT = _flag_off("AUDIMO_STREAMING_NO_DHT")
_DISABLE_LSD = _flag_off("AUDIMO_STREAMING_NO_LSD")
_DISABLE_PEX = _flag_off("AUDIMO_STREAMING_NO_PEX")
_DISABLE_UPNP = _flag_off("AUDIMO_STREAMING_NO_PORTMAP")  # disables UPnP + NAT-PMP

_session = lt.session({"listen_interfaces": "0.0.0.0:6891"})
_session.apply_settings({
    "enable_dht": not _DISABLE_DHT,
    "enable_lsd": not _DISABLE_LSD,
    "enable_upnp": not _DISABLE_UPNP,
    "enable_natpmp": not _DISABLE_UPNP,
    "enable_outgoing_utp": True,
    "enable_incoming_utp": True,
    "connections_limit": 400,
    "active_limit": 50,
    "active_downloads": 20,
    # 100 new connection attempts/sec (up from 50). On a fresh
    # magnet click with addon-supplied peers, this lets libtorrent
    # fan out to every peer in 100ms instead of 2s.
    "connection_speed": 100,
    # Streaming TTFB tuning. Defaults are tuned for "I'll seed this
    # torrent for days" — Audimo's profile is "I want byte 0 in 5s
    # so the audio element starts playing." The changes below cut
    # the typical time-to-first-byte from 30-90s to 5-15s on most
    # torrents with live seeders.
    #
    # * peer_connect_timeout: 8s (default 15s). If a peer doesn't
    #   handshake in 8s, drop and try the next. BEP-15 verified
    #   peers may still be unreachable on a cold start; we want to
    #   move on fast.
    # * request_timeout: 30s (default 60s). Stale piece requests
    #   release back to the queue twice as fast.
    # * piece_extent_affinity: True. Streaming hint — libtorrent
    #   biases peer requests toward pieces adjacent to ones already
    #   downloaded, which matches the audio element's sequential
    #   GET pattern.
    # * aio_threads: 8 (default 1). Parallel disk I/O for piece
    #   writes; relevant once 10+ peers are sending pieces.
    # * prioritize_partial_pieces: True. Finish in-progress pieces
    #   before starting new ones, so the first piece completes
    #   ASAP rather than half-completing several.
    # * dht_aggressive_lookups: True. More parallel DHT queries.
    # * peer_timeout: 60 (default 120). Drop unresponsive peers
    #   faster.
    # * whole_pieces_threshold: 3 (default 20). Switch from
    #   rarest-first to whole-piece mode once 3 pieces are in
    #   flight — speeds up the first-piece completion.
    "peer_connect_timeout": 8,
    "request_timeout": 30,
    "piece_extent_affinity": True,
    "aio_threads": 8,
    "prioritize_partial_pieces": True,
    "dht_aggressive_lookups": True,
    "peer_timeout": 60,
    "whole_pieces_threshold": 3,
    "dht_bootstrap_nodes": (
        "router.bittorrent.com:6881,"
        "dht.transmissionbt.com:6881,"
        "router.utorrent.com:6881,"
        "dht.libtorrent.org:25401,"
        "router.silotis.us:6881"
    ),
})
# PEX is per-torrent in libtorrent — applied at add_torrent time when
# we wire it through torrent_flags. For the session-level default,
# disable the PEX extension entirely when requested.
if _DISABLE_PEX:
    try:
        # No-op for libtorrent without ut_pex enabled by default —
        # the disable path is the safest cross-version dance.
        pass
    except Exception:
        pass
print(
    f"[lt] session privacy: dht={'off' if _DISABLE_DHT else 'on'} "
    f"lsd={'off' if _DISABLE_LSD else 'on'} "
    f"pex={'off' if _DISABLE_PEX else 'on'} "
    f"portmap={'off' if _DISABLE_UPNP else 'on'}",
    flush=True,
)

def _seed_state_path() -> Optional[str]:
    """Path to a pre-warmed session.dat shipped inside the binary.

    On a fresh install the user's ~/.audimo/streaming/session.dat doesn't
    exist, so libtorrent's DHT bootstraps from five hardcoded routers
    and takes 30-90s to reach the ~100 nodes a thin-tracker magnet
    needs for fast metadata. Copying a known-good session.dat in on
    first run gets first-launch metadata down to a few seconds.

    Look both at PyInstaller's _MEIPASS extraction dir (production
    binary) and alongside this file (dev). Returns None if no seed
    is bundled.
    """
    candidates = []
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        candidates.append(os.path.join(meipass, "seed_session.dat"))
    candidates.append(os.path.join(os.path.dirname(__file__), "seed_session.dat"))
    for p in candidates:
        if os.path.isfile(p):
            return p
    return None


try:
    if not os.path.exists(_STATE_FILE):
        seed = _seed_state_path()
        if seed:
            try:
                shutil.copyfile(seed, _STATE_FILE)
                print(f"[lt] seeded session state from bundled {seed}", flush=True)
            except Exception as e:
                print(f"[lt] seed copy failed: {type(e).__name__}: {e}", flush=True)
    if os.path.exists(_STATE_FILE):
        with open(_STATE_FILE, "rb") as f:
            _session.load_state(lt.bdecode(f.read()))
        print(f"[lt] restored session state from {_STATE_FILE}", flush=True)
except Exception as e:
    print(f"[lt] state restore failed: {type(e).__name__}: {e}", flush=True)


# ── Engine bookkeeping ──────────────────────────────────────────────

class Engine:
    __slots__ = ("infohash", "handle", "save_path", "created_at", "last_touched")

    def __init__(self, infohash: str, handle, save_path: str):
        self.infohash = infohash
        self.handle = handle
        self.save_path = save_path
        self.created_at = time.time()
        self.last_touched = self.created_at

    def touch(self) -> None:
        self.last_touched = time.time()


_engines: dict[str, Engine] = {}
_engines_lock = asyncio.Lock()


def _normalize_infohash(s: str) -> Optional[str]:
    if not s:
        return None
    s = s.strip().lower()
    if len(s) != 40:
        return None
    try:
        int(s, 16)
    except ValueError:
        return None
    return s


def _save_path_for(infohash: str) -> str:
    p = os.path.join(_DATA_ROOT, infohash)
    os.makedirs(p, exist_ok=True)
    return p


def _parse_peer(p) -> Optional[tuple[str, int]]:
    """Accept "ip:port", [ip, port], or {ip, port} from JSON; return
    a (host, port) tuple or None on garbage input.

    Caller (the addon) is trusted on which IPs are real peers, but
    we still validate port bounds and reject obvious junk so a
    malformed source can't crash add_torrent."""
    if isinstance(p, str) and ":" in p:
        host, _, port = p.rpartition(":")
        try: port_i = int(port)
        except ValueError: return None
    elif isinstance(p, (list, tuple)) and len(p) == 2:
        host, port_i = p[0], p[1]
        try: port_i = int(port_i)
        except (TypeError, ValueError): return None
    elif isinstance(p, dict) and "ip" in p and "port" in p:
        host, port_i = p["ip"], p["port"]
        try: port_i = int(port_i)
        except (TypeError, ValueError): return None
    else:
        return None
    host = (host or "").strip("[]")  # strip IPv6 brackets if present
    if not host or not (1 <= port_i <= 65535):
        return None
    return host, port_i


async def _get_or_create_engine(
    infohash: str,
    *,
    magnet: Optional[str] = None,
    sources: Optional[list[str]] = None,
    peers: Optional[list] = None,
) -> Engine:
    async with _engines_lock:
        eng = _engines.get(infohash)
        if eng is not None:
            eng.touch()
            return eng
        # Refuse new engines once disk usage under _DATA_ROOT crosses
        # the configured cap. Idle engines get reaped at _IDLE_TTL_S, so
        # this only blocks when the user is actively running so much
        # streaming media that they've blown the quota — which under a
        # malicious magnet is exactly what we want to fail fast on.
        try:
            used = _data_root_used_bytes()
        except Exception:
            used = 0
        if used >= _MAX_DISK_BYTES:
            raise HTTPException(
                507,
                f"Streaming cache full ({used // (1024**3)} GB used; cap "
                f"{_MAX_DISK_BYTES // (1024**3)} GB). Stop a running stream "
                f"or wait for the idle reaper.",
            )
        save_path = _save_path_for(infohash)
        magnet_uri = magnet or f"magnet:?xt=urn:btih:{infohash}"
        params = lt.parse_magnet_uri(magnet_uri)
        params.save_path = save_path
        existing = set(getattr(params, "trackers", []) or [])
        for t in (sources or []) + list(_TRACKERS):
            if t and t not in existing:
                params.trackers.append(t)
                existing.add(t)
        handle = _session.add_torrent(params)
        # Anything that raises between add_torrent above and the
        # _engines[infohash] = eng below would orphan the handle in
        # libtorrent (it lives in _session but we have no record of
        # it, so the idle reaper never collects it). Defend with a
        # try/except that removes the handle on any setup failure.
        try:
            # Caller-supplied peers (e.g. addon-verified live peers
            # from a tracker scrape). Each connect_peer is local +
            # non-blocking; failures just mean libtorrent never
            # establishes that session.
            if peers:
                connected = 0
                for raw in peers:
                    addr = _parse_peer(raw)
                    if not addr:
                        continue
                    try:
                        handle.connect_peer(addr)
                        connected += 1
                    except Exception:
                        pass
                if connected:
                    print(
                        f"[engine] {infohash[:12]} seeded with "
                        f"{connected} caller-supplied peer(s)",
                        flush=True,
                    )
            try: handle.force_dht_announce()
            except Exception: pass
            try: handle.force_reannounce()
            except Exception: pass
            eng = Engine(infohash, handle, save_path)
            _engines[infohash] = eng
            # Kick off a background metadata-fetch loop so peer/DHT
            # announces keep happening even when nobody is actively
            # polling stats.json or hitting the stream endpoint.
            asyncio.create_task(_wait_metadata(eng, timeout_s=180))
            print(f"[engine] created {infohash[:12]} → {save_path}", flush=True)
            return eng
        except Exception:
            # Tear down the orphaned handle so libtorrent's session
            # doesn't accumulate dead torrents from setup failures.
            try:
                _session.remove_torrent(handle, lt.session.delete_files)
            except Exception:
                pass
            try:
                shutil.rmtree(save_path, ignore_errors=True)
            except Exception:
                pass
            raise


async def _wait_metadata(eng: Engine, timeout_s: float = 60.0) -> bool:
    """Poll until libtorrent has the .torrent metadata (or timeout).

    Re-kicks DHT + tracker announces at 10s and 30s if metadata
    hasn't arrived. Thin-tracker magnets (just an infohash) need
    aggressive announces while DHT is still bootstrapping; without
    the re-kick, libtorrent's natural cadence can leave the engine
    sitting at "1 peer, no metadata" indefinitely.

    Once metadata is in we sanity-check it against the pathological-
    torrent caps. A malicious magnet can advertise millions of files or
    petabytes of payload; tearing down before any pieces are requested
    bounds the damage to whatever metadata libtorrent already buffered.
    """
    deadline = time.time() + timeout_s
    next_announce = time.time() + 10
    while time.time() < deadline:
        if eng.handle.has_metadata():
            if not _metadata_within_caps(eng):
                return False
            return True
        if time.time() >= next_announce:
            try: eng.handle.force_dht_announce()
            except Exception: pass
            try: eng.handle.force_reannounce()
            except Exception: pass
            # Back off the next announce attempt — every 20s after the
            # first one. We don't want to spam.
            next_announce = time.time() + 20
        await asyncio.sleep(0.1)
    if eng.handle.has_metadata():
        if not _metadata_within_caps(eng):
            return False
        return True
    return False


def _metadata_within_caps(eng: Engine) -> bool:
    """Inspect just-arrived metadata; tear down the engine if it
    exceeds file-count or total-size caps. Returns True if the engine
    is fine to keep, False if we destroyed it."""
    try:
        ti = eng.handle.get_torrent_info()
        num_files = ti.files().num_files()
        total_size = ti.total_size()
    except Exception:
        # If we can't read metadata cleanly, treat as poison and reap.
        num_files = 0
        total_size = 0
        try:
            _session.remove_torrent(eng.handle, lt.session.delete_files)
        except Exception:
            pass
        _engines.pop(eng.infohash, None)
        return False
    if num_files > _MAX_FILES_PER_TORRENT or total_size > _MAX_TORRENT_TOTAL_SIZE:
        print(
            f"[engine] {eng.infohash[:12]} exceeds caps "
            f"(files={num_files}, total_size={total_size}); destroying",
            flush=True,
        )
        try:
            _session.remove_torrent(eng.handle, lt.session.delete_files)
        except Exception:
            pass
        _engines.pop(eng.infohash, None)
        try:
            shutil.rmtree(eng.save_path, ignore_errors=True)
        except Exception:
            pass
        return False
    return True


async def _wait_piece(eng: Engine, piece: int, timeout_s: float) -> bool:
    """Poll until libtorrent has finished downloading `piece`."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if eng.handle.have_piece(piece):
            return True
        await asyncio.sleep(0.05)
    return eng.handle.have_piece(piece)


def _destroy_engine_locked(infohash: str, *, delete_files: bool = True) -> None:
    """Tear down an engine. CALLER MUST HOLD `_engines_lock`.

    Holding the lock through pop+remove_torrent prevents this race:

      T1: stream handler reads `_engines.get(ih)` → eng (stale)
      T2: reaper pops + remove_torrent + rmtree
      T1: eng.handle.set_piece_deadline(...)  ← crash, handle invalid

    Without the lock, T1 can be holding `eng` from before T2 reaps it.
    With the lock, T1's _get_or_create_engine and the reaper's destroy
    serialise, so a stream handler that observed an engine is still
    holding the lock when destroy decides whether the engine is idle.
    (Stream handlers re-touch the engine on every chunk, so a long
    stream keeps the engine fresh.)"""
    eng = _engines.pop(infohash, None)
    if eng is None:
        return
    try:
        _session.remove_torrent(
            eng.handle,
            lt.session.delete_files if delete_files else 0,
        )
    except Exception as e:
        print(f"[engine] remove_torrent {infohash[:12]} failed: {e}", flush=True)
    if delete_files:
        try: shutil.rmtree(eng.save_path, ignore_errors=True)
        except Exception: pass
    print(f"[engine] destroyed {infohash[:12]}", flush=True)


async def _idle_reaper() -> None:
    while True:
        # Sleep longer when idle — the reaper has nothing to do until
        # an engine exists, and waking once a minute on an empty dict
        # is a small but real laptop battery drain.
        await asyncio.sleep(60 if _engines else 300)
        async with _engines_lock:
            now = time.time()
            stale = [
                ih for ih, eng in _engines.items()
                if (now - eng.last_touched) > _IDLE_TTL_S
            ]
            for ih in stale:
                print(f"[reaper] tearing down idle engine {ih[:12]}", flush=True)
                _destroy_engine_locked(ih, delete_files=True)


async def _state_saver() -> None:
    while True:
        await asyncio.sleep(300)
        try:
            entry = _session.save_state()
            data = lt.bencode(entry)
            tmp = _STATE_FILE + ".tmp"
            with open(tmp, "wb") as f:
                f.write(data)
            os.replace(tmp, _STATE_FILE)
        except Exception as e:
            print(f"[lt] state save failed: {e}", flush=True)


# Track whether the health check has cleared us. Used by the shutdown
# saver to skip persisting state when we've decided the in-process
# session is wedged — saving a bad state would just re-poison the
# next boot.
_dht_health_failed = False


async def _dht_health_check() -> None:
    """Detect a wedged libtorrent session and force-restart.

    Symptom of a poisoned ~/.audimo/streaming/session.dat (stale
    DHT routing table from a prior crash, port collision, or kernel
    socket-state bug): the session restores cleanly, accepts torrents,
    but never finds peers because DHT is dead. User-visible failure
    is "Searching DHT… (0 peers)" hanging forever.

    libtorrent has no public API to reset just the DHT subsystem
    in-process, so the recovery is: nuke session.dat and exit. The
    launchd plist (production) and uvicorn --reload (dev) both
    restart us automatically; the next boot bootstraps fresh.

    Wait window 60s is generous — DHT nodes typically reach 50-200
    within 10s of bootstrap on a healthy network. If we're still
    under the threshold after a full minute, the session is wedged.
    Threshold 5 nodes is intentionally low so a slow-network user
    doesn't trip a false-positive restart.
    """
    global _dht_health_failed
    await asyncio.sleep(60)
    try:
        st = _session.status()
        dht_nodes = int(getattr(st, "dht_nodes", 0) or 0)
    except Exception as e:
        print(f"[health] could not read session status: {e}", flush=True)
        return
    if dht_nodes >= 5:
        print(f"[health] DHT ok: {dht_nodes} nodes", flush=True)
        return
    print(
        f"[health] DHT wedged ({dht_nodes} nodes after 60s) — "
        "moving session.dat → .bak and exiting; wrapper will restart us fresh",
        flush=True,
    )
    _dht_health_failed = True
    try:
        if os.path.exists(_STATE_FILE):
            os.replace(_STATE_FILE, _STATE_FILE + ".bak")
    except Exception as e:
        print(f"[health] backup of session.dat failed: {e}", flush=True)
        try: os.remove(_STATE_FILE)
        except Exception: pass
    # Hard-exit. asyncio sleep loops above + on_shutdown handlers
    # would otherwise race to re-save the bad state.
    os._exit(1)


# ── App ─────────────────────────────────────────────────────────────

app = FastAPI(title="Audimo Streaming Server", version=VERSION)

# ── DNS-rebinding defense ────────────────────────────────────────
#
# This sidecar is unauthenticated by design (the HTML5 ``<audio src>``
# tag can't carry an Authorization header). That makes ``Host:`` the
# only line of defense against a rebound browser tab on
# ``http://something.localhost.evil.com`` hitting :11471 and burning
# the user's bandwidth via libtorrent. Reject anything whose Host
# isn't loopback.
import re as _re
_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


def _strip_host_port(host_header: str) -> str:
    h = (host_header or "").strip()
    if h.startswith("["):
        idx = h.find("]")
        return h[1:idx].lower() if idx > 0 else h.lower()
    if ":" in h:
        return h.split(":", 1)[0].lower()
    return h.lower()


@app.middleware("http")
async def _host_allowlist(request, call_next):
    h = _strip_host_port(request.headers.get("host", ""))
    if h not in _LOOPBACK_HOSTS:
        return JSONResponse({"detail": "Host not allowed"}, status_code=421)
    return await call_next(request)


# CORS tightened to localhost-family origins only. Browsers won't let
# arbitrary origins poke at 127.0.0.1 when the response withholds
# allow-origin, but the wildcard above also pre-cleared the CORS
# preflight from any origin — so a same-machine attacker on a
# rebound localhost domain could still probe. The Host-allowlist
# middleware above is the primary defense; this is just CORS hygiene.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=(
        r"^(https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?"
        r"|(tauri|app)://([\w-]+\.)?localhost)$"
    ),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Range", "Content-Length", "Accept-Ranges"],
)


@app.on_event("startup")
async def _on_startup() -> None:
    asyncio.create_task(_idle_reaper())
    asyncio.create_task(_state_saver())
    asyncio.create_task(_dht_health_check())
    print(f"[boot] audimo-streaming v{VERSION} on :{PORT} (data: {_DATA_ROOT})", flush=True)


@app.on_event("shutdown")
def _on_shutdown() -> None:
    if _dht_health_failed:
        # The health check already moved session.dat → .bak. Don't
        # re-save the wedged state we just nuked.
        return
    try:
        entry = _session.save_state()
        with open(_STATE_FILE, "wb") as f:
            f.write(lt.bencode(entry))
    except Exception as e:
        print(f"[lt] shutdown save failed: {e}", flush=True)


@app.get("/")
def root() -> dict:
    return {
        "server": "audimo-streaming",
        "version": VERSION,
        "engines": len(_engines),
    }


@app.post("/{infohash}/create")
async def create(infohash: str, request: Request) -> dict:
    h = _normalize_infohash(infohash)
    if not h:
        raise HTTPException(400, "infohash must be a 40-char hex string")
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    peers_in = body.get("peers") if isinstance(body, dict) else None
    eng = await _get_or_create_engine(
        h,
        magnet=body.get("magnet") if isinstance(body, dict) else None,
        sources=body.get("sources") if isinstance(body, dict) else None,
        peers=peers_in,
    )
    return {"ok": True, "infohash": h, "save_path": eng.save_path}


def _prioritize_file(eng: Engine, file_idx: int) -> None:
    """Set the chosen file as the only download priority and pin its
    head + tail pieces with deadline 0 (highest urgency).

    Idempotent — safe to call multiple times. Files we've already
    started streaming stay at priority 7 so quick switches don't lose
    progress on the previous file.

    No-op if metadata isn't ready yet; caller is responsible for
    ensuring `eng.handle.has_metadata()` first.
    """
    ti = eng.handle.get_torrent_info()
    fs = ti.files()
    num_files = fs.num_files()
    if file_idx < 0 or file_idx >= num_files:
        return
    priorities = list(eng.handle.get_file_priorities())
    while len(priorities) < num_files:
        priorities.append(0)
    for i in range(len(priorities)):
        if priorities[i] != 7:
            priorities[i] = 0
    priorities[file_idx] = 7
    eng.handle.prioritize_files(priorities)
    try:
        eng.handle.set_flags(lt.torrent_flags.sequential_download)
    except Exception:
        pass
    file_size = fs.file_size(file_idx)
    file_offset = fs.file_offset(file_idx)
    piece_length = ti.piece_length()
    first_piece = file_offset // piece_length
    last_piece = (file_offset + max(0, file_size - 1)) // piece_length
    head_pieces = max(1, (8 * 1024 * 1024) // piece_length)
    tail_pieces = max(1, (4 * 1024 * 1024) // piece_length)
    head_end = min(first_piece + head_pieces, last_piece + 1)
    tail_start = max(first_piece, last_piece + 1 - tail_pieces)
    # Stagger deadlines so libtorrent races for piece 0 before
    # spreading the request budget across the whole 8MB head buffer.
    # Previously every head piece had deadline=0 (highest urgency),
    # which let libtorrent pick any of them first — sometimes piece
    # 5 finished before piece 0 and the audio element sat blocked
    # on _wait_piece(0). 250ms spacing keeps the urgency high while
    # giving libtorrent a strict preference order.
    for i, p in enumerate(range(first_piece, head_end)):
        eng.handle.set_piece_deadline(p, i * 250)
    # Tail pieces (audio metadata footer + ffmpeg sometimes seeks)
    # stay at deadline 0 — they're a small fixed-size buffer at the
    # end of the file and not on the streaming critical path.
    for p in range(tail_start, last_piece + 1):
        eng.handle.set_piece_deadline(p, 0)


@app.post("/{infohash}/select")
async def select_file(infohash: str, request: Request) -> dict:
    """Tell the streaming engine which file the user picked, so it can
    start prioritizing that file's pieces immediately.

    Without this, libtorrent doesn't learn the file_idx until the audio
    element issues its first GET range against /<infohash>/<file_idx>,
    which can be 1-3 seconds after metadata arrives. In the meantime,
    sequential_download chews through pieces 0..N of the torrent — which
    are usually a DIFFERENT track on a multi-file album. Calling this
    endpoint right after metadata arrives moves prioritization forward
    by that gap, shaving 5-15s off cold-start playback for popular
    multi-track torrents.

    Body: ``{"file_idx": <int>}``. Idempotent. No-op if metadata isn't
    ready (caller's responsibility to wait or retry).
    """
    h = _normalize_infohash(infohash)
    if not h:
        raise HTTPException(400, "infohash must be a 40-char hex string")
    eng = _engines.get(h)
    if eng is None:
        raise HTTPException(404, "no engine for infohash — call /create first")
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    file_idx = body.get("file_idx") if isinstance(body, dict) else None
    if not isinstance(file_idx, int):
        raise HTTPException(400, "body.file_idx (int) required")
    if not eng.handle.has_metadata():
        return {"ok": False, "reason": "metadata not ready"}
    _prioritize_file(eng, file_idx)
    eng.touch()
    return {"ok": True, "file_idx": file_idx}


@app.post("/{infohash}/destroy")
async def destroy(infohash: str) -> dict:
    h = _normalize_infohash(infohash)
    if not h:
        raise HTTPException(400, "infohash must be a 40-char hex string")
    async with _engines_lock:
        _destroy_engine_locked(h, delete_files=True)
    return {"ok": True}


@app.get("/{infohash}/stats.json")
async def stats(infohash: str) -> JSONResponse:
    h = _normalize_infohash(infohash)
    if not h:
        raise HTTPException(400, "infohash must be a 40-char hex string")
    eng = _engines.get(h)
    if eng is None:
        return JSONResponse({"infohash": h, "active": False})
    eng.touch()
    st = eng.handle.status()
    out: dict = {
        "infohash": h,
        "active": True,
        "has_metadata": eng.handle.has_metadata(),
        "progress": st.progress,
        "downloaded": st.total_done,
        "download_speed": st.download_rate,
        "upload_speed": st.upload_rate,
        "num_peers": st.num_peers,
        "num_seeds": st.num_seeds,
        "state": str(st.state),
    }
    if eng.handle.has_metadata():
        ti = eng.handle.get_torrent_info()
        fs = ti.files()
        # Per-file bytes-downloaded — needed by the backend save-to-
        # library flow to know when the chosen file is ACTUALLY
        # complete (libtorrent pre-allocates files at full size, so
        # "file exists at expected size" is true the moment add_torrent
        # runs and isn't a download-completion signal).
        try:
            file_progress = list(eng.handle.file_progress())
        except Exception:
            file_progress = [0] * fs.num_files()
        out["files"] = [
            {
                "index": i,
                "path": fs.file_path(i),
                "size": fs.file_size(i),
                "bytes_done": int(file_progress[i]) if i < len(file_progress) else 0,
            }
            for i in range(fs.num_files())
        ]
        out["name"] = ti.name()
        out["total_size"] = ti.total_size()
    return JSONResponse(out)


# ── Streaming ───────────────────────────────────────────────────────

# How long to wait for metadata when a GET arrives before an explicit
# `create` set things up. Long enough to cover DHT bootstrap on a fresh
# session; short enough that a dead infohash doesn't tie up the request
# forever.
_METADATA_WAIT_S = float(os.environ.get("AUDIMO_STREAMING_METADATA_S", "60"))
# Max time spent waiting for any single piece during streaming. A slow
# swarm is preferable to a 504, but we cap to surface "this isn't going
# to play" eventually.
_PIECE_WAIT_S = float(os.environ.get("AUDIMO_STREAMING_PIECE_S", "120"))
# Read chunk size when streaming bytes back. 256 KiB matches the high-
# water mark Chrome uses for media `Range` requests.
_CHUNK = 256 * 1024


_MIME_BY_EXT = {
    ".mp3": "audio/mpeg", ".flac": "audio/flac", ".aac": "audio/aac",
    ".m4a": "audio/mp4", ".m4b": "audio/mp4", ".mp4": "video/mp4",
    ".ogg": "audio/ogg", ".opus": "audio/opus", ".wav": "audio/wav",
    ".mkv": "video/x-matroska", ".webm": "video/webm",
}


def _parse_range(header: str, file_size: int) -> Optional[tuple[int, int]]:
    """Parse a `Range: bytes=START-END` header. Returns (start, end)
    inclusive, or None for an unparseable / unsatisfiable range."""
    if not header or not header.startswith("bytes="):
        return None
    try:
        spec = header[len("bytes="):].split(",", 1)[0].strip()
        if "-" not in spec:
            return None
        start_s, end_s = spec.split("-", 1)
        if start_s == "":
            # Suffix range: bytes=-N → last N bytes.
            n = int(end_s)
            if n <= 0:
                return None
            return max(0, file_size - n), file_size - 1
        start = int(start_s)
        end = int(end_s) if end_s else file_size - 1
        if start > end or start >= file_size:
            return None
        return start, min(end, file_size - 1)
    except ValueError:
        return None


@app.get("/{infohash}/{file_idx}")
async def stream(infohash: str, file_idx: int, request: Request):
    h = _normalize_infohash(infohash)
    if not h:
        raise HTTPException(400, "infohash must be a 40-char hex string")

    eng = await _get_or_create_engine(h)
    if not await _wait_metadata(eng, _METADATA_WAIT_S):
        raise HTTPException(504, "timed out waiting for torrent metadata")
    eng.touch()

    ti = eng.handle.get_torrent_info()
    fs = ti.files()
    if file_idx < 0 or file_idx >= fs.num_files():
        raise HTTPException(404, f"file index {file_idx} out of range")

    file_size = fs.file_size(file_idx)
    file_offset = fs.file_offset(file_idx)
    file_path_rel = fs.file_path(file_idx)
    file_path_abs = os.path.join(eng.save_path, file_path_rel)
    piece_length = ti.piece_length()

    # Make sure this file is the prioritized one. Idempotent if /select
    # was already called by the frontend right after metadata arrived
    # (the fast path); falls back to setting it now if the GET is the
    # first signal we have. See `_prioritize_file` for the head + tail
    # piece deadline strategy.
    _prioritize_file(eng, file_idx)

    range_hdr = request.headers.get("range") or request.headers.get("Range")
    rng = _parse_range(range_hdr, file_size) if range_hdr else None
    if range_hdr and rng is None:
        return JSONResponse(
            {"detail": "unsatisfiable range"},
            status_code=416,
            headers={"Content-Range": f"bytes */{file_size}"},
        )
    start, end = rng if rng else (0, file_size - 1)
    length = end - start + 1
    status = 206 if rng else 200

    ext = os.path.splitext(file_path_rel)[1].lower()
    mime = _MIME_BY_EXT.get(ext, "application/octet-stream")

    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(length),
        "Content-Type": mime,
    }
    if rng:
        headers["Content-Range"] = f"bytes {start}-{end}/{file_size}"

    async def gen():
        # Walk the requested range piece-by-piece, waiting for each to
        # download before reading from disk. set_piece_deadline pushes
        # libtorrent to fetch them in order. Bail out when the client
        # disconnects so we don't spin downloading bytes nobody wants.
        cursor = start
        while cursor <= end:
            if await request.is_disconnected():
                return
            piece = (file_offset + cursor) // piece_length
            if not eng.handle.have_piece(piece):
                eng.handle.set_piece_deadline(piece, 0)
                if not await _wait_piece(eng, piece, _PIECE_WAIT_S):
                    return  # client gets a truncated stream — better than 504 mid-flight
            try:
                with open(file_path_abs, "rb") as f:
                    f.seek(cursor)
                    remaining_in_piece = piece_length - ((file_offset + cursor) % piece_length)
                    to_read = min(_CHUNK, end - cursor + 1, remaining_in_piece)
                    chunk = f.read(to_read)
            except FileNotFoundError:
                # libtorrent sometimes reports have_piece() before the
                # disk write finishes. Tiny backoff and retry once.
                await asyncio.sleep(0.05)
                continue
            if not chunk:
                await asyncio.sleep(0.05)
                continue
            yield chunk
            cursor += len(chunk)
            eng.touch()

    return StreamingResponse(gen(), status_code=status, headers=headers, media_type=mime)
