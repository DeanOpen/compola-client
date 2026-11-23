//! `_noti_*` (Electron `Notification`, `$znoti`) → native notifications — port of `NativeNotifier.swift`.
//!
//! The official renderer decides when to notify (settings, mutes, app focus…) and calls `$znoti.createNotification`
//! / `closeNotification` (`host-scripts/notification-adapter.js` turns the web `Notification` of the official notifier
//! into those calls). This module answers them with a macOS notification and pushes `_noti_on-show` /
//! `_noti_on-click` / `_noti_on-close` back so the official callbacks run (open the conversation, timers). A click
//! also brings the UI window forward and emits `compola://notification-click` `{id, convId}` to it; an inline reply
//! emits `compola://notification-reply` `{id, convId, text}` (sending it is the UI's job).
//!
//! Delivery uses `UNUserNotificationCenter` ([`un`]): a delegate reports clicks and inline replies, and a
//! conversation's delivered banners are removed when it is opened. That center only works inside an app bundle, so
//! an unbundled dev binary falls back to `mac-notification-sys` (deprecated NSUserNotification; one waiting thread per
//! banner, no removal). `tauri-plugin-notification` is registered for the UI and is the fallback on other platforms.

#[cfg(target_os = "macos")]
mod un;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use crate::bridge::Registry;
use crate::host::{Host, Hosts, emit_ui};
use crate::values::{ArgsExt, undef};

// ---------------------------------------------------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Icon {
    /// `https://…` avatar (1-1 contact).
    Remote(url::Url),
    /// `data:image/png;base64,…` (group mosaics are rendered to a canvas by the official code).
    Inline(Vec<u8>),
    /// Relative asset of the client bundle, e.g. `assets/avatar_stranger_notif.<hash>.png`.
    Bundled(String),
}

/// What the official renderer hands to `$znoti.createNotification(title, options)`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NotificationRequest {
    pub title: String,
    pub body: String,
    /// Conversation id (`fromUid` for 1-1, `g…` for groups): the official click handler opens it.
    pub tag: String,
    pub silent: bool,
    pub icon: Option<Icon>,
}

impl NotificationRequest {
    pub fn parse(args: &[Value]) -> Option<Self> {
        let title = args.string_at(0).unwrap_or_default();
        let empty = serde_json::Map::new();
        let options = args.obj_at(1).unwrap_or(&empty);
        let body = options.get("body").and_then(Value::as_str).unwrap_or("").to_owned();
        if title.is_empty() && body.is_empty() {
            return None;
        }
        let tag = match options.get("tag") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Number(n)) => n.to_string(),
            _ => String::new(),
        };
        Some(Self {
            title,
            body,
            tag,
            silent: options.get("silent").and_then(Value::as_bool).unwrap_or(false),
            icon: options.get("icon").and_then(Value::as_str).and_then(parse_icon),
        })
    }
}

pub fn parse_icon(raw: &str) -> Option<Icon> {
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }
    if let Some(rest) = text.strip_prefix("data:") {
        let (meta, payload) = rest.split_once(',')?;
        if !meta.contains(";base64") {
            return None;
        }
        use base64::Engine as _;
        let data = base64::engine::general_purpose::STANDARD.decode(payload.trim()).ok().filter(|d| !d.is_empty())?;
        return Some(Icon::Inline(data));
    }
    if let Ok(url) = url::Url::parse(text) {
        if matches!(url.scheme(), "http" | "https") && url.host_str().is_some_and(|h| !h.is_empty()) {
            return Some(Icon::Remote(url));
        }
    }
    if text.contains("://") {
        return None;
    }
    // Relative asset path (strip cache-busting query).
    let path = text.split('?').next().unwrap_or("");
    (!path.is_empty()).then(|| Icon::Bundled(path.to_owned()))
}

