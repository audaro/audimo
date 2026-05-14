// Tests for the aggregator-settings store.
//
// Stored shape mirrors audimo-aio's bundle endpoint output, so
// regressions here would silently change what the source-aggregation
// pipeline reads at fan-out time.
//
// Run with: cd frontend && npm test

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// vitest's default node env doesn't ship a localStorage; the registry
// tests in this dir install a tiny in-memory shim before each run.
// We mirror the same shape so reads/writes behave like a real browser.
function createMemoryStorage() {
  const store = new Map()
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: (k) => { store.delete(k) },
    clear: () => { store.clear() },
  }
}

let aggregatorSettings
beforeEach(async () => {
  globalThis.localStorage = createMemoryStorage()
  // Reset the module cache so each test starts from a clean import —
  // the module itself is stateless but this keeps semantics
  // consistent with the registry tests next door.
  await new Promise((r) => setTimeout(r, 0))
  aggregatorSettings = await import('../aggregatorSettings.js')
})

describe('aggregatorSettings', () => {
  afterEach(() => {
    aggregatorSettings.clear()
  })

  it('returns {} when nothing has been stored', () => {
    expect(aggregatorSettings.get()).toEqual({})
  })

  it('round-trips a typical bundle aggregator_settings blob', () => {
    aggregatorSettings.set({
      filters_json: '{"tracks":{"bitrate_min":256}}',
      sort_json: '{"tracks":["bitrate_desc"]}',
      merge_sources: 'true',
    })
    expect(aggregatorSettings.get()).toEqual({
      filters_json: '{"tracks":{"bitrate_min":256}}',
      sort_json: '{"tracks":["bitrate_desc"]}',
      merge_sources: 'true',
    })
  })

  it('canonicalises merge_sources to lowercase "true"/"false" wire form', () => {
    // Cover the menagerie of forms that reach us: JS bool, Python's
    // str(True) ("True"), user-typed strings, "1"/"0" booleans, and
    // truthy numbers.
    const truthy = [true, 'true', 'True', 'TRUE', 'yes', 'on', '1', 1]
    const falsy =  [false, 'false', 'False', 'no', 'off', '0', 0, '', '  ']
    for (const v of truthy) {
      aggregatorSettings.set({ merge_sources: v })
      expect(aggregatorSettings.get()).toEqual({ merge_sources: 'true' })
    }
    for (const v of falsy) {
      aggregatorSettings.set({ merge_sources: v })
      expect(aggregatorSettings.get()).toEqual({ merge_sources: 'false' })
    }
  })

  it('drops unknown keys (the bundle producer is upstream)', () => {
    aggregatorSettings.set({
      filters_json: '{}',
      something_unrelated: 'x',
      api_key: 'leak-attempt',
    })
    expect(aggregatorSettings.get()).toEqual({ filters_json: '{}' })
  })

  it.each([
    ['null',      null],
    ['undefined', undefined],
    ['array',     []],
    ['number',    42],
    ['empty obj', {}],
    ['object with only-non-string fields', { filters_json: 5, sort_json: null }],
  ])('clears storage when called with %s', (_label, input) => {
    aggregatorSettings.set({ filters_json: '{}' })
    expect(aggregatorSettings.get()).toEqual({ filters_json: '{}' })
    aggregatorSettings.set(input)
    expect(aggregatorSettings.get()).toEqual({})
  })

  it('survives a corrupt stored value (returns {})', () => {
    localStorage.setItem('audimo:aggregator_settings', '{not valid json')
    expect(aggregatorSettings.get()).toEqual({})
  })

  it('survives a stored array (returns {})', () => {
    localStorage.setItem('audimo:aggregator_settings', JSON.stringify([1, 2, 3]))
    expect(aggregatorSettings.get()).toEqual({})
  })

  it('clear() removes the stored value', () => {
    aggregatorSettings.set({ filters_json: '{}' })
    aggregatorSettings.clear()
    expect(localStorage.getItem('audimo:aggregator_settings')).toBeNull()
  })
})
