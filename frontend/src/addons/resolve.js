// ── Resolve sources / resolve stream ───────────────────────────────
//
// `resolve.sources` (and its streaming variant) discover playable
// sources for a track. `resolve.stream` materializes a chosen source
// into a playable URL. `normalizeStreamEvent` translates the addon's
// snake_case SSE wire format into the camelCase shape the frontend
// player consumes.

import * as registry from './registry'
import * as client from './client'
import { rewriteAddonHost } from './_shared'
import { isCoreStreamableSource, streamFromCoreServer } from './_streaming'
import * as aggregatorSettings from './aggregatorSettings'
import * as v2 from './v2Pipeline'

// Filter an addon list to those that should participate in the given
// context. Addons without `source_contexts` in their manifest are
// treated as music-only to preserve existing behaviour. User settings
// (ctx_music / ctx_audiobook) override the manifest default.
function addonsForContext(addons, kind) {
  const isAudiobook = kind === 'audiobook'
  return addons.filter(addon => {
    const contexts = addon.manifest?.source_contexts   // e.g. ["music"] or ["audiobook"] or ["music","audiobook"]
    const s = addon.settings || {}
    if (isAudiobook) {
      if (s.ctx_audiobook === true) return true
      if (s.ctx_audiobook === false) return false
      // Default when manifest doesn't declare contexts: include the
      // addon. Older addon builds (e.g. audimo-indexers ≤0.17) didn't
      // ship `source_contexts`, and we were silently filtering them
      // out of audiobook fan-out, so audiobook clicks returned zero
      // sources even when the addon's AudiobookBay indexer had the
      // title. Defaulting to include matches the music-side behaviour
      // and is harmless: a pure-music addon just returns [] for
      // kind='audiobook'.
      if (!contexts) return true
      return contexts.includes('audiobook')
    } else {
      if (s.ctx_music === true) return true
      if (s.ctx_music === false) return false
      return !contexts || contexts.includes('music')
    }
  })
}

