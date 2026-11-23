//! Body handling shared by the system and pinned (DoH) transports: a time-to-headers bound, a stall (idle) timeout
//! between body chunks, and byte caps — buffered for images, streamed to a `.part` file for files (deleted on any
//! failure, so a truncated download never looks complete).

use std::path::{Path, PathBuf};
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use tokio::io::AsyncWriteExt;

use super::{MediaError, NetFailure, policy};

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

/// Streams the body into a new `.part` file in `directory`; the file is removed on any failure.
pub async fn stream_to_part(mut response: reqwest::Response, directory: &Path, max: u64, idle: Duration) -> Result<PathBuf, MediaError> {
    if response.content_length().is_some_and(|n| n > max) {
        return Err(MediaError::TooLarge);
    }
    tokio::fs::create_dir_all(directory).await?;
    let temp = part_file(directory);
    let result = async {
        let mut file = tokio::fs::File::create(&temp).await?;
        let mut received: u64 = 0;
        while let Some(chunk) = next_chunk(&mut response, idle).await? {
            received += chunk.len() as u64;
            if received > max {
                return Err(MediaError::TooLarge);
            }
            file.write_all(&chunk).await?;
        }
        file.flush().await?;
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

/// Writes an already-buffered body (the fingerprint helper's) to a `.part` file.
pub async fn write_part(directory: &Path, body: &[u8]) -> Result<PathBuf, MediaError> {
    tokio::fs::create_dir_all(directory).await?;
    let temp = part_file(directory);
    if let Err(e) = tokio::fs::write(&temp, body).await {
        let _ = tokio::fs::remove_file(&temp).await;
        return Err(e.into());
    }
    Ok(temp)
}
