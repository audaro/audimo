import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { authFetch, resolveCacheEntry } from '../api'
import { useDownloadJobs, findJob } from '../hooks/useDownloadJobs'
import Monogram from './Monogram'
import styles from './AudiobookDetailView.module.css'

// Map raw mime types / file paths into the format label the user
// recognises (M4B, MP3, FLAC, …) instead of "audio/mp4". m4b and
// m4a both serve as audio/mp4 over HTTP, so the file extension wins
// when we have one — otherwise fall back to the mime guess.
function prettyFormat(localFile, mime) {
  const ext = ((localFile || '').match(/\.([a-z0-9]{2,5})$/i) || [])[1]?.toLowerCase()
  if (ext) {
    if (ext === 'm4b') return 'M4B'
    if (ext === 'm4a') return 'M4A'
    if (ext === 'mp3') return 'MP3'
    if (ext === 'flac') return 'FLAC'
    if (ext === 'opus') return 'OPUS'
    if (ext === 'wav') return 'WAV'
    if (ext === 'ogg') return 'OGG'
    if (ext === 'aac') return 'AAC'
    return ext.toUpperCase()
  }
  const m = (mime || '').toLowerCase()
  if (!m) return ''
  if (m.includes('mp4')) return 'M4A/M4B'
  if (m.includes('mpeg')) return 'MP3'
  if (m.includes('flac')) return 'FLAC'
  if (m.includes('opus')) return 'OPUS'
  if (m.includes('aac')) return 'AAC'
  return m.replace('audio/', '').toUpperCase()
}

// Audiobook detail — hero + resume + about. Pulls the book record
// from /api/audiobooks/library on mount and reads the resume
// position from the in-app audiobook progress map.
//
// Out of scope for now: chapter list (most books are single-file
// M4Bs without chapter metadata exposed) and bookmarks (needs a
// new backend table — flagged for a follow-up).

