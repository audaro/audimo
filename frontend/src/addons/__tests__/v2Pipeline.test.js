// Tests for the v2 source pipeline.
//
// This is a JS port of audimo-aio's server.py pipeline; the test
// cases mirror the Python smoke set so a divergence in either
// runtime surfaces here before it ships.
//
// Run with: cd frontend && npm test

import { describe, expect, it } from 'vitest'

import {
  applyFilters,
  applySort,
  buildSortKeyFn,
  defaultMergeSortKeyFn,
  dedupKey,
  filterPasses,
  makeMergeWrapper,
  promoteAll,
  promoteSourceFields,
} from '../v2Pipeline.js'

describe('promoteSourceFields', () => {
  it('parses a torrent-style FLAC vinyl rip name', () => {
    const s = {
      name: 'Pink Floyd - The Wall (1979) [FLAC] [Vinyl Rip] [24-96]',
      ext: 'flac',
      version_tags: ['FLAC', 'Vinyl'],
      size: 800_000_000,
    }
    promoteSourceFields(s)
    expect(s.format).toBe('flac')
    expect(s.bitrate_tier).toBe('lossless')
    expect(s.rip_source).toBe('vinyl')
    expect(s.year).toBe(1979)
    expect(s.hi_res).toBe(true)
  })

  it('parses 320 mp3 remaster', () => {
    const s = {
      name: 'Beatles - Abbey Road (Remaster) [320kbps]',
      version_tags: ['320k', 'Remaster'],
      ext: 'mp3',
    }
    promoteSourceFields(s)
    expect(s.format).toBe('mp3')
    expect(s.bitrate_kbps).toBe(320)
    expect(s.bitrate_tier).toBe('320')
    expect(s.release_type).toBe('remaster')
  })

  it('is idempotent — re-running does nothing', () => {
    const s = {
      name: 'X - Y [FLAC]',
      ext: 'flac',
      version_tags: ['FLAC'],
    }
    promoteSourceFields(s)
    const snap = JSON.stringify(s)
    promoteSourceFields(s)
    promoteSourceFields(s)
    expect(JSON.stringify(s)).toBe(snap)
  })

  it('respects pre-set fields (extension may have populated them)', () => {
    const s = {
      name: 'something flac vinyl',
      ext: 'mp3',
      version_tags: [],
      format: 'opus', bitrate_tier: 'lossless', rip_source: 'cd',
    }
    promoteSourceFields(s)
    expect(s.format).toBe('opus')        // not overwritten
    expect(s.bitrate_tier).toBe('lossless')
    expect(s.rip_source).toBe('cd')
  })

  it('detects hi-res from the 24/96 form', () => {
    const s = { name: 'Album [24-96]', ext: 'flac', version_tags: [] }
    promoteSourceFields(s)
    expect(s.hi_res).toBe(true)
  })

  it('returns no-op on null/undefined input', () => {
    expect(() => promoteSourceFields(null)).not.toThrow()
    expect(() => promoteSourceFields(undefined)).not.toThrow()
  })

  it('promoteAll handles a list', () => {
    const list = [
      { name: 'a [FLAC]', ext: 'flac', version_tags: [] },
      { name: 'b [320k]', ext: 'mp3', version_tags: [] },
    ]
    promoteAll(list)
    expect(list[0].format).toBe('flac')
    expect(list[1].bitrate_kbps).toBe(320)
  })
})

