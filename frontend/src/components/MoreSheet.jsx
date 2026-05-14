import { useStore } from '../store'
import Icon from './Icon'
import MobileSheet from './MobileSheet'
import styles from './MoreSheet.module.css'

// "More" sheet — overflow list for views that don't fit the four
// built-in bottom-nav slots (Settings, Playlists, Queue, History,
// Podcasts, Addons) plus any addon tabs that overflowed. Built on
// the shared MobileSheet primitive; this component is only the
// list contents + navigation handling.

const ITEMS = [
  { view: 'queue',     label: 'Queue',     icon: 'queue' },
  { view: 'playlists', label: 'Playlists', icon: 'list' },
  { view: 'podcasts',  label: 'Podcasts',  icon: 'mic' },
  { view: 'history',   label: 'History',   icon: 'history' },
  { view: 'addons',    label: 'Addons',    icon: 'addon' },
  { view: 'settings',  label: 'Settings',  icon: 'settings' },
]

export default function MoreSheet({ open, onClose, overflowAddonTabs = [] }) {
  const { setView } = useStore()
  const pick = (v) => { setView(v); onClose() }

  const allItems = [
    ...ITEMS,
    ...overflowAddonTabs.map(a => ({
      view: `tab:${a.id}`,
      label: a.manifest.ui.tab.label || a.id,
      icon: 'addon',
    })),
  ]

  return (
    <MobileSheet open={open} onClose={onClose} title="More">
      <ul className={styles.list}>
        {allItems.map(({ view, label, icon }) => (
          <li key={view}>
            <button
              type="button"
              className={styles.row}
              onClick={() => pick(view)}
            >
              <Icon name={icon} size={20} />
              <span className={styles.rowLabel}>{label}</span>
              <Icon name="chev" size={16} className={styles.chev} />
            </button>
          </li>
        ))}
      </ul>
    </MobileSheet>
  )
}
