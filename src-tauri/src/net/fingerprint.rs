//! Client for the Go fingerprint helper (`FingerprintHelper/` of the Swift repo): performs requests with Chromium
//! 108's exact TLS ClientHello and HTTP/2 fingerprint over a unix socket. Until the helper is wired in, `ready`
//! returns `None` and the proxy uses reqwest.

use std::time::Duration;

use super::HttpResponse;

pub enum Error {
    /// The helper is not running / the connection dropped: the caller may fall back.
    Unavailable,
    /// An upstream failure (timeout, TLS, HTTP): a real answer, never retried on another stack.
    Failed(String),
}

pub struct FingerprintProxy;

static SHARED: FingerprintProxy = FingerprintProxy;

impl FingerprintProxy {
    pub fn shared() -> &'static FingerprintProxy {
        &SHARED
    }

    /// The helper when it is up (waiting at most `_wait` for it to start).
    pub async fn ready(&self, _wait: Duration) -> Option<&'static FingerprintProxy> {
        None
    }

    pub async fn perform(
        &self,
        _method: &str,
        _url: &str,
        _headers: &[(String, String)],
        _body: &[u8],
        _timeout: Option<Duration>,
    ) -> Result<HttpResponse, Error> {
        Err(Error::Unavailable)
    }

    /// Starts the helper process early so it is ready before the renderer's first requests.
    pub fn warm_up(&self, _app: &tauri::AppHandle) {}

    pub fn shutdown(&self) {}
}
