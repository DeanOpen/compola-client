//! Automatic updates from GitHub Releases (`tauri-plugin-updater`).
//!
//! The release workflow publishes signed update bundles and a `latest.json`; signatures are checked against the
//! public key in `tauri.conf.json` › `plugins.updater`. Two channels, chosen by the running version:
//! - stable (`0.1.4`): `releases/latest/download/latest.json` (the newest `v*` release);
//! - edge (`0.1.5-21`, built from every push to main): `releases/download/edge/latest.json`. Before this, edge builds
//!   had no manifest and were already "newer" than the stable release, so they never updated.
//!
//! Checks run in the core, signed in or not: 20 s after launch, then whenever an hour of wall-clock time has passed
//! (a timer that pauses while the computer sleeps would push the next check back by the length of every sleep).
//! A newer version is offered with a native dialog, at most once per version per run; Settings › Cập nhật shows the
//! state and checks / installs on demand (`updater_status`, `updater_check`, `updater_install`). Debug builds never
//! check (set `COMPOLA_UPDATER_DEBUG=1` to try it), and `COMPOLA_DISABLE_UPDATER=1` turns it off.

use std::collections::HashSet;
use std::time::{Duration, SystemTime};

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};

const FIRST_CHECK: Duration = Duration::from_secs(20);
const INTERVAL: Duration = Duration::from_secs(60 * 60);
/// How often the loop looks at the clock (short, so a check follows soon after waking up).
const TICK: Duration = Duration::from_secs(5 * 60);
const STABLE_ENDPOINT: &str = "https://github.com/DeanOpen/compola-client/releases/latest/download/latest.json";
const EDGE_ENDPOINT: &str = "https://github.com/DeanOpen/compola-client/releases/download/edge/latest.json";
pub const EVENT: &str = "compola://updater";

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
    /// Why it is off (debug build, headless server, turned off by the environment).
    pub disabled_reason: Option<String>,
    pub current_version: String,
    /// `stable` or `edge`.
    pub channel: &'static str,
    pub checking: bool,
    pub installing: bool,
    /// Unix ms of the last finished check.
    pub last_check: Option<i64>,
    pub last_error: Option<String>,
    /// A newer version found by the last check.
    pub available: Option<String>,
    pub notes: Option<String>,
}

#[derive(Default)]
struct State {
    status: Mutex<Status>,
    pending: Mutex<Option<Update>>,
    declined: Mutex<HashSet<String>>,
    /// One check / install at a time.
    busy: tokio::sync::Mutex<()>,
}

fn flag(name: &str) -> bool {
    std::env::var(name).is_ok_and(|v| !v.is_empty() && v != "0")
}

fn disabled_reason() -> Option<String> {
    if flag("COMPOLA_DISABLE_UPDATER") {
        return Some("Đã tắt bằng COMPOLA_DISABLE_UPDATER.".into());
    }
    // A headless server (Linux container) is updated by pulling a newer image, never in place.
    if crate::platform::headless() {
        return Some("Máy chủ Compola Server cập nhật bằng cách kéo image Docker mới.".into());
    }
    if cfg!(debug_assertions) && !flag("COMPOLA_UPDATER_DEBUG") {
        return Some("Bản dựng phát triển không tự cập nhật.".into());
    }
    None
}

/// Edge builds carry a pre-release part (`0.1.5-21`).
fn channel_of(version: &str) -> &'static str {
    if version.contains('-') { "edge" } else { "stable" }
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn state(app: &AppHandle) -> &State {
    app.state::<State>().inner()
}

fn changed(app: &AppHandle) {
    let status = state(app).status.lock().clone();
    crate::host::emit_ui(app, EVENT, status);
}

/// Registers the state and starts the background loop (once, from `setup`).
pub fn start(app: &AppHandle) {
    let version = app.package_info().version.to_string();
    let reason = disabled_reason();
    app.manage(State {
        status: Mutex::new(Status {
            enabled: reason.is_none(),
            disabled_reason: reason.clone(),
            channel: channel_of(&version),
            current_version: version,
            ..Status::default()
        }),
        ..State::default()
    });
    if let Some(reason) = reason {
        log::info!("updater: off ({reason})");
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        let mut last: Option<SystemTime> = None;
        loop {
            let due = last.is_none_or(|t| SystemTime::now().duration_since(t).map_or(true, |d| d >= INTERVAL));
            if due {
                last = Some(SystemTime::now());
                if let Ok(Some(update)) = check(&app).await {
                    offer(&app, update).await;
                }
            }
            tokio::time::sleep(TICK).await;
        }
    });
}

