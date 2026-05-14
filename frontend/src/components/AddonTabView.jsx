import { useState, useEffect, useCallback, useRef } from 'react'
import SourcePicker from './SourcePicker'
import * as orchestrator from '../addons/orchestrator'
import styles from './AddonTabView.module.css'

const CACHE_TTL = 60_000
const DEADLINE_MS = 8_000

const _responseCache = new Map()

function cacheGet(k) {
  const e = _responseCache.get(k)
  if (!e) return null
  if (Date.now() - e.ts > CACHE_TTL) { _responseCache.delete(k); return null }
  return e.data
}
function cachePut(k, data) { _responseCache.set(k, { data, ts: Date.now() }) }

async function fetchDeadline(url, init = {}) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), DEADLINE_MS)
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal })
    clearTimeout(t)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return await r.json()
  } finally {
    clearTimeout(t)
  }
}

function sanitize(sections) {
  if (!Array.isArray(sections)) return []
  return sections.slice(0, 20).map(sec => ({
    ...sec,
    items: Array.isArray(sec.items)
      ? sec.items.slice(0, 50).map(item => ({
          ...item,
          image: (typeof item.image === 'string' && item.image.startsWith('https://'))
            ? item.image.slice(0, 2048) : null,
          title: String(item.title || '').slice(0, 80),
          badges: Array.isArray(item.badges)
            ? item.badges.slice(0, 3).map(b => String(b).slice(0, 8)) : [],
        }))
      : [],
  }))
}