describe('filterPasses', () => {
  it('keeps everything when no spec is given', () => {
    expect(filterPasses({ format: 'mp3' }, null)).toBe(true)
    expect(filterPasses({ format: 'mp3' }, {})).toBe(true)
  })

  it('respects format include / exclude', () => {
    const s = { format: 'mp3' }
    expect(filterPasses(s, { format: { include: ['flac', 'mp3'] }})).toBe(true)
    expect(filterPasses(s, { format: { include: ['flac'] }})).toBe(false)
    expect(filterPasses(s, { format: { exclude: ['mp3'] }})).toBe(false)
  })

  it('does not reject on missing fields ("undetected" sources always pass)', () => {
    expect(filterPasses({}, { format: { include: ['flac'] }})).toBe(true)
    expect(filterPasses({}, { bitrate_min: 256 })).toBe(true)
  })

  it('respects bitrate_min — but only on concrete bitrates', () => {
    expect(filterPasses({ bitrate_kbps: 128 }, { bitrate_min: 256 })).toBe(false)
    expect(filterPasses({ bitrate_kbps: 320 }, { bitrate_min: 256 })).toBe(true)
    expect(filterPasses({ /* lossless */ }, { bitrate_min: 256 })).toBe(true)
  })

  it('respects size and seeders bounds', () => {
    expect(filterPasses({ size: 5_000_000 }, { size_min_mb: 10 })).toBe(false)
    expect(filterPasses({ size: 50_000_000 }, { size_max_mb: 10 })).toBe(false)
    expect(filterPasses({ size: 50_000_000 }, { size_min_mb: 10, size_max_mb: 100 })).toBe(true)
    expect(filterPasses({ seeders: 0 }, { seeders_min: 1 })).toBe(false)
    expect(filterPasses({ seeders: 5 }, { seeders_min: 1 })).toBe(true)
  })

  it('respects cached_only (matches both is_cached and rd_cached flags)', () => {
    expect(filterPasses({}, { cached_only: true })).toBe(false)
    expect(filterPasses({ rd_cached: true }, { cached_only: true })).toBe(true)
    expect(filterPasses({ is_cached: true }, { cached_only: true })).toBe(true)
  })

  it('respects regex_exclude on name (case-insensitive, ignores broken regex)', () => {
    const spec = { regex_exclude: ['\\bnightcore\\b', '\\(', /* bad regex */ '['] }
    expect(filterPasses({ name: 'A nightcore mix' }, spec)).toBe(false)
    expect(filterPasses({ name: 'Live (acoustic)' }, spec)).toBe(false)
    expect(filterPasses({ name: 'Album' }, spec)).toBe(true)
  })
})

describe('applyFilters', () => {
  it('routes by kind', () => {
    const sources = [
      { format: 'flac' },
      { format: 'mp3' },
    ]
    const filters = JSON.stringify({
      tracks:     { format: { include: ['flac'] }},
      audiobooks: { format: { include: ['mp3'] }},
    })
    expect(applyFilters(sources, filters, 'track').map(s => s.format)).toEqual(['flac'])
    expect(applyFilters(sources, filters, 'audiobook').map(s => s.format)).toEqual(['mp3'])
  })

  it('returns input unchanged on empty / malformed spec', () => {
    const sources = [{ format: 'mp3' }]
    expect(applyFilters(sources, null, 'track')).toBe(sources)
    expect(applyFilters(sources, '{not json}', 'track')).toBe(sources)
    expect(applyFilters(sources, JSON.stringify({}), 'track')).toBe(sources)
  })
})

describe('buildSortKeyFn', () => {
  it('returns null for empty / missing spec', () => {
    expect(buildSortKeyFn(null)).toBe(null)
    expect(buildSortKeyFn([])).toBe(null)
    expect(buildSortKeyFn(['nonexistent_step'])).toBe(null)
  })

  it('compiles a stack of named steps', () => {
    const fn = buildSortKeyFn(['rd_cached_desc', 'bitrate_desc'])
    expect(fn).toBeTypeOf('function')
    const a = fn({ rd_cached: true,  bitrate_kbps: 320 })
    const b = fn({ rd_cached: false, bitrate_kbps: 320 })
    expect(a[0] < b[0]).toBe(true)  // rd_cached wins
  })

  it('handles {preferred, ranked} blocks (lower-rank first)', () => {
    const fn = buildSortKeyFn([{ preferred: 'format', ranked: ['flac', 'alac', 'mp3'] }])
    expect(fn({ format: 'flac' })[0]).toBe(0)
    expect(fn({ format: 'mp3' })[0]).toBe(2)
    expect(fn({ format: 'opus' })[0]).toBe(4)  // unknown sorts last
    expect(fn({ /* missing */ })[0]).toBe(4)   // missing sorts last
  })
})

