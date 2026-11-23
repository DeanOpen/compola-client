//! `_noti_*` (Electron Notification, `$znoti`) → native notifications (port of `NativeNotifier.swift`). TODO(port).

use tauri::AppHandle;

use crate::bridge::Registry;

pub fn install(_app: &AppHandle, _reg: &mut Registry) {}
