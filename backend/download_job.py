"""Generic HTTP-to-disk download jobs.

Used by both music (cache rows that want a local copy) and audiobooks
(library rows promoting from streamed-only to disk-resident). The
mechanics are domain-agnostic: take a source URL + a destination
absolute path, fetch with HTTP Range support, write to a sibling
``.part`` file, atomic-rename when done.

State lives in an in-memory dict keyed by job id. Each job runs in a
background ``asyncio`` task; cancellation is cooperative via
``threading.Event``-style flag the fetch loop polls between chunks.
The dict survives the lifetime of the backend process — restarts
abort everything in flight, callers should re-trigger after boot.
"""
from __future__ import annotations

import asyncio
import os
import time
import uuid
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Optional
from urllib.parse import urlparse

import httpx


@dataclass
class DownloadJob:
    id: str
    kind: str                          # 'music' | 'audiobook'
    url: str
    dest_path: str                     # absolute path under user roots
    label: str = ""                    # human-readable for the progress UI
    related_key: str = ""              # cache_key for music, book_id for audiobook
    status: str = "pending"            # pending | downloading | done | error | cancelled
    bytes_done: int = 0
    bytes_total: int = 0
    started_at: int = 0
    finished_at: int = 0
    error: str = ""
    # Set externally to ask the worker to stop. Polled between
    # chunks; doesn't kill the in-flight read so the user might
    # still see one buffer's worth of bytes after they cancel.
    cancel_flag: bool = False
    # Optional callback fired once on terminal status (done/error/
    # cancelled). Used by the music + audiobook wrappers to update
    # their respective rows without coupling this module to either.
    on_finish: Optional[Callable[["DownloadJob"], Awaitable[None]]] = field(default=None, repr=False)

    @property
    def pct(self) -> float:
        if self.bytes_total <= 0:
            return 0.0
        return min(100.0, (self.bytes_done / self.bytes_total) * 100.0)

    def as_public(self) -> dict:
        return {
            "id": self.id,
            "kind": self.kind,
            "label": self.label,
            "related_key": self.related_key,
            "status": self.status,
            "bytes_done": self.bytes_done,
            "bytes_total": self.bytes_total,
            "pct": round(self.pct, 1),
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "error": self.error,
        }


# In-memory registry. Pruned aggressively so the dict can't grow
# unbounded on a long-lived backend. Two cutoffs apply on each
# ``_prune()`` call:
#
#   1. Time: completed jobs older than 30 minutes go regardless of
#      count — the frontend's progress overlay only cares about
#      recent jobs, and stale finished rows are pure noise.
#   2. Count: keep at most ``_MAX_TERMINAL_JOBS`` finished rows
#      (oldest first). A user who fires hundreds of small downloads
#      in one session would otherwise hold every job dict in RAM
#      until the next time cutoff.
#
# Active jobs (pending/downloading) are never pruned — they're the
# whole point of the registry.
_JOBS: dict[str, DownloadJob] = {}
_GC_AGE_S = 30 * 60
_MAX_TERMINAL_JOBS = 50


def _prune():
    cutoff = int(time.time()) - _GC_AGE_S
    # Phase 1: drop everything terminal-and-old.
    aged = [jid for jid, j in _JOBS.items() if j.finished_at and j.finished_at < cutoff]
    for jid in aged:
        _JOBS.pop(jid, None)
    # Phase 2: cap the terminal-but-recent set. Active jobs are
    # excluded from the count so a stuck/long-running download
    # doesn't get evicted.
    terminal = [
        (jid, j) for jid, j in _JOBS.items()
        if j.finished_at and j.status in ("done", "error", "cancelled")
    ]
    if len(terminal) > _MAX_TERMINAL_JOBS:
        terminal.sort(key=lambda kv: kv[1].finished_at or 0)
        for jid, _j in terminal[:len(terminal) - _MAX_TERMINAL_JOBS]:
            _JOBS.pop(jid, None)