describe('applySort', () => {
  it('sorts FLAC first, then 320, then 128 (audimo-aio smoke parity)', () => {
    const flac = { name: 'flac', format: 'flac' }
    const mp3320 = { name: '320', format: 'mp3', bitrate_kbps: 320 }
    const mp3128 = { name: '128', format: 'mp3', bitrate_kbps: 128 }
    const out = applySort(
      [mp3320, mp3128, flac],
      JSON.stringify({ tracks: [
        { preferred: 'format', ranked: ['flac', 'alac', 'mp3'] },
        'bitrate_desc',
      ]}),
      'track',
    )
    expect(out.map(s => s.name)).toEqual(['flac', '320', '128'])
  })

  it('routes by kind', () => {
    const a = { format: 'flac', name: 'a' }
    const b = { format: 'mp3',  name: 'b' }
    const sortJson = JSON.stringify({
      tracks:     [{ preferred: 'format', ranked: ['flac', 'mp3'] }],
      audiobooks: [{ preferred: 'format', ranked: ['mp3', 'flac'] }],
    })
    expect(applySort([b, a], sortJson, 'track').map(s => s.name)).toEqual(['a', 'b'])
    expect(applySort([b, a], sortJson, 'audiobook').map(s => s.name)).toEqual(['b', 'a'])
  })

  it('returns input on missing / malformed spec', () => {
    const xs = [{ format: 'flac' }]
    expect(applySort(xs, null, 'track')).toBe(xs)
    expect(applySort(xs, '{', 'track')).toBe(xs)
  })

  it('does not mutate the input array', () => {
    const xs = [{ name: 'a', bitrate_kbps: 100 }, { name: 'b', bitrate_kbps: 999 }]
    const out = applySort(xs, JSON.stringify({ tracks: ['bitrate_desc'] }), 'track')
    expect(out.map(s => s.name)).toEqual(['b', 'a'])
    expect(xs.map(s => s.name)).toEqual(['a', 'b'])
  })
})

describe('dedupKey', () => {
  it('cascades through the identity hierarchy', () => {
    expect(dedupKey({ info_hash: 'deadbeef' })).toBe('hash:DEADBEEF')
    expect(dedupKey({ acoustid: 'ABC-123' })).toBe('aid:abc-123')
    expect(dedupKey({ mb_recording_id: 'XYZ' })).toBe('mbid:xyz')
    expect(dedupKey({ name: 'Track', duration: 200 })).toBe('nd:track:200')
    expect(dedupKey({ name: 'Track', duration: 201 })).toBe('nd:track:200')  // bucketed
    expect(dedupKey({ id: 'src-1' })).toBe('id:src-1')
    expect(dedupKey({ name: 'Just a name' })).toBe('id:Just a name')
    expect(dedupKey({})).toBe('id:')
  })

  it('info_hash beats acoustid', () => {
    expect(dedupKey({ info_hash: 'AA', acoustid: 'BB' })).toBe('hash:AA')
  })

  it('returns "" for non-objects', () => {
    expect(dedupKey(null)).toBe('')
    expect(dedupKey(undefined)).toBe('')
    expect(dedupKey('hi')).toBe('')
  })
})

describe('defaultMergeSortKeyFn', () => {
  it('compiles the audimo-aio _merge_rank_key default', () => {
    const fn = defaultMergeSortKeyFn()
    expect(fn).toBeTypeOf('function')
    // Cached + flac + many seeders should beat uncached + mp3 + few.
    const a = fn({ rd_cached: true,  format: 'flac', seeders: 100, size: 1e9 })
    const b = fn({ rd_cached: false, format: 'mp3',  seeders: 1,   size: 1e8 })
    // Tuple compares lexicographically; first element (rd_cached_desc)
    // is enough to decide.
    expect(a[0] < b[0]).toBe(true)
  })
})

