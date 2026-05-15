import { useEffect, useState } from 'react'
import { useStore } from './store'
import { authMe, fetchPlaylists, pairRedeem, authFetch } from './api'
import * as desktop from './desktop'
import * as registry from './addons/registry'
import Sidebar from './components/Sidebar'
import Player from './components/Player'
import SearchView from './components/SearchView'
import QueueView from './components/QueueView'
import PlaylistsView from './components/PlaylistsView'
import LibraryView from './components/LibraryView'
import LibraryHub from './components/LibraryHub'

// Tiny redirect helper — we removed top-level routes (audiobooks)
// in favor of LibraryHub tabs. Callers that still set `view` to one
// of those names get bounced to the new home on next render.
function NavRedirect({ to }) {
  const { setView } = useStore()
  useEffect(() => { setView(to) }, [to, setView])
  return null
}
import Toast from './components/Toast'
import ConfirmModal from './components/ConfirmModal'
import BottomNav from './components/BottomNav'
import NowPlaying from './components/NowPlaying'
import BundleInstallListener from './components/BundleInstallListener'
import FfmpegBanner from './components/FfmpegBanner'
import SettingsView from './components/SettingsView'
import HistoryView from './components/HistoryView'
import AddonsView from './components/AddonsView'
import AudiobooksView from './components/AudiobooksView'
import AddonTabView from './components/AddonTabView'
import HomeView from './components/HomeView'
import WhatsNewView from './components/WhatsNewView'
import AudiobookDetailView from './components/AudiobookDetailView'
import PodcastsView from './components/PodcastsView'
import PodcastDetailView from './components/PodcastDetailView'
import FirstRun from './components/FirstRun'
import { PHONE_ACCESS_ENABLED } from './featureFlags'
import styles from './App.module.css'

