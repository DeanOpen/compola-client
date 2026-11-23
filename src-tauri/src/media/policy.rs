//! Recovery decisions of `MediaLoader.swift`, kept free of I/O so they can be tested: which DNS path a host uses,
//! dead-host and failure backoffs, how a fingerprint-helper failure and a DoH failure are treated, and how a
//! transport error message is classified.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use super::{MediaError, NetFailure, ResolveError};

/// After DoH worked for a host, skip the failing system lookup for this long.
pub const DOH_STICKINESS: Duration = Duration::from_secs(600);
/// NXDOMAIN hosts (retired `fNN-zpc` CDN hosts in migrated messages) fail immediately for this long.
pub const DEAD_HOST_TTL: Duration = Duration::from_secs(300);
/// A failed image is not re-fetched for this long (unless the UI asks with `retry=1`).
pub const FAILURE_BACKOFF: Duration = Duration::from_secs(20);
/// A successful system-resolver probe is trusted this long.
pub const SYSTEM_OK_TTL: Duration = Duration::from_secs(300);
/// A failed probe sends the host to DoH for this long.
pub const PROBE_FAILED_TTL: Duration = Duration::from_secs(20);
/// After the DoH path broke, the system resolver gets this long.
pub const DOH_BROKE_SYSTEM_TTL: Duration = Duration::from_secs(30);

/// Per-host DNS path state and per-URL failure backoff (the Swift actor's dictionaries).
#[derive(Default)]
pub struct DnsState {
    doh_hosts: HashMap<String, Instant>,
    system_ok: HashMap<String, Instant>,
    dead_hosts: HashMap<String, Instant>,
    failures: HashMap<String, (Instant, MediaError)>,
}

impl DnsState {
    /// Swift `failIfDead`: true while an NXDOMAIN verdict is fresh (expired entries are dropped).
    pub fn is_dead(&mut self, host: &str, now: Instant) -> bool {
        match self.dead_hosts.get(host) {
            Some(until) if *until > now => true,
            Some(_) => {
                self.dead_hosts.remove(host);
                false
            }
            None => false,
        }
    }

    pub fn mark_dead(&mut self, host: &str, now: Instant) {
        if self.dead_hosts.len() > 1000 {
            self.dead_hosts.clear();
        }
        self.dead_hosts.insert(host.to_owned(), now + DEAD_HOST_TTL);
    }

    /// What is known about the system resolver for `host`: `Some(false)` = go straight to DoH, `Some(true)` =
    /// recently fine, `None` = probe it.
    pub fn known_system(&self, host: &str, now: Instant) -> Option<bool> {
        if self.doh_hosts.get(host).is_some_and(|t| *t > now) {
            return Some(false);
        }
        if self.system_ok.get(host).is_some_and(|t| *t > now) {
            return Some(true);
        }
        None
    }

    pub fn record_probe(&mut self, host: &str, ok: bool, now: Instant) {
        if ok {
            self.system_ok.insert(host.to_owned(), now + SYSTEM_OK_TTL);
        } else {
            self.doh_hosts.insert(host.to_owned(), now + PROBE_FAILED_TTL);
        }
    }

    pub fn doh_worked(&mut self, host: &str, now: Instant) {
        self.doh_hosts.insert(host.to_owned(), now + DOH_STICKINESS);
    }

    /// The DoH path failed for a reason other than the resource: give the system resolver a go.
    pub fn doh_broke(&mut self, host: &str, now: Instant) {
        self.doh_hosts.remove(host);
        self.system_ok.insert(host.to_owned(), now + DOH_BROKE_SYSTEM_TTL);
    }

    /// Swift `usesDoH(host:)`.
    #[cfg(test)]
    pub fn uses_doh(&self, host: &str, now: Instant) -> bool {
        self.doh_hosts.get(&host.to_ascii_lowercase()).is_some_and(|t| *t > now)
    }

    pub fn note_failure(&mut self, key: &str, error: MediaError, now: Instant) {
        if self.failures.len() > 2000 {
            self.failures.retain(|_, (until, _)| *until > now);
        }
        self.failures.insert(key.to_owned(), (now + FAILURE_BACKOFF, error));
    }

    /// The error of a failure still inside its backoff window.
    pub fn recent_failure(&self, key: &str, now: Instant) -> Option<MediaError> {
        self.failures.get(key).filter(|(until, _)| *until > now).map(|(_, e)| e.clone())
    }