pub mod policy {
    /// The official client also hides banners while the app is focused (FocusDetector, fed by the focus bridge
    /// below); this is the native backstop for the one case that must never notify: the user is looking at the very
    /// conversation the message is in.
    pub fn should_suppress(
        app_is_active: bool,
        main_window_visible: bool,
        open_conversation: Option<&str>,
        tag: &str,
        user_idle_seconds: f64,
    ) -> bool {
        const IDLE_THRESHOLD: f64 = 180.0;
        if !app_is_active || !main_window_visible || tag.is_empty() || open_conversation != Some(tag) {
            return false;
        }
        user_idle_seconds < IDLE_THRESHOLD
    }

    /// Official text for a message whose content must stay hidden (`STR_PASS_CODE_NOTIFY_MESSAGE`).
    pub const HIDDEN_PREVIEW_BODY: &str = "Bạn có tin nhắn mới";

    pub fn body(body: &str, shows_preview: bool) -> String {
        if shows_preview { body.to_owned() } else { HIDDEN_PREVIEW_BODY.to_owned() }
    }

    /// File extension of an image the notification can show, sniffed from the bytes (CDN URLs have none).
    pub fn attachment_ext(data: &[u8]) -> Option<&'static str> {
        if data.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
            Some("png")
        } else if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
            Some("jpg")
        } else if data.starts_with(&[0x47, 0x49, 0x46, 0x38]) {
            Some("gif")
        } else {
            None
        }
    }

    /// Only Zalo CDN hosts over https may be fetched for the notification sound.
    pub fn is_sound_url_allowed(url: &url::Url) -> bool {
        url.scheme() == "https" && url.host_str().is_some_and(crate::downloads::is_zalo_cdn) && url.path().ends_with("/sound/noti.mp3")
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Notifier
// ---------------------------------------------------------------------------------------------------------------------

struct Live {
    host: Weak<Host>,
    tag: String,
    /// The account whose renderer created it (`None`: a Compola Server host's notification on a joined app).
    account: Option<String>,
}

pub struct Notifier {
    app: AppHandle,
    live: Mutex<HashMap<String, Live>>,
    /// The conversation the UI shows and its account (set by the UI side; `None` when unknown).
    open_conversation: Mutex<Option<(String, String)>>,
    /// "Show message preview" setting of the UI.
    shows_preview: AtomicBool,
    focus_wired: AtomicBool,
}

pub fn install(app: &AppHandle, reg: &mut Registry) {
    if app.try_state::<Arc<Notifier>>().is_none() {
        app.manage(Arc::new(Notifier {
            app: app.clone(),
            live: Mutex::new(HashMap::new()),
            open_conversation: Mutex::new(None),
            shows_preview: AtomicBool::new(true),
            focus_wired: AtomicBool::new(false),
        }));
    }
    let notifier = app.state::<Arc<Notifier>>().inner().clone();
    notifier.wire_focus_bridge();
    #[cfg(target_os = "macos")]
    if un::available() {
        let app = app.clone();
        let _ = app.clone().run_on_main_thread(move || {
            un::init(Box::new(move |id, account, conv, response| {
                if let Some(n) = app.try_state::<Arc<Notifier>>() {
                    n.handle_response(&id, Some(&account), &conv, response);
                }
            }));
        });
    }

    reg.handle("_noti_is-supported", |_, _| async { Ok(json!(true)) });
    let n = notifier.clone();
    reg.handle("_noti_create", move |host, args| {
        let id = n.create(&args, &host);
        async move { Ok(id.map(Value::String).unwrap_or_else(undef)) }
    });
    let n = notifier;
    reg.handle("_noti_close", move |_, args| {
        n.close(args.str_at(0));
        async { Ok(undef()) }
    });
}

fn notifier(app: &AppHandle) -> Arc<Notifier> {
    if app.try_state::<Arc<Notifier>>().is_none() {
        app.manage(Arc::new(Notifier {
            app: app.clone(),
            live: Mutex::new(HashMap::new()),
            open_conversation: Mutex::new(None),
            shows_preview: AtomicBool::new(true),
            focus_wired: AtomicBool::new(false),
        }));
    }
    app.state::<Arc<Notifier>>().inner().clone()
}

/// The click / reply handler of `UNUserNotificationCenter`, installed once in a joined app (no engine `install`).
#[cfg(target_os = "macos")]
static REMOTE_UN_WIRED: AtomicBool = AtomicBool::new(false);

/// Shows a notification the renderer of the Compola Server this app joined created (`crate::remote`): same banner,
/// suppression and click / reply handling as a local one, without the renderer's callbacks.
pub fn deliver_remote(app: &AppHandle, title: String, body: String, tag: String, silent: bool, image: Option<Vec<u8>>) {
    let n = notifier(app);
    #[cfg(target_os = "macos")]
    if un::available() && !REMOTE_UN_WIRED.swap(true, Ordering::SeqCst) {
        let handler_app = app.clone();
        let _ = app.run_on_main_thread(move || {
            un::init(Box::new(move |id, _account, conv, response| {
                if let Some(n) = handler_app.try_state::<Arc<Notifier>>() {
                    n.handle_response(&id, None, &conv, response);
                }
            }));
        });
    }
    let id = uuid::Uuid::new_v4().to_string().to_uppercase();
    n.live.lock().insert(id.clone(), Live { host: Weak::new(), tag: tag.clone(), account: None });
    n.deliver(NotificationRequest { title, body, tag, silent, icon: None }, id, image);
}

/// The UI reports the conversation on screen of `account` (suppression backstop); `None` when none is open.
pub fn set_open_conversation(app: &AppHandle, account: &str, id: Option<String>) {
    #[cfg(target_os = "macos")]
    if let Some(conv) = &id {
        un::clear_delivered(account, conv);
    }
    if let Some(n) = app.try_state::<Arc<Notifier>>() {
        *n.open_conversation.lock() = id.map(|c| (account.to_owned(), c));
    }
}

/// `"<account name> · <title>"` when several accounts are registered (docs/multi-account.md §5).
fn account_title(app: &AppHandle, account: &str, title: &str) -> String {
    let Some(accounts) = app.try_state::<Arc<crate::account::Accounts>>() else { return title.to_owned() };
    let registry = accounts.registry();
    if registry.accounts.len() < 2 {
        return title.to_owned();
    }
    match registry.get(account) {
        Some(r) => {
            let name = r.display_name().map(str::to_owned).unwrap_or_else(|| format!("Tài khoản {}", r.order + 1));
            format!("{name} · {title}")
        }
        None => title.to_owned(),
    }
}

/// The UI's "show message preview" setting.
#[allow(dead_code)]
pub fn set_shows_preview(app: &AppHandle, shows: bool) {
    if let Some(n) = app.try_state::<Arc<Notifier>>() {
        n.shows_preview.store(shows, Ordering::Relaxed);
    }
}

/// The official `noti.mp3`, requested by the renderer's own sound rules (`notification-adapter.js` posts it).
#[allow(dead_code)]
pub fn play_notification_sound(app: &AppHandle, raw: &str) {
    let Ok(url) = url::Url::parse(raw) else { return };
    if !policy::is_sound_url_allowed(&url) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let file = std::env::temp_dir().join("CompolaNotifications/noti.mp3");
        if !file.exists() {
            let ua = crate::net::fp::user_agent(crate::net::fp::DEFAULT_CLIENT_VERSION);
            let Some(jar) = crate::account::jar(&app, None) else { return };
            let Ok(mut r) = crate::net::fetch(&jar, &url, Vec::new(), &ua, Duration::from_secs(10)).await else { return };
            if r.status != 200 {
                return;
            }
            let mut data = Vec::new();
            while let Ok(Some(c)) = r.chunk().await {
                data.extend_from_slice(&c);
                if data.len() > 4 << 20 {
                    return;
                }
            }
            let _ = std::fs::create_dir_all(file.parent().unwrap());
            if std::fs::write(&file, &data).is_err() {
                return;
            }
        }
        #[cfg(target_os = "macos")]
        let _ = std::process::Command::new("/usr/bin/afplay").arg(&file).spawn();
    });
}

