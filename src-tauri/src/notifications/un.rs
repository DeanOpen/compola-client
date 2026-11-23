//! `UNUserNotificationCenter` backend (what `NativeNotifier.swift` used): delivery, the click / inline-reply delegate,
//! categories, authorization and removal of a conversation's delivered banners.
//!
//! `UNUserNotificationCenter.currentNotificationCenter` raises an Objective-C exception outside an app bundle (a dev
//! binary, `cargo test`), so [`available`] gates every call; the caller falls back to `mac-notification-sys` then.

use std::path::Path;
use std::ptr::NonNull;
use std::sync::OnceLock;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{AllocAnyThread, define_class, msg_send};
use objc2_foundation::{NSArray, NSError, NSSet, NSString, NSURL};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotification, UNNotificationAction,
    UNNotificationActionOptions, UNNotificationAttachment, UNNotificationCategory, UNNotificationCategoryOptions,
    UNNotificationDefaultActionIdentifier, UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNNotificationSettings, UNNotificationSound, UNTextInputNotificationAction, UNTextInputNotificationResponse,
    UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};
use tokio::sync::oneshot;

use super::Response;

pub const MESSAGE_CATEGORY: &str = "app.compola.message";
pub const REPLY_ACTION: &str = "app.compola.message.reply";
/// Thread of notifications without a conversation (`threadIdentifier` must not be empty to group).
const NO_THREAD: &str = "zalo";

/// What the delegate hands back: request id, conversation id, response.
pub type Responder = Box<dyn Fn(String, String, Response) + Send + Sync>;

static RESPONDER: OnceLock<Responder> = OnceLock::new();

/// Running from an app bundle with an identifier (the only case where the center can be used).
pub fn available() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(|| {
        let Ok(exe) = std::env::current_exe() else { return false };
        let Some(contents) = exe.parent().and_then(Path::parent) else { return false };
        exe.parent().and_then(Path::file_name).is_some_and(|n| n == "MacOS")
            && contents.file_name().is_some_and(|n| n == "Contents")
            && contents.parent().and_then(Path::extension).is_some_and(|e| e == "app")
            && plist::Value::from_file(contents.join("Info.plist"))
                .ok()
                .and_then(|v| v.as_dictionary()?.get("CFBundleIdentifier")?.as_string().map(|s| !s.is_empty()))
                .unwrap_or(false)
    })
}

fn center() -> Retained<UNUserNotificationCenter> {
    UNUserNotificationCenter::currentNotificationCenter()
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = AllocAnyThread]
    #[name = "CompolaNotificationDelegate"]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            // The official FocusDetector already decided to notify: show it even while Compola is frontmost.
            handler.call((UNNotificationPresentationOptions::Banner
                | UNNotificationPresentationOptions::List
                | UNNotificationPresentationOptions::Sound,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            handler: &block2::DynBlock<dyn Fn()>,
        ) {
            let request = response.notification().request();
            let id = request.identifier().to_string();
            let thread = request.content().threadIdentifier().to_string();
            let conv = if thread == NO_THREAD { String::new() } else { thread };
            let action = response.actionIdentifier().to_string();
            let outcome = if action == REPLY_ACTION {
                let any: &AnyObject = response.as_ref();
                any.downcast_ref::<UNTextInputNotificationResponse>().map(|r| Response::Reply(r.userText().to_string()))
            } else if action == unsafe { UNNotificationDefaultActionIdentifier }.to_string() {
                Some(Response::Click)
            } else {
                Some(Response::Dismissed)
            };
            if let (Some(outcome), Some(responder)) = (outcome, RESPONDER.get()) {
                responder(id, conv, outcome);
            }
            handler.call(());
        }
    }
);

impl Delegate {
    fn new() -> Retained<Self> {
        let this = Self::alloc().set_ivars(());
        unsafe { msg_send![super(this), init] }
    }
}

/// Once per process: delegate, the "Trả lời" category, and the authorization request. Call on the main thread,
/// early, so a click that launched the app is not missed.
pub fn init(responder: Responder) {
    if !available() || RESPONDER.set(responder).is_err() {
        return;
    }
    let center = center();
    // The center keeps its delegate weakly: this one lives as long as the process.
    let delegate = Delegate::new();
    center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    std::mem::forget(delegate);

    let reply = UNTextInputNotificationAction::actionWithIdentifier_title_options_textInputButtonTitle_textInputPlaceholder(
        &NSString::from_str(REPLY_ACTION),
        &NSString::from_str("Trả lời"),
        UNNotificationActionOptions::empty(),
        &NSString::from_str("Gửi"),
        &NSString::from_str("Nhập tin nhắn…"),
    );
    let actions: Retained<NSArray<UNNotificationAction>> = NSArray::from_retained_slice(&[Retained::into_super(reply)]);
    let category = UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(
        &NSString::from_str(MESSAGE_CATEGORY),
        &actions,
        &NSArray::new(),
        UNNotificationCategoryOptions::HiddenPreviewsShowTitle,
    );
    center.setNotificationCategories(&NSSet::from_retained_slice(&[category]));

    let done = RcBlock::new(|granted: Bool, _error: *mut NSError| {
        log::info!("notification authorization: {}", if granted.as_bool() { "granted" } else { "not granted" });
    });
    center.requestAuthorizationWithOptions_completionHandler(
        UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound | UNAuthorizationOptions::Badge,
        &done,
    );
}

