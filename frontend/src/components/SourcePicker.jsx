import { useState, useEffect, useRef, useMemo } from 'react'
import { useStore } from '../store'
import { authFetch } from '../api'
import * as orchestrator from '../addons/orchestrator'
import * as registry from '../addons/registry'
import styles from './SourcePicker.module.css'

// Display labels for the addon-detected version tags. Anything not
// listed falls back to the raw key — so a new tag added on the addon
// side shows up immediately without a frontend update, just less
// pretty.
const VERSION_TAG_LABEL = {
  instrumental: 'Instrumental',
  acapella:     'Acapella',
  karaoke:      'Karaoke',
  remix:        'Remix',
  live:         'Live',
  acoustic:     'Acoustic',
  cover:        'Cover',
  demo:         'Demo',
  speed_edit:   'Sped/Slowed',
  radio_edit:   'Radio Edit',
  rehearsal:    'Rehearsal',
}

function formatBytes(b) {
  if (!b) return '—'
  if (b > 1e9) return (b / 1e9).toFixed(1) + ' GB'
  if (b > 1e6) return (b / 1e6).toFixed(1) + ' MB'
  return (b / 1e3).toFixed(0) + ' KB'
}
function formatSpeed(bps) {
  if (!bps) return '—'
  if (bps > 1e6) return (bps / 1e6).toFixed(1) + ' MB/s'
  return (bps / 1e3).toFixed(0) + ' KB/s'
}

// Is this source a peer-to-peer source? Addons stamp ``is_peer: true``
// on the source object — that's the entire contract from core's side.
// Pre-Phase-4 a legacy fallback also checked ``kind/type === 'slskd'``,
// but the rule is that the native picker doesn't hardcode any
// addon's protocol name. Addons that still need the old shape can
// run a compatibility shim on their own side.
function isPeerSource(t) {
  return !!(t && t.is_peer === true)
}

// Quality preference → sort weight. A higher number wins. The
// `any` preference returns 0 for everything so the addon-side
// ordering passes through unchanged.
function qualityWeight(t, pref) {
  if (pref === 'any') return 0
  const tags = (t.version_tags || []).map(s => String(s).toLowerCase())
  const ext = (t.ext || '').toLowerCase()
  const isFlac = tags.some(x => x.includes('flac')) || ext === '.flac'
  const is320  = tags.some(x => /320/.test(x))
  if (pref === 'flac') {
    if (isFlac) return 2
    if (is320)  return 1
    return 0
  }
  if (pref === '320') {
    if (is320)  return 2
    if (isFlac) return 1
    return 0
  }
  return 0
}

// Re-sort a section's sources by the user's quality preference,
// preserving the addon-side ordering as a tiebreaker. We sort a
// shallow copy so the original section data stays unchanged (other
// renders can lean on the addon's order). Sort priority:
//   1. cached first    — instant playback always wins
//   2. verified=true   — file list confirmed contains the track,
//                        so we know it'll play vs. an unverified row
//                        that might fail with no_audio
//   3. seeders desc    — top-seeded torrents next
//   4. quality pref    — tiebreaker between same-seeder rows
//   5. original idx    — stable
function applyQualityPref(sources, pref) {
  if (!Array.isArray(sources)) return sources
  const isCached = (s) => !!s?.is_cached || !!s?.rd_cached
  const usePref = pref && pref !== 'any'
  return sources
    .map((s, i) => ({
      s, i,
      c: isCached(s) ? 1 : 0,
      v: s?.verified === true ? 1 : 0,
      n: s.seeders || 0,
      w: usePref ? qualityWeight(s, pref) : 0,
    }))
    .sort((a, b) => (b.c - a.c) || (b.v - a.v) || (b.n - a.n) || (b.w - a.w) || (a.i - b.i))
    .map(x => x.s)
}

