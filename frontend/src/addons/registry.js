// ──────────────────────────────────────────────────────────────────
// Addon registry — device-local storage for installed addons.
//
// In the device-as-client architecture (post-migration), the Audimo
// backend never persists addon URLs or per-addon credentials. The
// registry lives entirely in the browser: each device that has Audimo
// installed maintains its own list of installed addons in localStorage.
// Multi-device "sync" means re-pasting the install URL on each device
// (the Stremio model).
//
// Why localStorage and not IndexedDB:
//   • Addon lists are small (single-digit to low-double-digit entries).
//   • The whole list is read once on mount and rarely written; the
//     synchronous API makes the rest of the app simpler.
//   • If a user installs hundreds of addons we'd swap to IndexedDB —
//     the public surface of this module is intentionally small enough
//     for that to be a localized change.
//
// Storage shape (single key, JSON-encoded array):
//   tunnel:addons = [{
//     id:           string,        // from manifest
//     url:          string,        // includes secrets path-segment
//     manifest:     object,        // full manifest JSON, cached at install
//     enabled:      boolean,       // user toggle
//     settings:     object,        // non-secret toggles (mirror of what
//                                  //   the configure URL emits, minus
//                                  //   secrets — used to render Configure
//                                  //   prefill correctly)
//     installedAt:  number,        // Date.now() at first install
//     updatedAt:    number,        // Date.now() at last update
//   }, ...]
//
// All credentials (any addon-defined secret fields) are encoded
// inside `url`'s base64url path-segment. They never appear elsewhere.
//
// Storage encryption: the persisted JSON is wrapped in AES-GCM by
// `secretStore.encryptString` before being written to localStorage,
// so the raw values aren't visible from devtools' Application panel
// or a flat read of the browser's profile dir. The key lives in
// IndexedDB as a non-extractable CryptoKey. See secretStore.js for
// the full threat model.
//
// The public API (`list()`, `get()`, `subscribe()`, `withCapability()`)
// stays synchronous-after-init: a one-time async hydration in `init()`
// fills the in-memory cache, then everything else reads from there.
// Writes update the cache synchronously and persist asynchronously
// (fire-and-forget — encrypt failures are logged but don't block UI).
// ──────────────────────────────────────────────────────────────────

import { encryptString, decryptString } from './secretStore'

const STORAGE_KEY = 'tunnel:addons'         // legacy plaintext (back-compat)
const STORAGE_KEY_ENC = 'tunnel:addons:enc' // AES-GCM ciphertext blob

// In-memory subscriber list — components can subscribe() to get notified
// when the registry changes (install/remove/update). Used by the Zustand
// slice to mirror the registry into reactive state.
const subscribers = new Set()

// Module-level cache. `null` = not yet hydrated; `[]` = hydrated, empty.
// All public sync methods read from here; writes go through writeAll
// which updates the cache then persists asynchronously.
let _cache = null
let _initPromise = null

// Optional write-through callback, registered by store.js once the
// auth token is available. Mirrors local mutations to the backend so
// other devices on the same Audimo instance see the change on next
// reload. We deliberately don't import `api.js` here — registry.js
// stays a pure browser-storage module so it can be imported in
// non-app contexts (CLI scripts, tests) without dragging in the
// auth/store dependency graph.
//
// Failures are silent in the registry; the store-side handler is
// responsible for surfacing them as a toast if the user cares. Local
// mutations always succeed regardless — offline writes get written
// through on the next mutation that succeeds, or on next boot's pull.
let _writeThrough = null

export function setWriteThrough(fn) { _writeThrough = fn }

function notify() {
  for (const cb of subscribers) {
    try { cb() } catch (e) { console.error('[registry] subscriber error', e) }
  }
}

