//! Body handling shared by the system and pinned (DoH) transports: a time-to-headers bound, a stall (idle) timeout
//! between body chunks, and byte caps — buffered for images, streamed to a `.part` file for files (deleted on any
//! failure, so a truncated download never looks complete).

use std::path::{Path, PathBuf};
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use tokio::io::AsyncWriteExt;

use super::active::ActiveDownload;
use super::{MediaError, NetFailure, cache, policy};

pub fn header_map(headers: &[(String, String)]) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (k, v) in headers {
        if let (Ok(name), Ok(value)) = (HeaderName::from_bytes(k.as_bytes()), HeaderValue::from_str(v)) {
            map.append(name, value);
        }
    }
    map
}

fn timed_out() -> MediaError {
    MediaError::Net(NetFailure::Timeout, "timed out".into())
}

/// GET `url`; waits at most `ttfb` for the response head.
pub async fn send(client: &reqwest::Client, url: &url::Url, headers: &[(String, String)], ttfb: Duration) -> Result<reqwest::Response, MediaError> {
    let request = client.get(url.clone()).headers(header_map(headers)).send();
    match tokio::time::timeout(ttfb, request).await {
        Ok(Ok(response)) => Ok(response),
        Ok(Err(e)) => Err(policy::from_reqwest(&e)),
        Err(_) => Err(timed_out()),
    }
}

pub fn header(headers: &[(String, String)], name: &str) -> Option<String> {
    headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone())
}

pub fn response_headers(response: &reqwest::Response) -> Vec<(String, String)> {
    response.headers().iter().map(|(k, v)| (k.as_str().to_owned(), String::from_utf8_lossy(v.as_bytes()).into_owned())).collect()
}

pub fn is_redirect(status: u16) -> bool {
    matches!(status, 301 | 302 | 303 | 307 | 308)
}

/// The next body chunk, or a timeout after `idle` without data.
async fn next_chunk(response: &mut reqwest::Response, idle: Duration) -> Result<Option<Vec<u8>>, MediaError> {
    match tokio::time::timeout(idle, response.chunk()).await {
        Ok(Ok(chunk)) => Ok(chunk.map(|b| b.to_vec())),
        Ok(Err(e)) => Err(policy::from_reqwest(&e)),
        Err(_) => Err(timed_out()),
    }
}

