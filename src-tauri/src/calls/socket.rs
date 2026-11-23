//! Minimal `net.createServer().listen(path)` for a UNIX-domain stream socket — port of `UnixSocketServer.swift`.
//!
//! Each connection gets a reader and a writer task on the async runtime. Events for one connection are delivered in
//! order (connect, data…, end) on the reader's task; the callback is never invoked with the server's lock held.
//! Writes are queued and never block the caller.

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use tauri::async_runtime::JoinHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

/// `sockaddr_un.sun_path` holds 104 bytes on macOS, including the terminator.
pub const MAX_PATH_LENGTH: usize = 103;

#[derive(Debug)]
pub enum ServerEvent {
    Connect(u64),
    Data(u64, Vec<u8>),
    End(u64),
}

pub type Callback = Arc<dyn Fn(ServerEvent) + Send + Sync>;

struct Conn {
    writer: mpsc::UnboundedSender<Vec<u8>>,
    tasks: Vec<JoinHandle<()>>,
}

struct Inner {
    conns: Mutex<HashMap<u64, Conn>>,
    next_id: AtomicU64,
    callback: Callback,
}

impl Inner {
    /// Removes connection `id` (aborting its tasks, which closes the descriptor); `notify` reports `End` once.
    fn close(&self, id: u64, notify: bool) {
        let removed = self.conns.lock().remove(&id);
        let Some(conn) = removed else { return };
        for t in conn.tasks {
            t.abort();
        }
        if notify {
            (self.callback)(ServerEvent::End(id));
        }
    }
}

pub struct UnixSocketServer {
    pub path: String,
    inner: Arc<Inner>,
    accept: Mutex<Option<JoinHandle<()>>>,
    listening: AtomicBool,
}

impl UnixSocketServer {
    pub fn new(path: &str, callback: Callback) -> Self {
        Self {
            path: path.to_owned(),
            inner: Arc::new(Inner { conns: Mutex::new(HashMap::new()), next_id: AtomicU64::new(1), callback }),
            accept: Mutex::new(None),
            listening: AtomicBool::new(false),
        }
    }

    pub fn start(&self) -> Result<(), String> {
        if self.listening.load(Ordering::SeqCst) {
            return Ok(());
        }
        if self.path.len() > MAX_PATH_LENGTH {
            return Err("socket path too long".into());
        }
        let _ = std::fs::remove_file(&self.path);
        let listener = std::os::unix::net::UnixListener::bind(&self.path).map_err(|e| format!("bind(): {e}"))?;
        let _ = std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600));
        listener.set_nonblocking(true).map_err(|e| format!("listen(): {e}"))?;
        self.listening.store(true, Ordering::SeqCst);
        let inner = self.inner.clone();
        let task = tauri::async_runtime::spawn(async move {
            let Ok(listener) = tokio::net::UnixListener::from_std(listener) else { return };
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                };
                accept_one(&inner, stream);
            }
        });
        *self.accept.lock() = Some(task);
        Ok(())
    }

    /// Sends `data` to connection `id` (dropped when it is gone).
    pub fn write(&self, data: Vec<u8>, id: u64) {
        if let Some(c) = self.inner.conns.lock().get(&id) {
            let _ = c.writer.send(data);
        }
    }

    pub fn disconnect_all(&self) {
        let ids: Vec<u64> = self.inner.conns.lock().keys().copied().collect();
        for id in ids {
            self.inner.close(id, false);
        }
    }

    pub fn stop(&self) {
        self.disconnect_all();
        if let Some(t) = self.accept.lock().take() {
            t.abort();
        }
        if self.listening.swap(false, Ordering::SeqCst) {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

impl Drop for UnixSocketServer {
    fn drop(&mut self) {
        self.stop();
    }
}

fn accept_one(inner: &Arc<Inner>, stream: tokio::net::UnixStream) {
    let id = inner.next_id.fetch_add(1, Ordering::Relaxed);
    let (mut read_half, mut write_half) = stream.into_split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let writer_inner = Arc::downgrade(inner);
    let writer = tauri::async_runtime::spawn(async move {
        while let Some(data) = rx.recv().await {
            // Waits (up to ~3 s without progress) when the peer's buffer is full.
            let ok = matches!(tokio::time::timeout(Duration::from_secs(3), write_half.write_all(&data)).await, Ok(Ok(())));
            if !ok {
                if let Some(inner) = writer_inner.upgrade() {
                    inner.close(id, true);
                }
                return;
            }
        }
    });
    inner.conns.lock().insert(id, Conn { writer: tx, tasks: vec![writer] });
    (inner.callback)(ServerEvent::Connect(id));
    let reader_inner = Arc::downgrade(inner);
    let reader = tauri::async_runtime::spawn(async move {
        let mut buf = vec![0u8; 65_536];
        loop {
            let n = read_half.read(&mut buf).await;
            let Some(inner) = reader_inner.upgrade() else { return };
            match n {
                Ok(n) if n > 0 => {
                    // A connection closed meanwhile (reset) reports nothing more.
                    if !inner.conns.lock().contains_key(&id) {
                        return;
                    }
                    (inner.callback)(ServerEvent::Data(id, buf[..n].to_vec()));
                }
                _ => {
                    inner.close(id, true);
                    return;
                }
            }
        }
    });
    let mut conns = inner.conns.lock();
    match conns.get_mut(&id) {
        Some(c) => c.tasks.push(reader),
        None => reader.abort(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_path_limit() {
        let long = format!("/tmp/{}", "a".repeat(120));
        let server = UnixSocketServer::new(&long, Arc::new(|_| {}));
        assert!(server.start().is_err());
    }
}
