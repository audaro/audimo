// Audimo desktop shell.
//
// Phase 3 layout:
//   * `prefs`      — install state (state.json) + OS keychain
//   * `network`    — Tailscale + LAN detection for the onboarding flow
//   * `sidecars`   — backend + addon child-process management
//   * `commands`   — Tauri command surface (frontend ↔ shell IPC)
//
// Boot flow:
//   1. Load prefs from `~/.audimo/state.json`.
//   2. Spawn the backend with AUDIMO_API_KEY iff `remote_enabled`.
//   3. Spawn the bundled addon (best-effort).
//   4. Build the system tray + window.

mod addon_sidecars;
mod commands;
mod network;
mod prefs;
mod sidecars;

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_deep_link::DeepLinkExt;

use sidecars::{find_repo_root, spawn_backend, spawn_streaming, Sidecars, BACKEND_PORT};

/// Block (with timeout) until the backend is accepting connections on
/// 127.0.0.1:BACKEND_PORT. Used at startup so the WebView doesn't try
/// to load `http://127.0.0.1:8000/` before the FastAPI sidecar has
/// bound. Returns true if backend came up, false on timeout.
fn wait_for_backend(timeout_ms: u64) -> bool {
    use std::net::TcpStream;
    use std::time::{Duration, Instant};
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        if TcpStream::connect_timeout(
            &(std::net::Ipv4Addr::new(127, 0, 0, 1), BACKEND_PORT).into(),
            Duration::from_millis(150),
        ).is_ok() {
            return true;
        }
        if Instant::now() >= deadline { return false; }
        std::thread::sleep(Duration::from_millis(80));
    }
}

/// App-level state shared across commands. Holds the resolved repo
/// root so commands invoking `spawn_backend` after onboarding don't
/// have to walk the filesystem again.
pub struct AppState {
    pub repo_root: PathBuf,
}

/// Queue of `audimo://...` URLs that arrived before the WebView
/// finished mounting its deep-link listener. The frontend drains
/// this on mount via the ``audimo_drain_deep_links`` command, AND
/// keeps a live `audimo://deep-link` event subscription for URLs
/// that arrive while the app is running. Without this buffer, a
/// browser-clicked install link that wakes the app would race the
/// React mount and the user would see "nothing happened."
#[derive(Default)]
pub struct DeepLinkBuffer(pub Mutex<Vec<String>>);

