import { useStore } from './store'
import * as orchestrator from './addons/orchestrator'

// In the Tauri webview the page origin is `tauri://localhost`, which
// WebKit refuses to fetch for non-asset paths — so a relative `/api/...`
// fetch throws `TypeError: The string did not match the expected
// pattern.` Detect Tauri and pin the API base to the local backend.
// In dev (Vite at :5173) and phone-browser mode, same-origin relative
// URLs work via the proxy / static-file mount respectively.
// Evaluated lazily — Tauri may inject __TAURI_INTERNALS__ after this
// module's top-level code has already run, which would otherwise pin
// API_ORIGIN to "" and make every relative fetch throw
// "The string did not match the expected pattern." in WKWebView.
const isTauri = () => typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__
const apiOrigin = () => (isTauri() ? 'http://127.0.0.1:8000' : '')

// Resolve a possibly-relative URL (anything starting with `/`) against
// the API origin. Absolute URLs (http://, https://, etc.) pass through.
export function resolveUrl(url) {
  if (!isTauri()) return url
  if (typeof url !== 'string') return url
  if (url.startsWith('/')) return apiOrigin() + url
  return url
}

// Same idea but exported for component use when constructing URLs by
// hand (e.g. `<audio src={apiUrl('/api/cache/stream/...')}>`).
export const apiUrl = resolveUrl

// ──────────────────────────────────────────────────────────────────
// Cache resolve (device-as-client edition).
//
// Backend's ``/api/cache/resolve`` returns one of two shapes now:
//   • For local entries (uploads / legacy local-cached rows) — the
//     resolved {streamUrl, source, …} dict, exactly as before.
//   • For addon-produced entries — a delegation envelope of the form
//     ``{delegate_addon, key, entry}``. We re-resolve the entry on this
//     device by calling the addon's ``cache.resolve`` directly.
// Components don't need to know which path ran; they just await this
// helper and either get a resolved object or null.
// ──────────────────────────────────────────────────────────────────
export async function resolveCacheEntry({ key, apiKey, force } = {}) {
  if (!key) return null
  let body
  try {
    const r = await authFetch('/api/cache/resolve', {
      method: 'POST',
      body: JSON.stringify({ api_key: apiKey || '', key, force: !!force }),
    })
    if (!r.ok) {
      // Surface the actual error to the caller via a toast so the
      // user isn't left guessing why a track won't play. Common
      // failure modes: extension addon not configured (entry's
      // addon_id has no matching extension URL), backend lost the
      // entry, or the addon process is down.
      let detail = ''
      try {
        const j = await r.json()
        detail = j?.detail || ''
      } catch {}
      try {
        const { showToast } = useStore.getState()
        showToast(detail || `Track resolve failed (HTTP ${r.status})`, 5000)
      } catch {}
      return null
    }
    body = await r.json()
  } catch {
    return null
  }
  if (body && body.delegate_addon && body.entry) {
    const resolved = await orchestrator.cacheResolveEntry(body.entry, { force: !!body.force })
    // Addon doesn't implement /cache/resolve (404, malformed
    // response, addon down) — fall back to the cached streamUrl
    // when it's a stable upstream URL. Internet Archive, public
    // CDNs, and SoundCloud/YouTube extracts via /api/audio/proxy
    // all stay valid across sessions; only debrid links need
    // refresh. If the cached row has a streamUrl, use it.
    if (!resolved || !resolved.streamUrl) {
      const fallbackUrl = body.entry?.streamUrl || body.entry?.stream_url || ''
      if (fallbackUrl) {
        return {
          streamUrl: fallbackUrl,
          mimeType: body.entry.mime_type || body.entry.mimeType || 'audio/mpeg',
          source: body.entry.source || '',
        }
      }
      return null
    }
    // If the addon reports the previously-cached local file is gone,
    // ask the user what to do instead of silently re-downloading.
    if (resolved && resolved.status === 'local_file_missing') {
      const title = body.entry?.track_payload?.title || body.entry?.track_title
                  || body.entry?.filename || 'this track'
      const { askConfirm } = useStore.getState()
      const ok = await askConfirm({
        title: 'File not on disk',
        message:
          `"${title}" is no longer in your music folder.\n\n` +
          `Re-download it from the original source, or remove it from your library?`,
        confirmLabel: 'Re-download',
        cancelLabel: 'Remove from library',
      })
      if (ok) {
        return orchestrator.cacheResolveEntryForce(
          resolved.addonId,
          resolved.redispatchPayload,
        )
      }
      // User declined → remove from library so it stops appearing.
      try {
        await authFetch('/api/cache/remove', {
          method: 'DELETE',
          body: JSON.stringify({ key }),
        })
      } catch {}
      return null
    }
    return resolved
  }
  return body
}

