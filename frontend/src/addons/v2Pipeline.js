// ──────────────────────────────────────────────────────────────────
// v2 source pipeline — schema promoter / filter / stacked sort
// ──────────────────────────────────────────────────────────────────
//
// Direct port of audimo-aio's `server.py` v2 pipeline. The algorithms
// are intentionally identical at both ends so a source ranked X
// places when audimo-aio is in the path comes out the same X places
// when audimo-aio isn't and the orchestrator does the work locally.
//
//   promoteSourceFields(s)
//     Derive `format`, `bitrate_kbps`, `bitrate_tier`, `rip_source`,
//     `release_type`, `year`, `hi_res` from `name` + `version_tags`
//     + `ext`. Mutates in place; idempotent; never overwrites a
//     pre-set field.
//
//   filterPasses(source, spec)
//     Return false iff a concrete (non-undefined) field violates
//     `spec`. Sources with an undetected field always pass that
//     field — filters never reject for missing data.
//
//   buildSortKeyFn(spec)
//     Compile a sort-spec list (named steps + {preferred, ranked}
//     blocks) into a key function for Array.sort. Returns null if
//     the spec is empty / unparseable so the caller can fall through
//     to the legacy sort.
//
// Wire this into the orchestrator (shapeAddonSections in resolve.js)
// so persisted aggregator settings (aggregatorSettings.get()) shape
// the rendered SourcePicker output.

const LOSSLESS = new Set(['flac', 'alac', 'wav', 'ape', 'dsd'])

const FORMAT_FROM_EXT = {
  flac: 'flac', alac: 'alac', m4a: 'alac',
  mp3: 'mp3', aac: 'aac', ogg: 'ogg', opus: 'opus',
  wav: 'wav', ape: 'ape', dsd: 'dsd', dsf: 'dsd',
  m4b: 'm4b',
}
const FORMAT_FROM_TAG = {
  flac: 'flac', alac: 'alac', ape: 'ape', wav: 'wav',
  lossless: 'flac',
  mp3: 'mp3', aac: 'aac', m4a: 'alac',
  ogg: 'ogg', opus: 'opus', dsd: 'dsd',
}
const BITRATE_TIER_NUMERIC = {
  320: '320', 256: '256', 192: '192', 224: '192',
  160: 'low', 128: 'low',
}

const RIP_SOURCE_PATTERNS = [
  ['vinyl',    /\b(vinyl|lp|12"|7"|wax)\b/i],
  ['cd',       /\b(cd|cdda|cdrip|eac)\b/i],
  ['web',      /\b(web|webrip|webdl|web-dl|itunes|qobuz|tidal|spotify|deezer)\b/i],
  ['cassette', /\b(cassette|tape)\b/i],
  ['sacd',     /\bsacd\b/i],
  ['live',     /\b(live|aud|audience|sbd|soundboard|matrix)\b/i],
]
const RELEASE_TYPE_PATTERNS = [
  ['bootleg',     /\bbootleg\b/i],
  ['remix',       /\b(remix(es)?|rmx|mashup)\b/i],
  ['live',        /\b(live\s+(at|in|from|@)|\(live\)|\[live\])\b/i],
  ['demo',        /\b(demo|early\s+demo|rough\s+demo)\b/i],
  ['remaster',    /\b(remaster(ed)?|hd\s*remaster)\b/i],
  ['compilation', /\b(comp(ilation)?|greatest\s+hits|best\s+of|anthology)\b/i],
  ['ep',          /\bep\b/i],
  ['single',      /\b(single|maxi[ -]?single)\b/i],
  ['soundtrack',  /\b(ost|soundtrack)\b/i],
]
const HI_RES_RE = /\b(24[ -/]?(?:bit)?[ -/]?(?:96|88|176|192)|hi[ -]?res|24[ -]?96|24[ -]?192)\b/i
const BITRATE_NAME_RE = /\b(128|160|192|224|256|320)\s*k(?:bps)?\b/i
const BITRATE_VBR_RE = /\bV0\b|\bvbr\s*0?\b/i
const YEAR_NAME_RE = /(?:[([\s])((?:19|20)\d{2})(?:[)\]\s])/

