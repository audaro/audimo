import { useState, useEffect } from 'react'
import { useStore } from '../store'
import { authFetch } from '../api'
import * as registry from '../addons/registry'
import Icon from './Icon'
import styles from './Sidebar.module.css'
import { VERSION, WHATSNEW_VERSION } from '../version'

// v2 sidebar — three nav groups (Browse / Tools / Account), gold
// left-tick on the active row, "What's new" card + signed-in user
// row + library track counter pinned to the bottom. Mobile collapses
// to display:none; the mobile shell renders MTabBar instead.

const WHATSNEW_DISMISS_KEY = `tunnel:whatsnew:dismissed:${WHATSNEW_VERSION}`

const NAV_TOP = [
  { view: 'home',     label: 'Home',   icon: 'home' },
  { view: 'search',   label: 'Search', icon: 'search' },
]
// LIBRARY group — three content surfaces with equal weight. "Music"
// dropped the "My" prefix since the group label now does that work.
const NAV_LIBRARY = [
  { view: 'library',    label: 'Music',      icon: 'library' },
  { view: 'audiobooks', label: 'Audiobooks', icon: 'book' },
  { view: 'podcasts',   label: 'Podcasts',   icon: 'mic' },
]
const NAV_TOOLS = [
  { view: 'queue',     label: 'Queue',     icon: 'queue' },
  { view: 'playlists', label: 'Playlists', icon: 'list' },
  { view: 'history',   label: 'History',   icon: 'history' },
  { view: 'addons',    label: 'Addons',    icon: 'addon' },
]
const NAV_ACCT = [
  { view: 'settings', label: 'Settings', icon: 'settings' },
]

function NavLink({ item, active, onClick, badge }) {
  const isActive = active === item.view
  return (
    <button
      type="button"
      className={`${styles.navItem} ${isActive ? styles.active : ''}`}
      onClick={onClick}
    >
      <Icon name={item.icon} size={16} className={styles.navIcon} />
      <span className={styles.navLabel}>{item.label}</span>
      {badge > 0 && <span className={styles.navBadge}>{badge > 99 ? '99+' : badge}</span>}
      {item.isNew && <span className={styles.navNew}>NEW</span>}
    </button>
  )
}

export default function Sidebar() {
  const { view, setView, user, logout, addons } = useStore()

  const addonTabs = (addons || [])
    .filter(a => a.enabled !== false && a.manifest?.ui?.tab && a.manifest?.capabilities?.includes('ui.tab'))
    .sort((a, b) => (a.manifest.ui.tab.sort_priority ?? 100) - (b.manifest.ui.tab.sort_priority ?? 100))

  const [cacheCount, setCacheCount] = useState(0)
  const apiKey = useStore(s => s.apiKey)
  // Dismissed state for the What's new card. Persisted per-version
  // so a copy change re-surfaces it; cleared by future bumps to
  // WHATSNEW_VERSION above.
  const [whatsNewDismissed, setWhatsNewDismissed] = useState(() => {
    try { return localStorage.getItem(WHATSNEW_DISMISS_KEY) === '1' }
    catch { return false }
  })
  const dismissWhatsNew = () => {
    try { localStorage.setItem(WHATSNEW_DISMISS_KEY, '1') } catch {}
    setWhatsNewDismissed(true)
  }
  useEffect(() => {
    const refresh = () => {
      authFetch('/api/cache/list')
        .then(r => r.ok ? r.json() : null)
        .then(d => {
          if (!d) return
          const visible = (d.entries || []).filter(registry.entryIsResolvableOnDevice)
          setCacheCount(visible.length)
        })
        .catch(() => {})
    }
    refresh()
    return registry.subscribe(refresh)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey])


  return (
    <aside className={styles.sidebar}>
      <div className={styles.brand}>
        <div className={`h-display ${styles.wordmark}`}>audimo</div>
        <span className={`label ${styles.version}`}>v{VERSION}</span>
      </div>

      <nav className={styles.nav}>
        {NAV_TOP.map(item => (
          <NavLink key={item.view} item={item} active={view} onClick={() => setView(item.view)} />
        ))}
      </nav>

      <div className={`label ${styles.section}`}>Library</div>
      <nav className={styles.nav}>
        {NAV_LIBRARY.map(item => (
          <NavLink
            key={item.view}
            item={item}
            active={view}
            onClick={() => setView(item.view)}
          />
        ))}
      </nav>

      <div className={`label ${styles.section}`}>Tools</div>
      <nav className={styles.nav}>
        {NAV_TOOLS.map(item => (
          <NavLink key={item.view} item={item} active={view} onClick={() => setView(item.view)} />
        ))}
      </nav>

      {addonTabs.length > 0 && (
        <>
          <div className={`label ${styles.section}`}>Addons</div>
          <nav className={styles.nav}>
            {addonTabs.map(addon => {
              const tabCfg = addon.manifest.ui.tab
              const tabView = `tab:${addon.id}`
              const isActive = view === tabView
              return (
                <button
                  key={addon.id}
                  type="button"
                  className={`${styles.navItem} ${isActive ? styles.active : ''}`}
                  onClick={() => setView(tabView)}
                >
                  <Icon name="addon" size={16} className={styles.navIcon} />
                  <span className={styles.navLabel}>{tabCfg.label}</span>
                </button>
              )
            })}
          </nav>
        </>
      )}

      <div className={`label ${styles.section}`}>Account</div>
      <nav className={styles.nav}>
        {NAV_ACCT.map(item => (
          <NavLink key={item.view} item={item} active={view} onClick={() => setView(item.view)} />
        ))}
      </nav>

      <div className={styles.spacer} />

      {!whatsNewDismissed && (
        <div
          className={`${styles.whatsNew} ${view === 'whats-new' ? styles.whatsNewActive : ''}`}
          role="button"
          tabIndex={0}
          onClick={() => setView('whats-new')}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setView('whats-new') } }}
        >
          <button
            type="button"
            className={styles.whatsNewDismiss}
            onClick={e => { e.stopPropagation(); dismissWhatsNew() }}
            title="Hide"
            aria-label="Hide What's new"
          >✕</button>
          <div className={`label ${styles.whatsNewLabel}`}>What's new · {WHATSNEW_VERSION}</div>
          <div className={styles.whatsNewBody}>
            Now Playing tailored to audiobooks + podcasts, audiobook chapter list,
            reliable cache resolve.
          </div>
        </div>
      )}

      {user && (
        <div className={styles.userRow}>
          <span className={styles.userEmail}>{user.email}</span>
          <button
            type="button"
            className={styles.logoutBtn}
            onClick={logout}
            title="Sign out"
            aria-label="Sign out"
          >
            <Icon name="out" size={14} />
          </button>
        </div>
      )}

      {/* Footer chip: count of tracks in My Music. Originally labelled
          "Library" which double-counted with the sidebar group header
          and confused users on which "library" was being counted.
          Renamed to "Music" to match the navigation entry it counts. */}
      <div className={styles.libraryRow}>
        <span className="label">Music</span>
        <span className={styles.libraryVal}>
          {cacheCount} <span className="text-mute">{cacheCount === 1 ? 'track' : 'tracks'}</span>
        </span>
      </div>
    </aside>
  )
}
