// Tests for the registry's install transactionality.
//
// The boot-time pull in store.js treats the backend as source of truth:
// any local-only entry that the backend doesn't know about gets dropped
// on reload. So when registry.install's write-through to the backend
// fails, the local write must revert — otherwise the catalog UI shows
// "Installed" briefly, then the next reload silently undoes it (the
// bug that prompted this fix).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const MANIFEST = {
  id: 'test-addon',
  name: 'Test Addon',
  version: '1.0.0',
  capabilities: ['resolve.sources'],
}

beforeEach(async () => {
  // Each test gets fresh storage and a fresh module instance — the
  // registry caches state at module scope, so vi.resetModules() is
  // mandatory between tests.
  globalThis.localStorage = createMemoryStorage()
  globalThis.fetch = vi.fn(async (url) => {
    if (url.endsWith('/manifest.json')) {
      return { ok: true, json: async () => MANIFEST }
    }
    return { ok: false, status: 404 }
  })
  vi.resetModules()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('registry.install — transactional backend sync', () => {
  it('persists locally when write-through succeeds', async () => {
    const { default: registryFresh } = await importFresh()
    await registryFresh.init()
    const writeThrough = vi.fn(async () => {})
    registryFresh.setWriteThrough(writeThrough)

    const row = await registryFresh.install('http://127.0.0.1:53189')

    expect(row.id).toBe('test-addon')
    expect(writeThrough).toHaveBeenCalledOnce()
    expect(registryFresh.list()).toHaveLength(1)
    expect(registryFresh.get('test-addon')).toBeTruthy()
  })

  it('reverts the local write when write-through fails', async () => {
    const { default: registryFresh } = await importFresh()
    await registryFresh.init()
    const writeThrough = vi.fn(async () => {
      throw new Error('HTTP 500')
    })
    registryFresh.setWriteThrough(writeThrough)

    await expect(registryFresh.install('http://127.0.0.1:53189'))
      .rejects.toThrow(/Backend sync failed.*HTTP 500/)

    // Local must NOT have the entry — otherwise the boot-time pull
    // would silently drop it on next reload (the original bug).
    expect(registryFresh.list()).toHaveLength(0)
    expect(registryFresh.get('test-addon')).toBeNull()
  })

  it('restores prior version when reinstall write-through fails', async () => {
    // First install (succeeds) creates a baseline. Second install with
    // an updated manifest fails the write-through; the prior row must
    // come back, not disappear and not show the half-applied update.
    const { default: registryFresh } = await importFresh()
    await registryFresh.init()
    const writeThrough = vi.fn(async () => {})
    registryFresh.setWriteThrough(writeThrough)

    await registryFresh.install('http://127.0.0.1:53189')
    const before = registryFresh.get('test-addon')
    expect(before.url).toBe('http://127.0.0.1:53189')

    // Now arm write-through to throw, and try to "upgrade" to a new URL.
    writeThrough.mockImplementationOnce(async () => {
      throw new Error('HTTP 503')
    })
    await expect(registryFresh.install('http://127.0.0.1:99999'))
      .rejects.toThrow(/Backend sync failed.*HTTP 503/)

    // The original row should be intact, not the new URL.
    const after = registryFresh.get('test-addon')
    expect(after).toBeTruthy()
    expect(after.url).toBe('http://127.0.0.1:53189')
    expect(after.installedAt).toBe(before.installedAt)
  })

  it('skips write-through entirely when opts.deviceLocal=true', async () => {
    const { default: registryFresh } = await importFresh()
    await registryFresh.init()
    const writeThrough = vi.fn(async () => {
      throw new Error('should not be called')
    })
    registryFresh.setWriteThrough(writeThrough)

    const row = await registryFresh.install(
      'http://127.0.0.1:53189',
      { deviceLocal: true },
    )

    expect(row.id).toBe('test-addon')
    expect(writeThrough).not.toHaveBeenCalled()
    expect(registryFresh.list()).toHaveLength(1)
  })
})

describe('registry.remove — transactional backend sync', () => {
  it('removes locally when write-through succeeds', async () => {
    const { default: registryFresh } = await importFresh()
    await registryFresh.init()
    const writeThrough = vi.fn(async () => {})
    registryFresh.setWriteThrough(writeThrough)

    await registryFresh.install('http://127.0.0.1:53189')
    expect(registryFresh.list()).toHaveLength(1)

    const ok = await registryFresh.remove('test-addon')
    expect(ok).toBe(true)
    expect(registryFresh.list()).toHaveLength(0)
  })

  it('restores the entry when write-through fails', async () => {
    const { default: registryFresh } = await importFresh()
    await registryFresh.init()
    const writeThrough = vi.fn(async () => {})
    registryFresh.setWriteThrough(writeThrough)

    await registryFresh.install('http://127.0.0.1:53189')

    writeThrough.mockImplementationOnce(async () => {
      throw new Error('HTTP 502')
    })
    await expect(registryFresh.remove('test-addon'))
      .rejects.toThrow(/Backend sync failed.*HTTP 502/)

    // Entry must be back — otherwise next boot pull would re-fetch
    // from backend (which still has it) and "resurrect" it, but with
    // a stale URL (pre-remove), masking the failure.
    expect(registryFresh.list()).toHaveLength(1)
    expect(registryFresh.get('test-addon')).toBeTruthy()
  })

  it('returns false when removing a non-existent id (no write-through)', async () => {
    const { default: registryFresh } = await importFresh()
    await registryFresh.init()
    const writeThrough = vi.fn(async () => {})
    registryFresh.setWriteThrough(writeThrough)

    const ok = await registryFresh.remove('does-not-exist')
    expect(ok).toBe(false)
    expect(writeThrough).not.toHaveBeenCalled()
  })
})

describe('registry.setEnabled — transactional backend sync', () => {
  it('persists toggle when write-through succeeds', async () => {
    const { default: registryFresh } = await importFresh()
    await registryFresh.init()
    const writeThrough = vi.fn(async () => {})
    registryFresh.setWriteThrough(writeThrough)

    await registryFresh.install('http://127.0.0.1:53189')
    const updated = await registryFresh.setEnabled('test-addon', false)

    expect(updated.enabled).toBe(false)
    expect(registryFresh.get('test-addon').enabled).toBe(false)
  })

  it('reverts toggle when write-through fails', async () => {
    const { default: registryFresh } = await importFresh()
    await registryFresh.init()
    const writeThrough = vi.fn(async () => {})
    registryFresh.setWriteThrough(writeThrough)

    await registryFresh.install('http://127.0.0.1:53189')
    expect(registryFresh.get('test-addon').enabled).toBe(true)

    writeThrough.mockImplementationOnce(async () => {
      throw new Error('HTTP 504')
    })
    await expect(registryFresh.setEnabled('test-addon', false))
      .rejects.toThrow(/Backend sync failed.*HTTP 504/)

    // Toggle must be back to true (the prior state).
    expect(registryFresh.get('test-addon').enabled).toBe(true)
  })

  it('returns null for non-existent id (no write-through)', async () => {
    const { default: registryFresh } = await importFresh()
    await registryFresh.init()
    const writeThrough = vi.fn(async () => {})
    registryFresh.setWriteThrough(writeThrough)

    const result = await registryFresh.setEnabled('does-not-exist', false)
    expect(result).toBeNull()
    expect(writeThrough).not.toHaveBeenCalled()
  })
})

describe('registry.patchUrl — transactional backend sync', () => {
  it('updates origin when write-through succeeds', async () => {
    const { default: registryFresh } = await importFresh()
    await registryFresh.init()
    const writeThrough = vi.fn(async () => {})
    registryFresh.setWriteThrough(writeThrough)

    await registryFresh.install('http://127.0.0.1:53189')
    const updated = await registryFresh.patchUrl('test-addon', 'http://127.0.0.1:99999')

    expect(updated).toBeTruthy()
    expect(updated.url).toBe('http://127.0.0.1:99999')
    expect(registryFresh.get('test-addon').url).toBe('http://127.0.0.1:99999')
  })

  it('reverts URL when write-through fails', async () => {
    const { default: registryFresh } = await importFresh()
    await registryFresh.init()
    const writeThrough = vi.fn(async () => {})
    registryFresh.setWriteThrough(writeThrough)

    await registryFresh.install('http://127.0.0.1:53189')

    writeThrough.mockImplementationOnce(async () => {
      throw new Error('HTTP 521')
    })
    await expect(registryFresh.patchUrl('test-addon', 'http://127.0.0.1:99999'))
      .rejects.toThrow(/Backend sync failed.*HTTP 521/)

    // URL stays at the original — the boot reconcile loop will retry
    // patchUrl on the next boot if the sidecar port mismatch persists.
    expect(registryFresh.get('test-addon').url).toBe('http://127.0.0.1:53189')
  })

  it('returns the existing row when origin already matches (no write-through)', async () => {
    const { default: registryFresh } = await importFresh()
    await registryFresh.init()
    const writeThrough = vi.fn(async () => {})
    registryFresh.setWriteThrough(writeThrough)

    await registryFresh.install('http://127.0.0.1:53189')
    writeThrough.mockClear()

    const result = await registryFresh.patchUrl('test-addon', 'http://127.0.0.1:53189')
    expect(result.url).toBe('http://127.0.0.1:53189')
    expect(writeThrough).not.toHaveBeenCalled()
  })
})

// ── helpers ────────────────────────────────────────────────────────

function createMemoryStorage() {
  const store = new Map()
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: (k) => { store.delete(k) },
    clear: () => { store.clear() },
  }
}

async function importFresh() {
  const mod = await import('../registry.js')
  return { default: mod }
}
