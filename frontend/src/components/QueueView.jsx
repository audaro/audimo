import { useRef, useState } from 'react'
import { useStore } from '../store'
import { resolveCacheEntry } from '../api'
import { formatSec } from '../utils'
import Monogram from './Monogram'
import SourcePicker from './SourcePicker'
import EmptyState from './EmptyState'
import Icon from './Icon'
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import styles from './QueueView.module.css'

// Queue — design v2 layout.
//   • Header: stat line + h1 + 3 quick actions (Shuffle / Save / Clear)
//   • Now playing: large card pulled from queue[queueIdx]
//   • Up next: queue.slice(queueIdx + 1) — reorderable
//   • Played:   queue.slice(0, queueIdx) (dimmed, not reorderable)
//
// Reorder uses dnd-kit. The legacy HTML5 drag implementation worked
// on desktop but silently failed on touch devices (Mobile Safari /
// Chrome on Android don't fire HTML5 drag events from finger
// gestures). dnd-kit's TouchSensor with a 200ms long-press
// activation lets a tap-to-play coexist with drag-to-reorder on a
// phone, and the PointerSensor preserves the mouse-drag experience
// on desktop.

export default function QueueView() {
  const {
    queue, queueIdx, setQueueIdx, updateQueueItem,
    removeFromQueue, clearQueue, reorderQueue,
    showToast, apiKey,
    shuffle, setShuffle,
    setView,
  } = useStore()

  const playTokenRef = useRef(0)
  // Modal SourcePicker for queue items that have no streamUrl/
  // cache_key yet (added via "+ Queue" on Search). Click-to-play
  // routes through this so the user picks a source.
  const [pickerTrack, setPickerTrack] = useState(null)

  // dnd-kit sensors. PointerSensor handles mouse drags on desktop
  // with a small movement threshold so an intentional click on the
  // row (to play) isn't accidentally interpreted as a drag.
  // TouchSensor needs a long-press (200ms) before drag activates so
  // taps and vertical page scrolls still work as expected on phones.
  // KeyboardSensor lets screen-reader / keyboard-only users reorder
  // with arrow keys — accessibility win for free.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const playAt = async (i) => {
    const track = queue[i]
    if (!track) return
    if (track.streamUrl) { setQueueIdx(i); return }
    // No stream + no cache_key → unresolved queue item (came from
    // the "+ Queue" affordance on Search). Open the source picker
    // so the user can pick a source; once they hit play there, the
    // picker takes over playback.
    if (!track.cache_key) {
      setPickerTrack({
        title: track.title || '',
        artist: track.artist || '',
        album: track.album || '',
        album_cover: track.albumCover || track.album_cover || '',
      })
      return
    }
    const token = ++playTokenRef.current
    showToast('Loading…')
    let resolved
    try {
      resolved = await resolveCacheEntry({ key: track.cache_key, apiKey })
    } catch (e) {
      if (token !== playTokenRef.current) return
      showToast(`Could not load track: ${e?.message || 'unknown error'}`)
      return
    }
    if (token !== playTokenRef.current) return
    if (!resolved?.streamUrl) { showToast('Could not load track'); return }
    updateQueueItem(i, { streamUrl: resolved.streamUrl, source: resolved.source })
    setQueueIdx(i)
  }

  const playing = queueIdx >= 0 ? queue[queueIdx] : null
  const upNext = queueIdx >= 0 ? queue.slice(queueIdx + 1) : queue
  const played = queueIdx > 0 ? queue.slice(0, queueIdx) : []

  // Aggregate duration in seconds (skip items without one).
  const totalSecs = queue.reduce((s, t) => s + (Number(t.duration) || 0), 0)

  if (!queue.length) {
    return (
      <div className={styles.wrap}>
        <header className={styles.pageHead}>
          <div>
            <div className={styles.statLine}>0 tracks</div>
            <h1 className={styles.title}>Queue</h1>
          </div>
        </header>
        <EmptyState
          title="Queue is empty"
          body="Add tracks from search results or your library to start a session."
          action={{ label: 'Open Search', onClick: () => setView('search') }}
        />
      </div>
    )
  }

  return (
    <div className={styles.wrap}>
      <header className={styles.pageHead}>
        <div>
          <div className={styles.statLine}>
            {queue.length} {queue.length === 1 ? 'track' : 'tracks'}
            {totalSecs > 0 && <> · {formatSec(totalSecs)} total</>}
          </div>
          <h1 className={styles.title}>Queue</h1>
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={`${styles.actionBtn} ${shuffle ? styles.actionBtnActive : ''}`}
            onClick={() => setShuffle(!shuffle)}
            title="Shuffle"
          >
            <span className={styles.actionGlyph}>⇄</span> Shuffle
          </button>
          <button
            type="button"
            className={`${styles.actionBtn} ${styles.actionBtnDanger}`}
            onClick={clearQueue}
            title="Empty the queue"
          >
            <span className={styles.actionGlyph}>✕</span> Clear
          </button>
        </div>
      </header>

      {playing && (
        <section className={styles.section}>
          <div className={styles.sectionLabel}>Now playing</div>
          <div className={styles.nowPlayingCard}>
            <div className={styles.npArt}>
              {playing.albumCover
                ? <img src={playing.albumCover} alt="" />
                : <Monogram text={playing.artist || playing.title} />}
            </div>
            <div className={styles.npMeta}>
              <div className={styles.npTitle}>{playing.title || 'Unknown'}</div>
              <div className={styles.npArtist}>
                {playing.artist || '—'}
                {playing.album && <span className={styles.npAlbum}> · {playing.album}</span>}
              </div>
              <div className={styles.npBadges}>
                {playing.quality && <span className={styles.qualityBadge}>{playing.quality}</span>}
                {playing.source && <span className={styles.sourceLabel}>VIA {String(playing.source).toUpperCase()}</span>}
              </div>
            </div>
            <button
              type="button"
              className={styles.npOpen}
              onClick={() => useStore.getState().setNowPlayingExpanded(true)}
              title="Open Now Playing (F)"
            >Open ↗</button>
          </div>
        </section>
      )}

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionLabel}>Up next · {upNext.length} {upNext.length === 1 ? 'track' : 'tracks'}</span>
        </div>
        {upNext.length === 0 ? (
          <div className={styles.emptyHint}>End of queue. Enable shuffle or queue more tracks.</div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={({ active, over }) => {
              if (!over || active.id === over.id) return
              // ids are stable per-track strings; convert back to
              // queue indices and ask the store to do the swap.
              const upNextIds = upNext.map((t, i) => rowId(t, (queueIdx >= 0 ? queueIdx + 1 : 0) + i))
              const fromUp = upNextIds.indexOf(active.id)
              const toUp = upNextIds.indexOf(over.id)
              if (fromUp < 0 || toUp < 0) return
              const fromQ = (queueIdx >= 0 ? queueIdx + 1 : 0) + fromUp
              const toQ = (queueIdx >= 0 ? queueIdx + 1 : 0) + toUp
              reorderQueue(fromQ, toQ)
            }}
          >
            <SortableContext
              items={upNext.map((t, i) => rowId(t, (queueIdx >= 0 ? queueIdx + 1 : 0) + i))}
              strategy={verticalListSortingStrategy}
            >
              {upNext.map((track, i) => {
                const realIndex = (queueIdx >= 0 ? queueIdx + 1 : 0) + i
                const id = rowId(track, realIndex)
                return (
                  <SortableRow
                    key={id}
                    id={id}
                    track={track}
                    index={i + 1}
                    onPlay={() => playAt(realIndex)}
                    onRemove={() => removeFromQueue(realIndex)}
                  />
                )
              })}
            </SortableContext>
          </DndContext>
        )}
      </section>

      {played.length > 0 && (
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <span className={`${styles.sectionLabel} ${styles.sectionLabelDim}`}>
              Played · {played.length}
            </span>
          </div>
          {played.map((track, i) => (
            <Row
              key={track.cache_key || track.streamUrl || `pl-${i}-${track.title}`}
              track={track}
              dim
              icon="✓"
              onPlay={() => playAt(i)}
              onRemove={() => removeFromQueue(i)}
            />
          ))}
        </section>
      )}

      {pickerTrack && (
        <SourcePicker track={pickerTrack} onClose={() => setPickerTrack(null)} />
      )}
    </div>
  )
}

