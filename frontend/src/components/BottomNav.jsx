import { useState } from 'react'
import { useStore } from '../store'
import Icon from './Icon'
import MoreSheet from './MoreSheet'
import styles from './BottomNav.module.css'

// v2 mobile tab bar — four built-in tabs (Today / Search / Music /
// Books) plus a "More" slot that opens a sheet listing the rest
// (Settings, Playlists, Queue, History, Podcasts, Addons). Addon
// tabs go to the bar first; if there are more addon tabs than
// remaining slots they overflow into the More sheet.
const BUILT_IN = [
  { view: 'home',       label: 'Today',  icon: 'home' },
  { view: 'search',     label: 'Search', icon: 'search' },
  { view: 'library',    label: 'Music',  icon: 'library' },
  { view: 'audiobooks', label: 'Books',  icon: 'book' },
]

export default function BottomNav() {
  const { view, setView, addons } = useStore()
  const [moreOpen, setMoreOpen] = useState(false)
  const active = view || 'home'

  const addonTabs = (addons || [])
    .filter(a => a.enabled !== false && a.manifest?.ui?.tab && a.manifest?.capabilities?.includes('ui.tab'))
    .sort((a, b) => (a.manifest.ui.tab.sort_priority ?? 100) - (b.manifest.ui.tab.sort_priority ?? 100))

  // Layout decision: the 4 built-ins always take the first 4 slots,
  // and the 5th is ALWAYS "More" — that's the only path to Settings,
  // Playlists, Queue, History, Podcasts, Addons on mobile. Addon
  // tabs go into More instead of the bar so we don't force a hard
  // choice between system views and addon views.
  const visibleTabs = [
    ...BUILT_IN,
    { view: '__more__', label: 'More', icon: 'dot3' },
  ]
  // All addon tabs spill into the sheet for now. A future pass can
  // hoist the highest-priority addon tab into the bar when there
  // are zero addon tabs in flight, but the simple rule wins for v1.
  const overflowAddonTabs = addonTabs

  return (
    <>
      <nav className={styles.nav} style={{ gridTemplateColumns: `repeat(${visibleTabs.length}, 1fr)` }}>
        {visibleTabs.map(({ view: v, label, icon }) => {
          const isMore = v === '__more__'
          const isActive = !isMore && active === v
          return (
            <button
              key={v}
              type="button"
              className={`${styles.item} ${isActive ? styles.active : ''}`}
              onClick={() => isMore ? setMoreOpen(true) : setView(v)}
              aria-label={label}
            >
              <Icon name={icon} size={20} />
              <span className={`mono ${styles.label}`}>{label}</span>
            </button>
          )
        })}
      </nav>
      <MoreSheet
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        overflowAddonTabs={overflowAddonTabs}
      />
    </>
  )
}
