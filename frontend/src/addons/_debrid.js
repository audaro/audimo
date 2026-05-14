// ── Push to debrid (post-stream, fire-and-forget) ──────────────────
//
// After a torrent source has streamed via the bundled core libtorrent
// server, ask the addon that produced the source to also stage the
// torrent on the user's configured debrid backend. Subsequent plays
// can then skip libtorrent entirely (debrid CDN is faster and frees
// up local disk if the user opted into "Delete local copy after
// debrid caches it").
//
// Fire-and-forget: the addon returns 202-equivalent immediately and
// runs the actual debrid push in its background. We don't wait.

import * as registry from './registry'
import * as client from './client'
import { authFetch } from '../api'
import { _normalizeInfoHash } from './_shared'

export async function pushToDebrid({ source, cacheKey, track }) {
  if (!source) return
  const ih = _normalizeInfoHash(source.info_hash || source.infoHash)
  if (!ih) return
  const magnet = source.magnet || source.link || ''
  if (!magnet || !magnet.startsWith('magnet:')) return
  const addonId = source.addon_id
  if (!addonId) return
  const addon = registry.list().find(a => a.id === addonId)
  if (!addon) return
  // Backend's callback URL — same origin as the page when running in
  // the desktop webview (page is served by backend on :8000). For
  // remote clients (phone over Tailscale) we point at the page host.
  const isDesktop = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__
  const callbackBase = isDesktop
    ? 'http://127.0.0.1:8000'
    : (window.location.origin || '')
  const onComplete = `${callbackBase}/api/library/_addon_callback/${encodeURIComponent(addonId)}/promote_stream_url`
  // Read the "delete local copy after debrid caches it" toggle from
  // the addon's settings (kept in localStorage at install time, in
  // sync with the URL config segment). Pass it explicitly so the
  // addon doesn't have to round-trip-trust its own cfg parser — and
  // so users who toggled the setting via the configure UI without a
  // full re-install still see it work.
  const deleteLocal = addon.settings?.delete_local_after_debrid_cache === true
  try {
    await client.jsonCall(addon, '/push_to_debrid', {
      info_hash: ih,
      magnet,
      title: track?.title || '',
      artist: track?.artist || '',
      cache_key: cacheKey || '',
      on_complete_url: onComplete,
      delete_local: deleteLocal,
    })
  } catch (e) {
    console.warn(`[orchestrator] pushToDebrid ${addonId} failed:`, e.message)
  }
}

// ── Sweep: reclaim disk for tracks now cached on debrid ────────────
//
// User toggles "Delete local copy after debrid caches it" expecting
// disk to free up automatically. The post-play push_to_debrid flow
// catches most cases, but several leak through: app closed mid-poll,
// torrents that took >30 min for RD to finish, library entries from
// before the toggle was wired up. This sweep covers all of those by
// asking the source's addon "is this on debrid right now?" for every
// local-file row in the library and firing the same delete callback
// the auto path uses on a hit.
//
// Safe to call any time — idempotent. No-op for rows whose addon
// isn't installed or whose debrid backend doesn't have the torrent.

export async function sweepCachedToDebrid({ origin } = {}) {
  let candidates
  try {
    const isDesktop = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__
    const base = origin || (isDesktop ? 'http://127.0.0.1:8000' : (window.location.origin || ''))
    const r = await fetch(`${base}/api/library/cleanup_candidates`)
    if (!r.ok) return { deleted: 0, kept: 0, skipped: 0, error: `HTTP ${r.status}` }
    const d = await r.json()
    candidates = d.candidates || []
  } catch (e) {
    return { deleted: 0, kept: 0, skipped: 0, error: e.message }
  }
  let deleted = 0, kept = 0, skipped = 0
  // Bytes recovered. Surfaced in Settings → Reclaim disk so the
  // user sees "freed 1.4 GB" instead of just a file count.
  let bytesFreed = 0
  for (const c of candidates) {
    const addon = registry.list().find(a => a.id === c.addon_id)
    if (!addon) { skipped++; continue }
    const wantsDelete = addon.settings?.delete_local_after_debrid_cache === true
    if (!wantsDelete) { skipped++; continue }
    let res
    try {
      res = await client.jsonCall(addon, '/debrid_cache_check', {
        info_hash: c.info_hash,
        title: c.title,
        artist: c.artist,
      }, { timeoutMs: 15_000 })
    } catch (e) {
      console.warn(`[sweep] debrid_cache_check ${c.info_hash.slice(0,12)} failed:`, e.message)
      skipped++
      continue
    }
    if (!res?.cached || !res.url) { kept++; continue }
    try {
      const isDesktop = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__
      const base = origin || (isDesktop ? 'http://127.0.0.1:8000' : (window.location.origin || ''))
      const cb = await authFetch(`${base}/api/library/_addon_callback/${encodeURIComponent(c.addon_id)}/promote_stream_url`, {
        method: 'POST',
        body: JSON.stringify({
          cache_key: c.key,
          info_hash: c.info_hash,
          stream_url: res.url,
          source_label: res.label,
          mime_type: res.mime_type,
          delete_local: true,
        }),
      })
      const cbd = await cb.json()
      if (cbd?.deleted_local) {
        deleted++
        if (typeof c.local_file_size === 'number' && c.local_file_size > 0) {
          bytesFreed += c.local_file_size
        }
      } else {
        kept++
      }
    } catch (e) {
      console.warn(`[sweep] callback failed for ${c.key}:`, e.message)
      skipped++
    }
  }
  return { deleted, kept, skipped, total: candidates.length, bytesFreed }
}