export default function AddonTabView({ addon, query: externalQuery }) {
  const tabCfg = addon?.manifest?.ui?.tab || {}
  const addonId = addon?.id
  const base = (addon?.url || '').replace(/\/+$/, '')

  // Iframe-hosted tab page: when the manifest sets ui.tab.page_url,
  // we render the addon's URL in a sandboxed iframe instead of pulling
  // its /ui/catalog JSON. The addon owns its UI completely and talks
  // back to core via the window.audimo postMessage RPC bridge.
  if (tabCfg.page_url && base) {
    return <AddonIframeTab addon={addon} base={base} pageUrl={tabCfg.page_url} />
  }

  const [navStack, setNavStack] = useState([
    { endpoint: '/ui/catalog', title: tabCfg.label || addon?.manifest?.name || '' },
  ])
  const current = navStack[navStack.length - 1]

  // Tab-local search input — only mounted when manifest opts in via
  // tab.search:true. Falls back to externalQuery (the unified search
  // bar) when no local query has been typed.
  const [localQuery, setLocalQuery] = useState('')
  const query = (tabCfg.search ? localQuery : '') || externalQuery || ''

  const [sections, setSections] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [cursor, setCursor] = useState(null)
  const [pickerTrack, setPickerTrack] = useState(null)

  const load = useCallback(async (endpoint, q, cur) => {
    if (!base) return
    const useSearch = !!(q && tabCfg.search && endpoint === '/ui/catalog')
    const cacheKey = `${addonId}::${useSearch ? 'search' : endpoint}::${q || ''}::${cur || ''}`
    const cached = cacheGet(cacheKey)
    if (cached && !cur) { setSections(sanitize(cached.sections)); setCursor(cached.next_cursor || null); return }

    setLoading(true)
    setError(null)
    try {
      let data
      if (useSearch) {
        data = await fetchDeadline(`${base}/ui/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ q, cursor: cur || null, limit: 30 }),
        })
      } else {
        const url = new URL(`${base}${endpoint}`)
        if (cur) url.searchParams.set('cursor', cur)
        data = await fetchDeadline(url.toString())
      }
      const secs = sanitize(data?.sections)
      if (cur) {
        setSections(prev => [...prev, ...secs])
      } else {
        setSections(secs)
        cachePut(cacheKey, data)
      }
      setCursor(data?.next_cursor || null)
    } catch (e) {
      setError(e.name === 'AbortError' ? 'Timed out' : (e.message || 'Failed to load'))
    } finally {
      setLoading(false)
    }
  }, [base, addonId, tabCfg.search])

  useEffect(() => {
    setSections([])
    setCursor(null)
    load(current.endpoint, query, null)
  }, [current.endpoint, query, load])

  const handleSelect = useCallback((item) => {
    const sel = item?.on_select
    if (!sel || sel.type === 'noop') return
    if (sel.type === 'open') {
      const ep = `/ui/catalog/${sel.section_id || 'item'}/${encodeURIComponent(sel.id || '')}`
      setNavStack(s => [...s, { endpoint: ep, title: item.title || '' }])
    } else if (sel.type === 'browse') {
      if (typeof sel.endpoint === 'string')
        setNavStack(s => [...s, { endpoint: sel.endpoint, title: sel.title || item.title || '' }])
    } else if (sel.type === 'play') {
      setPickerTrack({
        title: sel.track?.title || item.title || '',
        artist: sel.track?.artist || item.subtitle || '',
        album: sel.track?.album || '',
        kind: sel.track?.kind || tabCfg.default_kind || 'music',
      })
    } else if (sel.type === 'open_url') {
      if (typeof sel.url === 'string' && sel.url.startsWith('https://'))
        window.open(sel.url, '_blank', 'noopener')
    }
  }, [tabCfg.default_kind])

  const goBack = () => setNavStack(s => s.slice(0, -1))

  const pageTitle = navStack.length > 1 ? current.title : (tabCfg.label || addon?.manifest?.name || '')

  return (
    <div className={styles.wrap}>
      <div className={styles.header}>
        {navStack.length > 1 && (
          <button className={styles.backBtn} onClick={goBack}>← Back</button>
        )}
        <h1 className={styles.title}>{pageTitle}</h1>
      </div>

      {tabCfg.search && navStack.length === 1 && (
        <div className={styles.searchWrap}>
          <input
            type="search"
            inputMode="search"
            enterKeyHint="search"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className={styles.searchInput}
            placeholder={tabCfg.search_placeholder || 'Search…'}
            value={localQuery}
            onChange={e => setLocalQuery(e.target.value)}
          />
        </div>
      )}

      {loading && sections.length === 0 && (
        <div className={styles.loading}>Loading…</div>
      )}
      {!loading && error && sections.length === 0 && (
        <div className={styles.errorChip}>
          {error} —{' '}
          <button className={styles.retryBtn} onClick={() => load(current.endpoint, query, null)}>
            retry
          </button>
        </div>
      )}

      {sections.map(sec => (
        <div key={sec.id || sec.title} className={styles.section}>
          {sec.title && (
            <div className={styles.sectionHeader}>
              <span className={styles.sectionTitle}>{sec.title}</span>
            </div>
          )}
          {sec.layout === 'grid'
            ? <GridSection items={sec.items} onSelect={handleSelect} />
            : <ListSection items={sec.items} onSelect={handleSelect} />
          }
        </div>
      ))}

      {cursor && !loading && (
        <button className={styles.loadMore} onClick={() => load(current.endpoint, query, cursor)}>
          Load more
        </button>
      )}
      {loading && sections.length > 0 && (
        <div className={styles.loadingMore}>Loading…</div>
      )}

      {pickerTrack && (
        <SourcePicker track={pickerTrack} onClose={() => setPickerTrack(null)} />
      )}
    </div>
  )
}

function GridSection({ items, onSelect }) {
  return (
    <div className={styles.grid}>
      {items.map(item => (
        <div
          key={item.id}
          className={styles.gridCard}
          onClick={() => onSelect(item)}
          role="button"
          tabIndex={0}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(item) } }}
        >
          <div className={styles.gridCover}>
            {item.image
              ? <img src={item.image} alt="" className={styles.coverImg} loading="lazy" />
              : <span className={styles.monogram}>{(item.title || '?')[0].toUpperCase()}</span>
            }
            {item.badges.length > 0 && (
              <div className={styles.badges}>
                {item.badges.map(b => <span key={b} className={styles.badge}>{b}</span>)}
              </div>
            )}
          </div>
          <div className={styles.gridTitle}>{item.title}</div>
          {item.subtitle && <div className={styles.gridSub}>{item.subtitle}</div>}
        </div>
      ))}
    </div>
  )
}

function ListSection({ items, onSelect }) {
  return (
    <div className={styles.list}>
      {items.map(item => (
        <div
          key={item.id}
          className={styles.listRow}
          onClick={() => onSelect(item)}
          role="button"
          tabIndex={0}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(item) } }}
        >
          <div className={styles.listThumb}>
            {item.image
              ? <img src={item.image} alt="" className={styles.thumbImg} loading="lazy" />
              : <span className={styles.thumbMonogram}>{(item.title || '?')[0].toUpperCase()}</span>
            }
          </div>
          <div className={styles.listMeta}>
            <div className={styles.listTitle}>{item.title}</div>
            {item.subtitle && <div className={styles.listSub}>{item.subtitle}</div>}
          </div>
          {item.badges.length > 0 && (
            <div className={styles.listBadges}>
              {item.badges.map(b => <span key={b} className={styles.badge}>{b}</span>)}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Iframe-hosted addon tab + window.audimo RPC bridge ────────────
//
// When an addon's manifest declares `ui.tab.page_url`, core renders
// the addon's URL in a sandboxed iframe and exposes a `window.audimo`
// API to it via postMessage. Methods:
//   • listAddons() → [{id, capabilities, enabled, label}]
//   • acquireTrack({title, artist, album, kind, policy}) → async iter
//   • getLibraryStatus({title, artist}) → "present" | "absent"
//   • cancel(rpc_id) → aborts a streaming acquireTrack
//
// Security: messages are only accepted from this exact iframe's
// contentWindow; replies are posted with the addon's origin as
// targetOrigin (no '*'). The iframe itself runs with the sandbox
// attribute set to "allow-scripts allow-forms" — no same-origin
// access, so a hostile addon page can't read the parent's cookies
// or localStorage. The addon's URL secrets stay in the parent only.
function AddonIframeTab({ addon, base, pageUrl }) {
  const iframeRef = useRef(null)
  const activeIters = useRef(new Map())  // rpc_id -> async iterator (for cancel)
  const iframeOrigin = (() => {
    try { return new URL(base).origin } catch { return null }
  })()
  const iframeSrc = `${base}${pageUrl.startsWith('/') ? pageUrl : '/' + pageUrl}`

  useEffect(() => {
    if (!iframeOrigin) return

    const post = (msg) => {
      const w = iframeRef.current?.contentWindow
      if (w) w.postMessage(msg, iframeOrigin)
    }

    const reply = (rpc_id, payload) => post({ __audimo: 1, rpc_id, ...payload })

    const handleStream = async (rpc_id, method, args) => {
      try {
        let iter
        if (method === 'acquireTrack') {
          iter = orchestrator.acquireTrack(args || {})
        } else {
          reply(rpc_id, { error: `unknown stream method: ${method}` })
          return
        }
        activeIters.current.set(rpc_id, iter)
        try {
          for await (const ev of iter) {
            reply(rpc_id, { event: ev })
          }
          reply(rpc_id, { done: true })
        } finally {
          activeIters.current.delete(rpc_id)
        }
      } catch (e) {
        reply(rpc_id, { error: e?.message || String(e) })
      }
    }

    const handleCall = async (rpc_id, method, args) => {
      try {
        let result
        switch (method) {
          case 'listAddons':
            result = orchestrator.listAddonsForIframe()
            break
          case 'getLibraryStatus':
            // Library presence check — defer to a future revision once
            // we have a stable artist+title match helper. For now return
            // 'unknown' so addons don't gate behavior on it.
            result = 'unknown'
            break
          default:
            reply(rpc_id, { error: `unknown method: ${method}` })
            return
        }
        reply(rpc_id, { result })
      } catch (e) {
        reply(rpc_id, { error: e?.message || String(e) })
      }
    }

    const onMessage = (e) => {
      // Strict origin + source check — only this iframe can talk to us.
      if (e.origin !== iframeOrigin) return
      if (e.source !== iframeRef.current?.contentWindow) return
      const m = e.data
      if (!m || m.__audimo !== 1) return

      // Iframe announced it's ready (handshake). No action needed today.
      if (m.ready) return

      // Fire-and-forget: addon asks host to open a URL externally. Use
      // Tauri's shell.open when available so it lands in the user's real
      // browser (system OAuth flows behave normally); fall back to a
      // plain window.open in browser-only mode. Validated above (only
      // this iframe's origin can send these).
      if (m.method === 'openExternal' && typeof m.url === 'string') {
        const url = m.url
        if (!/^https?:\/\//i.test(url)) return
        try {
          if (window.__TAURI__ && window.__TAURI__.shell && window.__TAURI__.shell.open) {
            window.__TAURI__.shell.open(url)
          } else {
            window.open(url, '_blank', 'noopener,noreferrer')
          }
        } catch {}
        return
      }

      if (m.cancel && m.rpc_id) {
        const iter = activeIters.current.get(m.rpc_id)
        if (iter && typeof iter.return === 'function') {
          iter.return().catch(() => {})
        }
        return
      }

      if (!m.rpc_id || !m.method) return

      if (m.method === 'acquireTrack') {
        handleStream(m.rpc_id, m.method, m.args)
      } else {
        handleCall(m.rpc_id, m.method, m.args)
      }
    }

    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
      // Cancel any in-flight streams on unmount.
      for (const iter of activeIters.current.values()) {
        try { iter.return && iter.return() } catch {}
      }
      activeIters.current.clear()
    }
  }, [iframeOrigin])

  return (
    <div className={styles.wrap}>
      <iframe
        ref={iframeRef}
        src={iframeSrc}
        title={addon?.manifest?.name || addon?.id || 'Addon'}
        className={styles.iframe}
        sandbox="allow-scripts allow-forms allow-popups"
        referrerPolicy="no-referrer"
      />
    </div>
  )
}

// Standalone search fan-out helper — used by SearchView to query all
// ui.tab addons that have search:true in parallel. Returns an array
// of { addon, sections } objects. Timeout per addon is DEADLINE_MS.
export async function fanOutSearch(addons, q) {
  if (!q || !addons.length) return []
  const results = await Promise.allSettled(
    addons.map(async (addon) => {
      const base = (addon.url || '').replace(/\/+$/, '')
      const data = await fetchDeadline(`${base}/ui/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q, limit: 20 }),
      })
      return { addon, sections: sanitize(data?.sections || []) }
    })
  )
  return results
    .filter(r => r.status === 'fulfilled' && r.value.sections.length > 0)
    .map(r => r.value)
}
