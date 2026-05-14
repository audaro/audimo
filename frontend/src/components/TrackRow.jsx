import { useState } from 'react'
import { useStore } from '../store'
import { authFetch, resolveCacheEntry } from '../api'
import SourcePicker from './SourcePicker'
import styles from './TrackRow.module.css'

function formatDuration(seconds) {
  if (!seconds) return '—'
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export default function TrackRow({ track }) {
  const { addToQueue, showToast, currentTrack, playNow, apiKey, cachedKeys: allCachedKeys = {} } = useStore()
  const isPlaying = currentTrack?.streamUrl &&
    currentTrack?.title === track.title && currentTrack?.artist === track.artist
  const [showPicker, setShowPicker] = useState(false)
  const [loading, setLoading] = useState(false)

  // Build normalized key matching backend format
  const normKey = `${(track.artist||'').toLowerCase().trim()}|${(track.title||'').toLowerCase().trim()}`
  const cachedInfo = (allCachedKeys && typeof allCachedKeys === 'object') ? allCachedKeys[normKey] : null
  const isCached = !!cachedInfo

  const handleRowClick = async () => {
    if (isCached) {
      setLoading(true)
      try {
        const data = await resolveCacheEntry({ key: cachedInfo.cache_key, apiKey })
        if (data && data.streamUrl) {
          playNow({
            title: track.title,
            artist: track.artist || '',
            albumCover: track.album_cover || null,
            streamUrl: data.streamUrl,
            source: data.source,
          })
          showToast(`⚡ Playing from cache`)
          setLoading(false)
          return
        }
      } catch (e) {}
      setLoading(false)
      // Cache resolve failed — fall through to picker
    }

    setShowPicker(true)
  }

  const handlePreview = (e) => {
    e.stopPropagation()
    if (!track.preview) return
    playNow({
      title: track.title + ' (preview)',
      artist: track.artist || '',
      albumCover: track.album_cover || null,
      streamUrl: track.preview,
    })
    showToast('Playing 30s Deezer preview')
  }

  const handleAdd = (e) => {
    e.stopPropagation()
    addToQueue({ ...track, id: track.id || String(Math.random()) })
    showToast(`Added "${track.title}" to queue`)
  }


  return (
    <>
      <div
        className={`${styles.row} ${isPlaying ? styles.playing : ''} ${loading ? styles.loading : ''}`}
        onClick={handleRowClick}
        title={isCached ? `Cached · ${cachedInfo.source || cachedInfo.type} — click to play` : 'Click to choose source'}
      >
        <div className={styles.cover} style={{ position: 'relative' }}>
          {track.album_cover
            ? <img src={track.album_cover} alt="" className={styles.coverImg} />
            : <div className={styles.coverFallback}>{loading ? '' : '🎵'}</div>
          }
          {loading && <div className={styles.coverSpinner} />}
          {isCached && !loading && (
            <div className={styles.cachedBadge}>✓</div>
          )}
        </div>

        <div className={styles.info}>
          <div className={styles.title}>
            {track.title}
            {isCached && <span className={styles.cachedTag}>⚡</span>}
          </div>
          <div className={styles.artist}>{track.artist || track.album || '—'}</div>
        </div>

        <div className={styles.album}>{track.album || ''}</div>
        <div className={styles.duration}>{formatDuration(track.duration)}</div>

        <div className={styles.actions}>
          {track.preview && (
            <button className={styles.previewBtn} onClick={handlePreview} title="30s preview">▶ Preview</button>
          )}
          <button className={styles.btn} onClick={handleAdd} title="Add to queue">+</button>
        </div>
      </div>

      {showPicker && (
        <SourcePicker track={track} onClose={() => setShowPicker(false)} />
      )}
    </>
  )
}
