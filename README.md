# Audimo

A native music + audiobook + podcast player for macOS, with a
Stremio-style addon system. Audimo core is a player; sources of audio
come from addons you install (with the exception of podcasts, which
ship built-in via standard RSS).

Self-hosted, single-user, multi-device. Think *Plex for music* with
plugins.

> **Status:** alpha, single-developer. Stable enough to be my daily
> player on one Mac. See [Status & roadmap](#status--roadmap) before
> depending on it.

---

## Why

Mainstream music apps are streaming-only and own your taste.
Self-hosted players (Plex, Jellyfin, Navidrome) are file-library-only
and don't help you *find* music. Audimo is the middle: a clean native
player whose sources of audio are **plugins you choose**, with
library + playlists + cross-device sync running on your own hardware.

## What it does

- **Plays music, audiobooks, and podcasts.** Library, queue, playlists,
  crossfade, shuffle, scrubber, mobile Now Playing.
- **Subscribes to podcasts** via any RSS feed URL (no addon needed —
  RSS is the one source format core handles natively). Episode list,
  per-episode download, listen-progress tracking.
- **Searches across multiple sources at once.** Songs, artists,
  audiobooks. A unified picker ranks results by quality, instant-cache
  availability, and your preferences.
- **Imports playlists.** Drop a CSV from Exportify (or paste a public
  Spotify playlist URL) → tracks queue up → core downloads N at a time
  via whichever source addons you have installed.
- **Syncs across devices.** Backend stores your library and playlists;
  phone and desktop share the same state. Pair a phone by QR.
- **Has zero source code of its own.** Audimo core ships no music
  search, no streaming, no downloading. Every result came from an
  addon you installed.
- **Single-user.** No accounts. No telemetry. No upload to anyone.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Audimo.app (macOS)                                          │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Tauri WebView                                         │  │
│  │  React + Vite + Zustand                                │  │
│  └────────────────────────┬───────────────────────────────┘  │
│                           │                                  │
│  ┌────────────────────────▼───────────────────────────────┐  │
│  │  Backend sidecar (Python/FastAPI, port 8000)           │  │
│  │  Library, playlists, history, cache index, pairing,    │  │
│  │  artist photos, ListenBrainz                           │  │
│  └────────────────────────┬───────────────────────────────┘  │
│  ┌────────────────────────▼───────────────────────────────┐  │
│  │  Streaming sidecar (bundled libtorrent server)         │  │
│  │  Fast TTFB direct peering for torrent sources          │  │
│  └────────────────────────────────────────────────────────┘  │
└───────────────────────────┬──────────────────────────────────┘
                            │  cross-origin HTTP
       ┌────────────────────┼────────────────────┐
       ▼                    ▼                    ▼
  ┌─────────┐         ┌─────────┐          ┌─────────┐
  │ Addon A │         │ Addon B │   ...    │ Addon N │
  └─────────┘         └─────────┘          └─────────┘
   (separate processes — your choice — local or remote)
```

### Core principles

1. **Audimo core ships zero source-handling code.** The codebase is
   grep-clean of source-name references. Every result you see came
   from an addon.
2. **Addons are HTTP services with a manifest.** Anyone can write one.
   Protocol is small. See [`docs/ADDON_PROTOCOL.md`](docs/ADDON_PROTOCOL.md)
   for the reference and [`docs/ADDON_GUIDE.md`](docs/ADDON_GUIDE.md)
   for a getting-started tutorial.
3. **Addons can contribute full UI pages**, not just data. An addon's
   manifest can declare an iframe-hosted tab in the main nav; the
   addon's page calls `window.audimo.acquireTrack(...)` over a
   postMessage RPC bridge to drive downloads using whichever source
   addons the user has installed.
4. **Single-user means no auth complexity.** API keys exist only when
   you expose the backend to a phone on your LAN / Tailscale.

## Install

### Quickstart (macOS)

1. Download `Audimo.app` from
   [Releases](https://github.com/audaro/audimo/releases) (TBD).
2. Move to `/Applications`, open it.
3. First-run wizard offers to set up an API key (skip for desktop-only).
4. **Addons → Install** and paste an addon's URL.

### From source

```bash
# Prerequisites: Node 20+, Rust (stable), Python 3.13+, ffmpeg
git clone https://github.com/audaro/audimo
cd audimo/frontend
npm install
npx tauri dev   # Tauri shell with hot-reload
```

Backend hot-reload runs alongside (uvicorn watches `backend/`). For a
release `.app`:

```bash
cd frontend
npx tauri build
# → frontend/src-tauri/target/release/bundle/macos/Audimo.app
```

## Addons

Audimo core ships none. Install via **Addons → Install** in the app.

The maintained community catalog lives at
[github.com/audimo-addons](https://github.com/audimo-addons):

| Addon | What it does |
|---|---|
| [`audimo-streamers`](https://github.com/audimo-addons/audimo-streamers) | YouTube, SoundCloud, Bandcamp playback (free streaming sources) |
| [`audimo-soulseek`](https://github.com/audimo-addons/audimo-soulseek) | Soulseek peer search; bundles + manages slskd locally |
| [`audimo-indexers`](https://github.com/audimo-addons/audimo-indexers) | Torrent indexers + debrid clients + ranking + BEP-15 verify |
| [`audimo-audiobooks`](https://github.com/audimo-addons/audimo-audiobooks) | Internet Archive, LibriVox, AudiobookBay |
| [`audimo-importers`](https://github.com/audimo-addons/audimo-importers) | Import playlists from Spotify / CSV / Exportify; auto-download via your other addons |
| [`audimo-catalog`](https://github.com/audimo-addons/audimo-catalog) | The one-click install catalog itself |

## Cross-device usage

1. Enable **Phone Access** in Settings on the desktop. Backend rebinds
   to all interfaces; an API key is generated.
2. A QR code appears with your machine's Tailscale or LAN URL + a
   one-time pair token (90 s TTL).
3. Scan with your phone → opens the URL → phone redeems the token →
   API key + addon list seeds into phone localStorage.
4. Desktop and phone now share library + playlists + history.

For internet-from-anywhere access: [Tailscale](https://tailscale.com)
(free for personal). Audimo doesn't ship hole-punching, ngrok-style
tunneling, or any third-party relay.

## Addon protocol — short version

An addon is an HTTP server returning a manifest at `GET /manifest.json`.
Audimo only routes requests to endpoints whose capability the addon
advertises.

```
POST /resolve/sources             — resolve.sources
POST /resolve/sources/stream      — resolve.sources.stream    (SSE)
POST /resolve/stream              — resolve.stream            (SSE)
POST /cache/resolve               — cache.resolve
GET  /ui/catalog, POST /ui/search — ui.tab (JSON-driven tab)
GET  /ui/page                     — ui.tab.page_url (iframe tab)
```

iframe-hosted tabs can call back into core via `window.audimo`:

```js
for await (const ev of window.audimo.acquireTrack({
  title: 'Blue Monday', artist: 'New Order',
  policy: { prefer: ['audimo-streamers'] },
})) {
  console.log(ev.status, ev.pct, ev.message)
}
```

Full reference: [`docs/ADDON_PROTOCOL.md`](docs/ADDON_PROTOCOL.md).
Tutorial: [`docs/ADDON_GUIDE.md`](docs/ADDON_GUIDE.md).

## Roadmap

- [x] Iframe-hosted addon tab pages + `window.audimo` RPC bridge
- [x] Importer addon (Spotify URL / Exportify CSV → queue → auto-download)
- [x] Audiobook search + dedicated library
- [x] Mobile-friendly Now Playing + bottom sheets
- [x] Phone pairing over LAN / Tailscale with QR
- [x] Bundled libtorrent streaming server (Stremio-style :11471) for
      fast TTFB on torrent sources
- [ ] Public release of native bundle (DMG + Homebrew cask)
- [ ] Linux + Windows builds (Tauri shell ports easily; the macOS
      LaunchAgent paths need replacing)
- [ ] Lyrics integration
- [ ] Smart playlists (recently added, rarely played, etc.)
- [ ] Volume normalization (ReplayGain / EBU R128)
- [ ] Per-track artist photo override

## Status & roadmap caveats

Alpha software, one person, used daily on one Mac. Stable enough to
be my primary player; not stable enough to recommend without caveats:

- **Single-user assumption is baked in.** Multi-user would need
  per-user isolation that doesn't exist yet.
- **macOS-only today.**
- **Addon ecosystem is small.** Writing a new one is a weekend
  project; the community is early.
- **Schema migrations are manual.** Major DB changes will require
  starting your library over.

## Contributing

Issues and PRs welcome. Areas that would meaningfully help:

- Linux / Windows port of the Tauri shell + sidecar autostart
- New addons (streaming sources, public-domain catalogs, smart radio)
- Cross-platform sidecar manager to replace LaunchAgents
- Test coverage

Codebase shape:

```
frontend/         — Vite + React + Zustand SPA
  src/
  src-tauri/      — Tauri 2 shell (Rust)
backend/          — FastAPI app, SQLite at ~/.audimo/tunnel.db
streaming_server/ — libtorrent streaming sidecar
docs/             — Protocol + guide
```

Style: snake_case Python, camelCase JS, comments explain *why* not
*what*, no emojis in code.

## License

TBD — likely AGPL-3.0 to keep forks open.

## Acknowledgments

Architectural ideas borrowed from:

- **Plex** — single-user-multi-device patterns
- **Stremio** — addon protocol shape, install URL with embedded
  config, single-user model
- **Jellyfin** — cross-device sync without an account system
- **Navidrome** — clean library presentation, focus on user-owned files
