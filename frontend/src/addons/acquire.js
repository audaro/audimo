// ── acquireTrack — headless source-pick + download + library save ──
//
// Generic primitive that takes a track + optional policy, fans out
// across enabled resolve.sources addons, picks one source by policy,
// runs resolve.stream, and persists the result to the library cache.
//
// Used by:
//   • The postMessage RPC bridge that exposes window.audimo to iframe-
//     hosted addon tab pages (AddonTabView). Addons like the importer
//     loop through a queue calling acquireTrack per row.
//   • Any future "batch download" / "auto radio" feature that needs a
//     non-interactive equivalent of the SourcePicker click flow.
//
// Core never inspects the source object beyond its addon_id and the
// optional `is_cached` / `is_peer` flags used for policy hints — the
// addon's source schema flows through verbatim, same as SourcePicker.
//
// Policy shape (all fields optional):
//   {
//     prefer: ['addon-id-a', 'addon-id-b', ...],  // priority order
//     fallback_order: ['addon-id-c', ...],         // tried after prefer
//     min_seeders: 0,                              // skip torrents below
//     require_cached: false,                       // only is_cached:true
//   }
// When policy is empty/absent, acquireTrack picks the first available
// source across all addons (same as if the user clicked the top row).

import { authFetch } from '../api'
import * as registry from './registry'
import { resolveSourcesStreaming, resolveStream } from './resolve'

function pickSourceByPolicy(sectionsByAddon, policy = {}) {
  const { prefer = [], fallback_order = [], min_seeders = 0, require_cached = false } = policy

  const isEligible = (src) => {
    if (require_cached && !src.is_cached && !src.rd_cached) return false
    if (min_seeders > 0 && (src.seeders || 0) < min_seeders) return false
    return true
  }

  // Try each preferred addon in order, then fallback order, then any.
  const order = [...prefer, ...fallback_order]
  const seen = new Set(order)
  for (const id of Object.keys(sectionsByAddon)) {
    if (!seen.has(id)) order.push(id)
  }

  for (const addonId of order) {
    const sources = sectionsByAddon[addonId] || []
    const picked = sources.find(isEligible)
    if (picked) return picked
  }
  return null
}

// Async generator. Yields events of the same shape as resolveStream
// plus a few orchestration-level events:
//   { status: 'resolving', message }
//   { status: 'picked', source, addon_id }
//   { status: 'downloading', pct, message }
//   { status: 'done', streamUrl, cacheKey, source, addon_id }
//   { status: 'error', message }
export async function* acquireTrack(
  { title, artist = '', album = '', kind = 'music', policy = {} } = {},
  { signal } = {},
) {
  if (!title) {
    yield { status: 'error', message: 'acquireTrack requires title' }
    return
  }

  yield { status: 'resolving', message: 'Searching sources…' }

  // Collect sections by addon. resolveSourcesStreaming streams sections
  // as they arrive — for headless acquire we just accumulate them all
  // before picking. (Could optimize to short-circuit when a prefer
  // match arrives, but the search latency is dominated by the slowest
  // addon and stopping early skips backup sources we may need.)
  const sectionsByAddon = {}
  await resolveSourcesStreaming(
    { title, artist, album, kind },
    {
      signal,
      onSection: (sec) => {
        if (!sec.addon_id || !Array.isArray(sec.sources)) return
        sectionsByAddon[sec.addon_id] = (sectionsByAddon[sec.addon_id] || []).concat(sec.sources)
      },
    },
  )

  const picked = pickSourceByPolicy(sectionsByAddon, policy)
  if (!picked) {
    yield { status: 'error', message: 'No source found for this track' }
    return
  }
  yield { status: 'picked', source: picked, addon_id: picked.addon_id }

  // Run resolve.stream — same machinery SourcePicker uses.
  let firstReady = null
  for await (const ev of resolveStream(
    {
      addonId: picked.addon_id,
      source: picked,
      track: { title, artist, album, kind },
    },
    { signal },
  )) {
    if (ev?.status === 'error') {
      yield { status: 'error', message: ev.message || 'stream failed' }
      return
    }
    if (ev?.status === 'downloading') {
      yield { status: 'downloading', pct: ev.pct, message: ev.message }
    }
    if (ev?.streamUrl) {
      firstReady = ev
      break
    }
    if (ev?.status === 'done') {
      firstReady = ev
      break
    }
  }
  if (!firstReady || !firstReady.streamUrl) {
    yield { status: 'error', message: 'Source produced no playable URL' }
    return
  }

  // Persist to library cache. Mirror of SourcePicker.playSource's
  // /api/cache/add payload — keep the shapes identical so cached
  // entries from acquireTrack and the user-driven picker behave the
  // same on replay / cache.resolve.
  const cacheBody = {
    ...firstReady,
    type: 'addon',
    addon_id: picked.addon_id,
    ...(kind === 'audiobook' ? { category: 'audiobook' } : {}),
    title,
    artist,
    album,
    streamUrl: firstReady.streamUrl,
    albumCover: firstReady.albumCover || '',
    source: firstReady.source || picked.source || 'Addon',
    addon_payload: firstReady.payload || null,
    source_payload: {
      ...picked,
      ...(firstReady.info_hash ? { info_hash: firstReady.info_hash } : {}),
      ...(Number.isInteger(firstReady.file_idx) ? { file_idx: firstReady.file_idx } : {}),
    },
    track_payload: { title, artist, album },
  }

  let cacheKey = null
  try {
    const r = await authFetch('/api/cache/add', {
      method: 'POST',
      body: JSON.stringify(cacheBody),
    })
    const d = await r.json().catch(() => ({}))
    cacheKey = d?.key || null
  } catch (e) {
    yield { status: 'error', message: `cache save failed: ${e.message}` }
    return
  }

  yield {
    status: 'done',
    streamUrl: firstReady.streamUrl,
    cacheKey,
    source: cacheBody.source,
    addon_id: picked.addon_id,
  }
}

// Lightweight enumeration for the iframe RPC bridge. Only exposes
// fields the addon needs for policy construction — never URLs (which
// carry secrets in their path segment).
export function listAddonsForIframe() {
  return registry.list().map(a => ({
    id: a.id,
    enabled: !!a.enabled,
    capabilities: a.manifest?.capabilities || [],
    label: a.manifest?.display?.label || a.manifest?.name || a.id,
  }))
}
