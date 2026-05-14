"""AssemblyAI-based audiobook chapter detection.

Long-running job: streams the local audio file to AssemblyAI's
``/upload`` endpoint, kicks off a transcript with ``auto_chapters``
enabled, polls until completion, parses the chapter list, persists
to ``audiobook_chapters``. Status visible via the same job
registry download_job uses, so the frontend's existing
``/api/download/jobs`` endpoint surfaces detection progress
alongside downloads.

Why AssemblyAI vs. an LLM with audio input: their pipeline runs
real ASR (Universal-2) and *then* runs chapter detection on top,
so timestamps are grounded in actual word positions in the audio.
LLMs with audio context (Gemini, GPT-4o-audio) hallucinate
timestamps because their precision-time output isn't tied to the
waveform.
"""
from __future__ import annotations

import asyncio
import json
import os
import time
import uuid

import httpx

import download_job
from database import get_db


ASSEMBLYAI_BASE = "https://api.assemblyai.com/v2"


async def _aai_upload(client: httpx.AsyncClient, api_key: str, path: str, job: download_job.DownloadJob) -> str:
    """Stream the file to AssemblyAI's ``/upload`` endpoint. Returns
    the upload_url they hand back — it's a private S3-like URL only
    they can resolve. Single POST, no resumable protocol nonsense.

    Body is streamed via an async generator so we can tick
    bytes_done as chunks leave the socket. AssemblyAI doesn't
    require Content-Length and accepts chunked transfer encoding.
    """
    size = os.path.getsize(path)
    job.bytes_total = size
    job.bytes_done = 0

    chunk_size = 256 * 1024
    async def stream_body():
        with open(path, "rb") as fh:
            while True:
                if job.cancel_flag:
                    return
                chunk = fh.read(chunk_size)
                if not chunk:
                    break
                yield chunk
                job.bytes_done += len(chunk)

    r = await client.post(
        f"{ASSEMBLYAI_BASE}/upload",
        content=stream_body(),
        headers={
            "Authorization": api_key,
            "Content-Type": "application/octet-stream",
            "Content-Length": str(size),
        },
        timeout=httpx.Timeout(600.0, read=120.0, write=600.0),
    )
    r.raise_for_status()
    job.bytes_done = size
    upload_url = r.json().get("upload_url") or ""
    if not upload_url:
        raise RuntimeError("AssemblyAI didn't return an upload_url")
    return upload_url


async def _aai_create_transcript(client: httpx.AsyncClient, api_key: str, audio_url: str) -> str:
    """Kick off a transcript. We DON'T enable auto_chapters — it's
    AssemblyAI's topic-segmentation feature, not chapter detection,
    and fires every few minutes on story-driven audiobooks (30+
    bogus segments where the book has 10 real chapters).

    Instead we get the bare transcript with word-level timestamps
    and search the word stream ourselves for "Chapter N" /
    "Prologue" / etc. announcements. Word timestamps are real ASR
    output, so the chapter boundaries are grounded in audio.
    """
    r = await client.post(
        f"{ASSEMBLYAI_BASE}/transcript",
        headers={"Authorization": api_key, "Content-Type": "application/json"},
        json={
            "audio_url": audio_url,
            # universal-2 is the standard tier (~$0.27/hr).
            # universal-3-pro is the premium option for harder
            # audio; not worth the extra cost for clean audiobook
            # narration.
            "speech_models": ["universal-2"],
            # Single-narrator audiobooks don't benefit from speaker
            # labels — disabling shaves processing time.
            "speaker_labels": False,
            "punctuate": True,
            "format_text": True,
        },
        timeout=httpx.Timeout(60.0),
    )
    if r.status_code >= 400:
        # Capture the response body so the user sees a useful
        # error rather than the bare HTTP status. AssemblyAI
        # surfaces clear messages like "speech_models must be one
        # of: ..." which the bare 400 would hide.
        body = ""
        try:
            j = r.json()
            body = j.get("error") or json.dumps(j)
        except ValueError:
            body = r.text[:300]
        raise RuntimeError(f"AssemblyAI rejected transcript ({r.status_code}): {body}")
    transcript_id = r.json().get("id") or ""
    if not transcript_id:
        raise RuntimeError("AssemblyAI didn't return a transcript id")
    return transcript_id