/// Looks for a newer version on the running build's channel and records the result.
async fn check(app: &AppHandle) -> Result<Option<Update>, String> {
    let st = state(app);
    let _guard = st.busy.lock().await;
    let channel = st.status.lock().channel;
    st.status.lock().checking = true;
    changed(app);
    let endpoint = if channel == "edge" { EDGE_ENDPOINT } else { STABLE_ENDPOINT };
    let result = async {
        let url = endpoint.parse().map_err(|e: url::ParseError| e.to_string())?;
        let updater = app.updater_builder().endpoints(vec![url]).map_err(|e| e.to_string())?.timeout(Duration::from_secs(30)).build().map_err(|e| e.to_string())?;
        updater.check().await.map_err(|e| e.to_string())
    }
    .await;
    {
        let mut s = st.status.lock();
        s.checking = false;
        s.last_check = Some(now_ms());
        match &result {
            Ok(Some(u)) => {
                log::info!("updater: {} available on {channel} (running {})", u.version, u.current_version);
                s.available = Some(u.version.clone());
                s.notes = u.body.clone().filter(|n| !n.trim().is_empty());
                s.last_error = None;
            }
            Ok(None) => {
                log::info!("updater: up to date ({}, {channel})", s.current_version);
                s.available = None;
                s.notes = None;
                s.last_error = None;
            }
            Err(e) => {
                log::warn!("updater: check failed ({channel}): {e}");
                s.last_error = Some(e.clone());
            }
        }
    }
    *st.pending.lock() = result.as_ref().ok().cloned().flatten();
    changed(app);
    result
}

/// The background prompt: once per version per run.
async fn offer(app: &AppHandle, update: Update) {
    if !state(app).declined.lock().insert(update.version.clone()) {
        return;
    }
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
    if ask(app, "Có bản cập nhật Compola", message, MessageDialogKind::Info, Some(("Cập nhật", "Để sau"))).await {
        if let Err(e) = install(app, update.clone()).await {
            let text = format!("Không cài được bản cập nhật Compola {}.\n\n{e}", update.version);
            ask(app, "Cập nhật không thành công", text, MessageDialogKind::Error, None).await;
        }
    }
}

/// Downloads, installs and restarts.
async fn install(app: &AppHandle, update: Update) -> Result<(), String> {
    let st = state(app);
    let _guard = st.busy.lock().await;
    st.status.lock().installing = true;
    changed(app);
    let mut received = 0usize;
    let result = update
        .download_and_install(
            |chunk, total| {
                received += chunk;
                log::debug!("updater: {received}/{total:?} bytes");
            },
            || log::info!("updater: downloaded, installing"),
        )
        .await
        .map_err(|e| e.to_string());
    st.status.lock().installing = false;
    match result {
        Ok(()) => {
            log::info!("updater: installed {}, restarting", update.version);
            app.restart();
        }
        Err(e) => {
            log::error!("updater: install failed: {e}");
            st.status.lock().last_error = Some(e.clone());
            changed(app);
            Err(e)
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

// ---- commands (Settings › Cập nhật) ----

#[tauri::command]
pub fn updater_status(app: AppHandle) -> Status {
    state(&app).status.lock().clone()
}

/// Checks now (also when the background prompt was dismissed for this version).
#[tauri::command]
pub async fn updater_check(app: AppHandle) -> Result<Status, String> {
    if let Some(reason) = state(&app).status.lock().disabled_reason.clone() {
        return Err(reason);
    }
    check(&app).await?;
    Ok(state(&app).status.lock().clone())
}

/// Installs the update the last check found, then restarts.
#[tauri::command]
pub async fn updater_install(app: AppHandle) -> Result<(), String> {
    let pending = state(&app).pending.lock().clone();
    let update = match pending {
        Some(u) => u,
        None => check(&app).await?.ok_or("Compola đang là bản mới nhất.")?,
    };
    install(&app, update).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channels() {
        assert_eq!(channel_of("0.1.4"), "stable");
        assert_eq!(channel_of("0.1.5-21"), "edge");
    }
}
