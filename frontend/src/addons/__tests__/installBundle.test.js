// Tests for the bundle-install module.
//
// The hosted audimo-aio configure page is the producer side of this
// contract; mismatches here would silently break the multi-addon
// install flow without breaking type checks.
//
// Run with: cd frontend && npm test

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  applyBundle,
  bundleUrlFromDeepLink,
  fetchBundle,
} from '../installBundle.js'

// applyBundle uses opts.deps to receive injected mocks for
// `addonInstall` / `registry.install` / `isDesktop`. The default
// (no deps) wires through to the real modules — fine for fetchBundle
// tests which don't reach the install loop. Tests that exercise the
// install loop pass mocks via deps.
//
// `b64urlEncode` (from registry.js) is used by the production code's
// bakeCredentials helper. Stub registry.js so the import chain
// doesn't drag localStorage / IndexedDB in.
vi.mock('../registry.js', () => ({
  install: vi.fn(),
  b64urlEncode: (s) =>
    Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
}))
vi.mock('../desktop.js', () => ({
  isDesktop: () => false,
  addonInstall: vi.fn(),
}))

describe('bundleUrlFromDeepLink', () => {
  it('returns the embedded url for a valid install-bundle deep link', () => {
    expect(
      bundleUrlFromDeepLink('audimo://install-bundle?url=https://x/c/abc/bundle.json'),
    ).toBe('https://x/c/abc/bundle.json')
  })

  it('is case-insensitive on the scheme', () => {
    expect(
      bundleUrlFromDeepLink('AUDIMO://install-bundle?url=https://x'),
    ).toBe('https://x')
  })

  it.each([
    ['non-audimo scheme',         'https://other.com/foo'],
    ['different verb',            'audimo://other-action?url=https://x'],
    ['no query string',           'audimo://install-bundle'],
    ['empty url param',           'audimo://install-bundle?url='],
    ['null',                      null],
    ['undefined',                 undefined],
    ['empty string',              ''],
    ['number',                    42],
  ])('returns null for %s', (_label, input) => {
    expect(bundleUrlFromDeepLink(input)).toBeNull()
  })
})

