// Single source of truth for global keyboard shortcuts. Player.jsx
// dispatches against `KEYBINDINGS` in its keydown handler; the
// Settings → Keyboard tab renders the same list as a reference
// card. Adding a shortcut means appending to this file once —
// both surfaces stay in sync automatically.
//
// `match(e)` is a small predicate that returns true when the
// keydown event matches the binding. Keeping the matcher inline
// lets us express things like "Cmd-K OR Ctrl-K" without baking
// platform branching into the dispatcher.

export const KEYBINDINGS = [
  {
    id: 'play_pause',
    label: 'Play / Pause',
    keyLabel: 'Space',
    match: (e) => e.key === ' ',
    handler: (ctx) => {
      ctx.e.preventDefault()
      if (ctx.track) ctx.setIsPlaying(!ctx.isPlayingRefCurrent)
    },
  },
  {
    id: 'seek_back',
    label: 'Seek −10 seconds',
    keyLabel: '←',
    match: (e) => e.key === 'ArrowLeft',
    handler: (ctx) => {
      ctx.e.preventDefault()
      if (ctx.active) ctx.active.currentTime = Math.max(ctx.active.currentTime - 10, 0)
    },
  },
  {
    id: 'seek_fwd',
    label: 'Seek +10 seconds',
    keyLabel: '→',
    match: (e) => e.key === 'ArrowRight',
    handler: (ctx) => {
      ctx.e.preventDefault()
      if (ctx.active?.duration) ctx.active.currentTime = Math.min(ctx.active.currentTime + 10, ctx.active.duration)
    },
  },
  {
    id: 'next',
    label: 'Next track',
    keyLabel: 'N',
    match: (e) => e.key === 'n' || e.key === 'N',
    handler: (ctx) => {
      const n = ctx.nextIdx()
      if (n >= 0) ctx.setQueueIdx(n)
    },
  },
  {
    id: 'prev',
    label: 'Previous track (or restart current)',
    keyLabel: 'P',
    match: (e) => e.key === 'p' || e.key === 'P',
    handler: (ctx) => {
      if (ctx.active && ctx.active.currentTime > 3) {
        ctx.active.currentTime = 0
        return
      }
      ctx.setQueueIdx(ctx.prevIdx())
    },
  },
  {
    id: 'mute',
    label: 'Mute / Unmute',
    keyLabel: 'M',
    match: (e) => e.key === 'm' || e.key === 'M',
    handler: (ctx) => {
      if (ctx.volumeRefCurrent > 0) {
        ctx.prevVolRefSet(ctx.volumeRefCurrent)
        ctx.setVolume(0)
      } else {
        ctx.setVolume(ctx.prevVolRefCurrent || 0.8)
      }
    },
  },
  {
    id: 'now_playing',
    label: 'Open Now Playing',
    keyLabel: 'F',
    match: (e) => e.key === 'f' || e.key === 'F',
    handler: (ctx) => { if (ctx.track) ctx.setNowPlayingExpanded(true) },
  },
  {
    id: 'shortcut_panel',
    label: 'Toggle the in-player shortcut panel',
    keyLabel: '?',
    match: (e) => e.key === '?',
    handler: (ctx) => ctx.setShowShortcuts(s => !s),
  },
  {
    id: 'search_focus',
    label: 'Focus search',
    keyLabel: '⌘K / Ctrl-K',
    match: (e) => (e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K'),
    // Dispatched from App.jsx (search-focus is a global action, not
    // player-scoped). Keep the binding here so it shows up in the
    // shortcuts panel even though Player doesn't run its handler.
    handler: null,
  },
]
