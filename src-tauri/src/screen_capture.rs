//! The official screenshot tool, `ZaloCap` (a Qt app in Zalo.app's `ZaloHelper.app`), driven the way Zalo PC's main
//! process drives it (main.js module "F58p") — port of `ScreenCapture.swift`:
//! - started once as `ZaloCap zalo2017 <log dir>` and kept running (restarted on demand after it exits);
//! - commands are JSON lines on stdin, `{"cmd": "zalo:capture", "data": {language, enableSend2Me, enableAccept, …}}`;
//! - answers are framed on stdout as `@cap_resp@{"id": n, "data": "<JSON {cmd, data}>"}@end_cap_resp@`, each
//!   acknowledged with `{"cmd": "zalo:recvAck", "data": n}`.
//!
//! The tool draws its own selection / annotation toolbar. "Gửi" (`cap:acceptScrs`) and "Gửi vào Cloud của tôi"
//! (`cap:send2meScrs`) leave the shot on the clipboard, "Chia sẻ" (`cap:forwardScrs`) hands over an image path, the
//! OCR "share text" (`cap:forwardTextScrs`) its text. OCR itself is not offered.
//!
//! The UI starts a capture with the `screen_capture_start` command; the result arrives as `compola://screen-capture`
//! ([`Outcome`]) on the UI window — sending the shot into the conversation is the UI's job.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use crate::host::emit_ui;

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Outcome {
    /// "Gửi": the shot (a PNG written from the clipboard) for the conversation the capture started from.
    #[serde(rename_all = "camelCase")]
    Send { path: String, conversation_id: String },
    /// "Gửi vào Cloud của tôi".
    #[serde(rename_all = "camelCase")]
    SendToMe { path: String, conversation_id: String },
    /// "Chia sẻ": the user picks the conversations.
    #[serde(rename_all = "camelCase")]
    Share { path: String, conversation_id: String },
    /// "Chia sẻ" of the recognised text.
    #[serde(rename_all = "camelCase")]
    ShareText { text: String, conversation_id: String },
    /// The tool may not record the screen (System Settings ▸ Privacy ▸ Screen Recording).
    NoPermission,
    /// Something failed before the tool could run (helper missing, clipboard empty…), with the text to show.
    #[serde(rename_all = "camelCase")]
    Failed { message: String, conversation_id: String },
}

/// A decoded `@cap_resp@…@end_cap_resp@` frame.
#[derive(Clone, Debug, PartialEq)]
pub struct Frame {
    pub id: Value,
    pub command: String,
    pub data: Option<Value>,
}

const FRAME_START: &str = "@cap_resp@";
const FRAME_END: &str = "@end_cap_resp@";

/// Takes every complete frame out of `buffer` (what precedes a frame is the tool's log output and is dropped).
pub fn frames(buffer: &mut String) -> Vec<Frame> {
    let mut found = Vec::new();
    while let Some(open) = buffer.find(FRAME_START) {
        let body_start = open + FRAME_START.len();
        let Some(close) = buffer[body_start..].find(FRAME_END).map(|i| body_start + i) else {
            buffer.drain(..open);
            return found;
        };
        // Main strips line breaks from the chunk before parsing.
        let body: String = buffer[body_start..close].chars().filter(|c| *c != '\r' && *c != '\n').collect();
        buffer.drain(..close + FRAME_END.len());
        let Ok(Value::Object(outer)) = serde_json::from_str::<Value>(&body) else { continue };
        let Some(id) = outer.get("id").cloned() else { continue };
        let (mut command, mut data) = (String::new(), None);
        if let Some(Ok(Value::Object(inner))) = outer.get("data").and_then(Value::as_str).map(serde_json::from_str::<Value>) {
            command = inner.get("cmd").and_then(Value::as_str).unwrap_or("").to_owned();
            data = inner.get("data").cloned();
        }
        found.push(Frame { id, command, data });
    }
    // No frame start: keep only a tail that could be the beginning of one.
    let keep = FRAME_START.len();
    if buffer.chars().count() > keep {
        let tail: String = buffer.chars().rev().take(keep).collect::<Vec<_>>().into_iter().rev().collect();
        *buffer = tail;
    }
    found
}