impl Notifier {
    fn create(self: &Arc<Self>, args: &[Value], host: &Arc<Host>) -> Option<String> {
        let request = NotificationRequest::parse(args)?;
        let id = uuid::Uuid::new_v4().to_string().to_uppercase();
        let account = host.account.id().to_owned();
        self.live.lock().insert(id.clone(), Live { host: Arc::downgrade(host), tag: request.tag.clone(), account: Some(account.clone()) });
        let this = self.clone();
        let deliver_id = id.clone();
        let asar = host.asar.clone();
        let net = host.net.clone();
        tauri::async_runtime::spawn(async move {
            let image = match &request.icon {
                Some(Icon::Inline(d)) => Some(d.clone()),
                Some(Icon::Bundled(p)) => asar.read(&format!("pc-dist/{p}")),
                Some(Icon::Remote(u)) => {
                    let fetch = net.request("GET", u, Vec::new(), Vec::new(), Some(Duration::from_secs(3)));
                    match tokio::time::timeout(Duration::from_secs(3), fetch).await {
                        Ok(Ok(r)) if r.status == 200 => Some(r.body),
                        _ => None,
                    }
                }
                None => None,
            };
            // Compola Server shares the default account only until its account dimension lands (§7).
            if account == crate::account::DEFAULT_ID {
                crate::remote::forward_notification(&this.app, &request.title, &request.body, &request.tag, request.silent, image.as_deref());
            }
            let request = NotificationRequest { title: account_title(&this.app, &account, &request.title), ..request };
            this.deliver(request, deliver_id, image);
        });
        Some(id)
    }

