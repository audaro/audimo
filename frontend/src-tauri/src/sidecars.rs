//! Sidecar process management.
//!
//! Two children, both optional:
//!   * **backend**   — Audimo core FastAPI app (`backend/`). Respawned
//!     on demand when remote-access settings change.
//!   * **streaming** — bundled core libtorrent streaming server (port
//!     11471, Stremio-style API). Content-agnostic: caller hands it
//!     `infohash + file_idx`, server peers + streams. No indexers, no
//!     debrid, no source discovery — those live in optional addons the
//!     user installs themselves.
//!
//! Indexer / source-discovery addons (e.g. audimo-aio, audimo-indexers)
//! are NOT bundled. A fresh install ships zero addons; the user opts in
//! by pasting a configured addon URL into the Addons tab.
//!
//! In dev we shell out to the repo's Python venv. In a packaged build
//! we look for PyInstaller-built sidecar binaries next to the Tauri
//! executable. The dev path also honours opt-out env vars
//! (`AUDIMO_TAURI_NO_BACKEND`, `AUDIMO_TAURI_NO_STREAMING`,
//! `AUDIMO_TAURI_NO_SIDECAR`) so an externally-managed instance
//! (e.g. launchd) doesn't get clobbered.

use std::fs;
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub const BACKEND_PORT: u16 = 8000;
pub const STREAMING_PORT: u16 = 11471;

// ── Orphan PID tracking ────────────────────────────────────────────
// The bundled backend / streaming children are stored in a Mutex on
// the running app, so a graceful exit (`RunEvent::Exit` in lib.rs)
// kills them via `kill_all`. A force-quit (kill -9, OS shutdown,
// power loss) doesn't run that handler, leaving orphan processes on
// :8000 / :11471. On the next boot, `port_in_use(STREAMING_PORT)`
// then returns true and we silently adopt the stale process; the
// backend, with no port-in-use guard, just fails to bind.
//
// Persisting `{backend_pid, streaming_pid}` lets us SIGTERM the prior
// orphan before respawning. Mirrors `addon_sidecars::RuntimeRecord`.

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct SidecarRuntime {
    #[serde(default)]
    backend_pid: u32,
    #[serde(default)]
    streaming_pid: u32,
}

fn runtime_path() -> Option<PathBuf> {
    let base = dirs::data_dir()?;
    let dir = base.join("audimo");
    let _ = fs::create_dir_all(&dir);
    Some(dir.join("sidecars-runtime.json"))
}