async function loadFromStorage() {
  // Prefer the encrypted blob; fall back to the legacy plaintext key
  // exactly once (it'll be re-persisted as ciphertext immediately).
  try {
    const encRaw = localStorage.getItem(STORAGE_KEY_ENC)
    if (encRaw) {
      const blob = JSON.parse(encRaw)
      const plain = await decryptString(blob)
      if (plain != null) {
        const parsed = JSON.parse(plain)
        return Array.isArray(parsed) ? parsed : []
      }
      console.warn('[registry] encrypted blob present but undecryptable — '
                 + 'falling back to legacy plaintext if any')
    }
  } catch (e) {
    console.warn('[registry] decrypt path errored; trying legacy plaintext', e)
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch (e) {
    console.error('[registry] failed to parse storage; resetting', e)
    return []
  }
}

async function persist(list) {
  try {
    const blob = await encryptString(JSON.stringify(list))
    localStorage.setItem(STORAGE_KEY_ENC, JSON.stringify(blob))
    // Wipe the legacy plaintext key now that we have a ciphertext copy.
    // Decrypt has already been verified inside encryptString's roundtrip
    // (we just produced this blob with the same key we'll decrypt with).
    localStorage.removeItem(STORAGE_KEY)
  } catch (e) {
    // SubtleCrypto can be missing in old WebViews / locked-down
    // contexts. Fall back to plaintext so the app keeps working — the
    // user is no worse off than before encryption was added.
    console.warn('[registry] encryption failed; storing plaintext', e)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
    localStorage.removeItem(STORAGE_KEY_ENC)
  }
}

// Awaited by `loadAddons` in store.js before any sync read. Idempotent.
export function init() {
  if (_cache !== null) return Promise.resolve()
  if (_initPromise) return _initPromise
  _initPromise = (async () => {
    const rows = await loadFromStorage()
    _cache = rows
    // Migrate legacy plaintext to the encrypted slot on first
    // successful hydration.
    if (rows.length > 0 && localStorage.getItem(STORAGE_KEY)
        && !localStorage.getItem(STORAGE_KEY_ENC)) {
      await persist(rows)
    }
    // Best-effort: refresh manifests in the background so addon
    // updates (new capabilities, label changes, version bumps) flow
    // in without the user reinstalling. Doesn't block init —
    // sync reads return the cached row until the refresh lands.
    if (rows.length > 0) {
      // Defer past first paint; nothing here is on the critical
      // boot path.
      setTimeout(() => { refreshManifests().catch(() => {}) }, 1500)
    }
  })()
  _initPromise.catch(() => { _initPromise = null; _cache = null })
  return _initPromise
}

// Re-fetch each installed addon's manifest in parallel and update
// the cached row if it changed. Best-effort: failures are swallowed
// (the addon is probably just offline; we'll try again next boot).
//
// Two staleness signals trigger a write: version string change, or
// any structural change to capabilities / settings_schema / display.
// Anything else (description tweaks, etc.) we ignore so we don't
// thrash localStorage on every boot.
async function refreshManifests() {
  const rows = readAll()
  if (rows.length === 0) return
  const TIMEOUT_MS = 5000
  const fetchOne = async (row) => {
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
      const r = await fetch(`${row.url.replace(/\/+$/, '')}/manifest.json`, {
        method: 'GET',
        signal: ctrl.signal,
      })
      clearTimeout(t)
      if (!r.ok) return null
      const fresh = await r.json()
      if (!fresh || fresh.id !== row.id) return null  // identity drift = bail
      return fresh
    } catch {
      return null
    }
  }
  const results = await Promise.all(rows.map(fetchOne))
  let changed = false
  const next = rows.map((row, i) => {
    const fresh = results[i]
    if (!fresh) return row
    if (manifestsEquivalent(row.manifest, fresh)) return row
    changed = true
    return { ...row, manifest: fresh, updatedAt: Date.now() }
  })
  if (changed) writeAll(next)
}

// Two manifests are equivalent (no refresh needed) when version,
// capabilities, settings_schema, and display all match. Anything
// else is cosmetic and not worth a write.
function manifestsEquivalent(a, b) {
  if (!a || !b) return false
  if (a.version !== b.version) return false
  const j = (v) => JSON.stringify(v ?? null)
  if (j(a.capabilities) !== j(b.capabilities)) return false
  if (j(a.settings_schema) !== j(b.settings_schema)) return false
  if (j(a.display) !== j(b.display)) return false
  return true
}