/**
 * Mutate `s` to add structured fields derived from existing
 * extension-stamped metadata. Idempotent and additive — never
 * overwrites a field the extension already set.
 */
export function promoteSourceFields(s) {
  if (!s || typeof s !== 'object') return
  const name = String(s.name || '').trim()
  const ext = String(s.ext || '').toLowerCase().replace(/^\.+/, '')
  const tags = (Array.isArray(s.version_tags) ? s.version_tags : [])
    .map(t => String(t).toLowerCase())
  const nameLower = name.toLowerCase()

  // format: prefer ext (most reliable), fall back to tag scan
  if (!s.format) {
    let fmt = FORMAT_FROM_EXT[ext]
    if (!fmt) {
      for (const tag of tags) {
        const key = tag.includes(' ') ? tag.split(' ')[0] : tag
        fmt = FORMAT_FROM_TAG[key]
        if (fmt) break
      }
    }
    if (fmt) s.format = fmt
  }

  // bitrate_kbps
  if (s.bitrate_kbps == null) {
    let br = null
    for (const tag of tags) {
      const m = BITRATE_NAME_RE.exec(tag)
      if (m) { br = parseInt(m[1], 10); break }
    }
    if (br == null) {
      const m = BITRATE_NAME_RE.exec(name)
      if (m) br = parseInt(m[1], 10)
    }
    if (br != null) s.bitrate_kbps = br
  }

  // bitrate_tier
  if (!s.bitrate_tier) {
    const fmt = s.format
    if (fmt && LOSSLESS.has(fmt)) {
      s.bitrate_tier = 'lossless'
    } else if (tags.some(t => BITRATE_VBR_RE.test(t)) || BITRATE_VBR_RE.test(name)) {
      s.bitrate_tier = 'v0'
    } else if (typeof s.bitrate_kbps === 'number') {
      s.bitrate_tier = BITRATE_TIER_NUMERIC[s.bitrate_kbps]
        || (s.bitrate_kbps < 192 ? 'low' : '192')
    }
  }

  // hi-res hint (24-bit / 96+ kHz)
  if (s.hi_res == null) {
    s.hi_res = HI_RES_RE.test(name) || tags.some(t => HI_RES_RE.test(t))
  }

  // rip_source
  if (!s.rip_source) {
    for (const [label, re] of RIP_SOURCE_PATTERNS) {
      if (re.test(nameLower) || tags.some(t => re.test(t))) {
        s.rip_source = label
        break
      }
    }
  }

  // release_type
  if (!s.release_type) {
    for (const [label, re] of RELEASE_TYPE_PATTERNS) {
      if (re.test(nameLower) || tags.some(t => re.test(t))) {
        s.release_type = label
        break
      }
    }
  }

  // year
  if (s.year == null) {
    const m = YEAR_NAME_RE.exec(` ${name} `)
    if (m) s.year = parseInt(m[1], 10)
  }
}

export function promoteAll(sources) {
  for (const s of sources || []) {
    try { promoteSourceFields(s) } catch { /* fail-soft */ }
  }
  return sources
}

// ──────────────────────────────────────────────────────────────────
// Filter pipeline
// ──────────────────────────────────────────────────────────────────

function inOut(value, spec) {
  // Apply include/exclude rules; missing value passes any rule (we
  // never reject for "couldn't detect").
  if (!value) return true
  if (!spec || typeof spec !== 'object') return true
  const inc = (spec.include || []).map(x => String(x).toLowerCase())
  const exc = (spec.exclude || []).map(x => String(x).toLowerCase())
  if (inc.length && !inc.includes(value)) return false
  if (exc.includes(value)) return false
  return true
}

/**
 * Return false iff a concrete (non-null) field on `source` violates
 * the spec. Mirrors audimo-aio's _filter_passes exactly.
 */
