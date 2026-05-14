import { useState, useEffect, useCallback, useRef } from 'react'
import { useStore } from '../store'
import { authFetch } from '../api'
import { useDownloadJobs, findJob } from '../hooks/useDownloadJobs'
import Icon from './Icon'
import EmptyState from './EmptyState'
import styles from './PodcastDetailView.module.css'

// Podcast detail — episode list for one subscription. Loading the page
// implicitly refreshes the feed if it's older than the backend's stale
// threshold (15 min). "Refresh" forces a fetch. "Unsubscribe" removes
// the show + episodes. Tapping an episode hands it to playNow with
// the audio_url as streamUrl.

function fmtDate(epoch) {
  if (!epoch) return ''
  const d = new Date(epoch * 1000)
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

// Auto-linkify URLs in the (already HTML-stripped) episode description.
// Splits on URL matches and re-renders with <a> for each one — never
// uses dangerouslySetInnerHTML, so XSS isn't on the table even if a
// feed serves malicious HTML. Trailing punctuation like "(see…)" gets
// shaved off the URL via a conservative regex.
const URL_RE = /https?:\/\/[^\s<>()]+[^\s<>().,;:!?]/g
function linkifyDescription(text) {
  if (!text) return null
  const out = []
  let lastIdx = 0
  let m
  let key = 0
  while ((m = URL_RE.exec(text)) !== null) {
    if (m.index > lastIdx) out.push(text.slice(lastIdx, m.index))
    out.push(<a key={key++} href={m[0]} target="_blank" rel="noreferrer noopener">{m[0]}</a>)
    lastIdx = m.index + m[0].length
  }
  if (lastIdx < text.length) out.push(text.slice(lastIdx))
  return out
}

function fmtDuration(s) {
  if (!s) return ''
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h) return `${h}h ${m}m`
  return `${m}m`
}

// Overflow menu for secondary podcast actions: toggles (auto-
// download, auto-cleanup), bulk mark-played/unplayed, and
// Unsubscribe. Keeps the header from sprouting 7+ buttons.
function PodcastOverflowMenu({ podcast, onToggleAutoDownload, onToggleAutoCleanup, onMarkAll, onUnsubscribe, bulkBusy }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)
  useEffect(() => {
    if (!open) return
    const onPointer = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const close = () => setOpen(false)
  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        className={styles.actionBtn}
        onClick={() => setOpen(o => !o)}
        title="More actions"
        aria-haspopup="true"
        aria-expanded={open}
      >⋯</button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            minWidth: 220,
            background: 'var(--bg-raised)',
            border: '1px solid var(--line)',
            zIndex: 20,
            padding: '6px 0',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.35)',
          }}
        >
          <OverflowItem
            label={podcast.auto_download ? '✓ Auto-download new episodes' : 'Auto-download new episodes'}
            onClick={() => { onToggleAutoDownload(); close() }}
          />
          <OverflowItem
            label={podcast.auto_cleanup_played ? '✓ Auto-cleanup after listening' : 'Auto-cleanup after listening'}
            onClick={() => { onToggleAutoCleanup(); close() }}
          />
          <OverflowDivider />
          <OverflowItem
            label="Mark all played"
            onClick={() => { onMarkAll(true); close() }}
            disabled={bulkBusy}
          />
          <OverflowItem
            label="Mark all unplayed"
            onClick={() => { onMarkAll(false); close() }}
            disabled={bulkBusy}
          />
          <OverflowDivider />
          <OverflowItem
            label="Unsubscribe"
            onClick={() => { onUnsubscribe(); close() }}
            danger
          />
        </div>
      )}
    </div>
  )
}

function OverflowItem({ label, onClick, disabled, danger }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '8px 14px',
        background: 'transparent',
        border: 0,
        font: 'inherit',
        fontSize: 13,
        color: danger ? 'var(--danger, #e25f5f)' : 'var(--fg)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = 'var(--bg)' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
    >{label}</button>
  )
}

function OverflowDivider() {
  return <div style={{ height: 1, background: 'var(--line-soft)', margin: '6px 0' }} />
}

