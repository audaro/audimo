// Helpers shared across orchestrator submodules.
//
// `rewriteAddonHost` is used by streaming (rewriting :11471 URLs),
// resolve (absolutizing relative SSE stream_urls), and cache (same,
// for redispatch results). `_normalizeInfoHash` is used by streaming
// and debrid push.

// "localhost" on the phone is the phone, not the desktop. When the
// page is being viewed from a non-loopback origin (Tailscale, LAN),
// swap loopback hostnames in addon URLs for the page's host so
// streamUrls and addon endpoints actually reach the desktop.
export function rewriteAddonHost(urlStr) {
  if (typeof window === 'undefined' || !urlStr) return urlStr
  let u
  try { u = new URL(urlStr) } catch { return urlStr }
  const loopback = new Set(['localhost', '127.0.0.1', '::1'])
  if (!loopback.has(u.hostname)) return urlStr
  const pageHost = window.location.hostname
  if (!pageHost || loopback.has(pageHost)) return urlStr
  u.hostname = pageHost
  return u.toString().replace(/\/+$/, '')
}

export function _normalizeInfoHash(s) {
  if (!s || typeof s !== 'string') return null
  const h = s.trim().toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(h)) return null
  return h
}