// Shape one addon's `sources` array (as emitted by the addon, either
// from JSON or SSE) into one or more sections the SourcePicker
// renders. Sources flagged as peer are split into a second section so
// the user can tell direct-peer sources apart from indexed sources.
// Each section is sorted by addon-reported quality signals
// (instant-first, then seeders-desc).
function shapeAddonSections(addon, rawSources, { sectionLabel, sectionIcon, merged, kind } = {}) {
  // Pass every field through verbatim — core does not interpret the
  // addon-specific keys, it just hands them back to the addon when
  // the user picks a row. Add `addon_id` and a few common defaults.
  let sources = (rawSources || []).map(src => ({
    addon_id: addon.id,
    type: src.kind || 'indexed',
    version_tags: Array.isArray(src.version_tags) ? src.version_tags : [],
    ...src,
  }))

  // v2 pipeline: derive structured fields (format/bitrate/rip_source/
  // release_type/etc.) from the addon's name+version_tags+ext, then
  // apply the user's persisted filter prefs from the AIO bundle. Sort
  // application is deferred — we still want cached-first behaviour
  // for the picker even when no sort spec is configured. When a spec
  // IS configured below, it wins over the legacy cached/seeders sort.
  v2.promoteAll(sources)
  const aggSettings = aggregatorSettings.get()
  if (aggSettings.filters_json) {
    sources = v2.applyFilters(sources, aggSettings.filters_json, kind)
  }
  const display = addon.manifest?.display || {}
  const mainLabel = sectionLabel || display.label || addon.manifest?.name || addon.id
  const mainIcon = sectionIcon || display.icon || ''

  // Merged-mode passthrough: an aggregator addon's
  // resolve.sources.stream may emit a single deliberately-mixed
  // "Best Sources" section with `merged: true`. Don't split it back
  // into indexed + peer buckets — that would undo the cross-extension
  // ranking the aggregator just did.
  if (merged) {
    return [{
      addon_id: addon.id,
      label: mainLabel,
      icon: mainIcon,
      sources,
    }]
  }

  // Peer sources (e.g. Soulseek) are bucketed separately so they can
  // render in their own picker section. Modern protocol: addon stamps
  // `is_peer: true`. Legacy fallback for older addon builds: `kind ===
  // 'slskd'`. Drop the fallback after a deprecation window.
  const isPeer = (t) => t.is_peer === true || t.kind === 'slskd'
  // "Instant playback" predicate. Addons stamp `is_cached: true`; the
  // legacy `rd_cached` field is honored as a fallback so we don't
  // lose the ⚡ badge for older addons.
  const isCached = (t) => !!t.is_cached || !!t.rd_cached
  const main = sources.filter(t => !isPeer(t))
  const peer = sources
    .filter(isPeer)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
  // Cap the indexed list at 25 after ranking — beyond that the long
  // tail is mostly low-quality dupes and the picker becomes a wall
  // of text.
  const SOURCE_DISPLAY_CAP = 25
  let mainOrdered
  if (aggSettings.sort_json) {
    // User-configured stacked sort wins. The cached/uncached split is
    // still meaningful conceptually but absorbing it into the sort
    // spec (e.g. `rd_cached_desc` as the first step) is cleaner than
    // splitting + concatenating around the user's intent.
    mainOrdered = v2.applySort(main, aggSettings.sort_json, kind).slice(0, SOURCE_DISPLAY_CAP)
  } else {
    const cached = main.filter(isCached)
    const notCached = main
      .filter(t => !isCached(t))
      .sort((a, b) => (b.seeders || 0) - (a.seeders || 0))
    mainOrdered = cached.concat(notCached).slice(0, SOURCE_DISPLAY_CAP)
  }
  const out = []
  // If the section the addon emitted is purely peer, keep that label
  // on the peer-section and skip the empty main. Previously we
  // emitted an empty main PLUS a "Direct peers" — confusing UX where
  // the user-recognisable name sat on a 0-results bucket.
  const isPurePeerSection = main.length === 0 && peer.length > 0
  if (!isPurePeerSection) {
    out.push({
      addon_id: addon.id,
      label: mainLabel,
      icon: mainIcon,
      sources: mainOrdered,
    })
  }
  if (peer.length > 0) {
    out.push({
      addon_id: addon.id,
      label: isPurePeerSection ? mainLabel : (display.peer_label || 'Direct peers'),
      icon: isPurePeerSection ? mainIcon : (display.peer_icon || ''),
      sources: peer.slice(0, 20),
    })
  }
  return out
}