    /// Swift `forgetFailures(for:)`: an explicit retry must really try again.
    pub fn forget_failure(&mut self, key: &str) {
        self.failures.remove(key);
    }

    #[cfg(test)]
    pub fn dead_hosts_clear_for_tests(&mut self) {
        self.dead_hosts.clear();
    }
}

/// What to do after a fingerprint-helper *upstream* failure.
#[derive(Debug, PartialEq, Eq)]
pub enum HelperOutcome {
    /// Retry on the reqwest / DoH stack (name-resolution trouble the DoH machinery may still recover).
    Fallback,
    /// A real answer: retrying on another stack would change the fingerprint.
    Fail(MediaError),
}

/// Swift `helperOrFallback(_:)` for `FingerprintProxy.Error.requestFailed(message)` (an unavailable helper is
/// already a fallback before this is asked).
pub fn helper_failure(message: &str) -> HelperOutcome {
    let m = message.to_ascii_lowercase();
    if m.contains("too large") || m.contains("toolarge") {
        return HelperOutcome::Fail(MediaError::TooLarge);
    }
    if crate::net::is_timeout_message(&m) || m.contains("canceled") {
        return HelperOutcome::Fail(MediaError::TimedOut);
    }
    const DNSISH: &[&str] = &["no such host", "lookup", "dns", "connection refused", "connection reset"];
    if DNSISH.iter().any(|d| m.contains(d)) {
        return HelperOutcome::Fallback;
    }
    HelperOutcome::Fail(MediaError::Net(NetFailure::Other, message.to_owned()))
}

/// What a failed DoH attempt means (the `catch` ladder of Swift `withDNSFallback`).
#[derive(Debug, PartialEq, Eq)]
pub enum DohOutcome {
    /// Reached the server (or the request is invalid / cancelled): report this error as is.
    Propagate,
    /// Authoritative NXDOMAIN: the host is gone, remember it and report `HostNotFound`.
    Dead,
    /// The DoH path itself broke (resolvers unreachable, connect failed): fall back / report the system error.
    Broken,
}

pub fn doh_failure(error: &MediaError) -> DohOutcome {
    match error {
        MediaError::Doh(ResolveError::NotFound(_)) => DohOutcome::Dead,
        MediaError::Cancelled => DohOutcome::Propagate,
        e if e.is_load_error() => DohOutcome::Propagate,
        _ => DohOutcome::Broken,
    }
}

/// Classifies a transport error by its (whole source-chain) message, as Swift did by URLError code.
pub fn classify_transport(message: &str, timed_out: bool) -> NetFailure {
    let m = message.to_ascii_lowercase();
    const DNS: &[&str] = &[
        "dns error",
        "failed to lookup address",
        "nodename nor servname",
        "name or service not known",
        "no such host",
        "no address associated",
        "temporary failure in name resolution",
    ];
    if DNS.iter().any(|d| m.contains(d)) {
        return NetFailure::Dns;
    }
    if timed_out || m.contains("timed out") || m.contains("timeout") {
        return NetFailure::Timeout;
    }
    const OFFLINE: &[&str] = &["network is unreachable", "network unreachable", "no route to host", "not connected to the internet", "network is down"];
    if OFFLINE.iter().any(|d| m.contains(d)) {
        return NetFailure::Offline;
    }
    const TLS: &[&str] = &["certificate", "tls", "handshake", "ssl"];
    if TLS.iter().any(|d| m.contains(d)) {
        return NetFailure::Tls;
    }
    NetFailure::Other
}

