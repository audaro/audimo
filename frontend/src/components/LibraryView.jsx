import { useState, useEffect, useMemo, useRef } from 'react'
import { useStore } from '../store'
import { useDownloadJobs, findJob } from '../hooks/useDownloadJobs'
import EmptyState from './EmptyState'
import { authFetch, resolveCacheEntry, updateCacheEntry } from '../api'
import {
  normalizeTrack, groupByAlbum, groupByArtist, filterTracksFuzzy,
} from '../lib/library'
import EditTrackModal from './EditTrackModal'
import Monogram from './Monogram'
import Icon from './Icon'
import MobileSheet from './MobileSheet'
import useIsMobile from '../hooks/useIsMobile'
import * as registry from '../addons/registry'
import * as desktop from '../desktop'
import styles from './LibraryView.module.css'


function shrinkCover(url) {
  if (!url) return url
  return url.replace(/-L\.jpg($|\?)/i, '-M.jpg$1')
}

// Module-scope cache so navigating between Artists / drilldowns /
// re-renders doesn't re-fetch the same name. Map<lowerName, url|null>.
// `null` = "we asked and Wikipedia had nothing" — still cached so we
// don't loop on missing photos. `undefined` = "haven't asked yet."
const _artistPhotoMem = new Map()

// Bumped on artist-image upload so all ArtistAvatar instances pick
// up the new override without remounting.
let _artistPhotoVersion = 0
const _artistPhotoListeners = new Set()
function bumpArtistPhotoCache(name) {
  if (name) _artistPhotoMem.delete(name.trim().toLowerCase())
  _artistPhotoVersion += 1
  for (const fn of _artistPhotoListeners) fn(_artistPhotoVersion)
}

