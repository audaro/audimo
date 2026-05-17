//! User-installed addon sidecars.
//!
//! Distinct from `sidecars::Sidecars`: those are the two binaries
//! bundled with the desktop app at build time (backend + streaming).
//! This module manages addons the *user* installs at runtime via the
//! Audimo catalog UI — each one is a downloaded PyInstaller-style
//! binary that speaks the standard addon HTTP protocol.
//!
//! Disk layout (all under the OS-conventional app-data dir):
//!     <app_data>/audimo/addons/installed/<id>/
//!         manifest.json           release manifest as downloaded
//!         bin/<exe-name>          the addon binary, +x
//!         state/                  addon's own state writes
//!
//! Process lifecycle:
//!   * `install(manifest_url)` downloads the right binary for the
//!     current platform, verifies SHA256, spawns it.
//!   * `spawn_all_installed()` walks `installed/` on app boot and
//!     respawns each addon on its previous port (auto-allocated on
//!     first install; persisted in `runtime.json` so restarts hit
//!     the same URL — important so the frontend's saved addon URL
//!     in localStorage keeps resolving).
//!   * `uninstall(id)` kills the child and removes the addon dir.

use std::collections::HashMap;
use std::fs;
use std::io::Write as _;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Suppress the console window Windows would otherwise allocate for
/// PyInstaller-bundled addon binaries spawned from the GUI app. No-op
/// on POSIX. See sidecars.rs for the same helper applied to the core
/// backend / streaming sidecars.
#[cfg(windows)]
fn no_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(windows))]
fn no_console(_cmd: &mut Command) {}

/// Remove a directory tree, retrying on Windows when the OS hasn't
/// yet released file handles from a freshly-killed process.
///
/// On Windows, `TerminateProcess` returns before all handles in the
/// kernel are torn down — and antivirus scanners frequently re-open
/// files between the kill and our `remove_dir_all`. The result is a
/// race where uninstall fails with "Access is denied (os error 5)"
/// even though we just killed everything. A short retry loop with
/// backoff papers over the race window (~100–500ms in practice).
/// POSIX doesn't have this problem; we still loop once for code
/// symmetry but the first attempt always succeeds.
fn remove_dir_all_with_retry(path: &Path) -> std::io::Result<()> {
    let mut last_err: Option<std::io::Error> = None;
    for delay_ms in [0u64, 100, 250, 500, 1000, 2000] {
        if delay_ms > 0 {
            std::thread::sleep(Duration::from_millis(delay_ms));
        }
        match fs::remove_dir_all(path) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::Other, "remove_dir_all retry exhausted")
    }))
}

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const ADDON_ID_PREFIX_ALLOWED: &str =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";

/// Per-platform binary entry in a release manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BinaryEntry {
    pub url: String,
    pub sha256: String,
}

/// Release manifest published with each addon version.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AddonManifest {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
    pub binaries: HashMap<String, BinaryEntry>,
    #[serde(default)]
    pub default_settings: serde_json::Value,
}

/// Persisted "where did we put this addon last time?" record. Lets us
/// reuse the same port across restarts so the frontend's saved
/// `http://127.0.0.1:<port>` URL keeps working.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RuntimeRecord {
    pub port: u16,
    /// PID of the last-known process on this port. Used on restart to
    /// kill an orphaned process (one that survived because the app was
    /// force-quit and kill_all() never ran) before checking port
    /// availability, so we can reuse the same port instead of
    /// allocating a new one.
    #[serde(default)]
    pub pid: u32,
}

/// Status row exposed to the frontend (`addon_list` etc).
#[derive(Debug, Clone, Serialize)]
pub struct AddonStatus {
    pub id: String,
    pub name: String,
    pub version: String,
    pub running: bool,
    pub port: Option<u16>,
    pub url: Option<String>,
}

struct Running {
    child: Child,
    port: u16,
    manifest: AddonManifest,
}

#[derive(Default)]
pub struct AddonSidecars {
    inner: Mutex<HashMap<String, Running>>,
}

impl AddonSidecars {
    pub fn list(&self) -> Vec<AddonStatus> {
        let g = match self.inner.lock() {
            Ok(g) => g,
            Err(_) => return vec![],
        };
        g.values()
            .map(|r| AddonStatus {
                id: r.manifest.id.clone(),
                name: r.manifest.name.clone(),
                version: r.manifest.version.clone(),
                running: true,
                port: Some(r.port),
                url: Some(format!("http://127.0.0.1:{}", r.port)),
            })
            .collect()
    }