/// A reqwest error as a `MediaError::Net`, classified over its whole source chain.
pub fn from_reqwest(error: &reqwest::Error) -> MediaError {
    let mut message = error.to_string();
    let mut source = std::error::Error::source(error);
    while let Some(s) = source {
        message.push_str(": ");
        message.push_str(&s.to_string());
        source = s.source();
    }
    MediaError::Net(classify_transport(&message, error.is_timeout()), message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dead_hosts_expire() {
        let mut s = DnsState::default();
        let t0 = Instant::now();
        assert!(!s.is_dead("f28-zpc.zdn.vn", t0));
        s.mark_dead("f28-zpc.zdn.vn", t0);
        assert!(s.is_dead("f28-zpc.zdn.vn", t0 + Duration::from_secs(299)));
        assert!(!s.is_dead("f28-zpc.zdn.vn", t0 + DEAD_HOST_TTL + Duration::from_secs(1)));
        assert!(!s.is_dead("f28-zpc.zdn.vn", t0)); // the expired entry was dropped
    }

    #[test]
    fn dns_path_decisions() {
        let mut s = DnsState::default();
        let t0 = Instant::now();
        let host = "res-zalo.zadn.vn";
        assert_eq!(s.known_system(host, t0), None); // unknown: probe
        s.record_probe(host, false, t0);
        assert_eq!(s.known_system(host, t0), Some(false)); // probe failed: DoH for 20 s
        assert_eq!(s.known_system(host, t0 + Duration::from_secs(21)), None);
        s.doh_worked(host, t0);
        assert!(s.uses_doh(host, t0 + Duration::from_secs(599)));
        assert!(s.uses_doh("RES-ZALO.zadn.vn", t0));
        assert!(!s.uses_doh(host, t0 + Duration::from_secs(601)));
        s.doh_broke(host, t0);
        assert!(!s.uses_doh(host, t0));
        assert_eq!(s.known_system(host, t0 + Duration::from_secs(29)), Some(true));
        assert_eq!(s.known_system(host, t0 + Duration::from_secs(31)), None);
        s.record_probe(host, true, t0);
        assert_eq!(s.known_system(host, t0 + Duration::from_secs(299)), Some(true));
    }

    #[test]
    fn failure_backoff_and_forced_retry() {
        let mut s = DnsState::default();
        let t0 = Instant::now();
        s.note_failure("k", MediaError::Http(404), t0);
        assert_eq!(s.recent_failure("k", t0 + Duration::from_secs(19)), Some(MediaError::Http(404)));
        assert_eq!(s.recent_failure("k", t0 + Duration::from_secs(21)), None);
        s.note_failure("k", MediaError::TimedOut, t0);
        s.forget_failure("k");
        assert_eq!(s.recent_failure("k", t0), None);
    }

    #[test]
    fn helper_failures() {
        assert_eq!(helper_failure("upstream: Timeout awaiting headers"), HelperOutcome::Fail(MediaError::TimedOut));
        assert_eq!(helper_failure("context canceled"), HelperOutcome::Fail(MediaError::TimedOut));
        assert_eq!(helper_failure("body too large"), HelperOutcome::Fail(MediaError::TooLarge));
        assert_eq!(helper_failure("dial tcp: lookup f6-zpc.zdn.vn: no such host"), HelperOutcome::Fallback);
        assert_eq!(helper_failure("read: connection reset by peer"), HelperOutcome::Fallback);
        assert!(matches!(helper_failure("remote error: tls: bad certificate"), HelperOutcome::Fail(MediaError::Net(NetFailure::Other, _))));
    }

    #[test]
    fn doh_failure_ladder() {
        assert_eq!(doh_failure(&MediaError::Doh(ResolveError::NotFound("x".into()))), DohOutcome::Dead);
        assert_eq!(doh_failure(&MediaError::Doh(ResolveError::AllEndpointsFailed("x".into()))), DohOutcome::Broken);
        assert_eq!(doh_failure(&MediaError::Http(403)), DohOutcome::Propagate); // reached the server through DoH
        assert_eq!(doh_failure(&MediaError::TooLarge), DohOutcome::Propagate);
        assert_eq!(doh_failure(&MediaError::Cancelled), DohOutcome::Propagate);
        assert_eq!(doh_failure(&MediaError::Net(NetFailure::Tls, "x".into())), DohOutcome::Broken);
        assert_eq!(doh_failure(&MediaError::Net(NetFailure::Timeout, "x".into())), DohOutcome::Broken);
    }

    #[test]
    fn transport_messages() {
        let dns = "error sending request: client error (Connect): dns error: failed to lookup address information: nodename nor servname provided, or not known";
        assert_eq!(classify_transport(dns, false), NetFailure::Dns);
        assert_eq!(classify_transport("operation timed out", false), NetFailure::Timeout);
        assert_eq!(classify_transport("anything", true), NetFailure::Timeout);
        assert_eq!(classify_transport("Network is unreachable (os error 51)", false), NetFailure::Offline);
        assert_eq!(classify_transport("invalid peer certificate: UnknownIssuer", false), NetFailure::Tls);
        assert_eq!(classify_transport("connection closed before message completed", false), NetFailure::Other);
    }
}
