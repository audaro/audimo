import { useState, useRef, useEffect } from 'react'
import { useStore } from '../store'
import { authFetch, resolveCacheEntry, updateCacheEntry } from '../api'
import * as orchestrator from '../addons/orchestrator'
import SourcePicker from './SourcePicker'
import EditTrackModal from './EditTrackModal'
import Monogram from './Monogram'
import EmptyState from './EmptyState'
import styles from './AudiobooksView.module.css'

const FORMAT_COLOR = { MP3: '#4caf8a', M4B: '#6a9fd8', M4A: '#6a9fd8' }

function bookId(book) {
  // Stable ID from title + author
  return btoa(encodeURIComponent(`${book.title}|${book.author || ''}`)).replace(/[^a-z0-9]/gi, '').slice(0, 32)
}

// Resolve a book's saved listen progress from the position/duration
// maps. Tries the new bookKey scheme first, then falls back to legacy
// streamUrl-keyed entries written before per-book keying. Legacy keys
// look like /api/audiobooks/library/<id>/stream or /api/files/local?
// path=<absolute path>; we match by either the bookId itself or a
// title/author substring in the path.
function resolveAudiobookProgress(book, cardId, positions, durations) {
  let pos = positions?.[cardId] || 0
  let dur = durations?.[cardId] || 0
  if (pos > 0 && dur > 0) return { pos, dur }

  const matches = (key) => {
    if (key.includes(`/library/${cardId}/`)) return true
    if (book.title) {
      if (key.includes(book.title)) return true
      if (key.includes(encodeURIComponent(book.title))) return true
    }
    if (book.author) {
      if (key.includes(book.author)) return true
      if (key.includes(encodeURIComponent(book.author))) return true
    }
    return false
  }
  if (pos === 0 && positions) {
    for (const k of Object.keys(positions)) {
      if (matches(k)) { pos = positions[k]; break }
    }
  }
  if (dur === 0 && durations) {
    for (const k of Object.keys(durations)) {
      if (matches(k)) { dur = durations[k]; break }
    }
  }
  return { pos, dur }
}

// Open Library covers shrunk from -L (200 KB) to -M (~30 KB) in a
// recent change. Library entries saved before that still carry -L
// URLs and load slowly. Rewrite at render time so old rows benefit
// without a migration.
function shrinkCoverUrl(url) {
  if (!url) return url
  return url.replace(/-L\.jpg($|\?)/i, '-M.jpg$1')
}