export default function SourcePicker({ track, onClose, inline = false }) {
  const { showToast, playNow, mergeCachedKeys, bumpCacheVersion, audioQualityPref } = useStore()

  const [addonSections, setAddonSections] = useState([]) // accumulates as the SSE stream emits
  const [sectionsLoading, setSectionsLoading] = useState(true)
  const [activeJob, setActiveJob] = useState(null)
  const fetchedRef = useRef(false)

  useEffect(() => {
    if (fetchedRef.current) return
    fetchedRef.current = true

    // Addons live device-side. Fan out to every resolve.sources addon
    // installed on this device — Audimo's backend isn't in the loop.
    // Streaming variant: each addon emits one section at a time as
    // its backends finish, so fast sources render immediately while
    // slower ones fill in later.
    const ctrl = new AbortController()
    orchestrator
      .resolveSourcesStreaming(
        { title: track.title, artist: track.artist || '', album: track.album || '', kind: track.kind || '' },
        {
          signal: ctrl.signal,
          onSection: section => {
            setAddonSections(prev => {
              // Replace if we've already seen this section_id; otherwise append.
              const key = section.section_id || `${section.addon_id}:${section.label}`
              const idx = prev.findIndex(s => (s.section_id || `${s.addon_id}:${s.label}`) === key)
              if (idx === -1) return [...prev, section]
              const next = prev.slice()
              next[idx] = section
              return next
            })
          },
        },
      )
      .finally(() => setSectionsLoading(false))
    return () => ctrl.abort()
  }, [])

  const finishPlay = async (streamUrl, src, albumCover) => {
    playNow({
      title: track.title, artist: track.artist || '',
      albumCover: albumCover || track.album_cover || null,
      streamUrl, source: src,
    })
    showToast(`▶ Playing via ${src}`)
    try {
      const cr = await authFetch('/api/cache/check', {
        method: 'POST',
        body: JSON.stringify({ tracks: [{ title: track.title, artist: track.artist || '' }] }),
      })
      const cd = await cr.json()
      mergeCachedKeys(cd.cached || {})
    } catch {}
    onClose()
  }

  // Per-stream cancellation for the addon path. The ref tracks the
  // active AbortController; userCancelledRef distinguishes "user hit
  // Cancel" (silent) from any other AbortError (must surface a toast).
  const addonAbortRef = useRef(null)
  const userCancelledRef = useRef(false)

  // Heuristic: should an addon error trigger auto-fallback to the
  // next peer in the same section? Per-peer failures (connection
  // refused, transfer errored, rejected, timed out) mean THIS peer
  // is bad but the file might still be reachable from someone else.
  // Contract: the addon emits ``retryable: true`` on errors that
  // should fall through to the next peer in the section. The native
  // picker doesn't hardcode any addon's error codes.
  const isRetryablePeerError = (ev) => {
    return !!(ev && ev.status === 'error' && ev.retryable === true)
  }

  // "Instant playback" predicate. Addons mark such rows with
  // `is_cached: true`; the legacy `rd_cached` field is honored as a
  // fallback so we don't lose the badge for older addons. The
  // peer-source predicate (`isPeerSource`) lives at module scope.
  const isCachedRow = (s) => !!s?.is_cached || !!s?.rd_cached

  // Cross-addon merge. With multiple resolve.sources addons (audimo-aio
  // fanning to extensions, plus audimo-indexers as a top-level addon),
  // each emits its own section. The user wants one consolidated view:
  // every RD-cached source on top, then non-cached sorted by seeders,
  // regardless of which addon found it. Dedupe by info_hash so the
  // same torrent doesn't appear twice when multiple indexers
  // surface it.
  //
  // Peer sources (slskd) keep their per-addon section — different
  // metadata and the user picks them on different criteria.
  const { mergedMain, peerSections } = useMemo(() => {
    const merged = []
    const seenHash = new Set()
    const peerOnly = []
    for (const sec of addonSections) {
      const peerHere = []
      for (const t of (sec.sources || [])) {
        if (isPeerSource(t)) {
          peerHere.push(t)
          continue
        }
        const h = (t.info_hash || '').toString().toLowerCase()
        if (h) {
          // Same torrent surfaced by multiple addons. Keep the more
          // useful copy: cached always wins over uncached (instant
          // playback beats any seeder count); among same cached-ness,
          // higher seeders wins. Without the cached-priority check we
          // could lose a cache-stamped version to an uncached one
          // that had more seeders, then sort it below cached items —
          // the user would never see the INSTANT badge.
          const prev = merged.findIndex(x => (x.info_hash || '').toString().toLowerCase() === h)
          if (prev !== -1) {
            const old = merged[prev]
            const tCached = isCachedRow(t)
            const oldCached = isCachedRow(old)
            if (tCached && !oldCached) {
              merged[prev] = t
            } else if (tCached === oldCached && (t.seeders || 0) > (old.seeders || 0)) {
              merged[prev] = t
            }
            continue
          }
          seenHash.add(h)
        }
        merged.push(t)
      }
      if (peerHere.length > 0) {
        peerOnly.push({ ...sec, sources: peerHere })
      }
    }
    merged.sort((a, b) => {
      const cd = (isCachedRow(b) ? 1 : 0) - (isCachedRow(a) ? 1 : 0)
      if (cd !== 0) return cd
      // Verified > unverified — a confirmed-contains-track torrent
      // will play. An unverified one might fail with no_audio after
      // the user clicks. Rank verified ahead of seeder count.
      const vd = (b?.verified === true ? 1 : 0) - (a?.verified === true ? 1 : 0)
      if (vd !== 0) return vd
      return (b.seeders || 0) - (a.seeders || 0)
    })
    return { mergedMain: merged, peerSections: peerOnly }
  }, [addonSections])

  const playSource = async (source, idx, peerFallbacks = [], torrentFallbacks = []) => {
    if (activeJob && activeJob.idx !== idx) return
    const jobId = `job_${Date.now()}`
    setActiveJob({ idx, jobId, pct: 0, message: 'Starting…', status: 'downloading' })

    // Forward the source object verbatim to the addon. Core does not
    // interpret the addon's source shape — the addon emitted it on
    // resolve.sources and consumes the same shape on resolve.stream.
    // The only thing we add is a stable `id` for retry/dedup if the
    // addon didn't supply one.
    const isPeer = isPeerSource(source)
    const sourcePayload = {
      ...source,
      id: source.id
        || source.info_hash
        || (source.username && source.filename ? `${source.username}:${source.filename}` : null)
        || source.name,
    }

    const ctrl = new AbortController()
    addonAbortRef.current = ctrl
    userCancelledRef.current = false
    try {
      // Peer-source flows can take 10+ minutes (queues, connection
      // setup); the addon waits up to 10 min internally, so the
      // fetch must outlast that. Indexed-source flow uses the
      // default. 15 min covers slow queues + connection setup.
      const stream = orchestrator.resolveStream({
        addonId: source.addon_id,
        source: sourcePayload,
        // `kind` MUST be forwarded — the addon uses it to pick the
        // save path (`~/Audiobooks` for audiobooks, `~/Music/Audimo`
        // for music).
        track: {
          title: track.title,
          artist: track.artist || '',
          album: track.album || '',
          kind: track.kind || '',
        },
      }, { signal: ctrl.signal, timeoutMs: isPeer ? 15 * 60 * 1000 : undefined })

      let firstReady = null
      // Time budget for torrent sources only. Peers are slow by
      // design (queue waits) — they keep the existing per-peer
      // retry logic. For torrents: if the chosen source can't
      // produce a streamUrl in budget, abort and let the caller try
      // the next ranked torrent source.
      //
      // Two budgets: addon-resolved torrents (debrid path, fast or
      // immediately fails) get the original 25s. Bundled-streaming-
      // server torrents need much longer — first-boot DHT bootstrap
      // on a thin-tracker magnet routinely takes 60-120s, and the
      // streaming server's own metadata deadline is 180s. A 25s
      // budget here was killing every cold-start attempt before peers
      // could deliver metadata, producing the "Searching DHT… → next
      // torrent" cycle.
      const TORRENT_FIRST_BYTE_BUDGET_MS =
        orchestrator.isCoreStreamableSource && orchestrator.isCoreStreamableSource(source)
          ? 150_000
          : 25_000
      const consumeStream = (async () => {
        for await (const ev of stream) {
          console.log('[SourcePicker] addon stream event:', JSON.stringify(ev))
          setActiveJob(prev => prev ? {
            ...prev,
            pct: typeof ev.pct === 'number' ? ev.pct : prev.pct,
            message: ev.message || prev.message,
            status: ev.status || prev.status,
          } : null)
          if (ev?.status === 'error') return ev
          if (ev?.streamUrl) return ev
          if (ev?.status === 'done') return ev
        }
        return null
      })()
      if (isPeer) {
        firstReady = await consumeStream
      } else {
        const TIMEOUT_SENTINEL = Symbol('budget')
        const budgetTimer = new Promise(resolve =>
          setTimeout(() => resolve(TIMEOUT_SENTINEL), TORRENT_FIRST_BYTE_BUDGET_MS)
        )
        const result = await Promise.race([consumeStream, budgetTimer])
        if (result === TIMEOUT_SENTINEL) {
          // Cancel the in-flight stream so the streaming server's
          // engine + libtorrent connections aren't held open.
          try { ctrl.abort('source-budget-exceeded') } catch {}
          firstReady = {
            status: 'error',
            message: `No bytes from this source after ${TORRENT_FIRST_BYTE_BUDGET_MS / 1000}s`,
            __budgetExceeded: true,
          }
        } else {
          firstReady = result
        }
      }

      addonAbortRef.current = null
      // User hit Cancel mid-resolve. cancelDownload already cleared
      // activeJob and toasted "Download cancelled" — bail without
      // falling through to the next source. Without this guard, a
      // cancel during DHT search would just kick off the next torrent
      // and surface "source failed — trying next…", making cancel
      // feel like it does nothing.
      if (userCancelledRef.current) {
        return
      }
      if (!firstReady || firstReady.status === 'error' || !firstReady.streamUrl) {
        // Auto-fall-through: if this peer flaked with a known
        // per-peer failure code and we have more peers in the same
        // section to try, transparently retry the next one without
        // bothering the user. Only show a toast when we run out.
        if (isPeer && firstReady && isRetryablePeerError(firstReady) && peerFallbacks.length > 0) {
          const [next, ...rest] = peerFallbacks
          showToast(`⤳ ${source.username || 'peer'} failed, trying ${next.username || 'next'}…`)
          // Reset activeJob first; the recursive call will re-set it.
          setActiveJob(null)
          // Defer one tick so React commits the cleared state before
          // the next attempt locks the UI again.
          setTimeout(() => playSource(next, idx, rest), 0)
          return
        }
        // Same fallthrough for torrent sources that ran out of time
        // budget OR returned an error (dead torrent, no audio file,
        // etc.). Skip silently to the next ranked torrent — usually
        // a different release of the same track with healthier seeds.
        if (!isPeer && torrentFallbacks.length > 0) {
          const [next, ...rest] = torrentFallbacks
          const reason = firstReady?.__budgetExceeded ? 'slow' : 'failed'
          showToast(`⤳ source ${reason} — trying next…`)
          setActiveJob(null)
          setTimeout(() => playSource(next, idx, [], rest), 0)
          return
        }
        setActiveJob(null)
        const msg = firstReady?.message || 'Addon could not resolve this source'
        // Peer failures can be very long; truncate so the toast
        // stays readable.
        const short = msg.length > 200 ? msg.slice(0, 197) + '…' : msg
        showToast(`${short}`)
        return
      }

      // Cache entry type. Core stores `type='addon'` for anything
      // an addon resolved; cache.resolve delegation keys off
      // `addon_id`, not `type`. The legacy specific types ('rd',
      // 'slskd' for peer sources) still exist in some installs' historical data and
      // the migration on read tags them with addon_id automatically.
      const initialType = 'addon'

      // Build the persisted cache row. Order matters:
      //   1. Spread the addon's `ready` event verbatim so opaque,
      //      addon-specific fields (e.g. its own cache key) survive
      //      into the row and reappear on cache.resolve.
      //   2. Then layer the core-owned fields on top so they always
      //      win even if the addon happens to emit a same-named key.
      const cacheBody = {
        ...firstReady,
        type: initialType,
        addon_id: source.addon_id,
        // Tag audiobook plays so the AudiobooksView can derive its
        // library from /api/cache/list instead of running its own
        // separate fetch (which has a stubborn boot-race we don't
        // hit on the music cache path).
        ...(track.kind === 'audiobook' ? { category: 'audiobook' } : {}),
        title: track.title,
        artist: track.artist || '',
        album: track.album || '',
        streamUrl: firstReady.streamUrl,
        albumCover: track.album_cover || firstReady.albumCover || '',
        // Fall back to a generic label — the addon owns the source
        // vocabulary; the native app shouldn't synthesize names of
        // upstream backends.
        source: firstReady.source || source.source || 'Addon',
        addon_payload: firstReady.payload || null,
        // Merge any fields the orchestrator resolved at play time
        // (e.g. the bundled streaming server's chosen file_idx for
        // torrents whose addon source was missing it) back onto the
        // source_payload so the backend's save-to-library flow sees
        // both info_hash and file_idx.
        source_payload: {
          ...sourcePayload,
          ...(firstReady.info_hash ? { info_hash: firstReady.info_hash } : {}),
          ...(Number.isInteger(firstReady.file_idx) ? { file_idx: firstReady.file_idx } : {}),
        },
        track_payload: {
          title: track.title,
          artist: track.artist || '',
          album: track.album || '',
        },
      }

      let cacheKey = null
      try {
        const r = await authFetch('/api/cache/add', {
          method: 'POST',
          body: JSON.stringify(cacheBody),
        })
        const d = await r.json().catch(() => ({}))
        cacheKey = d?.key || null
      } catch (e) {
        console.warn('[SourcePicker] cache/add failed:', e.message)
      }

      // Bundled-streaming-server flow: after we've started playing a
      // torrent via :11471 + saved a local copy, also ask the source's
      // addon to push the torrent to the user's debrid backend (RD/AD/
      // /TB/etc.). This keeps the addon-side "Delete local copy after
      // debrid caches it" toggle meaningful even though the actual
      // libtorrent download didn't go through the addon's own
      // /resolve/stream path. Fire-and-forget — playback is already
      // working, debrid push is a background optimization.
      if (cacheKey && cacheBody.source_payload?.info_hash && cacheBody.source_payload?.addon_id) {
        orchestrator.pushToDebrid({
          source: cacheBody.source_payload,
          cacheKey,
          track: { title: track.title, artist: track.artist || '' },
        }).catch(() => {})
      }

      // Background cache_hint listener: some addons promote the
      // entry's URL after a slow upstream cache completes. We listen
      // for that post-ready event and PATCH the cache row when it
      // arrives. Peer-source flows close immediately on `done`, so
      // skip the background listen for them.
      if (cacheKey && !isPeer) {
        ;(async () => {
          try {
            for await (const ev of stream) {
              if (ev?.status === 'error') break
              if (ev?.type === 'cache_hint' && ev?.streamUrl) {
                try {
                  // Forward every field the addon emitted on the
                  // hint event verbatim — core does not interpret
                  // addon-specific keys.
                  await authFetch('/api/cache/update', {
                    method: 'PATCH',
                    body: JSON.stringify({
                      ...ev,
                      key: cacheKey,
                      streamUrl: ev.streamUrl,
                      source: ev.source || cacheBody.source,
                    }),
                  })
                  bumpCacheVersion()
                } catch (e) {
                  console.warn('[SourcePicker:bg] cache/update failed:', e.message)
                }
              }
              if (ev?.type === 'done') break
            }
          } catch (e) {
            if (e.name !== 'AbortError') {
              console.warn('[SourcePicker:bg] listener errored:', e.message)
            }
          }
        })()
      }

      setActiveJob(null)
      bumpCacheVersion()
      const playedSrc = firstReady.source || source.source || 'Addon'
      await finishPlay(firstReady.streamUrl, playedSrc, firstReady.albumCover || null)
    } catch (e) {
      addonAbortRef.current = null
      console.warn('[SourcePicker] playSource error:', e?.name, e?.message, e)
      // Only suppress the toast when the user explicitly cancelled.
      // Any other AbortError (timeout, network drop, addon crash)
      // used to be swallowed silently — surface it instead so
      // "sometimes nothing happens" stops being a thing.
      if (e.name === 'AbortError' && userCancelledRef.current) {
        // user-initiated; cancelDownload already showed its own toast
      } else if (e.name === 'AbortError') {
        showToast('Stream aborted (timeout or connection dropped)')
      } else {
        showToast(`${e.message || 'Unknown error'}`)
      }
      setActiveJob(null)
    }
  }

  const cancelDownload = async () => {
    if (!activeJob) return
    userCancelledRef.current = true
    setActiveJob(prev => ({ ...prev, message: 'Cancelling…', status: 'cancelling' }))
    if (addonAbortRef.current) {
      try { addonAbortRef.current.abort() } catch {}
      addonAbortRef.current = null
    }
    setActiveJob(null)
    showToast('Download cancelled')
  }

  // Two render modes:
  //   • Modal (default) — full-screen overlay with track header
  //     + close button. Used by Library / Home / NowPlaying picks.
  //   • Inline — collapsible panel beneath a search row. The
  //     SearchView caller already shows the track meta in the row
  //     itself, so the header is redundant here. The panel skips
  //     the overlay + header and renders the source list directly.
  const Wrapper = inline ? InlineWrap : ModalWrap
  const wrapperProps = inline ? {} : { onClose }
  return (
    <Wrapper {...wrapperProps}>
        {!inline && (
          <div className={styles.header}>
            <div className={styles.trackInfo}>
              {track.album_cover && <img src={track.album_cover} alt="" className={styles.cover} />}
              <div>
                <div className={styles.trackTitle}>{track.title}</div>
                <div className={styles.trackArtist}>{track.artist}</div>
              </div>
            </div>
            <button className={styles.closeBtn} onClick={onClose}>✕</button>
          </div>
        )}

        {activeJob && (
          <div className={styles.progressWrap}>
            <div className={styles.progressBar}>
              <div
                className={[styles.progressFill, activeJob.status === 'error' ? styles.progressError : ''].join(' ')}
                style={{ width: `${activeJob.status === 'done' ? 100 : Math.max(activeJob.pct, 3)}%` }}
              />
            </div>
            <div className={styles.progressFooter}>
              <span className={styles.progressMsg}>{activeJob.message}</span>
              {activeJob.status === 'downloading' && (
                <button className={styles.cancelBtn} onClick={cancelDownload}>✕ Cancel</button>
              )}
            </div>
          </div>
        )}

        <div className={styles.sections}>

          {/* Addon-driven sections (label + icon come from addon manifest).
              Inside each section, peer sources render with FLAC badge
              + user/speed; indexed sources render with seed counts. */}
          {sectionsLoading && addonSections.length === 0 && (
            <div className={styles.section}>
              <div className={styles.sectionHeader}>
                <span className={styles.sectionTitle}>Addons</span>
                <span className={styles.sectionCount}>
                  <span className={styles.loadingDot}>searching…</span>
                </span>
              </div>
              <div className={styles.sectionLoading}>
                <div className={styles.spinner} />
              </div>
            </div>
          )}

          {/* Synthesize a "Best Sources" section combining every
              addon's non-peer sources (cached first, then by seeders,
              deduped by infohash). Peer sections render after. */}
          {[
            ...(mergedMain.length > 0 ? [{
              addon_id: '_merged',
              label: 'Best sources',
              icon: '⚡',
              sources: mergedMain,
            }] : []),
            ...peerSections,
          ].map((section, sIdx) => {
            // Apply the user's quality preference (FLAC / 320 / any)
            // as a stable secondary sort. 'any' is a no-op so addon
            // ordering passes through unchanged.
            const orderedSources = applyQualityPref(section.sources, audioQualityPref)
            return (
            <div key={`${section.addon_id}_${section.label}_${sIdx}`} className={styles.section}>
              <div className={styles.sectionHeader}>
                <span className={styles.sectionTitle}>{section.label}</span>
                <span className={styles.sectionCount}>{orderedSources.length} results</span>
              </div>
              {orderedSources.length === 0 && (
                <div className={styles.empty}>
                  {section.error ? `Addon error: ${section.error}` : 'No results found'}
                </div>
              )}
              {orderedSources.map((t, i) => {
                const idx = `addon_${section.addon_id}_${sIdx}_${i}`
                const active = activeJob?.idx === idx
                const isPeerRow = isPeerSource(t)

                if (isPeerRow) {
                  // Build the fallback list = every peer source after
                  // this one in the same section. If this peer flakes
                  // with a per-peer error, playSource auto-tries the
                  // next one without involving the user.
                  // `(section.sources || [])` — a malformed addon
                  // response with `sources: null` used to crash the
                  // whole picker render here.
                  // Use the quality-ordered list so peer-fallback
                  // skipping respects the user's preference too.
                  const peerFallbacks = (orderedSources || [])
                    .slice(i + 1)
                    .filter(isPeerSource)
                  return (
                    <div
                      key={i}
                      className={[styles.sourceRow, active ? styles.active : '', activeJob && !active ? styles.dimmed : ''].join(' ')}
                      role="button"
                      tabIndex={activeJob ? -1 : 0}
                      onClick={() => !activeJob && playSource(t, idx, peerFallbacks)}
                      onKeyDown={e => {
                        if (activeJob) return
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          playSource(t, idx, peerFallbacks)
                        }
                      }}
                    >
                      <div className={styles.sourceLeft}>
                        <span className={[styles.extBadge, (t.ext || '').toLowerCase() === '.flac' ? styles.lossless : styles.lossy].join(' ')}>
                          {(t.ext || '').replace('.', '').toUpperCase() || '?'}
                        </span>
                        <div className={styles.sourceInfo}>
                          <div className={styles.sourceName}>{t.short_name || t.name}</div>
                          <div className={styles.sourceMeta}>
                            {t.username} · {formatBytes(t.filesize || t.size)} · {formatSpeed(t.upload_speed)}
                            {t.free_slots > 0 && <span className={styles.freeSlot}> · {t.free_slots} slot{t.free_slots > 1 ? 's' : ''} free</span>}
                          </div>
                        </div>
                      </div>
                      <div className={styles.sourceRight}>
                        {active ? <span className={styles.dlSpinner} /> : <button className={styles.playBtn}>▶</button>}
                      </div>
                    </div>
                  )
                }

                const low = t.seeders < 20
                const cached = isCachedRow(t)
                // Auto-fall-through list for torrent sources: every
                // ranked-lower torrent (non-peer) row in the same
                // section. If this source can't deliver a streamUrl
                // within the 25s budget, playSource transparently
                // tries the next one — usually a healthier seed
                // count or RD-cached release of the same track.
                const torrentFallbacks = (orderedSources || [])
                  .slice(i + 1)
                  .filter(s => !isPeerSource(s))
                return (
                  <div key={i}>
                    <div
                      className={[styles.sourceRow, active ? styles.active : '', activeJob && !active ? styles.dimmed : '', cached ? styles.cachedRow : ''].join(' ')}
                      role="button"
                      tabIndex={activeJob ? -1 : 0}
                      onClick={() => !activeJob && playSource(t, idx, [], torrentFallbacks)}
                      onKeyDown={e => {
                        if (activeJob) return
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          playSource(t, idx, [], torrentFallbacks)
                        }
                      }}
                    >
                      <div className={styles.sourceLeft}>
                        {cached
                          ? <span className={styles.rdInstantBadge}>CACHED</span>
                          : t.kind === 'http'
                            ? <span className={styles.seedBadge}>FREE</span>
                            // Lazy listings (e.g. AudiobookBay) hand back
                            // the title without an info_hash, so the BEP-15
                            // tracker scrape that fills in seeder counts
                            // can't run until resolve.stream fetches the
                            // detail page. Show "?↑" instead of "0↑" so
                            // the user doesn't think the torrent is dead.
                            : (!t.info_hash && (t.seeders || 0) === 0)
                              ? <span className={styles.seedBadge}>?↑</span>
                              : <span className={styles.seedBadge}>{t.seeders || 0}↑</span>
                        }
                        <div className={styles.sourceInfo}>
                          <div className={styles.sourceName}>
                            {/* ✅ verified: addon fetched the file list
                                and confirmed a file matching the title
                                phrase is inside. Differs from the seed
                                count / quality tags — those are signals,
                                this is a fact. Hidden when verified !==
                                true so unverified rows aren't penalised
                                visually (we just don't promise). */}
                            {t.verified === true && (
                              <span className={styles.verifiedBadge} title="File list contains this track">
                                ✓
                              </span>
                            )}
                            {t.name}
                            {/* Version badges: addon detected this is
                                a non-original variant (live, remix,
                                instrumental, …). Surfaced inline so
                                the user can tell at a glance and skip
                                if they want the studio version. */}
                            {(t.version_tags || []).map(tag => (
                              <span key={tag} className={`${styles.versionTag} ${styles['vt_' + tag] || ''}`}>
                                {VERSION_TAG_LABEL[tag] || tag}
                              </span>
                            ))}
                          </div>
                          <div className={styles.sourceMeta}>
                            {cached && <span className={styles.cachedMeta}>Instant · </span>}
                            {/* Source badge: which upstream the addon
                                used to surface this row. The addon
                                stamps `source` on every row; we surface
                                it here so users can see who's vouching
                                for the result. */}
                            {t.source && <span className={styles.trackerTag}>{t.source}</span>}
                            {t.source && (t.size || t.query_type === 'album') && <span> · </span>}
                            {t.size ? formatBytes(t.size) : ''}
                            {t.query_type === 'album' && <span className={styles.albumTag}> · album</span>}
                          </div>
                        </div>
                      </div>
                      <div className={styles.sourceRight}>
                        {active ? <span className={styles.dlSpinner} /> : <button className={[styles.playBtn, cached ? styles.playBtnCached : ''].join(' ')}>▶</button>}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )})}

          {sectionsLoading && addonSections.length > 0 && (
            <div className={styles.sectionLoading}>
              <div className={styles.spinner} />
              <span style={{ marginLeft: 8, opacity: 0.7, fontSize: 12 }}>
                Still searching slower sources…
              </span>
            </div>
          )}

        </div>
    </Wrapper>
  )
}

// Modal wrapper: full-screen overlay with click-outside-to-close
// (existing behavior for Library / Home / NowPlaying surfaces).
function ModalWrap({ onClose, children }) {
  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}

// Inline wrapper: hairline-bordered panel that fits beneath a row.
// SearchView uses this so users can compare sources without a modal
// hop.
function InlineWrap({ children }) {
  return <div className={styles.inline}>{children}</div>
}
