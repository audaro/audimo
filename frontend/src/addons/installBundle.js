// Bundle install — multi-addon install flow driven by audimo-aio.
//
// The hosted audimo-aio configure page emits a bundle JSON shaped:
//
//   { version: 1,
//     addons: [
//       { manifest_url?, url?, name, id?, credentials: {…} },
//       ...
//     ],
//     aggregator_settings: { filters_json, sort_json, merge_sources } }
//
// Two shapes per entry:
//
//   • `manifest_url` — the addon hasn't been installed yet on this
//     device. We hand the URL to the catalog runtime
//     (`desktop.addonInstall`), which downloads the binary,
//     SHA-verifies it, drops it on disk, and spawns it as a sidecar.
//     The runtime returns the spawned `http://127.0.0.1:<port>` URL.
//     This is the path that lets a fresh user "configure on the web,
//     paste the URL into Audimo, and have everything install" without
//     needing any addon servers running locally first. Mirrors how
//     the catalog one-click install works elsewhere in AddonsView.
//
//   • `url` — the addon is already running somewhere reachable. We
//     skip the catalog runtime and use the URL as-is. Power-user
//     path; required-running-server is the trade-off.
//
// `credentials` is a dict of cfg keys (e.g. rd_api_key) the user
// entered in the AIO Services section AND the marketplace entry
// declared as supported. We bake those into the addon URL via a
// base64url-encoded JSON config segment AFTER the catalog runtime
// returns the spawned URL — the addon ends up authenticated when
// `registry.install()` registers it.
//
// `aggregator_settings` is metadata for whatever local meta-addon /
// source-aggregation logic wants it; this module surfaces it back to
// the caller and doesn't dictate where it gets applied.
//
// The actual user-confirm-then-install UX lives in
// BundleInstallListener.jsx — this module is the pure logic so it's
// importable and testable without a DOM.

import * as registry from './registry'
import { b64urlEncode } from './registry'
import * as desktop from '../desktop'

/**
 * Fetch and validate a bundle JSON.
 * @param {string} url
 * @returns {Promise<{version: number, addons: Array<{url: string, name?: string}>, aggregator_settings: object}>}
 */
export async function fetchBundle(url) {
  if (!url || typeof url !== 'string') {
    throw new Error('bundle url required')
  }
  let resp
  try {
    resp = await fetch(url, { method: 'GET' })
  } catch (e) {
    throw new Error(`Could not reach bundle URL: ${e?.message || e}`)
  }
  if (!resp.ok) {
    throw new Error(`Bundle fetch failed (HTTP ${resp.status})`)
  }
  let body
  try {
    body = await resp.json()
  } catch (e) {
    throw new Error(`Bundle response was not JSON: ${e?.message || e}`)
  }
  if (!body || typeof body !== 'object') {
    throw new Error('Bundle response was not an object')
  }
  if (!Array.isArray(body.addons)) {
    throw new Error("Bundle missing 'addons' array")
  }
  // Filter out malformed entries (need at least a manifest_url or a
  // url) and normalise so the install loop can read either shape
  // without re-validating.
  const addons = body.addons
    .filter(a => a && (
      (typeof a.manifest_url === 'string' && a.manifest_url.trim()) ||
      (typeof a.url === 'string' && a.url.trim())
    ))
    .map(a => ({
      manifest_url: typeof a.manifest_url === 'string' ? a.manifest_url.trim() : '',
      url:          typeof a.url          === 'string' ? a.url.trim()          : '',
      name:         typeof a.name         === 'string' ? a.name                : '',
      id:           typeof a.id           === 'string' ? a.id                  : '',
      credentials:  (a.credentials && typeof a.credentials === 'object' && !Array.isArray(a.credentials))
                      ? a.credentials
                      : {},
    }))
  return {
    version: body.version || 1,
    addons,
    aggregator_settings: (body.aggregator_settings && typeof body.aggregator_settings === 'object')
      ? body.aggregator_settings
      : {},
  }
}


