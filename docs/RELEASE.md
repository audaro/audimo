# Audimo release engineering

What needs to happen before pushing a build to users. This file is
the source of truth for signing, notarization, the streaming
sidecar's pre-warmed DHT state, and the auto-updater story.

## 1. Version bump

Bump these in lockstep:

* `frontend/src/version.js` — `VERSION`, `CODENAME`, `RELEASE_DATE`,
  `WHATSNEW_VERSION`.
* `frontend/src-tauri/tauri.conf.json` — top-level `"version"` (Tauri
  reads this for the macOS `CFBundleShortVersionString` /
  `CFBundleVersion` and Windows MSI `ProductVersion`).
* `frontend/src/components/WhatsNewView.jsx` — append the new
  `ITEMS` entries.

## 2. macOS signing + notarization

The tauri config has placeholders for `signingIdentity`,
`providerShortName`, and `entitlements`. Fill these in either at
build time via env vars (recommended for CI) or as JSON values
(easier for local builds).

### Env-var path (recommended)

```sh
export APPLE_SIGNING_IDENTITY="Developer ID Application: <Your Name> (TEAMID)"
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="app-specific-password"   # https://appleid.apple.com → Security → App-specific passwords
export APPLE_TEAM_ID="TEAMID"

cd frontend
npx tauri build
```

Tauri 2 invokes `notarytool` automatically when these env vars are
present. The signed + notarized `Audimo.app` and `Audimo_0.4_x64.dmg`
end up under `frontend/src-tauri/target/release/bundle/`.

### JSON path

```jsonc
// frontend/src-tauri/tauri.conf.json → bundle.macOS
"signingIdentity": "Developer ID Application: <Your Name> (TEAMID)",
"providerShortName": "<TEAMID>",
"entitlements": "entitlements.plist"
```

`entitlements.plist` lives next to `tauri.conf.json` and grants
the minimum needed:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <!-- Outbound network: addons, scrobblers, RSS, audio CDNs. -->
    <key>com.apple.security.network.client</key>
    <true/>
    <!-- Streaming sidecar peer port + addon sidecar bind. -->
    <key>com.apple.security.network.server</key>
    <true/>
    <!-- Audiobook + music files under ~/Music and ~/Audiobooks. -->
    <key>com.apple.security.files.user-selected.read-write</key>
    <true/>
    <!-- yt-dlp cookies-from-browser (audimo-streamers addon). -->
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
</dict>
</plist>
```

### Verifying

After `tauri build`:

```sh
codesign --verify --deep --strict --verbose=4 \
  src-tauri/target/release/bundle/macos/Audimo.app
spctl -a -t exec -vv src-tauri/target/release/bundle/macos/Audimo.app
xcrun stapler validate src-tauri/target/release/bundle/macos/Audimo.app
```

All three should report success. If `spctl` says "rejected", the
notarization step failed or hasn't propagated to Apple's CDN yet
(wait 5-10 min and retry).

## 3. Windows code signing

Tauri 2 reads `WINDOWS_CERTIFICATE_PASSWORD` + `WINDOWS_CERTIFICATE`
env vars. If you don't have an EV cert, the MSI installer triggers
SmartScreen on every download — set expectations in the release notes
("Right-click → Run anyway") or skip Windows entirely for 0.4 and ship
mac-only.

**Decision for 0.4**: ship macOS-only. Windows shows up in 0.5 if
demand justifies the certificate cost. The Linux .deb / .AppImage
output from `tauri build` is unsigned and that's fine — Linux users
expect unsigned binaries.

## 4. Pre-warming the streaming sidecar's DHT state

The bundled `streaming_server/seed_session.dat` is a pre-warmed
libtorrent session.dat snapshot. First-launch DHT bootstrap goes from
30-90s cold to ~5-15s with the seed in place.

### Refresh procedure

```sh
# 1. Run Audimo for ~10 minutes on a healthy network so the local
#    DHT routing table reaches ~100 live nodes.

# 2. Copy the warm session.dat into the repo.
cp ~/.audimo/streaming/session.dat streaming_server/seed_session.dat

# 3. Rebuild the streaming sidecar binary. ⚠ libtorrent is a
#    Homebrew binding, not pip-installable on Apple Silicon — the
#    spec's collect_all('libtorrent') silently no-ops if the build
#    venv can't import it, producing a binary that crashes with
#    ModuleNotFoundError at startup. Always export PYTHONPATH first:
cd streaming_server
export PYTHONPATH="/opt/homebrew/Cellar/libtorrent-rasterbar/$(ls /opt/homebrew/Cellar/libtorrent-rasterbar | tail -1)/lib/python3.14/site-packages"
.venv/bin/pyinstaller audimo_streaming.spec --clean

# Sanity-check the binary actually launches before shipping:
./dist/audimo-streaming &
sleep 8
curl -s http://127.0.0.1:11471/   # expect: {"server":"audimo-streaming",...}
pkill -f audimo-streaming

# 4. Sanity check: the spec's node-id strip should produce a seed
#    that has `nodes` populated but `node-id` absent. Verify with:
python -c "
import libtorrent as lt
data = open('seed_session.dat','rb').read()
state = lt.bdecode(data)
dht = state.get(b'dht state', {})
print('node-id present:', b'node-id' in dht)
print('nodes:', len(dht.get(b'nodes', [])))
"
# Expected: node-id present: False · nodes: 80+
```

### When to refresh

Every 6 months OR when the bootstrap takes noticeably longer than
normal on a fresh install (DHT routing tables drift over time as
nodes churn).

## 5. Auto-updater

**Decision for 0.4**: no auto-updater. Users download new releases
manually from GitHub. Rationale:

* Auto-updater needs its own signing key (separate from the macOS
  Developer ID) and an update-channel server. Both are real
  infrastructure work.
* The user-base is small in 0.4 — manual update fits the launch
  audience.
* Tauri's signed updater is the right answer at scale; revisit
  once 0.5 ships.

When we wire it up later: `tauri-plugin-updater` reads
`updater.endpoints[]` from `tauri.conf.json`, fetches a signed
manifest, verifies via a `TAURI_SIGNING_PUBLIC_KEY` baked into the
binary at build time, and applies the diff. The signing private
key lives outside the repo (`keyring` or 1Password).

**Document in the About page that updates are manual** so first-time
users know to check GitHub for new releases.

## 6. Release checklist

Run through this list before pushing a new release:

1. [ ] `frontend/src/version.js` version bumped.
2. [ ] `frontend/src-tauri/tauri.conf.json` version bumped.
3. [ ] `frontend/src/components/WhatsNewView.jsx` updated.
4. [ ] All addon repos rebuilt + their `manifest.json` versions
   bumped. The catalog (`audimo-catalog/catalog.json`) points to
   the new release URLs.
5. [ ] `streaming_server/seed_session.dat` refreshed (see §4).
6. [ ] `cd frontend && npm test && npm run build` clean.
7. [ ] `cd frontend/src-tauri && cargo test && cargo build --release`
   clean.
8. [ ] Run the UI test plan (`memory/MEMORY.md` → "UI Test Plan").
9. [ ] macOS signed + notarized (verify with `spctl`).
10. [ ] DMG installed on a fresh macOS user account, first-run
    completes without errors.
11. [ ] Crash tripwire dry-run: kill the running app with `pkill -9`,
    relaunch, expect the "didn't shut down cleanly" toast.
12. [ ] Privacy panel in Settings reflects the actual outbound traffic
    list (any new addon or feature changed it?).
13. [ ] Git tag `v0.4.0`, push, draft GitHub release with the DMG
    + .deb attached, paste WhatsNew copy as release notes.