/// Whole body in memory, at most `max` bytes, failing after `idle` without data.
pub async fn read_capped(mut response: reqwest::Response, max: u64, idle: Duration) -> Result<Vec<u8>, MediaError> {
    if response.content_length().is_some_and(|n| n > max) {
        return Err(MediaError::TooLarge);
    }
    let mut body = Vec::with_capacity(response.content_length().unwrap_or(0).min(max) as usize);
    while let Some(chunk) = next_chunk(&mut response, idle).await? {
        if body.len() as u64 + chunk.len() as u64 > max {
            return Err(MediaError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// A fresh `.<uuid>.part` path in `directory`.
pub fn part_file(directory: &Path) -> PathBuf {
    directory.join(format!(".{}.part", uuid::Uuid::new_v4()))
}

/// A response body being received: from reqwest, or streamed by the fingerprint helper.
pub enum Body {
    Reqwest(reqwest::Response),
    Helper(crate::net::fingerprint::HelperStream),
}

/// Message of the error a helper stream reports when the helper connection dropped mid-body (the caller may fall
/// back to the other stack, like Swift's `helperOrFallback`).
pub const HELPER_LOST: &str = "fingerprint helper connection lost";

impl Body {
    pub fn content_length(&self) -> Option<u64> {
        match self {
            Body::Reqwest(r) => r.content_length(),
            Body::Helper(_) => None,
        }
    }

    async fn next(&mut self, idle: Duration) -> Result<Option<Vec<u8>>, MediaError> {
        match self {
            Body::Reqwest(response) => next_chunk(response, idle).await,
            Body::Helper(stream) => match tokio::time::timeout(idle, stream.next_chunk()).await {
                Ok(Ok(chunk)) => Ok(chunk),
                Ok(Err(e)) => Err(helper_stream_error(e)),
                Err(_) => Err(timed_out()),
            },
        }
    }
}

/// A helper stream failure as a media error; [`HELPER_LOST`] means "fall back to the other stack".
pub fn helper_stream_error(error: crate::net::fingerprint::Error) -> MediaError {
    use crate::net::fingerprint::Error;
    match error {
        Error::TooLarge => MediaError::TooLarge,
        Error::Unavailable => MediaError::Net(NetFailure::Other, HELPER_LOST.into()),
        Error::Failed(message) => match policy::helper_failure(&message) {
            policy::HelperOutcome::Fail(e) => e,
            policy::HelperOutcome::Fallback => MediaError::Net(NetFailure::Other, HELPER_LOST.into()),
        },
    }
}

pub fn is_helper_lost(error: &MediaError) -> bool {
    matches!(error, MediaError::Net(NetFailure::Other, m) if m == HELPER_LOST)
}

/// Streams `body` into a new `.part` file in `directory`, reporting the part file, the declared length (`total`)
/// and every flushed chunk to `progress`, so ranges can be served while it runs. The file is removed on any failure.
pub async fn stream_to_part(
    mut body: Body,
    directory: &Path,
    max: u64,
    idle: Duration,
    total: Option<u64>,
    content_type: &str,
    progress: &ActiveDownload,
) -> Result<PathBuf, MediaError> {
    let total = total.or(body.content_length());
    if total.is_some_and(|n| n > max) {
        return Err(MediaError::TooLarge);
    }
    tokio::fs::create_dir_all(directory).await?;
    let temp = part_file(directory);
    let result = async {
        let mut file = tokio::fs::File::create(&temp).await?;
        cache::set_file_content_type(&temp, Some(content_type));
        progress.begin(temp.clone(), total, Some(content_type.to_owned()));
        let mut received: u64 = 0;
        while let Some(chunk) = body.next(idle).await? {
            received += chunk.len() as u64;
            if received > max {
                return Err(MediaError::TooLarge);
            }
            file.write_all(&chunk).await?;
            file.flush().await?; // on disk before readers are told
            progress.progress(received);
        }
        if total.is_some_and(|t| t != received) {
            return Err(MediaError::Net(NetFailure::Other, format!("body ended after {received} of {total:?} bytes")));
        }
        file.sync_all().await?;
        Ok(())
    }
    .await;
    match result {
        Ok(()) => Ok(temp),
        Err(e) => {
            let _ = tokio::fs::remove_file(&temp).await;
            Err(e)
        }
    }
}

/// Writes an already-buffered body (a helper response it did not stream) to a `.part` file.
pub async fn write_part(directory: &Path, body: &[u8], content_type: &str, progress: &ActiveDownload) -> Result<PathBuf, MediaError> {
    tokio::fs::create_dir_all(directory).await?;
    let temp = part_file(directory);
    if let Err(e) = tokio::fs::write(&temp, body).await {
        let _ = tokio::fs::remove_file(&temp).await;
        return Err(e.into());
    }
    cache::set_file_content_type(&temp, Some(content_type));
    progress.begin(temp.clone(), Some(body.len() as u64), Some(content_type.to_owned()));
    progress.progress(body.len() as u64);
    Ok(temp)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    /// A one-shot local HTTP server answering every connection with `response` (written in `pieces`, with a
    /// pause between them). Nothing leaves the machine.
    pub(crate) async fn serve_raw(pieces: Vec<Vec<u8>>, pause: Duration) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let pieces = pieces.clone();
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let _ = socket.read(&mut buf).await;
                    for piece in pieces {
                        if socket.write_all(&piece).await.is_err() {
                            return;
                        }
                        let _ = socket.flush().await;
                        tokio::time::sleep(pause).await;
                    }
                });
            }
        });
        format!("http://{addr}/clip.mp4")
    }

    async fn get(url: &str) -> Body {
        Body::Reqwest(reqwest::Client::new().get(url).send().await.unwrap())
    }

    #[tokio::test]
    async fn streams_into_a_part_file_with_progress() {
        let dir = std::env::temp_dir().join(format!("compola-http-{}", uuid::Uuid::new_v4()));
        let url = serve_raw(vec![b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\nhello ".to_vec(), b"world".to_vec()], Duration::from_millis(20)).await;
        let progress = ActiveDownload::default();
        let part = stream_to_part(get(&url).await, &dir, 100, Duration::from_secs(5), None, "video/mp4", &progress).await.unwrap();
        assert_eq!(std::fs::read(&part).unwrap(), b"hello world");
        let s = progress.snapshot();
        assert_eq!((s.part.as_deref(), s.received, s.total), (Some(part.as_path()), 11, Some(11)));
        assert_eq!(cache::file_content_type(&part), "video/mp4");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn short_too_large_and_stalled_bodies_leave_no_file() {
        let dir = std::env::temp_dir().join(format!("compola-http-{}", uuid::Uuid::new_v4()));
        let progress = ActiveDownload::default();
        let short = serve_raw(vec![b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc".to_vec()], Duration::ZERO).await;
        assert!(stream_to_part(get(&short).await, &dir, 100, Duration::from_secs(5), None, "x/y", &progress).await.is_err());
        let big = serve_raw(vec![b"HTTP/1.1 200 OK\r\nContent-Length: 101\r\n\r\n".to_vec()], Duration::ZERO).await;
        assert_eq!(stream_to_part(get(&big).await, &dir, 100, Duration::from_secs(5), None, "x/y", &progress).await, Err(MediaError::TooLarge));
        let mut chunked = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec();
        for _ in 0..2 {
            chunked.extend_from_slice(b"3c\r\n");
            chunked.extend_from_slice(&[b'x'; 60]);
            chunked.extend_from_slice(b"\r\n");
        }
        chunked.extend_from_slice(b"0\r\n\r\n");
        let unsized_big = serve_raw(vec![chunked], Duration::ZERO).await;
        assert_eq!(stream_to_part(get(&unsized_big).await, &dir, 100, Duration::from_secs(5), None, "x/y", &progress).await, Err(MediaError::TooLarge));
        let stall = serve_raw(vec![b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nab".to_vec(), Vec::new()], Duration::from_secs(5)).await;
        assert!(matches!(
            stream_to_part(get(&stall).await, &dir, 100, Duration::from_millis(100), None, "x/y", &progress).await,
            Err(MediaError::Net(NetFailure::Timeout, _))
        ));
        let leftovers = std::fs::read_dir(&dir).map(|d| d.count()).unwrap_or(0);
        assert_eq!(leftovers, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn helper_stream_errors() {
        use crate::net::fingerprint::Error;
        assert_eq!(helper_stream_error(Error::TooLarge), MediaError::TooLarge);
        assert!(is_helper_lost(&helper_stream_error(Error::Unavailable)));
        assert!(is_helper_lost(&helper_stream_error(Error::Failed("read: connection reset by peer".into()))));
        assert_eq!(helper_stream_error(Error::Failed("context deadline exceeded".into())), MediaError::TimedOut);
        assert!(!is_helper_lost(&helper_stream_error(Error::Failed("tls: bad certificate".into()))));
    }
}