function readAll() {
  // After init() the cache is populated. Calls before init return [],
  // matching the prior "no addons yet" behavior on first paint.
  return _cache || []
}

// Outstanding-write promise. `flush()` returns it so callers that
// need persistence to settle before proceeding (e.g. App.jsx
// redeeming a pair token then reloading the page) can await it
// without changing `writeAll`'s caller-side sync semantics.
let _lastWrite = Promise.resolve()
export function flush() {
  return _lastWrite
}

function writeAll(list) {
  _cache = list
  notify()
  _lastWrite = persist(list).catch(() => {})
  return _lastWrite
}

// ── Public API ──────────────────────────────────────────────────────

export function list() {
  return readAll()
}

export function get(id) {
  return readAll().find(a => a.id === id) || null
}

export function subscribe(cb) {
  subscribers.add(cb)
  return () => subscribers.delete(cb)
}

// Install or update an addon from a URL. Fetches /manifest.json,
// validates, splits the URL's config segment into secrets (kept in
// the URL) vs non-secrets (saved as `settings` so the Configure page
// can prefill them).
//
// Idempotent on (addon.id) — reinstalling overwrites url + settings,
// preserves `enabled` and `installedAt` from the prior row.
//
// `opts.deviceLocal` skips the backend write-through. Use it for the
// bundled Tauri sidecars (loopback URLs that aren't valid on other
// devices) so a desktop's `localhost:9005` doesn't crowd out a
// secret-bearing URL stored at the backend that other devices need.
export async function install(rawUrl, opts = {}) {
  let url = (rawUrl || '').trim()
  if (!url) throw new Error('URL required')
  if (url.endsWith('/manifest.json')) url = url.slice(0, -'/manifest.json'.length)
  url = url.replace(/\/+$/, '')

  let manifest
  try {
    const r = await fetch(`${url}/manifest.json`, { method: 'GET' })
    if (!r.ok) throw new Error(`Manifest fetch failed (HTTP ${r.status})`)
    manifest = await r.json()
  } catch (e) {
    throw new Error(`Could not fetch manifest from ${url}: ${e.message}`)
  }
  const id = manifest && manifest.id
  if (!id) throw new Error("Manifest missing 'id'")

  const { secrets, nonSecrets, baseUrl } = splitUrlByManifest(url, manifest)
  const finalUrl = secrets && Object.keys(secrets).length
    ? `${baseUrl.replace(/\/+$/, '')}/${b64urlEncode(JSON.stringify(secrets))}`
    : baseUrl

  const now = Date.now()
  const all = readAll()
  const existing = all.find(a => a.id === id)
  const next = {
    id,
    url: finalUrl,
    manifest,
    enabled: existing ? existing.enabled : true,
    settings: nonSecrets || {},
    installedAt: existing ? existing.installedAt : now,
    updatedAt: now,
  }
  const others = all.filter(a => a.id !== id)
  writeAll([...others, next])
  // Mirror to backend. We await this and revert the local write on
  // failure, because the boot-time pull treats backend as source of
  // truth — a local-only entry gets silently dropped on the next
  // reload, leaving the catalog UI showing "Install" for an addon
  // the user thinks they installed. Awaiting + reverting makes
  // install transactional from the caller's POV: either both
  // mirrors succeeded or neither did, and the caller (e.g.
  // installFromCatalog's retry helper) can retry on transient
  // failures. Skipped for device-local installs (bundled sidecars) —
  // their loopback URL is meaningless on other devices and would
  // clobber a hosted version's secret-bearing URL on the backend.
  if (_writeThrough && !opts.deviceLocal) {
    try {
      await _writeThrough({ op: 'install', url: rawUrl, addon: next })
    } catch (e) {
      // Revert: restore prior state (either remove the new entry, or
      // put back the previous version) so local + backend stay aligned.
      if (existing) {
        writeAll([...others, existing])
      } else {
        writeAll(others)
      }
      throw new Error(`Backend sync failed: ${e?.message || e}`)
    }
  }
  return next
}