// Audimo is single-user-per-install. The desktop shell runs the
// backend on 127.0.0.1 with no auth required. When the user opts to
// expose the app for phone access, they set AUDIMO_API_KEY on the
// backend and paste the same value into the frontend (stored as
// `apiKey` in the store, surfaced as `X-API-Key` on every request).
function getApiKey() {
  const s = useStore.getState()
  return s.apiKey || s.token || ''
}

export function authFetch(url, opts = {}) {
  const apiKey = getApiKey()
  const isFormData = opts.body instanceof FormData
  return fetch(resolveUrl(url), {
    ...opts,
    headers: {
      ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
      ...(apiKey ? { 'X-API-Key': apiKey } : {}),
      ...opts.headers,
    },
  })
}

async function req(path, opts = {}, auth = true) {
  const headers = { 'Content-Type': 'application/json', ...opts.headers }
  if (auth) {
    const apiKey = getApiKey()
    if (apiKey) headers['X-API-Key'] = apiKey
  }
  const r = await fetch(apiOrigin() + '/api' + path, { headers, ...opts })
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: r.statusText }))
    throw new Error(err.detail || `HTTP ${r.status}`)
  }
  return r.json()
}

// ── Identity ────────────────────────────────────────────────────
// `/api/auth/me` survives as a "what does the backend think my session
// is?" probe — useful for the frontend to know whether the API key it
// has matches what the backend expects. There's no register / login.
export const authMe = () => req('/auth/me')

// ── Pairing (QR onboarding) ─────────────────────────────────────
// Desktop mints a one-shot token bundling its API key + addon list.
// Mobile redeems the token once to seed its own localStorage. The
// mint call needs an API key explicitly because during onboarding the
// store hasn't been hydrated yet.
export async function pairMint({ apiKey, addons, baseUrl, ttlSeconds, reusable }) {
  const body = { addons: addons || [] }
  if (Number.isFinite(ttlSeconds)) body.ttl_seconds = ttlSeconds
  if (reusable) body.reusable = true
  const r = await fetch((baseUrl || apiOrigin()) + '/api/pair/mint', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    body: JSON.stringify(body),
  })
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: r.statusText }))
    throw new Error(err.detail || `HTTP ${r.status}`)
  }
  return r.json()
}

export async function pairRedeem({ token, baseUrl }) {
  const r = await fetch((baseUrl || '') + '/api/pair/redeem', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: r.statusText }))
    throw new Error(err.detail || `HTTP ${r.status}`)
  }
  return r.json()
}

// ── Playlists ────────────────────────────────────────────────────
export const fetchPlaylists = () => req('/playlists')

export const createPlaylistApi = (name) =>
  req('/playlists', { method: 'POST', body: JSON.stringify({ name }) })

export const updatePlaylistApi = (id, name) =>
  req(`/playlists/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) })

export const deletePlaylistApi = (id) =>
  req(`/playlists/${id}`, { method: 'DELETE' })

export const addTrackToPlaylistApi = (playlistId, track, position) =>
  req(`/playlists/${playlistId}/tracks`, { method: 'POST', body: JSON.stringify({ track, position }) })

export const removeTrackFromPlaylistApi = (playlistId, trackKey) =>
  req(`/playlists/${playlistId}/tracks/${encodeURIComponent(trackKey)}`, { method: 'DELETE' })

export const reorderPlaylistTracksApi = (playlistId, tracks) =>
  req(`/playlists/${playlistId}/tracks`, { method: 'PUT', body: JSON.stringify({ tracks }) })

// ── Deezer ──────────────────────────────────────────────────────
// These endpoints are auth-gated on the backend (Depends(get_current_user)),
// so when remote access is enabled the calls 401 without a key. The
// previous `auth=false` third arg dated back to local-only mode and
// silently broke search after the user turned remote access on. Pass
// the key by default; backend's local-only mode ignores it.
export const searchArtists = (q, limit = 12) =>
  req(`/search/artists?q=${encodeURIComponent(q)}&limit=${limit}`)

export const searchTracks = (q, limit = 30) =>
  req(`/search/tracks?q=${encodeURIComponent(q)}&limit=${limit}`)

export const getArtistTracks = (id, limit = 50) =>
  req(`/artist/${id}/tracks?limit=${limit}`)

export const getArtistInfo = (id) =>
  req(`/artist/${id}/info`)

export const addToCache = (payload) =>
  req('/cache/add', { method: 'POST', body: JSON.stringify(payload) })

export const updateCacheEntry = (payload) =>
  req('/cache/update', { method: 'PATCH', body: JSON.stringify(payload) })

