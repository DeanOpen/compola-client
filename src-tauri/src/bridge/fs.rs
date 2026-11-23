//! `$znode.fs.*` — Node's `fs` for the renderer (port of `FileSystemBridge.swift`). TODO(port): full port.

use std::sync::Arc;

use super::Registry;
use crate::platform::Platform;

pub fn install(_reg: &mut Registry, _platform: &Arc<Platform>) {}