export default function PodcastDetailView() {
  const podcastId = useStore(s => s.podcastDetailId)
  const previewFeed = useStore(s => s.podcastPreviewFeed)
  const openPodcastDetail = useStore(s => s.openPodcastDetail)
  const apiKey = useStore(s => s.apiKey)
  const setView = useStore(s => s.setView)
  const playNow = useStore(s => s.playNow)
  const showToast = useStore(s => s.showToast)
  const askConfirm = useStore(s => s.askConfirm)

  const [data, setData] = useState(null)  // { podcast, episodes } | null = loading
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const [filter, setFilter] = useState('')
  // 150ms debounce so each keystroke doesn't re-filter 500 episodes
  // synchronously. Below the threshold where users perceive lag.
  const [debouncedFilter, setDebouncedFilter] = useState('')
  useEffect(() => {
    if (!filter) { setDebouncedFilter(''); return }
    const id = setTimeout(() => setDebouncedFilter(filter), 150)
    return () => clearTimeout(id)
  }, [filter])
  const [sortOrder, setSortOrder] = useState('newest')  // 'newest' | 'oldest'
  // Pagination for the episode list. Some feeds (Hardcore History,
  // The Daily, news shows) ship 500+ entries; rendering all of them
  // at once produced a multi-second jank on Detail open. Show the
  // first PAGE_SIZE and let the user expand by PAGE_SIZE each click.
  // Reset whenever the filter or sort changes (the user's mental
  // pagination resets too).
  const PAGE_SIZE = 50
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  useEffect(() => { setVisibleCount(PAGE_SIZE) }, [debouncedFilter, sortOrder])
  const [bulkBusy, setBulkBusy] = useState(false)
  const jobs = useDownloadJobs()

  // Per-view "what was new when I opened the page" snapshot. We
  // capture last_opened_at from the initial GET and treat any
  // episode with pub_date > seenBaseline as NEW for this view only.
  // After capture, POST mark-seen so the card badge clears server-
  // side — but the baseline ref keeps showing NEW pips in this view
  // until the user explicitly plays each one (then we remove from
  // newPending for instant feedback).
  const seenBaselineRef = useRef(0)
  const [newPending, setNewPending] = useState(() => new Set())
  // Episode ids the user just clicked Download on. Lets the row flip
  // to the "Downloading 0%" state synchronously instead of waiting for
  // POST /download → useDownloadJobs poll → progress paint (~1-2s on
  // LAN). Cleared once a real DownloadJob shows up for the episode.
  const [pendingDownloads, setPendingDownloads] = useState(() => new Set())

  const load = useCallback(async ({ firstLoad = false, id = null, feedUrl = null } = {}) => {
    setError(null)
    try {
      const url = id
        ? `/api/podcasts/${id}`
        : `/api/podcasts/preview?feed_url=${encodeURIComponent(feedUrl)}`
      const r = await authFetch(url)
      if (!r.ok) {
        setError(r.status === 404 ? 'Subscription not found' : 'Failed to load')
        return
      }
      const payload = await r.json()
      // preview endpoint flags subscribed:true/false; subscribed
      // (/{id}) endpoint always means yes.
      const isSubscribed = id ? true : !!payload.subscribed
      payload.subscribed = isSubscribed
      if (firstLoad && isSubscribed) {
        const baseline = payload.podcast?.last_opened_at || 0
        seenBaselineRef.current = baseline
        const pending = new Set()
        for (const ep of (payload.episodes || [])) {
          if (!ep.played_at && ep.pub_date > baseline) pending.add(ep.id)
        }
        setNewPending(pending)
        const realId = payload.podcast?.id
        if (realId) {
          authFetch(`/api/podcasts/${realId}/mark-seen`, { method: 'POST' }).catch(() => {})
        }
      }
      setData(payload)
    } catch (e) {
      setError(String(e))
    }
  }, [])

  useEffect(() => {
    if (!podcastId && !previewFeed) return
    setData(null)
    setNewPending(new Set())
    load({ firstLoad: true, id: podcastId, feedUrl: previewFeed })
  }, [podcastId, previewFeed, apiKey, load])

  // Reload after any podcast download finishes so the row picks up
  // the new local_file. Watching the count of done podcast jobs is
  // a cheap proxy — every transition to "done" fires this once.
  const doneJobsCount = jobs.filter(j => j.kind === 'podcast' && j.status === 'done').length
  useEffect(() => {
    if (podcastId && doneJobsCount > 0) load({ id: podcastId })
  }, [doneJobsCount, podcastId, load])

  // Clear optimistic pending flags as soon as the real DownloadJob
  // surfaces for that episode — from here on out the polling hook
  // drives the progress %.
  useEffect(() => {
    if (pendingDownloads.size === 0) return
    setPendingDownloads(prev => {
      let changed = false
      const next = new Set(prev)
      for (const epId of prev) {
        if (findJob(jobs, 'podcast', epId)) {
          next.delete(epId)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [jobs, pendingDownloads])

  async function onRefresh() {
    if (!podcastId) return
    setRefreshing(true)
    try {
      const r = await authFetch(`/api/podcasts/${podcastId}/refresh`, { method: 'POST' })
      if (!r.ok) {
        showToast?.('Refresh failed', { kind: 'error' })
        return
      }
      setData(await r.json())
    } finally {
      setRefreshing(false)
    }
  }

  async function onSubscribe() {
    const feedUrl = data?.podcast?.feed_url || previewFeed
    if (!feedUrl) return
    const r = await authFetch('/api/podcasts/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feed_url: feedUrl }),
    })
    if (!r.ok) {
      showToast?.('Could not subscribe', { kind: 'error' })
      return
    }
    const body = await r.json()
    showToast?.(`Subscribed to ${body.podcast?.title || 'podcast'}`)
    // Swap from preview to subscribed view by setting podcastDetailId.
    // The useEffect dependency change reloads via the /{id} endpoint.
    if (body.podcast?.id) openPodcastDetail(body.podcast.id)
  }

  async function onToggleAutoDownload() {
    const next = !(data?.podcast?.auto_download)
    const r = await authFetch(`/api/podcasts/${podcastId}/auto-download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    })
    if (r.ok) {
      // Reflect immediately; load() also re-fires after this.
      setData(d => d ? { ...d, podcast: { ...d.podcast, auto_download: next ? 1 : 0 } } : d)
      showToast?.(next ? 'Auto-download on' : 'Auto-download off')
    }
  }

  async function onToggleAutoCleanup() {
    const next = !(data?.podcast?.auto_cleanup_played)
    const r = await authFetch(`/api/podcasts/${podcastId}/auto-cleanup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    })
    if (r.ok) {
      setData(d => d ? { ...d, podcast: { ...d.podcast, auto_cleanup_played: next ? 1 : 0 } } : d)
      showToast?.(next ? 'Auto-cleanup on' : 'Auto-cleanup off')
    }
  }

  async function onDownloadNext() {
    setBulkBusy(true)
    try {
      const r = await authFetch(`/api/podcasts/${podcastId}/download-next?n=5`, { method: 'POST' })
      if (!r.ok) {
        showToast?.('Could not start downloads', { kind: 'error' })
        return
      }
      const body = await r.json()
      showToast?.(body.count > 0
        ? `Downloading ${body.count} episode${body.count === 1 ? '' : 's'}…`
        : 'Nothing to download — already up to date')
    } finally {
      setBulkBusy(false)
    }
  }

  async function onMarkAll(played) {
    const epCount = (data?.episodes || []).length
    const verb = played ? 'played' : 'unplayed'
    const ok = await askConfirm({
      title: `Mark all ${verb}?`,
      message: `This will mark ${epCount} episode${epCount === 1 ? '' : 's'} as ${verb}.`,
      confirmLabel: `Mark ${verb}`,
      cancelLabel: 'Cancel',
    })
    if (!ok) return
    setBulkBusy(true)
    try {
      const action = played ? 'mark-all-played' : 'mark-all-unplayed'
      const r = await authFetch(`/api/podcasts/${podcastId}/${action}`, { method: 'POST' })
      if (!r.ok) {
        showToast?.('Failed', { kind: 'error' })
        return
      }
      const body = await r.json()
      showToast?.(`Updated ${body.updated} episode${body.updated === 1 ? '' : 's'}`)
      load({ id: podcastId })
    } finally {
      setBulkBusy(false)
    }
  }

  async function onUnsubscribe() {
    if (!podcastId) return
    const ok = await askConfirm({
      title: 'Unsubscribe?',
      message: `Unsubscribe from "${data?.podcast?.title || 'this podcast'}"? Downloaded episodes stay on disk.`,
      confirmLabel: 'Unsubscribe',
      cancelLabel: 'Cancel',
      danger: true,
    })
    if (!ok) return
    const r = await authFetch(`/api/podcasts/${podcastId}`, { method: 'DELETE' })
    if (r.ok) {
      showToast?.('Unsubscribed')
      setView('podcasts')
    } else {
      showToast?.('Failed to unsubscribe', { kind: 'error' })
    }
  }

  function onPlay(ep) {
    // Clear the per-view NEW pip immediately — the user has acted on
    // this episode, so it shouldn't keep visually shouting for
    // attention. (played_at will get set when they finish; that
    // affects future visits, not this one.)
    if (newPending.has(ep.id)) {
      setNewPending(prev => {
        const next = new Set(prev)
        next.delete(ep.id)
        return next
      })
    }
    // Downloaded episodes play from disk via /api/files/local; the
    // remote audio_url is the streaming fallback. Both go through the
    // standard playNow flow.
    const localUrl = ep.local_file
      ? `/api/files/local?path=${encodeURIComponent(ep.local_file)}`
      : null
    const streamUrl = localUrl || ep.audio_url
    if (!streamUrl) return
    // Only attach podcastEpisodeId (progress heartbeats, resume offset)
    // when we have a DB row for this episode — in preview mode the
    // row doesn't exist, so the heartbeats would 404. Audio still
    // plays; you just can't resume mid-episode until you subscribe.
    const isSubscribed = !!data?.subscribed
    playNow({
      title: ep.title || 'Episode',
      artist: data?.podcast?.title || 'Podcast',
      albumCover: ep.artwork || data?.podcast?.artwork || null,
      streamUrl,
      source: ep.local_file ? 'Downloaded' : 'Podcast',
      // Surfaced in NowPlaying — show notes + publish date for the
      // expanded view, podcastId so we could refetch if needed.
      podcastId: podcastId,
      episodeDescription: ep.description || '',
      publishedAt: ep.published_at || 0,
      ...(isSubscribed ? {
        podcastEpisodeId: ep.id,
        streamStartOffset: ep.position_s || 0,
      } : {}),
    })
    showToast?.(`▶ ${ep.title || 'Episode'}`)
  }

  async function onDownload(ep) {
    setPendingDownloads(prev => {
      const next = new Set(prev)
      next.add(ep.id)
      return next
    })
    const clearPending = () => {
      setPendingDownloads(prev => {
        if (!prev.has(ep.id)) return prev
        const next = new Set(prev)
        next.delete(ep.id)
        return next
      })
    }
    let r
    try {
      r = await authFetch(`/api/podcasts/episodes/${encodeURIComponent(ep.id)}/download`, { method: 'POST' })
    } catch (e) {
      clearPending()
      showToast?.('Download failed', { kind: 'error' })
      return
    }
    if (!r.ok) {
      clearPending()
      showToast?.('Download failed', { kind: 'error' })
      return
    }
    const body = await r.json().catch(() => ({}))
    if (body.already_local) {
      clearPending()
      showToast?.('Already downloaded')
      load({ id: podcastId })
    }
    // For the normal "job started" case, leave the row in pending state;
    // the effect below clears it as soon as the polling hook surfaces a
    // matching DownloadJob (typically within 1s of the POST returning).
  }

  async function onDeleteDownload(ep) {
    const ok = await askConfirm({
      title: 'Delete downloaded file?',
      message: `Delete the local file for "${ep.title || 'this episode'}"? You can re-download anytime.`,
      confirmLabel: 'Delete file',
      cancelLabel: 'Cancel',
      danger: true,
    })
    if (!ok) return
    const r = await authFetch(`/api/podcasts/episodes/${encodeURIComponent(ep.id)}/download`, { method: 'DELETE' })
    if (r.ok) {
      showToast?.('Removed download')
      load({ id: podcastId })
    }
  }

  async function setPlayed(ep, played) {
    const action = played ? 'mark-played' : 'mark-unplayed'
    const r = await authFetch(`/api/podcasts/episodes/${encodeURIComponent(ep.id)}/${action}`, { method: 'POST' })
    if (r.ok) {
      // Refresh so the pip + progress bar update.
      load({ id: podcastId })
    }
  }

  if (!podcastId && !previewFeed) {
    return (
      <div className={styles.wrap}>
        <div className={styles.body}>
          <EmptyState title="No podcast selected" body="Pick a show from the Podcasts page." />
        </div>
      </div>
    )
  }

  if (data === null && !error) {
    return <div className={styles.wrap}><div className={styles.loading}>Loading…</div></div>
  }

  if (error) {
    return (
      <div className={styles.wrap}>
        <div className={styles.body}>
          <button className={styles.backBtn} onClick={() => setView('podcasts')}>
            <Icon name="arrowL" size={16} /> Back
          </button>
          <EmptyState title="Couldn't load" body={error} />
        </div>
      </div>
    )
  }

  const { podcast, episodes } = data
  const subscribed = !!data.subscribed
  return (
    <div className={styles.wrap}>
      <div className={styles.header}>
        <button className={styles.backBtn} onClick={() => setView('podcasts')}>
          <Icon name="arrowL" size={16} /> Back
        </button>
        <div className={styles.hero}>
          <div className={styles.coverWrap}>
            {podcast.artwork
              ? <img src={podcast.artwork} alt="" className={styles.cover} />
              : <div className={styles.coverFallback}><Icon name="mic" size={48} /></div>}
          </div>
          <div className={styles.heroText}>
            <h1 className={styles.title}>{podcast.title || 'Untitled show'}</h1>
            {podcast.author && <div className={styles.author}>{podcast.author}</div>}
            {podcast.description && (
              <p className={styles.description}>{podcast.description}</p>
            )}
            <div className={styles.heroActions}>
              {!subscribed && (
                <button
                  className={`${styles.actionBtn} ${styles.actionBtnOn}`}
                  onClick={onSubscribe}
                >
                  + Subscribe
                </button>
              )}
              {subscribed && (
                <>
                  {/* Primary actions stay inline: the things a user
                      reaches for on a typical visit. Secondary
                      actions (toggles + irreversible ops) live in
                      the overflow menu below to keep the header
                      uncluttered. */}
                  <button className={styles.actionBtn} onClick={onRefresh} disabled={refreshing}>
                    {refreshing ? 'Refreshing…' : 'Refresh'}
                  </button>
                  <button
                    className={styles.actionBtn}
                    onClick={onDownloadNext}
                    disabled={bulkBusy}
                    title="Download the next 5 unplayed episodes"
                  >
                    Download next 5
                  </button>
                  {podcast.website && (
                    <a className={styles.actionBtn} href={podcast.website} target="_blank" rel="noreferrer">
                      Website
                    </a>
                  )}
                  <PodcastOverflowMenu
                    podcast={podcast}
                    onToggleAutoDownload={onToggleAutoDownload}
                    onToggleAutoCleanup={onToggleAutoCleanup}
                    onMarkAll={onMarkAll}
                    onUnsubscribe={onUnsubscribe}
                    bulkBusy={bulkBusy}
                  />
                </>
              )}
              {!subscribed && podcast.website && (
                <a className={styles.actionBtn} href={podcast.website} target="_blank" rel="noreferrer">
                  Website
                </a>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className={styles.body}>
        {episodes.length > 0 && (
          <div className={styles.filterRow}>
            <input
              type="search"
              inputMode="search"
              enterKeyHint="search"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className={styles.filterInput}
              placeholder="Filter episodes…"
              value={filter}
              onChange={e => setFilter(e.target.value)}
            />
            {filter && (
              <span className={styles.filterCount}>
                {episodes.filter(e => (e.title || '').toLowerCase().includes(debouncedFilter.toLowerCase())).length}
                {' '}/ {episodes.length}
              </span>
            )}
            <button
              type="button"
              className={styles.sortBtn}
              onClick={() => setSortOrder(o => o === 'newest' ? 'oldest' : 'newest')}
              title="Toggle sort order"
            >
              {sortOrder === 'newest' ? 'Newest first ↓' : 'Oldest first ↑'}
            </button>
          </div>
        )}
        {episodes.length === 0
          ? <EmptyState title="No episodes" body="The feed didn't return any playable episodes." />
          : (() => {
            const sorted = episodes
              .filter(ep => !debouncedFilter || (ep.title || '').toLowerCase().includes(debouncedFilter.toLowerCase()))
              .slice()
              .sort((a, b) => sortOrder === 'newest'
                ? (b.pub_date || 0) - (a.pub_date || 0)
                : (a.pub_date || 0) - (b.pub_date || 0))
            const visible = sorted.slice(0, visibleCount)
            const remaining = sorted.length - visible.length
            return <>
            <ul className={styles.episodes}>
              {visible.map(ep => {
                const played = ep.played_at > 0
                const progressPct = (!played && ep.position_s > 0 && ep.duration_s > 0)
                  ? Math.min(100, (ep.position_s / ep.duration_s) * 100)
                  : 0
                const remainingS = (!played && ep.position_s > 0 && ep.duration_s > 0)
                  ? Math.max(0, ep.duration_s - ep.position_s)
                  : 0
                const job = findJob(jobs, 'podcast', ep.id)
                const isDownloading = job && (job.status === 'pending' || job.status === 'downloading' || job.status === 'finalizing')
                const isLocal = !!ep.local_file
                const isNew = newPending.has(ep.id)
                const isPendingClick = pendingDownloads.has(ep.id) && !isDownloading && !isLocal
                return (
                  <li key={ep.id} className={`${styles.episode} ${played ? styles.episodePlayed : ''}`}>
                    <button
                      className={styles.playBtn}
                      onClick={() => onPlay(ep)}
                      aria-label={`Play ${ep.title}`}
                    >
                      <Icon name="play" size={14} />
                    </button>
                    <div className={styles.epMain}>
                      <div className={styles.epTitleRow}>
                        {played && <span className={styles.playedPip} title="Played" />}
                        {isNew && <span className={styles.newPip} title="New episode">NEW</span>}
                        <div className={styles.epTitle}>{ep.title || 'Untitled episode'}</div>
                      </div>
                      <div className={styles.epMeta}>
                        {fmtDate(ep.pub_date)}
                        {ep.duration_s ? ` · ${fmtDuration(ep.duration_s)}` : ''}
                        {remainingS > 0 && ` · ${fmtDuration(remainingS)} left`}
                      </div>
                      {progressPct > 0 && (
                        <div className={styles.progressBar}>
                          <div className={styles.progressFill} style={{ width: `${progressPct}%` }} />
                        </div>
                      )}
                      {ep.description && (
                        <div className={styles.epDesc}>{linkifyDescription(ep.description)}</div>
                      )}
                    </div>
                    {subscribed && (isLocal ? (
                      <button
                        className={`${styles.epAction} ${styles.epActionLocal}`}
                        onClick={() => onDeleteDownload(ep)}
                        title="Downloaded — click to delete"
                      >
                        <Icon name="check" size={14} />
                      </button>
                    ) : isDownloading ? (
                      <div className={styles.epAction} title={`Downloading ${job.pct || 0}%`}>
                        <span className={styles.dlPct}>{Math.round(job.pct || 0)}%</span>
                      </div>
                    ) : isPendingClick ? (
                      <div className={styles.epAction} title="Starting download…">
                        <span className={styles.dlPct}>0%</span>
                      </div>
                    ) : (
                      <button
                        className={styles.epAction}
                        onClick={() => onDownload(ep)}
                        title="Download for offline"
                      >
                        <Icon name="download" size={14} />
                      </button>
                    ))}
                    {subscribed && (
                      <button
                        className={styles.epAction}
                        onClick={() => setPlayed(ep, !played)}
                        title={played ? 'Mark as unplayed' : 'Mark as played'}
                      >
                        <Icon name={played ? 'x' : 'check'} size={14} />
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
            {remaining > 0 && (
              <div className={styles.showMoreRow}>
                <button
                  type="button"
                  className={styles.showMoreBtn}
                  onClick={() => setVisibleCount(c => c + PAGE_SIZE)}
                >
                  Show {Math.min(remaining, PAGE_SIZE)} more · {remaining} remaining
                </button>
              </div>
            )}
            </>
          })()}
      </div>
    </div>
  )
}
