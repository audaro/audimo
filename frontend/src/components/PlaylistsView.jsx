import { useState, useEffect, useRef } from 'react'
import { useStore } from '../store'
import {
  createPlaylistApi, deletePlaylistApi, updatePlaylistApi,
  addTrackToPlaylistApi, removeTrackFromPlaylistApi, reorderPlaylistTracksApi,
  authFetch, resolveCacheEntry,
} from '../api'
import Monogram from './Monogram'
import EmptyState from './EmptyState'
import styles from './PlaylistsView.module.css'

export default function PlaylistsView() {
  const {
    playlists, setPlaylists, createPlaylist, deletePlaylist, renamePlaylist,
    addTrackToPlaylist, removeTrackFromPlaylist, reorderPlaylist,
    loadQueue, playNow, showToast, apiKey,
  } = useStore()

  const [selectedId, setSelectedId] = useState(null)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState(null) // playlist id being renamed
  const [renameVal, setRenameVal] = useState('')
  const [cachedTracks, setCachedTracks] = useState([])
  const [addingTo, setAddingTo] = useState(null) // playlist id for add-track picker
  // Free-text filter for the add-track picker. Without it the user
  // had to scroll through every saved song to find the one they
  // wanted to add — fine at 10 tracks, miserable at 200.
  const [pickerQuery, setPickerQuery] = useState('')
  // (drag-state removed when DnD was replaced by ↑/↓ reorder buttons)

  // Load library tracks for the add-track picker. /api/cache/list
  // returns every saved song; we drop audiobooks here so the picker
  // is music-only (audiobooks can't sensibly join a music playlist).
  // We also stash the full set of cache keys (including audiobooks)
  // in `liveLibraryKeys` so playlist rows whose underlying entry has
  // been deleted get hidden client-side immediately — the backend
  // cascade in /api/cache/remove handles the DB side.
  const [liveLibraryKeys, setLiveLibraryKeys] = useState(() => new Set())
  useEffect(() => {
    authFetch('/api/cache/list')
      .then(r => r.json())
      .then(d => {
        const all = d.entries || []
        setCachedTracks(
          all.filter(e => e.category !== 'audiobook' && e.kind !== 'audiobook')
        )
        setLiveLibraryKeys(new Set(all.map(e => e.key)))
      })
      .catch(() => {})
  }, [])

  // Reset filter when picker opens/closes so a stale query doesn't
  // hide the list the next time the user clicks "+ Add Tracks".
  useEffect(() => { setPickerQuery('') }, [addingTo])

  // Click-outside + Esc dismiss for the Add tracks picker. Pointer-
  // outside closes the picker like any modal; Esc gives keyboard
  // users a way out without reaching for the small ✕.
  const pickerRef = useRef(null)
  useEffect(() => {
    if (!addingTo) return
    const onPointer = (e) => {
      if (!pickerRef.current) return
      if (pickerRef.current.contains(e.target)) return
      setAddingTo(null)
    }
    const onKey = (e) => { if (e.key === 'Escape') setAddingTo(null) }
    // mousedown beats click — we want the dismiss to land before
    // any inner click handler fires (e.g. selecting another playlist
    // would otherwise leave the picker open against a different
    // selected playlist).
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [addingTo])

  const selected = playlists.find(p => p.id === selectedId)

  const handleCreate = async () => {
    if (!newName.trim()) return
    try {
      const pl = await createPlaylistApi(newName.trim())
      createPlaylist(pl.name, pl.id)
      setNewName('')
      setCreating(false)
      setSelectedId(pl.id)
    } catch (e) {
      showToast('Error creating playlist')
    }
  }

  const playPlaylist = async (playlist, startIdx = 0, shuffled = false) => {
    if (!playlist.tracks.length) { showToast('Playlist is empty'); return }

    showToast(`⚡ Loading ${playlist.name}…`)

    // Build the queue without resolving — Player.jsx resolves each
    // track lazily as it becomes active (see its queueIdx effect).
    // Resolving N entries in parallel up-front blasts addons with N
    // simultaneous cache.resolve calls, which for legacy entries kicks
    // off N download jobs — capable of overwriting on-disk files
    // mid-play. Lazy resolution serializes naturally.
    //
    // The active track DOES get resolved up-front so playback starts
    // immediately; everything else waits its turn.
    const head = playlist.tracks[startIdx]
    let headResolved = null
    if (head) {
      try {
        const data = await resolveCacheEntry({ key: head.key, apiKey })
        if (data && data.streamUrl) {
          headResolved = {
            title: head.track_title || head.filename || 'Unknown',
            artist: head.track_artist || '',
            albumCover: head.albumCover || null,
            streamUrl: data.streamUrl,
            source: data.source,
          }
        }
      } catch (e) {}
    }
    if (!headResolved) {
      showToast('Track expired — play it from search to re-cache')
      return
    }

    const queueItems = playlist.tracks.map((t, i) => {
      if (i === startIdx) return headResolved
      // Unresolved entries get cache_key — Player.jsx looks for this
      // to drive its lazy resolve.
      return {
        title: t.track_title || t.filename || 'Unknown',
        artist: t.track_artist || '',
        albumCover: t.albumCover || null,
        cache_key: t.key,
      }
    })

    loadQueue(queueItems, startIdx, shuffled)
    showToast(`${shuffled ? '⇄ Shuffling' : '▶ Playing'} ${playlist.name} · ${queueItems.length} tracks`)
  }

  const playSingle = async (track, playlistTracks, idx) => {
    showToast('⚡ Loading…')
    try {
      const data = await resolveCacheEntry({ key: track.key, apiKey })
      if (!data || !data.streamUrl) { showToast('Track expired — play it from search to re-cache'); return }
      playNow({
        title: track.track_title || track.filename || 'Unknown',
        artist: track.track_artist || '',
        albumCover: track.albumCover || null,
        streamUrl: data.streamUrl,
        source: data.source,
      })
    } catch (e) {
      showToast('Error: ' + e.message)
    }
  }

  // Reorder by step. HTML5 drag-and-drop in Tauri's WKWebView was
  // dropping events silently regardless of how we set things up
  // (data transfer, drag image, separate handle target). Replaced
  // with ↑/↓ buttons that move a row one slot at a time. Less
  // glamorous than DnD but bulletproof — and most reorders only
  // shift things a few positions anyway.
  const moveTrack = (fromIdx, delta) => {
    const pl = playlists.find(p => p.id === selectedId)
    if (!pl) return
    const live = (pl.tracks || []).filter(t => liveLibraryKeys.has(t.key))
    const toIdx = fromIdx + delta
    if (toIdx < 0 || toIdx >= live.length) return
    // The store's reorderPlaylist works in terms of full-list
    // indices, not live-list indices, so map back to the underlying
    // position before calling.
    const fromKey = live[fromIdx].key
    const toKey = live[toIdx].key
    const fullFrom = pl.tracks.findIndex(t => t.key === fromKey)
    const fullTo   = pl.tracks.findIndex(t => t.key === toKey)
    if (fullFrom < 0 || fullTo < 0) return
    reorderPlaylist(selectedId, fullFrom, fullTo)
    // Persist the new ordering. Read state again post-update via
    // the store rather than the closure — the playlists ref above
    // is stale by the time this resolves.
    const next = useStore.getState().playlists.find(p => p.id === selectedId)
    if (next) reorderPlaylistTracksApi(selectedId, next.tracks).catch(() => {})
  }

  const handleRename = async (id, name) => {
    renamePlaylist(id, name)
    updatePlaylistApi(id, name).catch(() => {})
    setRenaming(null)
  }

  const handleDelete = async (id, name) => {
    // Tauri's WebView no-ops native confirm() — was the source of the
    // "delete does nothing" bug. Route through the in-app modal.
    const ok = await useStore.getState().askConfirm({
      title: 'Delete playlist',
      message: `Delete "${name}"? The tracks stay in your library; only the playlist is removed.`,
      confirmLabel: 'Delete',
      cancelLabel: 'Keep',
      danger: true,
    })
    if (!ok) return
    deletePlaylist(id)
    deletePlaylistApi(id).catch(() => {})
    setSelectedId(null)
  }

  const handleAddTrack = async (track) => {
    const pl = playlists.find(p => p.id === addingTo)
    if (!pl) return
    const position = pl.tracks.length
    addTrackToPlaylist(addingTo, track)
    addTrackToPlaylistApi(addingTo, track, position).catch(() => {})
  }

  const handleRemoveTrack = (playlistId, key) => {
    removeTrackFromPlaylist(playlistId, key)
    removeTrackFromPlaylistApi(playlistId, key).catch(() => {})
  }

  // ── List view ──────────────────────────────────────────────────
  if (!selectedId || !selected) {
    return (
    <div className={styles.wrap}>
      <header className={styles.pageHead}>
        <div>
          <div className={styles.statLine}>
            {playlists.length} {playlists.length === 1 ? 'playlist' : 'playlists'}
          </div>
          <h1 className={styles.title}>Playlists</h1>
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.actionBtn}
            onClick={() => setCreating(true)}
          >
            <span className={styles.actionGlyph}>＋</span> New playlist
          </button>
        </div>
      </header>

      {creating && (
        <div className={styles.createRow}>
          <input
            className={styles.nameInput}
            placeholder="Playlist name…"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setCreating(false) }}
            autoFocus
          />
          <button className={`${styles.btn} ${styles.primary}`} onClick={handleCreate}>Create</button>
          <button className={styles.btn} onClick={() => setCreating(false)}>Cancel</button>
        </div>
      )}

      {playlists.length === 0 && !creating && (
        <EmptyState
          title="No playlists yet"
          body="Create one to organise your saved tracks. You can add songs from your library or from search results."
          action={{ label: 'New playlist', onClick: () => setCreating(true) }}
        />
      )}

      {playlists.length > 0 && (
        <section className={styles.section}>
          <div className={styles.playlistGrid}>
            {playlists.map(p => {
              const live = (p.tracks || []).filter(t => liveLibraryKeys.has(t.key))
              return (
                <button
                  key={p.id}
                  type="button"
                  className={styles.playlistCard}
                  onClick={() => setSelectedId(p.id)}
                >
                  <div className={styles.playlistArt}>
                    {live.slice(0, 4).map((t, i) => (
                      t.albumCover
                        ? <img key={i} src={t.albumCover} alt="" className={styles.artThumb} />
                        : <div key={i} className={styles.artThumbFallback}><Monogram text={t.track_artist || t.track_title} /></div>
                    ))}
                    {live.length === 0 && <div className={styles.artEmpty}>—</div>}
                  </div>
                  <div className={styles.playlistName}>{p.name}</div>
                  <div className={styles.playlistCount}>{live.length} {live.length === 1 ? 'track' : 'tracks'}</div>
                </button>
              )
            })}
          </div>
        </section>
      )}
    </div>
    )
  }

  // ── Playlist detail view ───────────────────────────────────────
  // Tracks whose underlying cache entry has been deleted ("expired"
  // in the user's framing) get hidden from the detail view too. The
  // backend cascades the actual DB cleanup on /api/cache/remove.
  const selectedLive = (selected.tracks || []).filter(t => liveLibraryKeys.has(t.key))
  return (
    <div className={styles.wrap}>
      <div className={styles.breadcrumb}>
        <button className={styles.backBtn} onClick={() => setSelectedId(null)} aria-label="Back to playlists">←</button>
        <span className={styles.breadcrumbLabel}>Playlists</span>
      </div>

      <div className={styles.detailHeader}>
        <div className={styles.detailArt}>
          {selectedLive.slice(0, 4).map((t, i) => (
            t.albumCover
              ? <img key={i} src={t.albumCover} alt="" className={styles.artThumb} />
              : <div key={i} className={styles.artThumbFallback}><Monogram text={t.track_artist || t.track_title} /></div>
          ))}
          {selectedLive.length === 0 && <div className={styles.artEmpty}>—</div>}
        </div>
        <div className={styles.detailMeta}>
          <div className={styles.detailKind}>Playlist</div>
          {renaming === selected.id
            ? <div className={styles.renameRow}>
                <input
                  className={styles.nameInput}
                  value={renameVal}
                  onChange={e => setRenameVal(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleRename(selected.id, renameVal)
                    if (e.key === 'Escape') setRenaming(null)
                  }}
                  autoFocus
                />
                <button className={`${styles.btn} ${styles.primary}`} onClick={() => handleRename(selected.id, renameVal)}>Save</button>
              </div>
            : <h1 className={styles.detailTitle}>{selected.name}</h1>
          }
          <p className={styles.detailCount}>
            {selectedLive.length} {selectedLive.length === 1 ? 'track' : 'tracks'}
          </p>
          <div className={styles.detailActions}>
            <button
              className={`${styles.actionBtn} ${styles.actionBtnPrimary}`}
              onClick={() => playPlaylist({ ...selected, tracks: selectedLive }, 0, false)}
              disabled={!selectedLive.length}
            ><span aria-hidden="true">▶</span> Play</button>
            <button
              className={styles.actionBtn}
              onClick={() => playPlaylist({ ...selected, tracks: selectedLive }, 0, true)}
              disabled={!selectedLive.length}
            ><span aria-hidden="true">⇄</span> Shuffle</button>
            <button
              className={styles.actionBtn}
              onClick={() => setAddingTo(selected.id)}
            ><span aria-hidden="true">＋</span> Add tracks</button>
            <button
              className={styles.actionBtn}
              onClick={() => { setRenaming(selected.id); setRenameVal(selected.name) }}
            >Rename</button>
            <button
              className={`${styles.actionBtn} ${styles.actionBtnDanger}`}
              onClick={() => handleDelete(selected.id, selected.name)}
            >Delete</button>
          </div>
        </div>
      </div>

      {/* Add tracks picker */}
      {addingTo && (() => {
        // Live-filtered list. Match against title + artist, lowercased.
        const q = pickerQuery.trim().toLowerCase()
        const filtered = q
          ? cachedTracks.filter(t => {
              const haystack = `${t.track_title || ''} ${t.track_artist || ''}`.toLowerCase()
              return haystack.includes(q)
            })
          : cachedTracks
        return (
          <div className={styles.picker} ref={pickerRef}>
            <div className={styles.pickerHeader}>
              <span>Add from library · {cachedTracks.length} song{cachedTracks.length === 1 ? '' : 's'}</span>
              <button className={styles.pickerClose} onClick={() => setAddingTo(null)}>✕</button>
            </div>
            <input
              className={styles.pickerSearch}
              type="search"
              inputMode="search"
              enterKeyHint="search"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              placeholder="Filter by song or artist…"
              value={pickerQuery}
              onChange={e => setPickerQuery(e.target.value)}
            />
            <div className={styles.pickerList}>
              {cachedTracks.length === 0 && <p className={styles.pickerEmpty}>Your library is empty. Search and play some songs first.</p>}
              {cachedTracks.length > 0 && filtered.length === 0 && <p className={styles.pickerEmpty}>No matches for "{pickerQuery}".</p>}
              {filtered.map(t => {
                const already = selected.tracks.find(x => x.key === t.key)
                return (
                  <div key={t.key} className={`${styles.pickerRow} ${already ? styles.pickerAdded : ''}`}
                    onClick={() => {
                      if (already) { handleRemoveTrack(selected.id, t.key); return }
                      handleAddTrack(t)
                    }}>
                    <div className={styles.pickerCover}>
                      {t.albumCover
                        ? <img src={t.albumCover} alt="" style={{width:'100%',height:'100%',objectFit:'cover'}} />
                        : <Monogram text={t.track_artist || t.track_title} />}
                    </div>
                    <div className={styles.pickerInfo}>
                      <div className={styles.pickerTitle}>{t.track_title || t.filename || 'Unknown'}</div>
                      <div className={styles.pickerArtist}>{t.track_artist || ''}</div>
                    </div>
                    <span className={styles.pickerCheck}>{already ? '✓' : '+'}</span>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })()}

      {/* Track list */}
      {selectedLive.length === 0 && !addingTo && (
        <div className={styles.empty}>
          <p>{(selected.tracks || []).length === 0
                ? 'No tracks yet. Click "+ Add Tracks" to add from your library.'
                : 'All tracks in this playlist were removed from your library.'}</p>
        </div>
      )}

      <div className={styles.trackList}>
        {selectedLive.map((track, i) => (
          <div
            key={track.key}
            className={styles.trackRow}
            onClick={() => playSingle(track, selectedLive, i)}
          >
            <div
              className={styles.reorderBtns}
              onClick={e => e.stopPropagation()}
            >
              <button
                type="button"
                className={styles.reorderBtn}
                disabled={i === 0}
                onClick={() => moveTrack(i, -1)}
                title="Move up"
              >↑</button>
              <button
                type="button"
                className={styles.reorderBtn}
                disabled={i === selectedLive.length - 1}
                onClick={() => moveTrack(i, +1)}
                title="Move down"
              >↓</button>
            </div>
            <div className={styles.trackNum}>{i + 1}</div>
            <div className={styles.trackCover}>
              {track.albumCover
                ? <img src={track.albumCover} alt="" className={styles.trackCoverImg} />
                : <div className={styles.trackCoverFallback}><Monogram text={track.track_artist || track.track_title} /></div>}
            </div>
            <div className={styles.trackInfo}>
              <div className={styles.trackTitle}>{track.track_title || track.filename || 'Unknown'}</div>
              <div className={styles.trackArtist}>{track.track_artist || ''}</div>
            </div>
            <button
              className={styles.removeBtn}
              onClick={e => { e.stopPropagation(); handleRemoveTrack(selected.id, track.key) }}
              title="Remove from playlist"
            >✕</button>
          </div>
        ))}
      </div>
    </div>
  )
}

