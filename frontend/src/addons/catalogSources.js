// User-managed catalog sources.
//
// Like apt sources.list / Cydia repos: each source is a URL pointing
// at a JSON catalog file. The Addons tab fetches every configured
// source in parallel and merges the resulting addon lists for display.
//
// Stored in localStorage (browser-side, per-device) — matches the
// addon registry's storage model so phone-browser and desktop both
// work the same way.
//
// Trust model: adding a source means trusting that source author.
// We SHA256-verify binaries against the per-addon manifest, but the
// catalog itself is whatever the source serves — a malicious repo
// author could ship malicious binaries.

const KEY = 'audimo:catalog-sources'

// Stable id for a source from its URL — lets us key dedupe + UI lists
// without needing to walk the array. Cheap djb2 hash; not crypto.
function hashUrl(url) {
  let h = 5381
  for (let i = 0; i < url.length; i++) h = ((h << 5) + h + url.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

function readAll() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeAll(rows) {
  try {
    localStorage.setItem(KEY, JSON.stringify(rows))
  } catch (e) {
    console.warn('[catalog-sources] persist failed:', e?.message || e)
  }
  // Notify listeners (the Addons view subscribes so source list edits
  // re-render without a full page reload). Use a custom event since
  // localStorage's `storage` event only fires across tabs/windows,
  // not within the same document.
  try {
    window.dispatchEvent(new Event('audimo:catalog-sources:changed'))
  } catch {}
}

export function subscribe(handler) {
  const fn = () => handler(list())
  window.addEventListener('audimo:catalog-sources:changed', fn)
  // Cross-window changes too, just in case.
  const onStorage = (e) => { if (e.key === KEY) handler(list()) }
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener('audimo:catalog-sources:changed', fn)
    window.removeEventListener('storage', onStorage)
  }
}

export function list() {
  return readAll()
}

export function get(id) {
  return readAll().find(s => s.id === id) || null
}

// Add a source by URL. Idempotent on URL — re-adding the same URL
// updates `addedAt` to "now" but keeps the same id. Throws on invalid
// URL so the UI can surface a validation error.
export function add(rawUrl) {
  const url = (rawUrl || '').trim()
  if (!url) throw new Error('URL required')
  // Permissive URL check — http(s) only.
  let parsed
  try { parsed = new URL(url) } catch { throw new Error('Not a valid URL') }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('URL must be http:// or https://')
  }
  const id = hashUrl(url)
  const all = readAll()
  const existing = all.find(s => s.id === id)
  const now = Date.now()
  const next = existing
    ? { ...existing, addedAt: existing.addedAt || now }
    : { id, url, addedAt: now }
  const others = all.filter(s => s.id !== id)
  writeAll([...others, next])
  return next
}

export function remove(id) {
  const all = readAll()
  const next = all.filter(s => s.id !== id)
  if (next.length === all.length) return false
  writeAll(next)
  return true
}

// Patch a source row — used by the view to record `lastFetchedAt`,
// `lastError`, and the parsed catalog metadata (name, addon count).
export function update(id, patch) {
  const all = readAll()
  const idx = all.findIndex(s => s.id === id)
  if (idx === -1) return null
  all[idx] = { ...all[idx], ...patch }
  writeAll(all)
  return all[idx]
}
