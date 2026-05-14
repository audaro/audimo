import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import * as registry from './addons/registry'

// NOTE: We deliberately do NOT import authFetch from './api' here —
// api.js already imports useStore from this file, and pulling authFetch
// back in would create a circular import. ESM resolves cycles, but the
// imported binding can read as `undefined` during module init, which
// silently broke the addon seed migration. We inline the auth header
// instead.

export const useStore = create(
  persist(
    (set, get) => ({
      // ── Auth ─────────────────────────────────────────────────────
      token: null,
      user: null,
      setToken: (token) => set({ token }),
      setUser: (user) => set({ user }),
      logout: () => set({ token: null, user: null, apiKey: '', playlists: [], view: 'home' }),

      // ── API Key ──────────────────────────────────────────────────
      apiKey: '',
      setApiKey: (key) => set({ apiKey: key }),

      // ── Player ───────────────────────────────────────────────────
      queue: [],
      queueIdx: -1,
      isPlaying: false,
      currentTrack: null,
      shuffle: false,
      // Preferred audio quality — bias the source picker's verdict
      // toward FLAC / 320 / any. Doesn't filter results; just nudges
      // ranking. 'any' keeps the addon-emitted instant → verified →
      // seeders order.
      audioQualityPref: 'any', // 'flac' | '320' | 'any'
      setAudioQualityPref: (v) => set({ audioQualityPref: v }),

      // Default playback source. When set to an installed addon's id,
      // clicking a search result skips the source picker entirely:
      // we resolve sources from this addon only, pick the first hit,
      // and play it. The saved row in the user's library only happens
      // when they explicitly click the + button on a search row.
      // Empty string = legacy behaviour (open SourcePicker on click,
      // auto-save after play).
      defaultSourceAddonId: '',
      setDefaultSourceAddonId: (v) => set({ defaultSourceAddonId: v || '' }),
      // Theme: 'dark' | 'light'. Applied to <html data-theme="…">
      // from App.jsx — index.css drives variable swaps via the
      // attribute. Persisted alongside other prefs.
      theme: 'dark',
      setTheme: (v) => set({ theme: v === 'light' ? 'light' : 'dark' }),

      // Crossfade duration in seconds (0 = off). Moved out of the
      // Player's main transport row into Settings → Playback in 0.4
      // because it was visual clutter next to fundamental controls
      // and most users never touch it.
      crossfadeSec: 2,
      setCrossfadeSec: (n) => {
        const v = Number(n)
        set({ crossfadeSec: [0, 2, 4].includes(v) ? v : 0 })
      },

      // HTMLAudioElement.setSinkId target. '' = system default
      // (Chrome / Safari / WKWebView treat ''/'default' identically).
      // Player applies this on every src change so a USB DAC or
      // AirPlay device picked in Settings → Playback stays selected
      // across track changes.
      outputDeviceId: '',
      setOutputDeviceId: (id) => set({ outputDeviceId: (id || '').toString() }),
      shuffleOrder: [],   // indices of queue in shuffle order
      playSeq: 0,         // incremented on every explicit playNow so Player re-fires even for the same URL
      // Mobile-only: when true, the full-bleed Now Playing screen
      // overlays everything. Tap the mini-player to expand, tap the
      // ▾ chevron to collapse. Desktop ignores this flag.
      nowPlayingExpanded: false,
      setNowPlayingExpanded: (v) => set({ nowPlayingExpanded: !!v }),

      // Playback progress mirrored from Player.jsx's <audio> element.
      // Lifted into the store so NowPlaying (mobile full-bleed) can
      // read the same scrubber state without poking the DOM.
      progress: 0,
      duration: 0,

      // Per-audiobook resume positions + durations.
      //
      // Keyed by a stable `bookKey` (the library row's id /
      // bookId(title,author) — NOT the streamUrl, since the same
      // saved book can be played via two different streamUrls
      // depending on whether the local-file fast path or the
      // cache.resolve path runs). The Player accepts a `bookKey` on
      // the track and falls back to streamUrl when absent (e.g. for
      // ad-hoc playback from search results).
      //
      // `audiobookPositions` is updated on a 5s heartbeat from
      // <audio>.timeupdate (see Player.jsx) — too frequent and we'd
      // thrash localStorage; too coarse and a reload loses up to a
      // minute. `audiobookDurations` is written once per track on
      // onLoadedMetadata. Together they let the AudiobooksView card
      // render a thin progress bar (position / duration) without
      // needing a separate book-level metadata cache.
      audiobookPositions: {},
      audiobookDurations: {},
      setAudiobookPosition: (key, seconds) => {
        if (!key) return
        const v = Math.max(0, Math.floor(seconds || 0))
        set((s) => ({ audiobookPositions: { ...s.audiobookPositions, [key]: v } }))
      },
      setAudiobookDuration: (key, seconds) => {
        if (!key) return
        const v = Math.max(0, Math.floor(seconds || 0))
        if (v <= 0) return
        set((s) => {
          // Avoid thrashing localStorage — only write when the value
          // actually changes (audio.duration is stable per track).
          if (s.audiobookDurations[key] === v) return s
          return { audiobookDurations: { ...s.audiobookDurations, [key]: v } }
        })
      },
      clearAudiobookPosition: (key) => {
        if (!key) return
        set((s) => {
          const next = { ...s.audiobookPositions }
          delete next[key]
          return { audiobookPositions: next }
        })
      },
      setProgress: (progress, duration) => set({
        progress: progress || 0,
        duration: duration || 0,
      }),
      // Seek bridge: NowPlaying calls seekTo(seconds); Player.jsx's
      // useEffect on seekRequest applies it to the live audio element.
      // Counter forces re-fire even when consecutive seeks land on
      // the same target value.
      seekRequest: 0,
      seekTarget: 0,
      seekTo: (seconds) => set((s) => ({
        seekTarget: Math.max(0, seconds || 0),
        seekRequest: s.seekRequest + 1,
      })),

      setIsPlaying: (v) => set({ isPlaying: v }),

      setShuffle: (v) => set((s) => {
        if (v) {
          // Build shuffle order excluding current track, then shuffle the rest
          const indices = [...Array(s.queue.length).keys()].filter(i => i !== s.queueIdx)
          for (let i = indices.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [indices[i], indices[j]] = [indices[j], indices[i]]
          }
          // Put current track first in shuffle order
          const order = s.queueIdx >= 0 ? [s.queueIdx, ...indices] : indices
          return { shuffle: true, shuffleOrder: order }
        }
        return { shuffle: false, shuffleOrder: [] }
      }),

      addToQueue: (track) => set((s) => {
        const queue = [...s.queue, track]
        const shuffleOrder = s.shuffle
          ? [...s.shuffleOrder, queue.length - 1]
          : []
        return { queue, shuffleOrder }
      }),

      // Move queue[from] to position `to`. queueIdx (the currently
       // playing index) shifts so the same *track* stays selected:
       // moving the playing track itself updates the index to its
       // new home; otherwise indices between `from` and `to` shift
       // by one to compensate. Shuffle order isn't recomputed —
       // shuffle indices remain valid against the moved queue.
      reorderQueue: (from, to) => set((s) => {
        if (from === to) return {}
        const q = [...s.queue]
        if (from < 0 || from >= q.length || to < 0 || to >= q.length) return {}
        const [moved] = q.splice(from, 1)
        q.splice(to, 0, moved)
        let idx = s.queueIdx
        if (s.queueIdx === from) idx = to
        else if (from < s.queueIdx && to >= s.queueIdx) idx = s.queueIdx - 1
        else if (from > s.queueIdx && to <= s.queueIdx) idx = s.queueIdx + 1
        return { queue: q, queueIdx: idx }
      }),

      removeFromQueue: (i) => set((s) => {
        const q = [...s.queue]
        q.splice(i, 1)
        const newIdx = s.queueIdx > i ? s.queueIdx - 1 : s.queueIdx
        const shuffleOrder = s.shuffleOrder
          .filter(x => x !== i)
          .map(x => x > i ? x - 1 : x)
        return { queue: q, queueIdx: newIdx, shuffleOrder }
      }),

      clearQueue: () => set((s) => {
        // Preserve the currently playing track so playback continues; only
        // wipe the up-next list. If nothing is playing, fully clear.
        if (s.currentTrack) {
          return { queue: [s.currentTrack], queueIdx: 0, shuffleOrder: [] }
        }
        return { queue: [], queueIdx: -1, currentTrack: null, shuffleOrder: [] }
      }),

      // Load an entire queue at once and start playing at a given index (shuffle-aware)
      loadQueue: (tracks, startIdx = 0, shuffled = false) => {
        if (!tracks.length) return
        let shuffleOrder = []
        let playIdx = startIdx
        if (shuffled) {
          // Fisher-Yates shuffle of all indices
          const indices = [...Array(tracks.length).keys()]
          for (let i = indices.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [indices[i], indices[j]] = [indices[j], indices[i]]
          }
          shuffleOrder = indices
          playIdx = indices[0] // start at first shuffled position
        }
        const currentTrack = tracks[playIdx] || null
        set({ queue: tracks, queueIdx: playIdx, currentTrack, shuffle: shuffled, shuffleOrder, isPlaying: true })
      },

      setQueueIdx: (i) => set((s) => ({ queueIdx: i, currentTrack: s.queue[i] || null })),

      // Repeat mode — cycles off → queue → one. Player.jsx checks
      // `repeatMode === 'one'` in handleEnded() and just rewinds the
      // current track instead of advancing. nextIdx() handles 'queue'
      // by wrapping back to 0.
      repeatMode: 'off',
      cycleRepeatMode: () => set((s) => ({
        repeatMode: s.repeatMode === 'off' ? 'queue'
          : s.repeatMode === 'queue' ? 'one' : 'off',
      })),

      // Get next index respecting shuffle + repeat
      nextIdx: () => {
        const s = get()
        if (s.repeatMode === 'one') return s.queueIdx
        if (s.shuffle && s.shuffleOrder.length > 0) {
          const pos = s.shuffleOrder.indexOf(s.queueIdx)
          const nextPos = pos + 1
          if (nextPos < s.shuffleOrder.length) return s.shuffleOrder[nextPos]
          return s.repeatMode === 'queue' ? s.shuffleOrder[0] : -1
        }
        if (s.queueIdx < s.queue.length - 1) return s.queueIdx + 1
        return s.repeatMode === 'queue' && s.queue.length > 0 ? 0 : -1
      },

      // Get prev index respecting shuffle
      prevIdx: () => {
        const s = get()
        if (s.shuffle && s.shuffleOrder.length > 0) {
          const pos = s.shuffleOrder.indexOf(s.queueIdx)
          if (pos > 0) return s.shuffleOrder[pos - 1]
          return s.queueIdx
        }
        return s.queueIdx > 0 ? s.queueIdx - 1 : s.queueIdx
      },

      playNow: (track) => set((s) => {
        const playSeq = s.playSeq + 1
        const exists = s.queue.findIndex(t => t.streamUrl === track.streamUrl)
        if (exists >= 0) return { queueIdx: exists, currentTrack: track, isPlaying: true, playSeq }
        const queue = [track, ...s.queue]
        const shuffleOrder = s.shuffle ? [0, ...s.shuffleOrder.map(i => i + 1)] : []
        return { queue, queueIdx: 0, currentTrack: track, shuffleOrder, isPlaying: true, playSeq }
      }),

      updateQueueItem: (idx, updates) => set((s) => ({
        queue: s.queue.map((t, i) => i === idx ? { ...t, ...updates } : t),
        currentTrack: s.queueIdx === idx ? { ...s.currentTrack, ...updates } : s.currentTrack,
      })),

      // ── Playlists ────────────────────────────────────────────────
      // playlist: { id, name, tracks: [{key, track_title, track_artist, track_album, albumCover, type}] }
      playlists: [],

      setPlaylists: (playlists) => set({ playlists }),

      createPlaylist: (name, id) => {
        const playlistId = id || `pl_${Date.now()}`
        set((s) => ({ playlists: [...s.playlists, { id: playlistId, name, tracks: [] }] }))
        return playlistId
      },

      deletePlaylist: (id) => set((s) => ({
        playlists: s.playlists.filter(p => p.id !== id)
      })),

      renamePlaylist: (id, name) => set((s) => ({
        playlists: s.playlists.map(p => p.id === id ? { ...p, name } : p)
      })),

      addTrackToPlaylist: (playlistId, track) => set((s) => ({
        playlists: s.playlists.map(p => {
          if (p.id !== playlistId) return p
          // Don't add duplicates
          if (p.tracks.find(t => t.key === track.key)) return p
          return { ...p, tracks: [...p.tracks, track] }
        })
      })),

      removeTrackFromPlaylist: (playlistId, key) => set((s) => ({
        playlists: s.playlists.map(p =>
          p.id === playlistId
            ? { ...p, tracks: p.tracks.filter(t => t.key !== key) }
            : p
        )
      })),

      reorderPlaylist: (playlistId, fromIdx, toIdx) => set((s) => ({
        playlists: s.playlists.map(p => {
          if (p.id !== playlistId) return p
          const tracks = [...p.tracks]
          const [moved] = tracks.splice(fromIdx, 1)
          tracks.splice(toIdx, 0, moved)
          return { ...p, tracks }
        })
      })),

      // ── Cached track keys ────────────────────────────────────────
      cachedKeys: {},
      setCachedKeys: (keys) => set({ cachedKeys: keys }),
      mergeCachedKeys: (keys) => set((s) => ({ cachedKeys: { ...s.cachedKeys, ...keys } })),

      // ── View ─────────────────────────────────────────────────────
      view: 'home',
      setView: (v) => set({ view: v }),

      // Bumped when ⌘K (or Ctrl+K) fires anywhere in the app — the
      // SearchView watches this and focus()es the input on every
      // tick. Counter rather than boolean so a second ⌘K while already
      // on Search still re-focuses (and selects) the field.
      searchFocusKick: 0,
      kickSearchFocus: () => set((s) => ({ view: 'search', searchFocusKick: s.searchFocusKick + 1 })),

      // Audiobook detail page — id of the book the user opened.
      // Set by AudiobooksView/HomeView card click → navigates to
      // view='audiobook'. Cleared on back-button.
      audiobookDetailId: null,
      openAudiobookDetail: (id) => set({ audiobookDetailId: id, view: 'audiobook' }),

      // Podcast detail page — id of the show the user opened. Same
      // pattern as audiobookDetailId; the detail view fetches its own
      // episodes from /api/podcasts/{id}.
      //
      // `podcastPreviewFeed` is a parallel slot for "I clicked a
      // search result, just show me the feed without subscribing."
      // When set (and podcastDetailId is null), the detail view
      // fetches via /api/podcasts/preview and renders a Subscribe
      // affordance instead of subscribe-only chrome.
      podcastDetailId: null,
      podcastPreviewFeed: null,
      openPodcastDetail: (id) => set({ podcastDetailId: id, podcastPreviewFeed: null, view: 'podcast' }),
      openPodcastPreview: (feedUrl) => set({ podcastPreviewFeed: feedUrl, podcastDetailId: null, view: 'podcast' }),

      // ── Caching notification ────────────────────────────────────
      cachingMsg: null,
      setCachingMsg: (msg) => set({ cachingMsg: msg }),

      // ── Cache version (bumped whenever new audio is added to "My Music").
      //    Library views watch this and reload their list. ──
      cacheVersion: 0,
      bumpCacheVersion: () => set((s) => ({ cacheVersion: s.cacheVersion + 1 })),

      // ── Recently Played ──────────────────────────────────────────
      recentlyPlayed: [],
      logPlay: (track) => set((s) => ({
        recentlyPlayed: [
          { title: track.title, artist: track.artist, albumCover: track.albumCover || null, source: track.source || '', playedAt: Date.now() },
          ...s.recentlyPlayed.filter(t => !(t.title === track.title && t.artist === track.artist)),
        ].slice(0, 200),
      })),

      // ── Recent Searches ──────────────────────────────────────────
      recentSearches: [],
      addRecentSearch: (q) => set((s) => ({
        recentSearches: [q, ...s.recentSearches.filter(r => r.toLowerCase() !== q.toLowerCase())].slice(0, 10),
      })),
      removeRecentSearch: (q) => set((s) => ({
        recentSearches: s.recentSearches.filter(r => r !== q),
      })),

      // ── Addons (device-local) ────────────────────────────────────
      // Mirror of registry.list() kept in Zustand so React components can
      // re-render reactively. The registry itself is the source of truth
      // (localStorage); we subscribe to its change events and re-pull.
      addons: [],
      // Per-addon liveness tracking. Map<addonId, {online: bool,
      // lastChecked: epoch_ms, error?: string}>. Populated by
      // `probeAddonHealth` (call sites: AddonsView mount + slow
      // poller). Consumed by AddonsView's offline banner and any
      // future "indexers offline" surface. Stored as a plain object
      // so the persist middleware doesn't choke on a Map.
      addonHealth: {},
      setAddonHealth: (id, status) => set((s) => ({
        addonHealth: { ...s.addonHealth, [id]: { ...status, lastChecked: Date.now() } },
      })),
      probeAddonHealth: async () => {
        const list = (get().addons || []).filter(a => a.enabled !== false && a.url)
        const setAddonHealth = get().setAddonHealth
        await Promise.allSettled(list.map(async (a) => {
          try {
            const ctrl = new AbortController()
            const t = setTimeout(() => ctrl.abort(), 4000)
            const r = await fetch(
              a.url.replace(/\/+$/, '') + '/manifest.json',
              { signal: ctrl.signal, cache: 'no-store' },
            )
            clearTimeout(t)
            setAddonHealth(a.id, { online: r.ok, error: r.ok ? undefined : `HTTP ${r.status}` })
          } catch (e) {
            setAddonHealth(a.id, {
              online: false,
              error: e?.name === 'AbortError' ? 'timeout' : (e?.message || 'unreachable'),
            })
          }
        }))
      },
      _addonsUnsub: null,
      _addonsLoaded: false,

      // Initialize addon state. Called once at app mount (App.jsx). Reads
      // current registry, subscribes to changes, and — only on first run
      // when the local registry is empty — seeds from the backend's
      // one-shot `/api/addons/_export_for_device` endpoint to migrate
      // pre-device-as-client users without making them re-paste URLs.
      loadAddons: async () => {
        if (get()._addonsLoaded) return
        set({ _addonsLoaded: true })

        // Hydrate the encrypted-at-rest registry before any sync read.
        // Failure leaves _cache=null and registry.list() returns [] —
        // the user sees no addons until the next reload, which is fine.
        try { await registry.init() } catch (e) {
          console.warn('[store] registry.init failed:', e?.message || e)
        }

        // LAN-trust path bootstrap: if the registry is empty AND the
        // backend lets us in (LAN trust on, private-IP peer), pull
        // the user's addon list from /api/addons/_export_for_device.
        // This is what makes "open the URL on my phone, library +
        // addons just appear" work without a pair handshake.
        if ((registry.list() || []).length === 0) {
          try {
            const { authFetch, apiUrl } = await import('./api')
            const r = await authFetch(apiUrl('/api/addons/_export_for_device'))
            if (r.ok) {
              const d = await r.json()
              if (Array.isArray(d?.addons) && d.addons.length > 0) {
                registry.replaceAll(d.addons)
                try { await registry.flush() } catch {}
              }
            }
          } catch (e) {
            // Best-effort: if the endpoint is unreachable or 401s
            // (no LAN trust + no api key), fall through to the
            // existing pair flow.
            console.warn('[store] addon bootstrap skipped:', e?.message || e)
          }
        }

        // Keep Zustand mirror in sync with localStorage.
        const sync = () => set({ addons: registry.list() })
        const unsub = registry.subscribe(sync)
        set({ _addonsUnsub: unsub })
        sync()

        // ── Cross-device sync ─────────────────────────────────────
        // Wire registry mutations to write through to the backend
        // (POST/DELETE /api/addons). The backend already persists
        // these, and other devices pull on boot — so installing on
        // desktop shows up on the phone after a reload.
        const apiKey = get().apiKey || get().token || ''
        const authHeaders = () => {
          const k = get().apiKey || get().token || ''
          return k ? { 'X-API-Key': k } : {}
        }
        const { apiUrl } = await import('./api')
        registry.setWriteThrough(async ({ op, url, id, enabled, settings }) => {
          const h = { 'Content-Type': 'application/json', ...authHeaders() }
          if (op === 'install') {
            const r = await fetch(apiUrl('/api/addons'), {
              method: 'POST', headers: h, body: JSON.stringify({ url }),
            })
            if (!r.ok) throw new Error(`HTTP ${r.status}`)
          } else if (op === 'remove') {
            const r = await fetch(apiUrl(`/api/addons/${encodeURIComponent(id)}`), {
              method: 'DELETE', headers: authHeaders(),
            })
            if (!r.ok) throw new Error(`HTTP ${r.status}`)
          } else if (op === 'setEnabled') {
            const r = await fetch(apiUrl(`/api/addons/${encodeURIComponent(id)}/toggle`), {
              method: 'POST', headers: h,
              body: JSON.stringify({ enabled }),
            })
            if (!r.ok) throw new Error(`HTTP ${r.status}`)
          } else if (op === 'patchSettings') {
            const r = await fetch(apiUrl(`/api/addons/${encodeURIComponent(id)}/settings`), {
              method: 'PUT', headers: h,
              body: JSON.stringify(settings || {}),
            })
            if (!r.ok) throw new Error(`HTTP ${r.status}`)
          }
        })

        // ── One-shot purge of auto-installed loopback sidecars ────
        // Earlier builds auto-installed bundled sidecars (audimo-aio,
        // audimo-indexers) into the registry on every boot. Policy
        // changed: addon list is user-driven, fresh installs start
        // empty. Drop any leftover loopback entries from existing
        // installs once. Loopback-URL is the discriminator — a user
        // who configured a remote audimo-aio at e.g. aio.tunnel.com
        // has a non-loopback URL and is unaffected.
        const PURGE_FLAG = 'tunnel:migration:purged-bundled-sidecars-v1'
        if (!localStorage.getItem(PURGE_FLAG)) {
          const isLoopback = (urlStr) => {
            try {
              const h = new URL(urlStr).hostname
              return h === '127.0.0.1' || h === 'localhost' || h === '::1'
            } catch { return false }
          }
          let purgeOk = true
          for (const a of registry.list()) {
            if (isLoopback(a.url)) {
              try {
                await registry.remove(a.id)
                console.log(`[store] purged auto-installed loopback addon: ${a.id}`)
              } catch (e) {
                // Backend DELETE failed — local revert restored the
                // entry; we'll retry next boot.
                console.warn(`[store] purge failed for ${a.id}; will retry next boot:`, e?.message || e)
                purgeOk = false
              }
            }
          }
          if (purgeOk) {
            try { localStorage.setItem(PURGE_FLAG, '1') } catch {}
          }
        }

        // ── Boot-time pull ────────────────────────────────────────
        // Always reconcile from the backend on boot so a device sees
        // mutations made on a different device. Backend is treated
        // as the source of truth — local state is a cache. If the
        // pull fails (offline, no token), the localStorage copy is
        // used as-is.
        try {
          const r = await fetch(apiUrl('/api/addons/_export_for_device'), {
            headers: authHeaders(),
          })
          if (r.ok) {
            const d = await r.json()
            if (Array.isArray(d.addons)) {
              const local = registry.list()
              const remote = d.addons
              // Only replace if the remote list differs — avoids
              // gratuitously bumping installedAt timestamps and
              // notifying subscribers when nothing changed. Compare
              // by (id, url, enabled) since those are the bits the
              // backend can mutate.
              const sig = list => list
                .map(a => `${a.id}|${a.url}|${a.enabled !== false ? 1 : 0}`)
                .sort().join('\n')
              if (sig(local) !== sig(remote)) {
                registry.replaceAll(remote)
                console.log(`[store] reconciled ${remote.length} addon(s) from backend`)
              }
            }
          } else if (r.status !== 401 && r.status !== 403) {
            console.warn('[store] addon sync pull: HTTP', r.status)
          }
        } catch (e) {
          // Offline / no backend — fall through to localStorage. No
          // toast: the registry already has whatever was last seen.
          console.warn('[store] addon sync pull failed:', e.message)
        }

        // ── Sidecar port reconciliation (desktop only) ──────────────
        // When the Tauri runtime restarts a catalog-installed sidecar
        // on a different port (old port was in use), the backend's
        // stored URL goes stale. Detect the mismatch here and patch
        // both the local registry and the backend. Runs after the
        // backend pull so we're comparing against the freshest data.
        if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) {
          import('./desktop').then(async (desktop) => {
            try {
              const running = await desktop.addonList()
              for (const sidecar of (running || [])) {
                if (!sidecar.running || !sidecar.url) continue
                const existing = registry.get(sidecar.id)
                if (!existing) continue
                const existingOrigin = new URL(existing.url).origin
                const newOrigin = new URL(sidecar.url).origin
                if (existingOrigin !== newOrigin) {
                  try {
                    await registry.patchUrl(sidecar.id, newOrigin)
                    console.log(`[store] sidecar ${sidecar.id} port updated: ${existingOrigin} → ${newOrigin}`)
                  } catch (e) {
                    // Backend sync of the new port failed — local
                    // reverted to the stale URL. Resolve calls to
                    // this sidecar will fail until next reconcile;
                    // not worth a toast since this is best-effort.
                    console.warn(`[store] patchUrl failed for ${sidecar.id}:`, e?.message || e)
                  }
                }
              }
            } catch (e) {
              console.warn('[store] sidecar port reconcile failed:', e?.message || e)
            }
          }).catch(() => {})
        }

        // Boot-time disk reclaim removed. Per user feedback: the
        // sweep is destructive (deletes local files) and shouldn't
        // run unprompted on every launch. The same operation is
        // still available via Settings → Advanced → Reclaim disk.
      },

      // ── Toast ────────────────────────────────────────────────────
      // `showToast(msg)`                       — 3 s, default kind
      // `showToast(msg, 5000)`                 — explicit duration (legacy)
      // `showToast(msg, { kind: 'error' })`    — error kind, 5 s default
      // `showToast(msg, { kind, duration })`   — both
      //
      // Previously the second arg was strictly a number — call sites
      // passing `{kind:'error'}` coerced to NaN and the error toasts
      // dismissed instantly. Accepts either shape now.
      toast: null,
      toastKind: 'info',  // 'info' | 'error'
      _toastTimer: null,
      showToast: (msg, opts) => {
        let duration = 3000
        let kind = 'info'
        if (typeof opts === 'number' && Number.isFinite(opts)) {
          duration = opts
        } else if (opts && typeof opts === 'object') {
          if (opts.kind === 'error') {
            kind = 'error'
            duration = 5000
          }
          if (typeof opts.duration === 'number' && Number.isFinite(opts.duration)) {
            duration = opts.duration
          }
        }
        const prev = get()._toastTimer
        if (prev) clearTimeout(prev)
        const timer = setTimeout(
          () => set({ toast: null, toastKind: 'info', _toastTimer: null }),
          duration,
        )
        set({ toast: msg, toastKind: kind, _toastTimer: timer })
      },

      // ── Confirm modal ────────────────────────────────────────────
      // Async confirm dialog for code paths that aren't React (e.g.
      // api.js helpers). Use because Tauri's WebView blocks native
      // window.confirm() on macOS — silent no-op. Returns a Promise
      // that resolves to true (confirm) / false (cancel).
      confirmDialog: null,   // { title, message, confirmLabel, cancelLabel, danger? }
      _confirmResolve: null,
      // `danger: true` styles the mobile sheet with a red top bar +
      // solid-red confirm button so destructive actions get a brief
      // visual pause before the user's muscle-memory tap commits.
      askConfirm: ({ title = 'Confirm', message, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false }) => {
        return new Promise((resolve) => {
          set({
            confirmDialog: { title, message, confirmLabel, cancelLabel, danger },
            _confirmResolve: resolve,
          })
        })
      },
      _resolveConfirm: (answer) => {
        const fn = get()._confirmResolve
        set({ confirmDialog: null, _confirmResolve: null })
        if (typeof fn === 'function') fn(!!answer)
      },

      // Async text-input prompt — same modal, with an input field.
      // Reuses _confirmResolve under the hood. Resolves with the
      // typed string on Confirm, or null on Cancel.
      //
      // Why this exists alongside askConfirm: Tauri's WebView blocks
      // native window.prompt() the same way it blocks confirm(), and
      // we can't surface "Rename album to:" via askConfirm (no input
      // field). One Modal component renders both shapes — see
      // ConfirmModal.jsx.
      askPrompt: ({
        title = 'Rename',
        message = '',
        initial = '',
        placeholder = '',
        confirmLabel = 'Save',
        cancelLabel = 'Cancel',
      } = {}) => {
        return new Promise((resolve) => {
          set({
            confirmDialog: {
              title, message, confirmLabel, cancelLabel,
              input: { initial, placeholder },
            },
            _confirmResolve: resolve,
          })
        })
      },
      _resolvePrompt: (value) => {
        const fn = get()._confirmResolve
        set({ confirmDialog: null, _confirmResolve: null })
        if (typeof fn === 'function') fn(value)
      },
    }),
    {
      name: 'tunnel-storage',
      partialize: (s) => ({
        token: s.token,
        apiKey: s.apiKey,
        queue: s.queue,
        // Saving the queue without the index it's pointing at (and the
        // track itself) leaves the player half-restored on reload. The
        // user expects the same row + scrubber position they had before.
        queueIdx: s.queueIdx,
        currentTrack: s.currentTrack,
        audiobookPositions: s.audiobookPositions,
        audiobookDurations: s.audiobookDurations,
        shuffle: s.shuffle,
        repeatMode: s.repeatMode,
        cachedKeys: s.cachedKeys,
        recentSearches: s.recentSearches,
        recentlyPlayed: s.recentlyPlayed,
        audioQualityPref: s.audioQualityPref,
        defaultSourceAddonId: s.defaultSourceAddonId,
        theme: s.theme,
        crossfadeSec: s.crossfadeSec,
        outputDeviceId: s.outputDeviceId,
      }),
    }
  )
)
