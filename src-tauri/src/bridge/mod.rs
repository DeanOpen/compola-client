//! Rust implementation of the Electron preload bridge (`$zelectron`, `$znode`, `$zlogin`, …) that the official
//! renderer calls — port of `ZaloBridge.swift`. See `host-scripts/bridge.js` and the Swift repo's
//! `reanalysis/bridge-spec.md` for member semantics.
//!
//! Two kinds of members:
//! - **path-keyed** members implemented directly in the official preload (`$znode.fs.readFile`, …): registered with
//!   [`Registry::value`], [`Registry::sync`], [`Registry::async_`], …
//! - **table-driven** members that the preload maps to an Electron IPC channel (`bridge-table.json`): answered by
//!   channel handlers ([`Registry::handle`], [`Registry::handle_sync`]) — Rust plays Electron's main process.
//!
//! Handlers receive the calling [`Host`] (one per webview: main window, hidden shared-worker window) so they can
//! answer or push events to that window.

pub mod crypto;
pub mod file_manager;
pub mod fs;
pub mod implementation;

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::{Map, Value, json};

use crate::host::Host;
use crate::values::{Args, undef};

pub type BridgeResult = Result<Value, String>;
pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;
pub type AsyncHandler = Arc<dyn Fn(Arc<Host>, Args) -> BoxFuture<BridgeResult> + Send + Sync>;
pub type SyncHandler = Arc<dyn Fn(&Arc<Host>, Args) -> BridgeResult + Send + Sync>;

/// Node-style error text `"CODE: detail"`; bridge.js turns the prefix into `err.code`.
pub fn node_error(code: &str, detail: impl std::fmt::Display) -> String {
    format!("{code}: {detail}")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Async,
    Sync,
    Event,
    Off,
    Noop,
    NoopAsync,
    Value,
}

impl Mode {
    fn as_str(self) -> &'static str {
        match self {
            Mode::Async => "async",
            Mode::Sync => "sync",
            Mode::Event => "event",
            Mode::Off => "off",
            Mode::Noop => "noop",
            Mode::NoopAsync => "noop-async",
            Mode::Value => "value",
        }
    }
}

/// Every member and channel handler. Built once at boot, then shared (read-only) by all hosts.
#[derive(Default)]
pub struct Registry {
    globals: BTreeSet<String>,
    modes: BTreeMap<String, Mode>,
    values: BTreeMap<String, Value>,
    async_handlers: HashMap<String, AsyncHandler>,
    sync_handlers: HashMap<String, SyncHandler>,
    /// Preload member → {channel, type}, generated from the official preload.
    ipc_table: BTreeMap<String, Value>,
    channel_handlers: HashMap<String, AsyncHandler>,
    channel_sync_handlers: HashMap<String, SyncHandler>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    // ---- path-keyed members ----

    pub fn declare_global(&mut self, name: &str) {
        self.globals.insert(name.to_owned());
    }

    pub fn value(&mut self, path: &str, value: Value) {
        self.register(path, Mode::Value);
        self.values.insert(path.to_owned(), value);
    }

    pub fn async_<F, Fut>(&mut self, path: &str, handler: F)
    where
        F: Fn(Arc<Host>, Args) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = BridgeResult> + Send + 'static,
    {
        self.register(path, Mode::Async);
        self.async_handlers.insert(path.to_owned(), Arc::new(move |h, a| Box::pin(handler(h, a))));
    }

    pub fn sync<F>(&mut self, path: &str, handler: F)
    where
        F: Fn(&Arc<Host>, Args) -> BridgeResult + Send + Sync + 'static,
    {
        self.register(path, Mode::Sync);
        self.sync_handlers.insert(path.to_owned(), Arc::new(handler));
    }

    pub fn event(&mut self, path: &str) {
        self.register(path, Mode::Event);
    }
    pub fn off(&mut self, path: &str) {
        self.register(path, Mode::Off);
    }
    pub fn noop(&mut self, paths: &[&str]) {
        for p in paths {
            self.register(p, Mode::Noop);
        }
    }
    pub fn noop_async(&mut self, paths: &[&str]) {
        for p in paths {
            self.register(p, Mode::NoopAsync);
        }
    }

    fn register(&mut self, path: &str, mode: Mode) {
        self.modes.insert(path.to_owned(), mode);
        if let Some(global) = path.split('.').next() {
            self.globals.insert(global.to_owned());
        }
    }

    // ---- IPC channels ----

    pub fn load_ipc_table(&mut self, table: &Map<String, Value>) {
        for (path, entry) in table {
            let (Some(channel), Some(kind)) = (entry.get("channel").and_then(Value::as_str), entry.get("type").and_then(Value::as_str)) else {
                continue; // a few entries have no channel in the official preload itself
            };
            self.ipc_table.insert(path.clone(), json!({ "channel": channel, "type": kind }));
            if let Some(global) = path.split('.').next() {
                self.globals.insert(global.to_owned());
            }
        }
    }

    /// `ipcMain.handle(channel)` — answers REQUEST/NOTIFY (invoke), and REQUEST_SYNC when no sync handler exists.
    pub fn handle<F, Fut>(&mut self, channel: &str, handler: F)
    where
        F: Fn(Arc<Host>, Args) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = BridgeResult> + Send + 'static,
    {
        self.channel_handlers.insert(channel.to_owned(), Arc::new(move |h, a| Box::pin(handler(h, a))));
    }

    pub fn handle_sync<F>(&mut self, channel: &str, handler: F)
    where
        F: Fn(&Arc<Host>, Args) -> BridgeResult + Send + Sync + 'static,
    {
        self.channel_sync_handlers.insert(channel.to_owned(), Arc::new(handler));
    }

    /// Channels that are fine to acknowledge with `undefined` (telemetry, window chrome…).
    pub fn acknowledge(&mut self, channels: &[&str]) {
        for c in channels {
            if !self.channel_handlers.contains_key(*c) && !self.channel_sync_handlers.contains_key(*c) {
                self.channel_sync_handlers.insert((*c).to_owned(), Arc::new(|_, _| Ok(undef())));
            }
        }
    }

    /// `window.__zaloBridgeSpec`, injected before `bridge.js`.
    pub fn spec_script(&self) -> String {
        let members: BTreeMap<&String, &str> = self.modes.iter().map(|(k, m)| (k, m.as_str())).collect();
        let spec = json!({
            "globals": self.globals,
            "members": members,
            "values": self.values,
            "ipc": self.ipc_table,
        });
        format!("window.__zaloBridgeSpec = {};", serde_json::to_string(&spec).unwrap_or_else(|_| "{}".into()))
    }

    pub(crate) fn async_handler(&self, path: &str) -> Option<AsyncHandler> {
        self.async_handlers.get(path).cloned()
    }
    pub(crate) fn sync_handler(&self, path: &str) -> Option<SyncHandler> {
        self.sync_handlers.get(path).cloned()
    }
    pub(crate) fn channel_handler(&self, channel: &str) -> Option<AsyncHandler> {
        self.channel_handlers.get(channel).cloned()
    }
    pub(crate) fn channel_sync_handler(&self, channel: &str) -> Option<SyncHandler> {
        self.channel_sync_handlers.get(channel).cloned()
    }
}

/// Wraps a sync closure result: `None` → `undefined`.
pub fn opt<T: Into<Value>>(value: Option<T>) -> Value {
    value.map(Into::into).unwrap_or_else(undef)
}