describe('makeMergeWrapper', () => {
  // promoter populates `format` so the default _merge_rank_key has
  // a quality bucket to work with — tests use already-promoted
  // shapes so the merge logic itself is what we're exercising.
  function flacSource(name, extras = {}) {
    return { name, format: 'flac', info_hash: name.toUpperCase(), ...extras }
  }
  function mp3Source(name, extras = {}) {
    return { name, format: 'mp3', info_hash: name.toUpperCase(), ...extras }
  }

  it('pools two addons into a single Best Sources section', () => {
    const emitted = []
    const wrap = makeMergeWrapper(s => emitted.push(s), {})
    wrap({ addon_id: 'a', section_id: 'a:Main', label: 'A', sources: [flacSource('a1', { seeders: 50 })] })
    wrap({ addon_id: 'b', section_id: 'b:Main', label: 'B', sources: [mp3Source('b1', { seeders: 10 })] })
    expect(emitted).toHaveLength(2)
    // Each call re-emits the merged section with the new union.
    expect(emitted[0].section_id).toBe('merged')
    expect(emitted[0].sources).toHaveLength(1)
    expect(emitted[1].section_id).toBe('merged')
    expect(emitted[1].sources).toHaveLength(2)
  })

  it('dedupes by info_hash across addons', () => {
    const emitted = []
    const wrap = makeMergeWrapper(s => emitted.push(s), {})
    const dup = mp3Source('shared')
    wrap({ section_id: 'a', sources: [{ ...dup, seeders: 5 }] })
    wrap({ section_id: 'b', sources: [{ ...dup, seeders: 50 }] })  // better-seeded copy
    const last = emitted.at(-1)
    expect(last.sources).toHaveLength(1)
    // Better seed bucket wins on collision (audimo-aio _merge_rank_key).
    expect(last.sources[0].seeders).toBe(50)
  })

  it('keeps the rd_cached copy on collision', () => {
    const emitted = []
    const wrap = makeMergeWrapper(s => emitted.push(s), {})
    wrap({ section_id: 'a', sources: [mp3Source('x', { seeders: 100 })] })
    wrap({ section_id: 'b', sources: [mp3Source('x', { seeders: 1, rd_cached: true })] })
    const last = emitted.at(-1)
    expect(last.sources).toHaveLength(1)
    expect(last.sources[0].rd_cached).toBe(true)
  })

  it('passes error sections through unchanged', () => {
    const emitted = []
    const wrap = makeMergeWrapper(s => emitted.push(s), {})
    wrap({ section_id: 'a:err', sources: [], error: 'boom' })
    expect(emitted).toHaveLength(1)
    expect(emitted[0].error).toBe('boom')
    expect(emitted[0].section_id).toBe('a:err')   // not rewritten
  })

  it('passes already-merged sections through unchanged', () => {
    const emitted = []
    const wrap = makeMergeWrapper(s => emitted.push(s), {})
    const upstream = {
      addon_id: 'meta',
      section_id: 'meta:Best',
      label: 'Best (upstream)',
      sources: [flacSource('m')],
      merged: true,
    }
    wrap(upstream)
    expect(emitted).toEqual([upstream])
  })

  it('respects a user sort spec when one is configured', () => {
    const emitted = []
    const wrap = makeMergeWrapper(
      s => emitted.push(s),
      { sort_json: JSON.stringify({ tracks: ['bitrate_desc'] }) },
      'track',
    )
    wrap({ section_id: 'a', sources: [mp3Source('a', { bitrate_kbps: 128 })] })
    wrap({ section_id: 'b', sources: [mp3Source('b', { bitrate_kbps: 320 })] })
    expect(emitted.at(-1).sources.map(s => s.name)).toEqual(['b', 'a'])
  })

  it('caps the merged list per the cap option', () => {
    const emitted = []
    const wrap = makeMergeWrapper(s => emitted.push(s), {}, undefined, { cap: 2 })
    wrap({ section_id: 'a', sources: [
      mp3Source('1', { seeders: 30 }),
      mp3Source('2', { seeders: 20 }),
      mp3Source('3', { seeders: 10 }),
    ]})
    expect(emitted.at(-1).sources).toHaveLength(2)
  })
})
