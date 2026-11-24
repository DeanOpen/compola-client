//! Automatic updates from GitHub Releases (`tauri-plugin-updater`).
//!
//! The release workflow publishes signed update bundles and `latest.json` (endpoint in `tauri.conf.json` ›
//! `plugins.updater`); signatures are checked against the public key there. Compola checks shortly after launch and
//! then every few hours; when a newer version exists it asks once per version per run, then downloads, installs and
//! restarts. Debug builds never check (set `COMPOLA_UPDATER_DEBUG=1` to try it), and `COMPOLA_DISABLE_UPDATER=1`
//! turns it off.

use std::collections::HashSet;
use std::time::Duration;

use parking_lot::Mutex;
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

const FIRST_CHECK: Duration = Duration::from_secs(20);
const INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

fn enabled() -> bool {
    let flag = |name: &str| std::env::var(name).is_ok_and(|v| !v.is_empty() && v != "0");
    if flag("COMPOLA_DISABLE_UPDATER") {
        return false;
    }
    !cfg!(debug_assertions) || flag("COMPOLA_UPDATER_DEBUG")
}

/// Starts the background check loop (once, from `setup`).
pub fn start(app: &AppHandle) {
    if !enabled() {
        log::info!("updater: off");
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let declined = Mutex::new(HashSet::<String>::new());
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            check_once(&app, &declined).await;
            tokio::time::sleep(INTERVAL).await;
        }
    });
}

async fn check_once(app: &AppHandle, declined: &Mutex<HashSet<String>>) {
    let update = match app.updater().map_err(|e| e.to_string()) {
        Ok(updater) => updater.check().await.map_err(|e| e.to_string()),
        Err(e) => Err(e),
    };
    let update = match update {
        Ok(Some(update)) => update,
        Ok(None) => {
            log::info!("updater: up to date ({})", app.package_info().version);
            return;
        }
        Err(e) => {
            log::warn!("updater: check failed: {e}");
            return;
        }
    };
    if declined.lock().contains(&update.version) {
        return;
    }
    log::info!("updater: {} available (running {})", update.version, update.current_version);

    let notes = update.body.as_deref().map(str::trim).filter(|n| !n.is_empty()).map(|n| {
        let short: String = n.chars().take(600).collect();
        if short.len() < n.len() { format!("\n\n{short}…") } else { format!("\n\n{short}") }
    });
    let message = format!(
        "Compola {} đã có (bạn đang dùng {}).{}\n\nCập nhật và khởi động lại Compola ngay?",
        update.version,
        update.current_version,
        notes.unwrap_or_default()
    );
    if !ask(app, "Có bản cập nhật Compola", message, MessageDialogKind::Info, Some(("Cập nhật", "Để sau"))).await {
        declined.lock().insert(update.version.clone());
        return;
    }

    let mut received = 0usize;
    let result = update
        .download_and_install(
            |chunk, total| {
                received += chunk;
                log::debug!("updater: {received}/{total:?} bytes");
            },
            || log::info!("updater: downloaded, installing"),
        )
        .await;
    match result {
        Ok(()) => {
            log::info!("updater: installed {}, restarting", update.version);
            app.restart();
        }
        Err(e) => {
            log::error!("updater: install failed: {e}");
            let text = format!("Không cài được bản cập nhật Compola {}.\n\n{e}", update.version);
            ask(app, "Cập nhật không thành công", text, MessageDialogKind::Error, None).await;
        }
    }
}

/// A native dialog; `buttons` = (confirm, cancel) labels, or a single OK. True when confirmed.
async fn ask(app: &AppHandle, title: &str, message: String, kind: MessageDialogKind, buttons: Option<(&str, &str)>) -> bool {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let buttons = match buttons {
        Some((ok, cancel)) => MessageDialogButtons::OkCancelCustom(ok.into(), cancel.into()),
        None => MessageDialogButtons::Ok,
    };
    app.dialog().message(message).title(title).kind(kind).buttons(buttons).show(move |ok| {
        let _ = tx.send(ok);
    });
    rx.await.unwrap_or(false)
}
