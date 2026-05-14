//! Network info for the "phone access" onboarding step.
//!
//! Two pieces:
//!
//! * **Tailscale** — if the `tailscale` CLI is installed and the user
//!   is logged in, we surface their MagicDNS hostname and tailnet IP.
//!   The recommended way to point a phone at a Audimo install.
//!
//! * **LAN fallback** — every non-loopback IPv4 the host advertises.
//!   For users on the same Wi-Fi as their desktop who haven't set up
//!   Tailscale.
//!
//! Errors are swallowed → empty values. This is a UI hint, not a
//! security boundary; the user sees what's available and picks.

use std::process::Command;

use serde::Serialize;

#[derive(Debug, Default, Serialize)]
pub struct NetworkInfo {
    pub tailscale_ip: Option<String>,
    pub tailscale_hostname: Option<String>,
    pub lan_ips: Vec<String>,
    pub backend_port: u16,
}

pub fn detect(backend_port: u16) -> NetworkInfo {
    let (tailscale_ip, tailscale_hostname) = detect_tailscale();
    NetworkInfo {
        tailscale_ip,
        tailscale_hostname,
        lan_ips: detect_lan_ips(),
        backend_port,
    }
}

/// `tailscale status --json` returns rich state. We only need the
/// install owner's own node info: `Self.TailscaleIPs[0]` and
/// `Self.DNSName` (the MagicDNS hostname, with trailing dot).
fn detect_tailscale() -> (Option<String>, Option<String>) {
    let output = Command::new("tailscale")
        .args(["status", "--json"])
        .output();
    let Ok(out) = output else { return (None, None) };
    if !out.status.success() {
        return (None, None);
    }
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(&out.stdout) else {
        return (None, None);
    };
    let me = v.get("Self").cloned().unwrap_or(serde_json::Value::Null);
    let ip = me
        .get("TailscaleIPs")
        .and_then(|x| x.as_array())
        .and_then(|arr| arr.iter().find_map(|s| s.as_str().map(str::to_string)));
    let host = me
        .get("DNSName")
        .and_then(|s| s.as_str())
        .map(|s| s.trim_end_matches('.').to_string())
        .filter(|s| !s.is_empty());
    (ip, host)
}

fn detect_lan_ips() -> Vec<String> {
    let Ok(addrs) = if_addrs::get_if_addrs() else { return Vec::new() };
    addrs
        .into_iter()
        .filter(|a| !a.is_loopback())
        .filter_map(|a| match a.addr {
            // IPv4 only — phone-access UX is simpler with a single
            // address family.
            if_addrs::IfAddr::V4(v4) => Some(v4.ip.to_string()),
            _ => None,
        })
        .collect()
}