pub fn helper_executable(runtime: &Path) -> PathBuf {
    runtime.join("Contents/ZaloHelper.app/Contents/MacOS/ZaloCap")
}

#[derive(Default)]
struct State {
    stdin: Option<ChildStdin>,
    pid: Option<u32>,
    /// Bumped per launch: a late exit of a previous tool must not touch the current one.
    generation: u64,
    buffer: String,
    /// The conversation of the running capture; `None` while idle.
    conversation: Option<String>,
    /// The account of the latest capture (its outcome is tagged with it; kept after the capture ends).
    account: String,
    hid_compola: bool,
}

pub struct ScreenCapture {
    app: AppHandle,
    executable: PathBuf,
    log_dir: PathBuf,
    state: Mutex<State>,
}

/// `startScreenshot(params, convId)`: `with_compola` false hides Compola's windows first (main's "WithoutZalo").
#[tauri::command]
pub fn screen_capture_start(app: AppHandle, conversation_id: String, with_compola: bool, account: Option<String>) -> Result<(), String> {
    let account = crate::account::accounts(&app).registry().resolve(account.as_deref())?;
    let tool = capture(&app);
    {
        // A capture already running keeps its account (the new request is refused as busy).
        let mut st = tool.state.lock();
        if st.conversation.is_none() {
            st.account = account;
        }
    }
    tool.start(conversation_id, with_compola);
    Ok(())
}

fn capture(app: &AppHandle) -> Arc<ScreenCapture> {
    if app.try_state::<Arc<ScreenCapture>>().is_none() {
        app.manage(Arc::new(ScreenCapture {
            app: app.clone(),
            executable: helper_executable(&crate::runtime::candidate()),
            log_dir: log_dir(),
            state: Mutex::new(State::default()),
        }));
    }
    app.state::<Arc<ScreenCapture>>().inner().clone()
}

fn log_dir() -> PathBuf {
    crate::platform::app_support().join("logs/capture")
}

/// `ZaloCap zalo2017 <our log dir>` processes whose parent is gone (adopted by launchd): left by a previous run.
#[cfg(target_os = "macos")]
pub fn reap_orphans() -> Vec<i32> {
    use crate::calls::helper;
    let ours = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let configured = ours(&helper_executable(&crate::runtime::candidate()));
    let runtime = ours(&crate::runtime::root());
    let log_dir = log_dir().to_string_lossy().into_owned();
    let uid = unsafe { libc::getuid() };
    let mut reaped = Vec::new();
    for pid in helper::all_pids() {
        let Some(path) = helper::pid_path(pid).map(|p| ours(&p)) else { continue };
        let is_cap = path.file_name().is_some_and(|n| n == "ZaloCap") && (path == configured || path.starts_with(&runtime));
        if !is_cap || helper::owner_uid(pid) != Some(uid) || helper::parent_pid(pid) != Some(1) {
            continue;
        }
        if helper::arguments(pid).is_some_and(|a| a.len() >= 3 && a[1] == "zalo2017" && a[2] == log_dir) {
            log::info!("capture: reaping orphaned tool {pid}");
            unsafe { libc::kill(pid, libc::SIGTERM) };
            reaped.push(pid);
        }
    }
    helper::kill_later(reaped.clone());
    reaped
}

#[cfg(not(target_os = "macos"))]
pub fn reap_orphans() -> Vec<i32> {
    Vec::new()
}

/// App exit: the tool does not outlive the app.
pub fn shutdown(app: &AppHandle) {
    if let Some(c) = app.try_state::<Arc<ScreenCapture>>() {
        c.shutdown();
    }
}

impl ScreenCapture {
    fn outcome(&self, o: Outcome) {
        let account = self.state.lock().account.clone();
        let payload = serde_json::to_value(&o).unwrap_or(Value::Null);
        emit_ui(&self.app, "compola://screen-capture", crate::account::tag_payload("compola://screen-capture", &account, payload));
    }

