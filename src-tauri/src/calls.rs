//! Voice / video calls: main's "zcall-v2" module relaying to VNG's `ZaloCall` helper (port of `CallBridge.swift`).
//! TODO(port).

use tauri::AppHandle;

use crate::bridge::Registry;

pub fn install(_app: &AppHandle, reg: &mut Registry) {
    reg.handle("call-send-to-native", |_, _| async { Ok(crate::values::undef()) });
    reg.handle("call-init", |_, _| async { Ok(crate::values::undef()) });
}
