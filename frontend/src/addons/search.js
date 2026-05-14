// ── Track / audiobook / book search ────────────────────────────────
//
// Each function fans out a query across every enabled addon that
// advertises the relevant capability and merges the results.

import * as registry from './registry'
import * as client from './client'

// ── Track search (capability "search.tracks", legacy "search") ──────

export async function searchTracks(query, { signal } = {}) {
  const q = (query || '').trim()
  if (!q) return { results: [] }
  // Accept both new ("search.tracks") and legacy ("search") capability
  // names so addons that haven't updated their manifest still work.
  const addons = uniqueByAddon([
    ...registry.withCapability('search.tracks'),
    ...registry.withCapability('search'),
  ])
  const settled = await Promise.allSettled(
    addons.map(a => searchOne(a, q, signal))
  )
  const results = []
  for (const s of settled) {
    if (s.status === 'fulfilled') results.push(...s.value)
  }
  return { results }
}

async function searchOne(addon, q, signal) {
  // Try the new shape first; fall back to legacy on 404/HTTP error.
  const caps = addon.manifest?.capabilities || []
  try {
    if (caps.includes('search.tracks')) {
      const data = await client.searchTracks(addon, { q, limit: 25 }, { signal })
      return tagAddon(addon, data?.results || [])
    }
    // Legacy "search" addons used `{query}` body and `tracks` field.
    const data = await client.searchTracks(addon, { query: q }, { signal })
    return tagAddon(addon, data?.tracks || data?.results || [])
  } catch (e) {
    console.warn(`[orchestrator] searchTracks ${addon.id} failed:`, e.message)
    return []
  }
}

function tagAddon(addon, items) {
  return items.map(item => ({
    ...item,
    _addon_id: addon.id,
    _addon_name: addon.manifest?.name || addon.id,
    addon_id: item.addon_id || addon.id,  // some callers expect this name
  }))
}

// ── Audiobook search (capability "search.audiobooks") ───────────────

export async function searchAudiobooks(query, page = 1, { signal } = {}) {
  const q = (query || '').trim()
  if (!q) return { results: [] }
  const addons = registry.withCapability('search.audiobooks')
  const settled = await Promise.allSettled(
    addons.map(a => client.searchAudiobooks(a, { q, page }, { signal })
      .then(resp => ({ addon: a, resp })))
  )
  const results = []
  for (const s of settled) {
    if (s.status !== 'fulfilled') continue
    const { addon, resp } = s.value
    for (const item of (resp?.results || [])) {
      results.push({ ...item, _addon_id: addon.id, _addon_name: addon.manifest?.name || addon.id })
    }
  }
  return { results }
}

// ── Book search (capability "search.books") ─────────────────────────
//
// Discovery only. Fans out across every addon advertising
// `search.books` and merges the results — each addon decides which
// upstream catalog to query. Returns generic book metadata; the
// frontend renders it and routes a click through the normal
// SourcePicker flow to find audio.
export async function searchBooks(query, { signal, limit = 30 } = {}) {
  const q = (query || '').trim()
  if (!q) return { books: [] }
  // Try every installed addon, not just those whose cached manifest
  // advertises `search.books` — manifests are snapshotted at install
  // time, so an addon that gained the capability after install would
  // be invisible. Addons without the endpoint return 404; that's
  // cheap and the catch handles it.
  const candidates = registry.withCapability('search.books')
  const addons = candidates.length > 0 ? candidates : registry.list()
  const settled = await Promise.allSettled(
    addons.map(a => client.searchBooks(a, { q, limit }, { signal })),
  )
  const seen = new Set()
  const books = []
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i]
    if (s.status !== 'fulfilled' || !s.value) continue
    for (const b of (s.value.books || [])) {
      const key = `${(b.title || '').toLowerCase()}|${(b.author || '').toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      books.push({ ...b, _addon_id: addons[i].id })
    }
  }
  return { books }
}

// ── helpers ─────────────────────────────────────────────────────────

function uniqueByAddon(list) {
  const seen = new Set()
  const out = []
  for (const a of list) {
    if (seen.has(a.id)) continue
    seen.add(a.id)
    out.push(a)
  }
  return out
}
