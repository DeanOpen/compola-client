//! Main's download manager (`new-download-channel`, port of `DownloadManager.swift`). TODO(port).

use std::sync::Arc;

use tauri::AppHandle;

use crate::bridge::Registry;
use crate::platform::Platform;

pub fn install(_app: &AppHandle, _reg: &mut Registry, _platform: &Arc<Platform>) {}
