//! Port of `MediaLoader.swift` (minus image decoding, which the webview does).
//!
//! `data` (image flavour): disk cache → shared in-flight download (≤ 6 concurrent, 25 s deadline) → fingerprint
//! helper → system DNS + reqwest → DoH + pinned client for Zalo CDN hosts whose system lookup fails. Failures back
//! off for 20 s per URL; NXDOMAIN hosts fail fast for 5 min.
//!
//! `start_file` / `local_file` (cors flavour): the same transport ladder — the helper *streams* — written to
//! `MediaCache/files/<hash>.<ext>` through a `.part` file (2 GB cap, 30 s stall timeout, no total deadline),
//! quarantined, LRU-trimmed. The download runs as a detached task observable through `ActiveDownload`, so the
//! scheme can serve ranges while it runs.

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use futures_util::future::{BoxFuture, FutureExt};
use parking_lot::Mutex;
use tauri::{AppHandle, Manager};
use tokio::sync::Semaphore;

use super::active::{ActiveDownload, FinishGuard};
use super::cache::{self, DiskCache};
use super::doh::DoHResolver;
use super::flights::Flights;
use super::headers::{Flavour, apply_client_headers, helper_headers, sanitized_headers};
use super::http::{self, Body, header, is_redirect, response_headers};
use super::pinned::PinnedClients;
use super::policy::{DnsState, DohOutcome, HelperOutcome, doh_failure, helper_failure};
use super::{MediaError, NetFailure, diagnostics, is_allowed_local_file, is_zalo_cdn, normalized};
use crate::net::{self, cookies::CookieJar, fingerprint, fp};

pub const IMAGE_DEADLINE: Duration = Duration::from_secs(25);
/// Stall timeout of the image transports (Swift `timeoutIntervalForRequest`).
pub const IMAGE_IDLE: Duration = Duration::from_secs(10);
/// Files have no total deadline: a transfer fails only after this long without receiving any bytes.
pub const FILE_IDLE: Duration = Duration::from_secs(30);
pub const HELPER_IMAGE_TIMEOUT: Duration = Duration::from_secs(20);
pub const HELPER_WAIT: Duration = Duration::from_secs(2);
pub const MAX_IMAGE_BYTES: u64 = 96 << 20;
/// Largest file `local_file` downloads (Zalo allows up to 1 GB).
pub const MAX_FILE_BYTES: u64 = 2 << 30;
pub const MAX_CONCURRENT_DOWNLOADS: usize = 6;
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const REDIRECTS: u8 = 3;
/// The image cache is trimmed after this many stores.
const TRIM_EVERY_WRITES: u32 = 64;

/// A loaded body and its Content-Type.
#[derive(Debug)]
pub struct Media {
    pub content_type: String,
    pub bytes: Vec<u8>,
}

pub struct MediaLoader {
    app: Option<AppHandle>,
    pub cache: DiskCache,
    resolver: DoHResolver,
    pinned: PinnedClients,
    system: reqwest::Client,
    state: Mutex<DnsState>,
    data_flights: Flights<Result<Arc<Media>, MediaError>>,
    /// File downloads in progress, by final path.
    active: Mutex<HashMap<PathBuf, Arc<ActiveDownload>>>,
    probes: Flights<bool>,
    slots: Arc<Semaphore>,
    maintenance_started: AtomicBool,
    media_writes: AtomicU32,
}

static SHARED: OnceLock<Arc<MediaLoader>> = OnceLock::new();

fn content_type_of(headers: &[(String, String)]) -> String {
    cache::clean_content_type(header(headers, "content-type").as_deref()).unwrap_or_else(|| "application/octet-stream".into())
}

/// The redirect target of a 3xx response, normalized.
fn location(response: &reqwest::Response, base: &url::Url) -> Option<url::Url> {
    let value = response.headers().get("location")?.to_str().ok()?;
    normalized(&base.join(value).ok()?)
}

fn host_of(url: &url::Url) -> Result<String, MediaError> {
    url.host_str().filter(|h| !h.is_empty()).map(str::to_ascii_lowercase).ok_or(MediaError::BadUrl)
}

/// A DoH/pinned fetch is only for https Zalo CDN URLs.
fn doh_host(url: &url::Url) -> Result<String, MediaError> {
    let host = host_of(url)?;
    if url.scheme() != "https" || !is_zalo_cdn(&host) {
        return Err(MediaError::BadUrl);
    }
    Ok(host)
}

