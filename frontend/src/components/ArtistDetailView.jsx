import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { authFetch } from '../api'
import SourcePicker from './SourcePicker'
import Monogram from './Monogram'
import styles from './ArtistDetailView.module.css'

// Artist detail surfaced from a Search → artist click. Pulls top
// tracks + discography from the Deezer-backed core endpoints
// (/api/artist/:id/info|tracks|albums). The custom-artist-image
// override the user uploaded in Library is honoured here too via
// /api/library/artist-image — same chain as ArtistAvatar in the
// Library views.
//
// Songs are clickable and route through SourcePicker exactly like
// search results do, so the user picks a source the same way as
// from the regular Search tab.
//
// Tracks render a minimal album link (no Albums detail page yet —
// could come later). Album cards are display-only for now.
export default function ArtistDetailView({ artist, onBack }) {
  const { addToQueue, showToast } = useStore()
  const [info, setInfo] = useState(null)
  const [tracks, setTracks] = useState(null)
  const [albums, setAlbums] = useState(null)
  const [customImage, setCustomImage] = useState(null)
  const [picker, setPicker] = useState(null)

  useEffect(() => {
    if (!artist?.id) return
    let cancelled = false
    Promise.all([
      authFetch(`/api/artist/${artist.id}/info`).then(r => r.ok ? r.json() : null).catch(() => null),
      authFetch(`/api/artist/${artist.id}/tracks?limit=30`).then(r => r.ok ? r.json() : { tracks: [] }).catch(() => ({ tracks: [] })),
      authFetch(`/api/artist/${artist.id}/albums?limit=40`).then(r => r.ok ? r.json() : { albums: [] }).catch(() => ({ albums: [] })),
      authFetch(`/api/library/artist-image?name=${encodeURIComponent(artist.name)}`).then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([i, t, a, c]) => {
      if (cancelled) return
      setInfo(i)
      setTracks(t.tracks || [])
      setAlbums(a.albums || [])
      setCustomImage(c?.url || null)
    })
    return () => { cancelled = true }
  }, [artist?.id, artist?.name])

  const heroImage = customImage || info?.picture || artist?.picture || null
  const fanCount = info?.nb_fan
  const fanCountLabel = fanCount && fanCount >= 1_000_000
    ? `${(fanCount / 1_000_000).toFixed(1)}M fans`
    : fanCount && fanCount >= 1_000
      ? `${(fanCount / 1_000).toFixed(0)}K fans`
      : fanCount ? `${fanCount} fans` : ''

  const formatDuration = (s) => {
    if (!s) return '—'
    return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
  }

  return (
    <div className={styles.wrap}>
      <button className={styles.back} onClick={onBack}>← back to search</button>

      <div className={styles.hero}>
        <div className={styles.heroAvatar}>
          {heroImage
            ? <img src={heroImage} alt="" />
            : <Monogram text={artist?.name || '?'} />}
        </div>
        <div className={styles.heroInfo}>
          <div className={styles.heroLabel}>Artist</div>
          <h1 className={styles.heroName}>{artist?.name}</h1>
          <div className={styles.heroMeta}>
            {fanCountLabel}
            {info?.nb_album ? ` · ${info.nb_album} albums` : ''}
          </div>
        </div>
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Top tracks</h2>
        {tracks === null ? (
          <div className={styles.empty}>Loading…</div>
        ) : tracks.length === 0 ? (
          <div className={styles.empty}>No tracks available.</div>
        ) : (
          <div className={styles.trackList}>
            {tracks.map((t, i) => (
              <div
                key={t.id || i}
                className={styles.track}
                onClick={() => setPicker({
                  title: t.title, artist: t.artist, album: t.album,
                  album_cover: t.album_cover, duration: t.duration, preview: t.preview,
                })}
                title="Click to choose source"
              >
                <span className={styles.trackIndex}>{i + 1}</span>
                <div className={styles.trackCover}>
                  {t.album_cover
                    ? <img src={t.album_cover} alt="" loading="lazy" />
                    : <Monogram text={t.title} />}
                </div>
                <div className={styles.trackInfo}>
                  <div className={styles.trackTitle}>{t.title}</div>
                  <div className={styles.trackAlbum}>{t.album}</div>
                </div>
                <span className={styles.trackDuration}>{formatDuration(t.duration)}</span>
                <button
                  className={styles.queueBtn}
                  title="Add to queue"
                  onClick={(e) => {
                    e.stopPropagation()
                    addToQueue({
                      title: t.title,
                      artist: t.artist,
                      albumCover: t.album_cover,
                      preview: t.preview,
                    })
                    showToast(`Added "${t.title}" to queue`)
                  }}
                >≡+</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {albums && albums.length > 0 && (
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>Discography</h2>
          <div className={styles.albumGrid}>
            {albums.map(a => (
              <div key={a.id} className={styles.albumCard}>
                <div className={styles.albumCover}>
                  {a.cover
                    ? <img src={a.cover} alt="" loading="lazy" />
                    : <Monogram text={a.title} />}
                </div>
                <div className={styles.albumTitle}>{a.title}</div>
                <div className={styles.albumMeta}>
                  {a.release_date ? a.release_date.slice(0, 4) : ''}
                  {a.nb_tracks ? ` · ${a.nb_tracks} tracks` : ''}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {picker && (
        <SourcePicker track={picker} onClose={() => setPicker(null)} />
      )}
    </div>
  )
}