// Swap the origin (host:port) of an installed addon's URL without
// re-fetching the manifest. Used to reconcile sidecar URLs when a
// sidecar restarts on a new port.
//
// Transactional: local write reverts on backend-sync failure so the
// next boot-time pull doesn't undo a local-only change (and the
// caller sees a real error instead of a silent rollback later).
export async function patchUrl(id, newOrigin) {
  const all = readAll()
  const idx = all.findIndex(a => a.id === id)
  if (idx === -1) return null
  const entry = all[idx]
  let newUrl
  try {
    const oldOrigin = new URL(entry.url).origin
    if (oldOrigin === newOrigin) return entry
    newUrl = entry.url.replace(oldOrigin, newOrigin)
  } catch { return null }
  const next = { ...entry, url: newUrl, updatedAt: Date.now() }
  writeAll([...all.slice(0, idx), next, ...all.slice(idx + 1)])
  if (_writeThrough) {
    try {
      await _writeThrough({ op: 'install', url: newUrl, addon: next })
    } catch (e) {
      writeAll(all)  // restore prior row
      throw new Error(`Backend sync failed: ${e?.message || e}`)
    }
  }
  return next
}

export async function remove(id) {
  const all = readAll()
  const next = all.filter(a => a.id !== id)
  if (next.length === all.length) return false
  writeAll(next)
  if (_writeThrough) {
    try {
      await _writeThrough({ op: 'remove', id })
    } catch (e) {
      writeAll(all)  // restore the entry we just dropped
      throw new Error(`Backend sync failed: ${e?.message || e}`)
    }
  }
  return true
}

export async function setEnabled(id, enabled) {
  const all = readAll()
  const idx = all.findIndex(a => a.id === id)
  if (idx === -1) return null
  const updated = { ...all[idx], enabled: !!enabled, updatedAt: Date.now() }
  const next = all.slice()
  next[idx] = updated
  writeAll(next)
  if (_writeThrough) {
    try {
      await _writeThrough({ op: 'setEnabled', id, enabled: !!enabled })
    } catch (e) {
      writeAll(all)  // restore prior enabled state
      throw new Error(`Backend sync failed: ${e?.message || e}`)
    }
  }
  return updated
}

export async function patchSettings(id, partial) {
  const all = readAll()
  const idx = all.findIndex(a => a.id === id)
  if (idx === -1) return null
  const entry = all[idx]
  const newSettings = { ...(entry.settings || {}), ...partial }
  const updated = { ...entry, settings: newSettings, updatedAt: Date.now() }
  const next = all.slice()
  next[idx] = updated
  writeAll(next)
  if (_writeThrough) {
    try {
      await _writeThrough({ op: 'patchSettings', id, settings: newSettings, addon: updated })
    } catch (e) {
      writeAll(all)
      throw new Error(`Backend sync failed: ${e?.message || e}`)
    }
  }
  return updated
}

// Replace the registry wholesale. Used by the one-time seed-from-backend
// migration on first load after the device-as-client upgrade.
export function replaceAll(rows) {
  writeAll(Array.isArray(rows) ? rows : [])
}

// Return only enabled addons that advertise a given capability. Mirrors
// the backend's old `user_addons_with(user_id, capability)` helper.
export function withCapability(capability) {
  return readAll().filter(a =>
    a.enabled !== false &&
    Array.isArray(a.manifest?.capabilities) &&
    a.manifest.capabilities.includes(capability)
  )
}

// ── Manifest schema introspection ───────────────────────────────────

// Walk a manifest's (possibly sectioned) settings_schema and return the
// set of keys whose fields are secrets. Same rules as the backend used:
// `secret: true` OR `type: "password"`.
export function manifestSecretKeys(manifest) {
  const out = new Set()
  function walk(items) {
    if (!Array.isArray(items)) return
    for (const f of items) {
      if (!f || typeof f !== 'object') continue
      if (f.type === 'section') { walk(f.fields); continue }
      if (!f.key) continue
      if (f.secret === true || f.type === 'password') out.add(String(f.key))
    }
  }
  walk(manifest?.settings_schema)
  return out
}