def list_jobs() -> list[dict]:
    """Public job snapshot — drives the progress overlay."""
    _prune()
    return [j.as_public() for j in _JOBS.values()]


def get_job(job_id: str) -> Optional[DownloadJob]:
    return _JOBS.get(job_id)


def cancel_job(job_id: str) -> bool:
    j = _JOBS.get(job_id)
    if not j:
        return False
    if j.status in ("done", "error", "cancelled"):
        return False
    j.cancel_flag = True
    return True


def find_active_for(kind: str, related_key: str) -> Optional[DownloadJob]:
    """Return the in-flight job for a given (kind, key) if any.
    Lets callers debounce duplicate Download clicks."""
    for j in _JOBS.values():
        if j.kind != kind or j.related_key != related_key:
            continue
        if j.status in ("pending", "downloading"):
            return j
    return None


def _looks_like_safe_url(u: str) -> bool:
    """Reject anything that isn't a plain HTTP(S) URL whose host is
    safe to fetch. Routes through ``safe_fetch.validate_url`` so the
    block list (link-local / RFC1918 private / multicast / reserved)
    is identical to the addon-manifest path. Loopback stays allowed
    because the bundled streaming sidecar legitimately serves audio
    from ``127.0.0.1:11471``."""
    from safe_fetch import validate_url
    try:
        validate_url(u, max_len=4096, allow_loopback=True)
    except Exception:
        return False
    return True


_DEFAULT_HEADERS = {
    # Some CDNs 403 on missing/empty UA. Mimic a recent browser.
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/123.0.0.0 Safari/537.36",
    "Accept": "*/*",
}


async def _probe_range_support(client: httpx.AsyncClient, url: str) -> tuple[int, bool]:
    """Probe the URL with HEAD + a tiny Range GET to learn total size
    and whether the server actually serves byte ranges. googlevideo
    advertises Accept-Ranges in some HEAD responses but the canonical
    test is whether a Range request comes back as 206. Returns
    ``(total_bytes, range_ok)``; total of 0 means unknown."""
    total = 0
    range_ok = False
    try:
        h = await client.head(url, follow_redirects=True)
        cl = h.headers.get("content-length")
        if cl and cl.isdigit():
            total = int(cl)
        if (h.headers.get("accept-ranges") or "").lower() == "bytes":
            range_ok = True
    except Exception:
        pass
    if total <= 0 or not range_ok:
        # Some hosts (incl. googlevideo) don't expose AR on HEAD.
        # Fall back to a 1-byte Range probe; a 206 response is the
        # authoritative signal that we can split the download up.
        try:
            r = await client.get(url, headers={"Range": "bytes=0-0"}, follow_redirects=True)
            if r.status_code == 206:
                range_ok = True
                cr = r.headers.get("content-range") or ""
                # Format: "bytes 0-0/12345"
                if "/" in cr:
                    tail = cr.rsplit("/", 1)[-1].strip()
                    if tail.isdigit():
                        total = int(tail)
        except Exception:
            pass
    return total, range_ok


