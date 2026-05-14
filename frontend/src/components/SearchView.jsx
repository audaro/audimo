import { useState, useEffect, useRef, useMemo } from 'react'
import { useStore } from '../store'
import {
  authFetch, searchArtists, searchTracks, resolveCacheEntry,
  addToCache,
} from '../api'
import * as orchestrator from '../addons/orchestrator'
import * as registry from '../addons/registry'
import { resolveAndPlayDefault, buildCacheBody } from '../addons/defaultSource'
import { fanOutSearch } from './AddonTabView'
import SourcePicker from './SourcePicker'
import ArtistDetailView from './ArtistDetailView'
import Monogram from './Monogram'
import styles from './SearchView.module.css'

// Open Library covers ship as -L by default; -M is plenty for grids.
function shrinkCover(url) {
  if (!url) return url
  return url.replace(/-L\.jpg($|\?)/i, '-M.jpg$1')
}

function libraryKey(title, artist) {
  return `${(artist || '').toLowerCase().trim()}|${(title || '').toLowerCase().trim()}`
}

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'songs', label: 'Songs' },
  { id: 'artists', label: 'Artists' },
  { id: 'books', label: 'Audiobooks' },
  { id: 'podcasts', label: 'Podcasts' },
]

export default function SearchView() {
  const {
    recentSearches, addRecentSearch, removeRecentSearch,
    playNow, showToast, bumpCacheVersion,
    defaultSourceAddonId,
    cacheVersion,
    setView,
    openPodcastDetail,
    openPodcastPreview,
  } = useStore()
  // Per-row "saving via +" busy state so the user gets visible
  // feedback during the resolve+save round-trip.
  const [savingRowKey, setSavingRowKey] = useState(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [tracks, setTracks] = useState(null)    // null = not searched
  const [artists, setArtists] = useState(null)
  const [books, setBooks] = useState(null)
  const [podcasts, setPodcasts] = useState(null)
  // When non-null, the search results are hidden and an
  // ArtistDetailView takes over the SearchView surface.
  const [selectedArtist, setSelectedArtist] = useState(null)
  // Map: libraryKey(title, artist) → cache key. Lets us both flag rows
  // with the ✓ chip AND skip the picker when the user clicks a row
  // they've already saved (just resolve + play).
  const [libraryMap, setLibraryMap] = useState(new Map())
  const [pickerTrack, setPickerTrack] = useState(null)
  // Inline source-picker expansion. Only one row open at a time —
  // opening another one collapses the prior. Modal SourcePicker
  // (other surfaces) is unaffected; this is Search-only.
  const [expandedRowKey, setExpandedRowKey] = useState(null)
  // ⌘K refocus support — App.jsx bumps a counter; we watch it and
  // re-focus + select the input so the next keystroke replaces.
  const searchInputRef = useRef(null)
  const searchFocusKick = useStore(s => s.searchFocusKick)
  useEffect(() => {
    if (!searchInputRef.current) return
    searchInputRef.current.focus()
    searchInputRef.current.select?.()
  }, [searchFocusKick])
  const [addonSearchResults, setAddonSearchResults] = useState([]) // [{addon, sections}]
  const debounceRef = useRef(null)
  const lastQueryRef = useRef('')

  // Snapshot of saved tracks for "✓ In your library" badges. Pulled
  // from the same /api/cache/list path the Library views use.
  useEffect(() => {
    // 60s poll instead of 8s. The library map only changes when the
    // user adds / removes a track, and the global cacheVersion bump
    // (`bumpCacheVersion` in saveStreaming, addon flows, library views)
    // already triggers an immediate refresh on user action. Polling
    // exists purely as a backstop for cross-tab / cross-device edits.
    let aborter = new AbortController()
    const refresh = () => {
      // Abort any in-flight fetch so an unmount mid-roundtrip doesn't
      // setState on a stale component (and we don't queue duplicate
      // work if the user navigates away then back quickly).
      aborter.abort()
      aborter = new AbortController()
      authFetch('/api/cache/list', { signal: aborter.signal })
        .then(r => r.ok ? r.json() : null)
        .then(d => {
          if (!d) return
          const map = new Map()
          for (const e of (d.entries || [])) {
            map.set(libraryKey(e.track_title, e.track_artist), e.key)
          }
          setLibraryMap(map)
        })
        .catch(() => {})
    }
    refresh()
    const id = setInterval(refresh, 60_000)
    return () => { clearInterval(id); aborter.abort() }
  }, [cacheVersion])

  // Addons that contribute to the unified search bar. Either:
  //   • ui.search capability (chip integration — primary path)
  //   • ui.tab capability with tab.search:true (legacy / dual-surface)
  // Dedup on addon.id so an addon advertising both shows up once.
  const addons = useStore(s => s.addons)
  const searchableAddons = useMemo(() => {
    const byId = new Map()
    for (const a of (addons || [])) {
      if (a.enabled === false) continue
      const caps = a.manifest?.capabilities || []
      if (caps.includes('ui.search')) byId.set(a.id, a)
      else if (caps.includes('ui.tab') && a.manifest?.ui?.tab?.search === true) byId.set(a.id, a)
    }
    return [...byId.values()]
  }, [addons])

  // Fan out to searchable addons. When the "all" chip is active we
  // call every one of them; when an addon-specific chip is active we
  // call only that addon. Results appear after the built-in sections.
  useEffect(() => {
    const q = query.trim()
    if (!q) { setAddonSearchResults([]); return }
    let targets = []
    if (filter === 'all') {
      targets = searchableAddons
    } else if (filter.startsWith('addon:')) {
      const id = filter.slice('addon:'.length)
      const a = searchableAddons.find(x => x.id === id)
      if (a) targets = [a]
    }
    if (!targets.length) { setAddonSearchResults([]); return }
    let cancelled = false
    fanOutSearch(targets, q).then(results => {
      if (!cancelled) setAddonSearchResults(results)
    })
    return () => { cancelled = true }
  }, [query, filter, searchableAddons])

  // Live debounced search. 200 ms feels instant without flooding the
  // network on every keystroke. Empty query clears all sections.
  useEffect(() => {
    clearTimeout(debounceRef.current)
    const q = query.trim()
    if (!q) {
      setTracks(null); setArtists(null); setBooks(null); setPodcasts(null)
      setAddonSearchResults([])
      lastQueryRef.current = ''
      return
    }
    debounceRef.current = setTimeout(() => {
      lastQueryRef.current = q
      // Each source races independently — slowest doesn't block the
      // fastest from rendering. Stale results (older than the current
      // query) are discarded by comparing against lastQueryRef.
      const isFresh = () => lastQueryRef.current === q
      searchTracks(q).then(d => isFresh() && setTracks(d.tracks || [])).catch(() => isFresh() && setTracks([]))
      searchArtists(q).then(d => isFresh() && setArtists(d.artists || [])).catch(() => isFresh() && setArtists([]))
      authFetch(`/api/search/audiobooks?q=${encodeURIComponent(q)}&limit=10`).then(r => r.ok ? r.json() : { books: [] }).then(d => isFresh() && setBooks(d.books || [])).catch(() => isFresh() && setBooks([]))
      authFetch(`/api/podcasts/search?q=${encodeURIComponent(q)}`).then(r => r.ok ? r.json() : { results: [] }).then(d => isFresh() && setPodcasts(d.results || [])).catch(() => isFresh() && setPodcasts([]))
    }, 200)
    return () => clearTimeout(debounceRef.current)
  }, [query])

  const onSubmit = () => {
    const q = query.trim()
    if (q) addRecentSearch(q)
  }

  const showSongs = filter === 'all' || filter === 'songs'
  const showArtists = filter === 'all' || filter === 'artists'
  const showBooks = filter === 'all' || filter === 'books'
  const showPodcasts = filter === 'all' || filter === 'podcasts'
  const showAddonSearch = filter === 'all' || filter.startsWith('addon:')

  const songsVisible = useMemo(() => (tracks || []).map(t => {
    const cacheKey = libraryMap.get(libraryKey(t.title, t.artist)) || null
    return { ...t, saved: !!cacheKey, cacheKey }
  }), [tracks, libraryMap])

  const booksVisible = useMemo(() => (books || []).map(b => {
    const cacheKey = libraryMap.get(libraryKey(b.title, b.author)) || null
    return { ...b, saved: !!cacheKey, cacheKey }
  }), [books, libraryMap])

  // Click handler for song rows. If the track is already in the
  // library, resolve + play directly — opening SourcePicker on a
  // track the user already owns is redundant and confusing.
  const onSongClick = async (t) => {
    if (t.cacheKey) {
      const showToast = useStore.getState().showToast
      showToast('Loading…')
      try {
        const d = await resolveCacheEntry({ key: t.cacheKey })
        if (d?.streamUrl) {
          useStore.getState().playNow({
            title: t.title,
            artist: t.artist,
            albumCover: t.album_cover || t.cover || null,
            streamUrl: d.streamUrl,
            source: d.source,
          })
          return
        }
        showToast('Could not load track')
      } catch {
        showToast('Could not load track')
      }
      return
    }

    // Default-source mode: skip the picker, resolve + play from the
    // user's chosen addon directly. No library save on play — that's
    // an explicit action via the row's + button. Falls back to the
    // picker if the default addon is unreachable / returns nothing,
    // OR if the resolve+stream takes longer than DEFAULT_PLAY_TIMEOUT_MS
    // (uncached torrents, slow debrid downloads — those belong in
    // the picker where the user can see progress).
    if (defaultSourceAddonId) {
      showToast('Loading…')
      const track = {
        title: t.title,
        artist: t.artist,
        album: t.album || '',
        album_cover: t.album_cover || t.cover || '',
      }
      const DEFAULT_PLAY_TIMEOUT_MS = 15000
      const ctrl = new AbortController()
      const timeoutP = new Promise((resolve) => {
        setTimeout(() => {
          ctrl.abort()
          resolve({ ok: false, reason: 'timeout' })
        }, DEFAULT_PLAY_TIMEOUT_MS)
      })
      const result = await Promise.race([
        resolveAndPlayDefault(
          { addonId: defaultSourceAddonId, track },
          { signal: ctrl.signal },
        ),
        timeoutP,
      ])
      if (result.ok) {
        playNow({
          title: track.title,
          artist: track.artist,
          albumCover: track.album_cover || result.ready.albumCover || null,
          streamUrl: result.ready.streamUrl,
          mimeType: result.ready.mimeType,
          source: result.ready.source || result.source.source || '',
        })
        return
      }
      // Soft fall-through to the picker on every failure mode —
      // including the "noisy" ones. The default-source mode is a
      // *preference*, not a hard rule, so a momentary failure
      // shouldn't bombard the user with an error toast. The picker
      // itself is the recovery affordance; surfacing it silently
      // matches what the user expects.
      //
      // Only surface a toast when the default addon is missing
      // entirely (configuration error, not a transient failure).
      if (result.reason === 'no_addon') {
        showToast('Default source is no longer installed — picker reopened')
      }
    }

    setPickerTrack({
      title: t.title,
      artist: t.artist,
      album: t.album || '',
      album_cover: t.album_cover || t.cover || '',
    })
  }

  // Save a search-row track to the library via the default-source
  // addon, without playing. Wired to the + button on each row when
  // default-source mode is on. Idempotent on the backend — the
  // /api/cache/add path overwrites if a row already exists for the
  // same (title, artist).
  const onSongSavePlus = async (e, t) => {
    e.stopPropagation()
    if (!defaultSourceAddonId) return
    const rowKey = t.id || `${t.title}|${t.artist}`
    setSavingRowKey(rowKey)
    try {
      const track = {
        title: t.title,
        artist: t.artist,
        album: t.album || '',
        album_cover: t.album_cover || t.cover || '',
      }
      const result = await resolveAndPlayDefault(
        { addonId: defaultSourceAddonId, track },
      )
      if (!result.ok) {
        const msg = {
          no_addon:           "Default source isn't available",
          no_sources:         `No results from ${defaultSourceAddonId} for "${t.title}"`,
          resolve_stream_err: 'Default source errored while resolving',
          no_stream_url:      "Default source didn't return a stream",
        }[result.reason] || 'Could not save track'
        showToast(msg)
        return
      }
      const cacheBody = buildCacheBody({ track, source: result.source, ready: result.ready })
      const r = await authFetch('/api/cache/add', {
        method: 'POST',
        body: JSON.stringify(cacheBody),
      })
      if (!r.ok) {
        const txt = await r.text().catch(() => '')
        showToast(`Save failed: HTTP ${r.status}${txt ? ' — ' + txt.slice(0, 80) : ''}`)
        return
      }
      showToast(`✓ Saved "${t.title}" to library`)
      // Refresh the library map immediately so the row flips to the
      // saved badge. ``bumpCacheVersion()`` re-fires the cacheVersion-
      // gated effect at line 80 above, which does the fetch with the
      // correct cache.list field names (``track_title``/
      // ``track_artist`` — not ``title``/``artist``). Previously this
      // call ran its own inline fetch with the wrong field names,
      // which briefly produced an empty libraryMap before the effect
      // healed it.
      bumpCacheVersion()
    } catch (err) {
      console.warn('[SearchView] onSongSavePlus failed:', err?.message || err)
      showToast(`Save failed: ${err?.message || err}`)
    } finally {
      setSavingRowKey(null)
    }
  }

  // Click handler for audiobook cards. Same shortcut as songs: if
  // the book is already in the library, resolve + play; otherwise
  // open the SourcePicker so the user can pick a source.
  const onBookClick = async (b) => {
    if (b.cacheKey) {
      const showToast = useStore.getState().showToast
      showToast('Loading…')
      try {
        const d = await resolveCacheEntry({ key: b.cacheKey })
        if (d?.streamUrl) {
          useStore.getState().playNow({
            title: b.title,
            artist: b.author || 'Audiobook',
            albumCover: b.cover || null,
            streamUrl: d.streamUrl,
            source: d.source || 'Audiobook',
          })
          return
        }
        showToast('Could not load audiobook')
      } catch {
        showToast('Could not load audiobook')
      }
      return
    }
    setPickerTrack({
      title: b.title,
      artist: b.author || '',
      album: b.title,
      album_cover: b.cover || '',
      kind: 'audiobook',
    })
  }

  // ─── Renderers ─────────────────────────────────────────────────

  // When the user is on the "all" filter, every section is capped
  // to a short preview so songs / artists / audiobooks all fit on
  // one screen. Switching to a specific filter (Songs / Artists /
  // Audiobooks) lifts the cap to the section's natural maximum.
  // Without this the All view is a wall of song rows the user has
  // to scroll past before they realize there are also artists or
  // audiobooks below.
  const isAll = filter === 'all'
  const songsCap    = isAll ? 6 : 25
  const artistsCap  = isAll ? 6 : 12
  const booksCap    = isAll ? 6 : 18
  const podcastsCap = isAll ? 6 : 18
  const renderSeeMore = (sectionFilter, totalCount, shownCount) => (
    shownCount < totalCount ? (
      <button
        type="button"
        className={styles.seeMore}
        onClick={() => setFilter(sectionFilter)}
      >
        See all {totalCount} →
      </button>
    ) : null
  )

  const renderSongs = () => (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>Songs</h2>
        <span className={styles.sectionCount}>{songsVisible.length}</span>
      </div>
      <div className={styles.songsList}>
        {songsVisible.slice(0, songsCap).map(t => {
          const rowKey = t.id || `${t.title}|${t.artist}`
          const isSaving = savingRowKey === rowKey
          const showPlus = !!defaultSourceAddonId && !t.saved
          const isExpanded = expandedRowKey === rowKey
          return (
            <div key={rowKey} className={styles.songRowWrap}>
              <div
                className={`${styles.songRow} ${isExpanded ? styles.songRowExpanded : ''}`}
                onClick={() => onSongClick(t)}
              >
                {t.album_cover || t.cover
                  ? <img className={styles.songCover} src={t.album_cover || t.cover} alt="" loading="lazy" decoding="async" />
                  : <div className={styles.songCoverFallback}><Monogram text={t.artist || t.title} /></div>}
                <span className={`${styles.cell} ${styles.songTitle}`}>{t.title}</span>
                <span className={`${styles.cell} ${styles.songArtist}`}>{t.artist}</span>
                <span className={styles.savedBadgeSlot}>
                  {t.saved && <span className={styles.savedBadge} title="In your library">✓</span>}
                  {/* Sources toggle — opens the inline picker without
                      committing to a play. Existing default-source path
                      stays the same (row click → instant play). */}
                  <button
                    type="button"
                    className={`${styles.sourcesBtn} ${isExpanded ? styles.sourcesBtnActive : ''}`}
                    title={isExpanded ? 'Hide sources' : 'Compare sources'}
                    onClick={(e) => {
                      e.stopPropagation()
                      setExpandedRowKey(isExpanded ? null : rowKey)
                    }}
                  >
                    Sources <span aria-hidden="true">{isExpanded ? '▴' : '▾'}</span>
                  </button>
                  {showPlus && (
                    <button
                      type="button"
                      className={styles.savePlusBtn}
                      title="Add to library"
                      onClick={(e) => onSongSavePlus(e, t)}
                      disabled={isSaving}
                    >
                      {isSaving ? '…' : '+'}
                    </button>
                  )}
                </span>
              </div>
              {isExpanded && (
                <SourcePicker
                  inline
                  track={{
                    title: t.title,
                    artist: t.artist,
                    album: t.album || '',
                    album_cover: t.album_cover || t.cover || '',
                    kind: 'music',
                  }}
                />
              )}
            </div>
          )
        })}
      </div>
      {renderSeeMore('songs', songsVisible.length, songsCap)}
    </div>
  )

  const renderArtists = () => (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>Artists</h2>
        <span className={styles.sectionCount}>{(artists || []).length}</span>
      </div>
      <div className={styles.artistsRow}>
        {(artists || []).slice(0, artistsCap).map(a => (
          <div
            key={a.id || a.name}
            className={styles.artistCard}
            onClick={() => setSelectedArtist(a)}
          >
            <div className={styles.artistAvatar}>
              {a.picture
                ? <img src={a.picture} alt="" loading="lazy" decoding="async" />
                : (a.name || '?').trim().charAt(0).toUpperCase()}
            </div>
            <div className={styles.artistName}>{a.name}</div>
          </div>
        ))}
      </div>
      {renderSeeMore('artists', (artists || []).length, artistsCap)}
    </div>
  )

  // Podcast cards: clicking opens a *preview* of the show — no
  // subscribe side-effect. The detail view fetches the feed live,
  // shows episodes, and offers a Subscribe button if the user
  // wants to follow it. If they're already subscribed, the
  // preview endpoint short-circuits and serves the persisted row,
  // so the detail view renders subscribed-mode chrome.
  const onPodcastClick = (p) => {
    openPodcastPreview(p.feed_url)
  }

  const renderPodcasts = () => (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>Podcasts</h2>
        <span className={styles.sectionCount}>{(podcasts || []).length}</span>
      </div>
      <div className={styles.booksGrid}>
        {(podcasts || []).slice(0, podcastsCap).map(p => (
          <div
            key={p.feed_url}
            className={styles.bookCard}
            onClick={() => onPodcastClick(p)}
          >
            <div className={styles.bookCover}>
              {p.artwork
                ? <img src={p.artwork} alt="" loading="lazy" decoding="async" />
                : <Monogram text={p.title || p.author} />}
            </div>
            <div className={styles.bookTitle}>{p.title}</div>
            <div className={styles.bookAuthor}>{p.author || '—'}</div>
          </div>
        ))}
      </div>
      {renderSeeMore('podcasts', (podcasts || []).length, podcastsCap)}
    </div>
  )

  const renderBooks = () => (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>Audiobooks</h2>
        <span className={styles.sectionCount}>{booksVisible.length}</span>
      </div>
      <div className={styles.booksGrid}>
        {booksVisible.slice(0, booksCap).map(b => (
          <div
            key={b.open_library_key || `${b.title}|${b.author}`}
            className={styles.bookCard}
            onClick={() => onBookClick(b)}
          >
            <div className={styles.bookCover}>
              {b.cover
                ? <img src={shrinkCover(b.cover)} alt="" loading="lazy" decoding="async" />
                : <Monogram text={b.author || b.title} />}
              {b.saved && <div className={styles.bookSavedOverlay}>✓ Saved</div>}
            </div>
            <div className={styles.bookTitle}>{b.title}</div>
            <div className={styles.bookAuthor}>{b.author || '—'}</div>
          </div>
        ))}
      </div>
      {renderSeeMore('books', booksVisible.length, booksCap)}
    </div>
  )

  // ─── Empty state ───────────────────────────────────────────────
  const empty = !query.trim()
  const noResults = !empty
    && (tracks || artists || books || podcasts) // at least one source returned
    && (tracks || []).length === 0
    && (artists || []).length === 0
    && (books || []).length === 0
    && (podcasts || []).length === 0
    && lastQueryRef.current === query.trim()

  // Artist drilldown takes over the SearchView surface entirely
  // (back button restores the search results state). Mount above the
  // normal return so we don't have to thread a giant ternary through
  // every section render.
  if (selectedArtist) {
    return (
      <ArtistDetailView
        artist={selectedArtist}
        onBack={() => setSelectedArtist(null)}
      />
    )
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.header}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>Search</h1>
        </div>
        <input
          ref={searchInputRef}
          className={styles.searchInput}
          type="search"
          inputMode="search"
          enterKeyHint="search"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
          placeholder="Search songs, artists, audiobooks, podcasts…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') onSubmit() }}
        />
        {query.trim() && (
          <div className={styles.chips}>
            {FILTERS.map(f => (
              <button
                key={f.id}
                className={`${styles.chip} ${filter === f.id ? styles.chipActive : ''}`}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
              </button>
            ))}
            {searchableAddons
              .slice()
              .sort((a, b) => {
                const sa = a.manifest?.ui?.search?.sort_priority
                  ?? a.manifest?.ui?.tab?.sort_priority ?? 100
                const sb = b.manifest?.ui?.search?.sort_priority
                  ?? b.manifest?.ui?.tab?.sort_priority ?? 100
                return sa - sb
              })
              .map(a => {
                const id = `addon:${a.id}`
                const label = a.manifest?.ui?.search?.label
                  ?? a.manifest?.ui?.tab?.label
                  ?? a.manifest?.name
                  ?? a.id
                return (
                  <button
                    key={id}
                    className={`${styles.chip} ${filter === id ? styles.chipActive : ''}`}
                    onClick={() => setFilter(id)}
                  >
                    {label}
                  </button>
                )
              })}
          </div>
        )}
      </div>

      {empty ? (
        <div className={styles.emptyState}>
          {recentSearches.length > 0 && (
            <section className={styles.emptySection}>
              <div className={styles.emptySectionLabel}>Recent searches</div>
              <div className={styles.recentChips}>
                {recentSearches.map(r => (
                  <span key={r} className={styles.recentChip}>
                    <button
                      type="button"
                      className={styles.recentChipText}
                      onClick={() => { setQuery(r); addRecentSearch(r) }}
                    >{r}</button>
                    <button
                      type="button"
                      className={styles.recentChipClear}
                      onClick={() => removeRecentSearch(r)}
                      title="Remove"
                      aria-label={`Remove "${r}" from recent searches`}
                    >×</button>
                  </span>
                ))}
              </div>
            </section>
          )}

          <section className={styles.emptySection}>
            <header className={styles.emptySectionHead}>
              <div className={styles.emptySectionTitleGroup}>
                <h2 className={styles.emptySectionTitle}>Searching</h2>
                <span className={styles.emptySectionTag}>
                  {searchableAddons.length} {searchableAddons.length === 1 ? 'addon' : 'addons'}
                </span>
              </div>
              <button
                type="button"
                className={styles.emptyActionLink}
                onClick={() => setView('addons')}
              >Manage →</button>
            </header>
            {searchableAddons.length === 0 ? (
              <div className={styles.emptyHint}>
                No search-capable addons installed. Add one from the Addons tab to search beyond your local library.
              </div>
            ) : (
              <div className={styles.addonList}>
                {searchableAddons.map(a => {
                  const label = a.manifest?.display?.label || a.manifest?.name || a.id
                  const caps = (a.manifest?.capabilities || []).filter(c => c.startsWith('search.') || c === 'ui.search')
                  return (
                    <div key={a.id} className={styles.addonRow}>
                      <span className={styles.addonDot} aria-hidden="true" />
                      <span className={styles.addonName}>{label}</span>
                      <span className={styles.addonCaps}>{caps[0] || 'search'}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          {recentSearches.length === 0 && searchableAddons.length === 0 && (
            <div className={styles.empty}>
              <p>Type to search across your local library and any installed search addons.</p>
            </div>
          )}
        </div>
      ) : noResults ? (
        <div className={styles.empty}>
          <p>No matches for "{query.trim()}"</p>
        </div>
      ) : (
        <>
          {(() => {
            // In "All" view, surface whichever section the user most
            // likely meant by ranking each section's top result against
            // the query. Exact match (e.g. "Darknet Diaries" / "Darknet
            // Diaries") beats prefix beats substring beats token
            // overlap. Other filters render in declared order.
            const q = (query.trim() || '').toLowerCase()
            const qTokens = q.split(/\s+/).filter(Boolean)
            const score = (text) => {
              if (!text || !q) return -1
              const t = text.toLowerCase()
              if (t === q) return 100
              if (t.startsWith(q)) return 80
              if (t.includes(q)) return 60
              const hits = qTokens.filter(tok => t.includes(tok)).length
              return qTokens.length > 0 ? Math.round(40 * hits / qTokens.length) : 0
            }
            const sections = [
              { key: 'songs', show: showSongs, count: songsVisible.length,
                score: score(songsVisible[0]?.title), render: renderSongs },
              { key: 'artists', show: showArtists, count: (artists || []).length,
                score: score((artists || [])[0]?.name), render: renderArtists },
              { key: 'books', show: showBooks, count: booksVisible.length,
                score: score(booksVisible[0]?.title), render: renderBooks },
              { key: 'podcasts', show: showPodcasts, count: (podcasts || []).length,
                score: score((podcasts || [])[0]?.title), render: renderPodcasts },
            ]
            const visible = sections.filter(s => s.show && s.count > 0)
            if (isAll) {
              visible.sort((a, b) => b.score - a.score)  // declared order is the stable tiebreak
            }
            return visible.map(s => <div key={s.key}>{s.render()}</div>)
          })()}
          {showAddonSearch && addonSearchResults.map(({ addon, sections }) =>
            sections.map(sec => sec.items.length > 0 && (
              <div key={`${addon.id}::${sec.id || sec.title}`} className={styles.section}>
                <div className={styles.sectionHeader}>
                  <h2 className={styles.sectionTitle}>
                    {addon.manifest?.ui?.tab?.label || addon.manifest?.name}
                    {sec.title ? ` — ${sec.title}` : ''}
                  </h2>
                </div>
                <div className={styles.songsList}>
                  {(sec.items || []).slice(0, 6).map(item => (
                    <div
                      key={item.id || item.title}
                      className={styles.songRow}
                      onClick={() => {
                        const sel = item.on_select
                        if (sel?.type === 'play') {
                          setPickerTrack({
                            title: sel.track?.title || item.title || '',
                            artist: sel.track?.artist || item.subtitle || '',
                            album: sel.track?.album || '',
                            kind: sel.track?.kind || 'music',
                          })
                        }
                      }}
                    >
                      {item.image
                        ? <img className={styles.songCover} src={item.image} alt="" loading="lazy" />
                        : <div className={styles.songCoverFallback}>{(item.title || '?')[0]}</div>
                      }
                      <span className={`${styles.cell} ${styles.songTitle}`}>{item.title}</span>
                      <span className={`${styles.cell} ${styles.songArtist}`}>{item.subtitle}</span>
                      <span className={styles.savedBadgeSlot} />
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </>
      )}

      {pickerTrack && (
        <SourcePicker track={pickerTrack} onClose={() => setPickerTrack(null)} />
      )}
    </div>
  )
}
