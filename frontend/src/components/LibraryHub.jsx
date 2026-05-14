import { useState, useEffect, useCallback, useRef } from 'react'
import { useStore } from '../store'
import { authFetch } from '../api'
import { useDownloadJobs, findJob } from '../hooks/useDownloadJobs'
import * as registry from '../addons/registry'
import LibraryView from './LibraryView'
import styles from './LibraryHub.module.css'

// "Music" page shell — design v2. Owns the page header (stat line +
// h1 "Music"), the tab strip (Songs / Albums / Artists), the filter
// chip row, the sort dropdown, and the list/grid view toggle.
// Dispatches the body to LibraryView and passes its toolbar state
// down via controlled props.
//
// Audiobooks and Podcasts are sibling top-level sidebar entries
// under the Library group, so this hub is music-only.
const TABS = [
  { id: 'songs',     label: 'Songs' },
  { id: 'albums',    label: 'Albums' },
  { id: 'artists',   label: 'Artists' },
  // Playlists isn't a sub-view of LibraryHub — it's its own
  // top-level view (PlaylistsView). Tapping the tab routes there
  // instead of changing the local `tab` state, so users on mobile
  // can reach playlists from the Music shell without needing the
  // More sheet.
  { id: 'playlists', label: 'Playlists', externalView: 'playlists' },
]

const SORT_OPTIONS = [
  { id: 'recent',    label: 'Recently added' },
  { id: 'title-az',  label: 'Title A–Z' },
  { id: 'artist-az', label: 'Artist A–Z' },
]

