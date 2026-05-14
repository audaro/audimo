# Audimo Addon Guide

A practical, tutorial-style walkthrough for building an Audimo addon.
The wire-format reference is [`ADDON_PROTOCOL.md`](ADDON_PROTOCOL.md);
read this one first.

---

## What an addon is

An Audimo addon is an HTTP server. It returns a manifest at
`GET /manifest.json` declaring its `id`, `name`, `version`, and a list
of `capabilities`. Audimo only calls endpoints whose capability the
addon advertises. Anything not advertised, Audimo ignores.

There are three useful shapes:

| Shape | Capability | What it does |
|---|---|---|
| **Source provider** | `resolve.sources` + `resolve.stream` | Discovers playable sources for a track, then materializes a chosen source into a stream URL. Most addons are this shape. |
| **Catalog tab** | `ui.tab` | Adds a JSON-driven tab to the main nav. Audimo renders the cards; you supply data. |
| **Iframe tab** | `ui.tab` with `page_url` | Adds a tab whose content is an iframe pointing at HTML you serve. You own the UI; you call back into core via `window.audimo`. |

You can combine them. A streaming addon might ship `resolve.sources`,
`resolve.stream`, and `ui.home` (Home-view shelves) all in one server.

---

## Picking a stack

The protocol is HTTP+JSON+SSE; any language works. The maintained
addons are Python (FastAPI). The examples below are Python — translate
freely.