async def _aai_poll_transcript(client: httpx.AsyncClient, api_key: str, transcript_id: str, job: download_job.DownloadJob, timeout_s: int = 1800) -> dict:
    """Poll until the transcript is ``completed`` or ``error``.
    AssemblyAI usually finishes in 0.3-0.5x realtime — a 10h book
    typically transcribes in 3-5 minutes. We give a 30-min budget
    to absorb queue waits during peak usage."""
    deadline = time.time() + timeout_s
    started = time.time()
    while time.time() < deadline:
        if job.cancel_flag:
            raise RuntimeError("cancelled")
        r = await client.get(
            f"{ASSEMBLYAI_BASE}/transcript/{transcript_id}",
            headers={"Authorization": api_key},
            timeout=httpx.Timeout(30.0),
        )
        r.raise_for_status()
        data = r.json()
        status = data.get("status", "")
        if status == "completed":
            return data
        if status == "error":
            raise RuntimeError(f"AssemblyAI: {data.get('error', 'unknown error')}")
        # Surface elapsed time + AAI's status string in the job
        # label so the frontend overlay shows real progress signal.
        elapsed = int(time.time() - started)
        job.label = f"AssemblyAI: {status}… ({elapsed}s)"
        await asyncio.sleep(3.0)
    raise RuntimeError("AssemblyAI processing timed out (30 min)")


