import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { authFetch, resolveCacheEntry, apiUrl } from '../api'
import { formatSec, formatHMS } from '../utils'
import { KEYBINDINGS } from '../shortcuts'
import Monogram from './Monogram'
import Icon from './Icon'
import styles from './Player.module.css'

// Audiobook playback speeds. 1.0 is the default; the design exposes
// 0.75–2.0 in 0.25 steps with one extra at 1.75 (audiobook standard).
const SPEED_OPTIONS = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0]

// Sleep-timer presets in minutes. `'eoc'` = end of current chapter —
// without chapter metadata that maps to "end of current file" (the
// audio element's `ended` event), so it falls through to the same
// pause behavior the natural end of a book triggers.
//
// 15 leads instead of 10: a 10-minute sleep is shorter than most
// users actually want when they reach for the timer, and putting it
// first set the wrong "default" expectation on a popover the user
// is glancing at while drowsy.
const SLEEP_OPTIONS = [15, 30, 45, 60, 'eoc']

// Treat `waiting` / `stalled` events as a stream stall after this
// many ms with no `playing` resumption. Long enough that a normal
// rebuffer (network blip, slow seek) doesn't trigger; short enough
// that a dead stream URL doesn't silently hang forever.
//
// 60s. Was 45s — torrent streams freshly bootstrapped through DHT
// can take 30-40s of "waiting" before the first piece arrives, and
// some slow CDNs (cold-cache regional edges) push past 45s without
// being dead. 60s is "this stream is meaningfully broken, not just
// slow", with a soft-warning toast at the halfway mark so users
// know the watchdog is still ticking rather than wondering whether
// the app froze.
const STALL_TIMEOUT_MS = 60000
const STALL_WARN_MS = 30000

