// ── Source-link resolve + cache.resolve (saved-entry replay) ───────
//
// `resolveMagnet` converts an addon-supplied detail URL into the
// opaque source link the addon expects next. `cacheResolveEntry`
// re-resolves a saved library entry into a playable URL, handling
// redispatch through `resolve.stream` when the entry's source is
// ephemeral. `cacheResolveEntryForce` is the explicit-redownload
// variant invoked after the user confirms a missing local file.

import * as registry from './registry'
import * as client from './client'
import { rewriteAddonHost } from './_shared'
import { isCoreStreamableSource, streamFromCoreServer } from './_streaming'
import { normalizeStreamEvent } from './resolve'

// ── Source-link resolve ─────────────────────────────────────────────
// Asks any installed addon to convert an addon-supplied detail URL
// into the opaque source link the addon's protocol expects to see
// next. Core never inspects the link's contents.

export async function resolveMagnet(detailUrl, { signal } = {}) {
  const addons = registry.withCapability('resolve.magnet')
  if (addons.length === 0) {
    throw new Error('No installed addon can resolve this source.')
  }
  let lastErr
  for (const addon of addons) {
    try {
      const r = await client.resolveSourceLink(addon, { detail_url: detailUrl }, { signal })
      if (r && r.magnet) return { magnet: r.magnet, addon_id: addon.id }
    } catch (e) { lastErr = e }
  }
  throw new Error('No addon could resolve this source.' + (lastErr ? ' ' + lastErr.message : ''))
}

// ── Cache.resolve (re-resolve a saved library entry) ────────────────
//
// Mirrors backend's _addon_cache_resolve. Looks up the addon by the
// entry's addon_id, calls /cache/resolve, handles redispatch by
// re-running resolve.stream end-to-end. Returns the resolved
// {streamUrl, ...} dict, or null if the entry is unresolvable
// (addon missing, expired, etc.).
export async function cacheResolveEntry(entry, { signal, force } = {}) {
  const debug = (msg) => {
    try {
      const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__
      const url = (isTauri ? 'http://127.0.0.1:8000' : '') + '/api/_debug_log'
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag: 'cacheResolve', msg }),
      }).catch(() => {})
    } catch {}
  }
  const addonId = entry?.addon_id
  debug(`called addonId=${addonId} type=${entry?.type} key=${entry?.key || '?'}`)
  if (!addonId) { debug('no addonId on entry'); return null }
  // Prefer cache.resolve, fall back to resolve.stream-only addons.
  // If the originating addon isn't installed locally, fall back to any
  // installed addon with cache.resolve — the aggregator pattern means
  // audimo-aio knows how to dispatch by entry.addon_id to its
  // configured extensions, so the call still succeeds when the
  // extension itself isn't a separately-installed addon.
  const cacheResolvers = registry.withCapability('cache.resolve')
  let addon = cacheResolvers.find(a => a.id === addonId)
    || registry.withCapability('resolve.stream').find(a => a.id === addonId)
    || cacheResolvers[0]
  if (!addon) {
    debug(`no addon with cache.resolve installed — caps=${registry.list().map(a => a.id).join(',')}`)
    console.warn(`[orchestrator] no installed addon can resolve cached entry (origin=${addonId})`)
    return null
  }
  debug(`addon=${addon.id}${addon.id !== addonId ? ` (delegating from ${addonId})` : ''} url=${(addon.url||'').slice(0,80)}`)

  let result
  try {
    result = await client.cacheResolve(addon, entry, { signal, force })
    debug(`cache.resolve returned: ${JSON.stringify(result).slice(0, 200)}`)
  } catch (e) {
    debug(`cache.resolve THREW: ${e?.status || ''} ${e?.message || e}`)
    console.warn(`[orchestrator] cache.resolve ${addonId} failed:`, e.message)
    return null
  }

  // Local file was previously cached on disk and the user (or
  // something) deleted it. Don't auto-redownload — surface to the
  // caller so it can prompt the user. The caller can then call
  // `cacheResolveEntryForce` to actually run the redispatch when
  // the user confirms.
  if (result?.local_file_missing) {
    return {
      status: 'local_file_missing',
      expectedPath: result.expected_path || '',
      redispatchPayload: result.redispatch_payload || null,
      addonId,
    }
  }

  // Redispatch: addon couldn't return a URL directly (entry's source
  // is ephemeral). Re-run resolve.stream to materialize a fresh one.
  if (result?.redispatch) {
    debug(`redispatch begin payload=${JSON.stringify(result.payload || {}).slice(0,200)}`)
    const payload = result.payload || {}
    // Torrent payloads route through the bundled core libtorrent
    // server, bypassing the addon. Non-torrent payloads stay on the
    // originating addon (its /resolve/stream knows how to materialize
    // its own ephemeral sources, e.g. RD-backed direct URLs).
    let last = null
    let evCount = 0
    try {
      const trackHint = entry?.track_payload || {
        title: entry?.track_title || '',
        artist: entry?.track_artist || '',
      }
      const events = isCoreStreamableSource(payload?.source)
        ? streamFromCoreServer(payload.source, { signal, track: trackHint })
        : client.streamCall(addon, '/resolve/stream', payload, { signal })
      for await (const ev of events) {
        evCount += 1
        last = isCoreStreamableSource(payload?.source)
          ? ev
          : normalizeStreamEvent(ev, addon)
        if (last?.status === 'done' || last?.status === 'error' || last?.streamUrl) break
      }
    } catch (e) {
      debug(`redispatch streamCall THREW after ${evCount} events: ${e?.message || e}`)
      return null
    }
    debug(`redispatch end after ${evCount} events; status=${last?.status} streamUrl=${!!last?.streamUrl}`)
    if (!last || last.status === 'error' || !last.streamUrl) return null
    result = last
  }

  // Rewrite a relative streamUrl to absolute against the addon's URL.
  const su = result?.streamUrl || ''
  if (su.startsWith('/')) {
    result.streamUrl = rewriteAddonHost(addon.url.replace(/\/+$/, '')) + su
  }
  return result
}

