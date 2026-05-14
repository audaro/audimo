import { useState, useEffect, useCallback, useRef } from 'react'
import { useStore } from '../store'
import { authFetch, apiUrl } from '../api'
import EmptyState from './EmptyState'
import Icon from './Icon'
import styles from './PodcastsView.module.css'

// Podcasts library — your subscriptions, plus a paste-by-URL power-
// user escape for shows that don't show up in iTunes. Discovery
// proper lives on the global Search page (filter chip: Podcasts).

export default function PodcastsView() {
  const apiKey = useStore(s => s.apiKey)
  const view = useStore(s => s.view)
  const showToast = useStore(s => s.showToast)
  const openPodcastDetail = useStore(s => s.openPodcastDetail)
  const setView = useStore(s => s.setView)
  const kickSearchFocus = useStore(s => s.kickSearchFocus)

  const [podcasts, setPodcasts] = useState(null)
  const [feedUrl, setFeedUrl] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [importing, setImporting] = useState(false)
  const fileInputRef = useRef(null)

  const loadLibrary = useCallback(async () => {
    try {
      const r = await authFetch('/api/podcasts')
      if (!r.ok) return
      const data = await r.json()
      setPodcasts(data.podcasts || [])
    } catch {
      setPodcasts([])
    }
  }, [])

  // Re-fetch on every entry to the Podcasts view, not just on mount,
  // because the App keeps the component mounted via display:none/contents
  // — so a fresh subscribe → back-to-library trip would otherwise show
  // a stale list until the next ⌘+R.
  useEffect(() => {
    if (view === 'podcasts') loadLibrary()
  }, [view, apiKey, loadLibrary])

  function onExport() {
    // Plain anchor download — the backend sets Content-Disposition so
    // the browser saves rather than navigates. No auth header magic
    // needed since the file endpoint accepts the same query as any
    // other GET.
    const a = document.createElement('a')
    a.href = apiUrl('/api/podcasts/export.opml')
    a.download = 'audimo-podcasts.opml'
    a.click()
  }

  async function onImportFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setImporting(true)
    try {
      const text = await file.text()
      const r = await authFetch('/api/podcasts/import.opml', {
        method: 'POST',
        headers: { 'Content-Type': 'application/xml' },
        body: text,
      })
      if (!r.ok) {
        const err = await r.json().catch(() => ({}))
        showToast?.(err.detail || 'Import failed', { kind: 'error' })
        return
      }
      const data = await r.json()
      const added = data.added?.length || 0
      const failed = data.failed || []
      if (failed.length === 0) {
        showToast?.(`Imported ${added} podcast${added === 1 ? '' : 's'}`)
      } else {
        // Show the user WHICH feeds failed via the confirm modal —
        // toasts truncate at one or two lines and a 50-feed import
        // can produce dozens of failures. The confirm modal scrolls,
        // and the user can read each feed URL + the per-feed error
        // to decide what to fix. Confirm-or-cancel is unused; we
        // treat the modal as a long-form notification.
        const sample = failed.slice(0, 12).map(f =>
          `• ${f.feed_url}\n  → ${f.error || 'unknown error'}`
        ).join('\n')
        const more = failed.length > 12
          ? `\n…and ${failed.length - 12} more`
          : ''
        const askConfirm = useStore.getState().askConfirm
        await askConfirm({
          title: `Imported ${added}, ${failed.length} failed`,
          message: `${failed.length} feed${failed.length === 1 ? '' : 's'} couldn't be added:\n\n${sample}${more}`,
          confirmLabel: 'OK',
          cancelLabel: 'Copy failures',
        }).then(async (ok) => {
          if (ok) return
          // Cancel = "Copy failures" — drop the full failure list
          // (not just the sample) into the clipboard so the user
          // can paste into a text editor for review.
          try {
            const full = failed.map(f => `${f.feed_url}\t${f.error || ''}`).join('\n')
            await navigator.clipboard.writeText(full)
            showToast?.('Failure list copied to clipboard', 4000)
          } catch {
            showToast?.('Could not access clipboard', { kind: 'error' })
          }
        })
      }
      loadLibrary()
    } finally {
      setImporting(false)
    }
  }

  async function onSubscribe(e) {
    e.preventDefault()
    const url = feedUrl.trim()
    if (!url) return
    setSubmitting(true)
    try {
      const r = await authFetch('/api/podcasts/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feed_url: url }),
      })
      if (!r.ok) {
        const err = await r.json().catch(() => ({}))
        showToast?.(err.detail || 'Could not subscribe', { kind: 'error' })
        return
      }
      const data = await r.json()
      setFeedUrl('')
      showToast?.(`Subscribed to ${data.podcast?.title || 'podcast'}`)
      loadLibrary()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.header}>
        <div className={styles.headerTop}>
          <h1 className={styles.headerTitle}>Podcasts</h1>
          <span className={styles.headerCount}>
            {podcasts ? `${podcasts.length} ${podcasts.length === 1 ? 'show' : 'shows'}` : ''}
          </span>
          <div className={styles.headerActions}>
            <button
              type="button"
              className={styles.addBtn}
              onClick={() => fileInputRef.current?.click()}
              disabled={importing}
              title={importing ? 'Importing…' : 'Import OPML'}
              aria-label="Import OPML"
            >
              <span className={styles.addBtnFull}>
                {importing ? 'Importing…' : 'Import OPML'}
              </span>
              <span className={styles.addBtnShort} aria-hidden="true">
                {importing ? '…' : '↓'}
              </span>
            </button>
            <button
              type="button"
              className={styles.addBtn}
              onClick={onExport}
              disabled={!podcasts || podcasts.length === 0}
              title="Export OPML"
              aria-label="Export OPML"
            >
              <span className={styles.addBtnFull}>Export OPML</span>
              <span className={styles.addBtnShort} aria-hidden="true">↑</span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".opml,.xml,text/xml,application/xml"
              style={{ display: 'none' }}
              onChange={onImportFile}
            />
          </div>
        </div>
      </div>

      <div className={styles.body}>
        <form className={styles.addForm} onSubmit={onSubscribe}>
          <input
            type="url"
            inputMode="url"
            enterKeyHint="go"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className={styles.addInput}
            placeholder="Paste an RSS feed URL…"
            value={feedUrl}
            onChange={e => setFeedUrl(e.target.value)}
            disabled={submitting}
          />
          <button
            type="submit"
            className={styles.addBtn}
            disabled={submitting || !feedUrl.trim()}
          >
            {submitting ? 'Subscribing…' : 'Add'}
          </button>
        </form>

        {/* Initial-load skeleton. Matches the spinner+caption shape
            used by LibraryView and AudiobooksView so the first-boot
            state reads consistently across all three Library tabs. */}
        {podcasts === null && (
          <div className={styles.loading} role="status" aria-live="polite">
            <div className={styles.loadingSpinner} aria-hidden="true" />
            <p>Loading your podcasts…</p>
          </div>
        )}
        {podcasts && podcasts.length === 0 && (
          <EmptyState
            title="No podcasts yet"
            body="Search for shows from the Search page, or paste an RSS feed URL above."
            action={{ label: 'Open Search', onClick: () => { setView('search'); kickSearchFocus() } }}
          />
        )}
        {podcasts && podcasts.length > 0 && (
          <div className={styles.grid}>
            {podcasts.map(p => (
              <button
                key={p.id}
                type="button"
                className={styles.card}
                onClick={() => openPodcastDetail(p.id)}
              >
                <div className={styles.coverWrap}>
                  {p.artwork
                    ? <img src={p.artwork} alt="" className={styles.cover} loading="lazy" />
                    : <div className={styles.coverFallback}><Icon name="mic" size={24} /></div>}
                  {p.new_count > 0 && (
                    <span className={styles.cardBadge} title={`${p.new_count} new`}>
                      {p.new_count > 99 ? '99+' : p.new_count}
                    </span>
                  )}
                </div>
                <div className={styles.cardTitle}>{p.title || 'Untitled show'}</div>
                {p.author && <div className={styles.cardAuthor}>{p.author}</div>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
