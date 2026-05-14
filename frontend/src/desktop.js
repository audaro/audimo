// Bridge between the React app and the Tauri shell.
//
// The same Vite bundle runs in three contexts:
//   1. **Tauri webview** — `window.__TAURI_INTERNALS__` is present and
//      `invoke()` reaches the Rust commands defined in src-tauri.
//   2. **Phone browser** — connected to the desktop's backend over
//      Tailscale or LAN. No Tauri APIs available.
//   3. **Plain `npm run dev`** — also no Tauri.
//
// Every helper here gracefully degrades when not running under Tauri:
// `getState()` returns a "first run already complete" stub so the
// phone client and the legacy web build skip onboarding entirely. The
// onboarding flow is desktop-only — phones don't generate API keys,
// they consume one.

let invokeFn = null

// Evaluated lazily. Tauri 2's WebView injects `__TAURI_INTERNALS__`
// asynchronously — sometimes after this module has already finished
// evaluating. Capturing it once at import time leaves the answer
// permanently false in those races, which silently breaks anything
// gated on it (e.g. apiKey seeding from the desktop sidecar).
//
// `isDesktop` is now a function. The previous boolean export is
// removed so missed call sites fail loudly rather than silently
// producing the wrong answer.
export const isDesktop = () => typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__

async function getInvoke() {
  if (invokeFn) return invokeFn
  if (!isDesktop()) return null
  // Lazy import — this module is tree-shaken out of the phone-browser
  // bundle's evaluated graph because `isDesktop` short-circuits before
  // we ever call this.
  const mod = await import('@tauri-apps/api/core')
  invokeFn = mod.invoke
  return invokeFn
}

async function call(cmd, args) {
  const invoke = await getInvoke()
  if (!invoke) throw new Error('not running under Tauri')
  return invoke(cmd, args)
}

// ── State ────────────────────────────────────────────────────────

const NON_DESKTOP_STATE = Object.freeze({
  first_run_complete: true,
  remote_enabled: false,
  has_api_key: false,
  backend_port: 8000,
})

export async function getState() {
  if (!isDesktop()) return NON_DESKTOP_STATE
  return call('audimo_get_state')
}

export async function setFirstRunComplete() {
  if (!isDesktop()) return
  return call('audimo_set_first_run_complete')
}

// ── Remote / phone access ───────────────────────────────────────

/**
 * Enable or disable remote (phone) access.
 * When enabling, the shell ensures an API key exists in the keychain
 * and respawns the backend with `AUDIMO_API_KEY` + `0.0.0.0` binding.
 * Returns the API key (string) on enable, `null` on disable.
 */
export async function setRemoteEnabled(enabled) {
  if (!isDesktop()) throw new Error('remote-access toggle is desktop-only')
  return call('audimo_set_remote_enabled', { enabled })
}

export async function getApiKey() {
  if (!isDesktop()) return null
  return call('audimo_get_api_key')
}

/**
 * Return the install's API key, minting one if the install hasn't
 * booted before. The backend has no keyless mode any more — every
 * fetch requires `X-API-Key`, so the WebView must obtain a key
 * before any `authFetch` call.
 *
 * Returns the key string in Tauri, `null` in non-desktop contexts
 * (phone browsers use the pair-redeem flow to acquire their key).
 */
export async function ensureApiKey() {
  if (!isDesktop()) return null
  return call('audimo_ensure_api_key')
}

const _PRIVACY_STUB = Object.freeze({
  privacy_no_streaming: false,
  privacy_no_dht: false,
  privacy_no_lsd: false,
  privacy_no_pex: false,
})
export async function getPrivacy() {
  if (!isDesktop()) return { ..._PRIVACY_STUB }
  return call('audimo_get_privacy')
}
export async function setPrivacy(prefs) {
  if (!isDesktop()) throw new Error('privacy settings are desktop-only')
  return call('audimo_set_privacy', { privacy: prefs })
}

export async function regenerateApiKey() {
  if (!isDesktop()) throw new Error('regenerate is desktop-only')
  return call('audimo_regenerate_api_key')
}

export async function getNetworkInfo() {
  if (!isDesktop()) {
    return { tailscale_ip: null, tailscale_hostname: null, lan_ips: [], backend_port: 8000 }
  }
  return call('audimo_get_network_info')
}

/**
 * Open an http(s) URL in the user's default external browser.
 *
 * Tauri's WebView blocks window.open() in production, so the Configure
 * button (and any future "open external link" affordance) needs to
 * shell out via the Rust command. Falls through to window.open() in
 * non-desktop contexts (phone browser, plain web dev) where the
 * regular browser handles new tabs natively.
 */
export async function openExternalUrl(url) {
  if (!url) return false
  if (!isDesktop()) {
    const w = window.open(url, '_blank', 'noopener')
    return !!w
  }
  try {
    await call('audimo_open_external_url', { url })
    return true
  } catch (e) {
    console.warn('[desktop] openExternalUrl failed:', e?.message || e)
    return false
  }
}

// ── URL builders ────────────────────────────────────────────────

// ── Catalog-managed addons ──────────────────────────────────────
//
// One-click install for community addons via the Tauri sidecar
// runtime. Catalog fetch / install / uninstall / list go through
// the Rust commands in addon_sidecars.rs.
//
// In non-desktop contexts (phone browser, plain web dev) the catalog
// flow is unavailable — the manual install URL field stays as the
// only path. Helpers throw a descriptive error so the UI can surface
// "this is desktop-only" without silently no-oping.

export async function addonCatalogFetch(catalogUrl) {
  if (!isDesktop()) throw new Error('catalog requires the desktop app')
  return call('audimo_addon_catalog_fetch', { catalogUrl })
}

// Subscribe to install progress events emitted by the Rust sidecar
// runtime during binary download. Returns an unlisten function.
// handler receives { id, pct, message }.
export async function listenAddonInstallProgress(handler) {
  if (!isDesktop()) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  return listen('audimo:addon-install-progress', (ev) => handler(ev.payload))
}

export async function addonInstall(manifestUrl) {
  if (!isDesktop()) throw new Error('catalog install requires the desktop app')
  return call('audimo_addon_install', { manifestUrl })
}

export async function addonUninstall(id) {
  if (!isDesktop()) throw new Error('catalog uninstall requires the desktop app')
  return call('audimo_addon_uninstall', { id })
}

export async function addonList() {
  if (!isDesktop()) return []
  return call('audimo_addon_list')
}

export async function addonRestart(id) {
  if (!isDesktop()) throw new Error('addon restart requires the desktop app')
  return call('audimo_addon_restart', { id })
}

/**
 * Format a "phone access" URL for the user to type / scan / share
 * onto a phone. Prefers Tailscale MagicDNS hostname > Tailscale IP >
 * LAN IPv4. Returns `null` if nothing usable.
 */
export function pickPhoneUrl(networkInfo) {
  const port = networkInfo?.backend_port || 8000
  const host =
    networkInfo?.tailscale_hostname ||
    networkInfo?.tailscale_ip ||
    (networkInfo?.lan_ips && networkInfo.lan_ips[0])
  if (!host) return null
  return `http://${host}:${port}`
}
