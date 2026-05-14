// ── Default-source playback ────────────────────────────────────────
//
// When the user picks a single addon as their "default source" in
// Settings, search-row clicks bypass the source picker entirely:
// resolve sources from that one addon, take the first hit, play it.
// Saving to the user's library only happens when they click a row's
// + button — the play action alone is ephemeral.
//
// Falls back to opening the picker if the default addon is missing,
// disabled, or returns no sources.

import * as client from './client'
import * as registry from './registry'
import {
  resolveStream,
  normalizeStreamEvent,
} from './resolve'
import { rewriteAddonHost } from './_shared'
import { isCoreStreamableSource, streamFromCoreServer } from './_streaming'

// The addon already ranks its sources. Take the first one it emits.
function pickBest(sources) {
  return (Array.isArray(sources) && sources.length > 0) ? sources[0] : null
}

// Find the addon by id and verify it's still installed + enabled +
// advertises resolve.sources. Returns null if any check fails so the
// caller can fall back to the picker.
function pickAddon(addonId) {
  if (!addonId) return null
  const candidates = registry.withCapability('resolve.sources')
  return candidates.find(a => a.id === addonId) || null
}

/**
 * Resolve + play a track via a single named addon.
 *
 * Returns `{ ok: true, source, ready, addon }` on success — `source`
 * is the picked source object (suitable for cache/add later),
 * `ready` is the addon's normalised "ready" event (carries
 * streamUrl, mimeType, expires_at, etc.).
 *
 * Returns `{ ok: false, reason }` on failure. Reasons:
 *   - 'no_addon'           — addon missing/disabled/uninstalled
 *   - 'no_sources'         — addon returned 0 sources for the query
 *   - 'resolve_stream_err' — addon errored during resolve.stream
 *   - 'no_stream_url'      — resolve.stream finished without a URL
 *   - 'cancelled'          — caller-aborted via AbortSignal
 */
export async function resolveAndPlayDefault(
  { addonId, track },
  { signal } = {},
) {
  const addon = pickAddon(addonId)
  if (!addon) return { ok: false, reason: 'no_addon' }
  console.log('[default-source] addon url:', addon.url)

  // 1) Search via the SSE streaming endpoint — same path the source
  // picker uses, which is known to work against both local and
  // DO-hosted addon deployments.
  const allSources = []
  try {
    const reqPayload = { title: track.title, artist: track.artist, album: track.album, limit: 50 }
    if (track.kind) reqPayload.kind = track.kind
    const stream = client.resolveSourcesStream(
      addon,
      reqPayload,
      { signal, timeoutMs: 60000 },
    )
    const eventLog = []
    for await (const ev of stream) {
      eventLog.push(ev?.type || 'unknown')
      if (ev?.type === 'section' && Array.isArray(ev.sources)) {
        for (const s of ev.sources) {
          allSources.push({ ...s, addon_id: s.addon_id || addon.id })
        }
      }
    }
    console.log('[default-source] stream events:', eventLog, 'sources:', allSources.length)
  } catch (e) {
    if (signal?.aborted) return { ok: false, reason: 'cancelled' }
    const msg = e?.message || String(e)
    console.warn('[default-source] resolve.sources.stream failed:', msg)
    return { ok: false, reason: 'resolve_sources_err', detail: `${msg} · url: ${addon.url}` }
  }
  const picked = pickBest(allSources)
  if (!picked) return { ok: false, reason: 'resolve_sources_err', detail: `no sources (${allSources.length} collected)` }
  console.log('[default-source] picked:', picked.name, 'kind:', picked.kind)

  // Stamp addon_id (single-addon flow may skip the orchestrator's
  // shaping pass that normally adds it).
  const source = { ...picked, addon_id: picked.addon_id || addon.id }

  // 2) Resolve a playable stream URL.
  //
  // Sources the desktop streaming sidecar can handle go through
  // `streamFromCoreServer`; everything else goes through the addon's
  // own resolve.stream.
  const useCore = isCoreStreamableSource(source)
  let firstReady = null
  let lastError = null
  try {
    const eventStream = useCore
      ? streamFromCoreServer(source, { signal, track })
      : resolveStream(
          { addonId: addon.id, source, track },
          { signal, timeoutMs: 60000 },
        )
    for await (const evRaw of eventStream) {
      // streamFromCoreServer already yields normalized
      // {status, streamUrl, ...} events. resolveStream yields raw
      // SSE events that need translating.
      const ev = useCore ? evRaw : normalizeStreamEvent(evRaw, addon)
      if (ev.status === 'done' && ev.streamUrl) {
        firstReady = ev
        break
      }
      if (ev.status === 'error') {
        lastError = ev
        break
      }
      // ignore 'downloading' — the 15s timeout in the caller cuts
      // long flows off and falls back to the picker. Default-source
      // mode is for instant playback only; the picker is the right
      // surface for slow peer or debrid downloads (it shows
      // progress).
    }
  } catch (e) {
    if (signal?.aborted) return { ok: false, reason: 'cancelled' }
    console.warn('[default-source] stream pipeline threw:', e?.message || e)
    return { ok: false, reason: 'resolve_stream_err' }
  }

  if (!firstReady) {
    if (lastError) {
      console.warn('[default-source] stream error:', lastError.message)
    }
    return { ok: false, reason: 'no_stream_url' }
  }
  return { ok: true, source, ready: firstReady, addon }
}

/**
 * Build the cacheBody payload that /api/cache/add expects, using the
 * same shape SourcePicker uses for its auto-save. Used by the + button
 * on search rows (default-source mode) — given a track + the picked
 * source + the ready event, return what to POST to /api/cache/add.
 */
export function buildCacheBody({ track, source, ready }) {
  return {
    ...ready,
    type: 'addon',
    addon_id: source.addon_id,
    ...(track.kind === 'audiobook' ? { category: 'audiobook' } : {}),
    title: track.title,
    artist: track.artist || '',
    album: track.album || '',
    streamUrl: ready.streamUrl,
    albumCover: track.album_cover || ready.albumCover || '',
    source: ready.source || source.source || 'Addon',
    addon_payload: ready.payload || null,
    source_payload: {
      ...source,
      ...(ready.info_hash ? { info_hash: ready.info_hash } : {}),
      ...(Number.isInteger(ready.file_idx) ? { file_idx: ready.file_idx } : {}),
    },
    track_payload: {
      title: track.title,
      artist: track.artist || '',
      album: track.album || '',
    },
  }
}