    pub fn kill_all(&self) {
        if let Ok(mut g) = self.inner.lock() {
            for (_, mut r) in g.drain() {
                let _ = r.child.kill();
                let _ = r.child.wait();
            }
        }
    }

    pub fn kill(&self, id: &str) {
        if let Ok(mut g) = self.inner.lock() {
            if let Some(mut r) = g.remove(id) {
                // PyInstaller's single-file bootstrapper spawns the
                // real Python interpreter as a *child*. Killing the
                // bootstrapper alone leaves that child running, and
                // the child still holds the addon `.exe` + `_MEI*`
                // tempdir open — making uninstall fail with
                // "access denied (os error 5)" on Windows. Take down
                // the whole process tree before reaping.
                #[cfg(windows)]
                {
                    let mut tk = std::process::Command::new("taskkill");
                    tk.args(["/T", "/F", "/PID", &r.child.id().to_string()]);
                    no_console(&mut tk);
                    let _ = tk.status();
                }
                let _ = r.child.kill();
                let _ = r.child.wait();
            }
        }
    }

    /// Spawn the binary for an already-installed addon and register
    /// it in the in-memory map. Returns the bound port.
    pub fn spawn_installed(&self, id: &str, root: &Path) -> Result<u16, String> {
        let dir = installed_dir(root).join(id);
        let manifest_path = dir.join("manifest.json");
        let manifest: AddonManifest = serde_json::from_slice(
            &fs::read(&manifest_path).map_err(|e| format!("read manifest: {e}"))?,
        )
        .map_err(|e| format!("parse manifest: {e}"))?;
        if manifest.id != id {
            return Err(format!(
                "manifest id mismatch: expected {id}, got {}",
                manifest.id
            ));
        }

        let bin = bin_path(&dir, id);
        if !bin.is_file() {
            return Err(format!("addon binary missing: {bin:?}"));
        }

        // Reuse the previous port if we have one persisted, else
        // auto-allocate a fresh one. Persistence matters because the
        // frontend stores the addon URL in localStorage; if the port
        // changes on every boot the saved URL goes stale immediately.
        let runtime_path = dir.join("runtime.json");
        let prior: RuntimeRecord = fs::read(&runtime_path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();

        // Kill any orphaned process from a previous session (e.g. after
        // force-quit, kill_all() never ran and the old process is still
        // holding its port). We do this before the port-free check so we
        // can reuse the same port rather than allocating a new one, which
        // would break the frontend's stored addon URL.
        if prior.pid > 0 {
            kill_pid_if_addon(prior.pid, &installed_dir(root));
            // Wait for the port to actually free up — kernel takes
            // a moment after SIGKILL to reclaim, and the previous
            // 300ms blanket sleep wasn't always enough on busy
            // sidecars holding open connections. Bail at 2s and
            // fall through to allocating a fresh port.
            let deadline = Instant::now() + Duration::from_millis(2000);
            while !port_is_free(prior.port) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(100));
            }
        }

        let port = if prior.port > 0 && port_is_free(prior.port) {
            prior.port
        } else {
            allocate_free_port()?
        };

        let state_dir = dir.join("state");
        let _ = fs::create_dir_all(&state_dir);

        // Bind matches the main backend: loopback by default, all
        // interfaces when remote (phone) access is enabled. Without
        // this, the phone hits the rewritten URL (tailscale-host:port)
        // but the addon's socket only accepts loopback — so audio
        // requests time out and "nothing plays".
        let bind_host = if crate::prefs::load().remote_enabled {
            "0.0.0.0"
        } else {
            "127.0.0.1"
        };

        log::info!("spawning addon {id} on port {port} bind={bind_host} ({bin:?})");
        let mut cmd = Command::new(&bin);
        cmd.env("AUDIMO_ADDON_HOST", bind_host)
            .env("AUDIMO_ADDON_PORT", port.to_string())
            .env("AUDIMO_STREAMERS_HOST", bind_host)
            .env("AUDIMO_STREAMERS_PORT", port.to_string())
            .env("AUDIMO_STREAMERS_STATE_DIR", &state_dir)
            .env("AUDIMO_INDEXERS_HOST", bind_host)
            .env("AUDIMO_INDEXERS_PORT", port.to_string())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        no_console(&mut cmd);
        let child = cmd
            .spawn()
            .map_err(|e| format!("spawn {bin:?}: {e}"))?;