// Stable id for a queue row — needed by dnd-kit's SortableContext
// and as the React key. Track-level keys (cache_key, streamUrl)
// repeat in queues with the same item added twice, so we append
// the queue index to disambiguate.
function rowId(track, realIndex) {
  return `${track.cache_key || track.streamUrl || 'q'}-${realIndex}-${track.title || ''}`
}

// Sortable variant for the Up Next list — drag handle wired to
// dnd-kit listeners, transform pulled from useSortable. The
// played-history rows use the plain Row below (not reorderable).
function SortableRow({ id, track, index, onPlay, onRemove }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id })
  const dur = Number(track.duration) || 0
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    // Lift the dragging row visually — z-index pushes it above
    // siblings so the surrounding rows' transforms don't render
    // on top of it during the reorder animation.
    zIndex: isDragging ? 2 : undefined,
    opacity: isDragging ? 0.85 : undefined,
  }
  const cls = [
    styles.row,
    isDragging ? styles.rowDragging : '',
  ].filter(Boolean).join(' ')
  return (
    <div ref={setNodeRef} style={style} className={styles.rowWrap}>
      <button type="button" className={cls} onClick={onPlay}>
        <span
          {...attributes}
          {...listeners}
          className={styles.rowHandle}
          aria-label="Reorder track"
          // Stop click from bubbling to the row (which would play
          // the track); long-press/drag handlers are attached via
          // dnd-kit listeners above.
          onClick={(e) => e.stopPropagation()}
          // Disable native touch scroll on the handle so the
          // TouchSensor receives the long-press cleanly without
          // the browser hijacking the gesture for page-scroll.
          style={{ touchAction: 'none', cursor: 'grab' }}
        >
          <Icon name="drag" size={14} />
        </span>
        <span className={styles.rowIndex}>{index ?? ''}</span>
        <div className={styles.rowThumb}>
          {track.albumCover
            ? <img src={track.albumCover} alt="" />
            : <Monogram text={track.artist || track.title} />}
        </div>
        <div className={styles.rowMeta}>
          <div className={styles.rowTitle}>{track.title || 'Unknown'}</div>
          <div className={styles.rowSub}>{track.artist || '—'}</div>
        </div>
        {track.quality && <span className={styles.rowQuality}>{track.quality}</span>}
        {dur > 0 && <span className={styles.rowDuration}>{formatSec(dur)}</span>}
        {onRemove && (
          <span
            role="button"
            tabIndex={0}
            aria-label="Remove from queue"
            className={styles.rowRemove}
            onClick={(e) => { e.stopPropagation(); onRemove() }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onRemove() } }}
          >✕</span>
        )}
      </button>
    </div>
  )
}

