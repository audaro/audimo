import { useEffect, useState } from 'react'
import { authFetch } from '../api'

// Polls /api/download/jobs while any job is in flight. Idle when no
// active jobs (poll falls back to a slower interval so finished
// jobs visibly transition to "done" once before disappearing).
//
// Single source of truth for the global progress overlay AND for
// per-row Download buttons (lookup by `kind` + `related_key`).

const ACTIVE_INTERVAL_MS = 1000   // 1Hz while downloading
const IDLE_INTERVAL_MS = 6000     // back off when nothing's running

export function useDownloadJobs() {
  const [jobs, setJobs] = useState([])

  useEffect(() => {
    let cancelled = false
    let timer = null

    const tick = async () => {
      let fresh = null
      try {
        const r = await authFetch('/api/download/jobs')
        if (!r.ok) return
        const d = await r.json()
        if (cancelled) return
        fresh = d.jobs || []
        setJobs(fresh)
      } catch {
        // Network blip — keep polling at idle rate.
      } finally {
        if (cancelled) return
        // Decide the next interval from the FRESH response, not the
        // closure-captured `jobs` — that snapshot is frozen at mount
        // ([] deps), so without this the hook would poll at the idle
        // rate forever, even with an active download in flight. That
        // made download progress appear to "do nothing" for 6 seconds
        // after the user clicked the button.
        const anyActive = (fresh || []).some(j => j.status === 'pending' || j.status === 'downloading' || j.status === 'finalizing')
        timer = setTimeout(tick, anyActive ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS)
      }
    }
    tick()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return jobs
}

// Convenience: find the job for a specific kind+key, or null.
export function findJob(jobs, kind, relatedKey) {
  return (jobs || []).find(j => j.kind === kind && j.related_key === relatedKey) || null
}
