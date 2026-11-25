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

/// The local log: `<app support>/logs/engine.log` (the previous run, or the part before a size rotation, in
/// `engine.previous.log`). Settings › Engine shows its tail and reveals the file (`logs_reveal`).
pub fn log_path() -> std::path::PathBuf {
    platform::app_support().join("logs").join("engine.log")
}

fn init_logging() {
    use std::collections::HashMap;
    use std::io::Write;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    /// Rotated past this size, so a long run (or a chatty renderer) never fills the disk.
    const MAX_BYTES: u64 = 32 * 1024 * 1024;
    /// The same line again within this window is counted, not written (renderer errors polled every second).
    const REPEAT_WINDOW: Duration = Duration::from_secs(60);

    struct File {
        file: Option<std::fs::File>,
        written: u64,
        /// line → (when it was last written, repeats skipped since).
        recent: HashMap<String, (Instant, u32)>,
    }
    struct Logger;
    static FILE: std::sync::LazyLock<Mutex<File>> =
        std::sync::LazyLock::new(|| Mutex::new(File { file: None, written: 0, recent: HashMap::new() }));

    fn open(path: &std::path::Path) -> Option<std::fs::File> {
        std::fs::OpenOptions::new().create(true).append(true).open(path).ok()
    }

    impl log::Log for Logger {
        fn enabled(&self, m: &log::Metadata) -> bool {
            let max = if std::env::var_os("COMPOLA_DEBUG").is_some() { log::Level::Debug } else { log::Level::Info };
            m.level() <= max && (m.target().starts_with("compola") || m.level() <= log::Level::Warn)
        }
        fn log(&self, r: &log::Record) {
            if !self.enabled(r.metadata()) {
                return;
            }
            let line = format!("[{}] {}", r.level(), r.args());
            eprintln!("{line}");
            let Ok(mut f) = FILE.lock() else { return };
            let now = Instant::now();
            let mut repeats = 0;
            if let Some((last, skipped)) = f.recent.get_mut(&line) {
                if now.duration_since(*last) < REPEAT_WINDOW {
                    *skipped += 1;
                    return;
                }
                repeats = *skipped;
                *last = now;
                *skipped = 0;
            } else {
                if f.recent.len() >= 512 {
                    f.recent.retain(|_, (last, _)| now.duration_since(*last) < REPEAT_WINDOW);
                }
                f.recent.insert(line.clone(), (now, 0));
            }
            if f.written > MAX_BYTES {
                let path = log_path();
                let _ = std::fs::rename(&path, path.with_file_name("engine.previous.log"));
                f.file = open(&path);
                f.written = 0;
            }
            let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
            let text = if repeats > 0 { format!("{ts} {line}  (+{repeats} more like it in the last minute)\n") } else { format!("{ts} {line}\n") };
            f.written += text.len() as u64;
            if let Some(file) = f.file.as_mut() {
                let _ = file.write_all(text.as_bytes());
            }
        }
        fn flush(&self) {}
    }
    static LOGGER: Logger = Logger;

    let path = log_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // Keep one previous run.
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > 0) {
        let _ = std::fs::rename(&path, path.with_file_name("engine.previous.log"));
    }
    if let Ok(mut f) = FILE.lock() {
        f.file = open(&path);
    }
    let _ = log::set_logger(&LOGGER);
    log::set_max_level(log::LevelFilter::Debug);
    log::info!("Compola {} ({} {}) — log {}", env!("CARGO_PKG_VERSION"), std::env::consts::OS, std::env::consts::ARCH, path.display());
}

/// Settings › Engine › "Mở tệp nhật ký": shows the log file in Finder / Explorer.
#[tauri::command]
fn logs_reveal() -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(log_path()).map_err(|e| e.to_string())
}

/// UI-side diagnostics (failed commands, adapter errors) into the same file.
#[tauri::command]
fn ui_log(line: String) {
    log::info!("ui {}", line.chars().take(500).collect::<String>());
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
            logs_reveal,
            updater::updater_status,
            updater::updater_check,
            updater::updater_install,
            ui_log,
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
            automation::addons::commands::addons_pick,
            automation::addons::commands::addons_inspect,
            automation::addons::commands::addons_install,
            automation::addons::commands::addons_set_enabled,
            automation::addons::commands::addons_set_settings,
            automation::addons::commands::addons_set_limits,
            automation::addons::commands::addons_remove,
            automation::addons::commands::addons_restart,
            automation::addons::commands::addons_rollback,
            automation::addons::commands::addons_logs,
            automation::addons::commands::addons_clear_logs,
            automation::addons::commands::addons_ai_set,
            automation::addons::commands::addons_ai_test,
            automation::addons::commands::addons_workspace,
            automation::addons::commands::addons_quick_replies,
            automation::addons::commands::addons_note_counts,
            automation::addons::commands::addons_note_add,
            automation::addons::commands::addons_note_update,
            automation::addons::commands::addons_note_delete,
            automation::addons::commands::addons_suggestion_resolve,
            automation::addons::commands::addons_action_run,
            automation::addons::commands::addons_views,
            automation::addons::commands::addons_view_document,
            automation::addons::commands::addons_view_call,
            automation::automation_conversations,
            automation::automation_messages,
            automation::automation_send_text,
            automation::automation_search,
            automation::automation_search_status,
            automation::automation_search_set_config,
            automation::automation_search_clear,
            automation::automation_search_test,
            automation::automation_search_builtin_status,
            automation::automation_search_builtin_install,
            automation::automation_search_builtin_remove,
            automation::automation_search_pull_model,
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
                // What each account showed, so the next launch opens on it at once (engine.rs startup cache).
                if let Some(a) = app.try_state::<std::sync::Arc<account::Accounts>>() {
                    for engine in a.engines() {
                        engine.save_startup_cache();
                    }
                }
                net::fingerprint::FingerprintProxy::shared().shutdown();
                calls::shutdown(app);
                screen_capture::shutdown(app);
                // Add-ons get their `unload` and their storage is written before the process ends.
                if let Some(a) = app.try_state::<std::sync::Arc<automation::Automation>>() {
                    a.addons.shutdown();
                }
            }
        });
}