function Row({ track, index, dim, icon, onPlay, onRemove }) {
  const dur = Number(track.duration) || 0
  const cls = [
    styles.row,
    dim ? styles.rowDim : '',
  ].filter(Boolean).join(' ')
  return (
    <button
      type="button"
      className={cls}
      onClick={onPlay}
    >
      <span className={styles.rowHandle} aria-hidden="true">
        {icon ? icon : <Icon name="drag" size={14} />}
      </span>
      <span className={styles.rowIndex}>{index ?? ''}</span>
      <div className={styles.rowThumb}>
        {track.albumCover
          ? <img src={track.albumCover} alt="" />
          : <Monogram text={track.artist || track.title} />}
      </div>
      <div className={styles.rowMeta}>
        <div className={styles.rowTitle}>{track.title || 'Unknown'}</div>
        <div className={styles.rowSub}>{track.artist || '—'}</div>
      </div>
      {track.quality && <span className={styles.rowQuality}>{track.quality}</span>}
      {dur > 0 && <span className={styles.rowDuration}>{formatSec(dur)}</span>}
      {onRemove && (
        <span
          role="button"
          tabIndex={0}
          aria-label="Remove from queue"
          className={styles.rowRemove}
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onRemove() } }}
        >✕</span>
      )}
    </button>
  )
}
