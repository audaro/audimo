import { useState, useEffect, useRef } from 'react'
import { useStore } from '../store'
import * as registry from '../addons/registry'
import * as catalogSources from '../addons/catalogSources'
import * as desktop from '../desktop'
import styles from './AddonsView.module.css'

// Catalog model:
//   * The user adds catalog *sources* (URLs to JSON files) — like
//     apt sources.list or Cydia repos. Each file lists addons.
//   * The Catalog section aggregates addons across all configured
//     sources for one-click install.
//   * Fresh installs ship with **zero** sources. The user (or a
//     distributor) seeds them.
//
// Catalog file shape (versioned via `schema_version`):
//   {
//     "schema_version": 1,
//     "name": "audaro",                       // optional, used as a label
//     "description": "...",                   // optional
//     "addons": [
//       {
//         "id": "example-addon",
//         "name": "Example Addon",
//         "description": "...",
//         "author": "audaro",
//         "homepage": "https://github.com/audaro/example-addon",
//         "icon_url": "",
//         "manifest_url":
//           "https://github.com/audaro/example-addon/releases/latest/download/manifest.json"
//       }
//     ]
//   }

// ──────────────────────────────────────────────────────────────────
// Addons UI — device-as-client edition.
//
// Audimo's backend no longer stores addon URLs or credentials. Each
// device keeps its own addon list in localStorage (see
// frontend/src/addons/registry.js). All operations on this page —
// install, remove, toggle, configure — touch the registry directly,
// never the backend.
//
// Configure flow (unchanged from the server-storage era):
//   1. User clicks "Configure" → we open the addon's `/configure` URL
//      in a new browser tab (target=_blank rel="opener"). Because
//      addon.url already carries the user's secrets path-segment, the
//      configure page's pre-fill logic populates the form from the
//      existing install. We also merge in the addon's non-secret
//      toggles so show_if fields render correctly.
//   2. The configure page builds a new install URL on submit and
//      window.opener.postMessage()s it back to us.
//   3. We validate the message (origin + shape) and feed the URL to
//      registry.install() — same code path as a manual paste. Secrets
//      stay in the URL, non-secret toggles are saved as `settings`.
// ──────────────────────────────────────────────────────────────────

function originOf(urlStr) {
  try { return new URL(urlStr).origin } catch { return null }
}

// Catalog-installed addons live at http://127.0.0.1:<port>, which is
// machine-specific. Export/Import skips them — re-adding the catalog
// source on the new device + re-installing is the right reproduction
// path, not exporting a localhost URL that won't resolve.
function isLocalhostUrl(urlStr) {
  try {
    const h = new URL(urlStr).hostname
    return h === 'localhost' || h === '::1' || h.startsWith('127.')
  } catch { return true }
}

