//! Compola (Rust + Tauri) — a port of zalo-swift-re: the official Zalo PC renderer runs headless in a hidden webview
//! and Rust plays Electron's preload + main process; the UI window is a web frontend driven by its state.

mod asar;
mod bridge;
mod calls;
mod downloads;
mod engine;
mod host;
mod installer;
mod main_process;
mod media;
mod net;
mod notifications;
mod platform;
mod runtime;
mod screen_capture;
mod shared_worker;
mod sqlite_host;
mod values;

use std::sync::Arc;

use tauri::Manager;

fn init_logging() {
    struct Logger;
    impl log::Log for Logger {
        fn enabled(&self, m: &log::Metadata) -> bool {
            let max = if std::env::var_os("COMPOLA_DEBUG").is_some() { log::Level::Debug } else { log::Level::Info };
            m.level() <= max && (m.target().starts_with("compola") || m.level() <= log::Level::Warn)
        }
        fn log(&self, r: &log::Record) {
            if self.enabled(r.metadata()) {
                let line = format!("[{}] {}", r.level(), r.args());
                eprintln!("{line}");
                // Engine diagnostics on disk (shapes only: the bridge trace never logs contents).
                if let Some(f) = LOG_FILE.get() {
                    use std::io::Write;
                    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
                    let _ = writeln!(f.lock().unwrap(), "{ts} {line}");
                }
            }
        }
        fn flush(&self) {}
    }
    static LOGGER: Logger = Logger;
    static LOG_FILE: std::sync::OnceLock<std::sync::Mutex<std::fs::File>> = std::sync::OnceLock::new();
    let dir = platform::app_support().join("logs");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("engine.log");
    // Keep one previous run.
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > 0) {
        let _ = std::fs::rename(&path, dir.join("engine.previous.log"));
    }
    if let Ok(f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = LOG_FILE.set(std::sync::Mutex::new(f));
    }
    let _ = log::set_logger(&LOGGER);
    log::set_max_level(log::LevelFilter::Debug);
}

/// Before the rename to Compola the data folder was `~/Library/Application Support/CompolaTauri`: move it over once, so the
/// session (cookies, client databases, runtime, caches) survives.
fn migrate_legacy_data() {
    let new = platform::app_support();
    let Some(old) = new.parent().map(|p| p.join("CompolaTauri")) else { return };
    if old.is_dir() && !new.join("cookies.json").exists() {
        let _ = std::fs::remove_dir_all(&new);
        let _ = std::fs::rename(&old, &new);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    migrate_legacy_data();
    init_logging();
    let _ = rustls::crypto::ring::default_provider().install_default();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .register_asynchronous_uri_scheme_protocol(host::SCHEME, host::protocol::handle)
        .register_asynchronous_uri_scheme_protocol(media::protocol::SCHEME, media::protocol::handle)
        .manage(host::Hosts::default())
        .manage(Arc::new(shared_worker::SharedWorkerRouter::default()))
        .manage(Arc::new(net::cookies::CookieJar::load(platform::app_support().join("cookies.json"))))
        .setup(|app| {
            let engine = engine::Engine::new(app.handle().clone());
            app.manage(engine.clone());
            engine.start();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            engine::engine_phase,
            engine::engine_replay,
            engine::engine_info,
            engine::engine_call,
            engine::engine_eval,
            engine::engine_refresh_qr,
            engine::engine_logout,
            engine::engine_retry_runtime,
            engine::engine_show_renderer,
            engine::engine_switch_to_sqlite,
            engine::ui_set_open_conversation,
            engine::ui_set_shows_preview,
            engine::engine_call_with_files,
            engine::ui_widen_window,
            engine::clipboard_paste_files,
            calls::calls_status,
            calls::call_show_window,
            notifications::notification_authorization,
            notifications::notification_request_authorization,
            media::media_save,
            media::media_open_file,
            screen_capture::screen_capture_start,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // main `stop()`: the native helpers do not outlive the app.
            if let tauri::RunEvent::Exit = event {
                net::fingerprint::FingerprintProxy::shared().shutdown();
                calls::shutdown(app);
                screen_capture::shutdown(app);
            }
        });
}