// Streaming variant: fans out across addons that advertise
// `resolve.sources.stream`, consumes their SSE feeds, and calls
// `onSection(section)` each time a section arrives from any addon.
// Returns when every stream is done. Addons that lack the streaming
// capability fall back to the one-shot JSON endpoint and emit a
// single section once it returns.
export async function resolveSourcesStreaming(
  { title, artist, album, kind },
  { onSection, signal } = {},
) {
  if (!title || typeof onSection !== 'function') return
  const addons = addonsForContext(registry.withCapability('resolve.sources'), kind)
  if (addons.length === 0) return

  // Build the request payload once. `kind` is optional and only
  // plumbed when the caller passed one (e.g. 'audiobook' from the
  // audiobooks view) — addons can use it to bias their queries
  // and result scoring without changing the on-the-wire shape for
  // music callers that don't set it.
  // `limit: 50` overrides addon defaults (typically 10). The picker
  // splits the long tail into a curated "Top picks" cluster + "All
  // results" — needs the full pool to draw from.
  const reqPayload = { title, artist, album, limit: 50 }
  if (kind) reqPayload.kind = kind

  // Merge mode — when the user's bundle settings turn on
  // `merge_sources` (and there's actually more than one addon to
  // merge across), we accumulate sources from every addon into a
  // single keyed map and re-emit one "Best Sources" section to the
  // caller after each addon contribution. The user sees a single
  // ranked list that grows progressively, instead of N parallel
  // sections.
  //
  // We keep the user's per-addon error sections (sources empty,
  // `error` set) in the original passthrough — those are
  // diagnostic and lose meaning if pooled. Sections an upstream
  // already-merged (`merged: true`) also pass through unmodified
  // because they came from a meta-addon (e.g. local audimo-aio)
  // that did its own cross-extension merge already; double-merging
  // would lose information.
  const aggSettings = aggregatorSettings.get()
  const userWantsMerge = String(aggSettings.merge_sources) === 'true'
  const wrappedOnSection = (userWantsMerge && addons.length > 1)
    ? v2.makeMergeWrapper(onSection, aggSettings, kind)
    : onSection

  await Promise.allSettled(addons.map(async addon => {
    // Always try the streaming endpoint first. The manifest's
    // `resolve.sources.stream` capability is just a hint — addons
    // installed before the capability was added still respond if
    // they're running new code, and falling back on a real 404 costs
    // one extra round trip for legacy ones.
    const tryStream = async () => {
      const stream = client.resolveSourcesStream(
        addon, reqPayload, { signal, timeoutMs: 60000 },
      )
      let sawAny = false
      for await (const ev of stream) {
        if (!ev || ev.type !== 'section') continue
        sawAny = true
        const sections = shapeAddonSections(addon, ev.sources, {
          sectionLabel: ev.label,
          sectionIcon: ev.icon,
          merged: !!ev.merged,
          kind,
        })
        for (const s of sections) {
          // Scope section_id by addon — otherwise two addons emitting
          // sections with the same label collide in the SourcePicker's
          // dedupe map and one silently overwrites the other.
          s.section_id = ev.section_id || `${addon.id}:${s.label}`
          wrappedOnSection(s)
        }
      }
      return sawAny
    }
    try {
      try {
        await tryStream()
        return
      } catch (streamErr) {
        // Fall back to the JSON endpoint only on a clear "endpoint
        // missing" signal (HTTP 404 / 405). Network errors propagate.
        const status = streamErr?.status
        if (status !== 404 && status !== 405) throw streamErr
      }
      const resp = await client.resolveSources(
        addon, reqPayload, { signal, timeoutMs: 60000 },
      )
      const sections = shapeAddonSections(addon, resp?.sources || [], { kind })
      for (const s of sections) {
        s.section_id = `${addon.id}:${s.label}`
        wrappedOnSection(s)
      }
    } catch (e) {
      const display = addon.manifest?.display || {}
      // Errors flow through the original onSection regardless of
      // merge mode — pooling per-addon errors into a single bucket
      // would obscure WHICH addon broke.
      onSection({
        addon_id: addon.id,
        label: display.label || addon.manifest?.name || addon.id,
        icon: display.icon || '',
        sources: [],
        error: e?.message || String(e),
        section_id: `${addon.id}:error`,
      })
    }
  }))
}



export async function resolveSourcesGrouped({ title, artist, album, kind }, { signal } = {}) {
  if (!title) return { sections: [] }
  const addons = addonsForContext(registry.withCapability('resolve.sources'), kind)
  if (addons.length === 0) return { sections: [] }

  // resolve.sources fans out to multiple sections + an addon-side
  // library scan; allow up to 60s before we bail. The default 20s used
  // by jsonCall is enough only when every section is fast and warm.
  const settled = await Promise.allSettled(addons.map(a =>
    client.resolveSources(a, { title, artist, album }, { signal, timeoutMs: 60000 })
      .then(resp => ({ addon: a, resp }))
  ))

  const sections = []
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i]
    if (s.status !== 'fulfilled') {
      const a = addons[i]
      const msg = s.reason?.message || 'unknown error'
      console.warn(`[orchestrator] resolveSources ${a.id} failed:`, msg)
      // Surface the failure as a section so the user can see WHY there
      // are no results (vs. the addon silently being skipped). The
      // SourcePicker renders sections with empty `sources` as "No results
      // found" — this carries an explicit error label instead.
      const display = a.manifest?.display || {}
      sections.push({
        addon_id: a.id,
        label: display.label || a.manifest?.name || a.id,
        icon: display.icon || '',
        sources: [],
        error: msg,
      })
      continue
    }
    const { addon, resp } = s.value
    const raw = (resp && resp.sources) || []
    console.log(`[orchestrator] resolveSources ${addon.id}: ${raw.length} source(s)`)
    sections.push(...shapeAddonSections(addon, raw, { kind }))
  }
  return { sections }
}