    fn start(self: &Arc<Self>, conversation_id: String, with_compola: bool) {
        if self.state.lock().conversation.is_some() {
            log::info!("capture: busy");
            return;
        }
        if !crate::calls::is_executable(&self.executable) {
            self.outcome(Outcome::Failed {
                message: "Không tìm thấy công cụ chụp màn hình của Zalo (ZaloHelper.app/Contents/MacOS/ZaloCap). Hãy mở lại Compola để cài lại.".into(),
                conversation_id,
            });
            return;
        }
        // The tool records the screen on Compola's behalf (Compola is the responsible process): without the permission it
        // would only see the wallpaper. Ask macOS once; the tool itself reports `cap:noPermission` too.
        if !screen_capture_access(true) {
            self.outcome(Outcome::NoPermission);
            return;
        }
        if let Err(e) = self.launch_if_needed() {
            log::warn!("capture: launch failed {e}");
            self.outcome(Outcome::Failed { message: "Không mở được công cụ chụp màn hình.".into(), conversation_id });
            return;
        }
        self.state.lock().conversation = Some(conversation_id);
        let request = json!({
            "cmd": "zalo:capture",
            "data": { "language": "_vn", "enableSend2Me": 1, "enableAccept": 1, "viMyCloud": "Gửi vào Cloud của tôi", "enMyCloud": "Send to My Cloud" },
        });
        if with_compola {
            self.send(&request);
        } else {
            // Main hides the window and starts the capture 200 ms after its "hide" event.
            self.state.lock().hid_compola = true;
            #[cfg(target_os = "macos")]
            let _ = self.app.hide();
            let this = self.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(350)).await;
                this.send(&request);
            });
        }
    }

    fn shutdown(&self) {
        let pid = {
            let mut st = self.state.lock();
            st.generation += 1;
            st.stdin = None;
            st.pid.take()
        };
        if let Some(pid) = pid {
            unsafe { libc::kill(pid as i32, libc::SIGTERM) };
        }
        self.finish();
    }

    fn launch_if_needed(self: &Arc<Self>) -> Result<(), String> {
        if self.state.lock().pid.is_some() {
            return Ok(());
        }
        std::fs::create_dir_all(&self.log_dir).map_err(|e| e.to_string())?;
        // stdout carries the framed answers next to the tool's log lines; neither is logged verbatim (paths, OCR text).
        let mut child = Command::new(&self.executable)
            .arg("zalo2017")
            .arg(&self.log_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        // Kept running between captures: it must not outlive us.
        let watchdog = crate::calls::helper::Watchdog::spawn(child.id());
        let generation = {
            let mut st = self.state.lock();
            st.generation += 1;
            st.stdin = child.stdin.take();
            st.pid = Some(child.id());
            st.buffer.clear();
            st.generation
        };
        let mut stdout = child.stdout.take();
        let this = self.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 16384];
            if let Some(out) = stdout.as_mut() {
                while let Ok(n) = out.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    this.consume(generation, &buf[..n]);
                }
            }
            let status = child.wait().map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
            if let Some(w) = watchdog {
                w.disarm();
            }
            {
                let mut st = this.state.lock();
                if st.generation != generation {
                    return;
                }
                st.pid = None;
                st.stdin = None;
            }
            log::info!("capture: tool exited {status}");
            this.finish();
        });
        log::info!("capture: tool started");
        Ok(())
    }

    fn send(&self, request: &Value) {
        let mut st = self.state.lock();
        let Some(stdin) = st.stdin.as_mut() else { return };
        let mut line = serde_json::to_vec(request).unwrap_or_default();
        line.push(b'\n');
        // A write after the tool died fails with EPIPE (Rust ignores SIGPIPE), never ends Compola.
        if stdin.write_all(&line).and_then(|_| stdin.flush()).is_err() {
            log::warn!("capture: write failed");
        }
    }

    fn consume(&self, generation: u64, data: &[u8]) {
        let found = {
            let mut st = self.state.lock();
            if st.generation != generation {
                return;
            }
            st.buffer.push_str(&String::from_utf8_lossy(data));
            frames(&mut st.buffer)
        };
        for frame in found {
            self.send(&json!({ "cmd": "zalo:recvAck", "data": frame.id }));
            self.handle(frame);
        }
    }

    fn handle(&self, frame: Frame) {
        let conversation = self.state.lock().conversation.clone().unwrap_or_default();
        match frame.command.as_str() {
            "cap:acceptScrs" => self.deliver(|path| Outcome::Send { path, conversation_id: conversation.clone() }),
            "cap:send2meScrs" => self.deliver(|path| Outcome::SendToMe { path, conversation_id: conversation.clone() }),
            "cap:forwardScrs" => {
                let path = frame.data.as_ref().and_then(Value::as_str).map(|p| {
                    if p.starts_with("file://") { url::Url::parse(p).ok().and_then(|u| u.to_file_path().ok()).unwrap_or_else(|| p.into()) } else { PathBuf::from(p) }
                });
                match path.filter(|p| p.is_file()).and_then(|p| copy_shot(&p)) {
                    Some(copy) => {
                        self.finish();
                        self.outcome(Outcome::Share { path: copy.to_string_lossy().into_owned(), conversation_id: conversation });
                    }
                    None => self.deliver(|path| Outcome::Share { path, conversation_id: conversation.clone() }),
                }
            }
            "cap:forwardTextScrs" => {
                let mut text = frame.data.as_ref().and_then(Value::as_str).unwrap_or("").to_owned();
                // Main: a JSON payload carries the text in `text`.
                if let Ok(Value::Object(o)) = serde_json::from_str::<Value>(&text) {
                    text = o.get("text").and_then(Value::as_str).unwrap_or("").to_owned();
                }
                self.finish();
                if !text.is_empty() {
                    self.outcome(Outcome::ShareText { text, conversation_id: conversation });
                }
            }
            "cap:cancelScrs" | "cap:quitAction" => self.finish(),
            "cap:noPermission" => {
                self.finish();
                self.outcome(Outcome::NoPermission);
            }
            "cap:ocrRequest" => {
                // Main asks its OCR service; there is none here.
                let request = match &frame.data {
                    Some(Value::String(s)) => serde_json::from_str::<Value>(s).ok(),
                    other => other.clone(),
                };
                if let Some(id) = request.as_ref().and_then(|r| r.get("idReq")).and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    self.send(&json!({ "cmd": "zalo:ocrAvailability", "data": { "idReq": id, "enabled": false, "reason": "unsupported" } }));
                }
            }
            // cap:recvReq / cap:running / cap:copyScrs / cap:saveScrs / zalo:changeDataClipboard / cap:osEvent / …
            _ => {}
        }
    }

    /// The shot the tool left on the clipboard, written as PNG (main: `getClipboardImage().toPNG()`).
    fn deliver(&self, outcome: impl FnOnce(String) -> Outcome) {
        let conversation = self.state.lock().conversation.clone().unwrap_or_default();
        self.finish();
        match clipboard_png().and_then(|png| write_shot(&png, "png")) {
            Some(path) => self.outcome(outcome(path.to_string_lossy().into_owned())),
            None => self.outcome(Outcome::Failed { message: "Không lấy được ảnh chụp màn hình. Hãy thử lại.".into(), conversation_id: conversation }),
        }
    }

    /// Ends the running capture and brings Compola back (main's restore + `bringOnTop`).
    fn finish(&self) {
        let hid = {
            let mut st = self.state.lock();
            if st.conversation.is_none() && !st.hid_compola {
                return;
            }
            st.conversation = None;
            std::mem::take(&mut st.hid_compola)
        };
        #[cfg(target_os = "macos")]
        if hid {
            let _ = self.app.show();
        }
        let _ = hid;
        if let Some(w) = self.app.get_webview_window("main") {
            let _ = w.set_focus();
        }
    }
}