        // Persist port + PID for next boot so we can kill orphans.
        let child_pid = child.id();
        let _ = fs::write(
            &runtime_path,
            serde_json::to_vec(&RuntimeRecord { port, pid: child_pid }).unwrap_or_default(),
        );

        // PyInstaller single-file binaries extract ~30MB to /tmp on every
        // launch before the Python interpreter starts. On this machine that
        // takes ~5–6 seconds. 15s is generous but startup is a one-time
        // cost and we want callers to get a live URL back, not a race.
        if !wait_for_port(port, 15_000) {
            log::warn!("addon {id} did not bind {port} within 15s — returning anyway");
        }

        let mut g = self
            .inner
            .lock()
            .map_err(|_| "addon registry poisoned".to_string())?;
        // Replace any previous handle for the same id (defensive — e.g.
        // double install or restart races).
        if let Some(mut prev) = g.remove(id) {
            let _ = prev.child.kill();
            let _ = prev.child.wait();
        }
        g.insert(
            id.to_string(),
            Running {
                child,
                port,
                manifest,
            },
        );
        Ok(port)
    }
}

// ── Filesystem helpers ──────────────────────────────────────────────

/// `<app_data>/audimo/addons/`. Created on first access.
pub fn addons_root() -> Result<PathBuf, String> {
    let base = dirs::data_dir().ok_or_else(|| "no data dir".to_string())?;
    let p = base.join("audimo").join("addons");
    fs::create_dir_all(&p).map_err(|e| format!("mkdir {p:?}: {e}"))?;
    Ok(p)
}

fn installed_dir(root: &Path) -> PathBuf {
    root.join("installed")
}

fn bin_path(dir: &Path, id: &str) -> PathBuf {
    let exe_name = if cfg!(target_os = "windows") {
        format!("{id}.exe")
    } else {
        id.to_string()
    };
    dir.join("bin").join(exe_name)
}

fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| ADDON_ID_PREFIX_ALLOWED.contains(c))
}

// ── Network helpers ─────────────────────────────────────────────────

/// Sweep every process whose executable path lives under the
/// addons install root and SIGKILL it. Run at boot before respawn
/// to catch orphans from prior crash/force-quit sessions whose
/// `runtime.json` PID was overwritten by a later launch (so the
/// per-addon orphan-kill in `spawn_installed` only catches the
/// most recent prior PID, missing earlier zombies).
pub fn kill_strays_under(installed_root: &Path) {
    #[cfg(unix)]
    {
        let root = installed_root.to_string_lossy().to_string();
        if root.is_empty() { return; }
        let out = std::process::Command::new("pgrep")
            .args(["-f", &root])
            .output();
        let Ok(out) = out else { return };
        if !out.status.success() { return }
        let stdout = String::from_utf8_lossy(&out.stdout);
        let our_pid = std::process::id();
        let mut killed = 0;
        for line in stdout.lines() {
            let Ok(pid) = line.trim().parse::<u32>() else { continue };
            // Don't shoot ourselves or our parent shell.
            if pid == our_pid || pid == 0 { continue }
            // pgrep -f matches anything containing the root string,
            // including this very Tauri process if its command line
            // happens to include the path. Verify via the same exec
            // check `kill_pid_if_addon` uses.
            if !pid_belongs_to_addon(pid, installed_root) { continue }
            let _ = std::process::Command::new("kill")
                .arg("-9")
                .arg(pid.to_string())
                .status();
            killed += 1;
        }
        if killed > 0 {
            log::info!("addon stray-sweep: killed {killed} orphaned sidecar(s)");
            // Give the kernel a beat to release the ports before
            // respawn tries to reclaim them.
            std::thread::sleep(Duration::from_millis(300));
        }
    }
    #[cfg(not(unix))]
    {
        let _ = installed_root;
    }
}