export function filterPasses(source, spec) {
  if (!spec || typeof spec !== 'object') return true
  if (!inOut(source.format, spec.format)) return false

  const br = source.bitrate_kbps
  if (typeof br === 'number'
      && typeof spec.bitrate_min === 'number'
      && br < spec.bitrate_min) {
    return false
  }

  if (!inOut(source.rip_source, spec.rip_source)) return false
  if (!inOut(source.release_type, spec.release_type)) return false

  const size = source.size
  if (typeof size === 'number') {
    if (typeof spec.size_max_mb === 'number' && size > spec.size_max_mb * 1_000_000) return false
    if (typeof spec.size_min_mb === 'number' && size < spec.size_min_mb * 1_000_000) return false
  }

  const seeders = source.seeders
  if (typeof seeders === 'number'
      && typeof spec.seeders_min === 'number'
      && seeders < spec.seeders_min) {
    return false
  }

  if (spec.cached_only && !(source.is_cached || source.rd_cached)) return false

  if (Array.isArray(spec.regex_exclude)) {
    for (const pat of spec.regex_exclude) {
      try {
        if (new RegExp(pat, 'i').test(source.name || '')) return false
      } catch {
        // Invalid regex from the user → ignore that rule rather than
        // silently nuke every source.
      }
    }
  }

  return true
}

/**
 * Apply a filter spec from aggregator-settings.filters_json.
 * `kind` selects between the "tracks" and "audiobooks" sub-spec.
 */
export function applyFilters(sources, filtersJson, kind) {
  if (!filtersJson) return sources
  let parsed
  try {
    parsed = typeof filtersJson === 'string' ? JSON.parse(filtersJson) : filtersJson
  } catch {
    return sources
  }
  if (!parsed || typeof parsed !== 'object') return sources
  const spec = parsed[kind === 'audiobook' ? 'audiobooks' : 'tracks']
  if (!spec || typeof spec !== 'object') return sources
  return sources.filter(s => filterPasses(s, spec))
}

// ──────────────────────────────────────────────────────────────────
// Stacked sort
// ──────────────────────────────────────────────────────────────────

const SEED_BUCKETS = [
  [50, 4], [20, 3], [5, 2], [1, 1],
]
function seedBucket(seeders) {
  const n = Number(seeders) || 0
  for (const [thr, b] of SEED_BUCKETS) if (n >= thr) return b
  return 0
}
function qualityBucket(s) {
  // Mirrors audimo-aio's _quality_bucket: 0 unknown, 1 high lossy, 2 lossless.
  const fmt = s.format
  if (fmt && LOSSLESS.has(fmt)) return 2
  if (s.bitrate_tier === '320' || s.bitrate_tier === 'v0' || s.bitrate_tier === '256') return 1
  return 0
}

const SORT_STEPS = {
  rd_cached_desc:    s => -((s.rd_cached || s.is_cached) ? 1 : 0),
  relevance_desc:    s => -(Number(s._relevance) || 0),
  seeders_desc:      s => -(Number(s.seeders || s.free_slots) || 0),
  seed_bucket_desc:  s => -seedBucket(s.seeders || s.free_slots),
  quality_desc:      s => -qualityBucket(s),
  size_desc:         s => -(Number(s.size) || 0),
  size_asc:          s =>  (Number(s.size) || 0),
  bitrate_desc:      s => -(Number(s.bitrate_kbps) || 0),
  year_desc:         s => -(Number(s.year) || 0),
  year_asc:          s =>  (Number(s.year) || 9999),
  hi_res_desc:       s => -(s.hi_res ? 1 : 0),
  abridged_asc:      s =>  (s.abridged ? 1 : 0),
  has_chapters_desc: s => -(s.has_chapters ? 1 : 0),
}

