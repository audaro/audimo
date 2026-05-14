// Top-level listener for "install bundle" requests.
//
// Two trigger paths feed this component:
//
//   1. audimo:// deep link  →  the desktop shell (src-tauri) catches
//      `audimo://install-bundle?url=...` and emits an
//      `audimo://deep-link` Tauri event. Active in Tauri only.
//
//   2. window.opener postMessage from a hosted audimo-aio configure
//      page →  shape `{ type: 'tunnel-addon:install', bundleUrl }`.
//      Active in any browser (covers the case where the user opened
//      configure in a new tab from inside the app webview).
//
// Both paths converge on the same flow: fetch the bundle, ask the
// user to confirm (showing the count, source, and addon list), then
// run the multi-install through `applyBundle`. Successes and
// failures land in a single toast per run.
//
// Confirmation is mandatory — anything that arrives via a custom
// URL scheme or a postMessage could be malicious. The dialog shows
// the originating host so the user can recognise the source.

import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import { isDesktop } from '../desktop'
import {
  fetchBundle,
  applyBundle,
  bundleUrlFromDeepLink,
} from '../addons/installBundle'
import * as aggregatorSettings from '../addons/aggregatorSettings'

function originOf(url) {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

// Trusted origins for the `tunnel-addon:install` postMessage path.
// The only out-of-the-box flow that should ever fire one of these is
// the user's own audimo-aio configure page running on a known
// localhost/Tauri origin. Any other origin is a drive-by site trying
// to coax the user into installing an addon (possibly with attacker
// credentials baked in — see the comment on `bakeCredentials` in
// installBundle.js). Such origins are still RUNNABLE but only after a
// stronger warning in the confirm dialog. Pure-block would be safer;
// we leave a path because users may host their own configure page on
// a custom domain.
const _LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
function isTrustedBundleOrigin(origin) {
  if (!origin) return false
  let u
  try { u = new URL(origin) } catch { return false }
  if (u.protocol === 'tauri:' || u.protocol === 'app:') return true
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  return _LOOPBACK_HOSTS.has(u.hostname.toLowerCase())
}

// Summarise the credentials a bundle is about to bake into addon URLs
// so the confirm dialog can show what gets shared. We only show keys
// (e.g. `rd_api_key`, `slskd_password`) — never the values — both to
// avoid shoulder-surfing leaks and because a drive-by attacker would
// inject keys here as the smuggling vector.
function _summariseCredentials(bundle) {
  const lines = []
  for (const a of bundle.addons || []) {
    const keys = Object.keys(a.credentials || {}).filter(k => {
      const v = a.credentials[k]
      return typeof v === 'string' ? v.trim() : v != null
    })
    if (keys.length === 0) continue
    const label = a.name || a.id || a.url || a.manifest_url || 'addon'
    lines.push(`• ${label}: ${keys.join(', ')}`)
  }
  return lines
}

export default function BundleInstallListener() {
  const askConfirm = useStore(s => s.askConfirm)
  const showToast = useStore(s => s.showToast)
  const loadAddons = useStore(s => s.loadAddons)

  // Single-flight guard: ignore subsequent triggers while one is
  // already in the confirm-and-install pipeline. Otherwise a
  // double-clicked browser link or two stacked postMessages would
  // race two confirm dialogs and possibly install the same set
  // twice.
  const inFlightRef = useRef(false)

  async function runBundle(bundleUrl, sourceLabel, { trusted = true } = {}) {
    if (inFlightRef.current) return
    if (!bundleUrl) return
    inFlightRef.current = true
    try {
      let bundle
      try {
        bundle = await fetchBundle(bundleUrl)
      } catch (e) {
        showToast(`Bundle fetch failed: ${e?.message || e}`, 5000)
        return
      }
      const count = bundle.addons.length
      if (count === 0) {
        showToast('Bundle was empty — nothing to install', 4000)
        return
      }
      // Dialog body lists each addon URL so the user can spot anything
      // unexpected. Truncated past 8 entries to keep the modal
      // pleasant; we still install everything.
      const sample = bundle.addons.slice(0, 8).map(a => `• ${a.name || a.url}`).join('\n')
      const more = count > 8 ? `\n…and ${count - 8} more` : ''
      // Credential surfacing: a hostile configure page can bake the
      // attacker's RD/slskd creds into the bundle so every torrent
      // the user later plays runs against the attacker's debrid bill.
      // Surface the credential keys (never the values) so the user
      // can spot smuggled credentials before confirming.
      const credLines = _summariseCredentials(bundle)
      const credBlock = credLines.length
        ? `\n\nCredentials this bundle will set:\n${credLines.slice(0, 6).join('\n')}` +
          (credLines.length > 6 ? `\n…and ${credLines.length - 6} more` : '')
        : ''
      const trustWarning = trusted
        ? ''
        : '\n\n⚠ This came from an origin Audimo doesn\'t recognise. ' +
          'Only continue if you trust the page you just visited.'
      const ok = await askConfirm({
        title: `Install ${count} addon${count === 1 ? '' : 's'}?`,
        message: `From ${sourceLabel}\n\n${sample}${more}${credBlock}${trustWarning}`,
        confirmLabel: count === 1 ? 'Install' : `Install ${count}`,
        cancelLabel: 'Cancel',
      })
      if (!ok) return

      const { installed, failed } = await applyBundle(bundle)
      // Persist the aggregator-level filter/sort prefs so they
      // outlive this install run. Today nothing reads them yet
      // (the source-aggregation pipeline still uses its hardcoded
      // sort); a follow-up commit ports audimo-aio's v2 pipeline to
      // JS and wires it into resolve.js. Storing now means the
      // user's choices on the configure page aren't silently
      // dropped between then and now.
      aggregatorSettings.set(bundle.aggregator_settings)
      // Reload the in-memory addon list so the UI reflects new
      // installs without a page refresh.
      try { await loadAddons() } catch { /* fail-soft */ }

      if (failed.length === 0) {
        showToast(
          `Installed ${installed.length} addon${installed.length === 1 ? '' : 's'} ✓`,
          4000,
        )
      } else if (installed.length === 0) {
        showToast(
          `Bundle install failed (${failed.length}/${count}). First error: ${failed[0].error}`,
          6000,
        )
      } else {
        showToast(
          `Installed ${installed.length}/${count}. ${failed.length} failed — see console for details.`,
          6000,
        )
        // Surface the failures in the console so a power user can dig in
        // without having to crack open localStorage.
        // eslint-disable-next-line no-console
        console.warn('[bundle-install] failures:', failed)
      }
    } finally {
      inFlightRef.current = false
    }
  }

  // ── Tauri deep-link path ──────────────────────────────────────
  useEffect(() => {
    if (!isDesktop()) return
    let unlisten = null
    let cancelled = false

    const handleLink = (link) => {
      const bundleUrl = bundleUrlFromDeepLink(link)
      if (!bundleUrl) {
        // eslint-disable-next-line no-console
        console.info('[bundle-install] ignoring deep link (not install-bundle):', link)
        return
      }
      runBundle(bundleUrl, originOf(bundleUrl) || 'a hosted Audimo configure page')
    }

    ;(async () => {
      // Drain any buffered URLs first. The Rust shell queues
      // deep-link URLs that arrived before this listener mounted —
      // a browser-clicked install link that wakes the app would
      // otherwise be lost while React was still hydrating.
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const buffered = await invoke('audimo_drain_deep_links')
        if (cancelled) return
        for (const link of (Array.isArray(buffered) ? buffered : [])) {
          handleLink(typeof link === 'string' ? link : '')
        }
      } catch (e) {
        // Older shell builds don't expose the command — fall through
        // to live-event-only mode.
        // eslint-disable-next-line no-console
        console.info('[bundle-install] drain command unavailable:', e?.message || e)
      }

      try {
        const { listen } = await import('@tauri-apps/api/event')
        if (cancelled) return
        unlisten = await listen('audimo://deep-link', (event) => {
          handleLink(typeof event?.payload === 'string' ? event.payload : '')
        })
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[bundle-install] could not subscribe to deep-link event:', e)
      }
    })()
    return () => {
      cancelled = true
      if (typeof unlisten === 'function') unlisten()
    }
    // runBundle is stable enough; intentionally not in deps to keep
    // the listener subscribed exactly once for the component's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── postMessage from configure page ───────────────────────────
  useEffect(() => {
    function onMessage(e) {
      const msg = e.data
      if (!msg || msg.type !== 'tunnel-addon:install') return
      // We only handle the bundle variant here. The plain single-URL
      // re-save flow keeps living in AddonsView, where it's scoped to
      // already-installed addons (matching origin).
      if (typeof msg.bundleUrl !== 'string' || !msg.bundleUrl) return
      // Origin trust: an attacker on an arbitrary public page can
      // postMessage from a frame the user happens to open. We accept
      // both trusted (loopback / Tauri) and untrusted origins, but
      // untrusted ones get an extra warning in the confirm dialog AND
      // the credential keys are surfaced so smuggled creds are
      // visible. Pure-block would be safer but cuts off the
      // legitimate "user runs their own hosted configure page" flow.
      const trusted = isTrustedBundleOrigin(e.origin)
      if (!trusted) {
        // eslint-disable-next-line no-console
        console.warn('[bundle-install] postMessage from untrusted origin:', e.origin)
      }
      runBundle(msg.bundleUrl, e.origin || 'a configure page', { trusted })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return null
}
