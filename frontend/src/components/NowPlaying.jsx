import { useState, useEffect, useRef } from 'react'
import { useStore } from '../store'
import { authFetch } from '../api'
import { formatSec, formatHMS } from '../utils'
import Monogram from './Monogram'
import Icon from './Icon'
import MobileSheet from './MobileSheet'
import styles from './NowPlaying.module.css'

// Linkify plain-text URLs in podcast show notes. Mirrors the regex in
// PodcastDetailView so feed descriptions render the same way in both
// places. Never uses dangerouslySetInnerHTML — XSS-safe even on
// malicious feeds.
const URL_RE = /https?:\/\/[^\s<>()]+[^\s<>().,;:!?]/g
function linkifyText(text) {
  if (!text) return null
  const out = []
  let lastIdx = 0
  let m
  let key = 0
  while ((m = URL_RE.exec(text)) !== null) {
    if (m.index > lastIdx) out.push(text.slice(lastIdx, m.index))
    out.push(<a key={key++} href={m[0]} target="_blank" rel="noreferrer noopener">{m[0]}</a>)
    lastIdx = m.index + m[0].length
  }
  if (lastIdx < text.length) out.push(text.slice(lastIdx))
  return out
}

function fmtEpochDate(epoch) {
  if (!epoch) return ''
  const d = new Date(epoch * 1000)
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

// Stable bookKey-to-bookId: callers stamp `bookKey` on audiobook
// tracks. Strip any trailing chapter qualifier (`<id>|<ch>`) — the
// chapters endpoint wants the book id alone.
function bookIdFromTrack(track) {
  const k = track?.bookKey || ''
  const pipe = k.indexOf('|')
  return pipe > 0 ? k.slice(0, pipe) : k
}

// Full-bleed Now Playing surface. Two layouts share state:
//
//   • Desktop (≥ 900px): 3-column overlay — art + audio metadata on
//     the left, lyrics/credits/about tabs in the middle, up-next +
//     similar on the right. Opens when the user clicks the mini-
//     player's track tag.
//
//   • Mobile (< 900px): single-column bottom sheet with swipe-down
//     to dismiss. Opens when the user taps the mini-player.
//
// We pick the layout from `window.innerWidth` at mount and on every
// resize crossing the 900px boundary. No SSR concerns here — Audimo
// is client-only.

const DESKTOP_BREAKPOINT = 900

// `window.__forceMobile` is the same testing override that
// useIsMobile honors — when set, NowPlaying picks the mobile
// sheet regardless of the real viewport. Used by the Chrome-MCP
// mobile-emulation harness.
function readIsDesktop() {
  if (typeof window === 'undefined') return true
  if (window.__forceMobile === true) return false
  if (window.__forceMobile === false) return true
  return window.innerWidth >= DESKTOP_BREAKPOINT
}

function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(readIsDesktop)
  useEffect(() => {
    const onResize = () => setIsDesktop(readIsDesktop())
    window.addEventListener('resize', onResize)
    window.addEventListener('forcemobilechange', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('forcemobilechange', onResize)
    }
  }, [])
  return isDesktop
}

export default function NowPlaying() {
  const isDesktop = useIsDesktop()
  const { nowPlayingExpanded } = useStore()
  if (!nowPlayingExpanded) return null
  return isDesktop ? <NowPlayingDesktop /> : <NowPlayingMobile />
}