fn build_tray<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Audimo", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "Hide", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &hide, &quit])?;

    let _tray = TrayIconBuilder::with_id("audimo-tray")
        .tooltip("Audimo")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "hide" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Some(w) = tray.app_handle().get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(Sidecars::default())
        .manage(addon_sidecars::AddonSidecars::default())
        .manage(DeepLinkBuffer::default())
        .invoke_handler(tauri::generate_handler![
            commands::audimo_get_state,
            commands::audimo_set_first_run_complete,
            commands::audimo_set_remote_enabled,
            commands::audimo_get_api_key,
            commands::audimo_ensure_api_key,
            commands::audimo_drain_deep_links,
            commands::audimo_get_privacy,
            commands::audimo_set_privacy,
            commands::audimo_regenerate_api_key,
            commands::audimo_get_network_info,
            commands::audimo_open_external_url,
            commands::audimo_addon_catalog_fetch,
            commands::audimo_addon_install,
            commands::audimo_addon_uninstall,
            commands::audimo_addon_list,
            commands::audimo_addon_restart,
        ])
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            // Always init the log plugin — release builds need
            // sidecar-spawn diagnostics too. The plugin tees to stdout
            // and to ~/Library/Logs/<bundle_id>/ on macOS.
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .build(),
            )?;

            // Hand-off any audimo:// URLs that wake the app (or arrive
            // while it's running) to the webview. The frontend's deep
            // link handler parses the URL — for an
            // `audimo://install-bundle?url=...` it fetches the bundle
            // and runs the multi-addon install flow. We don't parse
            // here so the wire format can evolve without rebuilding
            // the Rust binary every time.
            //
            // In dev mode (`tauri dev`) the OS doesn't know about our
            // scheme yet — call `register("audimo")` once to claim it
            // for the running process so `open audimo://...` works for
            // testing. On release builds the scheme comes from the
            // bundled Info.plist (CFBundleURLTypes), populated from
            // tauri.conf.json's plugins.deep-link.desktop.schemes.
            let app_handle = app.handle().clone();
            #[cfg(any(debug_assertions, target_os = "linux", target_os = "windows"))]
            {
                if let Err(e) = app.deep_link().register("audimo") {
                    log::warn!("deep-link register('audimo') failed: {e}");
                }
            }
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    let s = url.to_string();
                    log::info!("deep link received: {s}");
                    // Buffer always — the WebView may not have its
                    // listener attached yet on a cold-wake from the OS.
                    if let Some(buf) = app_handle.try_state::<DeepLinkBuffer>() {
                        if let Ok(mut v) = buf.0.lock() {
                            v.push(s.clone());
                        }
                    }
                    // ALSO emit a live event — if the frontend is
                    // already mounted it gets the URL immediately
                    // without polling. The drain command dedupes by
                    // popping the buffer, so a URL is never delivered
                    // twice.
                    if let Err(e) = app_handle.emit("audimo://deep-link", &s) {
                        log::warn!("emit deep-link event failed: {e}");
                    }
                    // Bring the window forward so a click on a browser
                    // link feels like the app responded, not silently
                    // received-and-ignored.
                    if let Some(w) = app_handle.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
            });

            let repo_root = find_repo_root();
            log::info!("audimo repo root: {:?}", repo_root);
            app.manage(AppState { repo_root: repo_root.clone() });

            let p = prefs::load();
            log::info!(
                "loaded prefs: first_run_complete={} remote_enabled={}",
                p.first_run_complete, p.remote_enabled
            );

            // Always-on token: mint a key at first boot if the
            // install doesn't have one yet. The backend has no
            // keyless mode any more, so this MUST succeed before
            // spawn_backend (otherwise the WebView will only get 401s
            // until the user does something to make a key appear).
            let api_key = match prefs::ensure_api_key() {
                Ok(k) => Some(k),
                Err(e) => {
                    log::error!("could not mint or read API key: {e} — backend will reject all requests");
                    None
                }
            };

            let sidecars = app.state::<Sidecars>();
            if let Some(c) = spawn_backend(app.handle(), p.remote_enabled, api_key.as_deref()) {
                sidecars.set_backend(c);
            }
            if let Some(c) = spawn_streaming(&repo_root) {
                sidecars.set_streaming(c);
            }

            // Respawn user-installed addons (catalog runtime). Each
            // addon's binary lives under `<app_data>/audimo/addons/
            // installed/<id>/`; we walk that dir on every boot so
            // reinstall-after-upgrade and the user's manual file moves
            // both Just Work. Auto-allocates ports the first time;
            // reuses persisted ports on subsequent boots so frontend
            // localStorage URLs stay valid.
            let addon_state = app.state::<addon_sidecars::AddonSidecars>();
            let installed = addon_sidecars::list_installed_on_disk();
            if !installed.is_empty() {
                if let Ok(root) = addon_sidecars::addons_root() {
                    // Stray-sweep first — kills any addon processes
                    // left behind by prior crashed/force-quit sessions
                    // whose runtime.json got overwritten by a later
                    // launch. Without this, multiple zombie sidecars
                    // accumulate over time and the registry's URL
                    // routes to one while the others sit idle on
                    // their old ports.
                    addon_sidecars::kill_strays_under(&root);
                    for m in installed {
                        match addon_state.spawn_installed(&m.id, &root) {
                            Ok(port) => log::info!(
                                "respawned installed addon {} v{} on port {port}",
                                m.id, m.version
                            ),
                            Err(e) => log::warn!(
                                "failed to respawn installed addon {}: {e}",
                                m.id
                            ),
                        }
                    }
                }
            }

            // Block briefly until the backend is reachable. We want the
            // WebView to load `http://127.0.0.1:8000/` (so the frontend
            // is served from disk and can be hot-swapped without
            // rebuilding the Rust binary). Loading too early gives the
            // user a "Could not connect" page that the WebView caches
            // — they then see a blank screen on every subsequent
            // launch until they manually reload.
            //
            // Cold-start budget: the PyInstaller backend imports
            // FastAPI + a long tail of others. On older hardware or
            // first-run-after-reboot it routinely takes 8-12s. 20s is
            // generous but cheap — we've already paid for the splash
            // time.
            let ready = wait_for_backend(20_000);
            if !ready {
                log::warn!("backend didn't bind within 20s; opening window anyway — user will see a connection error until it's up");
            }

            // Build the main window pointing at the live backend.
            let url = WebviewUrl::External(
                format!("http://127.0.0.1:{}/", BACKEND_PORT).parse().unwrap(),
            );
            let _w = WebviewWindowBuilder::new(app, "main", url)
                .title("Audimo")
                .inner_size(1280.0, 800.0)
                .min_inner_size(900.0, 600.0)
                .resizable(true)
                .build()?;

            build_tray(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<Sidecars>() {
                state.kill_all();
            }
            if let Some(state) =
                app_handle.try_state::<addon_sidecars::AddonSidecars>()
            {
                state.kill_all();
            }
        }
    });
}
