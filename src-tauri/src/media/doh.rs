//! DNS-over-HTTPS resolver used when the system resolver cannot resolve Zalo CDN hosts (some ISP / VPN resolvers
//! SERVFAIL on `*.zadn.vn`; Zalo PC is unaffected because Chromium ships its own resolver). Port of
//! `DoHResolver.swift`: JSON API endpoints tried in order — two hostname endpoints, then IP literals (valid IP SANs on
//! both certificates) for when even those do not resolve. Answers are cached for their TTL (clamped 60…600 s),
//! NXDOMAIN for 300 s, and concurrent lookups of one host share a query.

use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Deserialize;

use super::ResolveError;
use super::flights::Flights;

pub const ENDPOINTS: &[&str] =
    &["https://dns.google/resolve", "https://cloudflare-dns.com/dns-query", "https://8.8.8.8/resolve", "https://1.1.1.1/dns-query"];

pub const NEGATIVE_TTL: Duration = Duration::from_secs(300);

#[derive(Deserialize)]
#[allow(non_snake_case)]
struct Answer {
    #[serde(rename = "type")]
    kind: i64,
    TTL: Option<i64>,
    data: String,
}

#[derive(Deserialize)]
#[allow(non_snake_case)]
struct Reply {
    Status: i64,
    Answer: Option<Vec<Answer>>,
}

/// What one endpoint's JSON reply says.
#[derive(Debug, PartialEq, Eq)]
pub enum ReplyOutcome {
    /// NXDOMAIN (Status 3) is authoritative.
    NotFound,
    /// A records and the cache lifetime (min TTL, clamped to 60…600 s; 60 s when absent).
    Addresses(Vec<Ipv4Addr>, Duration),
    /// Unusable (SERVFAIL, no A records, garbage): try the next endpoint.
    Skip,
}

pub fn parse_reply(body: &[u8]) -> ReplyOutcome {
    let Ok(reply) = serde_json::from_slice::<Reply>(body) else { return ReplyOutcome::Skip };
    if reply.Status == 3 {
        return ReplyOutcome::NotFound;
    }
    if reply.Status != 0 {
        return ReplyOutcome::Skip;
    }
    let records: Vec<&Answer> = reply.Answer.iter().flatten().filter(|a| a.kind == 1).collect();
    let addresses: Vec<Ipv4Addr> = records.iter().filter_map(|a| a.data.parse().ok()).collect();
    if addresses.is_empty() {
        return ReplyOutcome::Skip;
    }
    let ttl = records.iter().filter_map(|a| a.TTL).min().unwrap_or(60).clamp(60, 600);
    ReplyOutcome::Addresses(addresses, Duration::from_secs(ttl as u64))
}

pub struct DoHResolver {
    client: reqwest::Client,
    endpoints: Vec<String>,
    cache: Mutex<HashMap<String, (Vec<Ipv4Addr>, Instant)>>,
    negative: Mutex<HashMap<String, Instant>>,
    in_flight: Flights<Result<(Vec<Ipv4Addr>, Duration), ResolveError>>,
}

impl Default for DoHResolver {
    fn default() -> Self {
        Self::new(ENDPOINTS.iter().map(|s| s.to_string()).collect())
    }
}

impl DoHResolver {
    pub fn new(endpoints: Vec<String>) -> Self {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(8))
            .build()
            .expect("DoH client");
        Self { client, endpoints, cache: Mutex::default(), negative: Mutex::default(), in_flight: Flights::default() }
    }

    /// Resolved IPv4 addresses for `host`.
    pub async fn resolve(&self, host: &str) -> Result<Vec<Ipv4Addr>, ResolveError> {
        let key = host.to_ascii_lowercase();
        let now = Instant::now();
        if let Some((addresses, expires)) = self.cache.lock().get(&key) {
            if *expires > now {
                return Ok(addresses.clone());
            }
        }
        {
            let mut negative = self.negative.lock();
            match negative.get(&key) {
                Some(until) if *until > now => return Err(ResolveError::NotFound(host.to_owned())),
                Some(_) => {
                    negative.remove(&key);
                }
                None => {}
            }
        }
        let (client, endpoints, name) = (self.client.clone(), self.endpoints.clone(), key.clone());
        let result = self.in_flight.join(&key, move || query(client, endpoints, name)).await;
        match result {
            Ok((addresses, ttl)) => {
                self.cache.lock().insert(key, (addresses.clone(), Instant::now() + ttl));
                Ok(addresses)
            }
            Err(ResolveError::NotFound(h)) => {
                let mut negative = self.negative.lock();
                if negative.len() > 2000 {
                    negative.clear();
                }
                negative.insert(key, Instant::now() + NEGATIVE_TTL);
                Err(ResolveError::NotFound(h))
            }
            Err(e) => Err(e),
        }
    }

    /// Drops a cached answer (e.g. after every address failed to connect).
    pub fn invalidate(&self, host: &str) {
        self.cache.lock().remove(&host.to_ascii_lowercase());
    }
}