export default function Player() {
  const {
    queue, queueIdx, setQueueIdx, isPlaying, setIsPlaying,
    currentTrack, shuffle, setShuffle, nextIdx, prevIdx, logPlay,
    repeatMode, cycleRepeatMode,
    apiKey, updateQueueItem, playSeq, setNowPlayingExpanded,
    setProgress: setStoreProgress, seekRequest, seekTarget,
    showToast, audiobookPositions, setAudiobookPosition, setAudiobookDuration,
    crossfadeSec, outputDeviceId,
  } = useStore()

  // Stable per-book key: callers (AudiobooksView) stamp `bookKey` on
  // the track. Falls back to streamUrl for ad-hoc plays (e.g. a
  // search result that hasn't been added to the library yet).
  const audiobookKey = (t) => t?.bookKey || t?.streamUrl || ''

  // Per-track resume positions for audiobooks live in
  // `audiobookPositions[streamUrl]`. On every track change we re-arm
  // `pendingResumeRef` from the saved position for THAT track — that
  // way switching between two audiobooks doesn't blend their
  // scrubber positions. `onLoadedMetadata` consumes (and clears) the
  // pending value once the audio element knows its duration.
  const pendingResumeRef = useRef(0)
  // Throttle for heartbeat saves — once per 5s.
  const lastResumeSaveRef = useRef(0)
  // ListenBrainz scrobble — fires once per track-play after the user
  // has played past the threshold (>50% or 4 min). Cleared when a new
  // track loads. Backend silently no-ops if the user hasn't pasted a
  // ListenBrainz token, so this fires unconditionally.
  const scrobbledRef = useRef(false)
  const scrobbleStartedAtRef = useRef(0)
  // True until the first track load completes. When the user reloads
  // the app, we want the persisted currentTrack to appear in the
  // player ready to go, but paused — they didn't click play, so we
  // shouldn't auto-resume audio. Cleared once any explicit playNow /
  // setQueueIdx fires inside the session.
  const bootRestoreRef = useRef(true)

  // Mini-bar swipe gesture — pulling up on the trackInfo region
  // opens the NowPlaying surface, matching the native iOS music
  // player. Movement budget is generous (>40px and >2x horizontal
  // delta) so a horizontal scroll over the bar doesn't accidentally
  // open NowPlaying. The handlers live inside the component so they
  // can read setNowPlayingExpanded from the destructure above.
  const miniTouchRef = useRef(null)
  const miniSwipe = {
    onTouchStart: (e) => {
      if (e.touches.length !== 1) return
      miniTouchRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() }
    },
    onTouchMove: (e) => {
      // Nothing to track mid-gesture; we only care about start vs end.
      if (!miniTouchRef.current) return
      const t = e.touches[0]
      // Cancel pending tap if the finger has wandered far — we treat
      // any meaningful drag as a gesture, not a tap.
      miniTouchRef.current.lastX = t.clientX
      miniTouchRef.current.lastY = t.clientY
    },
    onTouchEnd: () => {
      const s = miniTouchRef.current
      miniTouchRef.current = null
      if (!s) return
      const dx = (s.lastX ?? s.x) - s.x
      const dy = (s.lastY ?? s.y) - s.y
      const upward = -dy
      // Up-swipe ≥ 40px AND mostly-vertical AND under 600ms = open.
      if (upward >= 40 && Math.abs(dx) < upward && Date.now() - s.t < 600) {
        if (currentTrack) setNowPlayingExpanded(true)
      }
    },
    onTouchCancel: () => { miniTouchRef.current = null },
  }

  const audioARef = useRef(null)
  const audioBRef = useRef(null)
  const activeRef = useRef('a')           // which element is active
  const activeUrlRef = useRef(null)       // URL currently playing (guards against double-load)
  const preloadedUrlRef = useRef(null)    // URL buffered in the inactive element
  const crossfading = useRef(false)
  const rafRef = useRef(null)
  const volumeRef = useRef(0.8)
  const prevVolRef = useRef(0.8)
  const isPlayingRef = useRef(false)
  // Suppresses the spurious `pause` DOM event that fires when we swap
  // the active element's `src` mid-playback. Without this, onPause
  // sets isPlaying=false, the isPlaying-sync effect calls pause(),
  // and the new track's play() rejects with AbortError. (Reproduces
  // when you go from a playing library track straight into a new
  // SourcePicker pick.)
  const loadingTrackRef = useRef(false)
  // Stall watchdog: armed by `waiting`/`stalled`, disarmed by
  // `playing` / src change. If it fires, the stream is treated as
  // dead and we skip to the next queued track.
  const stallTimerRef = useRef(null)
  const stallWarnTimerRef = useRef(null)
  // Stream URLs we've already attempted a force-resolve retry on.
  // Prevents an infinite re-resolve loop when the upstream source is
  // genuinely dead. A fresh force-resolve produces a new URL not in
  // this set, so retries are re-armed across sessions automatically.
  const forceRetriedUrlsRef = useRef(new Set())
  // Tracks that the watchdog gave up on AND there's nothing left to
  // auto-retry. The player chrome shows a "Retry now" button when
  // this is set — clicking it pops the URL out of forceRetriedUrlsRef
  // and reloads. Audit found that without an escape hatch, a slow
  // but live stream that tripped the timeout once got stuck unplayable
  // for the rest of the session.
  const [stalledKey, setStalledKey] = useState(null)

  const [progress, setProgress] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(0.8)
  const [showShortcuts, setShowShortcuts] = useState(false)
  // Auto-download polling cache: avoid hitting /api/settings on
  // every track change. Refreshed on `cacheVersion` bumps + once a
  // minute (so toggling the Settings switch propagates without a
  // full page refresh).
  const autoDownloadEnabledRef = useRef(false)
  useEffect(() => {
    let cancelled = false
    const refresh = () => authFetch('/api/settings/auto_download')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled && d) autoDownloadEnabledRef.current = !!d.enabled })
      .catch(() => {})
    refresh()
    const id = setInterval(refresh, 60_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])
  // In-flight download dedup so a track that gets paused + resumed
  // doesn't fire two POSTs to the same key.
  const autoDownloadFiredRef = useRef(new Set())
  const autoDownloadIfEnabled = (cacheKey) => {
    if (!autoDownloadEnabledRef.current) return
    if (!cacheKey) return
    if (autoDownloadFiredRef.current.has(cacheKey)) return
    autoDownloadFiredRef.current.add(cacheKey)
    authFetch(`/api/cache/${encodeURIComponent(cacheKey)}/download`, {
      method: 'POST',
      body: JSON.stringify({}),
    }).catch(() => {
      // Network blip — let the next track-change retry by
      // dropping this key from the dedup set.
      autoDownloadFiredRef.current.delete(cacheKey)
    })
  }

  // Audiobook-only controls. `bookSpeed` mirrors HTMLAudioElement
  // `.playbackRate` for both A/B elements — applied via effect so
  // crossfade swaps and src= reloads don't reset to 1.0.
  const [bookSpeed, setBookSpeed] = useState(1.0)
  // `sleepDeadline` is an absolute ms timestamp for minute-based
  // presets; `'eoc'` means "stop on the next `ended` event"; null is
  // disabled. Stored as one variable so the rendering code can show a
  // countdown for minute-mode and a static label for EOC.
  const [sleepDeadline, setSleepDeadline] = useState(null)
  const [sleepShown, setSleepShown] = useState(null) // for re-render tick
  const [sleepMenuOpen, setSleepMenuOpen] = useState(false)
  const sleepWrapRef = useRef(null)
  // Speed popover (mirror of the sleep-timer popover). Previously the
  // speed pill was a cycle button: each click bumped to the next of 6
  // presets, so going from 1× to 2× took 5 clicks. Popover gets the
  // user to any preset in one click.
  const [speedMenuOpen, setSpeedMenuOpen] = useState(false)
  const speedWrapRef = useRef(null)
  // True when the audio element is fetching data we're waiting on:
  // the initial track src= load before metadata arrives, or a
  // mid-playback `waiting`/`stalled` event. Cleared by `playing` /
  // `pause` / track change. Drives the spinner on the play button.
  const [isBuffering, setIsBuffering] = useState(false)
  // Human-readable label shown in place of the artist line while
  // loading: "Re-resolving source…", "Connecting…", "Buffering 23%".
  // Empty string when nothing's loading. Drives the spinner caption.
  const [loadingStatus, setLoadingStatus] = useState('')

  // Crossfade duration in seconds. Stored in the Zustand store
  // (persisted) and configured in Settings → Playback. Was previously
  // a local-state pill in the player chrome.
  const cfDuration = Number.isFinite(crossfadeSec) ? crossfadeSec : 0

  useEffect(() => { volumeRef.current = volume }, [volume])
  useEffect(() => { isPlayingRef.current = isPlaying }, [isPlaying])

  // Apply audiobook speed to both audio elements. We do this on every
  // render where either element exists so that a fresh src= load (which
  // resets playbackRate to 1.0) is corrected on the next tick.
  useEffect(() => {
    const a = audioARef.current
    const b = audioBRef.current
    if (a) a.playbackRate = bookSpeed
    if (b) b.playbackRate = bookSpeed
  })

  // Sleep timer. For minute presets we re-render every second to show
  // a countdown and pause when the deadline passes. For 'eoc' we just
  // wait for the audio element's `ended` event handler — which already
  // calls our `next()` — to land, and pause then.
  //
  // Volume fade-out: in the last 30s we taper the active element's
  // volume linearly toward zero so the user isn't jolted awake by a
  // sudden cut. The slider isn't touched; we only nudge the element's
  // playback volume. Volume is restored on pause/cancel.
  const SLEEP_FADE_MS = 30000
  useEffect(() => {
    if (typeof sleepDeadline !== 'number') {
      setSleepShown(sleepDeadline) // forwards 'eoc' or null for label
      return
    }
    const tick = () => {
      const remaining = sleepDeadline - Date.now()
      if (remaining <= 0) {
        const a = getActive()
        if (a) a.pause()
        setIsPlaying(false)
        setSleepDeadline(null)
        setSleepShown(null)
        // Restore the element volume so a re-play after the sleep
        // ends doesn't start at near-zero.
        const a2 = getActive()
        if (a2) a2.volume = volumeRef.current
        showToast('Sleep timer reached. Paused.', 4000)
        return
      }
      setSleepShown(remaining)
      // Linear fade ramp during the final SLEEP_FADE_MS. Above that
      // window we leave volume at the slider's level (volumeRef).
      const a = getActive()
      if (a) {
        if (remaining < SLEEP_FADE_MS) {
          const f = Math.max(0, remaining / SLEEP_FADE_MS)
          a.volume = Math.max(0, Math.min(1, volumeRef.current * f))
        } else {
          a.volume = volumeRef.current
        }
      }
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => {
      clearInterval(id)
      // Cancel path: user disabled the timer. Snap volume back so
      // they aren't stuck at 30%-of-slider until next track change.
      const a = getActive()
      if (a) a.volume = volumeRef.current
    }
  }, [sleepDeadline]) // eslint-disable-line react-hooks/exhaustive-deps

  // Click-outside-to-close for the sleep menu popover.
  useEffect(() => {
    if (!sleepMenuOpen) return
    const onPointer = (e) => {
      if (!sleepWrapRef.current?.contains(e.target)) setSleepMenuOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setSleepMenuOpen(false) }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [sleepMenuOpen])

  // Click-outside-to-close for the speed menu popover.
  useEffect(() => {
    if (!speedMenuOpen) return
    const onPointer = (e) => {
      if (!speedWrapRef.current?.contains(e.target)) setSpeedMenuOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setSpeedMenuOpen(false) }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [speedMenuOpen])

  // Long-form playback controls (speed + sleep timer) apply to both
  // Long-form controls. Sleep timer is meaningful only for audiobooks
  // and podcasts — clear it when the user moves on to music. Speed
  // applies to all tracks: workout playlists at 1.25× are a real use
  // case, so we keep the user's chosen speed across mode switches
  // and just let them re-adjust if it carries over awkwardly.
  const isLongFormCurrent = !!currentTrack?.isAudiobook || !!currentTrack?.podcastEpisodeId
  useEffect(() => {
    if (!isLongFormCurrent) {
      setSleepDeadline(null)
      setSleepMenuOpen(false)
    }
  }, [isLongFormCurrent])

  const getActive = () => activeRef.current === 'a' ? audioARef.current : audioBRef.current
  const getInactive = () => activeRef.current === 'a' ? audioBRef.current : audioARef.current
  const swapActive = () => { activeRef.current = activeRef.current === 'a' ? 'b' : 'a' }

  const track = currentTrack

  // Load new track when URL changes (from playNow, setQueueIdx from UI, etc.)
  // Also re-fires when playSeq changes so an explicit playNow always restarts
  // even if the URL is already in the queue (e.g. same link re-resolved).
  useEffect(() => {
    if (!track?.streamUrl) return
    console.log('[Player.load] effect fire', {
      title: track.title,
      streamUrl: track.streamUrl,
      playSeq,
    })

    // Cancel any in-progress crossfade
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    crossfading.current = false

    // Clear inactive buffer
    const inactive = getInactive()
    if (inactive) { inactive.pause(); inactive.src = ''; inactive.volume = 0 }
    preloadedUrlRef.current = null

    // Load & play on active
    const active = getActive()
    if (!active) return
    activeUrlRef.current = track.streamUrl
    // Reset ListenBrainz scrobble state — every fresh track load gets
    // its own threshold counter. Avoids one play scrobbling its
    // predecessor.
    scrobbledRef.current = false
    scrobbleStartedAtRef.current = Math.floor(Date.now() / 1000)
    // Auto-download trigger — when the user has enabled
    // "Auto-download to disk" in Settings, kick off a background
    // download for ANY playable cache entry: music, audiobooks,
    // podcasts (anything with a cache_key). The backend's
    // /api/cache/{key}/download endpoint handles the type-specific
    // destination dir + post-download hooks. Fires once per
    // track-change; backend short-circuits for tracks already on
    // disk via the {already_local: true} response.
    if (track.cache_key || track.cacheKey) {
      autoDownloadIfEnabled(track.cache_key || track.cacheKey)
    }
    // Mark loading so the synchronous `pause` event from changing
    // src doesn't propagate to setIsPlaying(false).
    loadingTrackRef.current = true
    setIsBuffering(true)
    clearStall()
    // Arm the per-track resume for audiobooks. onLoadedMetadata reads
    // and clears this once <audio>.duration is known.
    if (track.isAudiobook) {
      // Transcoded streams are already pre-seeked server-side via
      // ffmpeg `-ss`; the audio element should NOT seek further or
      // we'd skip past `streamStartOffset` worth of audio.
      const saved = audiobookPositions?.[audiobookKey(track)] || 0
      pendingResumeRef.current = track.transcoded ? 0 : saved
    } else if (track.podcastEpisodeId && track.streamStartOffset > 0) {
      // Podcast resume: callers stamp streamStartOffset on the track
      // from the server-known position_s. Direct (non-transcoded)
      // streams seek client-side via onLoadedMetadata.
      pendingResumeRef.current = track.streamStartOffset
    } else {
      pendingResumeRef.current = 0
    }
    active.src = apiUrl(track.streamUrl)
    active.volume = volumeRef.current
    // Boot restore: when the app reopens with a persisted currentTrack,
    // load the source so it's queued in the player but stay paused —
    // the user didn't click play. Subsequent track changes (any
    // explicit playNow) auto-play as normal.
    if (bootRestoreRef.current) {
      bootRestoreRef.current = false
      loadingTrackRef.current = false
      setIsBuffering(false)
      setIsPlaying(false)
      logPlay(track)
      updateMediaSession(track)
      return
    }
    active.play()
      .then(() => { loadingTrackRef.current = false })
      .catch((err) => {
        loadingTrackRef.current = false
        // AbortError fires when src changes mid-load (we're already
        // moving on); ignore it. NotAllowedError = autoplay policy
        // blocked the resume — surface it so the user knows to click
        // play. Anything else is a real failure on this URL.
        if (err?.name === 'AbortError') return
        if (err?.name === 'NotAllowedError') {
          showToast('▶ Press play to start (autoplay was blocked)')
          return
        }
        // For audiobooks: auto-fallback to the server-side transcode
        // endpoint when the failure is a codec mismatch. ffmpeg pipes
        // 2-ch AAC, which always plays. Skip if we've already fallen
        // back, or if the track has no bookKey (no library row to
        // transcode against).
        if (track.isAudiobook) {
          const code = active?.error?.code
          if (code === 4 && !track.transcoded && track.bookKey) {
            const saved = audiobookPositions?.[audiobookKey(track)] || 0
            const url = `/api/audiobooks/library/${encodeURIComponent(track.bookKey)}/stream/transcoded?start=${saved}`
            showToast('Converting on the fly — codec unsupported, falling back to AAC', 5000)
            if (queueIdx >= 0) {
              updateQueueItem(queueIdx, { streamUrl: url, streamStartOffset: saved, transcoded: true })
            }
            return
          }
          const detail = code === 4
            ? 'unsupported codec (often E-AC3 / Dolby — re-encode to AAC or MP3 and re-import)'
            : 'see console for details'
          showToast(`❌ Couldn't play "${track.title || 'audiobook'}" — ${detail}`, 8000)
          setIsPlaying(false)
          return
        }
        // Non-codec failures on a cached track → try a fresh resolve
        // once before skipping. Same reasoning as the onError path.
        if (track?.cache_key || track?.cacheKey) {
          const failed = track
          tryForceResolve(failed).then((retried) => {
            if (retried) return
            showToast(`❌ Couldn't start "${failed.title || 'track'}" — skipping`)
            handleEnded()
          })
          return
        }
        showToast(`❌ Couldn't start "${track.title || 'track'}" — skipping`)
        handleEnded()
      })

    logPlay(track)
    updateMediaSession(track)
    setTimeout(preloadNext, 800)
  }, [track?.streamUrl, playSeq])

  // Stall watchdog helpers. Defined here so the makeHandlers closures
  // and the load effect both see the same timer ref.
  const clearStall = () => {
    if (stallTimerRef.current) {
      clearTimeout(stallTimerRef.current)
      stallTimerRef.current = null
    }
    if (stallWarnTimerRef.current) {
      clearTimeout(stallWarnTimerRef.current)
      stallWarnTimerRef.current = null
    }
  }
  const armStall = () => {
    if (stallTimerRef.current) return
    // Soft warning at the halfway mark — lets the user know the
    // watchdog is alive rather than wondering whether playback is
    // frozen. Auto-dismissed; doesn't block the timer firing.
    stallWarnTimerRef.current = setTimeout(() => {
      stallWarnTimerRef.current = null
      const a = getActive()
      if (a && !a.paused && a.readyState < 3) {
        showToast('Stream slow — still waiting…', { duration: 4000 })
      }
    }, STALL_WARN_MS)
    stallTimerRef.current = setTimeout(() => {
      stallTimerRef.current = null
      if (stallWarnTimerRef.current) {
        clearTimeout(stallWarnTimerRef.current)
        stallWarnTimerRef.current = null
      }
      // Confirm we're still actually stalled before bailing — a
      // late-arriving `playing` could have raced the timer.
      const a = getActive()
      if (a && !a.paused && a.readyState >= 3) return
      // User-initiated pause is not a stall. HTML5 audio keeps issuing
      // background range requests after pause; on a torrent stream
      // (127.0.0.1:11471) those can emit `waiting` once the libtorrent
      // engine throttles a cold peer, which would arm this watchdog.
      // Without this guard, pausing a torrent track for STALL_TIMEOUT_MS
      // used to auto-skip to the next queue item.
      if (a && a.paused) return
      // Stalled tracks with a cache_key get one force-resolve retry
      // before we give up — the most common cause is an expired CDN
      // link (debrid / yt-dlp extract) that needs fresh extraction.
      const stalled = track
      tryForceResolve(stalled).then((retried) => {
        if (retried) return
        // Don't skip silently — set the stalled flag so the player
        // chrome surfaces a "Retry now" affordance. The user can
        // also click Next/Prev to move on. Previously this called
        // handleEnded() unconditionally, which jumped to the next
        // queue item with no warning.
        const key = stalled?.streamUrl || stalled?.cache_key || stalled?.cacheKey || ''
        if (key) setStalledKey(key)
        showToast('Stream stalled — tap Retry on the player or skip', {
          kind: 'error',
        })
        // Pause the (still-buffering) element so it doesn't keep
        // hammering range requests against a dead URL.
        if (a) { try { a.pause() } catch {} }
        setIsBuffering(false)
        setIsPlaying(false)
      })
    }, STALL_TIMEOUT_MS)
  }
  // Cleanup on unmount.
  useEffect(() => () => clearStall(), [])

  // Output device picker. setSinkId is supported in Chromium-based
  // browsers and Tauri's WKWebView on macOS Sonoma+. Bail silently
  // on environments that don't expose it — the user's pick stays
  // saved and will activate next time. '' or 'default' both mean
  // "system default" (we pass undefined to skip the call entirely
  // when no specific device was picked).
  useEffect(() => {
    const apply = (a) => {
      if (!a || typeof a.setSinkId !== 'function') return
      const target = outputDeviceId || 'default'
      try {
        a.setSinkId(target).catch(() => {
          // Permission denied / device went away / etc. Don't toast
          // — playback continues on the previous sink.
        })
      } catch {}
    }
    apply(audioARef.current)
    apply(audioBRef.current)
  }, [outputDeviceId])

  // Clear the "stalled" flag whenever the active track changes —
  // navigating to a new song is itself the retry.
  useEffect(() => { setStalledKey(null) }, [track?.streamUrl])

  // Manual retry: clear the URL out of the auto-retried set so the
  // next stall arm gets a fresh attempt, drop the stalled flag, and
  // re-trigger play on the current element.
  const retryStalledTrack = () => {
    const url = track?.streamUrl
    if (url) forceRetriedUrlsRef.current.delete(url)
    setStalledKey(null)
    const a = getActive()
    if (!a) return
    try {
      // Reload the current src — bypasses any cached error state.
      // Touching .currentTime to a non-zero offset isn't necessary;
      // load() + play() is enough.
      a.load()
      a.play().catch(() => {})
      setIsPlaying(true)
    } catch {}
  }

  // Compute a "Buffering X%" or "Connecting…" string from the active
  // audio element's buffered ranges. % is buffered-end / duration when
  // both are known; otherwise we fall back to the byte-less
  // "Connecting…" so the user knows something is happening rather
  // than staring at a bare spinner.
  const computeBufferingLabel = () => {
    const a = getActive()
    if (!a) return 'Connecting…'
    const dur = a.duration
    try {
      if (a.buffered && a.buffered.length && isFinite(dur) && dur > 0) {
        const end = a.buffered.end(a.buffered.length - 1)
        const pct = Math.max(0, Math.min(100, Math.round((end / dur) * 100)))
        return `Buffering ${pct}%`
      }
    } catch {}
    return 'Connecting…'
  }

  // While buffering, refresh the % label every 500ms so the user
  // sees progress on a slow torrent / large audiobook. Stops once
  // isBuffering flips back to false (onPlaying / onCanPlay / pause).
  useEffect(() => {
    if (!isBuffering) {
      setLoadingStatus('')
      return
    }
    // Skip the tick while we're displaying a higher-priority status
    // (e.g. "Re-resolving source…") — only refresh if the current
    // label already looks like a buffering one or is empty.
    const isBufferingLabel = (s) => !s || s === 'Connecting…' || s.startsWith('Buffering')
    setLoadingStatus(prev => isBufferingLabel(prev) ? computeBufferingLabel() : prev)
    const id = setInterval(() => {
      setLoadingStatus(prev => isBufferingLabel(prev) ? computeBufferingLabel() : prev)
    }, 500)
    return () => clearInterval(id)
  }, [isBuffering])

  // Force-resolve the failing track once before giving up. Returns
  // true when a fresh URL was obtained and pushed into the queue
  // (which re-fires the load effect and retries playback); false when
  // there's nothing to retry (no cache key, already retried this URL,
  // resolve returned nothing) or the user moved on mid-resolve.
  const tryForceResolve = async (failedTrack) => {
    const cacheKey = failedTrack?.cache_key || failedTrack?.cacheKey
    if (!cacheKey) return false
    const failedUrl = failedTrack?.streamUrl || ''
    if (failedUrl && forceRetriedUrlsRef.current.has(failedUrl)) return false
    if (failedUrl) forceRetriedUrlsRef.current.add(failedUrl)
    const idxAtRetry = queueIdx
    const seqAtRetry = playSeq
    setLoadingStatus('Re-resolving source…')
    setIsBuffering(true)
    let resolved
    try {
      resolved = await resolveCacheEntry({ key: cacheKey, apiKey, force: true })
    } catch {
      return false
    }
    // Bail if the user switched tracks while we were resolving.
    const s = useStore.getState()
    if (s.playSeq !== seqAtRetry || s.queueIdx !== idxAtRetry) return false
    if (!resolved?.streamUrl) return false
    updateQueueItem(idxAtRetry, {
      streamUrl: resolved.streamUrl,
      source: resolved.source || failedTrack.source,
    })
    return true
  }

  // Re-buffer when queue changes (new track added, shuffle, etc.)
  useEffect(() => {
    if (track?.streamUrl) preloadNext()
  }, [queue.length, queueIdx, shuffle])

  // isPlaying sync
  useEffect(() => {
    const active = getActive()
    if (!active) return
    if (isPlaying) active.play().catch(() => {})
    else active.pause()
  }, [isPlaying])

  // Auto-resolve queued tracks that have no streamUrl yet.
  // Try cache first; if not cached, skip to the next track.
  useEffect(() => {
    if (!track || track.streamUrl) return
    let cancelled = false
    const skip = () => {
      if (cancelled) return
      const nextI = nextIdx()
      if (nextI >= 0) setQueueIdx(nextI)
      else setIsPlaying(false)
    }
    authFetch('/api/cache/check', {
      method: 'POST',
      body: JSON.stringify({ tracks: [{ title: track.title, artist: track.artist || '' }] }),
    })
      .then(r => r.json())
      .then(data => {
        if (cancelled) return
        const key = `${(track.artist || '').toLowerCase().trim()}|${(track.title || '').toLowerCase().trim()}`
        const entry = data.cached?.[key]
        if (!entry) { skip(); return }
        return resolveCacheEntry({ key: entry.cache_key, apiKey }).then(resolved => {
          if (cancelled) return
          if (resolved?.streamUrl) {
            updateQueueItem(queueIdx, { streamUrl: resolved.streamUrl, source: resolved.source })
          } else {
            skip()
          }
        })
      })
      .catch(skip)
    return () => { cancelled = true }
  }, [queueIdx, track?.streamUrl])

  // Volume sync
  useEffect(() => {
    const active = getActive()
    if (active && !crossfading.current) active.volume = volume
  }, [volume])

  // Apply external seek requests (e.g. mobile NowPlaying scrubber).
  // The store increments seekRequest on every call so this fires even
  // when the user seeks twice to the same target.
  useEffect(() => {
    if (seekRequest === 0) return
    const active = getActive()
    if (!active) return
    if (active.duration && isFinite(active.duration)) {
      active.currentTime = Math.min(seekTarget, active.duration)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekRequest])

  // Tracks the queue index whose streamUrl we're currently resolving so
  // a queue change mid-fetch doesn't double-write to the wrong row.
  const preloadResolvingIdxRef = useRef(-1)

  const preloadNext = async () => {
    const nextI = nextIdx()
    if (nextI < 0) return
    const nextTrack = queue[nextI]
    if (!nextTrack) return

    // Eager resolve: tracks queued from My Library / album playback
    // carry a cache_key but no streamUrl. Resolving here (instead of
    // waiting until the track becomes active) lets the inactive
    // element start buffering well before the transition, so handoff
    // is gapless. No-op for tracks that already have a streamUrl.
    let streamUrl = nextTrack.streamUrl
    if (!streamUrl) {
      if (preloadResolvingIdxRef.current === nextI) return
      preloadResolvingIdxRef.current = nextI
      try {
        const r = await authFetch('/api/cache/check', {
          method: 'POST',
          body: JSON.stringify({ tracks: [{ title: nextTrack.title, artist: nextTrack.artist || '' }] }),
        })
        const data = await r.json()
        const k = `${(nextTrack.artist || '').toLowerCase().trim()}|${(nextTrack.title || '').toLowerCase().trim()}`
        const entry = data.cached?.[k]
        if (!entry) return
        const resolved = await resolveCacheEntry({ key: entry.cache_key, apiKey })
        if (!resolved?.streamUrl) return
        // Bail if the queue shifted under us while we were resolving.
        if (queue[nextI]?.title !== nextTrack.title || queue[nextI]?.artist !== nextTrack.artist) return
        streamUrl = resolved.streamUrl
        updateQueueItem(nextI, { streamUrl, source: resolved.source })
      } catch {
        return
      } finally {
        preloadResolvingIdxRef.current = -1
      }
    }

    if (streamUrl === preloadedUrlRef.current) return
    if (streamUrl === activeUrlRef.current) return
    const inactive = getInactive()
    if (!inactive) return
    inactive.pause()
    inactive.src = apiUrl(streamUrl)
    inactive.volume = 0
    inactive.preload = 'auto'
    preloadedUrlRef.current = streamUrl
  }

  const handleTimeUpdate = () => {
    const active = getActive()
    if (!active) return
    setProgress(active.currentTime)
    setDuration(active.duration || 0)
    // Mirror to the store so the mobile NowPlaying scrubber stays in
    // sync without binding to the DOM directly.
    setStoreProgress(active.currentTime, active.duration || 0)
    // Heartbeat-save resume position — audiobooks only. The user
    // doesn't want music tracks to remember position; only long-form
    // audio (audiobooks) gets the resume affordance.
    // timeupdate fires ~4×/s; persist middleware writes localStorage
    // on every set(), so throttle to once every 5s.
    if (track?.isAudiobook) {
      const key = audiobookKey(track)
      if (key) {
        const now = Date.now()
        if (now - lastResumeSaveRef.current >= 5000) {
          lastResumeSaveRef.current = now
          // For server-side transcoded streams ffmpeg has already
          // seeked to streamStartOffset, so the audio element's
          // currentTime is relative to that. Add the offset back so
          // we persist the absolute position in the original file.
          const abs = (track.streamStartOffset || 0) + active.currentTime
          setAudiobookPosition(key, abs)
        }
      }
    } else if (track?.podcastEpisodeId) {
      // Podcast progress heartbeat. Same 5s throttle as audiobooks
      // (sharing lastResumeSaveRef is fine — the two are mutually
      // exclusive on a given track). State lives server-side, not in
      // a Zustand map, so the body view in PodcastDetailView can
      // reflect it after a refresh.
      const now = Date.now()
      if (now - lastResumeSaveRef.current >= 5000) {
        lastResumeSaveRef.current = now
        authFetch(`/api/podcasts/episodes/${encodeURIComponent(track.podcastEpisodeId)}/progress`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            position_s: active.currentTime,
            duration_s: Number.isFinite(active.duration) ? Math.floor(active.duration) : 0,
          }),
        }).catch(() => {})
      }
    }
    // Scrobble + local-history threshold. Spec for both: fire once
    // per play, the moment the user crosses >50% or 4 minutes
    // (whichever comes first). Music goes to ListenBrainz; both music
    // and audiobooks log to local history (Today's Recently Played
    // list, the History view, and stats all read from it).
    if (!scrobbledRef.current && track?.title && active.duration > 0) {
      const threshold = Math.min(active.duration * 0.5, 240)
      if (active.currentTime >= threshold) {
        scrobbledRef.current = true
        if (!track.isAudiobook) {
          authFetch('/api/listens/submit', {
            method: 'POST',
            body: JSON.stringify({
              title: track.title,
              artist: track.artist || '',
              album: track.album || track.track_album || '',
              mbid: track.mbid || '',
              listened_at: scrobbleStartedAtRef.current || undefined,
            }),
          }).catch(() => {})
        }
        // Use wall-clock seconds since play started, not active.currentTime.
        // For audiobook resumes, currentTime begins at the saved position
        // (often hours into the book), so logging it inflated weekly
        // stats — a single resume could record "3 hours listened" the
        // instant the threshold tripped. Clamp to the track's duration
        // so a forward seek doesn't lie upward.
        const elapsed = Math.max(0, Math.floor(Date.now() / 1000 - (scrobbleStartedAtRef.current || 0)))
        const maxDur = Number.isFinite(active.duration) ? Math.floor(active.duration) : elapsed
        authFetch('/api/history/log', {
          method: 'POST',
          body: JSON.stringify({
            title: track.title,
            artist: track.artist || '',
            album: track.album || track.track_album || '',
            album_cover: track.albumCover || track.album_cover || '',
            source: track.source || '',
            addon_id: track.addon_id || track.addonId || '',
            kind: track.isAudiobook ? 'audiobook' : 'music',
            duration_played_s: Math.min(elapsed, maxDur),
          }),
        }).catch(() => {})
      }
    }

    // Trigger crossfade near end
    if (!crossfading.current && cfDuration > 0 && active.duration > 0) {
      const remaining = active.duration - active.currentTime
      if (remaining > 0 && remaining <= cfDuration) {
        const nextI = nextIdx()
        if (nextI >= 0) startCrossfade(nextI)
      }
    }
  }

  const startCrossfade = (nextI) => {
    const nextTrack = queue[nextI]
    if (!nextTrack?.streamUrl) return
    crossfading.current = true

    const current = getActive()
    const next = getInactive()
    if (!next) return

    if (preloadedUrlRef.current !== nextTrack.streamUrl) {
      next.src = apiUrl(nextTrack.streamUrl)
    }
    next.volume = 0
    next.play().catch(() => {})

    const durationMs = cfDuration * 1000
    const start = Date.now()
    const startVol = volumeRef.current

    const fade = () => {
      const t = Math.min((Date.now() - start) / durationMs, 1)
      if (current) current.volume = startVol * (1 - t)
      if (next) next.volume = startVol * t
      if (t < 1) {
        rafRef.current = requestAnimationFrame(fade)
      } else {
        if (current) { current.pause(); current.src = '' }
        preloadedUrlRef.current = null
        crossfading.current = false
        rafRef.current = null
        swapActive()
        activeUrlRef.current = nextTrack.streamUrl
        logPlay(nextTrack)
        updateMediaSession(nextTrack)
        setQueueIdx(nextI)
        setTimeout(preloadNext, 300)
      }
    }
    rafRef.current = requestAnimationFrame(fade)
  }

  const handleEnded = () => {
    if (crossfading.current) return
    // Audiobook reached the end — wipe the saved position so the
    // next play starts from 0 instead of "resuming" 1 second before
    // the credits.
    if (track?.isAudiobook) {
      const key = audiobookKey(track)
      if (key) setAudiobookPosition(key, 0)
    }
    if (track?.podcastEpisodeId) {
      authFetch(`/api/podcasts/episodes/${encodeURIComponent(track.podcastEpisodeId)}/progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position_s: 0, completed: true }),
      }).catch(() => {})
    }
    // Sleep timer 'end of chapter' mode — without chapter metadata,
    // each book is one file, so this is "stop on natural end". Pause
    // and short-circuit before the queue advances.
    if (sleepDeadline === 'eoc') {
      setIsPlaying(false)
      setSleepDeadline(null)
      setSleepShown(null)
      showToast('Sleep timer reached. Paused.', 4000)
      return
    }
    // Repeat-one — rewind the current track instead of advancing.
    // We bypass nextIdx() entirely since it would also return the
    // current index (correct) but reloading the src would cost a
    // network round-trip; resetting currentTime + playing is cheaper.
    if (repeatMode === 'one') {
      const a = getActive()
      if (a) { try { a.currentTime = 0; a.play() } catch {} }
      return
    }
    const nextI = nextIdx()
    if (nextI < 0) { setIsPlaying(false); return }

    const nextTrack = queue[nextI]
    const inactive = getInactive()

    // Gapless: pre-buffered — play immediately with no gap
    if (inactive && nextTrack?.streamUrl && preloadedUrlRef.current === nextTrack.streamUrl) {
      inactive.volume = volumeRef.current
      inactive.play().catch(() => {})
      swapActive()
      activeUrlRef.current = nextTrack.streamUrl
      preloadedUrlRef.current = null
      logPlay(nextTrack)
      updateMediaSession(nextTrack)
      setQueueIdx(nextI)
      setTimeout(preloadNext, 300)
    } else {
      setQueueIdx(nextI)
    }
  }

  const updateMediaSession = (t) => {
    if (!('mediaSession' in navigator) || !t) return
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title || '',
      artist: t.artist || '',
      artwork: t.albumCover ? [{ src: t.albumCover, sizes: '512x512', type: 'image/jpeg' }] : [],
    })
  }

  // Media Session action handlers — zustand actions read fresh state at call time
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const ms = navigator.mediaSession
    ms.setActionHandler('play', () => setIsPlaying(true))
    ms.setActionHandler('pause', () => setIsPlaying(false))
    ms.setActionHandler('nexttrack', () => { const n = nextIdx(); if (n >= 0) setQueueIdx(n) })
    ms.setActionHandler('previoustrack', () => {
      const active = getActive()
      if (active && active.currentTime > 3) { active.currentTime = 0; return }
      const p = prevIdx(); setQueueIdx(p)
    })
    ms.setActionHandler('seekto', (d) => {
      const active = getActive()
      if (active && d.seekTime != null) active.currentTime = d.seekTime
    })
    return () => {
      ['play', 'pause', 'nexttrack', 'previoustrack', 'seekto'].forEach(a => {
        try { ms.setActionHandler(a, null) } catch {}
      })
    }
  }, [])

  // Keyboard shortcuts — dispatched against the central KEYBINDINGS
  // registry in src/shortcuts.js. Adding a new shortcut means
  // appending to that file; the Settings → Keyboard tab and this
  // dispatcher stay in sync automatically.
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      const active = getActive()
      const ctx = {
        e,
        active,
        track,
        nextIdx, prevIdx, setQueueIdx,
        setIsPlaying,
        isPlayingRefCurrent: isPlayingRef.current,
        setVolume,
        volumeRefCurrent: volumeRef.current,
        prevVolRefCurrent: prevVolRef.current,
        prevVolRefSet: (v) => { prevVolRef.current = v },
        setShowShortcuts,
        setNowPlayingExpanded,
      }
      for (const bind of KEYBINDINGS) {
        if (!bind.handler) continue
        if (bind.match(e)) {
          bind.handler(ctx)
          return
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [track])

  const togglePlay = () => { if (track) setIsPlaying(!isPlaying) }

  const prev = () => {
    const audio = getActive()
    if (audio && audio.currentTime > 3) { audio.currentTime = 0; return }
    const p = prevIdx()
    if (p !== queueIdx) setQueueIdx(p)
    else if (audio) audio.currentTime = 0
  }

  const next = () => { const n = nextIdx(); if (n >= 0) setQueueIdx(n) }

  const seek = (e) => {
    const bar = e.currentTarget
    const raw = (e.clientX - bar.getBoundingClientRect().left) / bar.clientWidth
    const pct = Math.max(0, Math.min(1, raw))
    const active = getActive()
    const dur = active?.duration
    if (dur && isFinite(dur)) active.currentTime = pct * dur
  }

  // Relative-seek for the skip-back / skip-forward buttons on long-
  // form tracks. Clamps to [0, duration-1] so skipping past the end
  // doesn't blow past the file and fire `ended` from an out-of-range
  // seek; skipping back past 0 just lands at 0.
  const skip = (deltaS) => {
    const active = getActive()
    if (!active) return
    const dur = active.duration
    const target = (active.currentTime || 0) + deltaS
    if (dur && isFinite(dur)) {
      active.currentTime = Math.max(0, Math.min(dur - 1, target))
    } else {
      active.currentTime = Math.max(0, target)
    }
  }

  const pct = duration ? (progress / duration) * 100 : 0
  const sleepLabel = (shown) => {
    if (shown == null) return 'Sleep'
    if (shown === 'eoc') return 'EoC'
    const mins = Math.ceil(shown / 60_000)
    return `${mins}m`
  }

  const makeHandlers = (name) => ({
    onTimeUpdate: () => {
      if (activeRef.current !== name) return
      // Belt-and-suspenders: any timeupdate means audio is producing
      // bytes, so the spinner has no business showing. Some streams
      // (notably the bundled libtorrent server's /<ih>/<idx>) don't
      // fire `playing` reliably even when bytes are flowing — without
      // this the spinner would spin forever while the song plays.
      setIsBuffering(false)
      handleTimeUpdate()
    },
    onEnded: () => { if (activeRef.current === name) handleEnded() },
    onPlay: () => {
      if (activeRef.current !== name) return
      loadingTrackRef.current = false
      setIsPlaying(true)
    },
    onPlaying: () => {
      if (activeRef.current !== name) return
      clearStall()
      setIsBuffering(false)
    },
    onWaiting: () => {
      if (activeRef.current !== name) return
      armStall()
      // Only flag "buffering" when the user actually wants playback.
      // The audio element keeps prefetching after a pause and fires
      // `waiting` whenever its prefetch buffer drains — turning the
      // spinner on then is wrong UX (the user paused on purpose, no
      // load is blocking them).
      const a = getActive()
      if (a && !a.paused) setIsBuffering(true)
    },
    onStalled: () => {
      if (activeRef.current !== name) return
      armStall()
      const a = getActive()
      if (a && !a.paused) setIsBuffering(true)
    },
    onCanPlay: () => { if (activeRef.current === name) setIsBuffering(false) },
    onError: (e) => {
      if (activeRef.current !== name) return
      clearStall()
      setIsBuffering(false)
      // MediaError codes: 1=ABORTED, 2=NETWORK, 3=DECODE, 4=SRC_NOT_SUPPORTED.
      // The first is fine (user cancelled); the rest are fatal for this URL.
      const code = e?.target?.error?.code
      if (code === 1) return
      const labels = {
        2: 'network error',
        3: 'decode error',
        4: 'unsupported audio codec',
      }
      // Audiobook with unsupported codec: silently retry through the
      // server-side transcode endpoint instead of stopping. ffmpeg
      // pipes the file as 2-channel AAC, which any browser can play.
      // We pass the saved resume position as ?start= so playback
      // begins where the user left off; track.streamStartOffset
      // shifts all subsequent currentTime math back into absolute
      // seconds. transcodeAttempted guards against a 2nd-failure
      // loop (e.g. ffmpeg missing on this machine).
      if (track?.isAudiobook && code === 4 && !track.transcoded && track.bookKey) {
        const saved = audiobookPositions?.[audiobookKey(track)] || 0
        const url = `/api/audiobooks/library/${encodeURIComponent(track.bookKey)}/stream/transcoded?start=${saved}`
        showToast('Converting on the fly — codec unsupported, falling back to AAC', 5000)
        if (queueIdx >= 0) {
          updateQueueItem(queueIdx, { streamUrl: url, streamStartOffset: saved, transcoded: true })
        }
        return
      }
      // Network / decode failures on a track with a cache_key are
      // overwhelmingly stale-URL issues (debrid CDN expiry, yt-dlp
      // googlevideo URL rotation). Force-resolve once before giving
      // up. Code 4 (unsupported codec) is a real codec mismatch and
      // shouldn't retry — a fresh URL would have the same problem.
      if ((code === 2 || code === 3) && (track?.cache_key || track?.cacheKey)) {
        const failed = track
        tryForceResolve(failed).then((retried) => {
          if (retried) return
          if (failed?.isAudiobook) {
            showToast(`❌ Couldn't play "${failed?.title || 'audiobook'}" — ${labels[code] || 'unknown error'}`, 8000)
            setIsPlaying(false)
            return
          }
          showToast(`❌ Playback failed (${labels[code] || 'error'}) — skipping`)
          handleEnded()
        })
        return
      }
      // Audiobooks are standalone — auto-advancing to the next queued
      // track (which may be unrelated music) is hostile UX. Stop and
      // surface a longer-lived toast that says what to do next.
      if (track?.isAudiobook) {
        const detail = code === 4
          ? 'this audiobook is encoded in a codec your browser can\'t play (often E-AC3 / Dolby). Re-encode it to AAC or MP3 and re-import.'
          : labels[code] || 'unknown error'
        showToast(`❌ Couldn't play "${track?.title || 'audiobook'}" — ${detail}`, 8000)
        setIsPlaying(false)
        return
      }
      showToast(`❌ Playback failed (${labels[code] || 'error'}) — skipping`)
      handleEnded()
    },
    onEmptied: () => {
      if (activeRef.current !== name) return
      // Crossfade finalization sets src='' on the outgoing element
      // (which is still the active one until swapActive() runs a
      // moment later). The resulting `emptied` here would clear
      // isBuffering on the incoming track that's also mid-load —
      // skip while a crossfade is in flight.
      if (crossfading.current) return
      clearStall()
      setIsBuffering(false)
    },
    onPause: () => {
      if (activeRef.current !== name) return
      // Ignore pause events that fire as a side-effect of changing src
      // mid-load — we're about to call play() on the new source.
      if (loadingTrackRef.current) return
      // Same guard for the crossfade tail: startCrossfade pauses the
      // outgoing element + clears its src BEFORE swapActive() runs.
      // Without this guard, the pause event would setIsPlaying(false),
      // the isPlaying-sync effect would pause the (still inactive in
      // the ref but actually-playing) new element, and play() on it
      // would reject with AbortError. Audit blocker #4.
      if (crossfading.current) return
      setIsBuffering(false)
      setIsPlaying(false)
    },
    onLoadedMetadata: () => {
      if (activeRef.current !== name) return
      // First load after a fresh page boot: seek to the persisted
      // position so the user picks up where they left off. Bail if
      // the resume point is past the loaded duration (track changed
      // upstream, file is shorter, etc.). Audiobooks only — music
      // restarts at 0:00 by user preference.
      const active = getActive()
      const resume = pendingResumeRef.current
      pendingResumeRef.current = 0
      if (track?.isAudiobook && active && resume > 0 && active.duration && resume < active.duration - 2) {
        try { active.currentTime = resume } catch {}
      }
      // Stamp the duration once we know it — the AudiobooksView card
      // needs total seconds to compute pct = position / duration.
      if (track?.isAudiobook && active?.duration && isFinite(active.duration)) {
        const key = audiobookKey(track)
        if (key) setAudiobookDuration(key, active.duration)
      }
      handleTimeUpdate()
    },
  })

  return (
    <footer className={styles.player}>
      <audio ref={audioARef} {...makeHandlers('a')} />
      <audio ref={audioBRef} {...makeHandlers('b')} />

      <div className={styles.mobileBar}>
        <div className={styles.mobileBarFill} style={{ width: `${pct}%` }} />
      </div>

      <div
        className={styles.trackInfo}
        onClick={() => { if (track) setNowPlayingExpanded(true) }}
        onTouchStart={miniSwipe.onTouchStart}
        onTouchMove={miniSwipe.onTouchMove}
        onTouchEnd={miniSwipe.onTouchEnd}
        onTouchCancel={miniSwipe.onTouchCancel}
        title={track ? 'Open Now Playing' : undefined}
      >
        <div className={styles.thumb}>
          {track?.albumCover
            ? <img src={track.albumCover} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '7px' }} />
            : (track ? <Monogram text={track.artist || track.title} /> : <span style={{ color: 'var(--fg-soft)' }}>—</span>)}
        </div>
        <div className={styles.meta}>
          <div className={styles.title}>
            {track?.isAudiobook && <span className={styles.bookChip} aria-hidden="true">AUDIOBOOK</span>}
            {track?.title || 'No track playing'}
          </div>
          <div className={styles.artist}>
            {stalledKey ? (
              <span style={{ color: '#e85d5d' }}>
                Stream stalled —{' '}
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); retryStalledTrack() }}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'inherit',
                    textDecoration: 'underline',
                    cursor: 'pointer',
                    padding: 0,
                    font: 'inherit',
                  }}
                >Retry now</button>
              </span>
            ) : loadingStatus ? (
              <span style={{ opacity: 0.75 }}>{loadingStatus}</span>
            ) : (
              <>
                {track?.artist || '—'}
                {track?.isAudiobook && duration > 0 && progress > 0 && (
                  <span className={styles.bookRemain}>
                    {' · '}{formatHMS(Math.max(0, duration - progress))} left
                  </span>
                )}
              </>
            )}
          </div>
        </div>
        {track && (
          <button
            type="button"
            className={styles.expandBtn}
            onClick={e => { e.stopPropagation(); setNowPlayingExpanded(true) }}
            title="Open Now Playing (F)"
            aria-label="Open Now Playing"
          >↗</button>
        )}
      </div>

      <div className={styles.controls}>
        <div className={styles.btns}>
          <button className={`${styles.ctrlBtn} ${shuffle ? styles.active : ''}`} onClick={() => setShuffle(!shuffle)} title="Shuffle" aria-label={shuffle ? 'Shuffle on' : 'Shuffle off'}>⇄</button>
          {(track?.isAudiobook || track?.podcastEpisodeId) ? (
            <button className={styles.ctrlBtn} onClick={() => skip(-15)} disabled={!track} title="Skip back 15s" aria-label="Skip back 15 seconds">−15</button>
          ) : (
            <button className={styles.ctrlBtn} onClick={prev} disabled={!track} aria-label="Previous track"><Icon name="prev" size={18} /></button>
          )}
          <button
            className={`${styles.ctrlBtn} ${styles.playBtn}`}
            onClick={togglePlay}
            disabled={!track}
            aria-label={isBuffering ? 'Buffering' : (isPlaying ? 'Pause' : 'Play')}
          >
            {isBuffering ? <span className={styles.spinner} aria-hidden="true" /> : (
              <Icon name={isPlaying ? 'pause' : 'play'} size={20} />
            )}
          </button>
          {(track?.isAudiobook || track?.podcastEpisodeId) ? (
            <button className={styles.ctrlBtn} onClick={() => skip(30)} disabled={!track} title="Skip forward 30s" aria-label="Skip forward 30 seconds">+30</button>
          ) : (
            <button className={styles.ctrlBtn} onClick={next} disabled={!track} aria-label="Next track"><Icon name="next" size={18} /></button>
          )}
          <button
            className={`${styles.ctrlBtn} ${repeatMode !== 'off' ? styles.active : ''}`}
            onClick={cycleRepeatMode}
            title={
              repeatMode === 'off' ? 'Repeat off — click to enable'
                : repeatMode === 'queue' ? 'Repeat queue — click for repeat one'
                : 'Repeat one — click to disable'
            }
            aria-label={`Repeat ${repeatMode}`}
          >
            <span className={styles.repeatGlyph}>↻</span>
            {repeatMode === 'one' && <span className={styles.repeatBadge}>1</span>}
          </button>
          {track && (
            <div className={styles.sleepWrap} ref={speedWrapRef}>
              <button
                className={`${styles.cfBtn} ${bookSpeed !== 1.0 ? styles.cfActive : ''}`}
                onClick={() => setSpeedMenuOpen(o => !o)}
                title="Playback speed"
                aria-label="Playback speed"
              >{bookSpeed}×</button>
              {speedMenuOpen && (
                <div className={styles.sleepMenu}>
                  {SPEED_OPTIONS.map(opt => (
                    <button
                      key={opt}
                      className={`${styles.sleepMenuItem} ${opt === bookSpeed ? styles.cfActive : ''}`}
                      onClick={() => { setBookSpeed(opt); setSpeedMenuOpen(false) }}
                    >{opt}×{opt === 1.0 ? ' (normal)' : ''}</button>
                  ))}
                </div>
              )}
            </div>
          )}
          {(track?.isAudiobook || track?.podcastEpisodeId) && (
            <>
              <div className={styles.sleepWrap} ref={sleepWrapRef}>
                <button
                  className={`${styles.cfBtn} ${sleepShown != null ? styles.cfActive : ''}`}
                  onClick={() => setSleepMenuOpen(o => !o)}
                  title="Sleep timer"
                >{sleepLabel(sleepShown)}</button>
                {sleepMenuOpen && (
                  <div className={styles.sleepMenu}>
                    {SLEEP_OPTIONS.map(opt => (
                      <button
                        key={opt}
                        className={styles.sleepMenuItem}
                        onClick={() => {
                          if (opt === 'eoc') setSleepDeadline('eoc')
                          else setSleepDeadline(Date.now() + opt * 60_000)
                          setSleepMenuOpen(false)
                        }}
                      >{opt === 'eoc' ? 'End of chapter' : `${opt} min`}</button>
                    ))}
                    {sleepShown != null && (
                      <button
                        className={`${styles.sleepMenuItem} ${styles.sleepMenuClear}`}
                        onClick={() => { setSleepDeadline(null); setSleepMenuOpen(false) }}
                      >Cancel timer</button>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
        <div className={styles.progressWrap}>
          <span className={styles.time}>{((track?.isAudiobook || track?.podcastEpisodeId) ? formatHMS : formatSec)(progress)}</span>
          <div className={styles.progressBar} onClick={seek}>
            <div className={styles.progressTrack}>
              <div className={styles.progressFill} style={{ width: `${pct}%` }} />
            </div>
          </div>
          <span className={styles.time}>{((track?.isAudiobook || track?.podcastEpisodeId) ? formatHMS : formatSec)(duration)}</span>
        </div>
      </div>

      <div className={styles.mobileCtrls}>
        {(track?.isAudiobook || track?.podcastEpisodeId) ? (
          <button className={styles.ctrlBtn} onClick={() => skip(-15)} disabled={!track} aria-label="Skip back 15 seconds">−15</button>
        ) : (
          <button className={styles.ctrlBtn} onClick={prev} disabled={!track} aria-label="Previous track"><Icon name="prev" size={18} /></button>
        )}
        <button
          className={`${styles.ctrlBtn} ${styles.playBtn}`}
          onClick={togglePlay}
          disabled={!track}
          aria-label={isBuffering ? 'Buffering' : (isPlaying ? 'Pause' : 'Play')}
        >
          {isBuffering ? <span className={styles.spinner} aria-hidden="true" /> : (
            <Icon name={isPlaying ? 'pause' : 'play'} size={20} />
          )}
        </button>
        {(track?.isAudiobook || track?.podcastEpisodeId) ? (
          <button className={styles.ctrlBtn} onClick={() => skip(30)} disabled={!track} aria-label="Skip forward 30 seconds">+30</button>
        ) : (
          <button className={styles.ctrlBtn} onClick={next} disabled={!track} aria-label="Next track"><Icon name="next" size={18} /></button>
        )}
      </div>

      <div className={styles.right}>
        {track?.source && (
          <span className={styles.sourceBadge} title={`Source: ${track.source}`}>
            {String(track.source).toUpperCase()}
          </span>
        )}
        <button className={styles.shortcutHelp} onClick={() => setShowShortcuts(s => !s)} title="Keyboard shortcuts (?)">?</button>
        <span className={styles.volIcon}>VOL</span>
        <input
          type="range" className={styles.volSlider} min="0" max="100"
          value={Math.round(volume * 100)}
          onChange={(e) => setVolume(e.target.value / 100)}
          aria-label="Volume"
          title={`Volume ${Math.round(volume * 100)}`}
        />
        {/* Numeric readout removed: the slider position already
            conveys the level, the "VOL" label gives the slider
            context, and the redundant readout (0–100) read as
            visual noise next to the bar. The current value is in
            the tooltip + aria-label for accessibility. */}
      </div>

      {showShortcuts && (
        <div className={styles.shortcuts}>
          <div className={styles.shortcutsHeader}>
            <span className={styles.shortcutsTitle}>Keyboard Shortcuts</span>
            <button className={styles.shortcutsClose} onClick={() => setShowShortcuts(false)}>✕</button>
          </div>
          {[
            ['Space', 'Play / Pause'],
            ['←  →', 'Seek ±10 seconds'],
            ['N', 'Next track'],
            ['P', 'Previous track'],
            ['M', 'Mute / Unmute'],
            ['F', 'Open Now Playing'],
            ['?', 'Toggle this panel'],
          ].map(([key, label]) => (
            <div key={key} className={styles.shortcutRow}>
              <kbd className={styles.kbd}>{key}</kbd>
              <span className={styles.shortcutLabel}>{label}</span>
            </div>
          ))}
        </div>
      )}
    </footer>
  )
}
