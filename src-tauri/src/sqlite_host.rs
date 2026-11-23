//! Native SQLite behind the official data access layer (port of `SQLiteHost.swift`; JS side `sqlite-host.js`).
//! TODO(port): full port.

use std::path::PathBuf;
use std::sync::Arc;

use crate::bridge::Registry;

pub struct SqliteHost {
    pub root: PathBuf,
}

impl SqliteHost {
    pub fn new(root: PathBuf) -> Arc<Self> {
        let _ = std::fs::create_dir_all(&root);
        Arc::new(Self { root })
    }

    pub fn install(self: &Arc<Self>, _reg: &mut Registry) {}

    pub fn close_all(&self) {}
}
