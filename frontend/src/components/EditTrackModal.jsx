import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { updateCacheEntry, authFetch } from '../api'
import { useStore } from '../store'
import useIsMobile from '../hooks/useIsMobile'
import MobileSheet from './MobileSheet'
import styles from './EditTrackModal.module.css'

async function uploadCover(file, key) {
  // Backend requires both `file` and `key` (it stores under a hash of
  // the entry key so a future edit overwrites instead of stacking).
  // Without the key the endpoint 400s and the user got "Upload failed"
  // with no further detail.
  const form = new FormData()
  form.append('file', file)
  form.append('key', key || '')
  const r = await authFetch('/api/cache/upload-cover', { method: 'POST', body: form })
  if (!r.ok) {
    const detail = await r.json().catch(() => null)
    throw new Error(detail?.detail || `Upload failed (HTTP ${r.status})`)
  }
  const d = await r.json()
  return d.albumCover
}

function Combobox({ value, onChange, options, placeholder }) {
  const [open, setOpen] = useState(false)
  const [inputVal, setInputVal] = useState(value)
  const inputRef = useRef(null)
  const dropRef = useRef(null)
  const wrapRef = useRef(null)

  useEffect(() => { setInputVal(value) }, [value])

  useEffect(() => {
    const handler = (e) => { if (!wrapRef.current?.contains(e.target) && !dropRef.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Reposition the dropdown every render while open — directly mutates DOM, no state lag
  useEffect(() => {
    if (!open || !inputRef.current || !dropRef.current) return
    const r = inputRef.current.getBoundingClientRect()
    const maxH = 240
    const spaceBelow = window.innerHeight - r.bottom
    const spaceAbove = r.top
    const top = spaceBelow >= maxH || spaceBelow >= spaceAbove
      ? r.bottom + 4
      : r.top - Math.min(maxH, dropRef.current.offsetHeight) - 4
    dropRef.current.style.top = top + 'px'
    dropRef.current.style.left = r.left + 'px'
    dropRef.current.style.width = r.width + 'px'
  })

  const filtered = options.filter(o => o && o.toLowerCase().includes(inputVal.toLowerCase()) && o !== inputVal)

  const select = (opt) => {
    setInputVal(opt)
    onChange(opt)
    setOpen(false)
  }

  return (
    <div className={styles.comboWrap} ref={wrapRef}>
      <input
        ref={inputRef}
        className={styles.input}
        value={inputVal}
        onChange={e => { setInputVal(e.target.value); onChange(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
      />
      {open && filtered.length > 0 && createPortal(
        <div ref={dropRef} className={styles.comboDropdown} style={{ position: 'fixed', top: 0, left: 0 }}>
          {filtered.map(opt => (
            <div key={opt} className={styles.comboItem} onMouseDown={() => select(opt)}>
              {opt}
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  )
}

// `saveOverride` lets a caller take over the persistence step. The
// audiobook legacy library uses this — its rows have no cache_key,
// so updateCacheEntry would 404; instead the caller writes to
// /api/audiobooks/library directly. When omitted the default
// updateCacheEntry path runs.
export default function EditTrackModal({ entry, onClose, onSaved, saveOverride, artists = [], albums = [], kind = 'track' }) {
  // Audiobook variant: relabels Title/Artist as Title/Author, hides
  // the Album field (audiobooks don't have albums in our data model),
  // and swaps the header. Same persistence path otherwise — caller is
  // still responsible for providing saveOverride if the row isn't in
  // the cache table.
  const isAudiobook = kind === 'audiobook'
  const labels = isAudiobook
    ? { header: 'Edit Audiobook', title: 'Title', artist: 'Author', titlePh: 'Audiobook title', artistPh: 'Author name' }
    : { header: 'Edit Track', title: 'Song Name', artist: 'Artist', titlePh: 'Song name', artistPh: 'Artist name' }
  const { showToast } = useStore()
  const [title, setTitle] = useState(entry.track_title || '')
  const [artist, setArtist] = useState(entry.track_artist || '')
  const [album, setAlbum] = useState(entry.track_album || '')
  const [cover, setCover] = useState(entry.albumCover || '')
  const [preview, setPreview] = useState(entry.albumCover || '')
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const fileRef = useRef(null)

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleFile = async (file) => {
    if (!file) return
    const local = URL.createObjectURL(file)
    setPreview(local)
    setUploading(true)
    try {
      const url = await uploadCover(file, entry.key)
      setCover(url)
    } catch (e) {
      showToast('Upload failed: ' + e.message)
      setPreview(cover)
    } finally {
      setUploading(false)
    }
  }

  const handleDrop = (e) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file?.type.startsWith('image/')) handleFile(file)
  }

  const save = async () => {
    setSaving(true)
    try {
      const fields = {
        track_title: title.trim(),
        track_artist: artist.trim(),
        track_album: album.trim(),
        albumCover: cover.trim() || null,
      }
      if (typeof saveOverride === 'function') {
        await saveOverride({ ...entry, ...fields })
      } else {
        await updateCacheEntry({ key: entry.key, ...fields })
      }
      onSaved({ ...entry, ...fields })
      showToast('Saved')
      onClose()
    } catch (e) {
      showToast('Save failed: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  const overlayRef = useRef(null)
  const mousedownTargetRef = useRef(null)
  const isMobile = useIsMobile()

  // The form body — shared between the mobile sheet and the
  // desktop dialog so we don't duplicate field markup. The cover
  // row stacks vertically on mobile (full-width thumb above the
  // URL input) via CSS; the desktop dialog keeps the side-by-side
  // grid it always had.
  const body = (
    <>
      <div className={styles.coverRow}>
        <div
          className={styles.playerThumb}
          onClick={() => fileRef.current?.click()}
          onDrop={handleDrop}
          onDragOver={e => e.preventDefault()}
        >
          {preview
            ? <img src={preview} alt="" className={styles.playerThumbImg} onError={() => setPreview('')} />
            : <span className={styles.playerThumbFallback}>🎵</span>}
          <div className={styles.thumbOverlay}>
            <span>{uploading ? 'Uploading…' : 'Click to upload'}</span>
          </div>
          <input ref={fileRef} type="file" accept="image/*" className={styles.fileInput}
            onChange={e => handleFile(e.target.files[0])} />
        </div>

        <div className={styles.coverRight}>
          <label className={styles.label}>Or paste a URL</label>
          <input
            className={styles.input}
            value={cover}
            onChange={e => { setCover(e.target.value); setPreview(e.target.value) }}
            placeholder="https://…"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
      </div>

      <label className={styles.label}>{labels.title}</label>
      <input className={styles.input} value={title} onChange={e => setTitle(e.target.value)} placeholder={labels.titlePh} />

      <label className={styles.label}>{labels.artist}</label>
      <Combobox value={artist} onChange={setArtist} options={artists} placeholder={labels.artistPh} />

      {!isAudiobook && (
        <>
          <label className={styles.label}>Album</label>
          <Combobox value={album} onChange={setAlbum} options={albums} placeholder="Album name" />
        </>
      )}

      <div className={styles.actions}>
        <button className={styles.cancelBtn} onClick={onClose}>Cancel</button>
        <button className={styles.saveBtn} onClick={save} disabled={saving || uploading}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </>
  )

  if (isMobile) {
    return (
      <MobileSheet open={true} onClose={onClose} title={labels.header}>
        <div className={styles.sheetBody}>
          {body}
        </div>
      </MobileSheet>
    )
  }

  return (
    <div
      className={styles.overlay}
      ref={overlayRef}
      onMouseDown={e => { mousedownTargetRef.current = e.target }}
      onClick={() => { if (mousedownTargetRef.current === overlayRef.current) onClose() }}
    >
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>
          <span className={styles.headerTitle}>{labels.header}</span>
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
        </div>
        {body}
      </div>
    </div>
  )
}