function ArtistAvatar({ name, small = false, large = false }) {
  const initial = (name || '?').trim().charAt(0).toUpperCase() || '?'
  const cacheKey = (name || '').trim().toLowerCase()
  const [photoUrl, setPhotoUrl] = useState(
    cacheKey && _artistPhotoMem.has(cacheKey) ? _artistPhotoMem.get(cacheKey) : null
  )
  // Subscribe to global invalidations (custom-image uploads).
  const [, setVersion] = useState(_artistPhotoVersion)
  useEffect(() => {
    const fn = (v) => setVersion(v)
    _artistPhotoListeners.add(fn)
    return () => { _artistPhotoListeners.delete(fn) }
  }, [])
  useEffect(() => {
    if (!cacheKey) return
    if (_artistPhotoMem.has(cacheKey)) {
      setPhotoUrl(_artistPhotoMem.get(cacheKey))
      return
    }
    let cancelled = false
    // Custom upload wins; fall back to Deezer via /api/artist-photo.
    Promise.all([
      authFetch(`/api/library/artist-image?name=${encodeURIComponent(name)}`).then(r => r.ok ? r.json() : null).catch(() => null),
      authFetch(`/api/artist-photo?name=${encodeURIComponent(name)}`).then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([custom, deezer]) => {
      if (cancelled) return
      const url = custom?.url || deezer?.url || null
      _artistPhotoMem.set(cacheKey, url)
      setPhotoUrl(url)
    })
    return () => { cancelled = true }
  }, [cacheKey, name])

  const cls = [
    large ? styles.detailHeaderArtist : styles.artistAvatar,
    small ? styles.artistAvatarSmall : '',
  ].filter(Boolean).join(' ')
  if (photoUrl) {
    return (
      <div className={cls}>
        <img
          src={photoUrl}
          alt={name || ''}
          loading="lazy"
          decoding="async"
          onError={() => { _artistPhotoMem.set(cacheKey, null); setPhotoUrl(null) }}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      </div>
    )
  }
  return <div className={cls}>{initial}</div>
}

// Album drilldown header cover: prefers user-supplied override over
// the track-derived art. Lifted out of the conditional drilldown JSX
// because it needs its own useEffect.
function AlbumDetailCover({ album, artist, fallbackUrl, fallbackText, onUploaded }) {
  const [customUrl, setCustomUrl] = useState(null)
  const [version, setVersion] = useState(0)
  useEffect(() => {
    if (!album) return
    let cancelled = false
    const qs = `album=${encodeURIComponent(album)}&artist=${encodeURIComponent(artist || '')}`
    authFetch(`/api/library/album-image?${qs}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled) setCustomUrl(d?.url || null) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [album, artist, version])
  const url = customUrl || fallbackUrl
  return (
    <div className={styles.detailCover} style={{ position: 'relative' }}>
      {url ? <img src={url} alt="" /> : <Monogram text={fallbackText} />}
      <label
        title="Upload custom album image"
        style={{
          position: 'absolute', bottom: 6, right: 6, padding: '4px 8px',
          fontSize: 11, background: 'rgba(0,0,0,.6)', color: '#fff',
          borderRadius: 4, cursor: 'pointer',
        }}
      >
        Upload
        <input
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={async (e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (!file) return
            const form = new FormData()
            form.append('album', album)
            form.append('artist', artist || '')
            form.append('file', file)
            const r = await authFetch('/api/library/album-image', { method: 'POST', body: form })
            if (r.ok) { setVersion(v => v + 1); onUploaded?.() }
          }}
        />
      </label>
    </div>
  )
}

function CoverImg({ url, fallbackText = '' }) {
  // Monogrammed fallback when art is missing — replaces the old
  // emoji-glyph stand-in. `fallbackText` is what we draw initials
  // from (artist name for songs, album title for album cards).
  if (!url) return <Monogram text={fallbackText} />
  return <img src={shrinkCover(url)} alt="" loading="lazy" decoding="async" />
}

// `shellMode`: when true, LibraryView is rendered inside LibraryHub
// and the parent owns the page header, the 4-tab strip, search,
// sort, view-toggle, and filter chips. We accept those values as
// controlled props and skip rendering our own header chrome.
//
// When false (legacy mounts), we own everything ourselves.
export default function LibraryView({
  shellMode = false,
  controlledTab,
  controlledQuery,
  controlledSortMode,
  controlledView,           // 'list' | 'grid'  (only meaningful for albums/artists tabs)
  controlledFilters,        // { lossless?: bool, addedThisWeek?: bool }
  onCountsChange,           // ({songs, albums, artists}) => void  — used by shell to render tab counts
  onDrillChange,            // (drill | null) => void — shell hides its toolbar when drilled into an album/artist
} = {}) {
  const {
    apiKey, cacheVersion, showToast, loadQueue, addToQueue,
    playlists, addTrackToPlaylist, createPlaylist,
    bumpCacheVersion, currentTrack,
  } = useStore()
  // The playing row matches when (a) we tagged the current track with
  // a cache_key (head of a library-originated queue) or (b) when the
  // queue advances to a tail item which already carries cache_key.
  // Falling back on title+artist keeps the highlight working for the
  // initial click before cache_key is plumbed end-to-end.
  // Download jobs registry — lookup per-row to render an inline
  // download progress affordance and gate the Download button.
  const downloadJobs = useDownloadJobs()
  // When any music download finishes, the cache row's local_file
  // gets stamped — bump cacheVersion so the library view re-reads
  // /api/cache/list and the Download button hides on that row.
  const lastBumpRef = useRef(0)
  useEffect(() => {
    const justDone = downloadJobs.find(j =>
      j.kind === 'music' && j.status === 'done' &&
      j.finished_at && j.finished_at > lastBumpRef.current
    )
    if (justDone) {
      lastBumpRef.current = justDone.finished_at
      bumpCacheVersion()
    }
  }, [downloadJobs, bumpCacheVersion])
  const playingKey = currentTrack?.cache_key || null
  const playingTitleArtist = currentTrack
    ? `${(currentTrack.title || '').toLowerCase().trim()}|${(currentTrack.artist || '').toLowerCase().trim()}`
    : null
  const isPlayingRow = (t) => {
    if (!currentTrack) return false
    if (playingKey && playingKey === t.key) return true
    const k = `${(t.title || '').toLowerCase().trim()}|${((t.artist || t.primaryArtist) || '').toLowerCase().trim()}`
    return k === playingTitleArtist
  }
  const [allTracks, setAllTracks] = useState([])
  const [loaded, setLoaded] = useState(false)
  // Internal state — only used when shellMode=false. When the shell
  // controls these, the controlled* prop wins below.
  const [internalTab, setTab] = useState('songs')
  const [internalQuery, setQuery] = useState('')
  const [internalSort, setSortMode] = useState('default')
  const tab = shellMode ? (controlledTab || 'songs') : internalTab
  const query = shellMode ? (controlledQuery || '') : internalQuery
  // Debounced mirror for filterTracksFuzzy. The fuzzy filter runs a
  // full O(n) pass on every keystroke; with 5000+ tracks the input
  // visibly lags. 200ms latency is below the threshold where users
  // perceive the box as unresponsive, while skipping the inter-
  // keystroke storm.
  const [debouncedQuery, setDebouncedQuery] = useState(query)
  useEffect(() => {
    if (!query) { setDebouncedQuery(''); return }
    const id = setTimeout(() => setDebouncedQuery(query), 200)
    return () => clearTimeout(id)
  }, [query])
  const sortMode = shellMode ? (controlledSortMode || 'default') : internalSort
  const view = controlledView || 'grid'
  const filters = controlledFilters || {}
  const [drill, setDrill] = useState(null) // { kind, key }
  // Notify the shell when we drill into an album/artist so it can
  // hide its search/sort/filter toolbar — that bar makes no sense
  // on a finite detail page (one album = ~12 tracks, no filtering
  // needed).
  useEffect(() => { onDrillChange?.(drill) }, [drill, onDrillChange])

  // Action UI state
  const [editEntry, setEditEntry] = useState(null)
  const [playlistMenuFor, setPlaylistMenuFor] = useState(null) // track key
  const [newPlName, setNewPlName] = useState('')
  const [creatingPl, setCreatingPl] = useState(false)
  const isMobile = useIsMobile()
  // confirm/undo state removed; global ConfirmModal handles destructive prompts.

  // Self-heal heartbeat — covers the boot race that drops the first
  // /api/cache/list fetch.
  useEffect(() => {
    // Single fetch on mount + on cacheVersion bump. The previous
    // implementation polled every 4s for 32s after mount as a "still
    // loading" backstop, which compounded the boot-time hammer when
    // Sidebar + LibraryView + AudiobooksView all mounted on the same
    // tick (3 views × 8 ticks = 24 hits in 32s). Every mutation path
    // already calls bumpCacheVersion(), which re-fires this effect,
    // so the poll was redundant.
    let cancelled = false
    authFetch('/api/cache/list')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (cancelled) return
        if (d) {
          // Drop audiobook entries — they belong in the audiobooks
          // tab, not the music library. We check both `category`
          // (set by the startup backfill that mirrors audiobook_library
          // rows) AND `kind` (stamped by addons that produce audiobook
          // entries directly).
          const tracks = (d.entries || [])
            .filter(e => e.category !== 'audiobook' && e.kind !== 'audiobook')
            .map(normalizeTrack)
          setAllTracks(prev => {
            if (prev.length !== tracks.length) return tracks
            for (let i = 0; i < tracks.length; i++) {
              const a = prev[i], b = tracks[i]
              if (a.key !== b.key
                  || a.localFile !== b.localFile
                  || a.title !== b.title
                  || a.artist !== b.artist
                  || a.album !== b.album
                  || a.cover !== b.cover) {
                return tracks
              }
            }
            return prev
          })
        }
        // Mark loaded even on failure / empty response so the
        // spinner doesn't spin forever when the API key isn't yet
        // populated or the user truly has zero saved tracks. The
        // empty-state UI is the right thing to show in either case.
        setLoaded(true)
      })
      .catch(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [cacheVersion, apiKey])

  useEffect(() => { if (query) setDrill(null) }, [query])
  // Clear any open album/artist drilldown when the parent shell
  // switches the tab. Without this, clicking Songs from inside an
  // artist drilldown leaves you stuck on the artist page.
  useEffect(() => { setDrill(null) }, [tab])
  // Close playlist popover on outside click.
  useEffect(() => {
    if (!playlistMenuFor) return
    const close = () => setPlaylistMenuFor(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [playlistMenuFor])

  // ─── Derived data ──────────────────────────────────────────────
  // Chip filters (controlled by the shell): apply BEFORE fuzzy
  // search so a search-while-filtering hit is computed against the
  // filtered set, not the whole library.
  const SEVEN_DAYS_S = 7 * 24 * 3600
  const chipFiltered = useMemo(() => {
    let out = allTracks
    if (filters.lossless) {
      out = out.filter(t => t.quality === 'FLAC' || t.quality === 'WAV' || t.quality === 'ALAC')
    }
    if (filters.addedThisWeek) {
      const cutoff = Math.floor(Date.now() / 1000) - SEVEN_DAYS_S
      out = out.filter(t => (t.addedAt || 0) >= cutoff)
    }
    return out
  }, [allTracks, filters.lossless, filters.addedThisWeek])
  const filteredAll = useMemo(
    () => filterTracksFuzzy(debouncedQuery, chipFiltered),
    [debouncedQuery, chipFiltered],
  )
  const filtered = useMemo(() => {
    if (sortMode === 'default' || sortMode === 'recent') {
      if (sortMode === 'recent') {
        return [...filteredAll].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
      }
      return filteredAll
    }
    const cmp = sortMode === 'artist-az'
      ? (a, b) => (a.artist || a.primaryArtist || '').localeCompare(b.artist || b.primaryArtist || '')
                  || (a.title || '').localeCompare(b.title || '')
      : (a, b) => (a.title || '').localeCompare(b.title || '')
    return [...filteredAll].sort(cmp)
  }, [filteredAll, sortMode])
  const albums = useMemo(() => {
    const g = groupByAlbum(filtered)
    if (sortMode === 'default') return g
    return [...g].sort((a, b) =>
      sortMode === 'artist-az'
        ? (a.artist || '').localeCompare(b.artist || '') || a.album.localeCompare(b.album)
        : a.album.localeCompare(b.album)
    )
  }, [filtered, sortMode])
  const artists = useMemo(() => {
    const g = groupByArtist(filtered)
    if (sortMode === 'default') return g
    return [...g].sort((a, b) => a.name.localeCompare(b.name))
  }, [filtered, sortMode])

  // Surface counts up to the shell so it can label the tab strip.
  // Wrapped in an effect to avoid setState-in-render warnings.
  useEffect(() => {
    if (onCountsChange) {
      onCountsChange({ songs: filtered.length, albums: albums.length, artists: artists.length })
    }
  }, [filtered.length, albums.length, artists.length, onCountsChange])

  // Autocomplete sources for EditTrackModal — distinct artist + album
  // names already in the user's library.
  const allArtistNames = useMemo(
    () => Array.from(new Set(allTracks.map(t => t.primaryArtist).filter(Boolean))).sort(),
    [allTracks],
  )
  const allAlbumNames = useMemo(
    () => Array.from(new Set(allTracks.map(t => t.album).filter(Boolean))).sort(),
    [allTracks],
  )

  // ─── Playback ──────────────────────────────────────────────────
  // Resolve only the clicked track up-front. The rest of the list is
  // queued unresolved — Player.jsx's queueIdx effect resolves each as
  // it becomes active. Resolving N tracks in parallel up-front blasts
  // the addon with N simultaneous cache.resolve calls (rate-limited)
  // and, for legacy entries that fall through to a download path,
  // races N download jobs against the same on-disk destinations.
  const playFrom = async (clicked, list) => {
    console.log('[playFrom] clicked', { key: clicked.key, title: clicked.title, artist: clicked.artist })
    showToast('Loading…')
    let head
    try {
      const d = await resolveCacheEntry({ key: clicked.key, apiKey })
      console.log('[playFrom] resolved', { streamUrl: d?.streamUrl, source: d?.source })
      if (!d?.streamUrl) { showToast('Could not load track'); return }
      head = {
        title: clicked.title,
        artist: clicked.artist || clicked.primaryArtist,
        albumCover: clicked.cover || null,
        streamUrl: d.streamUrl,
        source: d.source,
        cache_key: clicked.key,
      }
    } catch (e) {
      console.warn('[playFrom] resolve threw', e)
      showToast('Could not load track'); return
    }
    const tailItems = list.filter(t => t.key !== clicked.key).map(t => ({
      title: t.title,
      artist: t.artist || t.primaryArtist,
      albumCover: t.cover || null,
      cache_key: t.key,
    }))
    console.log('[playFrom] loadQueue', { headTitle: head.title, headStreamUrl: head.streamUrl, tailCount: tailItems.length })
    loadQueue([head, ...tailItems], 0)
    // Read store state right after to confirm the set actually
    // updated currentTrack — if this prints My Band, something is
    // re-overwriting it post-set.
    queueMicrotask(() => {
      const s = useStore.getState()
      console.log('[playFrom] post-loadQueue store', {
        idx: s.queueIdx,
        currentTitle: s.currentTrack?.title,
        currentStreamUrl: s.currentTrack?.streamUrl,
      })
    })
    showToast('▶ Playing')
  }

  // ─── Edit / metadata changes ──────────────────────────────────
  const onSaved = (updated) => {
    setAllTracks(prev => prev.map(t => t.key === updated.key ? normalizeTrack({
      key: updated.key,
      type: updated.type,
      track_title: updated.track_title,
      track_artist: updated.track_artist,
      track_album: updated.track_album,
      albumCover: updated.albumCover,
      source: updated.source,
      addon_id: updated.addon_id,
      category: updated.category,
    }) : t))
  }

  // Bulk rename for album / artist drilldowns. Iterates the affected
  // tracks and calls /api/cache/update one by one. Slow for huge
  // collections but the API doesn't have a bulk variant yet.
  const bulkRename = async (tracks, patch, successMsg) => {
    showToast(`Renaming ${tracks.length} track${tracks.length === 1 ? '' : 's'}…`)
    let okCount = 0
    for (const t of tracks) {
      try {
        await updateCacheEntry({ key: t.key, ...patch })
        okCount += 1
      } catch (e) {
        console.warn('rename failed for', t.key, e)
      }
    }
    showToast(`${successMsg} (${okCount}/${tracks.length})`)
    bumpCacheVersion()
  }

  const renameArtist = async (oldName, newName, tracks) => {
    const target = (newName || '').trim()
    if (!target || target === oldName) return
    await bulkRename(tracks, { track_artist: target }, `Renamed artist → ${target}`)
    setDrill(null)
  }

  const renameAlbum = async (oldName, newName, tracks) => {
    const target = (newName || '').trim()
    if (!target || target === oldName) return
    await bulkRename(tracks, { track_album: target }, `Renamed album → ${target}`)
    setDrill(null)
  }

  // ─── Delete with confirm modal ────────────────────────────────
  // The earlier "10s undo" pattern made sense when deletes only
  // touched the library row. Now that we also unlink the audio file
  // from disk (~/Music/Audimo) the destruction is meaningful enough
  // to warrant a clear yes/no on the way in, not a hidden race
  // against a 10-second timer.
  const finalizeDelete = async (items) => {
    for (const t of items) {
      try {
        await authFetch('/api/cache/remove', {
          method: 'DELETE',
          body: JSON.stringify({ key: t.key }),
        })
      } catch (e) {
        console.warn('delete failed', t.key, e)
      }
    }
    setAllTracks(prev => prev.filter(t => !items.some(i => i.key === t.key)))
  }

  const requestDelete = async ({ items, label }) => {
    const { askConfirm } = useStore.getState()
    const what = items.length === 1
      ? `"${items[0].title}"`
      : `${items.length} tracks${label ? ` from ${label}` : ''}`
    const ok = await askConfirm({
      title: 'Remove from library',
      message:
        `Remove ${what} from your library?\n\n` +
        `This also deletes the audio file${items.length > 1 ? 's' : ''} from your computer (~/Music/Audimo).`,
      confirmLabel: 'Remove & delete file',
      cancelLabel: 'Keep',
      danger: true,
    })
    if (!ok) return
    finalizeDelete(items)
  }

  // ─── Add to playlist ──────────────────────────────────────────
  const onAddToPlaylist = (e, playlistId, entry) => {
    e.stopPropagation()
    addTrackToPlaylist(playlistId, {
      key: entry.key,
      track_title: entry.title,
      track_artist: entry.artist || entry.primaryArtist,
      track_album: entry.album,
      albumCover: entry.cover,
    })
    showToast('Added to playlist')
    setPlaylistMenuFor(null)
  }

  const onCreatePlaylist = async (e, entry) => {
    e.stopPropagation()
    const name = (newPlName || '').trim()
    if (!name) return
    setCreatingPl(true)
    try {
      const id = createPlaylist(name)
      addTrackToPlaylist(id, {
        key: entry.key,
        track_title: entry.title,
        track_artist: entry.artist || entry.primaryArtist,
        track_album: entry.album,
        albumCover: entry.cover,
      })
      showToast(`Created "${name}" and added`)
    } finally {
      setCreatingPl(false)
      setNewPlName('')
      setPlaylistMenuFor(null)
    }
  }

  // ─── Renderers ─────────────────────────────────────────────────

  const renderSongs = (tracks) => (
    <div className={styles.songs}>
      <div className={styles.songsHeader}>
        <span></span>
        <span>Title</span>
        <span>Artist</span>
        <span>Album</span>
        <span></span>
      </div>
      {tracks.map(t => {
        const playing = isPlayingRow(t)
        return (
        <div
          key={t.key}
          className={`${styles.songRow} ${playing ? styles.songRowActive : ''}`}
          onClick={() => playFrom(t, tracks)}
        >
          <div className={styles.coverSlot}>
            {playing && <span className={styles.playingMark}>▶</span>}
            {t.cover
              ? <img className={styles.songCover} src={shrinkCover(t.cover)} alt="" loading="lazy" decoding="async" />
              : <div className={styles.songCoverFallback}><Monogram text={t.artist || t.primaryArtist || t.title} /></div>}
          </div>
          <span className={`${styles.cell} ${styles.songTitle}`}>{t.title}</span>
          <span className={`${styles.cell} ${styles.songArtist}`}>{t.artist || t.primaryArtist}</span>
          <span className={`${styles.cell} ${styles.songAlbum}`}>{t.album || '—'}</span>
          <span className={styles.rowActions} onClick={e => e.stopPropagation()}>
            <button
              className={styles.iconBtn}
              title="Add to queue"
              onClick={() => {
                addToQueue({
                  title: t.title,
                  artist: t.artist || t.primaryArtist,
                  albumCover: t.cover || null,
                  cache_key: t.key,
                })
                showToast(`Added "${t.title}" to queue`)
              }}
              aria-label="Add to queue"
            ><Icon name="queueAdd" size={14} /></button>
            {!t.localFile && (() => {
              // Per-row Download — tee the streaming source to disk
              // so future plays don't depend on debrid URL freshness.
              // Hidden once the row has a localFile; while running
              // the button shows a percentage.
              const dj = findJob(downloadJobs, 'music', t.key)
              // 'finalizing' = bytes are on disk but on_finish (transcode
              // + cache stamp) hasn't completed yet. Keep the button
              // disabled-and-progressy until the row's local_file is
              // stamped; otherwise the user sees a flicker between
              // 100% and the row's "saved" state.
              const running = dj && (dj.status === 'pending' || dj.status === 'downloading' || dj.status === 'finalizing')
              return (
                <button
                  className={styles.iconBtn}
                  title={running
                    ? `Downloading… ${Math.round(dj.pct)}%`
                    : 'Download to disk for offline playback'}
                  disabled={!!running}
                  onClick={async () => {
                    try {
                      // Re-resolve via the addon orchestrator so we
                      // POST a fresh stream URL — cached rows for
                      // YouTube/RD-sourced tracks expire in hours,
                      // and a stale URL would 403 mid-download.
                      const resolved = await resolveCacheEntry({ key: t.key })
                      const fresh = resolved?.streamUrl || resolved?.stream_url || ''
                      // Skip override for /api/files/local URLs — the
                      // endpoint already short-circuits on local_file
                      // and httpx can't fetch a relative path anyway.
                      const useOverride = fresh && !fresh.startsWith('/')
                      const r = await authFetch(`/api/cache/${encodeURIComponent(t.key)}/download`, {
                        method: 'POST',
                        body: JSON.stringify(useOverride ? { stream_url: fresh } : {}),
                      })
                      if (!r.ok) {
                        const j = await r.json().catch(() => ({}))
                        throw new Error(j.detail || `HTTP ${r.status}`)
                      }
                      showToast(`Downloading "${t.title}"…`)
                    } catch (e) {
                      showToast(`Download failed: ${e.message || e}`)
                    }
                  }}
                  aria-label="Download to disk"
                >{running ? `${Math.round(dj.pct)}%` : <Icon name="download" size={14} />}</button>
              )
            })()}
            {t.localFile && desktop.isDesktop() && (
              // Reveal the file in Finder / Explorer. Only shown for
              // rows backed by a local copy AND only on the desktop
              // shell — there's no Finder on a phone, so the icon
              // would just throw a confusing error if exposed there.
              <button
                className={styles.iconBtn}
                title="Reveal in Finder"
                onClick={async (e) => {
                  e.stopPropagation()
                  try {
                    const r = await authFetch('/api/library/reveal_file', {
                      method: 'POST',
                      body: JSON.stringify({ path: t.localFile }),
                    })
                    if (!r.ok) {
                      const j = await r.json().catch(() => ({}))
                      throw new Error(j.detail || `HTTP ${r.status}`)
                    }
                  } catch (err) {
                    showToast(`Reveal failed: ${err.message || err}`)
                  }
                }}
                aria-label="Reveal in Finder"
              ><Icon name="folder" size={14} /></button>
            )}
            <button
              className={styles.iconBtn}
              title="Edit metadata"
              onClick={() => setEditEntry({
                key: t.key,
                track_title: t.title,
                track_artist: t.artist || t.primaryArtist,
                track_album: t.album,
                albumCover: t.cover,
              })}
              aria-label="Edit metadata"
            ><Icon name="edit" size={14} /></button>
            <span className={styles.plMenuWrap}>
              <button
                className={styles.iconBtn}
                title="Add to playlist"
                onClick={e => { e.stopPropagation(); setPlaylistMenuFor(playlistMenuFor === t.key ? null : t.key) }}
                aria-label="Add to playlist"
              ><Icon name="plus" size={14} /></button>
              {/* Desktop popover. The mobile counterpart renders
                  inside <MobileSheet> via modals() — a popover next
                  to a 24px button is unreachable on touch and the
                  inline list overflows the row. */}
              {!isMobile && playlistMenuFor === t.key && (
                <div className={styles.plMenu} onClick={e => e.stopPropagation()}>
                  {playlists.map(p => (
                    <div key={p.id} className={styles.plMenuItem} onClick={e => onAddToPlaylist(e, p.id, t)}>
                      {p.name}
                    </div>
                  ))}
                  <div className={styles.plMenuDivider} />
                  <div className={styles.plMenuNew}>
                    <input
                      className={styles.plMenuInput}
                      value={newPlName}
                      onChange={e => setNewPlName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') onCreatePlaylist(e, t) }}
                      placeholder="New playlist name…"
                      autoFocus
                    />
                    <button
                      className={styles.plMenuCreate}
                      disabled={creatingPl || !newPlName.trim()}
                      onClick={e => onCreatePlaylist(e, t)}
                    >Create</button>
                  </div>
                </div>
              )}
            </span>
            <button
              className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
              title="Remove from library"
              onClick={() => requestDelete({
                items: [t], label: `"${t.title}"`, requireConfirm: false,
              })}
              aria-label="Remove from library"
            ><Icon name="x" size={14} /></button>
          </span>
        </div>
        )
      })}
    </div>
  )

  const renderAlbumsGrid = (list) => (
    <div className={styles.albumsGrid}>
      {list.map(a => (
        <div key={a.key} className={styles.albumCard} onClick={() => setDrill({ kind: 'album', key: a.key })}>
          <div className={styles.albumCoverBox}>
            {a.cover
              ? <img src={shrinkCover(a.cover)} alt="" loading="lazy" decoding="async" />
              : <Monogram text={a.album || a.artist} />}
          </div>
          <div className={styles.albumName}>{a.album}</div>
          <div className={styles.albumMeta}>{a.artist} · {a.trackCount} song{a.trackCount === 1 ? '' : 's'}</div>
        </div>
      ))}
    </div>
  )

  const renderArtistsGrid = (list) => (
    <div className={styles.artistsGrid}>
      {list.map(ar => (
        <div key={ar.key} className={styles.artistCard} onClick={() => setDrill({ kind: 'artist', key: ar.key })}>
          <ArtistAvatar name={ar.name} />
          <div className={styles.artistName}>{ar.name}</div>
          <div className={styles.artistMeta}>
            {ar.albumCount} album{ar.albumCount === 1 ? '' : 's'} · {ar.trackCount} song{ar.trackCount === 1 ? '' : 's'}
          </div>
        </div>
      ))}
    </div>
  )

  // ─── Drilldown ─────────────────────────────────────────────────
  if (drill?.kind === 'album') {
    const album = albums.find(a => a.key === drill.key)
    if (!album) { setDrill(null); return null }
    // Find the artist's drilldown key so the breadcrumb can jump to it.
    const artistEntry = artists.find(a => a.name === album.artist)
    return (
      <div className={styles.wrap}>
        <div className={styles.breadcrumb}>
          <button className={styles.crumb} onClick={() => setDrill(null)}>← library</button>
          <span className={styles.crumbSep}>/</span>
          {artistEntry ? (
            <button className={styles.crumb} onClick={() => setDrill({ kind: 'artist', key: artistEntry.key })}>
              {album.artist}
            </button>
          ) : (
            <span className={styles.crumb}>{album.artist}</span>
          )}
          <span className={styles.crumbSep}>/</span>
          <span className={styles.crumbCurrent}>{album.album}</span>
        </div>
        <div className={styles.detailHeader}>
          <AlbumDetailCover
            album={album.album}
            artist={album.artist}
            fallbackUrl={album.cover ? shrinkCover(album.cover) : null}
            fallbackText={album.album || album.artist}
            onUploaded={() => showToast('Album image updated')}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className={styles.detailKind}>Album</div>
            <h1 className={styles.detailTitle}>{album.album}</h1>
            <div className={styles.detailMeta}>
              {artistEntry ? (
                <span
                  className={styles.detailArtistLink}
                  onClick={() => setDrill({ kind: 'artist', key: artistEntry.key })}
                >{album.artist}</span>
              ) : album.artist}
            </div>
            <div className={styles.detailMetaSub}>
              {album.trackCount} {album.trackCount === 1 ? 'track' : 'tracks'}
            </div>
            <div className={styles.detailActions}>
              <button
                className={`${styles.actionBtn} ${styles.actionBtnPrimary}`}
                onClick={() => playFrom(album.tracks[0], album.tracks)}
              ><span aria-hidden="true">▶</span> Play</button>
              <button
                className={styles.actionBtn}
                onClick={() => {
                  const shuffled = album.tracks.slice().sort(() => Math.random() - 0.5)
                  playFrom(shuffled[0], shuffled)
                }}
              ><span aria-hidden="true">⇄</span> Shuffle</button>
              <button
                className={styles.actionBtn}
                onClick={async () => {
                  const newName = await useStore.getState().askPrompt({
                    title: 'Rename album',
                    initial: album.album,
                    placeholder: 'Album name',
                    confirmLabel: 'Rename',
                  })
                  if (newName && newName.trim() && newName.trim() !== album.album) {
                    renameAlbum(album.album, newName.trim(), album.tracks)
                  }
                }}
              >Rename</button>
              <button
                className={`${styles.actionBtn} ${styles.actionBtnDanger}`}
                onClick={() => requestDelete({
                  items: album.tracks,
                  label: `"${album.album}" (${album.trackCount} tracks)`,
                  requireConfirm: true,
                })}
              >Delete</button>
            </div>
          </div>
        </div>
        {renderSongs(album.tracks)}
        {modals()}
      </div>
    )
  }

  if (drill?.kind === 'artist') {
    const artist = artists.find(a => a.key === drill.key)
    if (!artist) { setDrill(null); return null }
    return (
      <div className={styles.wrap}>
        <div className={styles.breadcrumb}>
          <button className={styles.crumb} onClick={() => setDrill(null)}>← library</button>
          <span className={styles.crumbSep}>/</span>
          <span className={styles.crumbCurrent}>{artist.name}</span>
        </div>
        <div className={styles.detailHeader}>
          <ArtistAvatar name={artist.name} large />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className={styles.detailKind}>Artist</div>
            <h1 className={styles.detailTitle}>{artist.name}</h1>
            <div className={styles.detailMetaSub}>
              {artist.albumCount} {artist.albumCount === 1 ? 'album' : 'albums'} · {artist.trackCount} {artist.trackCount === 1 ? 'track' : 'tracks'}
            </div>
            <div className={styles.detailActions}>
              <button
                className={styles.actionBtn}
                onClick={async () => {
                  const newName = await useStore.getState().askPrompt({
                    title: 'Rename artist',
                    initial: artist.name,
                    placeholder: 'Artist name',
                    confirmLabel: 'Rename',
                  })
                  if (newName && newName.trim() && newName.trim() !== artist.name) {
                    renameArtist(artist.name, newName.trim(), artist.tracks)
                  }
                }}
              >Rename artist</button>
              <label className={styles.actionBtn} style={{ cursor: 'pointer' }}>
                Upload image
                <input
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={async (e) => {
                    const file = e.target.files?.[0]
                    e.target.value = ''
                    if (!file) return
                    const form = new FormData()
                    form.append('name', artist.name)
                    form.append('file', file)
                    const r = await authFetch('/api/library/artist-image', { method: 'POST', body: form })
                    if (!r.ok) {
                      showToast('Upload failed')
                      return
                    }
                    bumpArtistPhotoCache(artist.name)
                    showToast('Artist image updated')
                  }}
                />
              </label>
              <button
                className={`${styles.actionBtn} ${styles.actionBtnDanger}`}
                onClick={() => requestDelete({
                  items: artist.tracks,
                  label: `everything by ${artist.name} (${artist.trackCount} tracks)`,
                  requireConfirm: true,
                })}
              >Delete all</button>
            </div>
          </div>
        </div>
        {artist.albums.length > 0 && <>
          <div className={styles.sectionTitle}>Albums</div>
          {renderAlbumsGrid(artist.albums)}
        </>}
        <div className={styles.sectionTitle}>Songs</div>
        {renderSongs(artist.tracks)}
        {modals()}
      </div>
    )
  }

  // ─── Top-level ─────────────────────────────────────────────────
  function modals() {
    // Mobile add-to-playlist sheet — same content as the desktop
    // popover, but full-bleed and reachable for thumbs. Triggered
    // when `playlistMenuFor` is set AND the viewport is mobile.
    const pickerTrack = isMobile && playlistMenuFor
      ? allTracks.find(x => x.key === playlistMenuFor)
      : null
    return (
      <>
        {editEntry && (
          <EditTrackModal
            entry={editEntry}
            artists={allArtistNames}
            albums={allAlbumNames}
            onClose={() => setEditEntry(null)}
            onSaved={(saved) => { onSaved(saved); setEditEntry(null) }}
          />
        )}
        <MobileSheet
          open={!!pickerTrack}
          onClose={() => { setPlaylistMenuFor(null); setNewPlName('') }}
          title="Add to playlist"
        >
          {pickerTrack && (
            <>
              <ul className={styles.plSheetList}>
                {playlists.map(p => (
                  <li key={p.id}>
                    <button
                      type="button"
                      className={styles.plSheetRow}
                      onClick={(e) => onAddToPlaylist(e, p.id, pickerTrack)}
                    >
                      <Icon name="list" size={20} />
                      <span>{p.name}</span>
                    </button>
                  </li>
                ))}
                {playlists.length === 0 && (
                  <li className={styles.plSheetEmpty}>
                    No playlists yet — create one below.
                  </li>
                )}
              </ul>
              <div className={styles.plSheetFooter}>
                <input
                  className={styles.plSheetInput}
                  type="text"
                  placeholder="New playlist name…"
                  value={newPlName}
                  onChange={(e) => setNewPlName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') onCreatePlaylist(e, pickerTrack) }}
                  autoCapitalize="words"
                />
                <button
                  type="button"
                  className={styles.plSheetCreate}
                  disabled={creatingPl || !newPlName.trim()}
                  onClick={(e) => onCreatePlaylist(e, pickerTrack)}
                >Create + add</button>
              </div>
            </>
          )}
        </MobileSheet>
        {/* Confirm + undo banner removed — global ConfirmModal in
            App.jsx handles the prompt now. */}
      </>
    )
  }

  return (
    <div className={styles.wrap}>
      {!shellMode && (
        <div className={styles.header}>
          <div className={styles.titleRow}>
            <h1 className={styles.title}>Library</h1>
          </div>
          <input
            className={styles.searchInput}
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
          <div className={styles.tabs}>
            <button className={`${styles.tab} ${tab === 'songs' ? styles.tabActive : ''}`} onClick={() => setTab('songs')}>Songs · {filtered.length}</button>
            <button className={`${styles.tab} ${tab === 'albums' ? styles.tabActive : ''}`} onClick={() => setTab('albums')}>Albums · {albums.length}</button>
            <button className={`${styles.tab} ${tab === 'artists' ? styles.tabActive : ''}`} onClick={() => setTab('artists')}>Artists · {artists.length}</button>
            <select
              className={styles.sortSelect}
              value={sortMode}
              onChange={e => setSortMode(e.target.value)}
              title="Sort"
            >
              <option value="default">Default</option>
              <option value="title-az">Title A–Z</option>
              <option value="artist-az">Artist A–Z</option>
            </select>
          </div>
        </div>
      )}

      {filtered.length === 0 ? (
        !loaded && !query ? (
          <div className={styles.empty}>
            <div className={styles.spinner} />
            <p>Loading your library…</p>
          </div>
        ) : (
          query ? (
            <EmptyState
              title="No matches"
              body={`Nothing in your library matches "${query}". Try a shorter query or different word.`}
              compact
            />
          ) : (
            <EmptyState
              title="Your library is empty"
              body="Search and play a song to build it. Tracks you save show up here."
              action={{ label: 'Open Search', onClick: () => useStore.getState().setView('search') }}
            />
          )
        )
      ) : tab === 'songs' ? renderSongs(filtered)
        : tab === 'albums' ? renderAlbumsGrid(albums)
        : renderArtistsGrid(artists)}

      {modals()}
    </div>
  )
}


// ConfirmDialog and UndoBanner removed — global ConfirmModal in
// App.jsx handles destructive prompts now (no undo, single confirm).
