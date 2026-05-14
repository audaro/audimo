// ──────────────────────────────────────────────────────────────────
// Addon orchestrator — barrel file.
//
// The orchestrator fans out a request across every enabled addon
// that advertises a capability, merges the results, and shapes them
// into the payload the frontend renders. Each public function here
// drives a single device-side flow:
//
//   • searchTracks / searchAudiobooks / searchBooks      — search.js
//   • resolveSourcesGrouped / resolveSourcesStreaming    — resolve.js
//   • resolveStream / normalizeStreamEvent               — resolve.js
//   • resolveMagnet                                      — cache.js
//   • cacheResolveEntry / cacheResolveEntryForce         — cache.js
//   • pushToDebrid / sweepCachedToDebrid                 — _debrid.js
//   • isCoreStreamableSource (libtorrent gating)         — _streaming.js
//
// Failures from individual addons are isolated: one broken addon
// shouldn't kill the whole flow. Errors are logged and dropped.
// ──────────────────────────────────────────────────────────────────

export { isCoreStreamableSource } from './_streaming'
export { pushToDebrid, sweepCachedToDebrid } from './_debrid'
export { searchTracks, searchAudiobooks, searchBooks } from './search'
export {
  resolveSourcesStreaming,
  resolveSourcesGrouped,
  resolveStream,
  normalizeStreamEvent,
} from './resolve'
export {
  resolveMagnet,
  cacheResolveEntry,
  cacheResolveEntryForce,
} from './cache'
export { acquireTrack, listAddonsForIframe } from './acquire'