export default function LibraryHub() {
  const apiKey = useStore(s => s.apiKey)
  const cacheVersion = useStore(s => s.cacheVersion)
  const bumpCacheVersion = useStore(s => s.bumpCacheVersion)
  // Renamed to `navigateTo` so it doesn't shadow the local
  // `[view, setView]` state hook below (which is list/grid mode).
  const navigateTo = useStore(s => s.setView)
  const playlists = useStore(s => s.playlists)
  const [tab, setTab] = useState('songs')
  const [query, setQuery] = useState('')
  const [sortMode, setSortMode] = useState('recent')
  const [view, setView] = useState('list')
  // Set to truthy when LibraryView drills into an album/artist
  // detail page. We hide the search/sort toolbar in that mode —
  // those controls are for the top-level library list, not for the
  // 12 tracks on a single album.
  const [isDrilled, setIsDrilled] = useState(false)
  // Lossless / added-this-week filter chips were removed (clutter, low
  // usage). LibraryView's API still accepts a `controlledFilters` prop
  // so we hand it a frozen all-off object instead of ripping that arg
  // out, keeping this commit small and reversible.
  const filters = { lossless: false, addedThisWeek: false }

  // Bump cacheVersion whenever a download (audiobook or music) lands,
  // so the count row + audiobook list re-fetches without the user
  // having to refresh. Without this, the user clicks Download on a
  // book, the file lands in audiobook_library, but the visible
  // "N audiobooks" stays stuck at the pre-download number.
  const downloadJobs = useDownloadJobs()
  const lastBumpRef = useRef(0)
  useEffect(() => {
    const justDone = downloadJobs.find(j =>
      (j.kind === 'audiobook' || j.kind === 'music') &&
      j.status === 'done' &&
      j.finished_at && j.finished_at > lastBumpRef.current
    )
    if (justDone) {
      lastBumpRef.current = justDone.finished_at
      bumpCacheVersion()
    }
  }, [downloadJobs, bumpCacheVersion])

  // Aggregate stats line — track count + audiobook count + lossless
  // ratio, all from /api/cache/list. Refreshed on cacheVersion bumps.
  const [stats, setStats] = useState({ tracks: 0, books: 0, lossless: 0, lossy: 0 })
  useEffect(() => {
    let cancelled = false
    Promise.all([
      authFetch('/api/cache/list').then(r => r.ok ? r.json() : null).catch(() => null),
      // Audiobook count comes from the dedicated audiobook_library
      // table, not the music cache. Cache-side `category=='audiobook'`
      // entries are a subset (only books that have been played) — using
      // them undercounts. Fall back to that subset if the audiobooks
      // endpoint is unreachable.
      authFetch('/api/audiobooks/library').then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([cache, ab]) => {
      if (cancelled) return
      const entries = ((cache && cache.entries) || []).filter(registry.entryIsResolvableOnDevice)
      let tracks = 0, lossless = 0, lossy = 0
      for (const e of entries) {
        if (e.category === 'audiobook' || e.kind === 'audiobook') continue
        tracks++
        const m = (e.mime_type || '').toLowerCase()
        const fn = (e.filename || '').toLowerCase()
        const isLossless = m.includes('flac') || m.includes('wav') || m.includes('alac')
          || fn.endsWith('.flac') || fn.endsWith('.wav')
        if (isLossless) lossless++
        else if (m || fn) lossy++
      }
      const books = Array.isArray(ab?.books)
        ? ab.books.length
        : entries.filter(e => e.category === 'audiobook' || e.kind === 'audiobook').length
      setStats({ tracks, books, lossless, lossy })
    })
    return () => { cancelled = true }
  }, [apiKey, cacheVersion])

  // Counts surfaced from LibraryView so the tab strip can render
  // current-filter-aware counts (e.g. Songs · 47 vs. 1247 when a
  // chip is active).
  const [counts, setCounts] = useState({ songs: 0, albums: 0, artists: 0 })
  // Memoized so LibraryView's effect doesn't fire on every render
  // (parent re-renders ≠ new function identity for a child callback).
  const onCountsChange = useCallback((c) => {
    setCounts(prev => (prev.songs === c.songs && prev.albums === c.albums && prev.artists === c.artists)
      ? prev : c)
  }, [])

  const tabCount = (id) => {
    if (id === 'songs')     return counts.songs
    if (id === 'albums')    return counts.albums
    if (id === 'artists')   return counts.artists
    if (id === 'playlists') return Array.isArray(playlists) ? playlists.length : null
    return null
  }

  return (
    <div className={styles.wrap}>
      <header className={styles.pageHead}>
        <div>
          <div className={styles.statLine}>
            {stats.tracks.toLocaleString()} {stats.tracks === 1 ? 'track' : 'tracks'}
          </div>
          <h1 className={styles.title}>Music</h1>
        </div>
      </header>

      <nav className={styles.tabBar}>
        {TABS.map(t => {
          const c = tabCount(t.id)
          // externalView tabs route to a top-level view rather than
          // swapping inline content. They never show as "active" in
          // LibraryHub because navigating away unmounts it.
          const onClick = t.externalView
            ? () => navigateTo(t.externalView)
            : () => setTab(t.id)
          return (
            <button
              key={t.id}
              type="button"
              className={`${styles.tab} ${tab === t.id && !t.externalView ? styles.tabActive : ''}`}
              onClick={onClick}
            >
              {t.label}
              {c != null && <span className={styles.tabCount}>{c}</span>}
            </button>
          )
        })}
      </nav>

      {/* Toolbar — search · sort · view. Hidden on album/artist
          detail pages where the filtering UI is overkill for the
          handful of tracks shown. */}
      {!isDrilled && (
        <div className={styles.toolbar}>
          <input
            className={styles.search}
            type="search"
            inputMode="search"
            enterKeyHint="search"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="Search your music…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          <div className={styles.toolbarRight}>
            <div className={styles.sortBox}>
              <span className={styles.sortLabel}>Sort</span>
              <select
                className={styles.sortSelect}
                value={sortMode}
                onChange={e => setSortMode(e.target.value)}
              >
                {SORT_OPTIONS.map(o => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      )}

      {/* Body — single LibraryView rendering the active music tab. */}
      <div className={styles.body}>
        <div style={{ display: 'contents' }}>
          <LibraryView
            shellMode
            controlledTab={tab}
            controlledQuery={query}
            controlledSortMode={sortMode}
            controlledView={view}
            controlledFilters={filters}
            onCountsChange={onCountsChange}
            onDrillChange={(d) => setIsDrilled(!!d)}
          />
        </div>
      </div>
    </div>
  )
}