/// `CGPreflightScreenCaptureAccess`, asking macOS (`CGRequestScreenCaptureAccess`) when `request` and not granted.
fn screen_capture_access(request: bool) -> bool {
    #[cfg(target_os = "macos")]
    {
        #[link(name = "CoreGraphics", kind = "framework")]
        unsafe extern "C" {
            fn CGPreflightScreenCaptureAccess() -> bool;
            fn CGRequestScreenCaptureAccess() -> bool;
        }
        if unsafe { CGPreflightScreenCaptureAccess() } {
            return true;
        }
        if request {
            unsafe { CGRequestScreenCaptureAccess() };
        }
        false
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = request;
        false
    }
}

fn clipboard_png() -> Option<Vec<u8>> {
    let image = arboard::Clipboard::new().ok()?.get_image().ok()?;
    encode_png(image.width as u32, image.height as u32, &image.bytes)
}

fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Option<Vec<u8>> {
    if width == 0 || height == 0 || rgba.len() != width as usize * height as usize * 4 {
        return None;
    }
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.write_header().ok()?.write_image_data(rgba).ok()?;
    Some(out)
}

/// Shots live in the temporary directory, one folder each (the page reads them while it uploads); older ones go.
fn shots_dir() -> PathBuf {
    std::env::temp_dir().join("compola-screenshots")
}