fn load_runtime() -> SidecarRuntime {
    runtime_path()
        .and_then(|p| fs::read(&p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save_runtime(rec: &SidecarRuntime) {
    if let Some(p) = runtime_path() {
        if let Ok(bytes) = serde_json::to_vec(rec) {
            let _ = fs::write(p, bytes);
        }
    }
}

#[cfg(unix)]
fn signal_pid(pid: u32, sig: &str) {
    let _ = Command::new("kill").arg(sig).arg(pid.to_string()).status();
}

#[cfg(windows)]
fn force_kill_pid(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/F"])
        .status();
}

/// Wait up to `timeout` for `port` to become free. Returns true if it did.
fn wait_port_free(port: u16, timeout: Duration) -> bool {
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        if !port_in_use(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    !port_in_use(port)
}

/// Wait up to `timeout` for `port` to become bound. Returns true if it did.
fn wait_port_bound(port: u16, timeout: Duration) -> bool {
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        if port_in_use(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    port_in_use(port)
}

/// Kill an orphan PID still holding `port`. Escalates TERM → KILL and
/// only returns `true` once the port is actually free. The previous
/// implementation fire-and-forgot SIGTERM and slept 300ms, so a backend
/// that swallowed TERM (or was mid-syscall) would survive every "reap"
/// and keep serving on loopback while the new spawn silently failed to
/// bind. Returning a success bool lets the caller decide whether to
/// proceed with the spawn at all.
#[must_use]
fn reap_orphan_if_present(label: &str, pid: u32, port: u16) -> bool {
    if pid == 0 || !port_in_use(port) {
        return true;
    }
    log::info!("sidecars: reaping orphan {label} pid={pid} on port {port}");

    #[cfg(unix)]
    {
        signal_pid(pid, "-TERM");
        if wait_port_free(port, Duration::from_millis(1500)) {
            return true;
        }
        log::warn!(
            "sidecars: {label} pid={pid} ignored SIGTERM after 1.5s — escalating to SIGKILL"
        );
        signal_pid(pid, "-KILL");
        if wait_port_free(port, Duration::from_millis(1500)) {
            return true;
        }
    }
    #[cfg(windows)]
    {
        force_kill_pid(pid);
        if wait_port_free(port, Duration::from_millis(1500)) {
            return true;
        }
    }

    log::error!(
        "sidecars: failed to free port {port} from {label} pid={pid} — port still bound \
         (possibly a different process now owns the PID, or an externally-managed instance)"
    );
    false
}

#[derive(Default)]
pub struct Sidecars {
    backend: Mutex<Option<Child>>,
    streaming: Mutex<Option<Child>>,
}

impl Sidecars {
    pub fn set_backend(&self, child: Child) {
        if let Ok(mut g) = self.backend.lock() {
            if let Some(mut old) = g.take() {
                let _ = old.kill();
                let _ = old.wait();
            }
            *g = Some(child);
        }
    }

    pub fn set_streaming(&self, child: Child) {
        if let Ok(mut g) = self.streaming.lock() {
            // Mirror set_backend: kill the previous child before
            // overwriting. Without this, a respawn (or accidental
            // double-spawn during startup) leaks the prior process,
            // which then fights us for :11471 on the next launch.
            if let Some(mut old) = g.take() {
                let _ = old.kill();
                let _ = old.wait();
            }
            *g = Some(child);
        }
    }

    pub fn kill_backend(&self) {
        if let Ok(mut g) = self.backend.lock() {
            if let Some(mut c) = g.take() {
                let _ = c.kill();
                let _ = c.wait();
            }
        }
    }

    pub fn kill_all(&self) {
        self.kill_backend();
        if let Ok(mut g) = self.streaming.lock() {
            if let Some(mut c) = g.take() {
                let _ = c.kill();
                let _ = c.wait();
            }
        }
    }
}

/// True if something is already listening on 127.0.0.1:port — usually
/// a launchd-managed sidecar in dev. We don't try to fight it.
fn port_in_use(port: u16) -> bool {
    TcpStream::connect_timeout(
        &(std::net::Ipv4Addr::new(127, 0, 0, 1), port).into(),
        Duration::from_millis(150),
    )
    .is_ok()
}

/// Best-effort lookup of the repo root in dev mode. Walks up from the
/// current working directory until we hit a directory containing both
/// `backend/` and `streaming_server/`. Honours `AUDIMO_REPO_ROOT`
/// override.
pub fn find_repo_root() -> PathBuf {
    if let Ok(env_root) = std::env::var("AUDIMO_REPO_ROOT") {
        return PathBuf::from(env_root);
    }
    let mut cur = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    for _ in 0..6 {
        if cur.join("backend").is_dir() && cur.join("streaming_server").is_dir() {
            return cur;
        }
        if !cur.pop() {
            break;
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn env_flag(name: &str) -> bool {
    matches!(std::env::var(name).as_deref(), Ok("1") | Ok("true"))
}

/// Resolve the python interpreter to use for dev-mode sidecars.
fn resolve_python(dir: &PathBuf) -> String {
    if let Ok(p) = std::env::var("AUDIMO_PYTHON") {
        return p;
    }
    let venv = dir.join("venv/bin/python");
    if venv.is_file() {
        return venv.to_string_lossy().into_owned();
    }
    let dot_venv = dir.join(".venv/bin/python");
    if dot_venv.is_file() {
        return dot_venv.to_string_lossy().into_owned();
    }
    "python3".into()
}

/// Spawn the backend sidecar.
///
/// * `remote_enabled = false` → bind 127.0.0.1, no API key. The
///   desktop webview is the only thing that can reach it.
/// * `remote_enabled = true`  → bind 0.0.0.0 and inject
///   `AUDIMO_API_KEY` from the keychain. The user has explicitly
///   opted in to phone access.
pub fn spawn_backend(
    app: &AppHandle,
    remote_enabled: bool,
    api_key: Option<&str>,
) -> Option<Child> {
    // Mint the DB encryption key on first boot and pass it via env.
    // Backend prefers AUDIMO_SECRET_KEY > legacy TUNNEL_SECRET_KEY >
    // ~/.audimo/secret.key file. Best-effort: if keyring access fails,
    // the backend falls back to the file path.
    let secret_key = crate::prefs::ensure_secret_key().ok();
    if env_flag("AUDIMO_TAURI_NO_BACKEND") || env_flag("AUDIMO_TAURI_NO_SIDECAR") {
        log::info!("backend sidecar disabled via env");
        return None;
    }

    // Reap any orphan from a force-quit before trying to bind. If we
    // can't free the port, spawning is pointless — the new child would
    // fail to bind and exit, leaving the zombie in charge of :8000.
    let mut runtime = load_runtime();
    if !reap_orphan_if_present("audimo-backend", runtime.backend_pid, BACKEND_PORT) {
        log::error!(
            "backend sidecar: port {BACKEND_PORT} still bound after reap attempt — \
             refusing to spawn (would fail to bind silently). Resolve the conflicting \
             process and relaunch."
        );
        return None;
    }

    let host = if remote_enabled { "0.0.0.0" } else { "127.0.0.1" };
    let port = BACKEND_PORT.to_string();

    // Production path: PyInstaller binary placed next to the Tauri exe.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let bundled = dir.join("audimo-backend");
            if bundled.is_file() {
                log::info!("spawning bundled backend: {:?} (remote={})", bundled, remote_enabled);
                let mut cmd = Command::new(&bundled);
                cmd.env("AUDIMO_BACKEND_HOST", host)
                    .env("AUDIMO_BACKEND_PORT", &port);
                if let Some(k) = api_key {
                    cmd.env("AUDIMO_API_KEY", k);
                } else {
                    cmd.env_remove("AUDIMO_API_KEY");
                }
                if let Some(s) = secret_key.as_deref() {
                    cmd.env("AUDIMO_SECRET_KEY", s);
                }
                if let Ok(res_dir) = app.path().resource_dir() {
                    let candidates = [
                        res_dir.join("_up_").join("dist"),
                        res_dir.join("dist"),
                    ];
                    if let Some(d) = candidates.iter().find(|p| p.is_dir()) {
                        log::info!("frontend dist resource: {:?}", d);
                        cmd.env("AUDIMO_FRONTEND_DIST", d);
                    } else {
                        log::warn!("no frontend dist resource found under {:?}", res_dir);
                    }
                }
                let child_opt = cmd
                    .stdout(Stdio::inherit())
                    .stderr(Stdio::inherit())
                    .spawn()
                    .map_err(|e| log::error!("failed to spawn bundled backend: {e}"))
                    .ok();
                if let Some(ref c) = child_opt {
                    runtime.backend_pid = c.id();
                    save_runtime(&runtime);
                    verify_backend_bound(c.id(), host);
                }
                return child_opt;
            }
        }
    }

    // Dev path
    let repo_root = app
        .try_state::<crate::AppState>()
        .map(|s| s.repo_root.clone())
        .unwrap_or_else(find_repo_root);
    let backend_dir = repo_root.join("backend");
    if !backend_dir.is_dir() {
        log::warn!("backend dir not found at {:?}", backend_dir);
        return None;
    }
    let python = resolve_python(&backend_dir);
    log::info!(
        "spawning backend (dev): {} run.py host={} port={} remote={}",
        python, host, port, remote_enabled
    );
    let mut cmd = Command::new(&python);
    cmd.arg("run.py")
        .current_dir(&backend_dir)
        .env("AUDIMO_BACKEND_HOST", host)
        .env("AUDIMO_BACKEND_PORT", &port);
    if let Some(k) = api_key {
        cmd.env("AUDIMO_API_KEY", k);
    } else {
        cmd.env_remove("AUDIMO_API_KEY");
    }
    if let Some(s) = secret_key.as_deref() {
        cmd.env("AUDIMO_SECRET_KEY", s);
    }
    let child_opt = cmd
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| log::error!("failed to spawn backend: {e}"))
        .ok();
    if let Some(ref c) = child_opt {
        runtime.backend_pid = c.id();
        save_runtime(&runtime);
        verify_backend_bound(c.id(), host);
    }
    child_opt
}

/// Confirm the newly-spawned backend actually grabbed :BACKEND_PORT.
/// Logs an error (but does not kill the child) if it didn't — common
/// cause is a leftover orphan our reap missed, in which case the new
/// child is exiting and the loopback zombie is still serving. Surfacing
/// it as ERROR makes the case grep-able instead of "why is my UI stuck".
fn verify_backend_bound(pid: u32, host: &str) {
    if !wait_port_bound(BACKEND_PORT, Duration::from_secs(8)) {
        log::error!(
            "backend sidecar pid={pid} did not bind {host}:{BACKEND_PORT} within 8s \
             — child likely exited (orphan on loopback may still be serving)"
        );
        return;
    }
    log::info!("backend sidecar pid={pid} listening on {host}:{BACKEND_PORT}");
}

/// Spawn the bundled audimo-streaming sidecar — Stremio-style local
/// libtorrent server on `127.0.0.1:11471`. Bundled binary in
/// production, `streaming_server/run_native.sh` in dev. Skipped if a
/// launchd-managed instance is already on the port, OR if the user
/// disabled the sidecar in privacy settings.
pub fn spawn_streaming(repo_root: &PathBuf) -> Option<Child> {
    if env_flag("AUDIMO_TAURI_NO_STREAMING") || env_flag("AUDIMO_TAURI_NO_SIDECAR") {
        log::info!("streaming sidecar disabled via env");
        return None;
    }
    let prefs = crate::prefs::load();
    if prefs.privacy_no_streaming {
        log::info!("streaming sidecar disabled via privacy prefs");
        return None;
    }

    // Reap our own orphan first. If the prior streaming PID matches a
    // process listening on :11471, it's our own zombie and we own the
    // right to kill it. After the kill the port-in-use check below
    // becomes meaningful again — anything still bound is a launchd
    // (or other externally-managed) instance we shouldn't fight.
    //
    // If the reap *failed* (port still ours but we couldn't free it),
    // the old assumption "anything still bound is externally-managed"
    // is wrong — that's our own zombie, not launchd. Distinguish the
    // two by checking whether we just tried to reap a known PID.
    let mut runtime = load_runtime();
    let had_pid = runtime.streaming_pid != 0;
    let reap_ok = reap_orphan_if_present(
        "audimo-streaming",
        runtime.streaming_pid,
        STREAMING_PORT,
    );

    if port_in_use(STREAMING_PORT) {
        if had_pid && !reap_ok {
            log::error!(
                "streaming sidecar: port {STREAMING_PORT} still bound by our own \
                 orphan pid={} after reap attempt — refusing to spawn",
                runtime.streaming_pid
            );
        } else {
            log::info!(
                "streaming sidecar: port {STREAMING_PORT} already bound \
                 — assuming externally-managed instance"
            );
        }
        return None;
    }

    // Pass privacy toggles via env so streaming_server/server.py can
    // apply them at session-init time. The user's prefs above already
    // determined we should spawn at all; these refine WHAT the sidecar
    // announces while it runs.
    let mk_envs = || -> Vec<(&'static str, &'static str)> {
        let mut envs: Vec<(&'static str, &'static str)> = Vec::new();
        if prefs.privacy_no_dht { envs.push(("AUDIMO_STREAMING_NO_DHT", "1")); }
        if prefs.privacy_no_lsd { envs.push(("AUDIMO_STREAMING_NO_LSD", "1")); }
        if prefs.privacy_no_pex { envs.push(("AUDIMO_STREAMING_NO_PEX", "1")); }
        envs
    };

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let bundled = dir.join("audimo-streaming");
            if bundled.is_file() {
                log::info!("spawning bundled streaming: {:?}", bundled);
                let mut cmd = Command::new(&bundled);
                for (k, v) in mk_envs() { cmd.env(k, v); }
                let child_opt = cmd
                    .stdout(Stdio::inherit())
                    .stderr(Stdio::inherit())
                    .spawn()
                    .map_err(|e| log::error!("failed to spawn bundled streaming: {e}"))
                    .ok();
                if let Some(ref c) = child_opt {
                    runtime.streaming_pid = c.id();
                    save_runtime(&runtime);
                    verify_streaming_bound(c.id());
                }
                return child_opt;
            }
        }
    }

    let script = repo_root.join("streaming_server/run_native.sh");
    if !script.is_file() {
        log::warn!("streaming launcher not found at {:?}", script);
        return None;
    }
    log::info!("spawning streaming (dev): {:?}", script);
    let mut cmd = Command::new("bash");
    cmd.arg(script).current_dir(repo_root.join("streaming_server"));
    for (k, v) in mk_envs() { cmd.env(k, v); }
    let child_opt = cmd
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| log::error!("failed to spawn streaming: {e}"))
        .ok();
    if let Some(ref c) = child_opt {
        runtime.streaming_pid = c.id();
        save_runtime(&runtime);
        verify_streaming_bound(c.id());
    }
    child_opt
}

fn verify_streaming_bound(pid: u32) {
    if !wait_port_bound(STREAMING_PORT, Duration::from_secs(8)) {
        log::error!(
            "streaming sidecar pid={pid} did not bind 127.0.0.1:{STREAMING_PORT} within 8s"
        );
        return;
    }
    log::info!("streaming sidecar pid={pid} listening on 127.0.0.1:{STREAMING_PORT}");
}