    /// The official code closes its notification after ~10 s, when a newer one for the same conversation replaces
    /// it, and on click. A macOS banner leaves the screen by itself and its history belongs in Notification Center,
    /// so this only acknowledges the close to the renderer.
    fn close(&self, id: Option<&str>) {
        let Some(id) = id else { return };
        let Some(entry) = self.live.lock().remove(id) else { return };
        self.push("_noti_on-close", id, entry.account.as_deref(), Some(&entry));
    }

    fn push(&self, channel: &str, id: &str, account: Option<&str>, entry: Option<&Live>) {
        let fallback_label = crate::account::AccountPaths::new(&crate::platform::app_support(), account.unwrap_or(crate::account::DEFAULT_ID))
            .label(crate::main_process::MAIN_LABEL);
        let host = entry.and_then(|e| e.host.upgrade()).or_else(|| self.app.state::<Hosts>().get(&fallback_label));
        if let Some(host) = host {
            host.send(channel, vec![json!({ "id": id, "tag": entry.map(|e| e.tag.as_str()).unwrap_or("") })]);
        }
    }

    fn ui_window_state(&self) -> (bool, bool) {
        match self.app.get_webview_window("main") {
            Some(w) => (
                w.is_focused().unwrap_or(false),
                w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false),
            ),
            None => (false, false),
        }
    }

    fn deliver(self: &Arc<Self>, request: NotificationRequest, id: String, image: Option<Vec<u8>>) {
        let (active, visible) = self.ui_window_state();
        // Only the active account's conversation can be on screen.
        let account = self.live.lock().get(&id).and_then(|l| l.account.clone());
        let active_account = self.app.try_state::<Arc<crate::account::Accounts>>().map(|a| a.active_id());
        let open = self
            .open_conversation
            .lock()
            .clone()
            .filter(|(a, _)| Some(a) == account.as_ref() && Some(a) == active_account.as_ref())
            .map(|(_, c)| c);
        if policy::should_suppress(active, visible, open.as_deref(), &request.tag, user_idle_seconds()) {
            log::info!("notification suppressed: conversation is open and the app is in use");
            return;
        }
        let body = policy::body(&request.body, self.shows_preview.load(Ordering::Relaxed));
        let image_file = image.and_then(|d| {
            let ext = policy::attachment_ext(&d)?;
            let dir = std::env::temp_dir().join("CompolaNotifications");
            std::fs::create_dir_all(&dir).ok()?;
            let file = dir.join(format!("{}.{ext}", uuid::Uuid::new_v4()));
            std::fs::write(&file, d).ok()?;
            Some(file)
        });

        #[cfg(target_os = "macos")]
        if un::available() {
            let this = self.clone();
            tauri::async_runtime::spawn(async move {
                let banner = un::Banner {
                    id: &id,
                    title: &request.title,
                    body: &body,
                    conversation: &request.tag,
                    account: account.as_deref(),
                    silent: request.silent,
                    image: image_file.as_deref(),
                };
                let result = un::deliver(banner).await;
                if let Some(f) = &image_file {
                    let _ = std::fs::remove_file(f); // normally already moved into the center's store
                }
                match result {
                    Ok(()) => this.announce_shown(id),
                    Err(e) => {
                        log::info!("notification dropped: {e}");
                        this.live.lock().remove(&id);
                    }
                }
            });
            return;
        }

        // Fallback (unbundled dev binary / other platforms): the banner is announced optimistically.
        self.announce_shown(id.clone());
        let this = self.clone();
        // mac-notification-sys blocks until the user interacts: one thread per delivered notification.
        std::thread::spawn(move || {
            let response = show(&this.app, &request, &body, image_file.as_deref());
            if let Some(f) = &image_file {
                let _ = std::fs::remove_file(f);
            }
            match response {
                Ok(r) => this.handle_response(&id, account.as_deref(), &request.tag, r),
                Err(e) => {
                    log::warn!("notification failed: {e}");
                    this.live.lock().remove(&id);
                }
            }
        });
    }

    /// `_noti_on-show`, a moment after delivery: the renderer registers the id when `createNotification` resolves.
    fn announce_shown(self: &Arc<Self>, id: String) {
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(60)).await;
            let live = this.live.lock().get(&id).map(|e| Live { host: e.host.clone(), tag: e.tag.clone(), account: e.account.clone() });
            if let Some(entry) = live {
                this.push("_noti_on-show", &id, entry.account.as_deref(), Some(&entry));
            }
        });
    }

    /// `account`: the banner's account (`None`: a Compola Server host's banner on a joined app).
    fn handle_response(&self, id: &str, account: Option<&str>, conv_id: &str, response: Response) {
        let entry = self.live.lock().remove(id);
        let account = entry.as_ref().and_then(|e| e.account.clone()).or_else(|| account.map(str::to_owned));
        match response {
            Response::Click => {
                #[cfg(target_os = "macos")]
                un::clear_delivered(account.as_deref().unwrap_or(crate::account::DEFAULT_ID), conv_id);
                self.bring_app_to_front();
                // A banner of another account shows that account first.
                if let (Some(a), Some(accounts)) = (&account, self.app.try_state::<Arc<crate::account::Accounts>>()) {
                    if let Err(e) = accounts.set_active(a) {
                        log::warn!("notification click: account {a}: {e}");
                    }
                }
                emit_ui(&self.app, "compola://notification-click", json!({ "id": id, "convId": conv_id, "account": account }));
                // The official click handler (`_onNotiClicked`) opens the conversation in the client state.
                self.push("_noti_on-click", id, account.as_deref(), entry.as_ref());
            }
            Response::Reply(text) => {
                if !text.is_empty() && !conv_id.is_empty() {
                    emit_ui(&self.app, "compola://notification-reply", json!({ "id": id, "convId": conv_id, "text": text, "account": account }));
                }
            }
            Response::Dismissed => {}
        }
        if entry.is_some() {
            self.push("_noti_on-close", id, account.as_deref(), entry.as_ref());
        }
    }

    fn bring_app_to_front(&self) {
        #[cfg(target_os = "macos")]
        let _ = self.app.show();
        if let Some(w) = self.app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
    }

    /// `webContents.send('visibility-change', 'focus'|'blur', windowId)` as Electron's main does for the main window:
    /// the official FocusDetector decides "app is in use" from these (and skips banners while focused).
    fn wire_focus_bridge(self: &Arc<Self>) {
        let Some(window) = self.app.get_webview_window("main") else { return };
        if self.focus_wired.swap(true, Ordering::SeqCst) {
            return;
        }
        let app = self.app.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::Focused(focused) = event {
                if let Some(host) = app.state::<Hosts>().get(crate::main_process::MAIN_LABEL) {
                    host.send("visibility-change", vec![json!(if *focused { "focus" } else { "blur" }), json!("1")]);
                }
            }
        });
    }
}