fn write_shot(data: &[u8], ext: &str) -> Option<PathBuf> {
    prune(&shots_dir());
    let folder = shots_dir().join(uuid::Uuid::new_v4().to_string().to_uppercase());
    std::fs::create_dir_all(&folder).ok()?;
    let path = folder.join(format!("screenshot.{ext}"));
    std::fs::write(&path, data).ok()?;
    Some(path)
}

/// A shared image kept in its own format (PNG / JPEG); anything else is refused.
fn copy_shot(source: &Path) -> Option<PathBuf> {
    let data = std::fs::read(source).ok()?;
    let ext = crate::notifications::policy::attachment_ext(&data).filter(|e| *e != "gif")?;
    write_shot(&data, ext)
}

fn prune(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let cutoff = std::time::SystemTime::now() - Duration::from_secs(6 * 3600);
    for entry in entries.flatten() {
        let created = entry.metadata().and_then(|m| m.created().or_else(|_| m.modified())).unwrap_or(std::time::UNIX_EPOCH);
        if created < cutoff {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_are_cut_out_of_log_noise() {
        let mut buffer = "\" 2026/10/27 - 08:15:09:198 | MainWindow::connectEvents\"\nSUCCESS_INIT\n".to_owned()
            + r#"@cap_resp@{"id":7,"data":"{\"cmd\":\"cap:recvReq\",\"data\":\"zalo:capture\"}"}@end_cap_resp@"#
            + "log line\n"
            + r#"@cap_resp@{"id":8,"data":"{\"cmd\":\"cap:forwardScrs\",\"data\":\"/tmp/shot.png\"}"}@end_"#;
        let first = frames(&mut buffer);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].command, "cap:recvReq");
        assert_eq!(first[0].data, Some(json!("zalo:capture")));
        assert_eq!(first[0].id, json!(7));
        // The second frame is incomplete: kept until its end marker arrives.
        assert!(buffer.starts_with("@cap_resp@"));
        buffer.push_str("cap_resp@");
        let second = frames(&mut buffer);
        assert_eq!(second.iter().map(|f| f.command.as_str()).collect::<Vec<_>>(), ["cap:forwardScrs"]);
        assert_eq!(second[0].data, Some(json!("/tmp/shot.png")));
        assert!(buffer.is_empty());
    }

    #[test]
    fn frame_split_across_chunks_and_line_breaks() {
        let mut buffer = "noise @cap_".to_owned();
        assert!(frames(&mut buffer).is_empty());
        buffer.push_str("resp@{\"id\":1,\r\n\"data\":\"{\\\"cmd\\\":\\\"cap:acceptScrs\\\"}\"}@end_cap_resp@");
        let found = frames(&mut buffer);
        assert_eq!(found.iter().map(|f| f.command.as_str()).collect::<Vec<_>>(), ["cap:acceptScrs"]);
        assert_eq!(found[0].data, None);
    }

    #[test]
    fn garbage_without_frame_stays_bounded() {
        let mut buffer = "x".repeat(5000);
        assert!(frames(&mut buffer).is_empty());
        assert!(buffer.len() <= FRAME_START.len());
    }

    #[test]
    fn outcome_payloads() {
        let v = serde_json::to_value(Outcome::SendToMe { path: "/p".into(), conversation_id: "g1".into() }).unwrap();
        assert_eq!(v, json!({ "kind": "sendToMe", "path": "/p", "conversationId": "g1" }));
        assert_eq!(serde_json::to_value(Outcome::NoPermission).unwrap(), json!({ "kind": "noPermission" }));
    }

    #[test]
    fn png_encoding() {
        let png = encode_png(2, 1, &[255, 0, 0, 255, 0, 255, 0, 255]).unwrap();
        assert_eq!(crate::notifications::policy::attachment_ext(&png), Some("png"));
        assert!(encode_png(2, 2, &[0; 4]).is_none());
    }
}
