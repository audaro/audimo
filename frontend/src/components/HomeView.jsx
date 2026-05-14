import { useState, useEffect, useMemo } from 'react'
import { useStore } from '../store'
import { authFetch } from '../api'
import * as registry from '../addons/registry'
import SourcePicker from './SourcePicker'
import { resolveCacheEntry } from '../api'
import styles from './HomeView.module.css'

const DEADLINE_MS = 8_000

async function fetchDeadline(url, init = {}) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), DEADLINE_MS)
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal })
    clearTimeout(t)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return await r.json()
  } finally {
    clearTimeout(t)
  }
}

function sanitizeShelves(raw, declared) {
  if (!Array.isArray(raw)) return []
  const allowedIds = new Set((declared || []).map(d => d.id))
  const declaredById = new Map((declared || []).map(d => [d.id, d]))
  return raw
    .filter(s => s && allowedIds.has(s.id) && Array.isArray(s.items) && s.items.length > 0)
    .map(s => ({
      ...s,
      title: s.title || declaredById.get(s.id)?.label || '',
      sort_priority: declaredById.get(s.id)?.sort_priority ?? 100,
      items: s.items.slice(0, 50).map(item => ({
        ...item,
        image: (typeof item.image === 'string' && item.image.startsWith('https://'))
          ? item.image.slice(0, 2048) : null,
        title: String(item.title || '').slice(0, 80),
        badges: Array.isArray(item.badges)
          ? item.badges.slice(0, 3).map(b => String(b).slice(0, 8)) : [],
      })),
    }))
}

function fmtToday() {
  return new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
}