describe('fetchBundle', () => {
  let originalFetch
  beforeEach(() => {
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function mockFetch(impl) {
    globalThis.fetch = vi.fn(impl)
  }

  it('parses a well-formed bundle response', async () => {
    mockFetch(async () => new Response(JSON.stringify({
      version: 1,
      addons: [
        { url: 'https://a/', name: 'a' },
        { url: 'https://b/', name: 'b' },
      ],
      aggregator_settings: { merge_sources: 'true' },
    }), { status: 200 }))
    const out = await fetchBundle('https://aio.example/c/abc/bundle.json')
    expect(out.version).toBe(1)
    expect(out.addons.map(a => a.url)).toEqual(['https://a/', 'https://b/'])
    expect(out.aggregator_settings).toEqual({ merge_sources: 'true' })
  })

  it('drops malformed addon entries silently (the producer is upstream)', async () => {
    mockFetch(async () => new Response(JSON.stringify({
      addons: [
        { url: 'https://ok/', name: 'good' },
        { url: '   ', name: 'whitespace' },     // dropped
        { name: 'no url or manifest_url' },     // dropped
        null,                                    // dropped
        { url: 'https://ok2/' },                 // kept, name defaults to ''
        { manifest_url: 'https://catalog/m.json', name: 'catalog' }, // kept (manifest_url path)
      ],
    }), { status: 200 }))
    const out = await fetchBundle('https://aio/x')
    expect(out.addons.map(a => a.url || a.manifest_url)).toEqual([
      'https://ok/', 'https://ok2/', 'https://catalog/m.json',
    ])
    expect(out.addons[1].name).toBe('')
    expect(out.addons[2].manifest_url).toBe('https://catalog/m.json')
  })

  it('parses entries with a credentials dict', async () => {
    mockFetch(async () => new Response(JSON.stringify({
      addons: [{
        manifest_url: 'https://catalog/m.json',
        name: 'indexers',
        credentials: { rd_api_key: 'rd-token', alldebrid_api_key: 'ad-token' },
      }],
    }), { status: 200 }))
    const out = await fetchBundle('https://aio/x')
    expect(out.addons[0].credentials).toEqual({
      rd_api_key: 'rd-token', alldebrid_api_key: 'ad-token',
    })
  })

  it.each([
    ['HTTP error',     async () => new Response('boom', { status: 502 }), /HTTP 502/],
    ['non-JSON body',  async () => new Response('<html>nope</html>', { status: 200 }),
                                                                          /not JSON/],
    ['missing addons', async () => new Response(JSON.stringify({ version: 1 }), { status: 200 }),
                                                                          /addons/],
    ['non-object',     async () => new Response(JSON.stringify('hi'), { status: 200 }),
                                                                          /not an object/],
  ])('throws on %s', async (_label, impl, msgRe) => {
    mockFetch(impl)
    await expect(fetchBundle('https://aio/x')).rejects.toThrow(msgRe)
  })

  it.each([null, undefined, '', 42])('throws on bad URL input %s', async (bad) => {
    await expect(fetchBundle(bad)).rejects.toThrow(/url required/i)
  })
})

describe('applyBundle', () => {
  // Tests inject mocks via opts.deps so we don't have to monkey-patch
  // the desktop module surface. addonInstall stub returns a fake
  // running URL for the catalog-install path.
  function deps({
    addonInstall = vi.fn(async (url) => ({ url: 'http://127.0.0.1:50000', name: 'mock' })),
    isDesktop = vi.fn(() => true),
    registryInstall = vi.fn(async () => {}),
  } = {}) {
    return { addonInstall, isDesktop, registryInstall }
  }

  it('catalog-install path: addonInstall → bake creds → registryInstall', async () => {
    const d = deps()
    const result = await applyBundle({
      addons: [{
        manifest_url: 'https://catalog/m.json',
        name: 'indexers',
        credentials: { rd_api_key: 'rd-token' },
      }],
    }, { deps: d })
    expect(d.addonInstall).toHaveBeenCalledWith('https://catalog/m.json')
    expect(d.registryInstall).toHaveBeenCalledTimes(1)
    // The URL handed to registry.install carries a base64 segment with
    // the credential payload — decode and check.
    const passed = d.registryInstall.mock.calls[0][0]
    expect(passed).toMatch(/^http:\/\/127\.0\.0\.1:50000\//)
    const seg = passed.split('/').pop()
    const pad = '='.repeat((4 - (seg.length % 4)) % 4)
    const decoded = Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString()
    expect(JSON.parse(decoded)).toEqual({ rd_api_key: 'rd-token' })
    expect(result.installed[0].status).toBe('installed')
  })

  it('legacy url path: skips addonInstall, bakes empty creds, calls registryInstall', async () => {
    const d = deps()
    await applyBundle({
      addons: [{ url: 'http://localhost:9005', name: 'local', credentials: {} }],
    }, { deps: d })
    expect(d.addonInstall).not.toHaveBeenCalled()
    expect(d.registryInstall).toHaveBeenCalledWith('http://localhost:9005')
  })

  it('non-desktop refuses manifest_url-only entries with a useful error', async () => {
    const d = deps({ isDesktop: vi.fn(() => false) })
    const result = await applyBundle({
      addons: [{ manifest_url: 'https://catalog/m.json', name: 'x' }],
    }, { deps: d })
    expect(d.addonInstall).not.toHaveBeenCalled()
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].error).toMatch(/desktop/i)
  })

  it('falls back to url when manifest_url install fails (other addons keep going)', async () => {
    const d = deps({
      addonInstall: vi.fn(async () => { throw new Error('release 404') }),
    })
    const result = await applyBundle({
      addons: [
        { manifest_url: 'https://catalog/dead.json', name: 'dead' },
        { url: 'http://localhost:9006', name: 'ok' },
      ],
    }, { deps: d })
    expect(result.installed.map(e => e.name)).toEqual(['ok'])
    expect(result.failed.map(e => e.name)).toEqual(['dead'])
    expect(result.failed[0].error).toBe('release 404')
  })

  it('emits a progress event per addon', async () => {
    const d = deps({
      registryInstall: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('boom')),
    })
    const events = []
    await applyBundle(
      { addons: [
        { url: 'https://a/', credentials: {} },
        { url: 'https://b/', credentials: {} },
      ]},
      { deps: d, onProgress: (e) => events.push(e) },
    )
    expect(events).toHaveLength(2)
    expect(events[0].status).toBe('installed')
    expect(events[1].status).toBe('failed')
    expect(events[1].error).toBe('boom')
  })

  it('handles an empty bundle', async () => {
    const d = deps()
    const result = await applyBundle({ addons: [] }, { deps: d })
    expect(result.installed).toEqual([])
    expect(result.failed).toEqual([])
    expect(d.registryInstall).not.toHaveBeenCalled()
    expect(d.addonInstall).not.toHaveBeenCalled()
  })

  it('returns aggregator_settings as-is', async () => {
    const d = deps()
    const result = await applyBundle({
      addons: [],
      aggregator_settings: { merge_sources: 'true', filters_json: '{}' },
    }, { deps: d })
    expect(result.aggregator_settings).toEqual({ merge_sources: 'true', filters_json: '{}' })
  })
})