enum Response {
    Click,
    Reply(String),
    Dismissed,
}

#[cfg(target_os = "macos")]
fn show(app: &AppHandle, request: &NotificationRequest, body: &str, image: Option<&std::path::Path>) -> Result<Response, String> {
    use mac_notification_sys::{MainButton, Notification, NotificationResponse};
    // Only reached without an app bundle (dev binary): the library's default sender shows the banner.
    let _ = app;
    let image_path = image.map(|p| p.to_string_lossy().into_owned());
    let mut n = Notification::new();
    n.title(&request.title).message(body).wait_for_click(true).main_button(MainButton::Response("Trả lời"));
    if !request.silent {
        n.default_sound();
    }
    if let Some(p) = &image_path {
        n.content_image(p);
    }
    match n.send().map_err(|e| e.to_string())? {
        NotificationResponse::Click | NotificationResponse::ActionButton(_) => Ok(Response::Click),
        NotificationResponse::Reply(text) => Ok(Response::Reply(text)),
        NotificationResponse::CloseButton(_) | NotificationResponse::None => Ok(Response::Dismissed),
    }
}

#[cfg(not(target_os = "macos"))]
fn show(app: &AppHandle, request: &NotificationRequest, body: &str, _image: Option<&std::path::Path>) -> Result<Response, String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification().builder().title(&request.title).body(body).show().map_err(|e| e.to_string())?;
    Ok(Response::Dismissed)
}

