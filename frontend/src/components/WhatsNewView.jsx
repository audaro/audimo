import { useStore } from '../store'
import styles from './WhatsNewView.module.css'
import { VERSION, CODENAME, RELEASE_DATE } from '../version'

// Static changelog. Bump VERSION in `src/version.js` and update ITEMS
// when shipping a release. Order: newest at the top of ITEMS.
// ROADMAP is aspirational, not guaranteed — keep it short and
// high-confidence only.

const ITEMS = [
  {
    tag: 'NEW',
    title: 'Today screen',
    body: 'Replaces the blank Home default. Continue listening to audiobooks, see what you played recently, and surface what your installed addons are showing.',
    target: 'home',
  },
  {
    tag: 'NEW',
    title: 'Audiobook playback controls',
    body: 'Variable speed (0.75× through 2.0×) and a sleep timer with end-of-chapter mode, surfaced in the player when an audiobook is playing.',
    target: 'library',
  },
  {
    tag: 'NEW',
    title: 'Search empty state',
    body: 'Recent searches as chips and a live readout of which installed addons are participating in your search.',
    target: 'search',
  },
  {
    tag: 'NEW',
    title: 'Addon UI surfaces',
    body: 'Addons can now contribute three independent surfaces — a dedicated tab, a chip in unified search, or shelves on the Home view. Each is opt-in via a manifest capability.',
    target: 'addons',
  },
]

const ROADMAP = [
  { v: '0.5', title: 'Stats & listening history', body: 'A local play log so the Today rail can show this-week hours, top artists, and source mix.' },
  { v: '0.5', title: 'Smart playlists', body: 'Rule editor combining quality, year, plays, source, and date added, with auto-refresh.' },
  { v: '0.5', title: 'Synced lyrics', body: 'Karaoke-style line highlighting in Now Playing, fed by an LRCLIB addon.' },
  { v: '0.5', title: 'Output device picker', body: 'Send playback to a specific output (USB DAC, AirPlay device) right from the player.' },
]

export default function WhatsNewView() {
  const { setView } = useStore()
  return (
    <div className={styles.wrap}>
      <header className={styles.head}>
        <div className={styles.tag}>{`v${VERSION} · ${CODENAME} · ${RELEASE_DATE}`}</div>
        <h1 className={styles.title}>What's new</h1>
        <p className={styles.lede}>
          The biggest shift since launch: a Today screen replaces the blank
          Home default, addons can now contribute to multiple UI surfaces
          independently, and the audiobook player picked up the controls
          you've been asking for.
        </p>
      </header>

      <section className={styles.itemGrid}>
        {ITEMS.map(it => (
          <button
            key={it.title}
            type="button"
            className={styles.item}
            onClick={() => it.target && setView(it.target)}
          >
            <div className={styles.itemTag}>{it.tag}</div>
            <div className={styles.itemBody}>
              <div className={styles.itemTitle}>{it.title}</div>
              <div className={styles.itemDesc}>{it.body}</div>
            </div>
            <span className={styles.itemArrow} aria-hidden="true">→</span>
          </button>
        ))}
      </section>

      <section className={styles.roadmap}>
        <header className={styles.roadmapHead}>
          <h2 className={styles.roadmapTitle}>Coming next</h2>
          <span className={styles.roadmapTag}>roadmap · subject to change</span>
        </header>
        {ROADMAP.map(r => (
          <div key={r.title} className={styles.roadmapRow}>
            <span className={styles.roadmapVersion}>v{r.v}</span>
            <div>
              <div className={styles.roadmapItemTitle}>{r.title}</div>
              <div className={styles.roadmapItemBody}>{r.body}</div>
            </div>
          </div>
        ))}
      </section>
    </div>
  )
}
