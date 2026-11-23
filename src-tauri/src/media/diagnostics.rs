//! Minimal, rate-limited media-load diagnostics (port of `MediaDiagnostics.swift`).
//!
//! A line carries the CDN host and a failure class only — never a full URL (paths and query strings carry
//! per-message tokens) and never content: `media fail kind=image host=f28-zpc.zdn.vn class=dns`. The same
//! (kind, host, class) is reported at most once per window, with a count of what was suppressed, and the total is
//! capped per minute, so a screen full of retired CDN links cannot flood the log.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use super::{MediaError, NetFailure, ResolveError};

/// Admits a key at most once per `window`, and at most `max_per_minute` lines overall.
pub struct Limiter {
    window: Duration,
    max_per_minute: usize,
    last: HashMap<String, Instant>,
    suppressed: HashMap<String, usize>,
    minute_start: Option<Instant>,
    minute_count: usize,
}

impl Default for Limiter {
    fn default() -> Self {
        Self::new(Duration::from_secs(60), 30)
    }
}

impl Limiter {
    pub fn new(window: Duration, max_per_minute: usize) -> Self {
        Self { window, max_per_minute, last: HashMap::new(), suppressed: HashMap::new(), minute_start: None, minute_count: 0 }
    }

    /// None when the line should be dropped, else how many identical lines were dropped since the last one.
    pub fn admit(&mut self, key: &str, now: Instant) -> Option<usize> {
        if self.minute_start.is_none_or(|start| now.duration_since(start) >= Duration::from_secs(60)) {
            self.minute_start = Some(now);
            self.minute_count = 0;
        }
        if self.last.get(key).is_some_and(|previous| now.duration_since(*previous) < self.window) {
            *self.suppressed.entry(key.to_owned()).or_default() += 1;
            return None;
        }
        if self.minute_count >= self.max_per_minute {
            *self.suppressed.entry(key.to_owned()).or_default() += 1;
            return None;
        }
        self.minute_count += 1;
        if self.last.len() > 500 {
            self.last.clear();
            self.suppressed.clear();
        }
        self.last.insert(key.to_owned(), now);
        Some(self.suppressed.remove(key).unwrap_or(0))
    }
}

/// Failure class of a media error: `http-404`, `dns`, `dns-unreachable`, `timeout`, `offline`, `tls`, `size`,
/// `other`. None for cancellation (not a failure).
pub fn classify(error: &MediaError) -> Option<String> {
    Some(match error {
        MediaError::Cancelled => return None,
        MediaError::Http(code) => format!("http-{code}"),
        MediaError::TimedOut => "timeout".into(),
        MediaError::TooLarge => "size".into(),
        MediaError::HostNotFound => "dns".into(),
        MediaError::BadUrl | MediaError::Forbidden | MediaError::Io(_) => "other".into(),
        MediaError::Doh(ResolveError::NotFound(_)) => "dns".into(),
        MediaError::Doh(ResolveError::AllEndpointsFailed(_)) => "dns-unreachable".into(),
        MediaError::Net(kind, _) => match kind {
            NetFailure::Dns => "dns",
            NetFailure::Timeout => "timeout",
            NetFailure::Offline => "offline",
            NetFailure::Tls => "tls",
            NetFailure::Other => "other",
        }
        .into(),
    })
}

pub fn line(kind: &str, host: &str, failure_class: &str, suppressed: usize) -> String {
    let mut line = format!("media fail kind={kind} host={host} class={failure_class}");
    if suppressed > 0 {
        line.push_str(&format!(" suppressed={suppressed}"));
    }
    line
}

static LIMITER: Mutex<Option<Limiter>> = Mutex::new(None);

/// Reports a failed media load to the log (rate-limited). Safe from any thread.
pub fn report(url: &url::Url, error: &MediaError, kind: &str) {
    let Some(class) = classify(error) else { return };
    let Some(host) = url.host_str().map(str::to_ascii_lowercase).filter(|h| !h.is_empty()) else { return };
    let suppressed = LIMITER.lock().get_or_insert_with(Limiter::default).admit(&format!("{kind}|{host}|{class}"), Instant::now());
    if let Some(suppressed) = suppressed {
        log::warn!("{}", line(kind, &host, &class, suppressed));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_failures() {
        assert_eq!(classify(&MediaError::Http(404)).as_deref(), Some("http-404"));
        assert_eq!(classify(&MediaError::HostNotFound).as_deref(), Some("dns"));
        assert_eq!(classify(&MediaError::Net(NetFailure::Dns, String::new())).as_deref(), Some("dns"));
        assert_eq!(classify(&MediaError::Net(NetFailure::Timeout, String::new())).as_deref(), Some("timeout"));
        assert_eq!(classify(&MediaError::Net(NetFailure::Offline, String::new())).as_deref(), Some("offline"));
        assert_eq!(classify(&MediaError::Net(NetFailure::Tls, String::new())).as_deref(), Some("tls"));
        assert_eq!(classify(&MediaError::TooLarge).as_deref(), Some("size"));
        assert_eq!(classify(&MediaError::Doh(ResolveError::NotFound("x".into()))).as_deref(), Some("dns"));
        assert_eq!(classify(&MediaError::Doh(ResolveError::AllEndpointsFailed("x".into()))).as_deref(), Some("dns-unreachable"));
        assert_eq!(classify(&MediaError::Cancelled), None);
    }

    #[test]
    fn limiter_drops_repeats_and_counts_them() {
        let mut limiter = Limiter::new(Duration::from_secs(60), 3);
        let t0 = Instant::now();
        let at = |s: u64| t0 + Duration::from_secs(s);
        assert_eq!(limiter.admit("a", t0), Some(0));
        assert_eq!(limiter.admit("a", at(1)), None);
        assert_eq!(limiter.admit("a", at(2)), None);
        assert_eq!(limiter.admit("a", at(61)), Some(2)); // reports how many were dropped
        assert_eq!(limiter.admit("b", at(62)), Some(0));
        assert_eq!(limiter.admit("c", at(63)), Some(0));
        assert_eq!(limiter.admit("d", at(64)), None); // per-minute cap (3 since t0+61) reached
        assert_eq!(limiter.admit("d", at(130)), Some(1)); // new minute; one drop reported
    }

    #[test]
    fn line_carries_host_and_class_only() {
        assert_eq!(line("image", "f28-zpc.zdn.vn", "dns", 4), "media fail kind=image host=f28-zpc.zdn.vn class=dns suppressed=4");
        assert_eq!(line("file", "f28-zpc.zdn.vn", "http-404", 0), "media fail kind=file host=f28-zpc.zdn.vn class=http-404");
    }
}
