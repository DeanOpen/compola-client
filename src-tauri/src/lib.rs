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
mod net;
mod notifications;
mod platform;
mod runtime;
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
                eprintln!("[{}] {}", r.level(), r.args());
            }
        }
        fn flush(&self) {}
    }
    static LOGGER: Logger = Logger;
    let _ = log::set_logger(&LOGGER);
    log::set_max_level(log::LevelFilter::Debug);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_logging();
    let _ = rustls::crypto::ring::default_provider().install_default();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .register_asynchronous_uri_scheme_protocol(host::SCHEME, host::protocol::handle)
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
            engine::engine_info,
            engine::engine_call,
            engine::engine_eval,
            engine::engine_refresh_qr,
            engine::engine_logout,
            engine::engine_retry_runtime,
            engine::engine_show_renderer,
            engine::engine_switch_to_sqlite,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                net::fingerprint::FingerprintProxy::shared().shutdown();
            }
        });
}