function fmtTimeRemaining(seconds) {
  if (!seconds || seconds < 0) return ''
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}h ${m}m left`
  return `${m}m left`
}
function fmtTotal(seconds) {
  if (!seconds || seconds < 0) return ''
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function fmtBytes(b) {
  if (!b || b <= 0) return '—'
  if (b > 1e9) return (b / 1e9).toFixed(2) + ' GB'
  if (b > 1e6) return (b / 1e6).toFixed(1) + ' MB'
  return (b / 1e3).toFixed(0) + ' KB'
}

export default function AudiobookDetailView() {
  const apiKey = useStore(s => s.apiKey)
  const id = useStore(s => s.audiobookDetailId)
  const setView = useStore(s => s.setView)
  // Re-fetch the book record on cache bumps so the just-finished
  // download flips the hero/buttons (Download → Detect chapters, etc.)
  // without forcing the user to navigate away and back.
  const cacheVersion = useStore(s => s.cacheVersion)
  const positions = useStore(s => s.audiobookPositions || {})
  const durations = useStore(s => s.audiobookDurations || {})
  const playNow = useStore(s => s.playNow)
  const showToast = useStore(s => s.showToast)
  const askConfirm = useStore(s => s.askConfirm)

  const [book, setBook] = useState(null)
  const [chapters, setChapters] = useState([])
  const [bookmarks, setBookmarks] = useState([])
  const [loading, setLoading] = useState(true)
  const currentTrack = useStore(s => s.currentTrack)
  const progress = useStore(s => s.progress)
  const seekTo = useStore(s => s.seekTo)
  const isPlayingThisBook =
    currentTrack?.isAudiobook &&
    (currentTrack?.bookKey === id || (typeof currentTrack?.bookKey === 'string' && currentTrack.bookKey.startsWith(`${id}|`)))
  // Active download (if any) for this book — surfaces a progress
  // bar in the hero and disables the Download button while running.
  const downloadJobs = useDownloadJobs()
  const downloadJob = findJob(downloadJobs, 'audiobook', id)
  const detectJob = findJob(downloadJobs, 'chapter-detect', id)
  // Re-fetch chapters when the detect job lands successfully — the
  // backend has just persisted new rows into audiobook_chapters.
  useEffect(() => {
    if (!id || !detectJob) return
    if (detectJob.status !== 'done') return
    authFetch(`/api/audiobooks/library/${encodeURIComponent(id)}/chapters`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setChapters(d.chapters || []) })
      .catch(() => {})
  }, [id, detectJob?.status])
  // Whether the user has an AssemblyAI key configured — drives
  // whether we show the Detect chapters button at all.
  const [aaiEnabled, setAaiEnabled] = useState(false)
  useEffect(() => {
    authFetch('/api/settings/assemblyai')
      .then(r => r.ok ? r.json() : null)
      .then(d => setAaiEnabled(!!d?.enabled))
      .catch(() => {})
  }, [apiKey])

  // When a download finishes, the audiobook_library row gets its
  // local_file stamped — re-fetch the book record so the hero +
  // chapter list react without a manual page reload.
  useEffect(() => {
    if (!id || !downloadJob) return
    if (downloadJob.status !== 'done') return
    authFetch('/api/audiobooks/library')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const found = (d?.books || []).find(b => b.id === id)
        if (found) {
          // Prefer the on-disk extension over whatever's stored in the
          // DB's `format` column — older rows persisted the raw mime
          // ("audio/mp4") which surfaced as "MP4" in the UI even when
          // the actual file was an .m4b.
          setBook({ ...found, format: prettyFormat(found.localFile, found.format) })
        }
      })
      .catch(() => {})
  }, [id, downloadJob?.status])

  useEffect(() => {
    let cancelled = false
    if (!id) { setBook(null); setLoading(false); return }
    setLoading(true)
    // Try the audiobook library table first (downloaded books).
    // If that misses, fall back to the streamed-cache (entries with
    // category='audiobook') — those are books the user has played
    // through an addon stream but not yet promoted to disk. We
    // synthesize a `book` record from the cache fields so the
    // detail page can show the hero + Download button without
    // requiring an audiobook_library row.
    Promise.all([
      authFetch('/api/audiobooks/library').then(r => r.ok ? r.json() : null).catch(() => null),
      authFetch('/api/cache/list').then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([lib, cache]) => {
      if (cancelled) return
      const fromLib = (lib?.books || []).find(b => b.id === id)
      if (fromLib) {
        setBook(fromLib)
        setLoading(false)
        return
      }
      // Cache-only fallback. AudiobooksView's merge keys cache rows
      // by bookId(title, author) — kept identical here so a click
      // from the library grid lands on the same hash. Don't refactor
      // out without updating both sites.
      const bookId = (title, author) =>
        btoa(encodeURIComponent(`${title}|${author || ''}`))
          .replace(/[^a-z0-9]/gi, '').slice(0, 32)
      const audiobookCache = (cache?.entries || [])
        .filter(e => e.category === 'audiobook' || e.kind === 'audiobook')
      const fromCache = audiobookCache.find(e =>
        bookId(e.track_title || '', e.track_artist || '') === id
      )
      if (fromCache) {
        setBook({
          id,
          title: fromCache.track_title || 'Unknown',
          author: fromCache.track_artist || '',
          cover: fromCache.albumCover || '',
          localFile: '',           // cache-only — no disk copy yet
          source: fromCache.source || '',
          format: prettyFormat(fromCache.local_file, fromCache.mime_type),
          // Surface the cache key so the Download endpoint can
          // pluck the streamUrl out of /api/cache without us
          // having to re-resolve through the addon.
          _cache_key: fromCache.key,
        })
      } else {
        setBook(null)
      }
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [id, apiKey, cacheVersion])

  // Chapters — pulled from ffprobe via the backend. Empty list when
  // the book has no embedded chapter metadata or no local file yet.
  // Re-fetches on cacheVersion bump so chapters extracted post-
  // download (ffprobe needs the file on disk) show up immediately.
  useEffect(() => {
    let cancelled = false
    if (!id) { setChapters([]); return }
    authFetch(`/api/audiobooks/library/${encodeURIComponent(id)}/chapters`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled) setChapters(d?.chapters || []) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [id, apiKey, cacheVersion])

  const refreshBookmarks = () => {
    if (!id) return
    authFetch(`/api/audiobooks/library/${encodeURIComponent(id)}/bookmarks`)
      .then(r => r.ok ? r.json() : null)
      .then(d => setBookmarks(d?.bookmarks || []))
      .catch(() => {})
  }
  useEffect(() => {
    if (!id) { setBookmarks([]); return }
    refreshBookmarks()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, apiKey])

  // No selected book — render nothing. The detail view is always
  // mounted (App.jsx uses display: contents/none routing), so we
  // can't bounce here — that would set state during render and
  // loop. The user reaches this surface only via openAudiobookDetail,
  // which sets both id and view together.
  if (!id) return null

  if (loading) {
    return (
      <div className={styles.wrap}>
        <div className={styles.empty}>Loading…</div>
      </div>
    )
  }
  if (!book) {
    return (
      <div className={styles.wrap}>
        <div className={styles.breadcrumb}>
          <button
            type="button"
            className={styles.backBtn}
            onClick={() => setView('audiobooks')}
            aria-label="Back to audiobooks"
          >←</button>
          <span className={styles.breadcrumbLabel}>Audiobooks</span>
        </div>
        <div className={styles.empty}>Audiobook not found.</div>
      </div>
    )
  }

  const pos = positions[book.id] || 0
  const dur = durations[book.id] || 0
  const pct = dur > 0 ? pos / dur : 0
  const remaining = dur > 0 ? Math.max(0, dur - pos) : 0
  const hasSingleFileProgress = pct > 0.005 && pct < 0.95
  // Multifile books store position per chapter; aggregate to decide
  // whether Resume vs Play. We also use this in the chapter list to
  // mark earlier chapters as played when the user is on chapter N+1.
  const hasMultifileProgress = chapters.some(c => c.multifile && (positions[`${id}|ch${c.index}`] || 0) > 1)
  const hasProgress = hasSingleFileProgress || hasMultifileProgress

  // Map current playback position → chapter index.
  //   • Multi-file: the queue carries one track per chapter, so the
  //     active chapter is whichever bookKey matches `${id}|ch${i}`.
  //   • Embedded chapters: pos is the offset inside the single file;
  //     scan each chapter's [start_s, end_s) window.
  const activeChapterIdx = (() => {
    if (!chapters.length) return -1
    if (chapters.some(c => c.multifile)) {
      const bk = currentTrack?.bookKey || ''
      const m = /\|ch(\d+)$/.exec(bk)
      if (m && bk.startsWith(`${book?.id}|`)) {
        const idx = chapters.findIndex(c => c.index === Number(m[1]))
        if (idx >= 0) return idx
      }
      return -1
    }
    if (!hasProgress) return 0
    for (let i = 0; i < chapters.length; i++) {
      const c = chapters[i]
      if (pos >= c.start_s && pos < c.end_s) return i
    }
    return chapters.length - 1
  })()

  // Multi-file books have one audio file per chapter — clicks open
  // that chapter's file via ?ch=N and queue the rest for auto-
  // advance. Embedded-chapter books (M4B with chpl markers) all
  // share one stream and we just seek inside it.
  const isMultifile = chapters.some(c => c.multifile)

  const buildMultifileQueue = (startIdx) => {
    return chapters.slice(startIdx).map(ch => ({
      title: `${ch.title}`,
      artist: book.title,                 // "now playing" reads as Chapter X • Book Title
      albumCover: book.cover || null,
      streamUrl: `/api/audiobooks/library/${book.id}/stream?ch=${ch.index}`,
      source: 'Library',
      isAudiobook: true,
      // Per-chapter resume: each file gets its own bookKey so the
      // player's audiobookPositions map saves position independently.
      bookKey: `${book.id}|ch${ch.index}`,
    }))
  }

  // Compute the absolute position-in-book for the bookmark API.
  // Single-file: store.progress is already the absolute time.
  // Multi-file: each chapter file has its own currentTime, so add
  //   the active chapter's start_s offset to get cumulative time.
  const currentBookPosition = () => {
    if (!isPlayingThisBook) return 0
    if (chapters.some(c => c.multifile)) {
      const m = /\|ch(\d+)$/.exec(currentTrack?.bookKey || '')
      const ch = m ? chapters.find(c => c.index === Number(m[1])) : null
      return (ch?.start_s || 0) + (progress || 0)
    }
    return progress || 0
  }

  const addBookmark = async () => {
    if (!isPlayingThisBook) {
      showToast('Start playback first — bookmarks save the current position')
      return
    }
    const pos = currentBookPosition()
    const ch = activeChapterIdx >= 0 ? chapters[activeChapterIdx] : null
    const title = await useStore.getState().askPrompt({
      title: 'Bookmark this moment',
      initial: ch?.title || `${Math.floor(pos / 60)}m`,
      placeholder: 'Bookmark name',
      confirmLabel: 'Save',
    })
    if (title === null) return // user cancelled
    try {
      const r = await authFetch(`/api/audiobooks/library/${encodeURIComponent(id)}/bookmarks`, {
        method: 'POST',
        body: JSON.stringify({
          position_s: pos,
          chapter_index: ch?.index || null,
          title: (title || '').trim(),
        }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      refreshBookmarks()
      showToast(`Bookmarked at ${fmtTotal(Math.floor(pos))}`)
    } catch (e) {
      showToast(`Bookmark failed: ${e.message || e}`)
    }
  }

  const deleteBookmark = async (bookmark) => {
    try {
      await authFetch(`/api/audiobooks/library/${encodeURIComponent(id)}/bookmarks/${bookmark.id}`, {
        method: 'DELETE',
      })
      refreshBookmarks()
    } catch {}
  }

  // Jump to a bookmark. Single-file: seek inside the loaded book.
  // Multi-file: figure out which chapter contains the position and
  // play that file from the offset within it.
  const jumpToBookmark = (bookmark) => {
    const pos = bookmark.position_s
    if (chapters.some(c => c.multifile)) {
      const ch = chapters.find(c => pos >= c.start_s && pos < c.end_s) || chapters[0]
      const offset = Math.max(0, pos - (ch?.start_s || 0))
      const startIdx = chapters.findIndex(c => c.index === ch.index)
      const tail = buildMultifileQueue(startIdx)
      const [head, ...rest] = tail
      const headWithOffset = { ...head, streamStartOffset: offset }
      useStore.getState().loadQueue([headWithOffset, ...rest], 0, false)
      showToast(`▶ ${ch.title}`)
      return
    }
    if (isPlayingThisBook) {
      seekTo(pos)
      return
    }
    if (book.localFile) {
      const streamUrl = `/api/audiobooks/library/${book.id}/stream`
      playNow({
        title: book.title,
        artist: book.author || 'Audiobook',
        albumCover: book.cover || null,
        streamUrl,
        source: 'Library',
        isAudiobook: true,
        bookKey: book.id,
        streamStartOffset: pos,
      })
      showToast(`▶ ${book.title}`)
    }
  }

  const playChapter = (chapter) => {
    if (!book.localFile) {
      setView('audiobooks')
      showToast('Open from Audiobooks to start the download')
      return
    }
    if (isMultifile) {
      const startIdx = chapters.findIndex(c => c.index === chapter.index)
      const tail = buildMultifileQueue(startIdx)
      const head = tail[0]
      // Use loadQueue to atomically replace the queue with the
      // chapter list. Auto-advance through `ended` events handles
      // chapter-to-chapter transitions; player resume per bookKey.
      useStore.getState().loadQueue(tail, 0, false)
      showToast(`▶ ${head.title}`)
      return
    }
    // Embedded-chapter book — single file, seek within it.
    if (isPlayingThisBook) {
      seekTo(chapter.start_s)
      return
    }
    const streamUrl = `/api/audiobooks/library/${book.id}/stream`
    playNow({
      title: book.title,
      artist: book.author || 'Audiobook',
      albumCover: book.cover || null,
      streamUrl,
      source: 'Library',
      isAudiobook: true,
      bookKey: book.id,
      streamStartOffset: chapter.start_s,
    })
    showToast(`▶ ${chapter.title}`)
  }

  const resume = async () => {
    // Cache-only book (no local file yet) — resolve through the
    // cache so we play via the addon's stream URL. The user can
    // still hit Download to promote to disk in parallel.
    if (!book.localFile) {
      const ck = book._cache_key
      if (!ck) {
        setView('audiobooks')
        showToast('No source on file — start playback from search')
        return
      }
      try {
        const resolved = await resolveCacheEntry({ key: ck, apiKey })
        if (!resolved?.streamUrl) {
          showToast('Could not resolve a stream URL — addon may be offline')
          return
        }
        playNow({
          title: book.title,
          artist: book.author || 'Audiobook',
          albumCover: book.cover || null,
          streamUrl: resolved.streamUrl,
          source: resolved.source || book.source || 'Audiobook',
          isAudiobook: true,
          bookKey: id,
        })
        showToast(`▶ ${book.title}`)
      } catch (e) {
        showToast(`Could not play: ${e.message || e}`)
      }
      return
    }
    // Multi-file: resume on whichever chapter has the most progress
    // (any non-zero position) — or chapter 1 if nothing's been
    // played. Then queue the rest from there for auto-advance.
    if (isMultifile) {
      const positions = useStore.getState().audiobookPositions || {}
      let resumeIdx = 0
      for (let i = chapters.length - 1; i >= 0; i--) {
        const ck = `${book.id}|ch${chapters[i].index}`
        if ((positions[ck] || 0) > 1) { resumeIdx = i; break }
      }
      const tail = buildMultifileQueue(resumeIdx)
      useStore.getState().loadQueue(tail, 0, false)
      showToast(`▶ ${tail[0].title}`)
      return
    }
    // Single-file: reuse the existing playNow flow.
    const streamUrl = `/api/audiobooks/library/${book.id}/stream`
    playNow({
      title: book.title,
      artist: book.author || 'Audiobook',
      albumCover: book.cover || null,
      streamUrl,
      source: 'Library',
      isAudiobook: true,
      bookKey: book.id,
    })
    showToast(`▶ ${book.title}`)
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.breadcrumb}>
        <button
          type="button"
          className={styles.backBtn}
          onClick={() => setView('audiobooks')}
          aria-label="Back to audiobooks"
        >←</button>
        <span className={styles.breadcrumbLabel}>Audiobooks</span>
      </div>

      <header className={styles.hero}>
        <div className={styles.cover}>
          {book.cover
            ? <img src={book.cover} alt="" />
            : <Monogram text={book.author || book.title} />}
        </div>
        <div className={styles.meta}>
          <div className={styles.kind}>Audiobook</div>
          <h1 className={styles.title}>{book.title}</h1>
          {book.author && <div className={styles.author}>{book.author}</div>}

          {dur > 0 && (
            <div className={styles.progressLine}>
              {hasProgress ? (
                <>
                  <div className={styles.progressBar}>
                    <div className={styles.progressFill} style={{ width: `${(pct * 100).toFixed(1)}%` }} />
                  </div>
                  <div className={styles.progressMeta}>
                    {Math.round(pct * 100)}% · {fmtTimeRemaining(remaining)} · {fmtTotal(dur)} total
                  </div>
                </>
              ) : (
                <div className={styles.progressMeta}>{fmtTotal(dur)} total</div>
              )}
            </div>
          )}

          <div className={styles.actions}>
            <button
              type="button"
              className={`${styles.actionBtn} ${styles.actionBtnPrimary}`}
              onClick={resume}
            >
              <span aria-hidden="true">▶</span>
              {hasProgress ? ' Resume' : ' Play'}
            </button>
            <button
              type="button"
              className={styles.actionBtn}
              onClick={addBookmark}
              title={isPlayingThisBook
                ? 'Save the current playback position'
                : 'Start playback first — bookmarks save where you are right now'}
              disabled={!isPlayingThisBook}
            >
              <span aria-hidden="true">⌾</span> Bookmark
            </button>
            {!book.localFile && (
              <button
                type="button"
                className={styles.actionBtn}
                onClick={async () => {
                  try {
                    // Cache-only books don't have an audiobook_library
                    // row yet. The download endpoint requires one, so
                    // promote the cache entry into a real library row
                    // first. Idempotent — POSTing the same id is a
                    // no-op upsert in the backend.
                    if (book._cache_key) {
                      await authFetch('/api/audiobooks/library', {
                        method: 'POST',
                        body: JSON.stringify({
                          id,
                          title: book.title,
                          author: book.author || '',
                          cover: book.cover || '',
                          format: book.format || '',
                        }),
                      })
                    }
                    const r = await authFetch(`/api/audiobooks/library/${encodeURIComponent(id)}/download`, {
                      method: 'POST',
                      body: JSON.stringify({}),
                    })
                    if (!r.ok) {
                      const j = await r.json().catch(() => ({}))
                      throw new Error(j.detail || `HTTP ${r.status}`)
                    }
                    showToast('Download started')
                  } catch (e) {
                    showToast(`Download failed: ${e.message || e}`)
                  }
                }}
                disabled={!!downloadJob && (downloadJob.status === 'pending' || downloadJob.status === 'downloading')}
                title="Save a local copy for offline playback"
              >
                <span aria-hidden="true">↓</span>
                {downloadJob && downloadJob.status === 'downloading'
                  ? ` ${Math.round(downloadJob.pct)}%`
                  : downloadJob?.status === 'pending'
                    ? ' Queued…'
                    : ' Download'}
              </button>
            )}
            {book.localFile && aaiEnabled && (
              <button
                type="button"
                className={styles.actionBtn}
                onClick={async () => {
                  // AssemblyAI processes audio at ~10× real-time
                  // (varies by queue depth). For a Xh book that's
                  // roughly X*6 minutes of wall-clock. Surface the
                  // estimate so the user can decide whether to wait.
                  // dur lives on the player-progress duration ref,
                  // not on book.duration, so we read it from the
                  // closure-captured `dur` set near the hero.
                  const seconds = dur || 0
                  const estMins = seconds > 0
                    ? Math.max(1, Math.round((seconds / 60) / 10))
                    : 0
                  const human = estMins >= 60
                    ? `~${Math.round(estMins / 60)}h ${estMins % 60}m`
                    : `~${estMins}m`
                  if (estMins > 5) {
                    // AssemblyAI billing: ~$0.27/hr of audio. Surface
                    // the cost estimate alongside wall time so the
                    // user knows what they're spending.
                    const hours = Math.max(0, Math.round((seconds / 3600) * 10) / 10)
                    const estCost = hours > 0 ? `~$${(hours * 0.27).toFixed(2)}` : 'pennies'
                    const ok = await askConfirm({
                      title: 'Detect chapters with AssemblyAI?',
                      message:
                        `Estimated wall time: ${human} ` +
                        `(audio length ÷ ~10× processing speed).\n` +
                        `Estimated cost: ${estCost} on your AssemblyAI account.\n\n` +
                        `Detection runs in the background — you can keep using Audimo.`,
                      confirmLabel: 'Detect chapters',
                      cancelLabel: 'Cancel',
                    })
                    if (!ok) return
                  }
                  try {
                    const r = await authFetch(`/api/audiobooks/library/${encodeURIComponent(id)}/detect-chapters`, {
                      method: 'POST',
                    })
                    if (!r.ok) {
                      const j = await r.json().catch(() => ({}))
                      throw new Error(j.detail || `HTTP ${r.status}`)
                    }
                    showToast(`Detecting chapters with AssemblyAI · est. ${human}`, 5000)
                  } catch (e) {
                    showToast(`Detection failed: ${e.message || e}`)
                  }
                }}
                disabled={!!detectJob && (detectJob.status === 'pending' || detectJob.status === 'downloading')}
                title="Use AssemblyAI to find chapter boundaries in this audiobook"
              >
                <span aria-hidden="true">⌁</span>
                {detectJob && detectJob.status === 'downloading'
                  ? ' Detecting…'
                  : detectJob?.status === 'pending'
                    ? ' Queued…'
                    : chapters.length > 0
                      ? ' Re-detect chapters'
                      : ' Detect chapters'}
              </button>
            )}
          </div>
          {detectJob && (detectJob.status === 'downloading' || detectJob.status === 'pending') && (
            <div className={styles.progressLine} style={{ marginTop: 12 }}>
              {/* Detection phases reflected in detectJob.label —
                  Uploading…, Queuing transcript…, AssemblyAI: queued/
                  processing… (Ns). Bytes progress shows during upload;
                  indeterminate bar after that since AAI's queue +
                  transcribe phases don't expose granular progress. */}
              {detectJob.bytes_total > 0 && detectJob.label?.startsWith('Uploading') ? (
                <div className={styles.progressBar}>
                  <div className={styles.progressFill} style={{ width: `${detectJob.pct}%` }} />
                </div>
              ) : (
                <div className={styles.progressBar}>
                  <div className={styles.progressFill} style={{ width: '100%', opacity: 0.4 }} />
                </div>
              )}
              <div className={styles.progressMeta}>
                {detectJob.label || 'Detecting chapters…'}
                {detectJob.bytes_total > 0 && detectJob.label?.startsWith('Uploading') && (
                  <> · {fmtBytes(detectJob.bytes_done)} / {fmtBytes(detectJob.bytes_total)}</>
                )}
              </div>
            </div>
          )}
          {detectJob?.status === 'error' && (
            <div className={styles.progressMeta} style={{ color: 'var(--red)', marginTop: 8 }}>
              Detection failed: {detectJob.error || 'unknown error'}
            </div>
          )}
          {downloadJob && (downloadJob.status === 'downloading' || downloadJob.status === 'pending') && (
            <div className={styles.progressLine} style={{ marginTop: 12 }}>
              <div className={styles.progressBar}>
                <div className={styles.progressFill} style={{ width: `${downloadJob.pct}%` }} />
              </div>
              <div className={styles.progressMeta}>
                Downloading · {Math.round(downloadJob.pct)}%
                {downloadJob.bytes_total > 0 && (
                  <> · {fmtBytes(downloadJob.bytes_done)} / {fmtBytes(downloadJob.bytes_total)}</>
                )}
              </div>
            </div>
          )}
          {downloadJob?.status === 'error' && (
            <div className={styles.progressMeta} style={{ color: 'var(--red)', marginTop: 8 }}>
              Download failed: {downloadJob.error || 'unknown error'}
            </div>
          )}
        </div>
      </header>

      {/* Bookmarks render above chapters — saved positions are the
          thing the user wants to jump back to immediately, while the
          full chapter list is a deeper scroll. */}
      {bookmarks.length > 0 && (
        <section className={styles.section}>
          <div className={styles.sectionLabel}>
            {bookmarks.length} {bookmarks.length === 1 ? 'bookmark' : 'bookmarks'}
          </div>
          {/* Sorted by audio position (asc), not creation time, so the
              list reads left-to-right through the book. Users scanning
              for "where did I drop that note" find it where they'd
              expect rather than at the top of a reverse-chrono list. */}
          <ul className={styles.bookmarkList}>
            {[...bookmarks].sort((a, b) => (a.position_s || 0) - (b.position_s || 0)).map(bm => (
              <li key={bm.id} className={styles.bookmarkItem}>
                <button
                  type="button"
                  className={styles.bookmarkRow}
                  onClick={() => jumpToBookmark(bm)}
                >
                  <span className={styles.bookmarkTime}>{fmtTotal(Math.floor(bm.position_s))}</span>
                  <span className={styles.bookmarkTitle}>
                    {bm.title || (bm.chapter_index ? `Chapter ${bm.chapter_index}` : 'Bookmark')}
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.bookmarkDelete}
                  onClick={() => deleteBookmark(bm)}
                  title="Remove bookmark"
                  aria-label="Remove bookmark"
                >✕</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* No chapters AND no local file: chapter metadata is embedded
          inside the audio file (ffprobe needs the bytes on disk), so
          stream-only / debrid-backed books can't expose chapters
          until they're downloaded. Surface this so the user doesn't
          assume the book is unstructured. */}
      {chapters.length === 0 && book && !book.localFile && (
        <section className={styles.section}>
          <div className={styles.sectionLabel}>Chapters</div>
          <p className={styles.aboutBody}>
            Chapter markers become available once this book is downloaded —
            they're embedded in the audio file, not the source feed.
          </p>
        </section>
      )}

      {chapters.length > 0 && (
        <section className={styles.section}>
          <div className={styles.sectionLabel}>
            {chapters.length} {chapters.length === 1 ? 'chapter' : 'chapters'}
          </div>
          <ol className={styles.chapterList}>
            {chapters.map((ch, i) => {
              const len = Math.max(0, ch.end_s - ch.start_s)
              const isActive = i === activeChapterIdx
              const wasPlayed = activeChapterIdx >= 0 && i < activeChapterIdx
              return (
                <li key={ch.index} className={styles.chapterItem}>
                  <button
                    type="button"
                    className={`${styles.chapterRow} ${isActive ? styles.chapterRowActive : ''} ${wasPlayed ? styles.chapterRowPlayed : ''}`}
                    onClick={() => playChapter(ch)}
                  >
                    <span className={styles.chapterIdx}>
                      {String(ch.index).padStart(2, '0')}
                    </span>
                    <span className={styles.chapterTitle}>{ch.title}</span>
                    {len > 0 && (
                      <span className={styles.chapterLen}>{fmtTotal(len)}</span>
                    )}
                    <span className={styles.chapterIcon} aria-hidden="true">
                      {isActive ? '▶' : wasPlayed ? '✓' : ''}
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
        </section>
      )}

      {book.about && (
        <section className={styles.section}>
          <div className={styles.sectionLabel}>About</div>
          <p className={styles.aboutBody}>{book.about}</p>
        </section>
      )}

      <section className={styles.section}>
        <div className={styles.sectionLabel}>Source</div>
        <dl className={styles.metaGrid}>
          {book.format && (<>
            <dt className={styles.metaKey}>Format</dt>
            <dd className={styles.metaVal}>{book.format}</dd>
          </>)}
          {book.size && (<>
            <dt className={styles.metaKey}>Size</dt>
            <dd className={styles.metaVal}>{book.size}</dd>
          </>)}
          {/* Local copy path used to render here — verbose and never
              actionable. Replaced by the Reveal in Finder button up
              top once that lands on the audiobook detail page. */}
          {Array.isArray(book.categories) && book.categories.length > 0 && (<>
            <dt className={styles.metaKey}>Categories</dt>
            <dd className={styles.metaVal}>{book.categories.join(' · ')}</dd>
          </>)}
        </dl>
      </section>
    </div>
  )
}