// Translate the addon SSE vocabulary into the shape the frontend
// expects. The addon protocol uses snake_case + a `type` discriminator
// (progress | ready | cache_hint | error | unsupported | done); the
// frontend was written against `{ status, streamUrl, mimeType, source }`.
// Keeping the translation here means SourcePicker, AudiobooksView, and
// cacheResolveEntry don't have to know about either wire format.
//
// `addon` is required so we can rewrite relative stream_urls — many
// addons return paths like "/stream/<id>" and expect the caller to
// prepend the addon's origin. The orchestrator owns that rewrite in
// the device-as-client architecture.
export function normalizeStreamEvent(ev, addon) {
  if (!ev || typeof ev !== 'object') return ev
  const t = ev.type
  const absolutize = (url) => {
    if (!url) return ''
    if (!url.startsWith('/')) return url
    if (!addon || !addon.url) return url
    return rewriteAddonHost(addon.url.replace(/\/+$/, '')) + url
  }
  if (t === 'ready' || t === 'cache_hint') {
    return {
      ...ev,
      status: 'done',
      streamUrl: absolutize(ev.stream_url || ev.streamUrl || ''),
      mimeType: ev.mime_type || ev.mimeType || '',
      source: ev.source_label || ev.source || '',
      // Carry through the rest verbatim so cacheResolveEntry /
      // SourcePicker can persist them. Core does not interpret any
      // addon-specific fields beyond the small set above.
      pct: typeof ev.pct === 'number' ? ev.pct : 100,
    }
  }
  if (t === 'progress') {
    return { ...ev, status: 'downloading', pct: ev.pct, message: ev.message }
  }
  if (t === 'error' || t === 'unsupported') {
    return {
      ...ev,
      status: 'error',
      message: ev.message || ev.reason || 'addon error',
    }
  }
  if (t === 'done') return { ...ev, status: 'done' }
  // Already-normalized events (or unknown types) pass through unchanged.
  // Rewrite a relative streamUrl on already-normalized events too.
  if (ev.streamUrl && ev.streamUrl.startsWith && ev.streamUrl.startsWith('/')) {
    return { ...ev, streamUrl: absolutize(ev.streamUrl) }
  }
  return ev
}

// ── Resolve stream (capability "resolve.stream", SSE) ───────────────
//
// Async generator. Caller iterates events; each event is a parsed
// object matching the addon's resolve.stream contract:
//   { status: "downloading"|"done"|"error", pct?, message?,
//     streamUrl?, mimeType?, ... }
//
// Picks the first enabled resolve.stream addon that matches the
// caller-provided addon_id (when given), otherwise the first capable
// one. The source object is passed through untouched — the addon owns
// the schema.
export async function* resolveStream({ addonId, source, track, ...rest }, { signal, timeoutMs } = {}) {
  const enabled = registry.withCapability('resolve.stream')
  if (enabled.length === 0) {
    yield { status: 'error', message: 'No addon installed providing resolve.stream' }
    return
  }
  // Torrent sources are streamed by the bundled core libtorrent
  // server (Stremio-style :11471), bypassing addons entirely. The
  // addon's job ends at "here's an infohash"; core does the peering.
  // `track` (title/artist) is passed through so the streaming server's
  // file picker can match by title-phrase rather than picking the
  // largest playable file (wrong song on multi-track releases).
  if (isCoreStreamableSource(source)) {
    yield* streamFromCoreServer(source, { signal, track })
    return
  }
  const addon = addonId ? enabled.find(a => a.id === addonId) || enabled[0] : enabled[0]
  if (!addon) {
    yield { status: 'error', message: 'No matching addon for resolve.stream' }
    return
  }
  try {
    // `track` was destructured out for the core-stream branch above; we
    // need to include it again here so addon resolve.stream receives the
    // title/artist/album. Without it, addons that organize files by
    // metadata (e.g. audimo-soulseek's move-to-Music step) fall back to
    // _Unsorted because the payload only carries `source`.
    for await (const ev of client.streamCall(addon, '/resolve/stream', { source, track, ...rest }, { signal, timeoutMs })) {
      yield normalizeStreamEvent(ev, addon)
    }
  } catch (e) {
    yield { status: 'error', message: e.message || 'addon stream failed' }
  }
}