/// Does the system resolver answer for `host` within `timeout`?
pub async fn probe_system_dns(host: String, timeout: Duration) -> bool {
    match tokio::time::timeout(timeout, tokio::net::lookup_host((host.as_str(), 443))).await {
        Ok(Ok(mut addrs)) => addrs.next().is_some(),
        _ => false,
    }
}

impl MediaLoader {
    /// The app-wide loader (`app_support()/MediaCache`).
    pub fn shared(app: &AppHandle) -> Arc<Self> {
        SHARED
            .get_or_init(|| {
                let root = crate::platform::app_support().join("MediaCache");
                Arc::new(Self::new(Some(app.clone()), DiskCache::new(&root), DoHResolver::default(), MAX_CONCURRENT_DOWNLOADS))
            })
            .clone()
    }

    /// `app: None` (tests): no fingerprint helper, no cookies, default user agent.
    pub fn new(app: Option<AppHandle>, cache: DiskCache, resolver: DoHResolver, max_concurrent: usize) -> Self {
        let system = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(10))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .expect("media http client");
        Self {
            app,
            cache,
            resolver,
            pinned: PinnedClients::default(),
            system,
            state: Mutex::default(),
            data_flights: Flights::default(),
            active: Mutex::default(),
            probes: Flights::default(),
            slots: Arc::new(Semaphore::new(max_concurrent)),
            maintenance_started: AtomicBool::new(false),
            media_writes: AtomicU32::new(0),
        }
    }

    // ---- identity ----

    fn user_agent(&self) -> String {
        self.app
            .as_ref()
            .and_then(|app| app.try_state::<Arc<crate::engine::Engine>>().and_then(|e| e.main_process()))
            .map(|main| main.platform.user_agent())
            .unwrap_or_else(|| fp::user_agent(fp::DEFAULT_CLIENT_VERSION))
    }

    fn jar(&self) -> Option<Arc<CookieJar>> {
        Some(self.app.as_ref()?.try_state::<Arc<CookieJar>>()?.inner().clone())
    }

    /// The full wire header set for the reqwest transports: cookies (Zalo https hosts only) + flavour defaults.
    fn wire_headers(&self, url: &url::Url, flavour: Flavour) -> Vec<(String, String)> {
        let mut base = Vec::new();
        if let Some(cookie) = self.jar().and_then(|j| j.header_for(url)) {
            base.push(("cookie".to_owned(), cookie));
        }
        let mut headers = sanitized_headers(&base, url);
        apply_client_headers(&mut headers, flavour, &self.user_agent());
        headers
    }

    fn store_cookies(&self, url: &url::Url, response: &reqwest::Response) {
        if let Some(jar) = self.jar() {
            jar.store_from_headers(url, &response_headers(response));
        }
    }

    // ---- state (locks never held across an await) ----

    fn fail_if_dead(&self, host: &str) -> Result<(), MediaError> {
        if self.state.lock().is_dead(host, Instant::now()) { Err(MediaError::HostNotFound) } else { Ok(()) }
    }

    fn mark_dead(&self, host: &str) {
        self.state.lock().mark_dead(host, Instant::now());
    }

    fn doh_worked(&self, host: &str) {
        self.state.lock().doh_worked(host, Instant::now());
    }

    fn doh_broke(&self, host: &str) {
        self.state.lock().doh_broke(host, Instant::now());
    }

    fn known_system(&self, host: &str) -> Option<bool> {
        self.state.lock().known_system(host, Instant::now())
    }

    fn record_probe(&self, host: &str, ok: bool) {
        self.state.lock().record_probe(host, ok, Instant::now());
    }

    /// Test hook: has this host been switched to the DoH path?
    #[cfg(test)]
    pub fn uses_doh(&self, host: &str) -> bool {
        self.state.lock().uses_doh(host, Instant::now())
    }

    // ---- images (and any body the UI wants whole) ----

    /// Bytes for `url` — cached, de-duplicated, concurrency-capped, with an overall deadline. `retry` drops the
    /// failure backoff.
    pub async fn data(self: &Arc<Self>, url: &url::Url, retry: bool) -> Result<Arc<Media>, MediaError> {
        if url.scheme() == "file" {
            // Files the official download path wrote under ZaloData, or our own caches.
            let path = is_allowed_local_file(url).ok_or(MediaError::Forbidden)?;
            let bytes = tokio::fs::read(&path).await?;
            let content_type = tokio::task::spawn_blocking(move || cache::file_content_type(&path)).await.unwrap_or_default();
            return Ok(Arc::new(Media { content_type, bytes }));
        }
        let url = normalized(url).ok_or(MediaError::BadUrl)?;
        let key = cache::cache_key(&url);
        let backoff = {
            let mut st = self.state.lock();
            if retry {
                st.forget_failure(&key);
                None
            } else {
                st.recent_failure(&key, Instant::now())
            }
        };
        if let Some(error) = backoff {
            return Err(error);
        }
        let hit = {
            let (this, u) = (self.clone(), url.clone());
            tokio::task::spawn_blocking(move || this.cache.read_media(&u)).await.ok().flatten()
        };
        if let Some((content_type, bytes)) = hit {
            return Ok(Arc::new(Media { content_type: cache::body_content_type(&content_type, &bytes), bytes }));
        }
        let (this, u) = (self.clone(), url.clone());
        let result = self
            .data_flights
            .join(&format!("d:{url}"), move || async move {
                let _slot = this.slots.clone().acquire_owned().await.map_err(|_| MediaError::Cancelled)?;
                let mut media = match tokio::time::timeout(IMAGE_DEADLINE, this.clone().download(u.clone(), REDIRECTS)).await {
                    Ok(result) => result?,
                    Err(_) => return Err(MediaError::TimedOut),
                };
                media.content_type = cache::body_content_type(&media.content_type, &media.bytes);
                let media = Arc::new(media);
                let (store, m) = (this.clone(), media.clone());
                let _ = tokio::task::spawn_blocking(move || store.store_media(&u, &m)).await;
                Ok(media)
            })
            .await;
        if let Err(error) = &result {
            if *error != MediaError::Cancelled {
                diagnostics::report(&url, error, "image");
                self.state.lock().note_failure(&key, error.clone(), Instant::now());
            }
        }
        result
    }

    fn store_media(&self, url: &url::Url, media: &Media) {
        if let Err(e) = self.cache.write_media(url, &media.content_type, &media.bytes) {
            log::debug!("media cache write failed: {e}");
        }
        if self.media_writes.fetch_add(1, Ordering::Relaxed) % TRIM_EVERY_WRITES == TRIM_EVERY_WRITES - 1 {
            cache::trim_files(&self.cache.media_dir, self.cache.media_limit, None, cache::STALE_PART_AGE, std::time::SystemTime::now());
        }
    }

    fn download(self: Arc<Self>, url: url::Url, redirects_left: u8) -> BoxFuture<'static, Result<Media, MediaError>> {
        async move {
            let host = host_of(&url)?;
            self.fail_if_dead(&host)?;
            if let Some(media) = self.image_via_helper(&url).await? {
                return Ok(media);
            }
            let (doh_loader, doh_url) = (self.clone(), url.clone());
            let doh = move || doh_loader.clone().image_via_doh(doh_url.clone(), redirects_left);
            let system = || self.image_via_system(&url);
            self.with_dns_fallback(&host, false, doh, system).await
        }
        .boxed()
    }

    /// Swift `helperOrFallback`: `Ok(None)` = helper unavailable or name-resolution trouble, use the other stack.
    async fn helper_get(&self, url: &url::Url, flavour: Flavour, timeout: Option<Duration>) -> Result<Option<net::HttpResponse>, MediaError> {
        let Some(app) = &self.app else { return Ok(None) };
        let mut headers = vec![("User-Agent".to_owned(), self.user_agent())];
        headers.extend(helper_headers(&[], url, flavour));
        match net::perform_via_helper(app, "GET", url, headers, &[], timeout, HELPER_WAIT).await {
            Ok(None) => Ok(None),
            Ok(Some(r)) if (200..300).contains(&r.status) => Ok(Some(r)),
            Ok(Some(r)) => Err(MediaError::Http(r.status)),
            Err(message) => match helper_failure(&message) {
                HelperOutcome::Fallback => Ok(None),
                HelperOutcome::Fail(e) => Err(e),
            },
        }
    }

    async fn image_via_helper(&self, url: &url::Url) -> Result<Option<Media>, MediaError> {
        let Some(r) = self.helper_get(url, Flavour::Image, Some(HELPER_IMAGE_TIMEOUT)).await? else { return Ok(None) };
        if r.body.len() as u64 > MAX_IMAGE_BYTES {
            return Err(MediaError::TooLarge);
        }
        Ok(Some(Media { content_type: content_type_of(&r.headers), bytes: r.body }))
    }

    async fn image_via_system(&self, url: &url::Url) -> Result<Media, MediaError> {
        let headers = self.wire_headers(url, Flavour::Image);
        let response = http::send(&self.system, url, &headers, IMAGE_IDLE).await?;
        self.store_cookies(url, &response);
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(MediaError::Http(status));
        }
        let content_type = content_type_of(&response_headers(&response));
        let bytes = http::read_capped(response, MAX_IMAGE_BYTES, IMAGE_IDLE).await?;
        Ok(Media { content_type, bytes })
    }

    /// DoH-resolved, SNI-pinned fetch (Swift `fetchViaDoHFetched`); redirects re-enter `download`.
    fn image_via_doh(self: Arc<Self>, url: url::Url, redirects_left: u8) -> BoxFuture<'static, Result<Media, MediaError>> {
        async move {
            let host = doh_host(&url)?;
            let addresses = self.resolver.resolve(&host).await.map_err(MediaError::Doh)?;
            let client = self.pinned.client(&host, &addresses)?;
            let headers = self.wire_headers(&url, Flavour::Image);
            let response = match http::send(&client, &url, &headers, IMAGE_IDLE).await {
                Ok(r) => r,
                Err(e) => {
                    self.resolver.invalidate(&host);
                    return Err(e);
                }
            };
            self.store_cookies(&url, &response);
            let status = response.status().as_u16();
            if is_redirect(status) && redirects_left > 0 {
                if let Some(next) = location(&response, &url) {
                    return self.clone().download(next, redirects_left - 1).await;
                }
            }
            if !(200..300).contains(&status) {
                return Err(MediaError::Http(status));
            }
            let content_type = content_type_of(&response_headers(&response));
            match http::read_capped(response, MAX_IMAGE_BYTES, IMAGE_IDLE).await {
                Ok(bytes) => Ok(Media { content_type, bytes }),
                Err(e) => {
                    if matches!(e, MediaError::Net(..)) {
                        self.resolver.invalidate(&host);
                    }
                    Err(e)
                }
            }
        }
        .boxed()
    }

    // ---- DNS fallback policy ----

    /// Swift `withDNSFallback`: DoH first for hosts whose system lookup is known/probed bad, DoH as a retry when the
    /// system fetch fails like a DNS problem. DoH is only ever used for Zalo CDN hosts.
    async fn with_dns_fallback<T, D, DF, S, SF>(&self, host: &str, confirm_timeouts: bool, doh: D, system: S) -> Result<T, MediaError>
    where
        D: Fn() -> DF,
        DF: Future<Output = Result<T, MediaError>>,
        S: FnOnce() -> SF,
        SF: Future<Output = Result<T, MediaError>>,
    {
        let allow_doh = is_zalo_cdn(host);
        // Known-bad (or just probed as bad) system DNS: go straight to DoH.
        if allow_doh && !self.system_resolves(host).await {
            match doh().await {
                Ok(result) => {
                    self.doh_worked(host);
                    return Ok(result);
                }
                Err(e) => match doh_failure(&e) {
                    DohOutcome::Propagate => return Err(e),
                    DohOutcome::Dead => {
                        // Authoritative NXDOMAIN: the system resolver cannot know better.
                        self.mark_dead(host);
                        return Err(MediaError::HostNotFound);
                    }
                    DohOutcome::Broken => self.doh_broke(host), // give the system resolver a go
                },
            }
        }
        match system().await {
            Err(MediaError::Net(kind, message)) if allow_doh && kind.is_dns_failure() => {
                // A mid-transfer stall (file downloads) is not evidence of broken DNS: only fall back to DoH when a
                // fresh lookup really fails.
                if confirm_timeouts && kind == NetFailure::Timeout && probe_system_dns(host.to_owned(), PROBE_TIMEOUT).await {
                    return Err(MediaError::TimedOut);
                }
                match doh().await {
                    Ok(result) => {
                        self.doh_worked(host);
                        Ok(result)
                    }
                    Err(e) => match doh_failure(&e) {
                        DohOutcome::Propagate => Err(e), // reached the server through DoH: a real answer
                        DohOutcome::Dead => {
                            self.mark_dead(host);
                            Err(MediaError::HostNotFound)
                        }
                        DohOutcome::Broken => Err(MediaError::Net(kind, message)), // DoH failed too: the system error
                    },
                }
            }
            other => other,
        }
    }

    /// Cheap pre-flight: does the system resolver answer for `host` within a few seconds? One shared probe per host,
    /// so a stalled resolver cannot pile up blocked lookups.
    async fn system_resolves(&self, host: &str) -> bool {
        if let Some(known) = self.known_system(host) {
            return known;
        }
        let name = host.to_owned();
        let ok = self.probes.join(host, move || probe_system_dns(name, PROBE_TIMEOUT)).await;
        self.record_probe(host, ok);
        ok
    }

    // ---- files (voice, documents, video) ----

    /// Downloads `url` (or reuses `MediaCache/files/<hash>.<ext>`) and returns the file.
    pub async fn local_file(self: &Arc<Self>, url: &url::Url) -> Result<PathBuf, MediaError> {
        match self.start_file(url)? {
            FileStart::Ready(path) => Ok(path),
            FileStart::Active(download) => download.finished().await,
        }
    }

    /// The cached file, or the download that produces it (started here unless one already runs). The download
    /// runs detached from any one caller, so range readers coming and going do not restart it.
    pub fn start_file(self: &Arc<Self>, url: &url::Url) -> Result<FileStart, MediaError> {
        if url.scheme() == "file" {
            return is_allowed_local_file(url).map(FileStart::Ready).ok_or(MediaError::Forbidden);
        }
        let url = normalized(url).ok_or(MediaError::BadUrl)?;
        let target = self.cache.file_path(&url);
        self.start_maintenance();
        let mut active = self.active.lock();
        if let Some(download) = active.get(&target) {
            // A task that died without cleaning up leaves a failed entry behind: start over then.
            if !matches!(download.snapshot().finished, Some(Err(_))) {
                return Ok(FileStart::Active(download.clone()));
            }
        }
        if std::fs::metadata(&target).is_ok_and(|m| m.is_file()) {
            cache::touch(&target); // LRU use
            return Ok(FileStart::Ready(target));
        }
        let download = Arc::new(ActiveDownload::default());
        active.insert(target.clone(), download.clone());
        drop(active);
        let this = self.clone();
        let task_download = download.clone();
        tokio::spawn(async move {
            let guard = FinishGuard(task_download.clone());
            let result = match this.clone().file_to_temp(url.clone(), REDIRECTS, task_download.clone()).await {
                Ok(temp) => {
                    let (target, origin) = (target.clone(), url.clone());
                    tokio::task::spawn_blocking(move || publish(&temp, &target, &origin))
                        .await
                        .unwrap_or_else(|e| Err(MediaError::Io(e.to_string())))
                }
                Err(e) => Err(e),
            };
            match &result {
                Ok(path) => this.schedule_trim(Some(path.clone())),
                Err(error) => diagnostics::report(&url, error, "file"),
            }
            // Published (or failed) before leaving the table: a new caller then finds the file.
            task_download.finish(result);
            this.active.lock().remove(&target);
            drop(guard);
        });
        Ok(FileStart::Active(download))
    }

    fn start_maintenance(self: &Arc<Self>) {
        if !self.maintenance_started.swap(true, Ordering::Relaxed) {
            self.schedule_trim(None);
        }
    }

    fn schedule_trim(self: &Arc<Self>, keep: Option<PathBuf>) {
        let this = self.clone();
        tokio::task::spawn_blocking(move || this.cache.trim_all(keep.as_deref()));
    }

    /// A complete download in a fresh `.part` file (none is left behind on failure).
    fn file_to_temp(
        self: Arc<Self>,
        url: url::Url,
        redirects_left: u8,
        progress: Arc<ActiveDownload>,
    ) -> BoxFuture<'static, Result<PathBuf, MediaError>> {
        async move {
            let host = host_of(&url)?;
            self.fail_if_dead(&host)?;
            if let Some(file) = self.file_via_helper(&url, &progress).await? {
                return Ok(file);
            }
            let (doh_loader, doh_url, doh_progress) = (self.clone(), url.clone(), progress.clone());
            let doh = move || doh_loader.clone().file_via_doh(doh_url.clone(), redirects_left, doh_progress.clone());
            let system = || self.file_via_system(&url, &progress);
            self.with_dns_fallback(&host, true, doh, system).await
        }
        .boxed()
    }

    /// Streams through the fingerprint helper. `Ok(None)`: helper unavailable (also when its connection drops
    /// mid-body) or name-resolution trouble — the caller uses the other stack (Swift `fetchFileViaHelper`).
    async fn file_via_helper(&self, url: &url::Url, progress: &ActiveDownload) -> Result<Option<PathBuf>, MediaError> {
        let Some(app) = &self.app else { return Ok(None) };
        let mut request = fingerprint::Request::new("GET", url.as_str());
        request.headers = vec![("User-Agent".to_owned(), self.user_agent())];
        request.headers.extend(helper_headers(&[], url, Flavour::Cors));
        request.max_bytes = MAX_FILE_BYTES as i64;
        request.idle_ms = FILE_IDLE.as_millis() as u64;
        let start = match net::stream_via_helper(app, url, request, HELPER_WAIT).await {
            Ok(None) => return Ok(None),
            Ok(Some(start)) => start,
            Err(e) => {
                let e = http::helper_stream_error(e);
                return if http::is_helper_lost(&e) { Ok(None) } else { Err(e) };
            }
        };
        let result = match start {
            fingerprint::StreamStart::Complete(r) => {
                if !(200..300).contains(&r.status) {
                    return Err(MediaError::Http(r.status));
                }
                http::write_part(&self.cache.files_dir, &r.body, &content_type_of(&r.headers), progress).await
            }
            fingerprint::StreamStart::Head(head, stream) => {
                if !(200..300).contains(&head.status) {
                    return Err(MediaError::Http(head.status)); // dropping the stream cancels it
                }
                let total = header(&head.headers, "content-length").and_then(|v| v.trim().parse().ok());
                let content_type = content_type_of(&head.headers);
                http::stream_to_part(Body::Helper(stream), &self.cache.files_dir, MAX_FILE_BYTES, FILE_IDLE, total, &content_type, progress).await
            }
        };
        match result {
            Ok(temp) => Ok(Some(temp)),
            Err(e) if http::is_helper_lost(&e) => Ok(None),
            Err(e) => Err(e),
        }
    }

    async fn file_via_system(&self, url: &url::Url, progress: &ActiveDownload) -> Result<PathBuf, MediaError> {
        let headers = self.wire_headers(url, Flavour::Cors);
        let response = http::send(&self.system, url, &headers, FILE_IDLE).await?;
        self.store_cookies(url, &response);
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(MediaError::Http(status));
        }
        let content_type = content_type_of(&response_headers(&response));
        http::stream_to_part(Body::Reqwest(response), &self.cache.files_dir, MAX_FILE_BYTES, FILE_IDLE, None, &content_type, progress).await
    }

    /// A pinned-transport failure while fetching a file: size and stalls are verdicts, anything else invalidates
    /// the DoH answer.
    fn pinned_file_error(&self, host: &str, error: MediaError) -> MediaError {
        match error {
            MediaError::TooLarge => MediaError::TooLarge,
            MediaError::Net(NetFailure::Timeout, _) => MediaError::TimedOut,
            other => {
                self.resolver.invalidate(host);
                other
            }
        }
    }

    fn file_via_doh(
        self: Arc<Self>,
        url: url::Url,
        redirects_left: u8,
        progress: Arc<ActiveDownload>,
    ) -> BoxFuture<'static, Result<PathBuf, MediaError>> {
        async move {
            let host = doh_host(&url)?;
            let addresses = self.resolver.resolve(&host).await.map_err(MediaError::Doh)?;
            let client = self.pinned.client(&host, &addresses)?;
            let headers = self.wire_headers(&url, Flavour::Cors);
            let response = http::send(&client, &url, &headers, FILE_IDLE).await.map_err(|e| self.pinned_file_error(&host, e))?;
            self.store_cookies(&url, &response);
            let status = response.status().as_u16();
            if is_redirect(status) && redirects_left > 0 {
                if let Some(next) = location(&response, &url) {
                    return self.clone().file_to_temp(next, redirects_left - 1, progress).await;
                }
            }
            if !(200..300).contains(&status) {
                return Err(MediaError::Http(status));
            }
            let content_type = content_type_of(&response_headers(&response));
            http::stream_to_part(Body::Reqwest(response), &self.cache.files_dir, MAX_FILE_BYTES, FILE_IDLE, None, &content_type, &progress)
                .await
                .map_err(|e| self.pinned_file_error(&host, e))
        }
        .boxed()
    }
}

