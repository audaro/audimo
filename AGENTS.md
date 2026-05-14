# Audimo — Project Context for Codex

## Product shape

Audimo is a **native desktop application** (macOS + Windows) that
optionally lets the user expose the same instance as a **web app for
remote access from their phone**. The user runs everything on their own
hardware. There is no central Audimo server, no SaaS, no multi-tenant
backend that Anthropic-or-anyone-else operates.

This is **single-user, multi-device**, not multi-tenant. Mental model:
"Plex for music + audiobooks." One user. One library. Multiple devices
(desktop = primary; phone web view = secondary, accessed remotely over
the internet to the user's own home machine).

## What this means for design decisions

1. **`AUDIMO_HOSTED=1` is a niche escape hatch, not the production
   mode.** It exists for someone who wants to spin up a public hosted
   audimo_aio addon and disable libtorrent for legal-defensibility.
   It is not the default path. The default is: user runs the desktop
   app, the addon process is bundled alongside, libtorrent is enabled,
   Real-Debrid is optional.

2. **libtorrent is a first-class playback path**, not a fallback or a
   dev-only nicety. Reliability fixes for libtorrent (port mapping, DHT
   warm-up, tracker pool, metadata timeout, peer-discovery settings,
   private-tracker guards) directly affect end users.

3. **The bundled addon is co-located with the desktop app.** Not a
   separate service the user has to install. Likely shipped as a sidecar
   binary launched by the desktop wrapper (Tauri/Electron). Bridge
   networking + explicit port maps remain the right call so multiple
   addons can coexist.

4. **Desktop ↔ mobile sync is the real "multi-device" problem.** The
   phone's web view runs in a browser without the user's desktop
   localStorage. Addon URLs (which carry secrets in path segments) need
   to move between devices. Today this works via the Export/Import flow
   in `AddonsView`. Future: QR-code seeding, or an authenticated
   "/api/addons/seed" endpoint that the mobile web app calls once on
   first launch using a desktop-issued one-time token. Never put addon
   URLs through any third-party server.

5. **Remote access security.** When the user enables the web view, the
   backend becomes internet-reachable. Auth is mandatory: API key (or
   stronger) on every endpoint. HTTPS required (recommend the user use
   Tailscale, Cloudflare Audimo, or similar — never expose a raw port to
   the public internet). Rate-limiting on auth endpoints to slow brute
   force. The API key lives on the desktop; mobile gets a derived
   per-device token.

6. **Device-as-client is the target architecture (not yet reality).**
   The goal is for each device (desktop, phone) to keep its own addon
   list in localStorage and talk to addons directly from the browser
   (addons serving `Access-Control-Allow-Origin: *`), so the FastAPI
   backend never has to hold addon URLs or credentials.

   **Current state**: backend `addons` and `addon_settings` tables
   (`backend/database.py:160`, `:172`) DO store per-user addon URLs
   and credentials, and `backend/main.py` calls addons directly
   (`_consume_addon_stream`, `cache_resolve`, search dispatch). The
   frontend client in `frontend/src/addons/` exists alongside this
   server-side path. Don't add new server-side addon-calling code;
   prefer routing through the browser. Removing the server-side path
   is a planned refactor.

7. **Legal-defensibility framing still matters.** Audimo core ships
   zero indexer / RD / torrent code. All of that lives in the optional
   `audimo_aio` addon. Users who want a clean install never see
   it. Don't propose moving any of it back into core.

8. **Single-user assumption simplifies a lot.** No per-user data
   isolation, no quota enforcement, no abuse mitigation in the addon.
   Rate-limiting is mostly there to protect upstream APIs (RD,
   Prowlarr) from runaway bugs, not to police users.

## Local environment

- **Project root**: `/Users/jordansimpson/dev/tunnel` (was `~/Downloads`
  but moved out because macOS TCC blocks launchd from reading
  `~/Downloads`).
- **Addons live in their own repos** under `github.com/audimo-addons/*`,
  cloned as siblings to this repo:
    `~/dev/audimo-aio/`, `~/dev/audimo-indexers/`, `~/dev/audimo-slskd/`,
    `~/dev/audimo-streamers/`, `~/dev/audimo-catalog/`.
  Each runs natively on its own port (aio 9004, indexers 9005, slskd 9007,
  streamers 9006). Restart after editing an addon's `server.py`:
    `launchctl kickstart -k gui/$UID/com.audimo.<short>`
  Each addon repo carries its own `*.plist.template` next to its source.
- **Install / refresh the streaming sidecar's launchd plist**:
  `scripts/install_launchd.sh streaming` renders
  `streaming_server/com.audimo.streaming.plist.template` into
  `~/Library/LaunchAgents/`. Pair: `scripts/uninstall_launchd.sh`.
  Addon plists are managed inside their respective addon repos, not
  by this script.
- **Docker compose for hosted mode** lives in each addon's repo (e.g.
  `~/dev/audimo-indexers/deploy/docker-compose.yml` for the niche
  `AUDIMO_HOSTED=1` case). Don't use it for local dev.

## Architecture quick-reference