async def _download_parallel_ranges(
    job: "DownloadJob",
    client: httpx.AsyncClient,
    part_path: str,
    total: int,
    chunks: int,
) -> Exception | None:
    """Pull the file in N parallel byte-range requests. Each task
    writes its slice with its own file handle + seek, so the kernel
    handles the ordering. Pre-allocates .part to ``total`` bytes so
    seek-then-write doesn't sparse-write across the file system.
    Returns ``None`` on success or the last exception on hard
    failure. Cancels mid-stream when ``job.cancel_flag`` flips."""
    PER_CHUNK_RETRY = 4
    # Pre-allocate so seeked writes don't extend the file repeatedly.
    with open(part_path, "wb") as fh:
        try: fh.truncate(total)
        except OSError: pass

    # Even slicing; last chunk absorbs any rounding remainder.
    chunk_size = total // chunks
    ranges: list[tuple[int, int]] = []
    for i in range(chunks):
        start = i * chunk_size
        end = total - 1 if i == chunks - 1 else (start + chunk_size - 1)
        ranges.append((start, end))

    job.bytes_done = 0
    last_err: Exception | None = None
    sem = asyncio.Lock()  # protect bytes_done updates from skew

    async def fetch_range(start: int, end: int) -> None:
        nonlocal last_err
        for attempt in range(1, PER_CHUNK_RETRY + 1):
            if job.cancel_flag: return
            try:
                async with client.stream(
                    "GET", job.url,
                    headers={"Range": f"bytes={start}-{end}"},
                ) as resp:
                    resp.raise_for_status()
                    # Server may ignore Range — bail to the single-stream
                    # path by surfacing a clear error to the caller.
                    if resp.status_code != 206:
                        raise httpx.HTTPError(
                            f"server returned {resp.status_code} for Range request "
                            "(expected 206)"
                        )
                    pos = start
                    # Each task opens its own handle + seeks. macOS / Linux
                    # serialize per-handle writes, so concurrent seeks are
                    # safe as long as ranges don't overlap (they don't).
                    with open(part_path, "r+b") as fh:
                        fh.seek(start)
                        async for piece in resp.aiter_bytes(chunk_size=64 * 1024):
                            if job.cancel_flag: return
                            fh.write(piece)
                            pos += len(piece)
                            async with sem:
                                job.bytes_done += len(piece)
                    if pos - 1 < end:
                        # Truncated mid-range — retry just this chunk
                        # from where we got cut. Update the start so
                        # the next attempt resumes at the right offset.
                        async with sem:
                            # bytes_done already counted whatever made it
                            # to disk; don't double-count on retry.
                            pass
                        start = pos
                        last_err = httpx.RemoteProtocolError(
                            f"chunk cut at {pos - 1}/{end}")
                        await asyncio.sleep(min(2 ** attempt, 4))
                        continue
                    return  # success
            except (httpx.HTTPError, OSError) as e:
                last_err = e
                if attempt >= PER_CHUNK_RETRY: return
                await asyncio.sleep(min(2 ** attempt, 4))

    tasks = [asyncio.create_task(fetch_range(s, e)) for s, e in ranges]
    try:
        await asyncio.gather(*tasks)
    except Exception as e:
        last_err = e

    if job.cancel_flag:
        return None  # caller cleans up
    # Verify final size matches expectation; if short, surface the
    # last sub-error so the caller falls back to single-stream.
    actual = os.path.getsize(part_path) if os.path.exists(part_path) else 0
    if actual < total:
        return last_err or RuntimeError(f"got {actual}/{total} bytes")
    return None


async def _safe_on_finish(job: "DownloadJob") -> None:
    """Run ``job.on_finish`` if present, swallowing exceptions so a
    bad hook can't crash the worker. Records the failure on the job
    instead — the frontend's progress overlay surfaces ``job.error``,
    so a silent on_finish crash (e.g. db write fail) doesn't leave
    the user staring at a "done" row whose follow-up never landed."""
    if not job.on_finish:
        return
    try:
        await job.on_finish(job)
    except Exception as e:
        # Don't override a primary success/failure status if it's
        # already terminal — only stamp error when the job was
        # otherwise headed for a clean done.
        if job.status in ("done", "finalizing"):
            job.status = "error"
            job.error = f"on_finish: {e}"
        print(f"[download_job] on_finish hook raised: {e}", flush=True)


