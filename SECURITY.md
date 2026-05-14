# Audimo security model

Audimo is a single-user, self-hosted desktop app. This file describes
what the threat model assumes, what it actively defends against, and
what it doesn't. If you're shipping Audimo in a context that doesn't
match these assumptions, read this carefully before deploying.

## Reporting vulnerabilities

If you find a security issue, please open a private security advisory
at <https://github.com/audaro/audimo/security/advisories/new>. Avoid
filing public issues for unpatched vulnerabilities.

## Assumed deployment

* Audimo runs on the user's own machine (desktop app: macOS, Windows,
  Linux).
* The user installed it themselves and trusts the binary they ran.
* `~/.audimo/` is owned by the user account that runs the app.
* The OS keychain is functional (macOS Keychain Services, Windows
  Credential Manager, Linux Secret Service). On systems where it
  isn't, secrets fall back to `~/.audimo/*.key` files with `chmod 0600`
  — protection only as strong as the user's home directory.

## What Audimo protects against

### Drive-by browser tabs (DNS rebinding)

The backend binds `127.0.0.1:8000` and the streaming sidecar binds
`127.0.0.1:11471`. A browser tab the user happens to open on an
attacker site cannot:

* Read the API key (it's only ever in the Tauri-shell-injected
  store, not exposed via cross-origin endpoints).
* Reach `/api/...` endpoints — every endpoint requires
  `X-API-Key: <token>` and the token isn't accessible from other
  origins. The shell mints it into the OS keychain on first boot.
* Get past the `Host:`-header middleware — even with a rebound
  `localhost.attacker.com` resolving to `127.0.0.1`, the backend
  refuses requests whose Host isn't loopback (or, in remote mode,
  the user's explicit LAN/Tailscale host).
* Hit the streaming sidecar — same Host check.

### Other processes on the same machine

Same-machine processes can reach `127.0.0.1:8000` but can't:

* Read the API key from the keychain without entitlements
  (a malicious unsigned binary would have to trigger an OS-level
  permission prompt that names the keyring service).
* Bypass auth — every endpoint requires the token.

A malicious local process that grabs the token (e.g. via reading
`~/.audimo/api_key` if keychain is unavailable, or via an OS-level
keychain breach) **does** get full backend authority. This is
outside Audimo's threat model — that's a compromised user account.

### Malicious RSS feeds / OPML imports

* XML parsing uses `defusedxml` (no DTD/entity expansion).
* Feed `<link>`, `itunes:image href`, and enclosure URLs are
  scrubbed to http(s)-only on the server side. `javascript:`,
  `data:`, `file:` URIs never reach the frontend.
* Server-side URL fetches use a shared SSRF helper (`backend/safe_fetch.py`)
  that resolves the hostname, filters every returned IP against
  a denylist (loopback / RFC1918 / link-local / multicast /
  reserved), and connects to a pinned IP — DNS rebinding-proof.
  Each 3xx redirect is re-validated.

### Server-supplied URLs (audio proxy)

The `/api/audio/proxy` endpoint plays audio from upstream CDNs.
URLs must carry an HMAC-signed token (`?exp=…&t=…`) minted only
by authenticated mint paths (addon callbacks, audiobook saves).
The signing secret is derived from the install's DB Fernet key.
24h token lifetime. Drops 3xx redirects so a compromised CDN
can't pivot to an internal host.

### Addons

* Addons run as separate sidecar processes bound to `127.0.0.1`.
* All addon-supplied URLs are sanitized before any frontend or
  backend fetch (same SSRF helper).
* Addon manifest `id` field is allowlisted to `[a-zA-Z0-9._-]{1,64}`
  so a crafted id can't path-traverse on disk.
* The frontend's `tunnel-addon:install` postMessage path
  cross-origin-checks the sender. Untrusted origins still get
  through, but with an extra warning in the confirm dialog AND
  surface the credential keys the bundle would set on the user's
  behalf — so a drive-by site can't smuggle attacker RD/Soulseek
  credentials into the user's setup.

### Pairing (mobile)

* `/api/pair/redeem` is rate-limited (10 / IP / 60s).
* Pair tokens are 256-bit, single-use, 90s TTL.
* The mobile device receives the same API key the desktop has —
  this is "one identity, multiple devices", not delegated access.
  Regenerate the API key (Settings → Advanced) to revoke every
  paired device at once.

### Encryption at rest

* Addon settings in the SQLite DB are Fernet-encrypted. The key is
  stored in the OS keychain (`KEYRING_USER_SECRET="db_secret_key"`).
* Legacy installs that have a `~/.audimo/secret.key` file are
  migrated into the keychain on first run after upgrade. The file
  remains as a fallback for keychain-denied environments.

## What Audimo does NOT protect against

### A compromised user account

Anything that can read the user's keychain or run as the user is
implicitly trusted. Audimo can't defend against malware running
under the same OS user.

### A maliciously-installed addon

Installing an addon URL hands the addon process the ability to:

* Serve any audio it wants when a track is "resolved".
* Probe the backend's public surface (it knows the install URL).
* Receive the user's debrid/soulseek/etc. credentials that the user
  configured for it.

Treat addon URLs like browser extensions: only install ones from
sources you trust. The bundled credentials displayed in the
install confirm dialog are the strongest signal a malicious
bundle is about to set up credentials you didn't intend.

### A compromised addon catalog

If a catalog source is compromised, the addons it lists can be
tampered with. Audimo's catalog install flow SHA256-verifies
binaries against the manifest's claimed hash, but the manifest
itself isn't signed. A publisher-signature scheme is on the 0.5+
roadmap.

### Network traffic shaping / metadata

Audimo doesn't hide:

* DNS lookups for upstream services (Apple, Deezer, ListenBrainz,
  addon manifest URLs, debrid CDNs).
* The fact that the user is running Audimo (User-Agent: `Audimo/...`
  on outbound requests).
* DHT announces from the libtorrent streaming sidecar (info-hashes
  of torrents the user plays). Disable via Settings → Privacy →
  "DHT announces" or turn the sidecar off entirely.

If anonymity-vs-network-observers matters to you, route the app
through a privacy network (Tor / VPN) at the OS level. Audimo
doesn't ship with built-in proxying.

### Physical access

A disk image of `~/.audimo/` paired with the OS keychain export
is a full backup of Audimo state, including credentials. Audimo
relies on OS-level disk encryption (FileVault, BitLocker, LUKS)
to protect against laptop theft.

## Cryptographic primitives

* DB encryption: `cryptography.fernet.Fernet` (AES-128-CBC + HMAC-SHA256).
* Audio proxy tokens: HMAC-SHA256, truncated to 128 bits.
* API keys: 32 bytes of `os.urandom` / `rand::thread_rng`, base64url-encoded.
* Pair tokens: `secrets.token_urlsafe(32)` (192 bits of entropy).

## Out-of-scope CVE classes

The following don't apply to a localhost-bound desktop app and are
not tracked as vulnerabilities in Audimo:

* "Cross-site scripting" via inputs the user controls themselves
  (their own library, their own podcast subscriptions). XSS via
  third-party RSS feeds IS in scope and patched (see "Malicious
  RSS feeds" above).
* Timing attacks against `hmac.compare_digest`-protected secrets
  on a host with `wmem_max` / TCP-RST latency in the milliseconds.
* DoS via the user's own client (a user attacking themselves).