// ─── Desktop 3-column overlay ────────────────────────────────────
function NowPlayingDesktop() {
  const {
    currentTrack: track, isPlaying, setIsPlaying,
    queueIdx, queue, setQueueIdx, nextIdx, prevIdx,
    setNowPlayingExpanded, setView,
    progress, duration, seekTo,
    addons,
  } = useStore()

  const [tab, setTab] = useState('lyrics')
  const barRef = useRef(null)

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') setNowPlayingExpanded(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [setNowPlayingExpanded])

  if (!track) {
    setNowPlayingExpanded(false)
    return null
  }

  const togglePlay = () => setIsPlaying(!isPlaying)
  const next = () => { const n = nextIdx(); if (n >= 0) setQueueIdx(n) }
  const prev = () => {
    const p = prevIdx()
    if (p !== queueIdx) setQueueIdx(p)
  }
  const onScrub = (e) => {
    const bar = barRef.current
    if (!bar || !duration) return
    const rect = bar.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    seekTo(pct * duration)
  }

  const isLongForm = !!track.isAudiobook || !!track.podcastEpisodeId
  const fmt = isLongForm ? formatHMS : formatSec
  const pct = duration ? Math.max(0, Math.min(100, (progress / duration) * 100)) : 0

  // Up next derived from queue. Skip the currently-playing index.
  // Audiobooks ignore queue UI — books are standalone, not playlists.
  const upNext = (queueIdx >= 0 ? queue.slice(queueIdx + 1) : queue).slice(0, 8)

  // Audio meta — best-effort extraction from the track payload.
  // Long-form audio hides bitrate/format trivia; the user cares about
  // chapter / show notes instead.
  const audioMeta = isLongForm ? [] : audioMetaFor(track)

  // Lyrics-addon presence drives the lyrics tab's call-to-action.
  const hasLyricsAddon = (addons || []).some(a =>
    a.enabled !== false && (a.manifest?.capabilities || []).includes('lyrics.fetch')
  )

  // Header label + secondary line per media type.
  const kindLabel = track.isAudiobook
    ? 'AUDIOBOOK'
    : track.podcastEpisodeId
      ? `PODCAST${track.publishedAt ? ` · ${fmtEpochDate(track.publishedAt).toUpperCase()}` : ''}`
      : `TRACK${track.album ? ` · ${track.album}` : ''}`
  const secondaryLine = track.isAudiobook
    ? (track.artist || '—')   // author
    : track.podcastEpisodeId
      ? (track.artist || '—') // show name
      : (track.artist || '—') // music artist

  return (
    <div className={styles.dRoot}>
      <header className={styles.dHead}>
        <div className={styles.dPlayingFrom}>
          NOW PLAYING{track.source ? ` · FROM ${String(track.source).toUpperCase()}` : ''}
        </div>
        <button
          type="button"
          className={styles.dCloseBtn}
          onClick={() => setNowPlayingExpanded(false)}
          title="Minimize (Esc)"
        >
          <span aria-hidden="true">▾</span>
          <span className={styles.dCloseLabel}>Minimize</span>
        </button>
      </header>

      <div className={styles.dCols}>
        {/* LEFT: hero (art + meta + transport + audio metadata) */}
        <div className={styles.dLeft}>
          <div className={styles.dArtWrap}>
            {track.albumCover
              ? <img src={track.albumCover} alt="" className={styles.dArt} />
              : <div className={styles.dArtFallback}>
                  <Monogram text={track.artist || track.title} />
                </div>}
          </div>
          <div className={styles.dMeta}>
            <div className={styles.dKind}>{kindLabel}</div>
            <h1 className={styles.dTitle}>{track.title || 'Unknown'}</h1>
            <div className={styles.dArtist}>{secondaryLine}</div>
          </div>

          {/* Scrubber */}
          <div className={styles.dScrub}>
            <span className={styles.dTime}>{fmt(progress || 0)}</span>
            <div ref={barRef} className={styles.dScrubBar} onClick={onScrub}>
              <div className={styles.dScrubFill} style={{ width: `${pct}%` }} />
            </div>
            <span className={styles.dTime}>{fmt(duration || 0)}</span>
          </div>

          {/* Transport */}
          <div className={styles.dCtrls}>
            <button className={styles.dCtrlBtn} onClick={prev} disabled={!track}>⏮</button>
            <button
              className={`${styles.dCtrlBtn} ${styles.dPlayBtn}`}
              onClick={togglePlay}
              disabled={!track}
              aria-label={isPlaying ? 'Pause' : 'Play'}
            >{isPlaying ? '⏸' : '▶'}</button>
            <button className={styles.dCtrlBtn} onClick={next} disabled={!track}>⏭</button>
          </div>

          {audioMeta.length > 0 && (
            <div className={styles.dAudio}>
              <div className={styles.dSectionLabel}>Audio · this stream</div>
              <dl className={styles.dAudioGrid}>
                {audioMeta.map(([k, v]) => (
                  <div key={k} className={styles.dAudioRow}>
                    <dt className={styles.dAudioKey}>{k}</dt>
                    <dd className={styles.dAudioVal}>{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </div>

        {/* RIGHT: media-type-specific panels. Music keeps lyrics/credits
            /about + up next. Audiobook swaps in a chapter list and
            drops the queue (books are standalone). Podcast swaps in
            show notes and keeps a queue. */}
        <div className={styles.dRight}>
          {track.isAudiobook ? (
            <AudiobookRightDesktop
              track={track}
              progress={progress}
              seekTo={seekTo}
              setIsPlaying={setIsPlaying}
            />
          ) : track.podcastEpisodeId ? (
            <PodcastRightDesktop
              track={track}
              upNext={upNext}
              queueIdx={queueIdx}
              setQueueIdx={setQueueIdx}
              setView={setView}
              setNowPlayingExpanded={setNowPlayingExpanded}
            />
          ) : (
            <MusicRightDesktop
              track={track}
              hasLyricsAddon={hasLyricsAddon}
              upNext={upNext}
              queueIdx={queueIdx}
              setQueueIdx={setQueueIdx}
              setView={setView}
              setNowPlayingExpanded={setNowPlayingExpanded}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Music: lyrics stub (addon-deferred) + Up next ────────────────
//
// Pre-0.4 this surface had three tabs: Lyrics / Credits / About — all
// three were stubs with placeholder copy. A new user opening Now
// Playing for the first time clicked through three empty panels.
// Collapsed to Lyrics-only with the addon CTA in 0.4; Credits and
// About come back when a metadata addon ships.
function MusicRightDesktop({ track, hasLyricsAddon, upNext, queueIdx, setQueueIdx, setView, setNowPlayingExpanded }) {
  return (
    <>
      <section className={styles.dPanel}>
        <div className={styles.dSectionLabel}>Lyrics</div>
        <div className={styles.dTabBody}>
          <Stub
            title="No synced lyrics yet"
            body={
              hasLyricsAddon
                ? "A lyrics addon is installed but hasn't supplied a match for this track. Try a different one — the lookup runs per-track."
                : 'Synced lyrics arrive via a lyrics addon. Once installed, lines will highlight in time with playback.'
            }
            action={hasLyricsAddon ? null : { label: 'Browse addons →', onClick: () => { setView('addons'); setNowPlayingExpanded(false) } }}
          />
        </div>
      </section>

      <section className={styles.dPanel}>
        <div className={styles.dRightHead}>
          <span className={styles.dSectionLabel}>Up next</span>
          <button
            type="button"
            className={styles.dRightAction}
            onClick={() => { setView('queue'); setNowPlayingExpanded(false) }}
          >See all →</button>
        </div>
        {upNext.length === 0 ? (
          <div className={styles.dEmpty}>Nothing queued after this track.</div>
        ) : (
          upNext.map((q, i) => (
            <button
              key={`up-${queueIdx + 1 + i}`}
              type="button"
              className={styles.dQueueRow}
              onClick={() => setQueueIdx(queueIdx + 1 + i)}
            >
              <div className={styles.dQueueThumb}>
                {q.albumCover
                  ? <img src={q.albumCover} alt="" />
                  : <Monogram text={q.artist || q.title} />}
              </div>
              <div className={styles.dQueueMeta}>
                <div className={styles.dQueueTitle}>{q.title || 'Unknown'}</div>
                <div className={styles.dQueueSub}>{q.artist || '—'}</div>
              </div>
            </button>
          ))
        )}
      </section>
    </>
  )
}

// ─── Audiobook: chapter list (no queue) ────────────────────────────
function AudiobookRightDesktop({ track, progress, seekTo, setIsPlaying }) {
  const [chapters, setChapters] = useState([])
  const bookId = bookIdFromTrack(track)
  useEffect(() => {
    if (!bookId) { setChapters([]); return }
    let cancelled = false
    authFetch(`/api/audiobooks/library/${encodeURIComponent(bookId)}/chapters`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled) setChapters(d?.chapters || []) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [bookId])

  // The chapter the user is currently inside — strictly the latest
  // chapter whose start_s is ≤ progress. We compare against the
  // streaming offset world (Player.jsx tracks progress in stream
  // time, with chapter-per-stream restarts at 0). The audiobook's
  // chapter list is stored in absolute seconds from book start; for
  // a per-chapter stream we can't pinpoint without knowing the
  // current chapter index, so fall back to "no highlight" when
  // ambiguous. Whole-file streams (progress in absolute seconds)
  // highlight correctly.
  const activeIdx = chapters.findIndex((c, i) => {
    const next = chapters[i + 1]
    return progress >= (c.start_s || 0) && (!next || progress < (next.start_s || Infinity))
  })

  const onChapter = (ch) => {
    // Seek inside the current stream if it spans the whole book;
    // chapter-per-stream books need a fresh load (a future task).
    if (typeof ch.start_s === 'number') {
      seekTo(ch.start_s)
      setIsPlaying(true)
    }
  }

  return (
    <section className={styles.dPanel}>
      <div className={styles.dRightHead}>
        <span className={styles.dSectionLabel}>
          Chapters{chapters.length ? ` · ${chapters.length}` : ''}
        </span>
      </div>
      {chapters.length === 0 ? (
        <div className={styles.dEmpty}>
          No chapter markers for this book yet. Run "Detect chapters" on the book's detail page to populate.
        </div>
      ) : (
        chapters.map((ch, i) => (
          <button
            key={`ch-${i}`}
            type="button"
            className={`${styles.dQueueRow} ${i === activeIdx ? styles.dRowActive : ''}`}
            onClick={() => onChapter(ch)}
            title={typeof ch.start_s === 'number' ? `Jump to ${formatHMS(ch.start_s)}` : ''}
          >
            <div className={styles.dQueueMeta}>
              <div className={styles.dQueueTitle}>
                {String(i + 1).padStart(2, '0')} · {ch.title || `Chapter ${i + 1}`}
              </div>
              <div className={styles.dQueueSub}>
                {typeof ch.start_s === 'number' ? formatHMS(ch.start_s) : '—'}
              </div>
            </div>
          </button>
        ))
      )}
    </section>
  )
}

// ─── Podcast: show notes + Up next ─────────────────────────────────
function PodcastRightDesktop({ track, upNext, queueIdx, setQueueIdx, setView, setNowPlayingExpanded }) {
  const desc = track.episodeDescription || ''
  return (
    <>
      <section className={styles.dPanel}>
        <div className={styles.dRightHead}>
          <span className={styles.dSectionLabel}>Episode notes</span>
        </div>
        {desc ? (
          <p className={styles.dPodcastNotes}>{linkifyText(desc)}</p>
        ) : (
          <Stub
            title="No episode notes"
            body="This episode's feed didn't include show notes. Some podcasts publish them on their website instead."
          />
        )}
      </section>

      <section className={styles.dPanel}>
        <div className={styles.dRightHead}>
          <span className={styles.dSectionLabel}>Up next</span>
          <button
            type="button"
            className={styles.dRightAction}
            onClick={() => { setView('queue'); setNowPlayingExpanded(false) }}
          >See all →</button>
        </div>
        {upNext.length === 0 ? (
          <div className={styles.dEmpty}>Nothing queued after this episode.</div>
        ) : (
          upNext.map((q, i) => (
            <button
              key={`up-${queueIdx + 1 + i}`}
              type="button"
              className={styles.dQueueRow}
              onClick={() => setQueueIdx(queueIdx + 1 + i)}
            >
              <div className={styles.dQueueThumb}>
                {q.albumCover
                  ? <img src={q.albumCover} alt="" />
                  : <Monogram text={q.artist || q.title} />}
              </div>
              <div className={styles.dQueueMeta}>
                <div className={styles.dQueueTitle}>{q.title || 'Unknown'}</div>
                <div className={styles.dQueueSub}>{q.artist || '—'}</div>
              </div>
            </button>
          ))
        )}
      </section>
    </>
  )
}

function Stub({ title, body, action }) {
  return (
    <div className={styles.dStub}>
      <h2 className={styles.dStubTitle}>{title}</h2>
      <p className={styles.dStubBody}>{body}</p>
      {action && (
        <button type="button" className={styles.dStubAction} onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  )
}

function audioMetaFor(track) {
  const out = []
  // Source — addon name or generic label
  if (track.source) out.push(['Source', String(track.source)])
  // Mime / format — derive a friendlier label
  const mime = track.mimeType || track.mime_type
  if (mime) {
    const fmt = mime.includes('flac') ? 'FLAC'
      : mime.includes('mpeg') ? 'MP3'
      : mime.includes('ogg') ? 'OGG'
      : mime.includes('wav') ? 'WAV'
      : mime.includes('aac') || mime.includes('mp4') ? 'AAC/M4A'
      : mime
    out.push(['Format', fmt])
  }
  if (track.bitrate) out.push(['Bitrate', track.bitrate])
  if (track.releaseGroup) out.push(['Release group', track.releaseGroup])
  return out
}

// ─── Mobile bottom sheet ─────────────────────────────────────────
// Rebuilt in Phase 3 — proper icon controls (no text "prev/play/
// next"), visible scrubber thumb, Queue access via a stacked
// sheet, and an overflow `⋯` menu for save/playlist/artist/album.
function NowPlayingMobile() {
  const {
    currentTrack: track, isPlaying, setIsPlaying,
    queueIdx, setQueueIdx, queue, nextIdx, prevIdx,
    setNowPlayingExpanded, setView,
    playlists, addTrackToPlaylist, createPlaylist, showToast,
  } = useStore()
  // Subscribed separately because progress + duration tick every
  // ~250ms during playback and we want the rest of the destructure
  // to stay stable across renders (otherwise every play-tick
  // re-runs the entire body).
  const progress = useStore(s => s.progress)
  const duration = useStore(s => s.duration)
  const seekTo = useStore(s => s.seekTo)

  const [dragPct, setDragPct] = useState(null)
  const barRef = useRef(null)
  const [pullY, setPullY] = useState(0)
  const touchStartYRef = useRef(null)
  // Local sheet state — Queue list (taps jump to queue index),
  // overflow menu (save/playlist/artist/album/…), and the
  // playlist-picker sub-sheet that the overflow menu opens.
  // All stacked above NowPlaying via MobileSheet z-index: 1200.
  const [queueOpen, setQueueOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [playlistPickerOpen, setPlaylistPickerOpen] = useState(false)
  const [newPlName, setNewPlName] = useState('')

  if (!track) {
    setNowPlayingExpanded(false)
    return null
  }

  const togglePlay = () => setIsPlaying(!isPlaying)
  const next = () => { const n = nextIdx(); if (n >= 0) setQueueIdx(n) }
  const prev = () => {
    const p = prevIdx()
    if (p !== queueIdx) setQueueIdx(p)
  }
  const isLongForm = !!(track?.isAudiobook || track?.podcastEpisodeId)
  const skipBy = (deltaS) => {
    if (typeof duration !== 'number' || duration <= 0) return
    seekTo(Math.max(0, Math.min(duration - 1, (progress || 0) + deltaS)))
  }

  const pctFromEvent = (e) => {
    const bar = barRef.current
    if (!bar) return 0
    const rect = bar.getBoundingClientRect()
    const x = (e.touches?.[0]?.clientX ?? e.clientX) - rect.left
    return Math.max(0, Math.min(1, x / rect.width))
  }
  const onScrubDown = (e) => {
    e.preventDefault()
    const pct = pctFromEvent(e)
    setDragPct(pct)
    if (e.pointerId != null) e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onScrubMove = (e) => { if (dragPct != null) setDragPct(pctFromEvent(e)) }
  const onScrubUp = () => {
    if (dragPct == null || !duration) { setDragPct(null); return }
    seekTo(dragPct * duration)
    setDragPct(null)
  }

  // Swipe-down on the sheet header dismisses NowPlaying. We attach
  // these only to .topBar / .meta so the gesture doesn't fight
  // with the scrubber's horizontal drag or the queue button.
  const onTouchStart = (e) => {
    if (e.touches.length !== 1) return
    touchStartYRef.current = e.touches[0].clientY
    setPullY(0)
  }
  const onTouchMove = (e) => {
    if (touchStartYRef.current == null) return
    const dy = e.touches[0].clientY - touchStartYRef.current
    if (dy > 0) setPullY(Math.min(dy, 240))
  }
  const onTouchEnd = () => {
    if (touchStartYRef.current == null) return
    const finalY = pullY
    touchStartYRef.current = null
    setPullY(0)
    if (finalY > 100) setNowPlayingExpanded(false)
  }

  // Horizontal swipe on the album art = prev / next. Attached to
  // the artWrap so the swipe-down dismiss above doesn't have to
  // disambiguate the gesture direction (different element, no
  // overlap). 60px threshold + 2:1 horizontal:vertical ratio
  // distinguishes "I want to change track" from "I'm starting to
  // scroll." Long-form audiobook / podcast skips by ±15/30s
  // instead of changing track — matches the visible button row.
  const artSwipeRef = useRef(null)
  const artSwipe = {
    onTouchStart: (e) => {
      if (e.touches.length !== 1) return
      artSwipeRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
    },
    onTouchMove: (e) => {
      const s = artSwipeRef.current
      if (!s) return
      s.lastX = e.touches[0].clientX
      s.lastY = e.touches[0].clientY
    },
    onTouchEnd: () => {
      const s = artSwipeRef.current
      artSwipeRef.current = null
      if (!s || s.lastX == null) return
      const dx = s.lastX - s.x
      const dy = (s.lastY ?? s.y) - s.y
      if (Math.abs(dx) < 60) return
      if (Math.abs(dx) < Math.abs(dy) * 2) return
      // Left-swipe (negative dx) → forward; right-swipe → backward,
      // matching native iOS music app and most other players.
      if (dx < 0) {
        if (isLongForm) skipBy(30); else next()
      } else {
        if (isLongForm) skipBy(-15); else prev()
      }
    },
    onTouchCancel: () => { artSwipeRef.current = null },
  }

  const liveProgress = dragPct != null && duration ? dragPct * duration : progress
  const pct = duration ? Math.max(0, Math.min(100, (liveProgress / duration) * 100)) : 0
  const fmtTime = isLongForm ? formatHMS : formatSec

  const upNext = (queueIdx >= 0 ? queue.slice(queueIdx + 1) : queue).slice(0, 50)

  const goView = (v) => { setMenuOpen(false); setNowPlayingExpanded(false); setView(v) }

  return (
    <div
      className={styles.root}
      style={pullY ? { transform: `translateY(${pullY}px)`, transition: 'none' } : undefined}
    >
      <div
        className={styles.grabber}
        aria-hidden="true"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
      />
      <div
        className={styles.topBar}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
      >
        <button
          className={styles.collapseBtn}
          onClick={() => setNowPlayingExpanded(false)}
          aria-label="Collapse"
          type="button"
        >
          <Icon name="chevD" size={24} />
        </button>
        <span className={styles.playingFrom}>now playing</span>
        <button
          className={styles.collapseBtn}
          onClick={() => setMenuOpen(true)}
          aria-label="More"
          type="button"
        >
          <Icon name="dot3" size={24} />
        </button>
      </div>

      <div
        className={styles.artWrap}
        onTouchStart={artSwipe.onTouchStart}
        onTouchMove={artSwipe.onTouchMove}
        onTouchEnd={artSwipe.onTouchEnd}
        onTouchCancel={artSwipe.onTouchCancel}
      >
        {track.albumCover
          ? <img src={track.albumCover} alt="" className={styles.art} />
          : <div className={styles.artFallback}><Monogram text={track.artist || track.title} /></div>}
      </div>

      <div className={styles.meta}>
        <h1 className={styles.title}>{track.title || 'Unknown'}</h1>
        <div className={styles.artist}>{track.artist || '—'}</div>
      </div>

      <div
        ref={barRef}
        className={[styles.scrubber, dragPct != null ? styles.scrubberActive : ''].join(' ')}
        onPointerDown={onScrubDown}
        onPointerMove={onScrubMove}
        onPointerUp={onScrubUp}
        onPointerCancel={onScrubUp}
      >
        <div className={styles.scrubberTrack}>
          <div className={styles.scrubberFill} style={{ width: `${pct}%` }} />
          <div className={styles.scrubberThumb} style={{ left: `${pct}%` }} />
        </div>
        <div className={styles.scrubberTimes}>
          <span>{fmtTime(liveProgress)}</span>
          <span>{fmtTime(duration || 0)}</span>
        </div>
      </div>

      <div className={styles.controls}>
        {isLongForm ? (
          <button
            className={styles.skipBtn}
            onClick={() => skipBy(-15)}
            disabled={!track}
            aria-label="Skip back 15 seconds"
            type="button"
          >
            <span className={styles.skipLabel}>-15</span>
          </button>
        ) : (
          <button
            className={styles.ctrlBtn}
            onClick={prev}
            disabled={!track}
            aria-label="Previous"
            type="button"
          >
            <Icon name="prev" size={24} />
          </button>
        )}
        <button
          className={styles.playBtn}
          onClick={togglePlay}
          disabled={!track}
          aria-label={isPlaying ? 'Pause' : 'Play'}
          type="button"
        >
          <Icon name={isPlaying ? 'pause' : 'play'} size={28} />
        </button>
        {isLongForm ? (
          <button
            className={styles.skipBtn}
            onClick={() => skipBy(30)}
            disabled={!track}
            aria-label="Skip forward 30 seconds"
            type="button"
          >
            <span className={styles.skipLabel}>+30</span>
          </button>
        ) : (
          <button
            className={styles.ctrlBtn}
            onClick={next}
            disabled={!track}
            aria-label="Next"
            type="button"
          >
            <Icon name="next" size={24} />
          </button>
        )}
      </div>

      <button
        type="button"
        className={styles.queueBtn}
        onClick={() => setQueueOpen(true)}
        aria-label="Open queue"
      >
        <Icon name="queue" size={18} />
        <span>Queue</span>
        {queueIdx >= 0 && queue.length > 0 && (
          <span className={styles.queuePosTxt}>{queueIdx + 1} of {queue.length}</span>
        )}
      </button>

      <MobileSheet open={queueOpen} onClose={() => setQueueOpen(false)} title="Up next">
        <ul className={styles.queueList}>
          {upNext.length === 0 && (
            <li className={styles.queueEmpty}>Nothing queued up after this track.</li>
          )}
          {upNext.map((q, i) => (
            <li key={`${q.key || q.id || i}-${i}`}>
              <button
                type="button"
                className={styles.queueRow}
                onClick={() => { setQueueIdx(queueIdx + 1 + i); setQueueOpen(false) }}
              >
                <div className={styles.queueRowThumb}>
                  {q.albumCover
                    ? <img src={q.albumCover} alt="" />
                    : <Monogram text={q.artist || q.title} />}
                </div>
                <div className={styles.queueRowMeta}>
                  <div className={styles.queueRowTitle}>{q.title || 'Unknown'}</div>
                  <div className={styles.queueRowSub}>{q.artist || '—'}</div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </MobileSheet>

      <MobileSheet open={menuOpen} onClose={() => setMenuOpen(false)} title={track.title || 'Track'}>
        <ul className={styles.menuList}>
          <li>
            <button type="button" className={styles.menuRow} onClick={() => goView('library')}>
              <Icon name="library" size={20} />
              <span>View in library</span>
            </button>
          </li>
          <li>
            <button
              type="button"
              className={styles.menuRow}
              onClick={() => { setMenuOpen(false); setPlaylistPickerOpen(true) }}
            >
              <Icon name="list" size={20} />
              <span>Add to playlist</span>
            </button>
          </li>
          <li>
            <button type="button" className={styles.menuRow} onClick={() => goView('queue')}>
              <Icon name="queue" size={20} />
              <span>Open queue</span>
            </button>
          </li>
        </ul>
      </MobileSheet>

      {/* Playlist picker sub-sheet — opens from the overflow menu's
          "Add to playlist" row. Tapping a playlist adds the current
          track to it and dismisses. Inline "New playlist…" input at
          the bottom keeps creation in the same flow. */}
      <MobileSheet
        open={playlistPickerOpen}
        onClose={() => { setPlaylistPickerOpen(false); setNewPlName('') }}
        title="Add to playlist"
      >
        <ul className={styles.menuList}>
          {(playlists || []).map(p => (
            <li key={p.id}>
              <button
                type="button"
                className={styles.menuRow}
                onClick={() => {
                  addTrackToPlaylist(p.id, {
                    title: track.title, artist: track.artist, album: track.album,
                    albumCover: track.albumCover, streamUrl: track.streamUrl,
                    cache_key: track.cache_key, duration: track.duration,
                  })
                  showToast?.(`Added to "${p.name}"`)
                  setPlaylistPickerOpen(false)
                }}
              >
                <Icon name="list" size={20} />
                <span>{p.name}</span>
              </button>
            </li>
          ))}
          {(playlists || []).length === 0 && (
            <li className={styles.menuEmpty}>No playlists yet — create one below.</li>
          )}
        </ul>
        <div className={styles.menuFooter}>
          <input
            className={styles.menuNewInput}
            type="text"
            placeholder="New playlist name…"
            value={newPlName}
            onChange={(e) => setNewPlName(e.target.value)}
            autoCapitalize="words"
          />
          <button
            type="button"
            className={styles.menuNewBtn}
            disabled={!newPlName.trim()}
            onClick={() => {
              const name = newPlName.trim()
              if (!name) return
              const pid = createPlaylist(name)
              if (pid) {
                addTrackToPlaylist(pid, {
                  title: track.title, artist: track.artist, album: track.album,
                  albumCover: track.albumCover, streamUrl: track.streamUrl,
                  cache_key: track.cache_key, duration: track.duration,
                })
                showToast?.(`Added to "${name}"`)
              }
              setNewPlName('')
              setPlaylistPickerOpen(false)
            }}
          >Create + add</button>
        </div>
      </MobileSheet>
    </div>
  )
}
