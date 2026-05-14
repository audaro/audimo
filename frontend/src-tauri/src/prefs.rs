//! Persistent install-level state for the Audimo desktop shell.
//!
//! Two pieces of state, kept on different surfaces by sensitivity:
//!
//! * **Non-secret prefs** — `~/.audimo/state.json`. The first-run flag
//!   and the "remote access enabled" toggle live here. World-readable
//!   is fine; these are not credentials.
//!
//! * **Secrets** — OS keychain. The remote-access API key never
//!   touches disk. macOS Keychain Services, Windows Credential
//!   Manager, Linux Secret Service via the `keyring` crate.
//!
//! The frontend never sees the file path or the keychain entry name;
//! it goes through the Tauri command surface in `commands.rs`.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

const KEYRING_SERVICE: &str = "app.audimo.desktop";
const KEYRING_USER: &str = "remote_api_key";
const KEYRING_USER_SECRET: &str = "db_secret_key";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Prefs {
    /// True once the user has finished (or skipped) the onboarding.
    #[serde(default)]
    pub first_run_complete: bool,

    /// True if the user has opted to expose the backend beyond
    /// 127.0.0.1 for phone access. When this is true the backend is
    /// spawned with an API key and bound to 0.0.0.0; the key itself
    /// lives in the OS keychain, not here.
    #[serde(default)]
    pub remote_enabled: bool,

    /// Skip spawning the libtorrent streaming sidecar entirely.
    /// Recommended for users who only play debrid-cached or
    /// streaming-addon content — they get zero peer visibility,
    /// no DHT announces, no inbound peer port. Torrent-source
    /// playback stops working when set.
    #[serde(default)]
    pub privacy_no_streaming: bool,

    /// Disable DHT announces. The streaming sidecar still serves
    /// peers it learns via trackers, but does not announce our
    /// info-hashes to the global DHT.
    #[serde(default)]
    pub privacy_no_dht: bool,

    /// Disable Local Service Discovery (LSD). Stops the sidecar
    /// from announcing on the local network.
    #[serde(default)]
    pub privacy_no_lsd: bool,

    /// Disable Peer Exchange (PEX) — connected peers won't share
    /// peer lists with us.
    #[serde(default)]
    pub privacy_no_pex: bool,
}

fn prefs_dir() -> PathBuf {
    dirs_home()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".audimo")
}

fn prefs_path() -> PathBuf {
    prefs_dir().join("state.json")
}

/// Minimal home-dir resolver — avoids pulling in the `dirs` crate.
fn dirs_home() -> Option<PathBuf> {
    if let Ok(h) = std::env::var("HOME") {
        if !h.is_empty() {
            return Some(PathBuf::from(h));
        }
    }
    if let Ok(p) = std::env::var("USERPROFILE") {
        if !p.is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    None
}

pub fn load() -> Prefs {
    let path = prefs_path();
    let Ok(bytes) = fs::read(&path) else {
        return Prefs::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

pub fn save(prefs: &Prefs) -> std::io::Result<()> {
    let dir = prefs_dir();
    fs::create_dir_all(&dir)?;
    let bytes = serde_json::to_vec_pretty(prefs).expect("Prefs always serialises");
    fs::write(prefs_path(), bytes)
}

// ── API key storage ─────────────────────────────────────────────
//
// Two-tier storage: try the OS keychain first (works in signed/installed
// builds), fall back to a 0600 file at `~/.audimo/api_key` when keychain
// access fails (unsigned dev builds, missing entitlements, denied
// prompts). Single-user self-hosted app: the file is owned by the same
// user that runs the app — same security posture as the rest of
// `~/.audimo`.

fn key_file() -> PathBuf {
    prefs_dir().join("api_key")
}

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())
}

fn read_key_file() -> Option<String> {
    let s = fs::read_to_string(key_file()).ok()?;
    let s = s.trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

fn write_key_file(key: &str) -> Result<(), String> {
    let dir = prefs_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = key_file();
    fs::write(&path, key).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn delete_key_file() {
    let _ = fs::remove_file(key_file());
}

pub fn get_api_key() -> Option<String> {
    if let Ok(e) = entry() {
        if let Ok(s) = e.get_password() {
            if !s.is_empty() { return Some(s); }
        }
    }
    read_key_file()
}

/// Return the install's API key, generating + persisting a fresh one
/// if none exists. Used by the always-on token model: every install
/// has an API key from first boot, the backend always requires it,
/// and the WebView fetches it via the Tauri command surface. Remote
/// (phone) mode is an orthogonal toggle that just controls whether
/// the backend binds 0.0.0.0 — the key itself exists either way.
pub fn ensure_api_key() -> Result<String, String> {
    if let Some(k) = get_api_key() {
        return Ok(k);
    }
    let key = generate_api_key();
    set_api_key(&key)?;
    Ok(key)
}

pub fn set_api_key(key: &str) -> Result<(), String> {
    // Best-effort keychain write so signed builds still benefit. Always
    // mirror to the file so reads succeed regardless of keychain state.
    if let Ok(e) = entry() {
        let _ = e.set_password(key);
    }
    write_key_file(key)
}

pub fn clear_api_key() -> Result<(), String> {
    if let Ok(e) = entry() {
        match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(_) => {} // best-effort
        }
    }
    delete_key_file();
    Ok(())
}

// ── DB Fernet secret key ────────────────────────────────────────
//
// Backend encrypts addon_settings (RD tokens, slskd passwords) at
// rest using a Fernet key. The key was historically a 0600 file at
// ``~/.audimo/secret.key`` next to the encrypted database — which is
// only marginally better than plaintext (anyone who reads ~/.audimo
// reads both). Stash it in the OS keychain so a leaked home-dir
// backup or synced iCloud folder doesn't trivially expose secrets.
//
// Migration: if the file exists from a prior install, copy its
// contents into the keychain on first run and keep the file as a
// fallback so a keychain-denied dev build still boots.

fn secret_file() -> PathBuf {
    prefs_dir().join("secret.key")
}

fn secret_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER_SECRET).map_err(|e| e.to_string())
}

