# Audimo Addon Protocol

This is the wire contract Audimo addons implement. The desktop app talks
to addons directly from the browser (device-as-client), so this protocol
is the only thing that has to be stable across versions.

For a tutorial-style getting-started guide, see
[ADDON_GUIDE.md](ADDON_GUIDE.md).

Production implementations live in their own repos under the
[audimo-addons](https://github.com/audimo-addons) GitHub org:

- [`audimo-streamers`](https://github.com/audimo-addons/audimo-streamers) — YouTube, SoundCloud, Bandcamp
- [`audimo-soulseek`](https://github.com/audimo-addons/audimo-soulseek) — Soulseek peer search (bundles slskd)
- [`audimo-indexers`](https://github.com/audimo-addons/audimo-indexers) — torrent indexers + debrid clients
- [`audimo-audiobooks`](https://github.com/audimo-addons/audimo-audiobooks) — Internet Archive, LibriVox, AudiobookBay
- [`audimo-importers`](https://github.com/audimo-addons/audimo-importers) — Spotify / CSV import (UI-only addon using §9)

Each implements this protocol in full.

## Conventions

- **Transport:** HTTP + JSON. Streaming endpoints use Server-Sent Events
  (`Content-Type: text/event-stream`).
- **Casing:** snake_case on the wire, in both directions. The frontend
  orchestrator translates to camelCase internally.
- **CORS:** addons MUST send `Access-Control-Allow-Origin: *` (or
  reflect the request origin) plus `Allow-Methods: *` and
  `Allow-Headers: *`. The Audimo UI calls addons directly from the
  browser; without permissive CORS the entire flow breaks.
- **Auth:** addons running on `localhost` typically run unauthenticated.
  An addon hosted on a public URL SHOULD gate every endpoint except
  `/manifest.json` and CORS preflight on a shared secret presented as
  `X-Audimo-Addon-Key`.

## 1. Manifest — `GET /manifest.json`

Static metadata. Called once at install time and snapshotted by the
client. The client does **not** re-fetch on every request, so manifest
changes only take effect on reinstall.

```json
{
  "id": "example-addon",
  "name": "Example Addon",
  "version": "1.0.0",
  "description": "What this addon does, in one sentence.",
  "capabilities": ["resolve.sources", "resolve.stream"],
  "display": { "label": "Example", "icon": "" },
  "settings_schema": []
}
```

| Field | Required | Notes |
|---|---|---|
| `id` | ✓ | Stable kebab-case identifier. The client routes follow-up calls (resolve.stream, cache.resolve) back to the addon that produced a source by matching this against `source.addon_id`. |
| `name` | ✓ | Human label for the install list. |
| `version` | ✓ | semver. |
| `capabilities` | ✓ | Subset of the capability strings below. The client only calls endpoints whose capability is advertised. |
| `description` | – | One sentence shown in the UI. |
| `display` | – | `{label, icon}` for chrome. |
| `settings_schema` | – | Sectioned form schema rendered by `/configure` and the in-app addon-settings panel. See "Settings schema" below. |

### Capabilities

| String | Endpoint | Verb | Streaming |
|---|---|---|---|
| `resolve.sources` | `/resolve/sources` | POST | no — returns a list |
| `resolve.sources.stream` | `/resolve/sources/stream` | POST | yes (SSE) — progressive results |
| `resolve.stream` | `/resolve/stream` | POST | yes (SSE) — playable URL pipeline |
| `cache.resolve` | `/cache/resolve` | POST | no — refresh a stored URL |
| `search.books` | `/search/books` | POST | no — audiobook discovery |
| `search` | `/search` | POST | no — generic track search (used by the example addon) |
| `ui.tab` | `/ui/catalog`, `/ui/search` | GET / POST | no — dedicated tab in main nav (see §7) |
| `ui.search` | `/ui/search` | POST | no — chip in unified search (see §7) |
| `ui.home` | `/ui/home` | GET | no — shelves on the Home view (see §7) |

An addon MAY register the same endpoints at both
`/<endpoint>` and `/{config}/<endpoint>` (the "config-in-URL" /
Stremio-style pattern). When both forms exist, path-segmented config
wins over body settings. This keeps secrets out of request bodies that
might be logged.

## 2. `POST /resolve/sources` — list candidate sources

Request body:

```json
{
  "title": "Song title",
  "artist": "Artist name",
  "album": "Album",
  "kind": "music" | "audiobook",
  "limit": 50,
  "settings": { "...addon-specific settings..." }
}
```

`title` is the only required field. `settings` is omitted when config
is baked into the URL path.

Response body:

```json
{
  "sources": [
    {
      "addon_id": "audimo-indexers",
      "kind": "torrent" | "stream" | ...,
      "name": "Display name (release title)",
      "info_hash": "uppercase-40-hex",
      "link": "magnet:?xt=urn:btih:... | https://...",
      "link_type": "magnet" | "torrent" | "url",
      "source": "indexer-id",
      "topic_id": "private-tracker topic id (optional)",
      "seeders": 12,
      "size_bytes": 123456789,
      "rd_cached": false,
      "version_tags": ["FLAC", "Live"],
      "year": 2019
    }
  ]
}
```

**Critical:** every source MUST carry `addon_id` — the aggregator and
the device-side orchestrator dispatch `resolve.stream` and
`cache.resolve` calls back to the addon whose id matches. Sources
without `addon_id` are unroutable and will be silently dropped.

`kind` discriminates how the client treats the source:

- `kind == "torrent"` → if `info_hash` is present, the desktop
  streaming sidecar (port 11471) may peer the torrent locally instead
  of going through the addon for `resolve.stream`.
- `kind == "stream"` (or anything else) → always goes through
  `resolve.stream` for the playable URL.

Any additional fields are passed through verbatim and echoed back to
the addon in `resolve.stream` and `cache.resolve` payloads. The core
client never inspects them.

## 3. `POST /resolve/sources/stream` — progressive sources (SSE)

Same request body as `/resolve/sources`. The response is an SSE stream
of:

| `type` | Payload |
|---|---|
| `section` | `{ id, label, sources: [...] }` — a labelled cluster of sources, e.g. one per indexer |
| `progress` | `{ pct, message }` — optional progress text shown during long fan-out queries |
| `error` | `{ code, message }` — non-fatal: stream continues |
| `done` | `{}` — terminal |

Use this when source discovery is slow (multiple upstream indexers in
parallel) and the user benefits from seeing partial results.

## 4. `POST /resolve/stream` — playable-URL pipeline (SSE)

Request body:

```json
{
  "source": { /* one source object from /resolve/sources */ },
  "track": { "title": "...", "artist": "...", "album": "...", "kind": "music" },
  "settings": { ... }
}
```

The response is an SSE stream where each event has a `type`
discriminator. Events the client understands:

| `type` | Required fields | Meaning |
|---|---|---|
| `progress` | `pct` (0–100), `message` | Visible progress update |
| `ready` | `stream_url`, `mime_type` | Final playable URL |
| `cache_hint` | same as `ready` | Like `ready`, but the client SHOULD also persist this entry to the cache store |
| `unsupported` | `code`, `message` | The addon can't serve this source itself but the client may have a fallback. The well-known `code: "torrent_no_debrid"` (with `info_hash`, `magnet`, `name`, `seeders`) tells the desktop streaming sidecar to peer the torrent locally |
| `error` | `code`, `message` | Hard failure |
| `done` | – | Terminal — no more events |

`stream_url` MAY be relative (e.g. `/file?path=...`). The orchestrator
absolutizes it against the addon's origin. This keeps URLs portable
when an addon is reinstalled at a different host.

`mime_type` should be a real audio type (`audio/mpeg`, `audio/flac`,
`audio/mp4`, etc.). The player won't transcode; pick something
browsers can play.

Additional fields are passed through and stored in the cache entry
verbatim — the addon owns the schema. The client only requires
`stream_url` and `mime_type` to play, plus whatever the addon needs
echoed back in `cache.resolve` to refresh the URL later.

### Example sequence

```
data: {"type":"progress","pct":5,"message":"Checking Real-Debrid…"}

data: {"type":"progress","pct":80,"message":"Found in Real-Debrid — unrestricting…"}

data: {"type":"ready","stream_url":"https://debrid.example/audio.flac","mime_type":"audio/flac","source_label":"RD","info_hash":"ABCD..."}

data: {"type":"done"}
```

## 5. `POST /cache/resolve` — refresh a stored URL

Request body: an entry the client previously stored (the full event
the addon emitted, with `addon_id` stamped on it). Response is a
single JSON object — same shape as a `ready` event:

```json
{ "stream_url": "...", "mime_type": "...", "...passthrough fields..." }
```

Or an error:

```json
{ "error": "code", "message": "human text" }
```

This exists because debrid links and other temporary URLs expire. The
addon is responsible for re-resolving from whatever durable identifier
it baked into the original entry (e.g. `info_hash`, `rd_link`).

## 6. Settings schema

The `settings_schema` field in the manifest is a list of sections,
each containing leaf fields. Field types:

| `type` | Use |
|---|---|
| `text` | Plain string |
| `password` | String — masked input, never logged |
| `boolean` | Checkbox |
| `extension_list` | (Aggregator only) Editable list of extension addon URLs |

```json
[
  {
    "type": "section",
    "label": "Real-Debrid",
    "description": "Optional. Enables instant playback for cached torrents.",
    "fields": [
      { "key": "rd_api_key", "type": "password", "label": "API key" }
    ]
  }
]
```

The `/configure` HTML page (if served) renders this schema in full.
The in-app settings panel renders only the leaf text/password/boolean
fields.

## 7. UI surfaces — addon-contributed views

An addon can contribute UI to three independent surfaces, and opts
into each one separately by advertising the matching capability:

| Surface | Capability | Where it shows up |
|---|---|---|
| **Tab** | `ui.tab` | Dedicated top-level tab in the main nav (sidebar on desktop, bottom-nav on mobile). For addons that own a "world" — Podcasts, Audiobooks, Internet Archive, etc. |
| **Search chip** | `ui.search` | A filter chip in the unified search bar, alongside *All / Songs / Artists / Audiobooks*. For addons that just add searchable content. |
| **Home shelves** | `ui.home` | One or more named shelves on the Home view, interleaved with shelves from other addons. For curated / personal / browse content. |

The native app does the rendering for all three; the addon returns
declarative card data only. **No HTML, no JavaScript, no iframes, no
CSS** — that's a hard line. It keeps the security model intact (an
addon URL is never trusted with DOM access), keeps mobile and desktop
parity automatic, and means the visual language stays consistent
across addons.

The card / section data model is shared across all three surfaces
(see §7.5). Only the placement and the endpoint differ.

### 7.0 Manifest declaration (all surfaces)

The addon's `ui` manifest block holds one optional sub-block per
surface. An addon may declare any combination — only the ones whose
capability is also advertised in `capabilities` are activated.

```json
{
  "id": "audimo-streamers",
  "capabilities": ["resolve.sources", "resolve.stream", "ui.search", "ui.home"],
  "ui": {
    "tab":    { /* §7.1 — dedicated tab */ },
    "search": { /* §7.2 — search chip */ },
    "home":   { /* §7.3 — home shelves */ }
  }
}
```

### 7.1 `ui.tab` — dedicated tab

Adds a top-level tab to the main nav. The tab has its own back-stack,
its own search bar (when `tab.search:true`), and renders the addon's
`/ui/catalog` response on entry.

Manifest:

```json
"ui": {
  "tab": {
    "id": "podcasts",
    "label": "Podcasts",
    "icon": "🎙",
    "search": true,
    "search_placeholder": "Search podcasts…",
    "default_kind": "podcast",
    "sort_priority": 50
  }
}
```

| Field | Required | Notes |
|---|---|---|
| `tab.id` | ✓ | Stable id, kebab-case. Used as the tab key in the bottom nav and as a routing handle. |
| `tab.label` | ✓ | Display text on the tab + section header. |
| `tab.icon` | – | Single emoji or short text glyph. SVG / image URLs **not** accepted (visual-language hard line). |
| `tab.search` | – | If `true`, the unified search bar dispatches `q` to this tab too. Default `false`. |
| `tab.search_placeholder` | – | Custom placeholder when the user navigates *into* the tab. Default: the app's generic placeholder. |
| `tab.default_kind` | – | One of `track`, `album`, `artist`, `book`, `podcast`, `episode`, `mixed`. Tells the renderer how to lay cards out (grid vs. list) when the addon doesn't override per-section. |
| `tab.sort_priority` | – | Lower = earlier in the nav. Built-in tabs sit at 0–10 (Search), 20 (Library), 30 (Queue), 40 (Playlists). Default `100`. |

The user can hide any addon-defined tab from Settings → Tabs without
removing the addon (so disabling Soulseek search doesn't take Soulseek
playback with it).

#### `GET /ui/catalog` — the tab landing surface

Called when the user opens the tab with no query in the unified search.
Cheap, cacheable. Path-segmented config addons should also accept
`GET /{config}/ui/catalog`.

Request: no body. Query:

| Param | Notes |
|---|---|
| `cursor` | Optional opaque pagination cursor returned by a previous response. |

Response:

```json
{
  "sections": [
    {
      "id": "trending",
      "title": "Trending this week",
      "layout": "grid",
      "items": [
        {
          "id": "p:42",
          "title": "Hardcore History",
          "subtitle": "Dan Carlin",
          "image": "https://example.com/cover/42.jpg",
          "kind": "podcast",
          "on_select": { "type": "open", "section_id": "podcast", "id": "p:42" },
          "badges": ["NEW"]
        }
      ]
    }
  ],
  "next_cursor": "abc123"
}
```

| Field | Notes |
|---|---|
| `sections[]` | Render top-to-bottom. Empty sections are dropped silently. |
| `section.title` | Plain text. |
| `section.layout` | `"grid"` (album-art tiles) or `"list"` (track-row style). Default `"list"`. |
| `section.items[]` | Up to ~50 per section. Renderer paginates internally. |
| `item.id` | Stable across pages. The renderer dedupes on this when paginating. |
| `item.image` | Absolute https URL. The app serves it through its existing cover-cache. **No data: URLs**, **no relative paths**. |
| `item.kind` | Same vocabulary as `tab.default_kind`. Lets the renderer pick a fallback monogram if `image` 404s. |
| `item.on_select` | What to do when the user taps the card. See §8.4. |
| `item.badges` | Optional short tags rendered as plain text chips (e.g. `NEW`, `EXPLICIT`, `2h 14m`). Cap 3, ≤ 8 chars each. |
| `next_cursor` | Pass back as `?cursor=` to fetch more. Omit when there's no next page. |

#### `POST /ui/search` — search inside the tab

Only required if the manifest sets `tab.search: true`. Same response
shape as `/ui/catalog`. Request body:

```json
{ "q": "cosmos", "cursor": null, "limit": 30 }
```

When `tab.search:true`, the renderer mounts a search input inside the
tab header (using `tab.search_placeholder` for the placeholder text),
and dispatches typing to this endpoint.

`/ui/search` is **shared** with the `ui.search` capability (§7.2).
An addon that advertises both `ui.tab` and `ui.search` exposes a
single endpoint, with two callers (tab-internal search + chip in
unified search). It does not need to disambiguate them.

### 7.2 `ui.search` — chip in the unified search bar

Adds a filter chip (e.g. `Streaming`) to the chip row at the top of
the unified search view, next to *All / Songs / Artists / Audiobooks*.

When the chip is active, search results are restricted to this
addon's `/ui/search` response. When *All* is active, the addon's
results are interleaved with the built-in sections.

Manifest:

```json
"ui": {
  "search": {
    "label": "Streaming",
    "placeholder": "Search YouTube, SoundCloud, Bandcamp…",
    "sort_priority": 50
  }
}
```

| Field | Required | Notes |
|---|---|---|
| `search.label` | ✓ | Chip text. Keep short (≤ 12 chars). |
| `search.placeholder` | – | Custom placeholder shown in the unified search input when this chip is active. Default: the app's generic placeholder. |
| `search.sort_priority` | – | Lower = earlier in the chip row, after the built-in chips. Default `100`. |

Endpoint: `POST /ui/search`. Body and response are identical to
§7.1's `/ui/search` endpoint (and addons SHOULD share the
implementation when they advertise both `ui.tab` and `ui.search`).

### 7.3 `ui.home` — shelves on the Home view

Contributes one or more named shelves (sections of cards) to the
Home view. The Home view aggregates shelves across all installed
`ui.home` addons and renders them in `sort_priority` order.

Manifest:

```json
"ui": {
  "home": {
    "shelves": [
      { "id": "subscribed", "label": "Subscribed", "sort_priority": 30 },
      { "id": "trending",   "label": "Trending",   "sort_priority": 60 }
    ]
  }
}
```

| Field | Required | Notes |
|---|---|---|
| `home.shelves[]` | ✓ | At least one. Cap 6 per addon. |
| `shelf.id` | ✓ | Stable id, kebab-case. Returned as `section.id` in the response so the renderer can match content to the manifest declaration. |
| `shelf.label` | ✓ | Plain text section title. |
| `shelf.sort_priority` | – | Lower = higher on the page. Default `100`. |

Endpoint: `GET /ui/home`. No body. Optional `?cursor` for pagination
(uncommon — most home shelves are short).

Response:

```json
{
  "shelves": [
    {
      "id": "trending",
      "title": "Trending",
      "layout": "grid",
      "items": [ /* same item shape as §7.5 */ ]
    }
  ]
}
```

The addon returns **all** of its declared shelves in one response.
The renderer matches `shelves[].id` against the manifest declaration
and discards anything that wasn't declared (defence-in-depth — the
manifest is the contract). Empty shelves are dropped silently.

A shelf returned without a corresponding manifest declaration is
ignored; the renderer never surfaces unannounced content.

### 7.4 `on_select` — what a tap does

Six kinds, no others:

```json
// Open a card detail view. The detail view itself is another
// /ui/catalog-shaped response keyed by id.
{ "type": "open", "section_id": "podcast", "id": "p:42" }

// Resolve + play immediately, using the addon's resolve.sources
// pipeline. The renderer turns this into a SourcePicker call —
// identical to what tapping a Deezer search row does today.
{ "type": "play", "track": { "title": "Show #42", "artist": "Dan Carlin", "album": "Hardcore History" } }

// Add to library without playing. The addon supplies the cache row.
{ "type": "add_to_library", "entry": { "track_title": "...", "track_artist": "...", "addon_id": "audimo-podcasts" } }

// Open a sub-catalog (paginated). Same shape as the tab landing.
{ "type": "browse", "endpoint": "/ui/catalog/podcast/42", "title": "Episodes" }

// Open the user's external browser. Restricted to https URLs that
// match the addon's own origin OR a manifest-declared allowlist.
{ "type": "open_url", "url": "https://podcasts.example.com/show/42" }

// No-op — useful for non-interactive cards (genre headers etc).
{ "type": "noop" }
```

The renderer **never** evaluates strings as URLs unless the
`on_select.type` is one of the above. An addon that emits `{type:
"eval", code: "..."}` will be ignored entirely (and logged as a
manifest violation).

### 7.5 Detail views

When the user taps a card with `on_select.type == "open"`, the
renderer calls the same endpoint with the id appended:

```
GET /ui/catalog/{section_id}/{id}
```

Response shape is identical to `/ui/catalog` — sections of cards. The
detail view gets a back button automatically. Detail views can nest:
each card's `on_select` can `open` another id, and the renderer keeps
a back stack.

### 7.6 Caching, errors, deadlines

- The renderer caches `/ui/catalog` responses for 60 s in memory. Cache
  is keyed on `(addon_id, endpoint, query)` — no shared cache across
  addons.
- Each request has a hard 8 s deadline. Addons that miss it get their
  section rendered as an inline error chip (`Couldn't load`) the user
  can tap to retry. The rest of the catalog still renders.
- A response with no `sections` array, with a `sections` array of
  non-objects, or with any `item.image` that isn't an absolute https
  URL, gets dropped silently and an error chip surfaces in its place.
  Addons should defensively validate before sending.
- The renderer enforces caps server-side: `len(sections) ≤ 20`,
  `len(items) ≤ 50` per section, `len(title) ≤ 80`, `len(image) ≤
  2048`. Anything over those is truncated, not rejected — the
  response still renders.

### 7.7 What the addon does NOT control

- **Layout chrome.** Tab nav, search bar, header, fonts, colors,
  spacing, the back button — all owned by the app. Addons declare
  `layout: "grid" | "list"` per section, and that's it.
- **Audio playback.** `on_select: "play"` flows into the existing
  `resolve.sources` → SourcePicker → `resolve.stream` pipeline. There
  is no addon-supplied `<audio>` element.
- **Persistent state.** The renderer doesn't store anything across
  reloads except the user's "tab hidden" flags. Addons that need
  persistence (e.g. listening progress) own that on their own backend
  and reflect it in `on_select` payloads.
- **Notifications, modals, popups.** None.

### 7.8 Worked example — a podcasts addon

Manifest:

```json
{
  "id": "audimo-podcasts", "version": "1.0.0",
  "capabilities": ["ui.tab", "resolve.stream", "cache.resolve"],
  "display": { "label": "Podcasts", "icon": "🎙" },
  "ui": {
    "tab": {
      "id": "podcasts", "label": "Podcasts", "icon": "🎙",
      "search": true, "default_kind": "podcast"
    }
  }
}
```

`GET /ui/catalog` renders a "Subscribed" list + a "Trending" grid.
Tapping a podcast card fires `on_select: { type: "open", id: "p:42" }`,
which the renderer dispatches as `GET /ui/catalog/podcast/p:42`. That
returns one section listing episodes; tapping an episode fires
`on_select: { type: "play", track: {…} }`, which slides the existing
SourcePicker open and the addon's `resolve.stream` capability serves
the audio. Episode "save" buttons fire `add_to_library`, which writes
through the existing `/api/cache/add` flow.

Net result: a fully-functional Podcasts tab in the native app,
implemented as one addon with one extra capability and two new
endpoints. Zero changes to core needed once the renderer ships.

## 9. Iframe-hosted tab pages — `ui.tab.page_url`

The JSON catalog flow (§7.1) is enough for browse-and-tap addons.
For addons that need a custom UI — forms, drag-drop zones, queues
with live progress, anything more interactive than tap-a-card —
declare a `page_url` in the manifest:

```json
"ui": {
  "tab": {
    "label": "Import",
    "icon": "download",
    "page_url": "/ui/page",
    "sort_priority": 50
  }
}
```

When `page_url` is set, core renders the tab as a **sandboxed
iframe** pointing at `${addon.url}${page_url}` instead of fetching
`/ui/catalog`. The addon owns the entire page — HTML, CSS, JS, any
client-side framework. Same-origin requests from the iframe back to
the addon's own sidecar work as normal HTTP.

### Sandbox

The iframe is rendered with:

```html
<iframe sandbox="allow-scripts allow-forms allow-popups"
        referrerpolicy="no-referrer" ...>
```

No `allow-same-origin`, so the page cannot read the parent's cookies
or localStorage. The addon's install URL secrets stay in the parent.

### Talking back to core

Iframe pages call `window.audimo` to drive core. See §10.

### Reference implementation

The `audimo-importers` addon is a worked example: its sidecar serves
a single HTML file at `/ui/page` that renders a queue, a CSV
drop-zone, and a worker loop calling `window.audimo.acquireTrack(...)`
to download imported tracks via the user's other installed source
addons.

## 10. `window.audimo` — host RPC bridge

Iframe-hosted tab pages get a `window.audimo` API injected by core
over postMessage. The shim is small (~80 lines); the canonical copy
lives at [`frontend/public/audimo-addon-rpc.js`](../frontend/public/audimo-addon-rpc.js)
in the core repo. Addons SHOULD vendor a copy into their served HTML
(parent and iframe are cross-origin; the iframe can't fetch the
parent's `/public` files).

### Methods

#### `acquireTrack(track, opts?) → AsyncIterable<event>`

Headless equivalent of clicking a result in SourcePicker. Core fans
out across enabled `resolve.sources` addons, picks one source by the
caller's policy, calls `resolve.stream`, and persists the result to
the library cache. Yields progress events until completion or error.

```js
for await (const ev of window.audimo.acquireTrack({
  title: 'Blue Monday',
  artist: 'New Order',
  album: 'Power Corruption & Lies',
  kind: 'music',
  policy: {
    prefer: ['audimo-streamers'],
    fallback_order: ['audimo-indexers', 'audimo-soulseek'],
    min_seeders: 0,
    require_cached: false,
  },
})) {
  // ev.status ∈ 'resolving' | 'picked' | 'downloading' | 'done' | 'error'
  // ev.pct, ev.message, ev.source, ev.addon_id, ev.cacheKey
  console.log(ev.status, ev.message || `${ev.pct}%`)
}
```

**Policy fields (all optional):**

| Field | Default | Notes |
|---|---|---|
| `prefer` | `[]` | Addon IDs to try first, in order. If any returns sources, the first eligible one wins. |
| `fallback_order` | `[]` | Tried after `prefer` exhausts. |
| `min_seeders` | `0` | For torrent sources. Sources with fewer seeders are skipped. |
| `require_cached` | `false` | Only consider sources flagged `is_cached: true` or `rd_cached: true` (instant playback). |

If neither `prefer` nor `fallback_order` matches anything eligible,
core falls through to the remaining enabled addons in registry order.

#### `listAddons() → Promise<Addon[]>`

Returns a sanitized list of enabled addons. URLs are deliberately
omitted — the iframe never sees install URLs (which contain secrets).

```js
const addons = await window.audimo.listAddons()
// [{ id, capabilities, enabled, label }, ...]
```

#### `cancel(rpc_id)`

Cancels an in-flight `acquireTrack` stream. The `rpc_id` is the
`.rpc_id` property attached to the iterable returned by
`acquireTrack`.

```js
const iter = window.audimo.acquireTrack({ ... })
// later:
window.audimo.cancel(iter.rpc_id)
```

Iterating with `for await` and `break`-ing also cancels (the
shim's `Symbol.asyncIterator` calls `cancel` via its `return()` hook).

#### `openExternal(url)` *(via postMessage)*

For OAuth flows and any other "this needs a real top-level
navigation" use case (Spotify OAuth refuses to be iframed, etc.),
post a message to the parent:

```js
window.parent.postMessage({
  __audimo: 1,
  method: 'openExternal',
  url: 'https://exportify.net',
}, '*')
```

The host opens the URL via Tauri's `shell.open` when available
(lands in the user's real browser, where OAuth works normally) or
`window.open(url, '_blank', 'noopener,noreferrer')` as a fallback.
Only `http(s)://` schemes are accepted.

### Wire protocol (parent ↔ iframe)

For addons that prefer to roll their own shim rather than vendor the
canonical one:

**Iframe → parent (request):**
```js
{ __audimo: 1, rpc_id: 'uuid', method: 'acquireTrack', args: { ... } }
{ __audimo: 1, rpc_id: 'uuid', cancel: true }
{ __audimo: 1, ready: true }                              // optional handshake
```

**Parent → iframe (reply):**
```js
{ __audimo: 1, rpc_id: 'uuid', result: ... }              // one-shot
{ __audimo: 1, rpc_id: 'uuid', error: 'message' }
{ __audimo: 1, rpc_id: 'uuid', event: { ... } }           // streaming
{ __audimo: 1, rpc_id: 'uuid', done: true }               // stream ends
```

The parent validates the source `event.source === iframe.contentWindow`
and replies with `targetOrigin = new URL(addon.url).origin`. Messages
from any other window are ignored.

### Security boundary recap

- Sandboxed iframe — no DOM access to the parent, no cookie/storage
  reads.
- Strict origin matching on all RPC replies.
- Addon URLs (with secret config segments) are never sent to the
  iframe; only addon IDs are exposed via `listAddons()`.
- `openExternal` is restricted to `http(s)://` URLs.
- No filesystem, no native API surface beyond what's listed above.

## 11. Operational notes

- **Don't log the URL.** Config segments contain user secrets. uvicorn
  should run with `--no-access-log` (or behind a proxy that strips
  paths). The bundled addons emit a startup warning if neither
  `--no-access-log` nor `TUNNEL_ACCESS_LOG_OK=1` is set.
- **Stamp `addon_id` on every source.** Without it, follow-up
  `resolve.stream` calls have nowhere to go.
- **SSE `done` is mandatory.** The client uses it to know when to
  release the connection. A stream that ends without `done` reads as
  a network failure.
- **Manifests are snapshotted client-side.** When you ship a manifest
  change, existing installs won't see it until the user reinstalls the
  addon URL. Bump `version` so this is visible in the install list.
