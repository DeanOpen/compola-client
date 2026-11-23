//! Port of main's `sharedWorkerManager` (`main-dist/main.js`, module `poPE`; Swift `SharedWorkerRouter`).
//!
//! Zalo PC runs heavy background tasks (cloud message scan, offline sync, preview updates…) in a hidden *shared
//! worker* window (`shared-worker.html`). Windows register handlers for task types (`$zsharedWorker.register(type)`);
//! `$zsharedWorker.runTask(task)` is routed to the window that registered `task.type`, and the result/progress is
//! routed back to the requesting window.

use std::collections::HashMap;
use std::sync::{Arc, Weak};
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{Value, json};
use tauri::AppHandle;

use crate::bridge::Registry;
use crate::host::Host;
use crate::values::{ArgsExt, undef};

struct Pending {
    requester: Weak<Host>,
    request_id: Value,
    kind: String,
    handler_id: u64,
}

#[derive(Default)]
struct Inner {
    sender_ids: HashMap<String, (Weak<Host>, u64)>,
    next_sender_id: u64,
    handlers: HashMap<String, Weak<Host>>,
    pending: HashMap<String, Pending>,
    last_remote_config: Option<Value>,
    worker: Option<Weak<Host>>,
}

#[derive(Default)]
pub struct SharedWorkerRouter(Mutex<Inner>);

fn key_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "<null>".into(),
        other => other.to_string(),
    }
}

fn same(a: &Weak<Host>, b: &Arc<Host>) -> bool {
    a.upgrade().is_some_and(|h| Arc::ptr_eq(&h, b))
}

impl Inner {
    fn sender_id(&mut self, host: &Arc<Host>) -> u64 {
        self.sender_ids.retain(|_, (w, _)| w.upgrade().is_some());
        if let Some((w, id)) = self.sender_ids.get(&host.label) {
            if same(w, host) {
                return *id;
            }
        }
        self.next_sender_id += 1;
        let id = self.next_sender_id;
        self.sender_ids.insert(host.label.clone(), (Arc::downgrade(host), id));
        id
    }
}

fn respond(entry: &Pending, result: Option<Value>, error: Option<Value>) {
    let mut m = serde_json::Map::new();
    m.insert("id".into(), entry.request_id.clone());
    if let Some(r) = result {
        m.insert("result".into(), r);
    }
    if let Some(e) = error {
        m.insert("error".into(), e);
    }
    if let Some(h) = entry.requester.upgrade() {
        h.send("shared-worker-resp", vec![Value::Object(m)]);
    }
}

fn interrupted() -> Value {
    json!({ "name": "WorkerInterrupted", "message": "Worker is interrupted" })
}

impl SharedWorkerRouter {
    /// Drops everything that belonged to the worker window (it is being replaced or closed).
    pub fn reset_worker(&self, worker: &Arc<Host>) {
        let mut doomed = Vec::new();
        {
            let mut st = self.0.lock();
            if st.worker.as_ref().is_some_and(|w| same(w, worker)) {
                st.worker = None;
            }
            st.handlers.retain(|_, w| w.upgrade().is_some() && !same(w, worker));
            st.pending.retain(|_, p| p.requester.upgrade().is_some());
            let id = st.sender_id(worker);
            let keys: Vec<String> = st.pending.iter().filter(|(_, p)| p.handler_id == id).map(|(k, _)| k.clone()).collect();
            for k in keys {
                if let Some(p) = st.pending.remove(&k) {
                    doomed.push(p);
                }
            }
        }
        for p in doomed {
            respond(&p, None, Some(interrupted()));
        }
    }

    pub fn register_worker(&self, worker: &Arc<Host>) {
        let mut st = self.0.lock();
        st.worker = Some(Arc::downgrade(worker));
        st.handlers.retain(|_, w| !same(w, worker));
    }

    /// Forgets per-account state (logout).
    pub fn reset_session(&self) {
        let mut st = self.0.lock();
        st.last_remote_config = None;
        st.pending.clear();
    }

    /// Re-sends the last remote config when the worker page (re)loads (`handleRecoverRemoteConfig`).
    pub fn worker_did_finish_load(&self) {
        let (cfg, worker) = {
            let st = self.0.lock();
            (st.last_remote_config.clone(), st.worker.as_ref().and_then(Weak::upgrade))
        };
        if let (Some(cfg), Some(w)) = (cfg, worker) {
            w.send("shared-worker-remote-config-change", vec![cfg]);
        }
    }
}