// ── URL config-segment parsing ──────────────────────────────────────

export function b64urlEncode(jsonStr) {
  const b = btoa(jsonStr)
  return b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function b64urlDecode(seg) {
  try {
    const pad = '='.repeat((4 - (seg.length % 4)) % 4)
    return atob(seg.replace(/-/g, '+').replace(/_/g, '/') + pad)
  } catch { return null }
}

// If the URL's last path segment is base64url(JSON), peel it off and
// return [base, parsedObj]. Otherwise return [url, null].
export function splitUrlSegment(urlStr) {
  let u
  try { u = new URL(urlStr) } catch { return [urlStr, null] }
  const parts = u.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
  if (parts.length === 0) return [u.origin, null]
  const last = parts[parts.length - 1]
  const decoded = b64urlDecode(last)
  if (decoded) {
    try {
      const obj = JSON.parse(decoded)
      if (obj && typeof obj === 'object') {
        const base = u.origin + (parts.length > 1 ? '/' + parts.slice(0, -1).join('/') : '')
        return [base, obj]
      }
    } catch {}
  }
  return [u.origin + (parts.length ? '/' + parts.join('/') : ''), null]
}

// Split a URL's config segment by manifest secret-key set. Returns
// { secrets, nonSecrets, baseUrl } where baseUrl has no segment.
function splitUrlByManifest(url, manifest) {
  const [baseUrl, parsed] = splitUrlSegment(url)
  if (!parsed) return { secrets: {}, nonSecrets: {}, baseUrl }
  const secretKeys = manifestSecretKeys(manifest)
  const secrets = {}
  const nonSecrets = {}
  for (const [k, v] of Object.entries(parsed)) {
    if (secretKeys.has(k)) secrets[k] = v
    else nonSecrets[k] = v
  }
  return { secrets, nonSecrets, baseUrl }
}

// Build the URL the in-app Configure button should open. Merges the
// addon's URL secrets with its non-secret toggles so the addon's
// /configure page sees the full config and renders show_if fields
// correctly. Secrets win on key collision.
// Return the merged config (URL secrets + non-secret settings) for an
// addon. Secrets win on collision — that's the same precedence the
// addon's /configure flow uses.
export function addonConfig(addon) {
  if (!addon || !addon.url) return {}
  const [, secrets] = splitUrlSegment(addon.url)
  return { ...(addon.settings || {}), ...(secrets || {}) }
}

// Decide whether a cache entry can still be resolved on this device,
// given the currently-installed addons. Used by My Music to hide
// rows the user can't actually play (e.g. an entry that requires an
// addon credential the user has since removed).
export function entryIsResolvableOnDevice(entry) {
  if (!entry) return false
  const aid = entry.addon_id
  if (!aid) return true
  const addon = get(aid)
  // Default to visible whenever we can't make a confident negative
  // determination — e.g. addons haven't loaded into the registry yet
  // on first paint. Hiding rows on uncertainty makes the library
  // disappear in normal startup races; the actual resolve call will
  // still toast if it fails. We only POSITIVELY hide when the addon
  // IS installed and we can prove it lacks what the entry needs.
  if (!addon) return true
  // Local-file-backed entries are always playable from disk. If the
  // file is missing the addon's cache.resolve will surface the
  // "file deleted" prompt; that's a better UX than silently hiding
  // the row.
  if (entry.local_file || entry.addon_local_file) return true
  return true
}

export function configureUrl(addon) {
  if (!addon || !addon.url) return ''
  const [base, secrets] = splitUrlSegment(addon.url)
  const merged = { ...(addon.settings || {}), ...(secrets || {}) }
  if (Object.keys(merged).length === 0) {
    return base.replace(/\/+$/, '') + '/configure'
  }
  const seg = b64urlEncode(JSON.stringify(merged))
  return base.replace(/\/+$/, '') + '/' + seg + '/configure'
}
