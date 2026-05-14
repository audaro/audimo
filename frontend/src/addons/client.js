// ──────────────────────────────────────────────────────────────────
// Addon HTTP client — talks to a single addon over HTTPS/HTTP.
//
// Mirrors what `backend/addon_client.py` used to do, but runs in the
// browser. Each call sends the addon's non-secret toggles as
// `body.settings`; secrets live in the addon's URL path-segment and
// are carried automatically by the URL.
//
// Addons must serve `Access-Control-Allow-Origin: *` (or echo the
// Audimo origin). Addons that don't will fail with a CORS error in
// the browser; document this in the install flow.
//
// SSE: the addon protocol uses POST → SSE for resolve.stream, which
// EventSource doesn't support. We use fetch + ReadableStream and
// parse the SSE wire format ourselves. The `streamCall` generator
// yields parsed event objects (one per `data:` line).
// ──────────────────────────────────────────────────────────────────

import { splitUrlSegment } from './registry'

// Extract the optional `addon_key` from the addon's URL config
// segment. Hosted deploys gate every request with a shared-secret
// header; the key is baked into the install URL the user pasted,
// where it sits alongside other path-segment secrets (slskd creds,
// rd_api_key, etc.). Local addons (no key set) return {}.
function addonAuthHeaders(addon) {
  if (!addon || !addon.url) return {}
  const [, parsed] = splitUrlSegment(addon.url)
  const key = parsed && typeof parsed.addon_key === 'string' && parsed.addon_key.trim()
  return key ? { 'X-Audimo-Addon-Key': key } : {}
}

class AddonError extends Error {
  constructor(message, { addon, status } = {}) {
    super(message)
    this.name = 'AddonError'
    this.addon = addon
    this.status = status
  }
}

export { AddonError }

// If the addon URL is loopback but the page itself is being served
// from a non-loopback origin (Tailscale / LAN / phone browser), swap
// the addon's host for the page's host — "localhost" on the phone is
// the phone, not the desktop. Preserves port and path segments (which
// carry the user's secrets).
function rewriteLoopbackForClient(urlStr) {
  if (typeof window === 'undefined' || !urlStr) return urlStr
  let u
  try { u = new URL(urlStr) } catch { return urlStr }
  const loopback = new Set(['localhost', '127.0.0.1', '::1'])
  if (!loopback.has(u.hostname)) return urlStr
  const pageHost = window.location.hostname
  if (!pageHost || loopback.has(pageHost)) return urlStr
  u.hostname = pageHost
  return u.toString().replace(/\/+$/, '')
}

function addonBaseUrl(addon) {
  if (!addon || !addon.url) return ''
  return rewriteLoopbackForClient(addon.url.replace(/\/+$/, ''))
}

function buildBody(addon, payload) {
  // Same shape the backend used: addon receives non-secret toggles in
  // `settings`. The addon merges these with path-segment secrets server
  // side via `_config_from`.
  return {
    ...(payload || {}),
    settings: addon?.settings || {},
  }
}

export async function jsonCall(addon, path, payload, { method = 'POST', timeoutMs = 20000, signal } = {}) {
  if (!addon || !addon.url) throw new AddonError('Addon has no URL', { addon })
  const url = addonBaseUrl(addon) + path

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs)
  // Combine caller's signal with the timeout signal.
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason)
    else signal.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true })
  }

  let r
  try {
    r = await fetch(url, {
      method: method.toUpperCase(),
      headers: {
        'Content-Type': 'application/json',
        ...addonAuthHeaders(addon),
      },
      body: method.toUpperCase() === 'GET' ? undefined : JSON.stringify(buildBody(addon, payload)),
      signal: ctrl.signal,
    })
  } catch (e) {
    clearTimeout(timer)
    throw new AddonError(`${addon.id}: ${e.message || 'network error'}`, { addon })
  }
  clearTimeout(timer)

  if (!r.ok) {
    let detail = ''
    try { detail = (await r.text()).slice(0, 200) } catch {}
    throw new AddonError(`${addon.id}: HTTP ${r.status} — ${detail}`, { addon, status: r.status })
  }
  try {
    return await r.json()
  } catch (e) {
    throw new AddonError(`${addon.id}: invalid JSON response (${e.message})`, { addon })
  }
}

// ── Capability-typed wrappers ────────────────────────────────────────

export function searchTracks(addon, payload, opts) {
  return jsonCall(addon, '/search/tracks', payload, opts)
}

export function searchAudiobooks(addon, payload, opts) {
  return jsonCall(addon, '/search/audiobooks', payload, opts)
}