/// Installs the router channels of one account (`r` is that account's router).
pub fn install(_app: &AppHandle, reg: &mut Registry, r: Arc<SharedWorkerRouter>) {
    for ch in ["show-shared-worker", "hide-shared-worker", "shared-worker-ping", "shared-worker-dispose"] {
        reg.handle(ch, |_, _| async { Ok(undef()) });
    }

    let rr = r.clone();
    reg.handle("shared-worker-handle", move |host, a| {
        if let Some(kind) = a.string_at(0) {
            let mut st = rr.0.lock();
            st.handlers.insert(kind.clone(), Arc::downgrade(&host));
            let id = st.sender_id(&host);
            log::debug!("sw-router register {kind} from #{id}");
        }
        async { Ok(undef()) }
    });

    let rr = r.clone();
    reg.handle("shared-worker-start", move |host, _| {
        let rr = rr.clone();
        async move {
            // `onStartup`: work still pending on *another* window than the one that just (re)started is interrupted.
            let (sender, before) = {
                let mut st = rr.0.lock();
                (st.sender_id(&host), st.pending.keys().cloned().collect::<Vec<_>>())
            };
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(100)).await;
                let mut doomed = Vec::new();
                {
                    let mut st = rr.0.lock();
                    for k in before {
                        if st.pending.get(&k).is_some_and(|p| p.handler_id != sender) {
                            doomed.extend(st.pending.remove(&k));
                        }
                    }
                }
                for p in doomed {
                    respond(&p, None, Some(interrupted()));
                }
            });
            Ok(undef())
        }
    });

    let rr = r.clone();
    reg.handle("shared-worker-run", move |host, a| {
        let rr = rr.clone();
        async move {
            let Some(task) = a.obj_at(0).cloned() else { return Ok(undef()) };
            let request_id = task.get("id").cloned().unwrap_or(Value::Null);
            let kind = task.get("type").and_then(Value::as_str).unwrap_or("").to_owned();
            let reply_err = |msg: &str| host.send("shared-worker-resp", vec![json!({ "id": request_id, "error": msg })]);
            let routed = {
                let mut st = rr.0.lock();
                if st.worker.as_ref().and_then(Weak::upgrade).is_none() {
                    drop(st);
                    reply_err("Worker is not ready");
                    return Ok(undef());
                }
                let Some(handler) = st.handlers.get(&kind).and_then(Weak::upgrade) else {
                    drop(st);
                    log::debug!("sw-router run {kind} -> unsupported (no handler)");
                    reply_err("Task type is not supported");
                    return Ok(undef());
                };
                let sender = st.sender_id(&host);
                let handler_id = st.sender_id(&handler);
                let key = format!("{sender}_{}", key_of(&request_id));
                st.pending.insert(key.clone(), Pending { requester: Arc::downgrade(&host), request_id: request_id.clone(), kind: kind.clone(), handler_id });
                let mut routed = task.clone();
                routed.insert("id".into(), json!(key));
                (handler, routed)
            };
            routed.0.send("shared-worker-run", vec![Value::Object(routed.1)]);
            Ok(undef())
        }
    });

    let rr = r.clone();
    reg.handle("shared-worker-resp", move |_, a| {
        if let Some(msg) = a.obj_at(0) {
            let key = msg.get("id").map(key_of);
            let entry = key.and_then(|k| rr.0.lock().pending.remove(&k));
            if let Some(entry) = entry {
                respond(&entry, msg.get("result").cloned(), msg.get("error").cloned());
            }
        }
        async { Ok(undef()) }
    });

    let rr = r.clone();
    reg.handle("shared-worker-progress", move |_, a| {
        if let Some(msg) = a.obj_at(0) {
            let key = msg.get("id").map(key_of).unwrap_or_default();
            let target = rr.0.lock().pending.get(&key).map(|p| (p.requester.clone(), p.request_id.clone(), p.kind.clone()));
            if let Some((req, id, kind)) = target {
                let mut fwd = json!({ "id": id, "type": kind });
                if let Some(p) = msg.get("progress") {
                    fwd["progress"] = p.clone();
                }
                if let Some(c) = msg.get("checkpoint") {
                    fwd["checkpoint"] = c.clone();
                }
                if let Some(h) = req.upgrade() {
                    h.send("shared-worker-progress", vec![fwd]);
                }
            }
        }
        async { Ok(undef()) }
    });

    let rr = r.clone();
    reg.handle("shared-worker-abort", move |host, a| {
        if let Some(msg) = a.obj_at(0) {
            let (entry, handler, key) = {
                let mut st = rr.0.lock();
                let key = format!("{}_{}", st.sender_id(&host), key_of(msg.get("id").unwrap_or(&Value::Null)));
                let entry = st.pending.remove(&key);
                let handler = msg.get("type").and_then(Value::as_str).and_then(|t| st.handlers.get(t)).and_then(Weak::upgrade);
                (entry, handler, key)
            };
            if let Some(e) = entry {
                respond(&e, None, Some(json!("Aborted")));
            }
            if let Some(h) = handler {
                h.send("shared-worker-abort", vec![json!({ "id": key })]);
            }
        }
        async { Ok(undef()) }
    });

    let rr = r.clone();
    reg.handle("shared-worker-update-params", move |host, a| {
        if let Some(msg) = a.obj_at(0) {
            if let Some(kind) = msg.get("type").and_then(Value::as_str) {
                let (handler, key) = {
                    let mut st = rr.0.lock();
                    let key = format!("{}_{}", st.sender_id(&host), key_of(msg.get("id").unwrap_or(&Value::Null)));
                    (st.handlers.get(kind).and_then(Weak::upgrade), key)
                };
                if let Some(h) = handler {
                    h.send("shared-worker-update-params", vec![json!({ "id": key, "type": kind, "params": msg.get("params").cloned().unwrap_or(Value::Null) })]);
                }
            }
        }
        async { Ok(undef()) }
    });

    let rr = r;
    reg.handle("shared-worker-remote-config-change", move |_, a| {
        // Renderer sends `{config}`; main stores/forwards the inner `config`.
        let config = a.obj_at(0).and_then(|o| o.get("config").cloned()).or_else(|| a.first().cloned());
        if let Some(cfg) = config {
            let worker = {
                let mut st = rr.0.lock();
                st.last_remote_config = Some(cfg.clone());
                st.worker.as_ref().and_then(Weak::upgrade)
            };
            if let Some(w) = worker {
                w.send("shared-worker-remote-config-change", vec![cfg]);
            }
        }
        async { Ok(undef()) }
    });
}
