//! A file download in progress, observable while it runs: which `.part` file holds the body, how many bytes have
//! arrived, the expected total, and finally the published file (or the error). The `compola-media` scheme serves
//! `Range` requests for a video out of the `.part` file as soon as the requested bytes are on disk.

use std::path::PathBuf;

use tokio::sync::watch;

use super::MediaError;

#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    /// The `.part` file of the current attempt (a redirect or DNS fallback starts a new one from zero).
    pub part: Option<PathBuf>,
    /// Bytes of the current attempt written and flushed to `part`.
    pub received: u64,
    /// Content-Length of the current attempt, if the server sent one.
    pub total: Option<u64>,
    pub content_type: Option<String>,
    /// The published file, or why the download failed.
    pub finished: Option<Result<PathBuf, MediaError>>,
}

pub struct ActiveDownload {
    tx: watch::Sender<Snapshot>,
}

impl Default for ActiveDownload {
    fn default() -> Self {
        Self { tx: watch::channel(Snapshot::default()).0 }
    }
}

impl ActiveDownload {
    pub fn subscribe(&self) -> watch::Receiver<Snapshot> {
        self.tx.subscribe()
    }

    pub fn snapshot(&self) -> Snapshot {
        self.tx.borrow().clone()
    }

    /// A new attempt wrote its first (empty) part file.
    pub fn begin(&self, part: PathBuf, total: Option<u64>, content_type: Option<String>) {
        self.tx.send_modify(|s| {
            s.part = Some(part);
            s.received = 0;
            s.total = total;
            s.content_type = content_type;
        });
    }

    pub fn progress(&self, received: u64) {
        self.tx.send_modify(|s| s.received = received);
    }

    /// First call wins.
    pub fn finish(&self, result: Result<PathBuf, MediaError>) {
        self.tx.send_if_modified(|s| {
            if s.finished.is_some() {
                return false;
            }
            s.finished = Some(result);
            true
        });
    }

    /// Waits until `condition` holds (or the download finished) and returns that state.
    pub async fn wait(&self, condition: impl Fn(&Snapshot) -> bool) -> Snapshot {
        let mut rx = self.subscribe();
        // The sender lives in `self`, so the channel cannot close while we wait.
        match rx.wait_for(|s| s.finished.is_some() || condition(s)).await {
            Ok(s) => s.clone(),
            Err(_) => self.snapshot(),
        }
    }

    pub async fn finished(&self) -> Result<PathBuf, MediaError> {
        self.wait(|_| false).await.finished.unwrap_or(Err(MediaError::Cancelled))
    }
}

/// Finishes the download with `Cancelled` if its task ends without reporting (panic, abort).
pub struct FinishGuard(pub std::sync::Arc<ActiveDownload>);

impl Drop for FinishGuard {
    fn drop(&mut self) {
        self.0.finish(Err(MediaError::Cancelled));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;

    #[tokio::test]
    async fn readers_see_progress_and_the_end() {
        let dl = Arc::new(ActiveDownload::default());
        let reader = {
            let dl = dl.clone();
            tokio::spawn(async move { dl.wait(|s| s.received > 10).await })
        };
        dl.begin(PathBuf::from("/x/.a.part"), Some(100), None);
        dl.progress(5);
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(!reader.is_finished());
        dl.progress(11);
        let s = reader.await.unwrap();
        assert_eq!((s.received, s.total), (11, Some(100)));
        dl.finish(Ok(PathBuf::from("/x/a")));
        dl.finish(Err(MediaError::TimedOut)); // ignored
        assert_eq!(dl.finished().await, Ok(PathBuf::from("/x/a")));
    }

    #[tokio::test]
    async fn guard_reports_an_abandoned_download() {
        let dl = Arc::new(ActiveDownload::default());
        drop(FinishGuard(dl.clone()));
        assert_eq!(dl.finished().await, Err(MediaError::Cancelled));
    }
}