**Why Python+FastAPI for new addons:**
- The RPC matches FastAPI's `@app.post` shape exactly
- `StreamingResponse` makes SSE one line
- PyInstaller bundles the addon into a single binary for the
  one-click install pipeline (see [Releasing](#releasing) below)
- Every existing audimo-* addon uses it, so copy-paste is easy

---

## Tutorial 1: a minimal source-provider addon

Build something that returns a fake source for any track. Twenty
minutes end-to-end.

### Layout

```
my-addon/
  manifest.json
  server.py
  requirements.txt
  run_native.sh
```

### `manifest.json`

```json
{
  "schema_version": 1,
  "id": "my-addon",
  "name": "My Addon",
  "version": "0.1.0",
  "description": "A demo source provider.",
  "capabilities": ["resolve.sources", "resolve.stream"],
  "source_contexts": ["music"],
  "display": { "label": "My Addon", "icon": "" }
}
```

### `requirements.txt`

```
fastapi>=0.115
uvicorn[standard]>=0.32
```

### `server.py`

```python
import json
from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

app = FastAPI()
app.add_middleware(
    CORSMiddleware, allow_origins=["*"],
    allow_methods=["*"], allow_headers=["*"],
)

MANIFEST = json.loads(Path(__file__).with_name("manifest.json").read_text())

@app.get("/manifest.json")
async def manifest():
    return JSONResponse(MANIFEST)

@app.post("/resolve/sources")
async def resolve_sources(payload: dict):
    title = (payload.get("title") or "").strip()
    artist = (payload.get("artist") or "").strip()
    if not title:
        return {"sources": []}
    # Pretend we found one streamable source for any track.
    return {"sources": [{
        "addon_id": "my-addon",
        "kind": "stream",
        "name": f"{artist} — {title} (demo)",
        "link": "https://example.com/stream.mp3",
        "link_type": "url",
        "source": "demo",
        "is_cached": True,
    }]}

async def _sse(d: dict) -> bytes:
    return f"data: {json.dumps(d)}\n\n".encode()

@app.post("/resolve/stream")
async def resolve_stream(payload: dict):
    src = payload.get("source") or {}
    async def gen():
        yield await _sse({"type": "progress", "pct": 10, "message": "Connecting…"})
        yield await _sse({
            "type": "ready",
            "stream_url": src.get("link") or "",
            "mime_type": "audio/mpeg",
            "source_label": "Demo",
        })
        yield await _sse({"type": "done"})
    return StreamingResponse(gen(), media_type="text/event-stream")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=9020)
```

### `run_native.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
[[ ! -d .venv ]] && {
  python3 -m venv .venv
  ./.venv/bin/pip install -r requirements.txt
}
exec ./.venv/bin/python server.py
```

```bash
chmod +x run_native.sh && ./run_native.sh
```

### Install it

In Audimo: **Addons → Install → URL** → `http://localhost:9020`.
The addon shows up in the list. Now search for anything in Audimo;
your demo source should appear in the SourcePicker alongside any
other source addons you have installed.

That's the whole loop. From here, see [`ADDON_PROTOCOL.md`](ADDON_PROTOCOL.md)
for the full source schema, the `resolve.sources.stream` variant for
progressive results, `cache.resolve` for re-resolving saved entries,
and so on.

---

## Tutorial 2: an iframe-hosted tab addon

This is the new shape (added 2026-05). Use it when:
- The addon needs UI more interactive than tap-a-card (forms, drag-drop,
  real-time progress, custom layout).
- The addon is a *consumer* of other addons rather than a source
  itself — e.g. importers, smart-radio generators, "rip my history."

The `audimo-importers` addon is the reference implementation.

### Manifest

```json
{
  "schema_version": 1,
  "id": "my-tab-addon",
  "name": "My Tab",
  "version": "0.1.0",
  "capabilities": ["ui.tab"],
  "ui": {
    "tab": {
      "label": "My Tab",
      "icon": "star",
      "page_url": "/ui/page",
      "sort_priority": 50
    }
  }
}
```

`page_url` is the path on the addon's own origin. When set, core
renders the tab as a sandboxed iframe pointing at
`${addon.url}${page_url}` instead of fetching `/ui/catalog`.

### Server route

```python
from fastapi.responses import HTMLResponse

@app.get("/ui/page", response_class=HTMLResponse)
async def ui_page():
    return HTMLResponse(Path(__file__).with_name("page.html").read_text())
```

### `page.html`

```html
<!doctype html>
<html><head><meta charset="utf-8"><title>My Tab</title></head>
<body>
  <h1>Hello from inside Audimo</h1>
  <button id="go">Acquire Blue Monday</button>
  <pre id="log"></pre>

  <script>
  /* Vendor a copy of frontend/public/audimo-addon-rpc.js here.
     The shim defines window.audimo over postMessage. */
  </script>

  <script type="module">
  const log = (s) => document.getElementById('log').textContent += s + '\n';

  document.getElementById('go').onclick = async () => {
    for await (const ev of window.audimo.acquireTrack({
      title: 'Blue Monday',
      artist: 'New Order',
      kind: 'music',
    })) {
      log(`${ev.status} ${ev.pct ?? ''} ${ev.message ?? ''}`);
    }
  };
  </script>
</body></html>
```

### Get the shim

Copy the canonical postMessage shim into your `page.html` (inline) or
serve it from your own `/audimo-addon-rpc.js` route:

```bash
curl -O https://raw.githubusercontent.com/audaro/audimo/main/frontend/public/audimo-addon-rpc.js
```

The iframe page is on a different origin from core's `/public`, so
it can't fetch the parent's copy — you must vendor it.

### What you get

- `window.audimo.acquireTrack(...)` — full source-resolution +
  download + library-save pipeline, headless.
- `window.audimo.listAddons()` — the user's enabled addon list
  (IDs + capabilities only, no URLs).
- `window.audimo.cancel(rpc_id)` — abort an in-flight acquire.
- `postMessage({method: 'openExternal', url})` — open a URL in the
  user's real browser (for OAuth flows that refuse to be iframed).

See [`ADDON_PROTOCOL.md` §10](ADDON_PROTOCOL.md#10-windowaudimo--host-rpc-bridge)
for the full RPC reference.

### Security

The iframe runs with `sandbox="allow-scripts allow-forms allow-popups"`
— no same-origin access. The addon's install URL (which may contain
secrets) is never exposed to the iframe. Strict origin matching on
all postMessage exchanges.

---

## Testing locally

1. Run your addon: `./run_native.sh` (or `python server.py` directly).
2. Run Audimo from source (`npx tauri dev`) or use the installed app.
3. **Addons → Install → URL** → `http://localhost:<your-port>`.
4. Iterate. Manifest is snapshotted on install — bump version + reinstall
   to pick up manifest changes. Runtime endpoints update without
   reinstall (just restart your addon).

For UI-tab addons, the iframe reloads when you reopen the tab.

---

## Releasing

The maintained pattern (used by every audimo-addons repo):

1. Repo on `audimo-addons` GitHub org.
2. PyInstaller spec file (`<addon>.spec`) bundles the sidecar into a
   single binary per platform.
3. GitHub Actions workflow (`.github/workflows/release.yml`) on tag
   push (`<addon>-v0.1.0`):
   - Builds darwin-arm64, linux-x64, win32-x64
   - Generates `manifest.json` with the version from the tag + sha256s
     of each binary
   - Publishes a GitHub Release with all three binaries + manifest
4. The addon's install URL in production becomes the GitHub Releases
   manifest URL; the Audimo app downloads the binary at install time
   and verifies the sha256.

Copy the `release.yml` from any existing audimo-* addon as a starting
point — they're all near-identical.

---

## Conventions

- **snake_case on the wire** (both directions). The frontend
  translates to camelCase internally.
- **CORS open by default** for localhost addons. Public-URL addons
  should gate everything except `/manifest.json` on
  `X-Audimo-Addon-Key`.
- **Stamp `addon_id` on every source.** Without it, follow-up
  `resolve.stream` and `cache.resolve` calls have nowhere to go.
- **SSE streams MUST end with `{"type": "done"}`** so the client
  knows to release the connection.
- **Don't log request URLs.** Path segments contain user secrets.
  uvicorn should run with `--no-access-log`.
- **Manifests are snapshotted at install.** Bump `version` on any
  manifest change so users see it in the update list.

---

## Where to look next

- Wire reference: [`ADDON_PROTOCOL.md`](ADDON_PROTOCOL.md)
- Worked examples (source provider): [`audimo-streamers`](https://github.com/audimo-addons/audimo-streamers), [`audimo-indexers`](https://github.com/audimo-addons/audimo-indexers)
- Worked example (iframe tab): [`audimo-importers`](https://github.com/audimo-addons/audimo-importers)
- Worked example (bundling a binary backend): [`audimo-soulseek`](https://github.com/audimo-addons/audimo-soulseek) (manages an slskd subprocess)
- Catalog listing: [`audimo-catalog`](https://github.com/audimo-addons/audimo-catalog)

To get an addon into the one-click catalog, open a PR against
[`audimo-catalog`](https://github.com/audimo-addons/audimo-catalog)
adding your manifest URL.