function fmtTimeRemaining(seconds) {
  if (!seconds || seconds < 0) return ''
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}h ${m}m left`
  return `${m}m left`
}

function fmtAge(epochS) {
  if (!epochS) return ''
  const days = Math.floor((Date.now() / 1000 - epochS) / 86400)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days}d ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  return `${Math.floor(days / 30)}mo ago`
}

function fmtMinutes(s) {
  if (!s) return ''
  const m = Math.round(s / 60)
  return `${m}m`
}

export default function HomeView() {
  const { setView, audiobookPositions, audiobookDurations, playNow, openAudiobookDetail, openPodcastDetail, showToast } = useStore()
  const apiKey = useStore(s => s.apiKey)
  const cacheVersion = useStore(s => s.cacheVersion)
  const addons = useStore(s => s.addons) || []

  const [recentSaved, setRecentSaved] = useState([])
  const [continueBooks, setContinueBooks] = useState([])
  const [addonShelves, setAddonShelves] = useState([])
  const [recentPlayed, setRecentPlayed] = useState([])
  const [topThisMonth, setTopThisMonth] = useState([])
  const [newEpisodes, setNewEpisodes] = useState([])
  const [pickerTrack, setPickerTrack] = useState(null)
  const [loading, setLoading] = useState(true)

  // Top this month — most-played tracks in the last 30 days. Server
  // aggregates play_history; client just renders. Hidden when fewer
  // than 4 tracks have plays in the window (a half-empty rail looks
  // broken on a fresh install).
  useEffect(() => {
    let cancelled = false
    authFetch('/api/history/top?days=30&limit=10')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (cancelled || !d) return
        setTopThisMonth(d.tracks || [])
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [apiKey, cacheVersion])

  // New podcast episodes — latest unplayed across all subscriptions.
  // 8 rows max to keep the rail at a comparable height to the others.
  useEffect(() => {
    let cancelled = false
    authFetch('/api/podcasts/episodes/recent?limit=8')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled && d) setNewEpisodes(d.episodes || []) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [apiKey, cacheVersion])

  // Recently played — server-side play history, deduped by
  // (title, artist) so the same track played repeatedly shows once.
  // Stats aggregations (Today right rail, real History view) read
  // from the same /api/history rows but with different windowing.
  useEffect(() => {
    let cancelled = false
    authFetch('/api/history?limit=50')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (cancelled || !d) return
        const seen = new Set()
        const dedup = []
        for (const e of (d.entries || [])) {
          const k = `${(e.track_artist || '').toLowerCase()}|${(e.track_title || '').toLowerCase()}`
          if (seen.has(k)) continue
          seen.add(k)
          dedup.push(e)
          if (dedup.length >= 8) break
        }
        setRecentPlayed(dedup.filter(e => e.kind !== 'audiobook'))
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [apiKey, cacheVersion])

  // Recently added — pull from /api/cache/list, sort by updated_at desc
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    authFetch('/api/cache/list')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (cancelled || !d) return
        const entries = (d.entries || [])
          .filter(registry.entryIsResolvableOnDevice)
          .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0) || (b.added_at || 0) - (a.added_at || 0))
          .slice(0, 8)
        setRecentSaved(entries)
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [apiKey, cacheVersion])

  // Continue listening — only books with non-zero, non-finished progress
  useEffect(() => {
    let cancelled = false
    authFetch('/api/audiobooks/library')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (cancelled || !d) return
        // /api/audiobooks/library returns {books: [...]} — earlier
        // versions of this code read .entries and silently saw an
        // empty list, so the Continue Listening rail never populated.
        const books = (d.books || [])
          .map(b => {
            const pos = audiobookPositions[b.id] || 0
            const dur = audiobookDurations[b.id] || 0
            const pct = dur > 0 ? pos / dur : 0
            return { ...b, position: pos, duration: dur, pct }
          })
          .filter(b => b.pct > 0.005 && b.pct < 0.95 && !!b.localFile)
          .sort((a, b) => b.position - a.position)
          .slice(0, 4)
        setContinueBooks(books)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [apiKey, audiobookPositions, audiobookDurations])

  // ui.home addon shelves — fan out to enabled addons advertising ui.home,
  // drop addons that don't respond within deadline.
  useEffect(() => {
    let cancelled = false
    const homeAddons = addons.filter(a =>
      a.enabled !== false &&
      a.manifest?.capabilities?.includes('ui.home') &&
      Array.isArray(a.manifest?.ui?.home?.shelves)
    )
    if (!homeAddons.length) { setAddonShelves([]); return }

    Promise.allSettled(homeAddons.map(async addon => {
      const base = (addon.url || '').replace(/\/+$/, '')
      const data = await fetchDeadline(`${base}/ui/home`)
      const shelves = sanitizeShelves(data?.shelves, addon.manifest.ui.home.shelves)
      return { addon, shelves }
    })).then(results => {
      if (cancelled) return
      const ok = results
        .filter(r => r.status === 'fulfilled' && r.value.shelves.length > 0)
        .map(r => r.value)
      setAddonShelves(ok)
    })
    return () => { cancelled = true }
  }, [addons])

  const flattenedAddonShelves = useMemo(() => {
    const out = []
    for (const { addon, shelves } of addonShelves) {
      for (const sh of shelves) out.push({ addon, shelf: sh })
    }
    return out.sort((a, b) => (a.shelf.sort_priority ?? 100) - (b.shelf.sort_priority ?? 100))
  }, [addonShelves])

  const recentPlays = recentPlayed
  const enabledAddonCount = addons.filter(a => a.enabled !== false).length

  const isEmpty =
    !loading &&
    recentSaved.length === 0 &&
    continueBooks.length === 0 &&
    recentPlays.length === 0 &&
    flattenedAddonShelves.length === 0

  const playSavedTrack = async (entry) => {
    try {
      const data = await resolveCacheEntry({ key: entry.key, apiKey })
      if (!data || !data.streamUrl) {
        setPickerTrack({
          title: entry.track_title,
          artist: entry.track_artist,
          album: entry.track_album || '',
          kind: entry.kind || 'music',
        })
        return
      }
      playNow({
        title: entry.track_title,
        artist: entry.track_artist,
        // /api/cache/list returns the cover as `albumCover`
        // (camelCase). Fall through to `album_cover` and `cover`
        // for any caller that hands us a normalized shape.
        albumCover: entry.albumCover || entry.album_cover || entry.cover || '',
        streamUrl: data.streamUrl,
        mimeType: data.mimeType || 'audio/mpeg',
        cacheKey: entry.key,
      })
    } catch {
      setPickerTrack({
        title: entry.track_title,
        artist: entry.track_artist,
        kind: entry.kind || 'music',
      })
    }
  }

  // Recently-played history rows don't carry a cache_key — they
  // capture what was played, not how. Look up the title+artist
  // against the current cache via /api/cache/check; if there's a
  // hit we can replay from cache (re-resolves a fresh stream URL,
  // handling expired RD links etc.). Falls back to the picker
  // when the track was never saved or got removed.
  const playNewEpisode = (ep) => {
    const localUrl = ep.local_file
      ? `/api/files/local?path=${encodeURIComponent(ep.local_file)}`
      : null
    const streamUrl = localUrl || ep.audio_url
    if (!streamUrl) return
    playNow({
      title: ep.title || 'Episode',
      artist: ep.show_title || 'Podcast',
      albumCover: ep.artwork || null,
      streamUrl,
      source: ep.local_file ? 'Downloaded' : 'Podcast',
      podcastEpisodeId: ep.id,
      streamStartOffset: ep.position_s || 0,
    })
    showToast?.(`▶ ${ep.title || 'Episode'}`)
  }

  const playFromHistory = async (entry) => {
    const title = entry.track_title || ''
    const artist = entry.track_artist || ''
    try {
      const r = await authFetch('/api/cache/check', {
        method: 'POST',
        body: JSON.stringify({ tracks: [{ title, artist }] }),
      })
      const d = r.ok ? await r.json() : null
      const key = `${artist.toLowerCase().trim()}|${title.toLowerCase().trim()}`
      const cached = d?.cached?.[key]
      if (cached?.cache_key) {
        const data = await resolveCacheEntry({ key: cached.cache_key, apiKey })
        if (data?.streamUrl) {
          playNow({
            title,
            artist,
            albumCover: entry.album_cover || '',
            streamUrl: data.streamUrl,
            mimeType: data.mimeType || 'audio/mpeg',
            cacheKey: cached.cache_key,
          })
          return
        }
      }
    } catch {}
    // Cache miss or resolve failure — fall through to picker so
    // the user can pick a fresh source.
    setPickerTrack({
      title,
      artist,
      album: entry.track_album || '',
      kind: 'music',
    })
  }

  const playAddonItem = (item) => {
    const sel = item?.on_select
    if (!sel || sel.type === 'noop') return
    if (sel.type === 'play') {
      setPickerTrack({
        title: sel.track?.title || item.title || '',
        artist: sel.track?.artist || item.subtitle || '',
        album: sel.track?.album || '',
        kind: sel.track?.kind || 'music',
      })
    } else if (sel.type === 'open_url') {
      if (typeof sel.url === 'string' && sel.url.startsWith('https://'))
        window.open(sel.url, '_blank', 'noopener')
    }
  }

  return (
    <div className={styles.wrap}>
      <header className={styles.pageHead}>
        <div>
          <h1 className={styles.title}>Home</h1>
          <div className={styles.subtitle}>{fmtToday()}</div>
        </div>
        <div className={styles.meta}>
          {enabledAddonCount} {enabledAddonCount === 1 ? 'ADDON' : 'ADDONS'} ONLINE
        </div>
      </header>

      {isEmpty && (
        <div className={styles.emptyCard}>
          <h2 className={styles.emptyTitle}>Nothing here yet</h2>
          <p className={styles.emptyBody}>
            Add an addon to start discovering music and audiobooks, or jump to
            Search if you already know what you're looking for.
          </p>
          <div className={styles.emptyButtons}>
            <button className={styles.primaryBtn} onClick={() => setView('addons')}>
              Browse addons
            </button>
            <button className={styles.secondaryBtn} onClick={() => setView('search')}>
              Open Search
            </button>
          </div>
        </div>
      )}

      <div className={styles.layoutNoRail}>
        <div className={styles.sections}>
        {continueBooks.length > 0 && (
          <Section title="Continue listening" tag="audiobooks">
            {continueBooks.map(b => (
              <Row
                key={b.id}
                image={b.cover}
                title={b.title}
                sub={`${b.author || ''} · ${Math.round(b.pct * 100)}% · ${fmtTimeRemaining(b.duration - b.position)}`}
                onClick={() => openAudiobookDetail(b.id)}
              />
            ))}
          </Section>
        )}

        {newEpisodes.length > 0 && (
          <Section
            title="New episodes"
            tag="podcasts"
            action={<button className={styles.actionLink} onClick={() => setView('podcasts')}>Podcasts →</button>}
          >
            {newEpisodes.map(ep => (
              <Row
                key={ep.id}
                image={ep.artwork}
                title={ep.title}
                sub={`${ep.show_title || 'Podcast'} · ${fmtAge(ep.pub_date)}${ep.duration_s ? ` · ${fmtMinutes(ep.duration_s)}` : ''}`}
                onClick={() => playNewEpisode(ep)}
              />
            ))}
          </Section>
        )}

        {recentPlays.length > 0 && (
          <Section title="Recently played" action={<button className={styles.actionLink} onClick={() => setView('history')}>Full history →</button>}>
            {recentPlays.map((t, i) => (
              <Row
                key={`rp-${i}-${t.played_at}`}
                image={t.album_cover}
                title={t.track_title}
                sub={t.track_artist}
                right={t.source}
                onClick={() => playFromHistory(t)}
              />
            ))}
          </Section>
        )}

        {/* Top this month — server-side aggregate of play_history.
            Hidden until at least 4 tracks have plays in the 30-day
            window; otherwise it reads as broken on a fresh install. */}
        {topThisMonth.length >= 4 && (
          <Section
            title="Top this month"
            tag="stats"
          >
            {topThisMonth.map((t, i) => (
              <Row
                key={`top-${i}-${t.track_title}-${t.track_artist}`}
                image={t.album_cover}
                title={t.track_title}
                sub={t.track_artist}
                right={`${t.play_count} play${t.play_count === 1 ? '' : 's'}`}
                onClick={() => playFromHistory(t)}
              />
            ))}
          </Section>
        )}

        {recentSaved.length > 0 && (
          <Section title="Recently added" tag="library" action={<button className={styles.actionLink} onClick={() => setView('library')}>Library →</button>}>
            {recentSaved.map(e => (
              <Row
                key={e.key}
                image={e.albumCover || e.album_cover || e.cover}
                title={e.track_title}
                sub={e.track_artist}
                onClick={() => playSavedTrack(e)}
              />
            ))}
          </Section>
        )}

        {flattenedAddonShelves.map(({ addon, shelf }) => (
          <Section
            key={`${addon.id}::${shelf.id}`}
            title={shelf.title}
            tag={addon.manifest?.display?.label || addon.manifest?.name}
          >
            {shelf.layout === 'grid' ? (
              <div className={styles.grid}>
                {shelf.items.map(item => (
                  <GridCard
                    key={item.id}
                    title={item.title}
                    subtitle={item.subtitle}
                    image={item.image}
                    badges={item.badges}
                    onClick={() => playAddonItem(item)}
                  />
                ))}
              </div>
            ) : (
              shelf.items.map(item => (
                <Row
                  key={item.id}
                  image={item.image}
                  title={item.title}
                  sub={item.subtitle}
                  badges={item.badges}
                  onClick={() => playAddonItem(item)}
                />
              ))
            )}
          </Section>
        ))}
        </div>
      </div>

      {pickerTrack && (
        <SourcePicker track={pickerTrack} onClose={() => setPickerTrack(null)} />
      )}
    </div>
  )
}

function Section({ title, tag, action, children }) {
  return (
    <section className={styles.section}>
      <header className={styles.sectionHead}>
        <div className={styles.sectionTitleGroup}>
          <h2 className={styles.sectionTitle}>{title}</h2>
          {tag && <span className={styles.sectionTag}>{tag}</span>}
        </div>
        {action}
      </header>
      <div className={styles.sectionBody}>{children}</div>
    </section>
  )
}

function Row({ image, title, sub, right, badges, onClick }) {
  return (
    <button
      type="button"
      className={styles.row}
      onClick={onClick}
    >
      <div className={styles.rowThumb}>
        {image
          ? <img src={image} alt="" className={styles.rowImg} loading="lazy" />
          : <span className={styles.rowMono}>{(title || '?')[0].toUpperCase()}</span>
        }
      </div>
      <div className={styles.rowMeta}>
        <div className={styles.rowTitle}>{title}</div>
        {sub && <div className={styles.rowSub}>{sub}</div>}
      </div>
      {badges && badges.length > 0 && (
        <div className={styles.rowBadges}>
          {badges.map(b => <span key={b} className={styles.badge}>{b}</span>)}
        </div>
      )}
      {right && <div className={styles.rowRight}>{right}</div>}
    </button>
  )
}

function GridCard({ title, subtitle, image, badges, onClick }) {
  return (
    <div
      className={styles.gridCard}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
    >
      <div className={styles.cover}>
        {image
          ? <img src={image} alt="" className={styles.coverImg} loading="lazy" />
          : <span className={styles.monogram}>{(title || '?')[0].toUpperCase()}</span>
        }
        {badges && badges.length > 0 && (
          <div className={styles.gridBadges}>
            {badges.map(b => <span key={b} className={styles.badge}>{b}</span>)}
          </div>
        )}
      </div>
      <div className={styles.cardTitle}>{title}</div>
      {subtitle && <div className={styles.cardSub}>{subtitle}</div>}
    </div>
  )
}