def _persist_chapters(user_id: int, book_id: str, chapters: list[dict], source: str = "assemblyai"):
    """Replace any existing detected chapters for this book with the
    new list. Manual overrides (source='manual') aren't touched —
    user-edited rows survive a re-detection."""
    now = int(time.time())
    with get_db() as conn:
        conn.execute(
            "DELETE FROM audiobook_chapters WHERE user_id = ? AND book_id = ? AND source != 'manual'",
            (user_id, book_id),
        )
        for ch in chapters:
            conn.execute(
                """INSERT INTO audiobook_chapters
                   (user_id, book_id, source, index_n, title, start_s, end_s, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    user_id,
                    book_id,
                    source,
                    int(ch.get("index") or 0),
                    str(ch.get("title") or "")[:240],
                    float(ch.get("start_s") or 0),
                    float(ch.get("end_s") or 0),
                    now,
                ),
            )


_NUMBER_WORDS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
    "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14,
    "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18,
    "nineteen": 19, "twenty": 20, "thirty": 30, "forty": 40,
    "fifty": 50,
    # Ordinals in case the narrator says "Chapter the First"
    "first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5,
    "sixth": 6, "seventh": 7, "eighth": 8, "ninth": 9, "tenth": 10,
}
_ROMAN = {"i": 1, "ii": 2, "iii": 3, "iv": 4, "v": 5, "vi": 6,
          "vii": 7, "viii": 8, "ix": 9, "x": 10, "xi": 11,
          "xii": 12, "xiii": 13, "xiv": 14, "xv": 15}
_STANDALONE_LABELS = {
    "prologue", "epilogue", "foreword", "preface", "introduction",
    "afterword", "appendix", "preamble", "intro", "outro",
    "conclusion", "credits",
}


def _word_text(w: dict) -> str:
    """Strip trailing punctuation and lowercase a word from the
    transcript. AssemblyAI returns words with attached punctuation
    when format_text is on (e.g. "Chapter,")."""
    t = (w.get("text") or "").strip().lower()
    # Drop trailing punctuation; keep apostrophes for "let's", "won't"
    return t.rstrip(".,!?;:\"')") .lstrip("\"'(")


def _parse_chapter_number(words_after: list[dict]) -> tuple[int, int] | None:
    """Try to read a chapter number out of the next 1-3 words after
    the keyword "chapter" / "part". Returns (number, words_consumed)
    or None if no number found. Handles digit ("3"), word ("three"),
    Roman ("III"), and ordinal ("third") forms."""
    if not words_after:
        return None
    w0 = _word_text(words_after[0])
    # "the" filler: "Chapter the First"
    if w0 == "the" and len(words_after) >= 2:
        w1 = _word_text(words_after[1])
        n = _NUMBER_WORDS.get(w1)
        if n is not None:
            return (n, 2)
    # Digit
    if w0.isdigit():
        try:
            return (int(w0), 1)
        except ValueError:
            pass
    # Number word or ordinal
    n = _NUMBER_WORDS.get(w0)
    if n is not None:
        return (n, 1)
    # Roman numeral
    n = _ROMAN.get(w0)
    if n is not None:
        return (n, 1)
    return None


def _extract_chapters_from_words(words: list[dict], total_duration_ms: int) -> list[dict]:
    """Walk the word-level transcript and synthesize a chapter list
    from spoken announcements. Returns the same shape we persist:
    [{index, title, start_s, end_s}, ...].

    Heuristics:
      • A "chapter" or "part" keyword followed within 2 words by a
        number (digit/word/Roman/ordinal) starts a chapter.
      • Standalone "prologue"/"epilogue"/"foreword"/etc. start a
        chapter when preceded by ≥1.5s of silence (gap from the
        previous word's end).
      • Title is reconstructed from the next ~6 words after the
        announcement (typically the chapter's spoken title), but
        clipped at the next sentence-ending punctuation.

    Fallback: if no chapter announcements are found at all, return
    a single "Audiobook" chapter spanning the whole duration. The
    caller can decide whether to persist that or treat as no-op.
    """
    if not words:
        return []
    raw: list[tuple[float, str]] = []   # (start_s, full_title)
    n_words = len(words)
    i = 0
    while i < n_words:
        w = words[i]
        text = _word_text(w)
        prev_end = words[i - 1].get("end") if i > 0 else 0
        gap_s = ((w.get("start") or 0) - (prev_end or 0)) / 1000.0

        chapter_number = None
        consumed = 0
        keyword_word = None

        if text in ("chapter", "part") and gap_s >= 0.4:
            parsed = _parse_chapter_number(words[i + 1: i + 4])
            if parsed:
                chapter_number, consumed = parsed
                keyword_word = text
        elif text in _STANDALONE_LABELS and gap_s >= 1.5:
            # "Prologue", "Epilogue", etc. — standalone.
            chapter_number = -1   # placeholder; we'll renumber later
            consumed = 0
            keyword_word = text

        if keyword_word is None:
            i += 1
            continue

        # Title is intentionally minimal: numbered chapters become
        # "Chapter N" / "Part N"; standalone labels become their
        # capitalized form ("Prologue", "Epilogue", etc.). We
        # *don't* try to grab the next few words for a title,
        # because most audiobooks don't *have* spoken chapter
        # titles — the narrator says "Chapter Three." and goes
        # straight into prose. Capturing those next words just
        # leaks story content into the chapter label.
        start_ms = w.get("start") or 0
        if chapter_number == -1:
            # Standalone label (Prologue, Epilogue, etc.).
            title = keyword_word.title()
        else:
            title = f"{keyword_word.title()} {chapter_number}"
        raw.append((start_ms / 1000.0, title))
        # Skip past the keyword + any number-words we consumed so
        # we don't re-detect the same announcement.
        i = i + 1 + consumed

    if not raw:
        # No announcements found. Caller decides — we return empty
        # and the run_detect wrapper raises.
        return []

    # Build the final list: end_s of each chapter is the next
    # chapter's start_s (or the audio total for the last one).
    out = []
    for idx, (start_s, title) in enumerate(raw):
        end_s = raw[idx + 1][0] if idx + 1 < len(raw) else total_duration_ms / 1000.0
        out.append({
            "index": idx + 1,
            "title": title[:240],
            "start_s": start_s,
            "end_s": end_s,
        })
    return out


async def _run_detect(job: download_job.DownloadJob, user_id: int, book_id: str, file_path: str, api_key: str):
    """Worker body. Runs upload → create transcript → poll → persist.
    Updates job.label as it transitions phases so the frontend
    overlay can render meaningful text."""
    job.status = "downloading"   # reuses download_job's state machine — "downloading" = active phase
    job.started_at = int(time.time())
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0)) as client:
            job.label = "Uploading to AssemblyAI…"
            audio_url = await _aai_upload(client, api_key, file_path, job)
            job.label = "Queuing transcript…"
            tid = await _aai_create_transcript(client, api_key, audio_url)
            job.label = "AssemblyAI: queued… (0s)"
            data = await _aai_poll_transcript(client, api_key, tid, job)
            words = data.get("words") or []
            duration_ms = (data.get("audio_duration") or 0) * 1000
            if not words:
                raise RuntimeError("AssemblyAI returned an empty transcript — audio may be silent or unrecognizable")
            chapters = _extract_chapters_from_words(words, duration_ms)
            if not chapters:
                raise RuntimeError("No chapter announcements found in the narration — the book may not have spoken chapter markers")
            _persist_chapters(user_id, book_id, chapters, source="assemblyai")
            job.status = "done"
            job.label = f"Detected {len(chapters)} chapter(s)"
    except Exception as e:
        job.status = "error"
        job.error = str(e)
    finally:
        job.finished_at = int(time.time())


def start_detect(*, user_id: int, book_id: str, file_path: str, api_key: str, label: str = "") -> download_job.DownloadJob:
    """Spawn a chapter-detect job. Reuses the download_job registry
    so the frontend's existing /api/download/jobs polling surfaces
    progress alongside actual downloads. The kind='chapter-detect'
    lets the UI tell them apart."""
    job = download_job.DownloadJob(
        id=uuid.uuid4().hex[:16],
        kind="chapter-detect",
        url="",                              # not a download — kept empty
        dest_path=file_path,                 # informational
        label=label or "Detecting chapters…",
        related_key=book_id,
    )
    download_job._JOBS[job.id] = job
    asyncio.create_task(_run_detect(job, user_id, book_id, file_path, api_key))
    return job