async fn query(client: reqwest::Client, endpoints: Vec<String>, host: String) -> Result<(Vec<Ipv4Addr>, Duration), ResolveError> {
    for endpoint in &endpoints {
        let Ok(mut url) = url::Url::parse(endpoint) else { continue };
        url.query_pairs_mut().append_pair("name", &host).append_pair("type", "A");
        let response = match client.get(url).header("Accept", "application/dns-json").send().await {
            Ok(r) if r.status().as_u16() == 200 => r,
            _ => continue,
        };
        let Ok(body) = response.bytes().await else { continue };
        match parse_reply(&body) {
            ReplyOutcome::NotFound => return Err(ResolveError::NotFound(host)),
            ReplyOutcome::Addresses(addresses, ttl) => return Ok((addresses, ttl)),
            ReplyOutcome::Skip => continue,
        }
    }
    Err(ResolveError::AllEndpointsFailed(host))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_records_and_clamps_ttl() {
        let body = br#"{"Status":0,"TC":false,"Answer":[
            {"name":"res-zalo.zadn.vn.","type":5,"TTL":300,"data":"res-zalo.zadn.vn.edgekey.net."},
            {"name":"x.","type":1,"TTL":30,"data":"203.205.137.10"},
            {"name":"x.","type":1,"TTL":120,"data":"203.205.137.11"}]}"#;
        assert_eq!(
            parse_reply(body),
            ReplyOutcome::Addresses(vec!["203.205.137.10".parse().unwrap(), "203.205.137.11".parse().unwrap()], Duration::from_secs(60))
        );
        let long = br#"{"Status":0,"Answer":[{"type":1,"TTL":86400,"data":"1.2.3.4"}]}"#;
        assert_eq!(parse_reply(long), ReplyOutcome::Addresses(vec![Ipv4Addr::new(1, 2, 3, 4)], Duration::from_secs(600)));
        let no_ttl = br#"{"Status":0,"Answer":[{"type":1,"data":"1.2.3.4"}]}"#;
        assert_eq!(parse_reply(no_ttl), ReplyOutcome::Addresses(vec![Ipv4Addr::new(1, 2, 3, 4)], Duration::from_secs(60)));
    }

    #[test]
    fn nxdomain_is_authoritative_and_other_failures_skip() {
        assert_eq!(parse_reply(br#"{"Status":3,"Authority":[]}"#), ReplyOutcome::NotFound);
        assert_eq!(parse_reply(br#"{"Status":2}"#), ReplyOutcome::Skip); // SERVFAIL
        assert_eq!(parse_reply(br#"{"Status":0}"#), ReplyOutcome::Skip); // NOERROR, no answer
        assert_eq!(parse_reply(br#"{"Status":0,"Answer":[{"type":28,"TTL":60,"data":"::1"}]}"#), ReplyOutcome::Skip); // AAAA only
        assert_eq!(parse_reply(br#"{"Status":0,"Answer":[{"type":1,"TTL":60,"data":"not-an-ip"}]}"#), ReplyOutcome::Skip);
        assert_eq!(parse_reply(b"<html>"), ReplyOutcome::Skip);
    }

    #[tokio::test]
    async fn unreachable_endpoints_fail_all_and_are_not_cached_as_negative() {
        // Port 9 on localhost: connection refused, no network involved.
        let resolver = DoHResolver::new(vec!["https://127.0.0.1:9/resolve".into(), "not a url".into()]);
        assert_eq!(resolver.resolve("res-zalo.zadn.vn").await, Err(ResolveError::AllEndpointsFailed("res-zalo.zadn.vn".into())));
        assert!(resolver.negative.lock().is_empty());
    }

    #[tokio::test]
    async fn serves_cache_and_negative_entries_without_querying() {
        let resolver = DoHResolver::new(vec![]);
        resolver.cache.lock().insert("a.zadn.vn".into(), (vec![Ipv4Addr::new(1, 2, 3, 4)], Instant::now() + Duration::from_secs(60)));
        assert_eq!(resolver.resolve("A.zadn.vn").await, Ok(vec![Ipv4Addr::new(1, 2, 3, 4)]));
        resolver.invalidate("a.zadn.vn");
        assert!(matches!(resolver.resolve("a.zadn.vn").await, Err(ResolveError::AllEndpointsFailed(_))));
        resolver.negative.lock().insert("gone.zdn.vn".into(), Instant::now() + NEGATIVE_TTL);
        assert_eq!(resolver.resolve("gone.zdn.vn").await, Err(ResolveError::NotFound("gone.zdn.vn".into())));
    }
}
