//! Tauri command surface invoked by the React frontend via
//! `@tauri-apps/api/core`'s `invoke()`.
//!
//! Conventions:
//!   * Every command returns `Result<T, String>` — the frontend awaits
//!     a JS promise and gets a string error on rejection.
//!   * Mutations that change backend-spawn parameters
//!     (`set_remote_enabled`, `regenerate_api_key`) trigger a backend
//!     respawn so the new state takes effect without a full app
//!     restart.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::addon_sidecars::{self, AddonSidecars, AddonStatus};
use crate::network::{self, NetworkInfo};
use crate::prefs;
use crate::sidecars::{spawn_backend, Sidecars, BACKEND_PORT};

#[derive(Serialize)]
pub struct StateSnapshot {
    pub first_run_complete: bool,
    pub remote_enabled: bool,
    pub has_api_key: bool,
    pub backend_port: u16,
}

#[derive(Serialize, serde::Deserialize)]
pub struct PrivacyPrefs {
    pub privacy_no_streaming: bool,
    pub privacy_no_dht: bool,
    pub privacy_no_lsd: bool,
    pub privacy_no_pex: bool,
}

#[tauri::command]
pub fn audimo_get_state() -> StateSnapshot {
    let p = prefs::load();
    StateSnapshot {
        first_run_complete: p.first_run_complete,
        remote_enabled: p.remote_enabled,
        has_api_key: prefs::get_api_key().is_some(),
        backend_port: BACKEND_PORT,
    }
}

#[tauri::command]
pub fn audimo_set_first_run_complete() -> Result<(), String> {
    let mut p = prefs::load();
    p.first_run_complete = true;
    prefs::save(&p).map_err(|e| e.to_string())
}

/// Toggle remote (phone-access) mode.
///
/// Enabling: ensures an API key exists in the keychain (creates one on
/// the spot if missing) and respawns the backend with
/// `AUDIMO_API_KEY` + `0.0.0.0` binding. Returns the key so the
/// frontend can show it once during onboarding.
///
/// Disabling: clears the key from the keychain and respawns the
/// backend in local-only mode.
#[tauri::command]
pub fn audimo_set_remote_enabled(
    enabled: bool,
    app: AppHandle,
    sidecars: State<'_, Sidecars>,
) -> Result<Option<String>, String> {
    let mut p = prefs::load();
    p.remote_enabled = enabled;

    let returned_key = if enabled {
        let key = prefs::get_api_key().unwrap_or_else(prefs::generate_api_key);
        prefs::set_api_key(&key)?;
        Some(key)
    } else {
        prefs::clear_api_key()?;
        None
    };

    prefs::save(&p).map_err(|e| e.to_string())?;
    respawn_backend(&app, &sidecars);
    Ok(returned_key)
}

#[tauri::command]
pub fn audimo_get_api_key() -> Option<String> {
    prefs::get_api_key()
}

#[tauri::command]
pub fn audimo_get_privacy() -> PrivacyPrefs {
    let p = prefs::load();
    PrivacyPrefs {
        privacy_no_streaming: p.privacy_no_streaming,
        privacy_no_dht: p.privacy_no_dht,
        privacy_no_lsd: p.privacy_no_lsd,
        privacy_no_pex: p.privacy_no_pex,
    }
}

#[tauri::command]
pub fn audimo_set_privacy(
    privacy: PrivacyPrefs,
    sidecars: State<'_, Sidecars>,
) -> Result<PrivacyPrefs, String> {
    let mut p = prefs::load();
    p.privacy_no_streaming = privacy.privacy_no_streaming;
    p.privacy_no_dht = privacy.privacy_no_dht;
    p.privacy_no_lsd = privacy.privacy_no_lsd;
    p.privacy_no_pex = privacy.privacy_no_pex;
    prefs::save(&p).map_err(|e| e.to_string())?;
    // Tear down any running streaming sidecar so the next play
    // attempt either restarts it with the new env (when not
    // disabled) or simply skips it (when disabled). The lib.rs
    // setup doesn't expose a generic restart for the streaming
    // child, but kill_all is fine — we re-spawn on next play
    // attempt that needs it.
    let _ = sidecars; // Reserved for future use — we currently
                      // require a relaunch to re-spawn streaming
                      // with the new env. Surface that in the UI.
    Ok(audimo_get_privacy())
}

/// Return the install's API key, minting one if none exists. The
/// WebView calls this on boot so it always has a key to send as
/// ``X-API-Key`` on backend fetches — the backend now requires the
/// key in every mode (local + remote), so a brand-new install with
/// no prior key needs to mint on first launch.
#[tauri::command]
pub fn audimo_ensure_api_key() -> Result<String, String> {
    prefs::ensure_api_key()
}

/// Drain and return any `audimo://...` deep links that arrived
/// before the WebView's event listener attached. Called once on
/// frontend mount. Live URLs continue to flow via the
/// `audimo://deep-link` event subscription.
#[tauri::command]
pub fn audimo_drain_deep_links(
    buffer: State<'_, crate::DeepLinkBuffer>,
) -> Vec<String> {
    let mut guard = match buffer.0.lock() {
        Ok(g) => g,
        Err(_) => return Vec::new(),
    };
    std::mem::take(&mut *guard)
}

