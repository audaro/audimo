export const formatMs = (ms) => {
  if (!ms) return '—'
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export const formatSec = (s) => {
  if (!s || !isFinite(s) || isNaN(s)) return '0:00'
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

// HH:MM:SS for any duration ≥ 1h, M:SS otherwise. Audiobooks routinely
// run multi-hour, and the bare M:SS rendering wraps past 60 (e.g.
// "143:21" for a 2h23m chapter) which is unreadable.
export const formatHMS = (s) => {
  if (!s || !isFinite(s) || isNaN(s)) return '0:00'
  const total = Math.floor(s)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${m}:${String(sec).padStart(2, '0')}`
}

export const formatBytes = (b) => {
  if (!b) return '—'
  if (b > 1e9) return (b / 1e9).toFixed(1) + ' GB'
  if (b > 1e6) return (b / 1e6).toFixed(1) + ' MB'
  return (b / 1e3).toFixed(0) + ' KB'
}

export const isAudio = (fn = '') =>
  /\.(mp3|flac|aac|ogg|opus|m4a|wav|wma|alac|ape)$/i.test(fn)

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

