import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { authFetch } from '../api'
import EmptyState from './EmptyState'
import Monogram from './Monogram'
import styles from './HistoryView.module.css'

function groupByDay(entries) {
  const groups = {}
  for (const entry of entries) {
    const d = new Date(entry.played_at * 1000)
    const key = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
    if (!groups[key]) groups[key] = []
    groups[key].push(entry)
  }
  return Object.entries(groups)
}

function timeAgo(unixSeconds) {
  const diff = Date.now() - unixSeconds * 1000
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return new Date(unixSeconds * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export default function HistoryView() {
  const { playNow, showToast } = useStore()
  const apiKey = useStore(s => s.apiKey)
  const [entries, setEntries] = useState([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    authFetch('/api/history?limit=500')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (cancelled) return
        setEntries(d?.entries || [])
        setLoaded(true)
      })
      .catch(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [apiKey])

  const groups = groupByDay(entries)

  const handlePlay = async (entry) => {
    // History rows store title/artist but not a cache key. A row whose
    // matching library entry was deleted (or never saved) used to call
    // playNow optimistically — the Player then silently failed to
    // resolve and the click looked like a no-op. Check the cache up
    // front, play if found, otherwise route to Search prefilled so
    // the user has a working path.
    const norm = (s) => (s || '').trim().toLowerCase()
    const wantTitle = norm(entry.track_title)
    const wantArtist = norm(entry.track_artist)
    let match = null
    try {
      const r = await authFetch('/api/cache/list')
      if (r.ok) {
        const d = await r.json()
        match = (d.entries || []).find(e =>
          norm(e.track_title) === wantTitle &&
          (!wantArtist || norm(e.track_artist) === wantArtist)
        ) || null
      }
    } catch {
      // Network blip — fall back to optimistic play.
    }
    if (match) {
      showToast(`▶ ${entry.track_title}`)
      playNow({
        title: entry.track_title,
        artist: entry.track_artist,
        albumCover: entry.album_cover,
        cacheKey: match.key,
        streamUrl: match.streamUrl,
        source: match.source,
      })
      return
    }
    // Not in library any more (entry removed, addon uninstalled, etc.).
    // Surface this instead of letting the click look like a no-op.
    showToast(
      `Couldn't find "${entry.track_title}" in your library — re-add it from Search`,
      { kind: 'error' },
    )
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.header}>
        <h1 className={styles.title}>History</h1>
        <span className={styles.count}>{entries.length} plays</span>
      </div>

      <div className={styles.content}>
        {!loaded ? null : entries.length === 0 ? (
          <EmptyState
            title="No history yet"
            body="Tracks you play will show up here, grouped by day."
          />
        ) : (
          groups.map(([day, items]) => (
            <div key={day} className={styles.group}>
              <div className={styles.dayLabel}>{day}</div>
              {items.map((entry) => (
                <button
                  key={`${entry.played_at}|${entry.track_title}|${entry.track_artist}`}
                  type="button"
                  className={styles.row}
                  onClick={() => handlePlay(entry)}
                  aria-label={`Play ${entry.track_title}${entry.track_artist ? ' by ' + entry.track_artist : ''}`}
                >
                  <div className={styles.cover}>
                    {entry.album_cover
                      ? <img src={entry.album_cover} alt="" className={styles.coverImg} />
                      : <Monogram text={entry.track_title || entry.track_artist || '?'} size="md" />}
                  </div>
                  <div className={styles.info}>
                    <div className={styles.trackTitle}>{entry.track_title}</div>
                    <div className={styles.trackArtist}>{entry.track_artist || '—'}</div>
                  </div>
                  <div className={styles.right}>
                    {entry.source && <span className={styles.sourceBadge}>{entry.source}</span>}
                    <span className={styles.time}>{timeAgo(entry.played_at)}</span>
                  </div>
                </button>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