export default function AddonsView() {
  const { showToast, addons, bumpCacheVersion } = useStore()
  const addonHealth = useStore(s => s.addonHealth)
  const probeAddonHealth = useStore(s => s.probeAddonHealth)
  const [url, setUrl] = useState('')
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState('')

  // Probe each installed addon's /manifest.json on mount + every 60s
  // so we can show an offline banner instead of silently returning no
  // results when an addon sidecar has crashed or wandered off.
  useEffect(() => {
    if (!addons.length) return
    probeAddonHealth()
    const id = setInterval(() => probeAddonHealth(), 60000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addons.length])

  // Offline rows surface above the addon list — single banner with a
  // count + retry button (rather than one banner per addon, which
  // would dominate the page if multiple are down).
  const offlineAddons = addons.filter(a => {
    if (a.enabled === false) return false
    const h = addonHealth[a.id]
    // Only mark offline once we've actually checked at least once.
    // Avoids a false "all offline" flash on first mount before the
    // probe completes.
    return h && h.online === false
  })

  // Catalog state. Only meaningful in the desktop build — phone
  // browser / web dev see the manual install field as their only path.
  const isDesktopApp = desktop.isDesktop()
  // Source list (from localStorage) and per-source fetch results
  // keyed by source id.
  const [sources, setSources] = useState(() => catalogSources.list())
  const [sourceData, setSourceData] = useState({})  // id → {catalog, error, loading}
  const [newSourceUrl, setNewSourceUrl] = useState('')
  const [addingSource, setAddingSource] = useState(false)
  const [sourceError, setSourceError] = useState('')
  const [managedAddons, setManagedAddons] = useState([])
  const [busyId, setBusyId] = useState('')
  const [installProgress, setInstallProgress] = useState({})
  // Catalog filter/search. `catalogSourceFilter` is a source id or '' for All.
  const [catalogQuery, setCatalogQuery] = useState('')
  const [catalogSourceFilter, setCatalogSourceFilter] = useState('')
  // Disclosures. Sources opens automatically when the user has none so
  // the empty-state nudges them; Advanced is collapsed by default.
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  // Design v2: Installed / Discover / For developers. Discover is
  // the catalog browser + install-from-URL escape hatch; For
  // developers replaces the old "Building an addon" docs section.
  const [tab, setTab] = useState('installed')

  const refreshManaged = async () => {
    try {
      const list = await desktop.addonList()
      setManagedAddons(list || [])
    } catch (e) {
      // Non-desktop just gets [] silently.
      setManagedAddons([])
    }
  }

  // Fetch a single source's catalog and stash the result. Persists the
  // source's `lastFetchedAt` and either the fetched name or the last
  // error so the source list stays informative across reloads.
  const fetchSource = async (source) => {
    if (!isDesktopApp) return
    setSourceData(prev => ({
      ...prev,
      [source.id]: { ...(prev[source.id] || {}), loading: true },
    }))
    try {
      const catalog = await desktop.addonCatalogFetch(source.url)
      const name = (catalog && typeof catalog.name === 'string')
        ? catalog.name : null
      const count = Array.isArray(catalog?.addons) ? catalog.addons.length : 0
      catalogSources.update(source.id, {
        lastFetchedAt: Date.now(),
        lastError: null,
        name,
        addonCount: count,
      })
      setSourceData(prev => ({
        ...prev,
        [source.id]: { catalog, error: null, loading: false },
      }))
    } catch (e) {
      const msg = e?.message || String(e)
      catalogSources.update(source.id, {
        lastFetchedAt: Date.now(),
        lastError: msg,
      })
      setSourceData(prev => ({
        ...prev,
        [source.id]: { catalog: null, error: msg, loading: false },
      }))
    }
  }

  // Subscribe to source list changes (add/remove/update from anywhere
  // in the app — currently only this view, but the subscription model
  // matches how the addon registry works).
  useEffect(() => {
    if (!isDesktopApp) return
    setSources(catalogSources.list())
    refreshManaged()
    const unsub = catalogSources.subscribe(rows => setSources(rows))
    return unsub
  }, [isDesktopApp])

  // Subscribe to install progress events from the Rust sidecar runtime.
  useEffect(() => {
    if (!isDesktopApp) return
    let unlisten
    desktop.listenAddonInstallProgress(({ id, pct, message }) => {
      setInstallProgress(prev => ({ ...prev, [id]: { pct, message } }))
    }).then(fn => { unlisten = fn })
    return () => { unlisten?.() }
  }, [isDesktopApp])

  // Refetch every source whenever the source list changes (covers
  // initial mount, add, remove). Per-source `loading` state prevents
  // double-fetching.
  useEffect(() => {
    if (!isDesktopApp) return
    sources.forEach(s => {
      // Only auto-fetch sources we haven't fetched yet OR ones the
      // user explicitly asked us to refresh (lastFetchedAt cleared).
      const cur = sourceData[s.id]
      if (cur?.catalog || cur?.loading) return
      fetchSource(s)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources, isDesktopApp])

  const addSource = async () => {
    const u = newSourceUrl.trim()
    if (!u) return
    setAddingSource(true)
    setSourceError('')
    try {
      catalogSources.add(u)
      setNewSourceUrl('')
    } catch (e) {
      setSourceError(e?.message || 'Failed to add source')
    } finally {
      setAddingSource(false)
    }
  }

  const removeSource = (source) => {
    catalogSources.remove(source.id)
    setSourceData(prev => {
      const next = { ...prev }
      delete next[source.id]
      return next
    })
  }

  const refreshSource = (source) => {
    setSourceData(prev => {
      const next = { ...prev }
      delete next[source.id]
      return next
    })
    fetchSource(source)
  }

  // The Rust runtime returns as soon as the addon's TCP port is bound,
  // but uvicorn occasionally needs another beat before HTTP is fully
  // ready to serve. registry.install fetches /manifest.json and throws
  // if that fetch races the HTTP startup — which previously fell
  // through to a silent console.warn, leaving the catalog card showing
  // "Uninstall" while the in-browser registry stayed empty (and so
  // SourcePicker never queried the addon). Retry with a short backoff
  // covers the race; a final failure surfaces as a toast.
  const registryInstallWithRetry = async (url) => {
    const delays = [0, 600, 1500, 3000]
    let lastErr
    for (const ms of delays) {
      if (ms) await new Promise(r => setTimeout(r, ms))
      try {
        return await registry.install(url)
      } catch (e) {
        lastErr = e
      }
    }
    throw lastErr || new Error('registry.install failed')
  }

  const installFromCatalog = async (entry) => {
    if (!entry?.manifest_url) return
    setBusyId(entry.id)
    try {
      const status = await desktop.addonInstall(entry.manifest_url)
      // Hand the freshly-bound URL to the existing addon registry so
      // the rest of the app sees the addon exactly like a
      // manually-installed one. If it's already in the registry (e.g.
      // user re-installed) the registry replaces the URL.
      let registered = false
      if (status?.url) {
        try {
          await registryInstallWithRetry(status.url)
          registered = true
        } catch (e) {
          // Catalog runtime succeeded (binary downloaded + spawned),
          // but the in-browser registry handoff failed. Surface
          // explicitly — without it, the catalog card flips to
          // Uninstall but SourcePicker won't see the addon, which
          // looks like the install silently no-op'd.
          console.warn('[AddonsView] registry.install after catalog install failed:',
                       e?.message || e)
          showToast(
            `${status?.name || entry.name} downloaded but registry handoff failed: ${e?.message || e}. ` +
            `Try pasting ${status.url} into Install Addon manually.`
          )
        }
      }
      await refreshManaged()
      bumpCacheVersion()
      if (registered) {
        showToast(`${status?.name || entry.name} installed`)
      }
    } catch (e) {
      showToast(`Install failed: ${e?.message || e}`)
    } finally {
      setBusyId('')
      setInstallProgress(prev => { const n = { ...prev }; delete n[entry.id]; return n })
    }
  }

  const uninstallFromCatalog = async (entry) => {
    if (!entry?.id) return
    setBusyId(entry.id)
    try {
      // Drop from the in-browser registry first so resolve flows stop
      // hitting it immediately, then tell the runtime to kill the
      // child process and rm the binary.
      try { registry.remove(entry.id) } catch {}
      await desktop.addonUninstall(entry.id)
      await refreshManaged()
      bumpCacheVersion()
      showToast(`${entry.name || entry.id} removed`)
    } catch (e) {
      showToast(`Uninstall failed: ${e?.message || e}`)
    } finally {
      setBusyId('')
    }
  }

  // Listen for install URLs posted back from addon /configure pages.
  // Validate origin against the installed addon list and shape strictly —
  // this is the entry point that lets a remote page trigger an install,
  // so it has to be tight.
  //
  // Bundles (audimo-aio's "install everything I picked" flow) carry a
  // `bundleUrl` field on the same message; those are handled by
  // BundleInstallListener at app root with its own confirm dialog. We
  // bail out of this single-addon path so the same click doesn't
  // double-install audimo-aio plus everything in its bundle.
  useEffect(() => {
    function onMessage(e) {
      const msg = e.data
      if (!msg || msg.type !== 'tunnel-addon:install') return
      if (typeof msg.bundleUrl === 'string' && msg.bundleUrl) return
      if (typeof msg.url !== 'string' || typeof msg.addonId !== 'string') return
      const matching = addons.find(a => a.id === msg.addonId)
      if (!matching) return
      const addonOrigin = originOf(matching.url)
      if (!addonOrigin || e.origin !== addonOrigin) return
      installFromConfigure(msg.url)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [addons])

  const install = async () => {
    const raw = url.trim()
    if (!raw) return
    setInstalling(true)
    setError('')
    try {
      // Probe the manifest first. If the URL is a bundled-config
      // aggregator (`manifest.bundle: true` with a bundle_url),
      // hand it off to BundleInstallListener at the app root —
      // which fetches the bundle and one-click-installs every
      // addon with the user's saved settings. Otherwise fall
      // through to the single-addon install path.
      const stripped = raw.replace(/\/manifest\.json$/, '').replace(/\/+$/, '')
      let manifest = null
      try {
        const r = await fetch(`${stripped}/manifest.json`, { method: 'GET' })
        if (r.ok) manifest = await r.json()
      } catch {
        // Probe failure flows through to the registry.install path,
        // which will surface the same network error with its own
        // message.
      }
      if (manifest && manifest.bundle && typeof manifest.bundle_url === 'string' && manifest.bundle_url) {
        // Same wire shape as the audimo:// deep link path —
        // BundleInstallListener handles the confirm dialog and
        // applyBundle.
        window.postMessage({
          type: 'tunnel-addon:install',
          bundleUrl: manifest.bundle_url,
        }, window.location.origin)
        setUrl('')
        return
      }
      await registry.install(raw)
      setUrl('')
    } catch (e) {
      setError(e.message || 'Install failed')
    } finally {
      setInstalling(false)
    }
  }

  const installFromConfigure = async (newUrl) => {
    try {
      await registry.install(newUrl)
      showToast('Settings saved')
    } catch (e) {
      showToast(`Update failed: ${e.message}`)
    }
  }

  // Library purge note: in the device-as-client model, the backend
  // stores library entries that reference an addon by id. Disabling or
  // removing an addon makes those entries unresolvable on this device,
  // but they aren't "purged" eagerly — cacheResolveEntry simply returns
  // null for them.
  //
  // Tauri's WebView blocks native window.confirm(), so we route through
  // the in-app ConfirmModal (driven by store.askConfirm). Disable is
  // reversible (toggle back on), so we don't gate it; remove is
  // destructive enough to warrant the prompt.
  const remove = async (addon) => {
    const ok = await useStore.getState().askConfirm({
      title: 'Remove addon?',
      message: `Remove "${addon?.manifest?.display?.label || addon?.manifest?.name || addon.id}"? Any tracks in your library that came from this addon will stop playing on this device until you reinstall it.`,
      confirmLabel: 'Remove',
      cancelLabel: 'Cancel',
    })
    if (!ok) return
    try {
      await registry.remove(addon.id)
      bumpCacheVersion()
      showToast('Addon removed')
    } catch (e) {
      bumpCacheVersion()  // local state was reverted; resync UI
      showToast(`Could not remove: ${e?.message || e}`)
    }
  }

  const toggle = async (addon, enabled) => {
    try {
      await registry.setEnabled(addon.id, enabled)
      bumpCacheVersion()
    } catch (e) {
      bumpCacheVersion()  // local state was reverted; resync UI
      showToast(`Could not ${enabled ? 'enable' : 'disable'}: ${e?.message || e}`)
    }
  }

  // ── Export / Import ─────────────────────────────────────────────────
  // What goes in the file:
  //   * Catalog source URLs — the reproducible way to get back the
  //     same set of addons on a new device (re-add source, one-click
  //     install).
  //   * Manually-installed addons whose URL is reachable from another
  //     device — i.e. NOT http://127.0.0.1:<port> (catalog runtime
  //     binds locally and the port differs per machine, so exporting
  //     that URL would just produce an unreachable entry on import).
  // The file IS a credential — manual addon URLs may carry secrets in
  // their path segment — so we never send it anywhere; download only.
  const fileInputRef = useRef(null)

  const exportAddons = () => {
    const sourceList = catalogSources.list().map(s => ({ url: s.url }))
    const portable = registry.list().filter(a => !isLocalhostUrl(a.url))
    if (sourceList.length === 0 && portable.length === 0) {
      showToast('Nothing to export — no catalog sources or URL-installed addons')
      return
    }
    const blob = new Blob(
      [JSON.stringify({ version: 2, sources: sourceList, addons: portable }, null, 2)],
      { type: 'application/json' },
    )
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const stamp = new Date().toISOString().slice(0, 10)
    a.download = `tunnel-addons-${stamp}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    const parts = []
    if (sourceList.length) parts.push(`${sourceList.length} source${sourceList.length === 1 ? '' : 's'}`)
    if (portable.length) parts.push(`${portable.length} addon${portable.length === 1 ? '' : 's'}`)
    showToast(`Exported ${parts.join(' and ')}`)
  }

  const importAddons = async (file) => {
    if (!file) return
    let parsed
    try {
      const text = await file.text()
      parsed = JSON.parse(text)
    } catch (e) {
      showToast(`Import failed: ${e.message}`)
      return
    }
    // Backwards-compat: v1 was a bare array or `{ addons: [] }`. v2
    // adds a parallel `sources` array.
    const sourceRows = Array.isArray(parsed?.sources) ? parsed.sources : []
    const addonRows = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.addons) ? parsed.addons : []
    if (sourceRows.length === 0 && addonRows.length === 0) {
      showToast('Import failed: not an Audimo addon export')
      return
    }
    let sourcesAdded = 0
    for (const s of sourceRows) {
      if (!s?.url) continue
      try { catalogSources.add(s.url); sourcesAdded++ }
      catch (e) { console.warn('[AddonsView] source import failed:', e?.message || e) }
    }
    // Re-install each by URL so the manifest is freshly fetched and the
    // secret/non-secret split is recomputed against the current schema.
    // The stored `url` only carries the *secrets* segment — non-secret
    // toggles live in `row.settings` — so we merge them back into a
    // single segment before calling install, otherwise the addon's
    // non-secret toggles get reset to their schema defaults on import.
    let addonsOk = 0
    let addonsFailed = 0
    let addonsSkipped = 0
    for (const row of addonRows) {
      if (!row || typeof row.url !== 'string') { addonsFailed++; continue }
      // Catalog-installed addons (localhost URLs) reproduce via the
      // re-added source above — skip silently.
      if (isLocalhostUrl(row.url)) { addonsSkipped++; continue }
      try {
        const [base, secrets] = registry.splitUrlSegment(row.url)
        const merged = { ...(row.settings || {}), ...(secrets || {}) }
        const fullUrl = Object.keys(merged).length === 0
          ? base
          : `${base.replace(/\/+$/, '')}/${registry.b64urlEncode(JSON.stringify(merged))}`
        await registry.install(fullUrl)
        if (row.enabled === false) registry.setEnabled(row.id, false)
        addonsOk++
      } catch (e) {
        console.warn('[AddonsView] import failed for', row.url, e.message)
        addonsFailed++
      }
    }
    bumpCacheVersion()
    const parts = []
    if (sourcesAdded) parts.push(`${sourcesAdded} source${sourcesAdded === 1 ? '' : 's'}`)
    if (addonsOk) parts.push(`${addonsOk} addon${addonsOk === 1 ? '' : 's'}`)
    let msg = parts.length ? `Imported ${parts.join(' and ')}` : 'Nothing to import'
    if (addonsFailed) msg += ` · ${addonsFailed} failed`
    showToast(msg)
  }

  const onImportFile = (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''  // allow re-selecting the same file
    importAddons(file)
  }

  // Render an installed-addon card (used by the Installed list).
  const renderInstalledCard = (addon) => {
    const manifest = addon.manifest || {}
    const name = manifest.name || addon.id
    const description = manifest.description
    const capabilities = manifest.capabilities || []
    const hasSchema = Array.isArray(manifest.settings_schema) && manifest.settings_schema.length > 0
    // Per-addon health from probeAddonHealth (60s poller in this
    // view + on-mount drain). null = not yet checked; true = online;
    // false = offline (with optional ``error`` describing why).
    const health = addonHealth[addon.id]
    const healthState = !addon.enabled
      ? 'disabled'
      : health == null
        ? 'unknown'
        : health.online
          ? 'online'
          : 'offline'
    const healthStyle = {
      disabled: { color: 'var(--fg-mute)', borderColor: 'var(--line)' },
      unknown:  { color: 'var(--fg-mute)', borderColor: 'var(--line)' },
      online:   { color: '#7fc886', borderColor: 'rgba(127, 200, 134, 0.4)' },
      offline:  { color: '#e85d5d', borderColor: 'rgba(232, 93, 93, 0.4)' },
    }[healthState]
    const healthLabel = {
      disabled: 'disabled',
      unknown: 'checking…',
      online: 'online',
      offline: 'offline',
    }[healthState]

    return (
      <div key={addon.id} className={styles.addonCard}>
        <div className={styles.addonRow}>
          <div className={styles.addonInfo}>
            <div className={styles.addonName}>
              {name}
              <span
                title={healthState === 'offline' && health?.error ? `Offline: ${health.error}` : healthLabel}
                style={{
                  marginLeft: 10,
                  padding: '1px 8px',
                  border: `1px solid ${healthStyle.borderColor}`,
                  borderRadius: 4,
                  fontSize: 10,
                  fontWeight: 500,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: healthStyle.color,
                  verticalAlign: 'middle',
                  background: 'transparent',
                }}
              >{healthLabel}</span>
            </div>
            {description && <div className={styles.addonDesc}>{description}</div>}
            <div className={styles.addonMeta}>
              <span className={styles.addonUrl}>{addon.url}</span>
              {capabilities.map(c => (
                <span key={c} className={styles.cap}>{c}</span>
              ))}
            </div>
            {/* "Show in {Music, Audiobooks}" toggles removed —
                addons now declare their surfaces via the manifest's
                capabilities + ui.* sections, so per-surface UI
                checkboxes are redundant. The On/Off button controls
                the whole addon. */}
          </div>
          <div className={styles.addonActions}>
            {hasSchema && (
              <button
                className={styles.settingsBtn}
                type="button"
                title="Configure on the addon"
                onClick={async () => {
                  const u = registry.configureUrl(addon)
                  if (!u) return
                  const ok = await desktop.openExternalUrl(u)
                  if (!ok) {
                    useStore.getState().showToast(`Open this URL to configure: ${u}`)
                  }
                }}
              >
                Configure
              </button>
            )}
            <button
              className={`${styles.toggleBtn} ${addon.enabled ? styles.toggleOn : ''}`}
              onClick={() => toggle(addon, !addon.enabled)}
              title={addon.enabled ? 'Disable' : 'Enable'}
            >
              {addon.enabled ? 'On' : 'Off'}
            </button>
            <button className={styles.removeBtn} onClick={() => remove(addon)} title="Remove">✕</button>
          </div>
        </div>
      </div>
    )
  }

  // Aggregate catalog count for the Discover tab badge.
  const catalogCount = (() => {
    const ids = new Set()
    for (const s of sources) {
      const list = sourceData[s.id]?.catalog?.addons
      if (Array.isArray(list)) for (const e of list) if (e?.id) ids.add(e.id)
    }
    return ids.size
  })()
  const enabledCount = addons.filter(a => a.enabled).length

  return (
    <div className={styles.wrap}>
      <header className={styles.pageHead}>
        <div className={styles.statLine}>
          {enabledCount} of {addons.length} {addons.length === 1 ? 'addon' : 'addons'} running
        </div>
        <h1 className={styles.title}>Addons</h1>
        <p className={styles.lede}>
          Audimo plays your local files and searches built-in catalogs out of
          the box. To reach beyond that — extra search sources, lyrics,
          scrobbling, niche libraries — install an addon. You pick which ones.
        </p>
      </header>

      {offlineAddons.length > 0 && (
        <div
          role="status"
          aria-live="polite"
          style={{
            margin: '0 0 16px',
            padding: '10px 14px',
            border: '1px solid rgba(232, 93, 93, 0.4)',
            background: 'rgba(232, 93, 93, 0.08)',
            color: 'var(--fg)',
            borderRadius: 6,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: 13,
            gap: 12,
          }}
        >
          <span>
            {offlineAddons.length === 1 ? (
              <>
                <strong>{offlineAddons[0].manifest?.name || offlineAddons[0].id}</strong>
                {' '}is offline.
                {' '}Results from this addon won't appear until it's back.
              </>
            ) : (
              <>
                <strong>{offlineAddons.length} addons</strong> are offline:
                {' '}{offlineAddons.map(a => a.manifest?.name || a.id).join(', ')}.
              </>
            )}
          </span>
          <button
            type="button"
            onClick={() => probeAddonHealth()}
            style={{
              background: 'transparent',
              border: '1px solid var(--line)',
              color: 'inherit',
              padding: '6px 12px',
              borderRadius: 4,
              cursor: 'pointer',
              font: 'inherit',
            }}
          >Retry</button>
        </div>
      )}

      <nav className={styles.tabBar}>
        <button
          type="button"
          className={`${styles.tab} ${tab === 'installed' ? styles.tabActive : ''}`}
          onClick={() => setTab('installed')}
        >Installed <span className={styles.tabCount}>{addons.length}</span></button>
        {/* Discover used to be desktop-only because addon binaries
            install to a machine-specific 127.0.0.1:<port>. The tab
            still browses the catalog over the network on a phone —
            installation actions show a "continue on desktop" hint
            inside the panel instead of hiding the whole list. */}
        <button
          type="button"
          className={`${styles.tab} ${tab === 'discover' ? styles.tabActive : ''}`}
          onClick={() => setTab('discover')}
        >Discover {catalogCount > 0 && <span className={styles.tabCount}>{catalogCount}</span>}</button>
        <button
          type="button"
          className={`${styles.tab} ${tab === 'developer' ? styles.tabActive : ''}`}
          onClick={() => setTab('developer')}
        >For developers</button>
      </nav>

      {/* ── INSTALLED ── */}
      {tab === 'installed' && (
      <div className={styles.installBox}>
        <section className={styles.installByUrlBox}>
          <div className={styles.installByUrlLabel}>Install by URL</div>
          <p className={styles.installByUrlHint}>
            Paste a URL to an addon you host yourself or got directly from someone.
          </p>
          <div className={styles.installRow}>
            <input
              className={styles.input}
              type="url"
              inputMode="url"
              enterKeyHint="go"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={url}
              onChange={e => setUrl(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && install()}
              placeholder="https://addon.example.com/your-config-hash"
            />
            <button className={styles.installBtn} onClick={install} disabled={installing || !url.trim()}>
              {installing ? 'Installing…' : 'Install'}
            </button>
          </div>
          {error && <div className={styles.error}>{error}</div>}
        </section>

        <div className={styles.list} style={{ marginTop: 8 }}>
          {addons.length === 0 ? (
            <div className={styles.empty}>
              {isDesktopApp
                ? 'Nothing installed yet. Open the Discover tab or paste a URL above.'
                : 'Nothing installed yet. Paste a URL above to install.'}
            </div>
          ) : (
            addons.map(renderInstalledCard)
          )}
        </div>
      </div>
      )}

      {/* ── BROWSE CATALOG ── */}
      {tab === 'discover' && (
        <div className={styles.installBox}>
          <label className={styles.label}>Browse Catalog</label>
          <p className={styles.subtitle} style={{ marginTop: 0 }}>
            One-click install. Audimo downloads the addon binary, runs it locally, and registers it.
          </p>
          {!isDesktopApp && (
            <p className={styles.subtitle} style={{ marginTop: 4, color: 'var(--gold)' }}>
              Browsing on phone — installation needs the desktop app. Open this catalog there to install.
            </p>
          )}

          {/* Add source — always visible. */}
          <p className={styles.subtitle} style={{ margin: '8px 0 4px' }}>
            A source is a URL to a JSON catalog of addons (like apt repos).
            Adding one means trusting its author — binaries are SHA256-verified,
            but the catalog itself is whatever the source serves.
          </p>
          <div className={styles.installRow}>
            <input
              className={styles.input}
              type="url"
              inputMode="url"
              enterKeyHint="go"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={newSourceUrl}
              onChange={e => setNewSourceUrl(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addSource()}
              placeholder="Add catalog source URL (e.g. https://…/catalog.json)"
            />
            <button
              className={styles.installBtn}
              onClick={addSource}
              disabled={addingSource || !newSourceUrl.trim()}
            >
              {addingSource ? 'Adding…' : 'Add Source'}
            </button>
          </div>
          {sourceError && <div className={styles.error}>{sourceError}</div>}

          {/* Existing sources — list collapsed behind a disclosure once
              there's at least one, so the surface stays calm. */}
          {sources.length > 0 && (
            <>
              <button
                type="button"
                className={styles.disclosureBtn}
                onClick={() => setSourcesOpen(o => !o)}
              >
                <span className={`${styles.disclosureCaret}${sourcesOpen ? ' ' + styles.disclosureCaretOpen : ''}`}>▸</span>
                <span>{sources.length} source{sources.length === 1 ? '' : 's'} added</span>
              </button>
              {sourcesOpen && (
                <div className={styles.disclosureBody}>
                  <div className={styles.list}>
                    {sources.map(s => {
                      const data = sourceData[s.id] || {}
                      const label = s.name || data.catalog?.name || s.url
                      return (
                        <div key={s.id} className={styles.addonCard}>
                          <div className={styles.addonRow}>
                            <div className={styles.addonInfo}>
                              <div className={styles.addonName}>{label}</div>
                              <div className={styles.addonMeta}>
                                <span className={styles.addonUrl}>{s.url}</span>
                                {data.loading && <span className={styles.cap}>fetching…</span>}
                                {data.catalog && (
                                  <span className={styles.cap}>
                                    {Array.isArray(data.catalog.addons) ? data.catalog.addons.length : 0} addons
                                  </span>
                                )}
                                {data.error && (
                                  <span className={styles.cap} style={{ color: '#f77' }}>
                                    error: {data.error}
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className={styles.addonActions}>
                              <button
                                className={styles.toggleBtn}
                                onClick={() => refreshSource(s)}
                                disabled={data.loading}
                                title="Re-fetch this source"
                              >
                                Refresh
                              </button>
                              <button
                                className={styles.removeBtn}
                                onClick={() => removeSource(s)}
                                title="Remove source (does not uninstall already-installed addons)"
                              >
                                ✕
                              </button>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </>
          )}

          {sources.length === 0 ? (
            <div className={styles.empty}>
              Add a catalog source above to discover addons.
            </div>
          ) : (
          <>
          {(() => {
            const sourceLabelFor = (s) => {
              const data = sourceData[s.id]
              return s.name || data?.catalog?.name ||
                (() => { try { return new URL(s.url).hostname } catch { return s.url } })()
            }
            const sourcesWithAddons = sources.filter(s => {
              const list = sourceData[s.id]?.catalog?.addons
              return Array.isArray(list) && list.length > 0
            })
            const showFilters = sourcesWithAddons.length > 1
            return (
              <>
                <div className={styles.installRow} style={{ marginTop: 4 }}>
                  <input
                    className={styles.input}
                    value={catalogQuery}
                    onChange={e => setCatalogQuery(e.target.value)}
                    placeholder="Search catalog…"
                  />
                </div>
                {showFilters && (
                  <div className={styles.filterChips}>
                    <button
                      className={`${styles.chip}${catalogSourceFilter === '' ? ` ${styles.chipActive}` : ''}`}
                      onClick={() => setCatalogSourceFilter('')}
                    >
                      All
                    </button>
                    {sourcesWithAddons.map(s => (
                      <button
                        key={s.id}
                        className={`${styles.chip}${catalogSourceFilter === s.id ? ` ${styles.chipActive}` : ''}`}
                        onClick={() => setCatalogSourceFilter(s.id)}
                      >
                        {sourceLabelFor(s)}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )
          })()}
          <div className={styles.list} style={{ marginTop: 8 }}>
            {(() => {
              // Aggregate every successfully-fetched source's addons,
              // tagged with the source label so users can tell where
              // each card came from. De-dupe by addon id, preferring
              // the first source the user added (oldest addedAt).
              const ordered = [...sources].sort(
                (a, b) => (a.addedAt || 0) - (b.addedAt || 0)
              )
              const seen = new Set()
              const rows = []
              for (const s of ordered) {
                if (catalogSourceFilter && s.id !== catalogSourceFilter) continue
                const data = sourceData[s.id]
                const list = Array.isArray(data?.catalog?.addons)
                  ? data.catalog.addons : []
                const sourceLabel = s.name || data?.catalog?.name ||
                  (() => { try { return new URL(s.url).hostname } catch { return s.url } })()
                for (const entry of list) {
                  if (!entry?.id || seen.has(entry.id)) continue
                  seen.add(entry.id)
                  rows.push({ entry, sourceLabel })
                }
              }
              const q = catalogQuery.trim().toLowerCase()
              const filtered = q
                ? rows.filter(({ entry }) => {
                    const hay = [entry.name, entry.description, entry.id, entry.author]
                      .filter(Boolean).join(' ').toLowerCase()
                    return hay.includes(q)
                  })
                : rows
              if (rows.length === 0) {
                return (
                  <div className={styles.empty}>
                    No addons available yet — sources may still be fetching.
                  </div>
                )
              }
              if (filtered.length === 0) {
                return (
                  <div className={styles.empty}>
                    No addons match your search.
                  </div>
                )
              }
              return filtered.map(({ entry, sourceLabel }) => {
                const installed = managedAddons.find(m => m.id === entry.id)
                const isBusy = busyId === entry.id
                const progress = installProgress[entry.id]
                return (
                  <div key={entry.id} className={styles.addonCard}>
                    <div className={styles.addonRow}>
                      <div className={styles.addonInfo}>
                        <div className={styles.addonName}>{entry.name}</div>
                        {entry.description && (
                          <div className={styles.addonDesc}>{entry.description}</div>
                        )}
                        <div className={styles.addonMeta}>
                          {installed ? (
                            <>
                              <span className={styles.cap}>installed</span>
                              <span className={styles.cap}>v{installed.version}</span>
                              {installed.url && (
                                <span className={styles.addonUrl}>{installed.url}</span>
                              )}
                            </>
                          ) : (
                            <span className={styles.addonUrl}>via {sourceLabel}</span>
                          )}
                        </div>
                      </div>
                      <div className={styles.addonActions}>
                        {installed ? (
                          <button
                            className={styles.removeBtn}
                            onClick={() => uninstallFromCatalog(entry)}
                            disabled={isBusy}
                            title="Uninstall"
                          >
                            {isBusy ? '…' : 'Uninstall'}
                          </button>
                        ) : (
                          <button
                            className={styles.installBtn}
                            onClick={() => installFromCatalog(entry)}
                            disabled={isBusy}
                          >
                            {isBusy ? 'Installing…' : 'Install'}
                          </button>
                        )}
                      </div>
                    </div>
                    {isBusy && (
                      <div className={styles.installProgressWrap}>
                        <div className={styles.installProgressBar}>
                          <div
                            className={`${styles.installProgressFill}${progress == null ? ` ${styles.installProgressIndeterminate}` : ''}`}
                            style={progress != null ? { width: `${progress.pct}%` } : undefined}
                          />
                        </div>
                        {progress?.message && (
                          <div className={styles.installProgressMsg}>{progress.message}</div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })
            })()}
          </div>
          </>
          )}
        </div>
      )}

      {/* ── EXPORT/IMPORT — small disclosure under Installed and
            Discover tabs so the IO escape hatch stays reachable. ── */}
      {(tab === 'installed' || tab === 'discover') && (
        <div className={styles.advancedBox}>
          <button
            type="button"
            className={styles.advancedToggle}
            onClick={() => setAdvancedOpen(o => !o)}
          >
            <span className={`${styles.disclosureCaret}${advancedOpen ? ' ' + styles.disclosureCaretOpen : ''}`}>▸</span>
            Advanced
          </button>
          {advancedOpen && (
            <div className={styles.advancedBody}>
              <section className={styles.advancedSection}>
                <div className={styles.advancedSectionTitle}>Export / Import</div>
                <p className={styles.subtitle} style={{ margin: '0 0 8px' }}>
                  Save your catalog sources and any URL-installed addons to a file
                  you can re-import on another device. Catalog-installed addons
                  reproduce automatically when you re-add the source.
                </p>
                <div className={styles.ioRow}>
                  <button className={styles.ioBtn} onClick={exportAddons} title="Download a JSON file of catalog sources and URL-installed addons.">
                    Export
                  </button>
                  <button className={styles.ioBtn} onClick={() => fileInputRef.current?.click()} title="Import sources and addons from a previously-exported JSON file.">
                    Import
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="application/json,.json"
                    style={{ display: 'none' }}
                    onChange={onImportFile}
                  />
                  <span className={styles.ioHint}>
                    Export contains addon secrets — keep the file private.
                  </span>
                </div>
              </section>
            </div>
          )}
        </div>
      )}

      {/* ── FOR DEVELOPERS — addon SDK reference. ── */}
      {tab === 'developer' && (
        <div className={styles.devBox}>
          <div className={styles.devCard}>
            <div className={styles.statLine}>Build your own</div>
            <h2 className={styles.devTitle}>Audimo Addon SDK</h2>
            <p className={styles.docsText}>
              An addon is an HTTP server that implements the Audimo addon
              protocol. Serve a <code>GET /manifest.json</code> declaring your{' '}
              <code>id</code>, <code>name</code>, <code>version</code>, and{' '}
              <code>capabilities</code> array — Audimo only routes requests to
              endpoints whose capability you advertise. Addons must respond
              with <code>Access-Control-Allow-Origin: *</code> (or echo the
              Audimo origin) and answer the CORS{' '}
              <code>OPTIONS</code> preflight, since this device calls them
              directly from the browser.
            </p>

            <div className={styles.devSectionLabel}>Endpoint ↔ capability map</div>
            <div className={styles.devEndpointGrid}>
              <code className={styles.devEndpoint}>POST /resolve/sources</code>
              <span className={styles.devEndpointDesc}>
                <code>resolve.sources</code> · playable source candidates for a track
              </span>
              <code className={styles.devEndpoint}>POST /resolve/sources/stream</code>
              <span className={styles.devEndpointDesc}>
                <code>resolve.sources.stream</code> · SSE variant — fast indexers render before slow ones
              </span>
              <code className={styles.devEndpoint}>POST /resolve/stream</code>
              <span className={styles.devEndpointDesc}>
                <code>resolve.stream</code> · downloads/transcodes a chosen source, emits progress + final streamUrl
              </span>
              <code className={styles.devEndpoint}>POST /cache/resolve</code>
              <span className={styles.devEndpointDesc}>
                <code>cache.resolve</code> · re-resolves a stored library entry to a fresh stream URL
              </span>
              <code className={styles.devEndpoint}>POST /search/books</code>
              <span className={styles.devEndpointDesc}>
                <code>search.books</code> · audiobook discovery (audio still flows through <code>resolve.sources</code>)
              </span>
              <code className={styles.devEndpoint}>GET /ui/home</code>
              <span className={styles.devEndpointDesc}>
                <code>ui.home</code> · shelves on the Today screen
              </span>
              <code className={styles.devEndpoint}>POST /ui/search</code>
              <span className={styles.devEndpointDesc}>
                <code>ui.search</code> · chip in unified search
              </span>
              <code className={styles.devEndpoint}>GET /ui/catalog</code>
              <span className={styles.devEndpointDesc}>
                <code>ui.tab</code> · dedicated tab in the main nav
              </span>
            </div>

            <div className={styles.devSectionLabel}>Configure flow</div>
            <p className={styles.docsText}>
              To make settings configurable, expose <code>GET /configure</code> as
              a page the user opens from the Configure button on the addon row.
              When the user submits, build the new install URL (typically{' '}
              <code>{'<base>/<base64url-json-config>'}</code>) and send it back via{' '}
              <code>window.opener.postMessage</code> with shape{' '}
              <code>{`{ type: "tunnel-addon:install", addonId, url }`}</code>.
              The host accepts the message only when <code>addonId</code>{' '}
              matches an already-installed addon and <code>e.origin</code>{' '}
              matches that addon's origin — so postMessage is for{' '}
              <em>reconfiguring</em>, not first install (paste the URL via Discover for that).
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