#[tauri::command]
pub fn audimo_regenerate_api_key(
    app: AppHandle,
    sidecars: State<'_, Sidecars>,
) -> Result<String, String> {
    let key = prefs::generate_api_key();
    prefs::set_api_key(&key)?;
    // Make sure remote mode is on — regenerating implies wanting it.
    let mut p = prefs::load();
    if !p.remote_enabled {
        p.remote_enabled = true;
        prefs::save(&p).map_err(|e| e.to_string())?;
    }
    respawn_backend(&app, &sidecars);
    Ok(key)
}

#[tauri::command]
pub fn audimo_get_network_info() -> NetworkInfo {
    network::detect(BACKEND_PORT)
}

/// Open a URL in the user's default external browser.
///
/// Tauri 2's WebView blocks `window.open()` in production builds, so
/// `<a target="_blank">` and JS-driven popups silently no-op for the
/// addon Configure flow. This shells out to the OS opener instead:
/// macOS `open`, Linux `xdg-open`, Windows `start`. Restricted to
/// http/https URLs so the command can't be coaxed into running
/// arbitrary protocol handlers (file://, etc.).
#[tauri::command]
pub fn audimo_open_external_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("only http(s) URLs allowed".into());
    }
    use std::process::Command;
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "cmd"
    } else {
        "xdg-open"
    };
    let mut cmd = Command::new(opener);
    if cfg!(target_os = "windows") {
        cmd.args(["/C", "start", "", &url]);
    } else {
        cmd.arg(&url);
    }
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to launch {opener}: {e}"))
}

fn respawn_backend(app: &AppHandle, sidecars: &Sidecars) {
    sidecars.kill_backend();
    let p = prefs::load();
    // Always pass an API key — the backend has no keyless mode any
    // more. Mint one if the install hasn't booted before.
    let api_key = prefs::ensure_api_key().ok();
    if let Some(child) = spawn_backend(app, p.remote_enabled, api_key.as_deref()) {
        sidecars.set_backend(child);
    }
}

// ── Addon catalog / sidecar runtime ─────────────────────────────────
//
// The frontend's Addons → Catalog tab calls these. They run blocking
// HTTP/IO on a dedicated thread via `spawn_blocking` so the Tauri
// event loop stays responsive even for slow downloads.
//
// `addon_install` is the load-bearing one: it downloads the binary,
// SHA-verifies it, drops it on disk, then spawns it. The frontend
// gets the resulting `http://127.0.0.1:<port>` URL back and registers
// it in the existing addon registry — at which point the addon is
// indistinguishable from one the user pasted manually.

#[tauri::command]
pub async fn audimo_addon_catalog_fetch(
    catalog_url: String,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        addon_sidecars::fetch_catalog_blocking(&catalog_url)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn audimo_addon_install(
    manifest_url: String,
    app: AppHandle,
) -> Result<AddonStatus, String> {
    let app_clone = app.clone();
    let manifest = tauri::async_runtime::spawn_blocking(move || {
        addon_sidecars::install_blocking(&manifest_url, move |id, pct, message| {
            let _ = app_clone.emit(
                "audimo:addon-install-progress",
                serde_json::json!({ "id": id, "pct": pct, "message": message }),
            );
        })
    })
    .await
    .map_err(|e| format!("join: {e}"))??;

    let id = manifest.id.clone();
    let state = app.state::<AddonSidecars>();
    let root = addon_sidecars::addons_root()?;
    let port = state.spawn_installed(&id, &root)?;
    Ok(AddonStatus {
        id: id.clone(),
        name: manifest.name,
        version: manifest.version,
        running: true,
        port: Some(port),
        url: Some(format!("http://127.0.0.1:{port}")),
    })
}

#[tauri::command]
pub async fn audimo_addon_uninstall(
    id: String,
    sidecars: State<'_, AddonSidecars>,
) -> Result<(), String> {
    sidecars.kill(&id);
    tauri::async_runtime::spawn_blocking(move || {
        addon_sidecars::uninstall_blocking(&id)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub fn audimo_addon_list(
    sidecars: State<'_, AddonSidecars>,
) -> Vec<AddonStatus> {
    // Merge in-memory (running) status with on-disk (installed but
    // possibly not running) so the UI can show "installed but
    // crashed" rows. Running rows take precedence.
    let running = sidecars.list();
    let running_ids: std::collections::HashSet<_> =
        running.iter().map(|r| r.id.clone()).collect();
    let mut out = running;
    for m in addon_sidecars::list_installed_on_disk() {
        if running_ids.contains(&m.id) {
            continue;
        }
        out.push(AddonStatus {
            id: m.id,
            name: m.name,
            version: m.version,
            running: false,
            port: None,
            url: None,
        });
    }
    out
}

#[tauri::command]
pub async fn audimo_addon_restart(
    id: String,
    sidecars: State<'_, AddonSidecars>,
) -> Result<AddonStatus, String> {
    sidecars.kill(&id);
    let root = addon_sidecars::addons_root()?;
    let port = sidecars.spawn_installed(&id, &root)?;
    let installed = addon_sidecars::list_installed_on_disk();
    let m = installed
        .into_iter()
        .find(|m| m.id == id)
        .ok_or_else(|| format!("addon {id} not on disk"))?;
    Ok(AddonStatus {
        id,
        name: m.name,
        version: m.version,
        running: true,
        port: Some(port),
        url: Some(format!("http://127.0.0.1:{port}")),
    })
}