// `shellMode`: when true, AudiobooksView is mounted inside LibraryHub
// which already provides the page title + 4-tab strip. We suppress
// our own h2 in that case but keep the search form + library/search
// sub-tabs because they're audiobook-specific (the unified Search
// doesn't yet route to audiobook addons).
export default function AudiobooksView({ shellMode = false } = {}) {
  const { showToast, apiKey, cacheVersion, audiobookPositions, audiobookDurations } = useStore()
  const [tab, setTab] = useState('library')       // 'search' | 'library'
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)
  const [library, setLibrary] = useState(null)    // null = not loaded yet
  const [loading, setLoading] = useState(false)
  const [activeBook, setActiveBook] = useState(null)
  // When the user clicks a search result, we open SourcePicker on the
  // book's title/author. The picker handles the entire source
  // search → resolve → play → save-to-library flow the same way it
  // does for music. Library entries (already saved books) use the
  // legacy inline play path further down.
  const [pickerBook, setPickerBook] = useState(null)
  // Edit-metadata modal state. Maps audiobook fields → cache row
  // shape EditTrackModal expects (track_title / track_artist /
  // albumCover). Album field stays empty for audiobooks.
  const [editEntry, setEditEntry] = useState(null)
  const sseRef = useRef(null)
  // Aborts the addon's resolve.stream fetch when the user cancels.
  const audiobookAbortRef = useRef(null)

  // Load library on mount, on cacheVersion bumps, and (critically)
  // when apiKey lands. The desktop sidecar seeds apiKey
  // asynchronously, so the very first fetch on a fresh boot can
  // 401 and silently empty the library if we don't refire on
  // apiKey changes. Don't clobber on non-OK either — keep the
  // last good list visible.
  // Library comes from /api/cache/list (filtered for category=
  // 'audiobook') merged with /api/audiobooks/library (legacy saves).
  // Dedupe by stable bookId(title, author). Reusing /api/cache/list
  // sidesteps the boot-race that kept emptying this view.
  useEffect(() => {
    let cancelled = false
    const tick = () => {
      if (cancelled) return
      Promise.all([
        authFetch('/api/cache/list')
          .then(r => r.ok ? r.json() : { entries: [] })
          .catch(() => ({ entries: [] })),
        authFetch('/api/audiobooks/library')
          .then(r => r.ok ? r.json() : { books: [] })
          .catch(() => ({ books: [] })),
      ]).then(([cache, ab]) => {
        if (cancelled) return
        const byId = new Map()
        for (const e of (cache.entries || [])) {
          if (e.category !== 'audiobook') continue
          const id = bookId({ title: e.track_title || '', author: e.track_artist || '' })
          byId.set(id, {
            id,
            title: e.track_title || e.filename || 'Unknown',
            author: e.track_artist || '',
            cover: e.albumCover || '',
            cache_key: e.key,
            source: e.source || '',
          })
        }
        for (const b of (ab.books || [])) {
          const id = b.id || bookId({ title: b.title, author: b.author })
          if (!byId.has(id)) {
            byId.set(id, {
              id,
              title: b.title,
              author: b.author || '',
              cover: b.cover || '',
              cache_key: b.cache_key || '',
              source: b.source || '',
              ...b,
            })
          }
        }
        setLibrary([...byId.values()])
      })
    }
    tick()
    // Poll every 4s for the first ~30s so a boot-race that lost the
    // initial fetch still recovers without a manual refresh.
    const id = setInterval(tick, 4000)
    setTimeout(() => clearInterval(id), 32000)
    return () => { cancelled = true; clearInterval(id) }
  }, [cacheVersion, apiKey])


  const search = async (e) => {
    e?.preventDefault()
    if (!query.trim()) return
    setLoading(true)
    setResults(null)
    setTab('search')
    try {
      const r = await authFetch(`/api/search/audiobooks?q=${encodeURIComponent(query.trim())}&limit=20`)
      const data = r.ok ? await r.json() : { books: [] }
      setResults(data.books || [])
    } catch {
      setResults([])
      showToast('Search failed')
    } finally {
      setLoading(false)
    }
  }

  const saveToLibrary = async (book, sourceLink) => {
    const id = bookId(book)
    const entry = {
      id,
      title: book.title,
      author: book.author || '',
      cover: book.cover || '',
      format: book.format || '',
      size: book.size || '',
      categories: book.categories || [],
      // The backend schema persists this in the `magnet` column.
      // Without it, library entries come back with empty magnet +
      // detailUrl, and clicking the book bottoms out in a confusing
      // "no installed addon can resolve" error because the resolve
      // path has no source to dispatch on.
      magnet: sourceLink || '',
      sourceLink: sourceLink || '',
      detailUrl: book.detailUrl || '',
    }
    try {
      await authFetch('/api/audiobooks/library', {
        method: 'POST',
        body: JSON.stringify(entry),
      })
      setLibrary(prev => {
        if (!prev) return [entry]
        const filtered = prev.filter(b => b.id !== id)
        return [{ ...entry, addedAt: new Date().toISOString() }, ...filtered]
      })
      return entry   // return so caller can use the id
    } catch {
      return null
    }
  }

  const removeFromLibrary = async (e, book) => {
    e.stopPropagation()
    // Use the in-app modal — Tauri WebView no-ops native confirm() on
    // macOS, which silently dropped the prompt and made it look like
    // the delete button did nothing.
    const { askConfirm } = useStore.getState()
    const ok = await askConfirm({
      title: 'Remove from library',
      message: `Remove "${book.title}" from your library?\n\nThis also deletes the audio file from your computer.`,
      confirmLabel: 'Remove',
      cancelLabel: 'Keep',
      danger: true,
    })
    if (!ok) return
    try {
      // Two storage backends — clean both. The legacy
      // /api/audiobooks/library row may exist alongside a cache
      // entry that was written via cache.add (with category=
      // 'audiobook'). Removing only the legacy row leaves the cache
      // row visible in the music libraries.
      if (book.id) {
        await authFetch(`/api/audiobooks/library/${book.id}`, { method: 'DELETE' })
      }
      if (book.cache_key) {
        await authFetch('/api/cache/remove', {
          method: 'DELETE',
          body: JSON.stringify({ key: book.cache_key }),
        })
      }
      setLibrary(prev => prev ? prev.filter(b => b.id !== book.id) : prev)
      showToast('Removed from library')
    } catch {
      showToast('Failed to remove')
    }
  }

  // Edit metadata for any audiobook in the library. Two storage
  // backends: rows that have a cache_key write through the standard
  // updateCacheEntry path; legacy /api/audiobooks/library rows (no
  // cache_key) write through the books endpoint via saveOverride.
  // Either way the EditTrackModal looks identical to the user.
  const openEdit = (e, book) => {
    e.stopPropagation()
    setEditEntry({
      key: book.cache_key || '',
      audiobook_id: book.id,
      legacy: !book.cache_key,
      track_title: book.title,
      track_artist: book.author || '',
      track_album: '',
      albumCover: book.cover || '',
    })
  }

  // Persistence override for legacy audiobook rows. EditTrackModal
  // calls this instead of updateCacheEntry when set; we POST the
  // updated fields back to the audiobooks API. Maps audiobook
  // fields back to the legacy schema (title/author/cover).
  const saveLegacyAudiobook = async (updated) => {
    await authFetch('/api/audiobooks/library', {
      method: 'POST',
      body: JSON.stringify({
        id: updated.audiobook_id,
        title: updated.track_title,
        author: updated.track_artist,
        cover: updated.albumCover || '',
      }),
    })
  }

  const onEditSaved = async (updated) => {
    // For cache-keyed audiobooks: the cache entry's effective id in
    // our library merge is bookId(track_title, track_artist), which
    // changes when the title/author change. A legacy library row may
    // exist alongside the cache entry — saved at original-title time
    // — and after the edit its old id no longer collides with the
    // new cache id, so it surfaces as a duplicate. Wipe the stale
    // legacy row by its old id to keep the merged view clean.
    if (updated.key && editEntry?.audiobook_id) {
      try {
        await authFetch(`/api/audiobooks/library/${editEntry.audiobook_id}`, {
          method: 'DELETE',
        })
      } catch {}
    }
    setLibrary(prev => prev?.map(b => {
      const matches = updated.key
        ? b.cache_key === updated.key
        : b.id === updated.audiobook_id
      if (!matches) return b
      return {
        ...b,
        title: updated.track_title || b.title,
        author: updated.track_artist || b.author,
        cover: updated.albumCover || b.cover,
      }
    })?.filter(b => !(updated.key && b.id === editEntry?.audiobook_id && !b.cache_key)) ?? prev)
    setEditEntry(null)
  }

  const play = async (book) => {
    if (activeBook) return
    const bookEntryId = book.id || bookId(book)
    setActiveBook({ id: bookEntryId, title: book.title, pct: 0, message: 'Checking library…', status: 'starting' })

    try {

      // 0a. Local file — check both the book itself AND any matching library entry
      //     (covers clicking from search results when the book is already in library)
      const libraryMatch = library?.find(b => b.id === bookEntryId || b.id === bookId(book))
      const localFileToUse = book.localFile || libraryMatch?.localFile || ''

      if (localFileToUse) {
        // Use the library entry id for the stream URL (it has the file stored there)
        const streamEntryId = libraryMatch?.id || bookEntryId
        const streamUrl = `/api/audiobooks/library/${streamEntryId}/stream`
        // Verify the file is still there (no auth needed — stream endpoint is public)
        const headR = await fetch(streamUrl, { method: 'HEAD' }).catch(() => null)
        if (headR && headR.ok) {
          useStore.getState().playNow({
            title: book.title,
            artist: book.author || 'Audiobook',
            albumCover: book.cover || null,
            streamUrl,
            source: 'Library',
            isAudiobook: true,
            bookKey: bookEntryId,
          })
          showToast(`▶ ${book.title}`)
          setActiveBook(null)
          return
        }
        // File missing — clear local_file from library and fall through to re-download
        if (libraryMatch) {
          await authFetch(`/api/audiobooks/library/${streamEntryId}/set_file`, {
            method: 'POST',
            body: JSON.stringify({ localFile: '' }),
          }).catch(() => {})
          setLibrary(prev => prev?.map(b => b.id === streamEntryId ? { ...b, localFile: '' } : b) ?? prev)
        }
      }

      // 0b. In-memory cache check
      const artist = book.author || ''
      const title  = book.title || ''
      const checkR = await authFetch('/api/cache/check', {
        method: 'POST',
        body: JSON.stringify({ tracks: [{ title, artist }] }),
      })
      const checkD = await checkR.json()
      const normKey = `${artist.toLowerCase().trim()}|${title.toLowerCase().trim()}`
      const cached  = checkD.cached?.[normKey]

      if (cached) {
        const resolved = await resolveCacheEntry({ key: cached.cache_key, apiKey })
        if (resolved?.streamUrl) {
          useStore.getState().playNow({
            title: book.title,
            artist: book.author || 'Audiobook',
            albumCover: book.cover || null,
            streamUrl: resolved.streamUrl,
            source: resolved.source || 'Audiobook',
            isAudiobook: true,
            bookKey: bookEntryId,
          })
          showToast(`▶ ${book.title}`)
          // Make sure the book appears in the library even when we played from cache
          // (e.g. after the user removed it then clicked it again from search).
          await saveToLibrary(book, book.sourceLink || book.magnet || '')
          setActiveBook(null)
          return
        }
      }

      // 1. Not cached — ask the addon to resolve the book's detail
      //    URL into the source link it understands.
      setActiveBook(prev => prev ? { ...prev, message: 'Fetching source info…' } : null)
      let sourceLink = book.sourceLink || book.magnet
      if (!sourceLink) {
        // Library entries saved before we persisted source info come
        // back with empty detailUrl/magnet/sourceLink. Without one of
        // those we can't re-resolve, and resolveMagnet would throw an
        // unhelpful "no installed addon" error. Surface the actual
        // problem and bail out so the user can re-add via search.
        if (!book.detailUrl) {
          setActiveBook(null)
          showToast('This audiobook has no source on file — search for it again to play.', 5000)
          return
        }
        // Device-side: ask any installed addon advertising the
        // source-link resolver capability. The request never touches
        // Audimo core.
        const mr = await orchestrator.resolveMagnet(book.detailUrl)
        if (!mr?.magnet) throw new Error('Could not resolve source link')
        sourceLink = mr.magnet
      }

      // 2. Save to library now (before download starts) so the book
      //    appears in the Library tab with a live progress overlay.
      await saveToLibrary(book, sourceLink)

      // 3. Stream the source through any installed resolve.stream
      //    addon. Progress events come from the addon's SSE; nothing
      //    routes through Audimo core.
      const ctrl = new AbortController()
      audiobookAbortRef.current = ctrl
      try {
        const stream = orchestrator.resolveStream({
          source: {
            kind: 'torrent',
            link: sourceLink,
            link_type: 'magnet',
            name: book.title,
            seeders: 10,
            source: book.source || 'Addon',
          },
          track: { title: book.title, artist: book.author || '', album: '' },
        }, { signal: ctrl.signal })

        let last = null
        for await (const ev of stream) {
          last = ev
          setActiveBook(prev => prev ? {
            ...prev,
            pct: typeof ev.pct === 'number' ? ev.pct : prev.pct,
            message: ev.message || prev.message,
            status: ev.status || prev.status,
          } : null)
          if (ev?.status === 'error') break
          if (ev?.status === 'done' || ev?.streamUrl) break
        }
        audiobookAbortRef.current = null

        if (!last || last.status === 'error' || !last.streamUrl) {
          showToast(`${last?.message || 'Could not stream audiobook'}`)
          setActiveBook(null)
          return
        }

        useStore.getState().playNow({
          title: book.title,
          artist: book.author || 'Audiobook',
          albumCover: book.cover || null,
          streamUrl: last.streamUrl,
          source: last.source || 'Audiobook',
          isAudiobook: true,
          bookKey: bookEntryId,
        })
        showToast(`▶ ${book.title}`)
        setActiveBook(null)
      } catch (err) {
        audiobookAbortRef.current = null
        if (err.name !== 'AbortError') showToast(`${err.message}`)
        setActiveBook(null)
      }
    } catch (err) {
      if (sseRef.current) { sseRef.current.close(); sseRef.current = null }
      setActiveBook(null)
      showToast(`${err.message}`)
    }
  }

  const cancel = () => {
    if (sseRef.current) { sseRef.current.close(); sseRef.current = null }
    if (audiobookAbortRef.current) {
      try { audiobookAbortRef.current.abort() } catch {}
      audiobookAbortRef.current = null
    }
    setActiveBook(null)
  }

  // Library order: alphabetical by title (case-insensitive). Without
  // an explicit sort, displayBooks took whatever order the merge of
  // /api/cache/list + /api/audiobooks/library happened to produce —
  // which can shift between the 4s-poll ticks if a backend write
  // (cache.resolve, save_download, anything that re-touches
  // _stream_cache) reshuffles dict-insertion order. Visible as a row
  // briefly hopping above its neighbour after a play click, then
  // snapping back on the next tick.
  // Search results stay in the addon's relevance order — sorting by
  // title there would defeat the addon's ranking.
  const displayBooks = tab === 'library'
    ? [...(library || [])].sort((a, b) =>
        (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' })
      )
    : (results || [])

  // Resolve a search/library row to its saved entry (if any). Match
  // on normalized title+author rather than the previous bookId hash —
  // hashes are brittle to whitespace, case, or the addon emitting a
  // slightly different id field. Two books with the same normalized
  // (title, author) tuple are the same book.
  const normKey = (t, a) =>
    `${(t || '').toLowerCase().trim().replace(/\s+/g, ' ')}|${(a || '').toLowerCase().trim().replace(/\s+/g, ' ')}`
  const savedByNorm = (() => {
    const m = new Map()
    for (const b of (library || [])) m.set(normKey(b.title, b.author), b)
    return m
  })()
  const findSaved = (book) => savedByNorm.get(normKey(book.title, book.author)) || null

  return (
    <div className={styles.wrap}>
      {/* ── Header ── */}
      <div className={styles.header}>
        {!shellMode && (
          <div className={styles.headerTop}>
            <h2 className={styles.headerTitle}>Audiobooks</h2>
          </div>
        )}
        <form className={styles.searchForm} onSubmit={search}>
          <input
            className={styles.searchInput}
            type="search"
            inputMode="search"
            enterKeyHint="search"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search audiobooks…"
          />
          <button className={styles.searchBtn} type="submit" disabled={loading}>
            {loading ? <span className={styles.spinner} /> : 'Search'}
          </button>
        </form>

        {/* ── Tabs ── */}
        <div className={styles.tabs}>
          <button
            className={`${styles.tab} ${tab === 'library' ? styles.tabActive : ''}`}
            onClick={() => setTab('library')}
          >
            Library {library ? `· ${library.length}` : ''}
          </button>
          {/* Search Results tab only appears once the user actually runs a
              search. Hides on first load and after the user clears results. */}
          {results !== null && (
            <button
              className={`${styles.tab} ${tab === 'search' ? styles.tabActive : ''}`}
              onClick={() => setTab('search')}
            >
              Search Results · {results.length}
            </button>
          )}
        </div>
      </div>

      {/* Progress is shown per-card as an overlay (see grid below). When the
          active download isn't visible in the current tab, show a slim banner. */}
      {activeBook && !displayBooks.some(b => (b.id || bookId(b)) === activeBook.id) && (
        <div className={styles.progressBanner}>
          <div className={styles.progressBar}>
            <div
              className={`${styles.progressFill} ${activeBook.status === 'error' ? styles.progressError : ''}`}
              style={{ width: `${Math.max(activeBook.pct || 0, 3)}%` }}
            />
          </div>
          <div className={styles.progressFooter}>
            <span className={styles.progressTitle}>{activeBook.title}</span>
            <span className={styles.progressMsg}>{activeBook.message}</span>
            <button className={styles.cancelBtn} onClick={cancel}>✕</button>
          </div>
        </div>
      )}

      {/* ── Empty / loading states ── */}
      {tab === 'library' && library === null && (
        <div className={styles.empty}>
          <div className={styles.spinner} />
          <p>Loading your library…</p>
        </div>
      )}
      {tab === 'library' && library !== null && library.length === 0 && (
        <EmptyState
          title="No audiobooks yet"
          body="Search for an audiobook and download it to add it here."
          action={{ label: 'Search', onClick: () => setTab('search') }}
        />
      )}

      {tab === 'search' && results === null && !loading && (
        <EmptyState
          title="Find your next listen"
          body="Search for any audiobook above — Google Books powers the catalog and your installed addons resolve the audio."
        />
      )}

      {/* Active-search placeholder — without this the screen sat
          empty for the few seconds while the addon's search.books
          finished, leaving the user wondering if anything happened. */}
      {tab === 'search' && loading && results === null && (
        <div className={styles.empty}>
          <div className={styles.spinner} />
          <p>Searching audiobooks…</p>
          <p className={styles.emptyHint}>Searching via Google Books</p>
        </div>
      )}

      {tab === 'search' && results !== null && results.length === 0 && (
        <EmptyState
          title="No results"
          body="Try a different title or author."
        />
      )}

      {/* ── Grid ── */}
      {displayBooks.length > 0 && (
        <div className={styles.grid}>
          {displayBooks.map((book, i) => {
            const cardId = book.id || bookId(book)
            const isDownloading = activeBook && activeBook.id === cardId
            const otherActive = activeBook && !isDownloading
            return (
            <div
              key={book.id || i}
              className={`${styles.card} ${otherActive ? styles.cardDimmed : ''}`}
              onClick={() => {
                if (activeBook) return
                const saved = findSaved(book)
                // Library tab → detail page (works for both
                // downloaded books and cache-only entries; the
                // detail view falls back to /api/cache/list when
                // the audiobook_library lookup misses).
                if (tab === 'library' && saved) {
                  useStore.getState().openAudiobookDetail(saved.id)
                  return
                }
                if (saved) { play(saved); return }
                if (tab === 'search') setPickerBook(book)
                else play(book)
              }}
            >
              <div className={styles.cardCover}>
                {book.cover
                  ? <img
                      src={shrinkCoverUrl(book.cover)}
                      alt=""
                      className={styles.coverImg}
                      loading="lazy"
                      decoding="async"
                    />
                  : <div className={styles.coverFallback}><Monogram text={book.author || book.title} /></div>}
                {!isDownloading && <div className={styles.playOverlay}>▶</div>}
                {!isDownloading && (() => {
                  const { pos, dur } = resolveAudiobookProgress(book, cardId, audiobookPositions, audiobookDurations)
                  if (pos <= 0) return null
                  // Two visual modes:
                  //  • known duration → real percent, floored at 2% so
                  //    early progress is still visible
                  //  • unknown duration (legacy positions written before
                  //    the Player tracked duration) → a faint 10% marker
                  //    that just indicates "in progress"; replaying the
                  //    book under the new Player code captures duration.
                  const known = dur > 0
                  const pct = known ? Math.min(100, Math.max(0, (pos / dur) * 100)) : 10
                  const visiblePct = Math.max(pct, 2)
                  return (
                    <div className={styles.listenBar} title={known ? `${Math.round(pct)}% listened` : 'In progress'}>
                      <div
                        className={styles.listenFill}
                        style={{ width: `${visiblePct}%`, opacity: known ? 1 : 0.5 }}
                      />
                    </div>
                  )
                })()}
                {isDownloading && (
                  <div className={styles.downloadOverlay}>
                    <div className={styles.dlPct}>{Math.round(activeBook.pct || 0)}%</div>
                    <div className={styles.dlBar}>
                      <div
                        className={`${styles.dlFill} ${activeBook.status === 'error' ? styles.progressError : ''}`}
                        style={{ width: `${Math.max(activeBook.pct || 0, 3)}%` }}
                      />
                    </div>
                    <div className={styles.dlMsg}>{activeBook.message}</div>
                    <button
                      className={styles.dlCancel}
                      onClick={(e) => { e.stopPropagation(); cancel() }}
                      title="Cancel"
                    >✕</button>
                  </div>
                )}
              </div>
              <div className={styles.cardInfo}>
                <div className={styles.cardTitle}>{book.title}</div>
                {book.author && <div className={styles.cardAuthor}>{book.author}</div>}
                {book.pages > 0 && (
                  <div className={styles.cardLength}>
                    {book.pages.toLocaleString()} pages
                    {book.year ? ` · ${book.year}` : ''}
                  </div>
                )}
                {!book.pages && book.year > 0 && (
                  <div className={styles.cardLength}>{book.year}</div>
                )}
              </div>
              {/* Library row actions */}
              {tab === 'library' && (
                <div className={styles.cardActions}>
                  <button
                    className={styles.cardActionBtn}
                    onClick={(e) => openEdit(e, book)}
                    title="Edit metadata"
                  >✎</button>
                  <button
                    className={styles.removeBtn}
                    onClick={(e) => removeFromLibrary(e, book)}
                    title="Remove from library"
                  >✕</button>
                </div>
              )}
              {/* Saved badge on search results that already exist in
                  the library. Matched by the deterministic bookId
                  (title+author), since Open Library results don't
                  carry a stable detail URL the way the old
                  legacy addon-driven search did. */}
              {tab === 'search' && findSaved(book) && (
                <span className={styles.savedBadge}>✓ Saved</span>
              )}
            </div>
          )})}
        </div>
      )}

      {/* SourcePicker for an Open Library result. Builds a synthetic
          "track" — title + author — so the picker's existing
          resolve.sources fan-out can search through addon sources. The
          picker handles play, save-to-library, cache upgrade, etc. */}
      {pickerBook && (
        <SourcePicker
          track={{
            title: pickerBook.title,
            artist: pickerBook.author || '',
            album: pickerBook.title,
            album_cover: pickerBook.cover || '',
            // Hint to addons: this is an audiobook search, not music.
            // Addons can use this to append "audiobook|m4b" to their
            // queries and prefer audio formats in scoring. Plumbed
            // through SourcePicker → resolve.sources payload.
            kind: 'audiobook',
          }}
          onClose={() => {
            setPickerBook(null)
            // Trigger a full library refresh via cacheVersion. The old
            // close handler only re-fetched /api/audiobooks/library
            // (the legacy table) and clobbered the merged state. Now
            // that audiobooks live in /api/cache/list (category=
            // audiobook), the old fetch returned [] and made every
            // just-saved book look unsaved — clicking it again re-
            // opened the SourcePicker instead of playing.
            useStore.getState().bumpCacheVersion()
          }}
        />
      )}

      {editEntry && (
        <EditTrackModal
          entry={editEntry}
          kind="audiobook"
          artists={Array.from(new Set((library || []).map(b => b.author).filter(Boolean))).sort()}
          albums={[]}
          saveOverride={editEntry.legacy ? saveLegacyAudiobook : undefined}
          onClose={() => setEditEntry(null)}
          onSaved={onEditSaved}
        />
      )}
    </div>
  )
}
