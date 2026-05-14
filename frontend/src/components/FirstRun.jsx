import { useState } from 'react'
import * as desktop from '../desktop'
import { WHATSNEW_VERSION } from '../version'
import styles from './FirstRun.module.css'

// First-run onboarding for the desktop app.
//
// Two steps:
//   1. Welcome — what Audimo is.
//   2. Addons primer — surfaces the "you'll want to install an addon"
//      hint Stremio-style, with a one-click jump to the catalog.
//      The previous single-step welcome made a new user click
//      through Home → empty Search → "no addons" error before
//      figuring out that addons exist.
//
// onDone(initialView?) — initialView is 'addons' when the user
// picked "Browse the catalog" on step 2, undefined otherwise.
export default function FirstRun({ onDone }) {
  const [step, setStep] = useState(1)

  const finish = async (initialView) => {
    try {
      await desktop.setFirstRunComplete()
    } catch {}
    // Pre-dismiss the sidebar's "What's new" card. A brand-new
    // install has no prior version to compare against — there's
    // nothing new for THIS user, just feature parity. The card
    // re-surfaces on the next version bump because the dismiss key
    // is versioned (see Sidebar.jsx).
    try {
      localStorage.setItem(`tunnel:whatsnew:dismissed:${WHATSNEW_VERSION}`, '1')
    } catch {}
    onDone(initialView)
  }

  return (
    <div className={styles.root}>
      <div className={styles.card}>
        <div className={styles.steps} aria-hidden="true">
          <span className={`${styles.stepDot} ${step === 1 ? styles.active : ''}`} />
          <span className={`${styles.stepDot} ${step === 2 ? styles.active : ''}`} />
        </div>

        {step === 1 && (
          <>
            <h1 className={styles.h1}>Welcome to Audimo</h1>
            <p className={styles.lede}>
              Music, audiobooks, and podcasts — on your hardware. Audimo runs
              entirely on this machine: your library, your credentials, your
              playback history. Nothing leaves your network unless you tell it to.
            </p>
            <div className={styles.actions}>
              <button className={styles.primary} onClick={() => setStep(2)}>Continue</button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h1 className={styles.h1}>One more thing</h1>
            <p className={styles.lede}>
              Audimo plays your local files and searches built-in catalogs
              (audiobooks, podcasts) out of the box. To stream music from
              the web — or add lyrics, scrobbling, niche libraries —
              install an addon. You pick which ones.
            </p>
            <p className={styles.muted}>
              Skip this for now if you only plan to play files you already
              have on disk. You can install addons later from the Addons tab.
            </p>
            <div className={styles.actions}>
              <button
                className={styles.secondary}
                onClick={() => finish()}
              >Maybe later</button>
              <button
                className={styles.primary}
                onClick={() => finish('addons')}
              >Browse the catalog</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