// Force a redispatch (re-download from original source) for an entry
// whose local file went missing. Caller invokes this after the user
// confirms the prompt raised by `cacheResolveEntry`'s
// `local_file_missing` return.
export async function cacheResolveEntryForce(addonId, redispatchPayload, { signal } = {}) {
  // Same fallback as cacheResolveEntry: delegate through any locally-
  // installed addon if the originating one isn't directly installed.
  const cacheResolvers = registry.withCapability('cache.resolve')
  let addon = cacheResolvers.find(a => a.id === addonId)
    || registry.withCapability('resolve.stream').find(a => a.id === addonId)
    || cacheResolvers[0]
  if (!addon) return null
  const payload = redispatchPayload || {}
  // Torrent payloads route through the bundled core libtorrent server
  // (Stremio-style :11471), bypassing the addon. Non-torrent payloads
  // stay on the originating addon.
  let last = null
  const trackHint = payload?.track || payload?.track_payload || {}
  try {
    const events = isCoreStreamableSource(payload?.source)
      ? streamFromCoreServer(payload.source, { signal, track: trackHint })
      : client.streamCall(addon, '/resolve/stream', payload, { signal })
    for await (const ev of events) {
      last = isCoreStreamableSource(payload?.source)
        ? ev
        : normalizeStreamEvent(ev, addon)
      if (last?.status === 'done' || last?.status === 'error' || last?.streamUrl) break
    }
  } catch {
    return null
  }
  if (!last || last.status === 'error' || !last.streamUrl) return null
  const su = last.streamUrl || ''
  if (su.startsWith('/') && !isCoreStreamableSource(payload?.source)) {
    last.streamUrl = rewriteAddonHost(addon.url.replace(/\/+$/, '')) + su
  }
  return last
}
