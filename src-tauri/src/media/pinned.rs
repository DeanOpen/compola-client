//! Port of `PinnedHTTPSClient.swift`: connects to *given* (DoH-resolved) IPv4 addresses while TLS is performed for
//! the original hostname — SNI is the hostname and the certificate chain + hostname are validated (never
//! trust-all). Swift had to hand-roll HTTP/1.1 over `NWConnection` because URLSession cannot skip DNS; reqwest can
//! (`resolve_to_addrs`), so this is a cache of reqwest clients pinned per (host, addresses), redirects disabled so
//! the loader re-issues them through its own policy.

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::time::Duration;

use parking_lot::Mutex;
use rand::seq::SliceRandom;

use super::MediaError;

/// Addresses tried per request (Swift: `addresses.shuffled().prefix(4)`).
pub const MAX_ADDRESSES: usize = 4;
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(6);

#[derive(Default)]
pub struct PinnedClients {
    clients: Mutex<HashMap<(String, Vec<Ipv4Addr>), reqwest::Client>>,
}

impl PinnedClients {
    /// A client whose only resolution of `host` is `addresses` (shuffled, at most four; port from the URL).
    pub fn client(&self, host: &str, addresses: &[Ipv4Addr]) -> Result<reqwest::Client, MediaError> {
        if addresses.is_empty() {
            return Err(MediaError::Net(super::NetFailure::Dns, format!("no addresses for {host}")));
        }
        let mut sorted = addresses.to_vec();
        sorted.sort();
        let key = (host.to_ascii_lowercase(), sorted);
        if let Some(client) = self.clients.lock().get(&key) {
            return Ok(client.clone());
        }
        let client = build(host, addresses)?;
        let mut clients = self.clients.lock();
        if clients.len() >= 32 {
            clients.clear();
        }
        clients.insert(key, client.clone());
        Ok(client)
    }
}

fn build(host: &str, addresses: &[Ipv4Addr]) -> Result<reqwest::Client, MediaError> {
    let mut shuffled = addresses.to_vec();
    shuffled.shuffle(&mut rand::thread_rng());
    // Port 0: hyper uses the URL's (default 443) port for resolver-provided addresses.
    let addrs: Vec<SocketAddr> = shuffled.into_iter().take(MAX_ADDRESSES).map(|ip| SocketAddr::new(ip.into(), 0)).collect();
    reqwest::Client::builder()
        .resolve_to_addrs(host, &addrs)
        .redirect(reqwest::redirect::Policy::none())
        .https_only(true)
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|e| super::policy::from_reqwest(&e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clients_are_reused_per_host_and_address_set() {
        let pinned = PinnedClients::default();
        let a = [Ipv4Addr::new(10, 0, 0, 1), Ipv4Addr::new(10, 0, 0, 2)];
        let b = [Ipv4Addr::new(10, 0, 0, 2), Ipv4Addr::new(10, 0, 0, 1)];
        pinned.client("res-zalo.zadn.vn", &a).unwrap();
        pinned.client("RES-ZALO.zadn.vn", &b).unwrap();
        assert_eq!(pinned.clients.lock().len(), 1);
        assert!(pinned.client("res-zalo.zadn.vn", &[]).is_err());
    }

    #[tokio::test]
    async fn plain_http_is_refused_and_unreachable_addresses_fail() {
        let pinned = PinnedClients::default();
        let client = pinned.client("example.com", &[Ipv4Addr::new(127, 0, 0, 1)]).unwrap();
        assert!(client.get("http://example.com/x").send().await.is_err());
        // 127.0.0.1:9 refuses the connection — nothing leaves the machine.
        let err = client.get("https://example.com:9/x").send().await.unwrap_err();
        assert!(err.is_connect() || err.is_request(), "{err}");
    }
}