- `frontend/` — React + Vite. The same bundle is loaded by the desktop
  wrapper and served to the mobile browser. Addon registry
  (`src/addons/registry.js`), HTTP client (`src/addons/client.js`),
  orchestrator (`src/addons/orchestrator.js`). All addon I/O happens
  in-browser.
- `backend/` — FastAPI. Stores the user's library entries (track
  metadata + addon_id reference). Does not know addon URLs, does not
  call addons directly. Auth-gated for remote use.
- `~/dev/audimo-aio/` (private repo: `audimo-addons/audimo-aio`) —
  FastAPI **aggregator** (~2,400 lines). Port 9004. Capabilities:
  `resolve.sources`, `resolve.sources.stream`, `resolve.stream`,
  `cache.resolve`, `slskd.status`, `search.books`. Serves Soulseek
  (slskd) directly; everything else fans out to configured extension
  addons via `extension_urls` in settings. No scrapers, no debrid, no
  libtorrent of its own.
- `~/dev/audimo-indexers/` (public repo: `audimo-addons/audimo-indexers`) —
  Comet-style **workhorse** (~5,600 lines). Port 9005. 6 indexers
  (apibay, bitsearch, torrentdownload, prowlarr, rutracker,
  audiobookbay), 6 debrid clients (RD, AllDebrid, TorBox, Premiumize,
  Debrid-Link, EasyDebrid), BEP-15 verify + peer injection into the
  desktop streaming sidecar, RTN-style ranking, SQLite cache,
  /admin dashboard.
- `~/dev/audimo-slskd/` (public repo: `audimo-addons/audimo-slskd`) —
  Soulseek peer-source addon. Bridges the user's local slskd daemon
  into the addon protocol; local-only by design.
- `~/dev/audimo-streamers/` (public repo: `audimo-addons/audimo-streamers`) —
  YouTube / SoundCloud / Bandcamp streamers. Each service can be
  toggled in the addon's Configure page.
- `~/dev/audimo-catalog/` (public repo: `audimo-addons/audimo-catalog`) —
  Default community catalog. The Audimo desktop app lets users add
  this URL (or any other catalog URL) as a "source" to discover and
  one-click install addons.

## Aggregator/extension protocol

Every source returned from `resolve.sources` is stamped with the
`addon_id` of the addon that produced it. The aggregator dispatches
by that field:

- `resolve.stream`: if `source.addon_id != "audimo-aio"`, the request
  is proxied to the matching extension URL verbatim (SSE forwarded).
- `cache.resolve`: same, keyed off `entry.addon_id`.
- `slskd` sources are stamped `addon_id: "audimo-aio"` and handled
  locally.

Helpers in `audimo_aio/server.py`:
- `_enabled_extension_urls(cfg)` — parse the textarea
- `_fetch_extension_manifest`, `_build_extension_routing`
- `_call_extension_resolve_sources`, `_proxy_extension_sse`

When working in this area:
- Source records flowing through the aggregator MUST carry an
  `addon_id` field so dispatch routes correctly.
- The native app (`frontend/` + `backend/`) stays addon-agnostic.

## Addon SSE wire format

The addon emits snake_case events with a `type` discriminator:
`progress | ready | cache_hint | error | unsupported | done`. The
frontend orchestrator (`normalizeStreamEvent`) translates these to the
`{status, streamUrl, mimeType, source}` shape SourcePicker expects, and
absolutizes any relative `stream_url` against the addon's origin.

## Frontend testing & quirks

**Test harness**
- UI smoke tests: `cd frontend && npx playwright test e2e/tunnel.test.cjs --config=playwright.config.cjs --reporter=list`.
  Requires backend on :8000 and addon on :9004 already running.
- `frontend/package.json` is `"type": "module"`. Node config / test
  files must use `.cjs` (Playwright config, test files) or they fail to
  parse.
- Each Playwright test gets fresh localStorage. Seed the addon entry
  via `page.addInitScript(...)` before `page.goto()`, not after.

**Selectors**
- Use `getByPlaceholder('Search songs, artists, audiobooks…')` for the
  search input — `[placeholder*="Search"]` matches 5 inputs and trips
  strict mode.
- Vite hashes CSS Module class names. Use attribute selectors like
  `[class*="_songRow_"]`, never the raw class. Find the prefix by
  grepping the built bundle:
  `grep -oE '_[a-zA-Z]+_[a-z0-9]+_[0-9]+' frontend/dist/assets/index-*.js | sort -u`.

**Backend API surface (when writing tests or new fetches)**
- Library list: `/api/cache/list` (not `/api/tracks`)
- Track search: `/api/search/tracks?q=…`

**If a test flakes, check first**
- A `.first()` selector matching hidden DOM. Multiple views may be
  mounted simultaneously and toggled by CSS rather than unmounted —
  scope to a visible parent or wait for the right one.
- Stale SSE stream from the previous test keeping the addon busy. Add
  `{ retries: 2 }` and a 1–2s settle after `page.goto()` for any test
  that follows a source-picker test.

**Addon manifest changes**
- If you change the addon's manifest (display labels, capabilities,
  etc.), existing installs may not see the change until the addon URL
  is reinstalled — manifests appear to be snapshotted into client
  localStorage at install time. Verify before assuming code changes
  propagated.