/// Seconds since the last input event of the session (`CGEventSourceSecondsSinceLastEventType`).
fn user_idle_seconds() -> f64 {
    #[cfg(target_os = "macos")]
    {
        #[link(name = "CoreGraphics", kind = "framework")]
        unsafe extern "C" {
            fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
        }
        // kCGEventSourceStateCombinedSessionState, kCGAnyInputEventType
        unsafe { CGEventSourceSecondsSinceLastEventType(0, !0) }
    }
    #[cfg(not(target_os = "macos"))]
    0.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_electron_notification_arguments() {
        use base64::Engine as _;
        let png = base64::engine::general_purpose::STANDARD.encode([0x89, 0x50, 0x4E, 0x47, 1, 2, 3]);
        let r = NotificationRequest::parse(&[
            json!("Nhóm Gia đình"),
            json!({ "body": "Mẹ: ăn cơm chưa", "tag": "g12345", "silent": true, "icon": format!("data:image/png;base64,{png}") }),
        ])
        .unwrap();
        assert_eq!(r.title, "Nhóm Gia đình");
        assert_eq!(r.body, "Mẹ: ăn cơm chưa");
        assert_eq!(r.tag, "g12345");
        assert!(r.silent);
        assert_eq!(r.icon, Some(Icon::Inline(vec![0x89, 0x50, 0x4E, 0x47, 1, 2, 3])));
    }

    #[test]
    fn parses_icon_kinds() {
        assert_eq!(
            parse_icon("https://s120-ava-talk.zadn.vn/a/b/c"),
            Some(Icon::Remote(url::Url::parse("https://s120-ava-talk.zadn.vn/a/b/c").unwrap()))
        );
        assert_eq!(parse_icon("assets/avatar_stranger_notif.5b53.png?v=1"), Some(Icon::Bundled("assets/avatar_stranger_notif.5b53.png".into())));
        assert_eq!(parse_icon(""), None);
        assert_eq!(parse_icon("data:image/png;base64,@@@"), None);
        assert_eq!(parse_icon("file:///etc/passwd"), None);
    }

    #[test]
    fn tag_may_be_number_and_defaults_are_safe() {
        let numeric = NotificationRequest::parse(&[json!("Tên"), json!({ "body": "xin chào", "tag": 42 })]).unwrap();
        assert!(numeric.tag == "42" && !numeric.silent && numeric.icon.is_none());
        assert_eq!(NotificationRequest::parse(&[]), None);
        assert_eq!(NotificationRequest::parse(&[json!(""), json!({})]), None);
        let title_only = NotificationRequest::parse(&[json!("Zalo")]).unwrap();
        assert!(title_only.body.is_empty() && title_only.tag.is_empty());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn notification_center_is_gated_outside_a_bundle() {
        // `currentNotificationCenter` would raise outside an app bundle: the test binary must take the fallback.
        assert!(!un::available());
        un::clear_delivered("default", "g1"); // a no-op, not a crash
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn banner_threads_carry_the_account() {
        assert_eq!(un::thread_id("a1b2c3d4e", "g42"), "a1b2c3d4e:g42");
        assert_eq!(un::parse_thread("a1b2c3d4e:g42"), ("a1b2c3d4e".to_owned(), "g42".to_owned()));
        assert_eq!(un::parse_thread("default:"), ("default".to_owned(), String::new()));
        // Banners delivered before multi-account belong to the default account.
        assert_eq!(un::parse_thread("g42"), ("default".to_owned(), "g42".to_owned()));
        assert_eq!(un::parse_thread("zalo"), ("default".to_owned(), String::new()));
        assert_eq!(un::parse_thread("x:y"), ("default".to_owned(), "x:y".to_owned()));
    }

    #[test]
    fn preview_toggle() {
        assert_eq!(policy::body("Mẹ: xin chào", true), "Mẹ: xin chào");
        assert_eq!(policy::body("Mẹ: xin chào", false), "Bạn có tin nhắn mới");
    }

    #[test]
    fn suppresses_only_when_watching_that_conversation() {
        let s = |active: bool, visible: bool, open: Option<&str>, tag: &str, idle: f64| policy::should_suppress(active, visible, open, tag, idle);
        assert!(s(true, true, Some("5"), "5", 4.0));
        assert!(!s(false, true, Some("5"), "5", 4.0));
        assert!(!s(true, false, Some("5"), "5", 4.0));
        assert!(!s(true, true, Some("6"), "5", 4.0));
        assert!(!s(true, true, None, "5", 4.0));
        assert!(!s(true, true, Some(""), "", 4.0));
        assert!(!s(true, true, Some("5"), "5", 600.0)); // user stepped away: official idle rule still notifies
    }

    #[test]
    fn attachment_type_sniffing() {
        assert_eq!(policy::attachment_ext(&[0x89, 0x50, 0x4E, 0x47, 0x0D]), Some("png"));
        assert_eq!(policy::attachment_ext(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("jpg"));
        assert_eq!(policy::attachment_ext(b"GIF89a"), Some("gif"));
        assert_eq!(policy::attachment_ext(b"RIFF....WEBP"), None);
        assert_eq!(policy::attachment_ext(&[]), None);
    }

    #[test]
    fn sound_url_allow_list() {
        let ok = |s: &str| policy::is_sound_url_allowed(&url::Url::parse(s).unwrap());
        assert!(ok("https://stc-chat.zdn.vn/sound/noti.mp3"));
        assert!(!ok("http://stc-chat.zdn.vn/sound/noti.mp3"));
        assert!(!ok("https://evil.example.com/sound/noti.mp3"));
        assert!(!ok("https://stc-chat.zdn.vn/other.mp3"));
    }
}

/// Notification permission for Settings ▸ Thông báo: `authorized` | `denied` | `notDetermined` | `unavailable` (an
/// unbundled dev build cannot use the notification center).
#[tauri::command]
pub async fn notification_authorization() -> String {
    if !un::available() {
        return "unavailable".into();
    }
    un::status().await.unwrap_or("notDetermined").into()
}

/// Asks macOS for notification permission, then reports the resulting status.
#[tauri::command]
pub async fn notification_request_authorization() -> String {
    if !un::available() {
        return "unavailable".into();
    }
    let _ = un::request().await;
    un::status().await.unwrap_or("notDetermined").into()
}