// Append a base64url-encoded JSON config segment to a running addon
// URL. Used after the catalog runtime spawns the addon — credentials
// from the bundle get baked into the URL config segment so the
// addon-side `_config_from` picks them up like any other path-baked
// install URL would.
function bakeCredentials(url, creds) {
  if (!url) return url
  if (!creds || typeof creds !== 'object') return url
  const keys = Object.keys(creds).filter(k => {
    const v = creds[k]
    return typeof v === 'string' ? v.trim().length > 0 : v != null
  })
  if (keys.length === 0) return url
  const payload = {}
  for (const k of keys) payload[k] = creds[k]
  const seg = b64urlEncode(JSON.stringify(payload))
  return url.replace(/\/+$/, '') + '/' + seg
}

/**
 * Install every addon in a bundle. Failures are collected, not
 * thrown — partial success is the common case (one addon's
 * download fails but the others install fine).
 *
 * For entries with `manifest_url`, the catalog runtime
 * (`desktop.addonInstall`) downloads the binary, SHA-verifies it,
 * and spawns it. We then bake the entry's `credentials` into the
 * spawned URL's config segment and call `registry.install`. For
 * entries with only `url`, we bake creds + register directly.
 *
 * @param {{addons: Array<{manifest_url?: string, url?: string, name?: string, id?: string, credentials?: object}>, aggregator_settings: object}} bundle
 * @param {{onProgress?: (entry: object) => void, deps?: object}} [opts] — `deps` lets tests inject mocks for `desktop.addonInstall` / `registry.install`
 * @returns {Promise<{installed: Array, failed: Array, aggregator_settings: object}>}
 */
export async function applyBundle(bundle, opts = {}) {
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {}
  const deps = opts.deps || {}
  const addonInstall = deps.addonInstall || desktop.addonInstall
  const isDesktop = typeof deps.isDesktop === 'function' ? deps.isDesktop : desktop.isDesktop
  const registryInstall = deps.registryInstall || registry.install
  const installed = []
  const failed = []
  for (const a of bundle.addons || []) {
    const label = a.name || a.id || a.manifest_url || a.url || 'addon'
    try {
      // Resolve to a runnable URL: catalog runtime first if
      // manifest_url is present (and we're in the desktop shell),
      // else fall back to the legacy already-running URL.
      let runnableUrl
      if (a.manifest_url && isDesktop()) {
        const status = await addonInstall(a.manifest_url)
        if (!status || !status.url) {
          throw new Error('catalog runtime returned no URL')
        }
        runnableUrl = status.url
      } else if (a.url) {
        runnableUrl = a.url
      } else if (a.manifest_url) {
        throw new Error('manifest_url install requires the desktop app')
      } else {
        throw new Error('no manifest_url or url')
      }
      const finalUrl = bakeCredentials(runnableUrl, a.credentials)
      await registryInstall(finalUrl)
      const entry = {
        manifest_url: a.manifest_url || '', url: finalUrl,
        name: a.name || '', id: a.id || '',
        status: 'installed',
      }
      installed.push(entry)
      onProgress(entry)
    } catch (e) {
      const entry = {
        manifest_url: a.manifest_url || '', url: a.url || '',
        name: a.name || '', id: a.id || '',
        status: 'failed',
        error: e?.message || String(e),
      }
      failed.push(entry)
      onProgress(entry)
    }
  }
  return {
    installed,
    failed,
    aggregator_settings: bundle.aggregator_settings || {},
  }
}

/**
 * Convenience: parse `audimo://install-bundle?url=...` and return
 * the bundle URL. Returns null if the deep link isn't a bundle
 * install or is malformed.
 */
export function bundleUrlFromDeepLink(deepLink) {
  if (!deepLink || typeof deepLink !== 'string') return null
  // We accept any audimo:// path that supplies ?url= — keeps the
  // wire format flexible if we add more bundle-action verbs later.
  if (!deepLink.toLowerCase().startsWith('audimo://')) return null
  let parsed
  try {
    parsed = new URL(deepLink)
  } catch {
    return null
  }
  // URL parser lowercases the host but leaves the path; we only
  // care about install-bundle today.
  const host = (parsed.hostname || parsed.host || '').toLowerCase()
  if (host !== 'install-bundle') return null
  const u = parsed.searchParams.get('url')
  return u && u.trim() ? u.trim() : null
}