/**
 * Compile a sort spec list into a key function. Each step
 * contributes one tuple element evaluated left-to-right.
 *
 * Step types:
 *   - string: a name from SORT_STEPS
 *   - { preferred: <field>, ranked: [<value>, ...] }:
 *       compute a ranked-list index for a per-source value (lower
 *       index = higher priority). Unknown values sort last.
 */
export function buildSortKeyFn(spec) {
  if (!Array.isArray(spec) || spec.length === 0) return null
  const fns = []
  for (const step of spec) {
    if (typeof step === 'string') {
      const fn = SORT_STEPS[step]
      if (fn) fns.push(fn)
    } else if (step && typeof step === 'object' && step.preferred) {
      const field = String(step.preferred)
      const ranked = (step.ranked || []).map(x => String(x).toLowerCase())
      const big = ranked.length + 1
      const map = new Map(ranked.map((v, i) => [v, i]))
      fns.push((s) => {
        const v = s[field]
        if (v == null) return big
        const idx = map.get(String(v).toLowerCase())
        return idx == null ? big : idx
      })
    }
  }
  if (fns.length === 0) return null
  return (s) => fns.map(f => f(s))
}

// ──────────────────────────────────────────────────────────────────
// Dedup cascade
// ──────────────────────────────────────────────────────────────────
//
// Identity used to collapse duplicate listings when the same
// content surfaces from multiple addons (or multiple phases of one
// addon's stream). Mirrors audimo-aio's `_dedup_key` cascade so a
// source seen here gets the same identity it would get if
// audimo-aio were merging server-side:
//
//   1. info_hash       — torrent identity (always exact)
//   2. acoustid        — Chromaprint fingerprint, codec/source-
//                        agnostic; collapses the same recording
//                        across vinyl/CD/WEB rips
//   3. mb_recording_id — MusicBrainz recording identity
//   4. name+duration   — coarse fallback when nothing else is
//                        stamped; duration bucketed to 2s to absorb
//                        rip-length drift
//   5. id              — whatever the producing addon stamped
//
// Most extension addons today populate (1) only — the fingerprint-
// based fallbacks (2)/(3) wait on per-addon adoption. The cascade
// is wired now so the wire format doesn't change later.

export function dedupKey(s) {
  if (!s || typeof s !== 'object') return ''
  const h = String(s.info_hash || '').toUpperCase()
  if (h) return `hash:${h}`
  const aid = String(s.acoustid || '').trim().toLowerCase()
  if (aid) return `aid:${aid}`
  const mbid = String(s.mb_recording_id || '').trim().toLowerCase()
  if (mbid) return `mbid:${mbid}`
  const dur = s.duration
  const name = String(s.name || '').trim().toLowerCase()
  if (name && typeof dur === 'number' && dur > 0) {
    return `nd:${name}:${Math.floor(dur / 2) * 2}`
  }
  const sid = s.id || s.name || ''
  return `id:${sid}`
}

// Default merge-mode sort. Mirrors audimo-aio's `_merge_rank_key`:
// rd_cached → seed bucket → seeders → quality → size. Used when no
// user sort_json is configured but the user has merge_sources on.
const DEFAULT_MERGE_SORT = [
  'rd_cached_desc',
  'seed_bucket_desc',
  'seeders_desc',
  'quality_desc',
  'size_desc',
]
export function defaultMergeSortKeyFn() {
  return buildSortKeyFn(DEFAULT_MERGE_SORT)
}

/**
 * Apply a stacked sort from aggregator-settings.sort_json. Returns
 * a new array; the input is not mutated. Pass `kind` for per-kind
 * sub-specs ("tracks" / "audiobooks").
 */
export function applySort(sources, sortJson, kind) {
  if (!sortJson) return sources
  let parsed
  try {
    parsed = typeof sortJson === 'string' ? JSON.parse(sortJson) : sortJson
  } catch {
    return sources
  }
  if (!parsed || typeof parsed !== 'object') return sources
  const spec = parsed[kind === 'audiobook' ? 'audiobooks' : 'tracks']
  const keyFn = buildSortKeyFn(spec)
  if (!keyFn) return sources
  return [...sources].sort((a, b) => tupleCompare(keyFn(a), keyFn(b)))
}

