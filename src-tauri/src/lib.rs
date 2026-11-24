//! Compola (Rust + Tauri) — a port of zalo-swift-re: the official Zalo PC renderer runs headless in a hidden webview
//! and Rust plays Electron's preload + main process; the UI window is a web frontend driven by its state.

mod account;
mod ai_clients;
mod asar;
mod automation;
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
mod remote;
mod runtime;
mod screen_capture;
mod shared_worker;
mod sqlite_host;
mod sys;
mod updater;
mod values;


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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_logging();
    let _ = rustls::crypto::ring::default_provider().install_default();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .register_asynchronous_uri_scheme_protocol(host::SCHEME, host::protocol::handle)
        .register_asynchronous_uri_scheme_protocol(media::protocol::SCHEME, media::protocol::handle)
        .manage(host::Hosts::default());
    // A crashed WebContent process (one webview) is reloaded by its own account only (docs/multi-account.md §11).
    #[cfg(target_os = "macos")]
    let builder =
        builder.on_web_content_process_terminate(|webview| account::renderer_terminated(webview.app_handle(), webview.label()));
    builder
        .setup(|app| {
            // Headless server (Linux container): nobody looks at the UI; people use /web or a joined Compola app.
            if platform::headless() {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
                log::info!("headless server mode: data in {}", platform::app_support().display());
            }
            // Multi-account registry (docs/multi-account.md): an install from before it becomes the `default` account,
            // nothing moves.
            let accounts = account::Accounts::load(&platform::app_support());
            let registry = accounts.registry();
            log::info!("accounts: {} registered, active {}", registry.accounts.len(), registry.active);
            app.manage(accounts.clone());
            // Compola Server first: `emit_ui` forwards to it, and a joined app does not run its own engine.
            let remote = remote::Remote::new(app.handle().clone());
            app.manage(remote.clone());
            let automation = automation::Automation::new(app.handle().clone());
            app.manage(automation.clone());
            // A joined app shows the host's accounts: its engines exist (commands answer) but never start, and it has
            // no MCP server, schedules or add-ons of its own.
            let joined = remote.is_joined();
            accounts.start(app.handle(), !joined);
            if !joined {
                automation.start();
            }
            remote.start();
            updater::start(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ai_clients::ai_clients_detect,
            ai_clients::ai_clients_install,
            ai_clients::ai_clients_remove,
            account::accounts_list,
            account::account_add,
            account::account_remove,
            account::account_set_active,
            account::account_reorder,
            account::account_set_enabled,
            account::account_rename,
            account::ui_set_event_scope,
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
            media::media_allow_previews,
            calls::calls_status,
            calls::call_show_window,
            notifications::notification_authorization,
            notifications::notification_request_authorization,
            media::media_save,
            media::media_open_file,
            screen_capture::screen_capture_start,
            automation::automation_state,
            automation::automation_set_server,
            automation::automation_regenerate_token,
            automation::automation_save_client,
            automation::automation_delete_client,
            automation::automation_client_tools,
            automation::automation_client_call,
            automation::automation_save_job,
            automation::automation_delete_job,
            automation::automation_run_job,
            automation::automation_cron_preview,
            automation::automation_addon_install,
            automation::automation_addon_set_enabled,
            automation::automation_addon_set_settings,
            automation::automation_addon_storage_set,
            automation::automation_addon_remove,
            automation::automation_addon_register_tools,
            automation::automation_addon_tool_reply,
            automation::automation_conversations,
            automation::automation_messages,
            automation::automation_send_text,
            automation::automation_search,
            automation::automation_search_status,
            automation::automation_search_set_config,
            automation::automation_search_clear,
            automation::automation_search_test,
            remote::remote_status,
            remote::remote_state,
            remote::remote_set_server,
            remote::remote_admin_setup,
            remote::remote_admin_open,
            remote::remote_kick,
            remote::remote_api,
            remote::remote_providers,
            remote::remote_join_password,
            remote::remote_join_browser,
            remote::remote_join_cancel,
            remote::remote_leave,
            remote::remote_retry,
            remote::remote_accounts_list,
            remote::remote_account_set_active,
            remote::remote_set_event_scope,
            remote::remote_wait_connected,
            remote::remote_invoke,
            remote::remote_call_with_files,
            remote::remote_media_save,
            remote::remote_media_open_file,
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