/// Hard-kill an addon-sidecar PID. Verifies the PID still belongs
/// to a binary under `installed/` before signaling — guards
/// against the OS recycling the PID to an unrelated process
/// between sessions. SIGKILL because PyInstaller-frozen sidecars
/// frequently ignore SIGTERM (their Python signal handlers don't
/// chain to the bootstrap stub), so a polite kill leaves orphans.
fn kill_pid_if_addon(pid: u32, installed_root: &Path) {
    if pid == 0 || !pid_belongs_to_addon(pid, installed_root) {
        return;
    }
    #[cfg(unix)]
    {
        let _ = std::process::Command::new("kill")
            .arg("-9")
            .arg(pid.to_string())
            .status();
    }
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/F"]);
        no_console(&mut cmd);
        let _ = cmd.status();
    }
}

/// True when `pid`'s executable path lives under the addons
/// install root. Used to make sure we don't kill an unrelated
/// process whose PID was recycled. macOS / Linux only — Windows
/// falls back to "trust the runtime.json".
#[cfg(unix)]
fn pid_belongs_to_addon(pid: u32, installed_root: &Path) -> bool {
    let out = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output();
    let Ok(out) = out else { return false };
    if !out.status.success() {
        return false;
    }
    let cmd = String::from_utf8_lossy(&out.stdout);
    let root = installed_root.to_string_lossy();
    cmd.contains(root.as_ref())
}
#[cfg(not(unix))]
fn pid_belongs_to_addon(_pid: u32, _installed_root: &Path) -> bool { true }

fn allocate_free_port() -> Result<u16, String> {
    // Bind to :0, drop the socket, return the port. Brief race window
    // until we re-bind from the addon, but in practice fine on a
    // single-user machine.
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("port allocate: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("port read: {e}"))?
        .port();
    drop(listener);
    Ok(port)
}

fn port_is_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn wait_for_port(port: u16, timeout_ms: u64) -> bool {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        if std::net::TcpStream::connect_timeout(
            &(std::net::Ipv4Addr::new(127, 0, 0, 1), port).into(),
            Duration::from_millis(150),
        )
        .is_ok()
        {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(80));
    }
}

// ── Platform identifier (matches manifest binary keys) ─────────────

pub fn current_platform() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "darwin-arm64"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "darwin-x64"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "linux-x64"
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "win32-x64"
    }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "x86_64"),
    )))]
    {
        "unsupported"
    }
}

// ── Public install / uninstall ──────────────────────────────────────