function tupleCompare(ka, kb) {
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] < kb[i]) return -1
    if (ka[i] > kb[i]) return 1
  }
  return 0
}

// ──────────────────────────────────────────────────────────────────
// Cross-addon merge wrapper
// ──────────────────────────────────────────────────────────────────
//
// The orchestrator's `resolveSourcesStreaming` fans out to every
// enabled addon and forwards each addon's section to the caller's
// `onSection`. When the user has `merge_sources: true` on (set by
// the AIO bundle install), this wrapper intercepts those forwards:
// it pools sources from every addon into a shared accumulator
// keyed by `dedupKey` and re-emits a single "Best Sources" section
// to the caller after each contribution. Mirrors audimo-aio's
// merge_mode block in `resolve_sources_stream`.
//
// Sections that pass through unmodified:
//   * error sections — pooling per-addon errors loses which addon
//     broke; they stay diagnostic.
//   * sections an upstream already merged (`merged: true`) — those
//     came from a meta-addon that did its own cross-extension
//     merge; double-merging would lose information.

/**
 * Build a merge-mode wrapper around a caller-supplied `onSection`.
 * Caller decides when to use it (e.g. only when there's more than
 * one addon to merge across) by choosing whether to forward
 * sections to the wrapper or directly to onSection.
 *
 * @param {(section: object) => void} onSection
 * @param {{sort_json?: string}} aggSettings
 * @param {string} [kind] — 'audiobook' for the audiobook view, else tracks
 * @param {{cap?: number}} [opts] — `cap` truncates the emitted list (default 50)
 */
export function makeMergeWrapper(onSection, aggSettings, kind, opts = {}) {
  const cap = typeof opts.cap === 'number' ? opts.cap : 50
  const merged = new Map()
  const userSortSpec = (() => {
    if (!aggSettings || !aggSettings.sort_json) return null
    try {
      const parsed = JSON.parse(aggSettings.sort_json)
      if (!parsed || typeof parsed !== 'object') return null
      const list = parsed[kind === 'audiobook' ? 'audiobooks' : 'tracks']
      return Array.isArray(list) ? list : null
    } catch { return null }
  })()
  const userSortKeyFn = userSortSpec ? buildSortKeyFn(userSortSpec) : null
  // Collision resolution uses the default merge rank regardless of
  // whether the user configured a sort — mirrors audimo-aio's
  // _merge_into, which always uses _merge_rank_key. The user's sort
  // is preference for FINAL display order; for "which dup wins" we
  // want a deterministic, cache-aware default that doesn't accidentally
  // throw away the rd_cached copy because the user's sort doesn't
  // include rd_cached_desc.
  const collisionKeyFn = defaultMergeSortKeyFn()
  // Final-order sort: user spec if set, else the same default.
  const finalKeyFn = userSortKeyFn || collisionKeyFn

  return function mergedOnSection(section) {
    if (!section || section.error || section.merged === true || !Array.isArray(section.sources)) {
      onSection(section)
      return
    }
    for (const s of section.sources) {
      if (!s) continue
      const k = dedupKey(s)
      if (!k) continue
      const prior = merged.get(k)
      if (!prior) {
        merged.set(k, s)
        continue
      }
      // Keep the better-ranked source on collision.
      if (tupleCompare(collisionKeyFn(s), collisionKeyFn(prior)) < 0) {
        merged.set(k, s)
      }
    }
    const ordered = Array.from(merged.values())
      .map(s => [finalKeyFn(s), s])
      .sort((a, b) => tupleCompare(a[0], b[0]))
      .map(e => e[1])
      .slice(0, cap)
    onSection({
      addon_id: 'merged',
      section_id: 'merged',
      label: 'Best Sources',
      icon: '🔀',
      sources: ordered,
      merged: true,
    })
  }
}