export default function App() {
  const { view, setView, setUser, setApiKey, setPlaylists, loadAddons, addons } = useStore()
  // Theme reflection — mirror the zustand `theme` value to
  // <html data-theme="light"|"dark">. index.css overrides the
  // palette variables based on this attribute, so a single string
  // flip recolors the whole app without per-component logic.
  // Also drive <meta name="theme-color"> + iOS status-bar style so
  // the system chrome matches the page background in PWA / Add-to-
  // Home-Screen mode.
  const theme = useStore(s => s.theme)
  useEffect(() => {
    const isLight = theme === 'light'
    document.documentElement.setAttribute('data-theme', isLight ? 'light' : 'dark')
    const themeColor = isLight ? '#fafafa' : '#111111'
    let meta = document.querySelector('meta[name="theme-color"]')
    if (!meta) {
      meta = document.createElement('meta')
      meta.name = 'theme-color'
      document.head.appendChild(meta)
    }
    meta.content = themeColor
    let statusStyle = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')
    if (statusStyle) {
      statusStyle.content = isLight ? 'default' : 'black-translucent'
    }
  }, [theme])

  // Touch-pointer detection — flips <html data-touch="true"> on
  // hover-less devices so global CSS can reveal hover-hidden row
  // actions. Re-evaluates on `pointer`/`hover` changes (a phone
  // attached to a mouse, or a desktop touchscreen losing focus).
  useEffect(() => {
    const mq = window.matchMedia('(hover: none), (pointer: coarse)')
    const apply = () => {
      document.documentElement.setAttribute('data-touch', mq.matches ? 'true' : 'false')
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])
  // null = haven't loaded yet, false = show onboarding, true = show app.
  // For phone-browser / non-Tauri the desktop bridge stubs this to true
  // so onboarding never appears outside the desktop shell.
  const [firstRunComplete, setFirstRunComplete] = useState(null)
  // Pair redemption is mobile-side. While in flight we hold rendering so
  // the user doesn't briefly see an unauthenticated empty state.
  const [pairing, setPairing] = useState(false)
  const [pairError, setPairError] = useState('')

  // ⌘K / Ctrl+K from anywhere → jump to Search and focus the input.
  // Skips when the user is already typing into something so the
  // shortcut doesn't fight a real text input.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        const t = e.target
        const tag = t?.tagName
        const isField = tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable
        // Allow ⌘K to escape into Search even from inside another
        // field — the user's intent is unambiguous (Cmd-modified
        // shortcut). Only swallow to prevent the browser default.
        if (!isField || e.metaKey || e.ctrlKey) {
          e.preventDefault()
          useStore.getState().kickSearchFocus()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // Probe install state on mount.
  useEffect(() => {
    desktop.getState()
      .then(s => setFirstRunComplete(!!s.first_run_complete))
      .catch(() => setFirstRunComplete(true))
  }, [])

  // Mobile pair-redeem: when the page is opened from a desktop QR or
  // a home-screen URL, the query carries `?pair=<token>`. Reusable
  // home-screen tokens stay in the URL across launches; single-use
  // QR tokens get stripped after the first successful redeem so a
  // copied-link sharing accident doesn't reveal a still-valid token.
  //
  // If the store already has an apiKey + addons, we skip the network
  // call (no point re-redeeming when state is good). If a later
  // authMe() 401s with the ?pair= still present, the recovery path
  // below in the boot effect re-redeems automatically.
  useEffect(() => {
    if (!PHONE_ACCESS_ENABLED) return
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const token = params.get('pair')
    if (!token) return
    const existingState = useStore.getState()
    // Just an apiKey is enough — addons can legitimately be empty
    // (a fresh install with no addons enabled). The previous check
    // required addons.length > 0 which made the home-screen reload
    // loop with zero-addon desktops: redeem → reload → fail
    // alreadyPaired (no addons) → redeem → loop until rate-limited.
    const alreadyPaired = !!existingState.apiKey
    if (alreadyPaired) {
      // Don't hit the API — state is good. Keep ?pair= in the URL
      // so a wiped-storage relaunch can re-redeem.
      return
    }
    setPairing(true)
    pairRedeem({ token, baseUrl: window.location.origin })
      .then(async ({ api_key, addons, reusable }) => {
        setApiKey(api_key || '')
        registry.replaceAll(Array.isArray(addons) ? addons : [])
        // Wait for the encrypted addon-registry write to actually
        // land in localStorage before reloading. Without this the
        // reload fires while persist() (async crypto) is still
        // running, the next mount reads an empty registry, and the
        // home-screen icon looks "fresh" even though redeem
        // succeeded.
        try { await registry.flush() } catch {}
        // Single-use tokens: strip the now-consumed value so it
        // can't accidentally be re-shared. Reusable tokens stay so
        // a future wiped-storage launch can re-redeem.
        if (!reusable) {
          params.delete('pair')
          const qs = params.toString()
          const next = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash
          window.history.replaceState({}, '', next)
        }
        window.location.reload()
      })
      .catch(e => {
        setPairError(String(e?.message || e))
        setPairing(false)
      })
  }, [setApiKey])

  // Single-user-per-install: no login screen. Probe `/auth/me` so the
  // store knows the synthetic owner identity, fail-soft if the API key
  // is wrong (the user can fix it in Settings without being locked
  // out of the UI). Skip while onboarding is up so the user isn't
  // racing with the backend respawn that follows "Enable phone access".
  useEffect(() => {
    // Use a same-origin URL so this also works when the page is
    // served from a non-loopback host (LAN access via phone). The
    // hardcoded http://127.0.0.1:8000 was firing an "unreachable"
    // network error on every iPhone boot — visible in Safari Web
    // Inspector even though the catch() silently swallowed it.
    const dbg = (msg) => fetch('/api/_debug_log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag: 'App.boot', msg }),
    }).catch(() => {})
    dbg(`useEffect fired firstRunComplete=${firstRunComplete} isDesktop=${desktop.isDesktop()} hasInternals=${typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__}`)
    if (firstRunComplete !== true) return
    // Boot sequence: seed the API key BEFORE any authFetch fires.
    // The backend has no keyless mode any more, so authMe() with an
    // empty store would 401 and the user briefly sees "Authentication
    // required" toasts before the next render cycle seeds the key.
    // Chain explicitly so authMe waits for the key.
    let cancelled = false
    ;(async () => {
      if (desktop.isDesktop()) {
        try {
          const k = await desktop.ensureApiKey()
          dbg(`ensureApiKey returned len=${k ? k.length : 0}`)
          if (k && !cancelled) setApiKey(k)
        } catch (e) {
          dbg(`ensureApiKey threw ${e?.message || e}`)
        }
      }
      if (cancelled) return
      try {
        const { user } = await authMe()
        if (cancelled) return
        setUser(user)
        const d = await fetchPlaylists()
        if (!cancelled && d?.playlists) setPlaylists(d.playlists)
      } catch (e) {
        // If we got 401-class auth failure AND the URL still carries
        // a ?pair= token (home-screen icon launch with a revoked or
        // wiped session), redeem it. Reusable tokens make this safe
        // — the token works repeatedly until the desktop revokes it.
        const msg = String(e?.message || e || '').toLowerCase()
        const looks401 = msg.includes('401') || msg.includes('unauthorized') || msg.includes('authentication')
        const params = new URLSearchParams(window.location.search)
        const stalePairToken = params.get('pair')
        if (looks401 && stalePairToken && PHONE_ACCESS_ENABLED) {
          try {
            const { api_key, addons } = await pairRedeem({
              token: stalePairToken,
              baseUrl: window.location.origin,
            })
            if (!cancelled) {
              setApiKey(api_key || '')
              registry.replaceAll(Array.isArray(addons) ? addons : [])
              // Await encrypted persist before reload so the next
              // mount actually sees the addons (race fixed in the
              // primary redeem path too).
              try { await registry.flush() } catch {}
              window.location.reload()
              return
            }
          } catch {
            // Token revoked — fall through to fail-soft. User can
            // re-pair from a fresh URL on their desktop.
          }
        }
        // fail-soft — user can fix the key in Settings if it's wrong
      }
      // Crash tripwire: surface a one-shot toast if the previous
      // backend session didn't exit cleanly. The backend's
      // consume_crash_flag() makes this idempotent across reloads.
      try {
        const r = await authFetch('/api/boot-status')
        if (r.ok) {
          const j = await r.json()
          if (j?.previous_crashed && !cancelled) {
            useStore.getState().showToast(
              'Audimo didn\'t shut down cleanly last time. Check ~/.audimo for logs.',
              { duration: 7000 },
            )
          }
        }
      } catch {
        // Boot-status is best-effort; never block startup on it.
      }
      if (!cancelled) loadAddons()
    })()
    return () => { cancelled = true }
  }, [firstRunComplete, setUser, setApiKey, setPlaylists, loadAddons])

  if (pairing) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'var(--text)' }}>
        Pairing…
      </div>
    )
  }
  if (pairError) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'var(--text)', gap: 12, padding: 24, textAlign: 'center' }}>
        <div>Pairing failed: {pairError}</div>
        <div style={{ fontSize: 13, opacity: 0.7 }}>Generate a new code on your desktop and try again.</div>
      </div>
    )
  }
  if (firstRunComplete === null) return null
  if (firstRunComplete === false) {
    return <FirstRun onDone={(initialView) => {
      setFirstRunComplete(true)
      if (initialView) setView(initialView)
    }} />
  }

  const activeView = view || 'home'

  // Enabled addons that declare a ui.tab
  const addonTabs = (addons || []).filter(
    a => a.enabled !== false && a.manifest?.ui?.tab && a.manifest?.capabilities?.includes('ui.tab')
  )

  return (
    <div className={styles.layout}>
      <Sidebar />
      <main className={styles.main}>
        <FfmpegBanner />
        <div style={{ display: activeView === 'home' ? 'contents' : 'none' }}><HomeView /></div>
        <div style={{ display: activeView === 'search' ? 'contents' : 'none' }}><SearchView /></div>
        <div style={{ display: activeView === 'queue' ? 'contents' : 'none' }}><QueueView /></div>
        <div style={{ display: activeView === 'playlists' ? 'contents' : 'none' }}><PlaylistsView /></div>
        <div style={{ display: activeView === 'library' ? 'contents' : 'none' }}><LibraryHub /></div>
        <div style={{ display: activeView === 'audiobooks' ? 'contents' : 'none' }}><AudiobooksView /></div>
        <div style={{ display: activeView === 'settings' ? 'contents' : 'none' }}><SettingsView /></div>
        <div style={{ display: activeView === 'history' ? 'contents' : 'none' }}><HistoryView /></div>
        <div style={{ display: activeView === 'addons' ? 'contents' : 'none' }}><AddonsView /></div>
        <div style={{ display: activeView === 'whats-new' ? 'contents' : 'none' }}><WhatsNewView /></div>
        <div style={{ display: activeView === 'audiobook' ? 'contents' : 'none' }}><AudiobookDetailView /></div>
        <div style={{ display: activeView === 'podcasts' ? 'contents' : 'none' }}><PodcastsView /></div>
        <div style={{ display: activeView === 'podcast' ? 'contents' : 'none' }}><PodcastDetailView /></div>
        {/* Addon-defined tabs — one AddonTabView per installed ui.tab addon */}
        {addonTabs.map(addon => (
          <div key={addon.id} style={{ display: activeView === `tab:${addon.id}` ? 'contents' : 'none' }}>
            <AddonTabView addon={addon} />
          </div>
        ))}
      </main>
      <Player />
      <Toast />
      <ConfirmModal />
      <BottomNav />
      <NowPlaying />
      <BundleInstallListener />
    </div>
  )
}