/// Fetch a release manifest, download the matching binary, verify its
/// SHA256, write everything into `<addons>/installed/<id>/`. Caller is
/// expected to invoke `spawn_installed(id)` afterwards.
///
/// `on_progress(id, pct, message)` is called during the download so
/// the caller can emit UI events. The manifest fetch is fast (~1KB)
/// and happens before the first callback fires.
///
/// Synchronous on purpose — call this from `tauri::async_runtime::spawn_blocking`.
pub fn install_blocking(
    manifest_url: &str,
    on_progress: impl Fn(&str, u8, &str),
) -> Result<AddonManifest, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent(concat!("audimo/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let resp = client
        .get(manifest_url)
        .send()
        .map_err(|e| format!("fetch manifest: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("manifest HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().map_err(|e| format!("read manifest: {e}"))?;
    let manifest: AddonManifest =
        serde_json::from_slice(&bytes).map_err(|e| format!("parse manifest: {e}"))?;
    if !safe_id(&manifest.id) {
        return Err(format!("rejecting unsafe addon id: {:?}", manifest.id));
    }

    on_progress(&manifest.id, 5, "Manifest verified");

    let plat = current_platform();
    let entry = manifest
        .binaries
        .get(plat)
        .ok_or_else(|| format!("no binary for platform {plat}"))?;

    let root = addons_root()?;
    let dir = installed_dir(&root).join(&manifest.id);
    fs::create_dir_all(dir.join("bin")).map_err(|e| format!("mkdir: {e}"))?;
    fs::create_dir_all(dir.join("state")).map_err(|e| format!("mkdir: {e}"))?;

    let target = bin_path(&dir, &manifest.id);
    let staging = target.with_extension("partial");

    log::info!("downloading addon binary {} for {plat}", entry.url);
    let mut bin_resp = client
        .get(&entry.url)
        .send()
        .map_err(|e| format!("download binary: {e}"))?;
    if !bin_resp.status().is_success() {
        return Err(format!("binary HTTP {}", bin_resp.status()));
    }

    let content_len = bin_resp
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);

    {
        let mut f = fs::File::create(&staging).map_err(|e| format!("create {staging:?}: {e}"))?;
        let mut downloaded: u64 = 0;
        let mut buf = vec![0u8; 65536];
        let id = manifest.id.as_str();
        loop {
            use std::io::Read as _;
            let n = bin_resp.read(&mut buf).map_err(|e| format!("read binary: {e}"))?;
            if n == 0 {
                break;
            }
            f.write_all(&buf[..n]).map_err(|e| format!("write binary: {e}"))?;
            downloaded += n as u64;
            if content_len > 0 {
                // Map download progress to 10–85% of the overall bar.
                let dl_pct = (downloaded * 100 / content_len).min(100);
                let pct = (10 + dl_pct * 75 / 100) as u8;
                let mb_done = downloaded / 1_048_576;
                let mb_total = content_len / 1_048_576;
                on_progress(id, pct, &format!("Downloading… {mb_done}MB / {mb_total}MB"));
            } else {
                let mb_done = downloaded / 1_048_576;
                on_progress(id, 50, &format!("Downloading… {mb_done}MB"));
            }
        }
        f.flush().ok();
    }

    on_progress(&manifest.id, 87, "Verifying…");

    let actual_sha = sha256_of(&staging)?;
    if !actual_sha.eq_ignore_ascii_case(&entry.sha256) {
        let _ = fs::remove_file(&staging);
        return Err(format!(
            "sha256 mismatch: manifest={} actual={}",
            entry.sha256, actual_sha
        ));
    }

    on_progress(&manifest.id, 93, "Installing…");

    fs::rename(&staging, &target).map_err(|e| format!("rename {target:?}: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&target)
            .map_err(|e| format!("stat {target:?}: {e}"))?
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&target, perms)
            .map_err(|e| format!("chmod {target:?}: {e}"))?;
    }

    let manifest_path = dir.join("manifest.json");
    fs::write(&manifest_path, &bytes).map_err(|e| format!("write manifest: {e}"))?;

    on_progress(&manifest.id, 97, "Starting…");

    Ok(manifest)
}

pub fn uninstall_blocking(id: &str) -> Result<(), String> {
    if !safe_id(id) {
        return Err(format!("unsafe id: {id:?}"));
    }
    let root = addons_root()?;
    let dir = installed_dir(&root).join(id);
    if dir.exists() {
        remove_dir_all_with_retry(&dir)
            .map_err(|e| format!("rm {dir:?}: {e}"))?;
    }
    // PyInstaller single-file binaries extract to a temp dir
    // (`/tmp/_MEIxxxxxx` on POSIX, `%TEMP%\_MEIxxxxxx` on Windows) on
    // each launch. Killed processes don't run atexit cleanups, so these
    // accumulate. Sweep any leftover dirs on uninstall.
    if let Ok(entries) = fs::read_dir(std::env::temp_dir()) {
        for ent in entries.flatten() {
            let name = ent.file_name();
            let s = name.to_string_lossy();
            if s.starts_with("_MEI") {
                let _ = fs::remove_dir_all(ent.path());
            }
        }
    }
    Ok(())
}

/// Walk `<addons>/installed/` and return manifests for every addon
/// present on disk (running or not).
pub fn list_installed_on_disk() -> Vec<AddonManifest> {
    let root = match addons_root() {
        Ok(r) => r,
        Err(_) => return vec![],
    };
    let dir = installed_dir(&root);
    let mut out = vec![];
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return vec![],
    };
    for ent in entries.flatten() {
        let mp = ent.path().join("manifest.json");
        if let Ok(b) = fs::read(&mp) {
            if let Ok(m) = serde_json::from_slice::<AddonManifest>(&b) {
                out.push(m);
            }
        }
    }
    out
}

/// Catalog fetcher — returns the parsed JSON verbatim. The frontend
/// shapes it; we just verify the network call.
pub fn fetch_catalog_blocking(catalog_url: &str) -> Result<serde_json::Value, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent(concat!("audimo/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let resp = client
        .get(catalog_url)
        .send()
        .map_err(|e| format!("fetch catalog: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("catalog HTTP {}", resp.status()));
    }
    resp.json::<serde_json::Value>()
        .map_err(|e| format!("parse catalog: {e}"))
}

fn sha256_of(path: &Path) -> Result<String, String> {
    let mut f = fs::File::open(path).map_err(|e| format!("open {path:?}: {e}"))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut f, &mut hasher).map_err(|e| format!("hash {path:?}: {e}"))?;
    Ok(hex::encode(hasher.finalize()))
}