/// Whether banners may be shown (authorized or provisional). The Objective-C objects stay in this synchronous part,
/// so the awaiting future is `Send`.
fn authorized() -> oneshot::Receiver<bool> {
    let (tx, rx) = oneshot::channel();
    let tx = std::sync::Mutex::new(Some(tx));
    let block = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
        let status = unsafe { settings.as_ref() }.authorizationStatus();
        if let Some(tx) = tx.lock().ok().and_then(|mut t| t.take()) {
            let _ = tx.send(status == UNAuthorizationStatus::Authorized || status == UNAuthorizationStatus::Provisional);
        }
    });
    center().getNotificationSettingsWithCompletionHandler(&block);
    rx
}

pub struct Banner<'a> {
    pub id: &'a str,
    pub title: &'a str,
    pub body: &'a str,
    pub conversation: &'a str,
    pub silent: bool,
    pub image: Option<&'a Path>,
}

/// Adds the notification; resolves when the center accepted (or refused) it.
pub async fn deliver(banner: Banner<'_>) -> Result<(), String> {
    if !authorized().await.unwrap_or(false) {
        return Err("not authorized".into());
    }
    add(banner).await.unwrap_or_else(|_| Err("no answer from the notification center".into()))
}

fn add(banner: Banner<'_>) -> oneshot::Receiver<Result<(), String>> {
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(banner.title));
    content.setBody(&NSString::from_str(banner.body));
    content.setThreadIdentifier(&NSString::from_str(if banner.conversation.is_empty() { NO_THREAD } else { banner.conversation }));
    content.setCategoryIdentifier(&NSString::from_str(MESSAGE_CATEGORY));
    if !banner.silent {
        content.setSound(Some(&UNNotificationSound::defaultSound()));
    }
    if let Some(path) = banner.image {
        let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
        // The center moves the file into its own store.
        if let Ok(a) = unsafe { UNNotificationAttachment::attachmentWithIdentifier_URL_options_error(&NSString::from_str("avatar"), &url, None) } {
            content.setAttachments(&NSArray::from_retained_slice(&[a]));
        }
    }
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(banner.id), &content, None);
    let (tx, rx) = oneshot::channel::<Result<(), String>>();
    let tx = std::sync::Mutex::new(Some(tx));
    let block = RcBlock::new(move |error: *mut NSError| {
        let result = match unsafe { error.as_ref() } {
            Some(e) => Err(e.localizedDescription().to_string()),
            None => Ok(()),
        };
        if let Some(tx) = tx.lock().ok().and_then(|mut t| t.take()) {
            let _ = tx.send(result);
        }
    });
    center().addNotificationRequest_withCompletionHandler(&request, Some(&block));
    rx
}

/// Drops the delivered banners of a conversation the user has now opened.
pub fn clear_delivered(conversation: &str) {
    if !available() || conversation.is_empty() {
        return;
    }
    let conversation = conversation.to_owned();
    let block = RcBlock::new(move |delivered: NonNull<NSArray<UNNotification>>| {
        let delivered = unsafe { delivered.as_ref() };
        let ids: Vec<Retained<NSString>> = delivered
            .iter()
            .map(|n| n.request())
            .filter(|r| r.content().threadIdentifier().to_string() == conversation)
            .map(|r| r.identifier())
            .collect();
        if !ids.is_empty() {
            center().removeDeliveredNotificationsWithIdentifiers(&NSArray::from_retained_slice(&ids));
        }
    });
    center().getDeliveredNotificationsWithCompletionHandler(&block);
}

/// The authorization status for the settings UI: `authorized` | `denied` | `notDetermined`.
pub fn status() -> oneshot::Receiver<&'static str> {
    let (tx, rx) = oneshot::channel();
    let tx = std::sync::Mutex::new(Some(tx));
    let block = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
        let status = unsafe { settings.as_ref() }.authorizationStatus();
        let name = if status == UNAuthorizationStatus::Authorized || status == UNAuthorizationStatus::Provisional {
            "authorized"
        } else if status == UNAuthorizationStatus::Denied {
            "denied"
        } else {
            "notDetermined"
        };
        if let Some(tx) = tx.lock().ok().and_then(|mut t| t.take()) {
            let _ = tx.send(name);
        }
    });
    center().getNotificationSettingsWithCompletionHandler(&block);
    rx
}

/// Asks macOS for permission (shows the system prompt the first time); resolves with whether it was granted.
pub fn request() -> oneshot::Receiver<bool> {
    let (tx, rx) = oneshot::channel();
    let tx = std::sync::Mutex::new(Some(tx));
    let done = RcBlock::new(move |granted: Bool, _error: *mut NSError| {
        if let Some(tx) = tx.lock().ok().and_then(|mut t| t.take()) {
            let _ = tx.send(granted.as_bool());
        }
    });
    center().requestAuthorizationWithOptions_completionHandler(
        UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound | UNAuthorizationOptions::Badge,
        &done,
    );
    rx
}