export function searchBooks(addon, payload, opts) {
  return jsonCall(addon, '/search/books', payload, opts)
}

export function resolveSources(addon, payload, opts) {
  return jsonCall(addon, '/resolve/sources', payload, opts)
}

export function resolveSourcesStream(addon, payload, opts) {
  return streamCall(addon, '/resolve/sources/stream', payload, opts)
}

export function resolveSourceLink(addon, payload, opts) {
  // Resolves an addon-supplied detail URL to whatever opaque source
  // link the addon's protocol uses. Core hands the result back to
  // the same addon for streaming.
  return jsonCall(addon, '/resolve/magnet', payload, opts)
}

export function cacheResolve(addon, entry, opts = {}) {
  const body = { entry }
  if (opts.force) body.force = true
  return jsonCall(addon, '/cache/resolve', body, opts)
}

// Get-style: legacy `GET /stream/{id}` proxy used for per-track stream
// URLs that an addon already has on hand. No body, no settings
// injection.
export async function streamGet(addon, trackId, opts = {}) {
  if (!addon || !addon.url) throw new AddonError('Addon has no URL', { addon })
  const url = addonBaseUrl(addon) + '/stream/' + encodeURIComponent(trackId)
  let r
  try {
    r = await fetch(url, {
      method: 'GET',
      headers: { ...addonAuthHeaders(addon) },
      signal: opts.signal,
    })
  } catch (e) {
    throw new AddonError(`${addon.id}: ${e.message}`, { addon })
  }
  if (!r.ok) throw new AddonError(`${addon.id}: HTTP ${r.status}`, { addon, status: r.status })
  return r.json()
}

// ── SSE: POST → text/event-stream ────────────────────────────────────

/**
 * Stream `resolve.stream` events from an addon. EventSource doesn't
 * support POST or arbitrary headers, so we use fetch with a streaming
 * body and parse the SSE wire format manually.
 *
 * Yields parsed objects (the JSON inside each `data: ...` line).
 *
 * Caller may pass an AbortSignal to stop the stream early — the
 * addon receives a TCP close. Any work it started in response to
 * the request runs to whatever retention the addon defines; that's
 * outside Audimo core's concern.
 */
export async function* streamCall(addon, path, payload, { signal, timeoutMs = 600000 } = {}) {
  if (!addon || !addon.url) throw new AddonError('Addon has no URL', { addon })
  const url = addonBaseUrl(addon) + path

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs)
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason)
    else signal.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true })
  }

  let r
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...addonAuthHeaders(addon),
      },
      body: JSON.stringify(buildBody(addon, payload)),
      signal: ctrl.signal,
    })
  } catch (e) {
    clearTimeout(timer)
    throw new AddonError(`${addon.id}: ${e.message || 'network error'}`, { addon })
  }

  if (!r.ok) {
    clearTimeout(timer)
    let detail = ''
    try { detail = (await r.text()).slice(0, 200) } catch {}
    throw new AddonError(`${addon.id}: HTTP ${r.status} — ${detail}`, { addon, status: r.status })
  }
  if (!r.body) {
    clearTimeout(timer)
    throw new AddonError(`${addon.id}: response has no body`, { addon })
  }

  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      // SSE separates events with a blank line.
      let idx
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const rawEvent = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const ev = parseSseEvent(rawEvent)
        if (ev !== null) yield ev
      }
    }
    // Flush trailing event without blank line (some addons close abruptly).
    if (buf.trim()) {
      const ev = parseSseEvent(buf)
      if (ev !== null) yield ev
    }
  } finally {
    clearTimeout(timer)
    try { reader.releaseLock() } catch {}
  }
}

// Parse one SSE event block ("data: ...\ndata: ...") into a JS value.
// Joins multi-line data fields per the SSE spec, then JSON.parses.
// Returns null if the block was a comment or unparseable.
function parseSseEvent(raw) {
  const dataLines = []
  for (const line of raw.split('\n')) {
    const trimmed = line.replace(/\r$/, '')
    if (!trimmed || trimmed.startsWith(':')) continue
    if (trimmed.startsWith('data:')) {
      dataLines.push(trimmed.slice(5).replace(/^ /, ''))
    }
    // We ignore `event:`, `id:`, `retry:` for now — none of Audimo's
    // addon contracts use them.
  }
  if (dataLines.length === 0) return null
  const joined = dataLines.join('\n')
  try { return JSON.parse(joined) }
  catch { return { raw: joined } }
}