async def _run(job: DownloadJob) -> None:
    """Worker body. Streams bytes from job.url to job.dest_path with
    chunked writes + cancel polling. On success: atomic rename
    .part → final, fire on_finish. On error: leave the .part on disk
    (lets a future resume pick it up if we ever add Range-resume),
    record error message."""
    job.status = "downloading"
    job.started_at = int(time.time())

    if not _looks_like_safe_url(job.url):
        job.status = "error"
        job.error = "url failed safety check"
        job.finished_at = int(time.time())
        await _safe_on_finish(job)
        return

    os.makedirs(os.path.dirname(job.dest_path), exist_ok=True)
    part_path = job.dest_path + ".part"

    # If the destination already exists, treat it as 'already done'.
    # A common case: user clicks Download twice, the first finished
    # before the second click registered.
    if os.path.exists(job.dest_path) and os.path.getsize(job.dest_path) > 0:
        job.bytes_total = os.path.getsize(job.dest_path)
        job.bytes_done = job.bytes_total
        job.status = "done"
        job.finished_at = int(time.time())
        await _safe_on_finish(job)
        return

    # Resume-with-retry. googlevideo (YouTube) and some debrid CDNs
    # cut the connection partway through long audio fetches; without
    # Range-resume the user gets a half-MP3 .part and an empty-string
    # error. Up to MAX_ATTEMPTS retries; each attempt that makes
    # *some* forward progress resets the strike count so a flaky link
    # can still finish given enough patience.
    MAX_ATTEMPTS = 6
    NO_PROGRESS_LIMIT = 2  # consecutive zero-byte attempts → give up
    HEADERS = _DEFAULT_HEADERS

    last_err: Exception | None = None
    no_progress_streak = 0
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(60.0, read=120.0, write=60.0, pool=60.0),
            follow_redirects=True,
            headers=HEADERS,
        ) as client:
            # Fast path — googlevideo (and most CDNs) throttle a single
            # open GET to ~realtime stream rate. Explicit Range requests
            # bypass that cap. Probe first; if Range works and we know
            # the size, fan out to parallel chunks. Min 512KB to avoid
            # spawning lots of tasks for small files.
            parallel_done = False
            total_probe, range_ok = await _probe_range_support(client, job.url)
            if range_ok and total_probe >= 512 * 1024:
                job.bytes_total = total_probe
                # 4 chunks ≈ matches the 4-stream parallelism most browsers
                # use and stays under googlevideo's per-IP concurrency.
                par_err = await _download_parallel_ranges(
                    job, client, part_path, total_probe, chunks=4,
                )
                if par_err is None and not job.cancel_flag:
                    parallel_done = True
                else:
                    # Parallel path failed (or got cancelled) — wipe the
                    # .part. On failure we fall through to the legacy
                    # single-stream loop; on cancel the post-loop block
                    # handles the cancelled status.
                    last_err = par_err
                    try: os.remove(part_path)
                    except OSError: pass
                    job.bytes_done = 0

            for attempt in range(1, MAX_ATTEMPTS + 1):
                if parallel_done: break
                if job.cancel_flag: break
                # Pre-attempt size on disk drives Range header + append mode.
                start_offset = 0
                try:
                    if os.path.exists(part_path):
                        start_offset = os.path.getsize(part_path)
                except OSError:
                    start_offset = 0

                req_headers = dict(HEADERS)
                if start_offset > 0:
                    req_headers["Range"] = f"bytes={start_offset}-"

                bytes_this_attempt = 0
                try:
                    async with client.stream("GET", job.url, headers=req_headers) as resp:
                        # If server ignored Range and sent the whole body
                        # (200 instead of 206), restart from scratch.
                        ignored_range = (start_offset > 0 and resp.status_code == 200)
                        resp.raise_for_status()

                        cl = resp.headers.get("content-length")
                        if cl and cl.isdigit():
                            cl_int = int(cl)
                            if resp.status_code == 206:
                                # Partial content: total = offset + remaining.
                                job.bytes_total = start_offset + cl_int
                            else:
                                job.bytes_total = cl_int

                        mode = "wb" if (start_offset == 0 or ignored_range) else "ab"
                        if ignored_range:
                            start_offset = 0
                            job.bytes_done = 0

                        with open(part_path, mode) as fh:
                            if mode == "ab":
                                # Make sure our running counter matches the file.
                                job.bytes_done = start_offset
                            async for chunk in resp.aiter_bytes(chunk_size=64 * 1024):
                                if job.cancel_flag:
                                    job.status = "cancelled"
                                    try: fh.close()
                                    except Exception: pass
                                    try: os.remove(part_path)
                                    except OSError: pass
                                    job.finished_at = int(time.time())
                                    await _safe_on_finish(job)
                                    return
                                fh.write(chunk)
                                job.bytes_done += len(chunk)
                                bytes_this_attempt += len(chunk)
                    # Stream finished cleanly. If we know the total and
                    # we're short, treat as a partial-cut and retry.
                    if job.bytes_total > 0 and job.bytes_done < job.bytes_total:
                        last_err = httpx.RemoteProtocolError(
                            f"stream ended at {job.bytes_done}/{job.bytes_total} bytes")
                        if bytes_this_attempt > 0:
                            no_progress_streak = 0
                        else:
                            no_progress_streak += 1
                        if no_progress_streak >= NO_PROGRESS_LIMIT:
                            break
                        await asyncio.sleep(min(2 ** attempt, 8))
                        continue
                    # Either total unknown but stream closed cleanly, or
                    # we hit the byte target — call it done.
                    last_err = None
                    break
                except (httpx.HTTPError, OSError) as e:
                    last_err = e
                    if bytes_this_attempt > 0:
                        no_progress_streak = 0
                    else:
                        no_progress_streak += 1
                    if no_progress_streak >= NO_PROGRESS_LIMIT or attempt >= MAX_ATTEMPTS:
                        break
                    await asyncio.sleep(min(2 ** attempt, 8))

        if job.cancel_flag:
            job.status = "cancelled"
            try: os.remove(part_path)
            except OSError: pass
        elif last_err is not None:
            job.status = "error"
            msg = str(last_err) or last_err.__class__.__name__
            job.error = msg
        else:
            os.replace(part_path, job.dest_path)
            try:
                sz = os.path.getsize(job.dest_path)
                if sz > 0:
                    job.bytes_done = sz
                    if job.bytes_total <= 0:
                        job.bytes_total = sz
            except OSError:
                pass
            # Provisional state — the on_finish hook may still be
            # running (transcode pass, cache row stamp). Frontends
            # treat "finalizing" as not-ready so a Library row that's
            # mid-stamp doesn't briefly show the un-downloaded state
            # before the cache.list refetch picks up the local_file.
            job.status = "finalizing"
    except (httpx.HTTPError, OSError) as e:
        job.status = "error"
        job.error = str(e) or e.__class__.__name__
        # Leave the .part on disk — partial bytes are forensic info,
        # and a future retry can resume from where this left off.
    finally:
        # Terminal-path hook firing. _safe_on_finish swallows the
        # callback exception, records it as job.error, and leaves
        # the job's primary status intact unless we were heading
        # for a clean done (then it becomes error).
        await _safe_on_finish(job)
        # Flip provisional → terminal only after the hook had its
        # turn. "finalizing" never leaks into a finished_at-stamped
        # job — the frontend's "just done" detection keys off
        # finished_at, so wait until status + finished_at agree.
        if job.status == "finalizing":
            job.status = "done"
        job.finished_at = int(time.time())


def start_download(
    *,
    kind: str,
    url: str,
    dest_path: str,
    label: str = "",
    related_key: str = "",
    on_finish: Optional[Callable[[DownloadJob], Awaitable[None]]] = None,
) -> DownloadJob:
    """Spawn a download job. Returns the freshly-registered job
    record; the actual fetch runs in a background asyncio task. The
    job id is the only handle the caller needs."""
    job = DownloadJob(
        id=uuid.uuid4().hex[:16],
        kind=kind,
        url=url,
        dest_path=dest_path,
        label=label,
        related_key=related_key,
        on_finish=on_finish,
    )
    _JOBS[job.id] = job
    asyncio.create_task(_run(job))
    return job