/// What `start_file` found.
pub enum FileStart {
    Ready(PathBuf),
    Active(Arc<ActiveDownload>),
}

/// Moves a finished `.part` file to its final name (quarantined first, so the file is never visible without it).
/// Losing a race to another complete copy is fine.
fn publish(temp: &std::path::Path, target: &std::path::Path, origin: &url::Url) -> Result<PathBuf, MediaError> {
    if target.exists() {
        let _ = std::fs::remove_file(temp);
        return Ok(target.to_path_buf());
    }
    cache::apply_quarantine(temp, origin);
    match std::fs::rename(temp, target) {
        Ok(()) => Ok(target.to_path_buf()),
        Err(e) => {
            let _ = std::fs::remove_file(temp);
            if target.exists() { Ok(target.to_path_buf()) } else { Err(e.into()) }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::ResolveError;
    use std::sync::atomic::AtomicUsize;

    fn temp_loader() -> Arc<MediaLoader> {
        let root = std::env::temp_dir().join(format!("compola-media-test-{}", uuid::Uuid::new_v4()));
        // No reachable resolvers: nothing in these tests may leave the machine.
        Arc::new(MediaLoader::new(None, DiskCache::new(&root), DoHResolver::new(vec![]), 6))
    }

    fn u(s: &str) -> url::Url {
        url::Url::parse(s).unwrap()
    }

    #[tokio::test]
    async fn non_cdn_hosts_are_not_fetched_via_doh() {
        let loader = temp_loader();
        assert_eq!(loader.clone().image_via_doh(u("https://www.apple.com/"), 3).await.unwrap_err(), MediaError::BadUrl);
        assert_eq!(loader.clone().file_via_doh(u("http://res-zalo.zadn.vn/a"), 3, Arc::default()).await.unwrap_err(), MediaError::BadUrl);
    }

    #[tokio::test]
    async fn bad_and_forbidden_urls() {
        let loader = temp_loader();
        assert_eq!(loader.data(&u("ftp://x/y.jpg"), false).await.unwrap_err(), MediaError::BadUrl);
        assert_eq!(loader.data(&u("file:///etc/hosts"), false).await.unwrap_err(), MediaError::Forbidden);
        assert_eq!(loader.local_file(&u("file:///etc/hosts")).await.unwrap_err(), MediaError::Forbidden);
    }

    #[tokio::test]
    async fn cache_hits_need_no_network() {
        let loader = temp_loader();
        let url = u("http://s120-ava-talk.zadn.vn/a.jpg"); // normalized to https before the lookup
        loader.cache.write_media(&normalized(&url).unwrap(), "application/octet-stream", b"GIF89a....").unwrap();
        let media = loader.data(&url, false).await.unwrap();
        assert_eq!(media.bytes, b"GIF89a....");
        assert_eq!(media.content_type, "image/gif"); // generic server type → sniffed
        let file_url = u("https://f6-zpc.zdn.vn/v/clip.mp4");
        let path = loader.cache.file_path(&file_url);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"x").unwrap();
        assert_eq!(loader.local_file(&file_url).await.unwrap(), path);
        let _ = std::fs::remove_dir_all(loader.cache.media_dir.parent().unwrap());
    }

    #[tokio::test]
    async fn dead_hosts_fail_fast_and_failures_back_off() {
        let loader = temp_loader();
        loader.mark_dead("f28-zpc.zdn.vn");
        let url = u("https://f28-zpc.zdn.vn/jpg/a.jpg");
        assert_eq!(loader.data(&url, false).await.unwrap_err(), MediaError::HostNotFound);
        assert_eq!(loader.local_file(&url).await.unwrap_err(), MediaError::HostNotFound);
        // The image failure is remembered: the next call answers from the backoff even once the host is alive.
        loader.state.lock().dead_hosts_clear_for_tests();
        assert_eq!(loader.data(&url, false).await.unwrap_err(), MediaError::HostNotFound);
    }

    #[tokio::test]
    async fn file_downloads_are_shared_and_leave_the_table_when_done() {
        let loader = temp_loader();
        loader.mark_dead("f28-zpc.zdn.vn");
        let url = u("https://f28-zpc.zdn.vn/v/clip.mp4");
        let (FileStart::Active(a), FileStart::Active(b)) = (loader.start_file(&url).unwrap(), loader.start_file(&url).unwrap()) else {
            panic!("expected a running download");
        };
        assert!(Arc::ptr_eq(&a, &b));
        assert_eq!(a.finished().await, Err(MediaError::HostNotFound));
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(loader.active.lock().is_empty());
        assert_eq!(loader.local_file(&url).await, Err(MediaError::HostNotFound)); // a fresh attempt
    }

    /// Calls counted by the fake transports.
    #[derive(Default)]
    struct Calls {
        doh: AtomicUsize,
        system: AtomicUsize,
    }

    async fn fallback(
        loader: &MediaLoader,
        host: &str,
        calls: &Calls,
        doh: Result<u8, MediaError>,
        system: Result<u8, MediaError>,
    ) -> Result<u8, MediaError> {
        loader
            .with_dns_fallback(
                host,
                false,
                || {
                    calls.doh.fetch_add(1, Ordering::SeqCst);
                    let r = doh.clone();
                    async move { r }
                },
                || {
                    calls.system.fetch_add(1, Ordering::SeqCst);
                    async move { system }
                },
            )
            .await
    }

    fn dns_error() -> MediaError {
        MediaError::Net(NetFailure::Dns, "dns error".into())
    }

    #[tokio::test]
    async fn system_dns_failure_retries_through_doh_and_sticks() {
        let loader = temp_loader();
        let host = "res-zalo.zadn.vn";
        loader.record_probe(host, true);
        let calls = Calls::default();
        assert_eq!(fallback(&loader, host, &calls, Ok(1), Err(dns_error())).await, Ok(1));
        assert_eq!((calls.system.load(Ordering::SeqCst), calls.doh.load(Ordering::SeqCst)), (1, 1));
        assert!(loader.uses_doh(host));
        // Now known-bad: DoH first, the system path is not tried.
        let calls = Calls::default();
        assert_eq!(fallback(&loader, host, &calls, Ok(2), Ok(9)).await, Ok(2));
        assert_eq!((calls.system.load(Ordering::SeqCst), calls.doh.load(Ordering::SeqCst)), (0, 1));
    }

    #[tokio::test]
    async fn doh_verdicts() {
        let loader = temp_loader();
        let host = "f6-zpc.zdn.vn";
        loader.record_probe(host, false); // probe failed → DoH first
        // A real HTTP answer through DoH is reported as is; the system path is not tried.
        let calls = Calls::default();
        assert_eq!(fallback(&loader, host, &calls, Err(MediaError::Http(403)), Ok(9)).await, Err(MediaError::Http(403)));
        assert_eq!(calls.system.load(Ordering::SeqCst), 0);
        // A broken DoH path hands over to the system resolver.
        let calls = Calls::default();
        let broken = MediaError::Doh(ResolveError::AllEndpointsFailed(host.into()));
        assert_eq!(fallback(&loader, host, &calls, Err(broken.clone()), Ok(7)).await, Ok(7));
        assert!(!loader.uses_doh(host));
        // System DNS fails, DoH unreachable too: the system error is reported.
        let calls = Calls::default();
        assert_eq!(fallback(&loader, host, &calls, Err(broken), Err(dns_error())).await, Err(dns_error()));
        // NXDOMAIN through DoH: the host is dead.
        let calls = Calls::default();
        let gone = MediaError::Doh(ResolveError::NotFound(host.into()));
        assert_eq!(fallback(&loader, host, &calls, Err(gone), Err(dns_error())).await, Err(MediaError::HostNotFound));
        assert_eq!(loader.fail_if_dead(host), Err(MediaError::HostNotFound));
    }

    #[tokio::test]
    async fn non_zalo_hosts_never_use_doh() {
        let loader = temp_loader();
        let calls = Calls::default();
        assert_eq!(fallback(&loader, "example.com", &calls, Ok(1), Err(dns_error())).await, Err(dns_error()));
        assert_eq!(calls.doh.load(Ordering::SeqCst), 0);
        // Non-DNS failures on Zalo hosts do not trigger DoH either.
        let host = "res-zalo.zadn.vn";
        loader.record_probe(host, true);
        let calls = Calls::default();
        let tls = MediaError::Net(NetFailure::Tls, "bad cert".into());
        assert_eq!(fallback(&loader, host, &calls, Ok(1), Err(tls.clone())).await, Err(tls));
        assert_eq!(calls.doh.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn publish_moves_into_place_and_tolerates_races() {
        let dir = std::env::temp_dir().join(format!("compola-publish-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let origin = u("https://res-zalo.zadn.vn/x.bin");
        let (temp, target) = (dir.join(".a.part"), dir.join("a.bin"));
        std::fs::write(&temp, b"one").unwrap();
        assert_eq!(publish(&temp, &target, &origin).unwrap(), target);
        assert!(!temp.exists());
        #[cfg(target_os = "macos")]
        assert!(cache::has_quarantine(&target));
        std::fs::write(&temp, b"two").unwrap();
        assert_eq!(publish(&temp, &target, &origin).unwrap(), target); // lost a race: the other copy wins
        assert_eq!(std::fs::read(&target).unwrap(), b"one");
        assert!(!temp.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