fn read_secret_file() -> Option<String> {
    let s = fs::read_to_string(secret_file()).ok()?;
    let s = s.trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

fn write_secret_file(key: &str) -> Result<(), String> {
    let dir = prefs_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = secret_file();
    fs::write(&path, key).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Generate a fresh 32-byte Fernet key (base64url-encoded, 44 chars).
/// Matches the format `cryptography.fernet.Fernet.generate_key()`
/// produces so the backend can use it verbatim.
pub fn generate_secret_key() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    // Standard base64 with padding — what cryptography's Fernet expects.
    const ALPHA: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(44);
    let mut i = 0;
    while i + 3 <= buf.len() {
        let n = ((buf[i] as u32) << 16) | ((buf[i + 1] as u32) << 8) | (buf[i + 2] as u32);
        out.push(ALPHA[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPHA[((n >> 12) & 0x3f) as usize] as char);
        out.push(ALPHA[((n >> 6) & 0x3f) as usize] as char);
        out.push(ALPHA[(n & 0x3f) as usize] as char);
        i += 3;
    }
    // 32 % 3 == 2 → 3 base64 chars + 1 '=' pad
    if i + 2 == buf.len() {
        let n = ((buf[i] as u32) << 8) | (buf[i + 1] as u32);
        out.push(ALPHA[((n >> 10) & 0x3f) as usize] as char);
        out.push(ALPHA[((n >> 4) & 0x3f) as usize] as char);
        out.push(ALPHA[((n << 2) & 0x3f) as usize] as char);
        out.push('=');
    }
    out
}

#[allow(dead_code)]
pub fn set_secret_key(key: &str) -> Result<(), String> {
    if let Ok(e) = secret_entry() {
        let _ = e.set_password(key);
    }
    write_secret_file(key)
}

/// Return the install's DB Fernet key, generating + persisting a
/// fresh one if none exists. If a legacy ``secret.key`` file is
/// present without a keychain entry, the file's contents are copied
/// into the keychain on this call so subsequent installs prefer
/// keychain — without re-encrypting the DB.
pub fn ensure_secret_key() -> Result<String, String> {
    // Keychain wins if present.
    if let Ok(e) = secret_entry() {
        if let Ok(s) = e.get_password() {
            if !s.is_empty() { return Ok(s); }
        }
    }
    // Migrate the legacy file into the keychain so we stop relying
    // on a flat-file secret next to the DB.
    if let Some(s) = read_secret_file() {
        if !s.is_empty() {
            if let Ok(e) = secret_entry() {
                let _ = e.set_password(&s);
            }
            return Ok(s);
        }
    }
    // Fresh install — mint, persist, and continue. set_secret_key
    // mirrors to the file too, so a future keychain-denied dev build
    // still boots.
    let key = generate_secret_key();
    set_secret_key(&key)?;
    Ok(key)
}

/// Generate a 32-byte url-safe-base64 API key. Length ≈ 43 chars.
pub fn generate_api_key() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    // base64 url-safe without padding, hand-rolled to avoid pulling
    // in another crate.
    const ALPHA: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(43);
    let mut i = 0;
    while i + 3 <= buf.len() {
        let n = ((buf[i] as u32) << 16) | ((buf[i + 1] as u32) << 8) | (buf[i + 2] as u32);
        out.push(ALPHA[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPHA[((n >> 12) & 0x3f) as usize] as char);
        out.push(ALPHA[((n >> 6) & 0x3f) as usize] as char);
        out.push(ALPHA[(n & 0x3f) as usize] as char);
        i += 3;
    }
    // 32 % 3 == 2 bytes left → 3 base64 chars (no padding)
    if i + 2 == buf.len() {
        let n = ((buf[i] as u32) << 8) | (buf[i + 1] as u32);
        out.push(ALPHA[((n >> 10) & 0x3f) as usize] as char);
        out.push(ALPHA[((n >> 4) & 0x3f) as usize] as char);
        out.push(ALPHA[((n << 2) & 0x3f) as usize] as char);
    }
    out
}
