//! The native call helper process: signature check, orphan reaping, and `child_process.spawn` — port of
//! `CallHelperSupport.swift` and `SystemCallProcess` (`CallBridge.swift`).

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use super::{CallProcess, ExitFn};

/// Zalo's Developer ID team (VNG ONLINE CO.,LTD) and the helper's bundle identifier.
pub const REQUIREMENT: &str =
    r#"anchor apple generic and identifier "com.vng.zalo.zalocall" and certificate leaf[subject.OU] = "CVB6BX97VM""#;

/// `ZaloHelper.app` containing `executable` (`…/ZaloHelper.app/Contents/MacOS/ZaloCall`).
pub fn bundle_of(executable: &Path) -> PathBuf {
    executable.ancestors().nth(3).map(Path::to_path_buf).unwrap_or_default()
}

/// Full static validation of the helper bundle (all architectures) against [`REQUIREMENT`].
#[cfg(target_os = "macos")]
pub fn verify_signature(executable: &Path, requirement: &str) -> Result<(), String> {
    use core_foundation::url::CFURL;
    use security_framework::os::macos::code_signing::{Flags, SecRequirement, SecStaticCode};
    use std::str::FromStr;
    let url = CFURL::from_path(bundle_of(executable), true).ok_or("Không đọc được chữ ký của trình gọi Zalo.")?;
    let code = SecStaticCode::from_path(&url, Flags::NONE).map_err(|_| "Không đọc được chữ ký của trình gọi Zalo.".to_owned())?;
    let req = SecRequirement::from_str(requirement).map_err(|_| "Yêu cầu chữ ký không hợp lệ.".to_owned())?;
    code.check_validity(Flags::CHECK_ALL_ARCHITECTURES, &req).map_err(|e| {
        format!("Trình gọi của Zalo không có chữ ký hợp lệ của VNG nên ứng dụng không chạy nó (mã {}).", e.code())
    })
}

#[cfg(not(target_os = "macos"))]
pub fn verify_signature(_executable: &Path, _requirement: &str) -> Result<(), String> {
    Err("Trình gọi của Zalo chỉ chạy trên macOS.".into())
}

// ---------------------------------------------------------------------------------------------------------------------
// Orphans
// ---------------------------------------------------------------------------------------------------------------------

/// Helpers left behind by an Compola that crashed or was force-quit: identified by their argv, which points into one of
/// our `compola-call-<pid>-…` / `szc-<pid>-…` socket directories whose owner pid is dead. Other ZaloCall processes (for
/// example the official Zalo's, which uses `/tmp/socketzalorecv2021`) never match.
pub const DIRECTORY_PREFIXES: &[&str] = &["compola-call-", "swiftzalo-call-", "szc-"];

/// The pid encoded in a socket directory name (`compola-call-<pid>-XXXXXX`, legacy `…-<pid>`).
pub fn owner_pid(directory_name: &str) -> Option<i32> {
    let prefix = DIRECTORY_PREFIXES.iter().find(|p| directory_name.starts_with(**p))?;
    let digits: String = directory_name[prefix.len()..].chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

pub fn is_dead(pid: i32) -> bool {
    crate::sys::pid_is_gone(pid)
}

/// For helper argv `[exe, recvPath, sendPath]`: the dead owner's pid when it is one of our stale directories.
pub fn stale_owner(argv: &[String]) -> Option<i32> {
    if argv.len() < 3 {
        return None;
    }
    let (recv, send) = (Path::new(&argv[1]), Path::new(&argv[2]));
    if recv.file_name()? != "recv" || send.file_name()? != "send" || recv.parent()? != send.parent()? {
        return None;
    }
    let owner = owner_pid(recv.parent()?.file_name()?.to_str()?)?;
    (owner != std::process::id() as i32 && is_dead(owner)).then_some(owner)
}

/// Whether `path` is a `ZaloCall` we run: the configured helper, or any `ZaloCall` inside our runtime folder (a
/// previous runtime version, or the `COMPOLA_ZALO_APP` copy) — never the official Zalo's own.
fn is_our_helper(path: &Path, helper: &Path) -> bool {
    let canonical = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let path = canonical(path);
    path.file_name().is_some_and(|n| n == "ZaloCall")
        && (path == canonical(helper) || path.starts_with(canonical(&crate::runtime::root())))
}

/// Terminates our orphaned helpers (a crash, a force quit, a `tauri dev` restart: no `RunEvent::Exit`); returns their
/// pids. A helper is ours when its executable is ours ([`is_our_helper`]), it runs as this user, and its argv points
/// into one of our socket directories whose owner is dead ([`stale_owner`]).
#[cfg(target_os = "macos")]
pub fn reap_orphans(helper_executable: &Path) -> Vec<i32> {
    let me = std::process::id() as i32;
    let uid = crate::sys::uid();
    let mut reaped = Vec::new();
    for pid in all_pids() {
        if pid == me {
            continue;
        }
        let Some(path) = pid_path(pid) else { continue };
        if !is_our_helper(&path, helper_executable) || owner_uid(pid) != uid {
            continue;
        }
        if arguments(pid).is_some_and(|argv| stale_owner(&argv).is_some()) {
            log::info!("call: reaping orphaned helper {pid}");
            crate::sys::signal(pid, crate::sys::Signal::Terminate);
            reaped.push(pid);
        }
    }
    kill_later(reaped.clone());
    reaped
}

/// SIGKILL for whatever ignored the SIGTERM, two seconds later.
#[cfg(target_os = "macos")]
pub(crate) fn kill_later(pids: Vec<i32>) {
    if pids.is_empty() {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(2));
        for pid in pids {
            if crate::sys::pid_is_alive(pid) {
                crate::sys::signal(pid, crate::sys::Signal::Kill);
            }
        }
    });
}

#[cfg(not(target_os = "macos"))]
pub fn reap_orphans(_helper_executable: &Path) -> Vec<i32> {
    Vec::new()
}

#[cfg(target_os = "macos")]
pub(crate) fn all_pids() -> Vec<i32> {
    let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    if count <= 0 {
        return Vec::new();
    }
    let mut pids = vec![0i32; count as usize + 64];
    let filled = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), (pids.len() * std::mem::size_of::<i32>()) as i32) };
    pids.truncate(filled.max(0) as usize);
    pids.retain(|p| *p > 0);
    pids
}

#[cfg(target_os = "macos")]
pub(crate) fn pid_path(pid: i32) -> Option<PathBuf> {
    let mut buf = vec![0u8; 4 * libc::PATH_MAX as usize];
    let n = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    (n > 0).then(|| PathBuf::from(String::from_utf8_lossy(&buf[..n as usize]).into_owned()))
}

#[cfg(target_os = "macos")]
fn bsd_info(pid: i32) -> Option<libc::proc_bsdinfo> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
    let n = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size) };
    (n == size).then_some(info)
}

#[cfg(target_os = "macos")]
pub(crate) fn owner_uid(pid: i32) -> Option<u32> {
    bsd_info(pid).map(|i| i.pbi_uid)
}

/// The parent pid (1 once the parent died and launchd adopted the process).
#[cfg(target_os = "macos")]
pub(crate) fn parent_pid(pid: i32) -> Option<u32> {
    bsd_info(pid).map(|i| i.pbi_ppid)
}

/// `KERN_PROCARGS2`: argv of a process of this user (including argv[0]).
#[cfg(target_os = "macos")]
pub fn arguments(pid: i32) -> Option<Vec<String>> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let mut size: libc::size_t = 0;
    if unsafe { libc::sysctl(mib.as_mut_ptr(), 3, std::ptr::null_mut(), &mut size, std::ptr::null_mut(), 0) } != 0 || size == 0 {
        return None;
    }
    let mut data = vec![0u8; size];
    if unsafe { libc::sysctl(mib.as_mut_ptr(), 3, data.as_mut_ptr().cast(), &mut size, std::ptr::null_mut(), 0) } != 0 {
        return None;
    }
    data.truncate(size);
    parse_proc_args(&data)
}

/// Layout: `int argc`, executable path, NUL padding, `argc` NUL-terminated arguments, environment.
pub fn parse_proc_args(data: &[u8]) -> Option<Vec<String>> {
    if data.len() <= 4 {
        return None;
    }
    let argc = i32::from_ne_bytes(data[..4].try_into().ok()?);
    if !(1..1024).contains(&argc) {
        return None;
    }
    let mut i = 4;
    while i < data.len() && data[i] != 0 {
        i += 1; // executable path
    }
    while i < data.len() && data[i] == 0 {
        i += 1; // padding
    }
    let mut args = Vec::new();
    while args.len() < argc as usize && i < data.len() {
        let end = data[i..].iter().position(|b| *b == 0).map(|p| i + p).unwrap_or(data.len());
        args.push(String::from_utf8_lossy(&data[i..end]).into_owned());
        i = end + 1;
    }
    (args.len() == argc as usize).then_some(args)
}

/// Directories of Compola processes that no longer exist (crash / force quit) — only our own, never through a link.
pub fn remove_stale_directories(base: &Path) {
    let Ok(entries) = std::fs::read_dir(base) else { return };
    let me = std::process::id() as i32;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(pid) = name.to_str().and_then(owner_pid) else { continue };
        if pid == me || !is_dead(pid) {
            continue;
        }
        let Ok(meta) = std::fs::symlink_metadata(entry.path()) else { continue };
        if meta.is_dir() && crate::sys::owned_by_me(&meta) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// A fresh private directory made with `mkdtemp` (0700, fails when the name exists): `$TMPDIR` is already per-user;
/// a short `/tmp` name is the fallback when the path would not fit `sockaddr_un`.
#[cfg(unix)]
pub fn make_socket_directory(base: &Path) -> Result<PathBuf, String> {
    remove_stale_directories(base);
    remove_stale_directories(Path::new("/tmp"));
    let pid = std::process::id();
    let base = base.to_string_lossy();
    let templates = [format!("{}/compola-call-{pid}-XXXXXX", base.trim_end_matches('/')), format!("/tmp/szc-{pid}-XXXXXX")];
    for template in templates {
        if template.len() + "/recv".len() > super::socket::MAX_PATH_LENGTH {
            continue;
        }
        let Ok(c) = std::ffi::CString::new(template) else { continue };
        let raw = c.into_raw();
        let made = unsafe { libc::mkdtemp(raw) };
        let c = unsafe { std::ffi::CString::from_raw(raw) };
        if !made.is_null() {
            return Ok(PathBuf::from(c.to_string_lossy().into_owned()));
        }
    }
    Err("socket path too long".into())
}

/// No UNIX sockets for the helper here: a uniquely named directory under `base` (the helper never runs off macOS).
#[cfg(not(unix))]
pub fn make_socket_directory(base: &Path) -> Result<PathBuf, String> {
    remove_stale_directories(base);
    let pid = std::process::id();
    for _ in 0..16 {
        let dir = base.join(format!("compola-call-{pid}-{:06x}", rand::random::<u32>() & 0xFF_FFFF));
        if std::fs::create_dir(&dir).is_ok() {
            return Ok(dir);
        }
    }
    Err("could not create the socket directory".into())
}

// ---------------------------------------------------------------------------------------------------------------------
// Parent-death watchdog
// ---------------------------------------------------------------------------------------------------------------------

/// Kills a helper when this process dies, however it dies (SIGKILL included): a tiny `/bin/sh` blocked reading a pipe
/// whose only write end is ours (close-on-exec, so no other child inherits it). When we die the kernel closes it, the
/// read sees EOF, and the shell sends SIGTERM, then SIGKILL after two seconds. macOS has no `PR_SET_PDEATHSIG`, and a
/// thread of ours cannot outlive us. The watchdog runs in its own process group so a group kill of the app cannot
/// take it without the helper.
pub struct Watchdog {
    child: Option<std::process::Child>,
}

const WATCHDOG_SCRIPT: &str = r#"read -r _ ; kill -TERM "$1" 2>/dev/null; i=0; while kill -0 "$1" 2>/dev/null && [ $i -lt 20 ]; do sleep 0.1; i=$((i+1)); done; kill -KILL "$1" 2>/dev/null"#;

impl Watchdog {
    #[cfg(unix)]
    pub fn spawn(target: u32) -> Option<Self> {
        use std::os::unix::process::CommandExt;
        let child = Command::new("/bin/sh")
            .args(["-c", WATCHDOG_SCRIPT, "compola-helper-watchdog", &target.to_string()])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .inspect_err(|e| log::warn!("helper watchdog not started: {e}"))
            .ok()?;
        Some(Self { child: Some(child) })
    }

    /// No `/bin/sh` elsewhere: the helper only runs on macOS.
    #[cfg(not(unix))]
    pub fn spawn(_target: u32) -> Option<Self> {
        None
    }

    /// The target ended on its own (or was stopped by us): stop watching without touching its pid again.
    pub fn disarm(mut self) {
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

impl Drop for Watchdog {
    /// Dropping without [`Watchdog::disarm`] fires it (what our death does).
    fn drop(&mut self) {
        if let Some(mut c) = self.child.take() {
            drop(c.stdin.take());
            std::thread::spawn(move || {
                let _ = c.wait();
            });
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Production process
// ---------------------------------------------------------------------------------------------------------------------

/// `child_process.spawn(ZaloCall, [recvPath, sendPath])`. stdout is discarded; stderr is drained and only counted
/// (the helper's output can carry ids and tokens).
pub struct SystemCallProcess {
    pid: i32,
    running: Arc<AtomicBool>,
}

impl SystemCallProcess {
    pub fn launch(executable: &Path, args: &[&str], on_exit: ExitFn) -> Result<Arc<dyn CallProcess>, String> {
        let mut child = Command::new(executable)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        let pid = child.id() as i32;
        // The helper must not outlive us (it does not exit when its sockets close).
        let watchdog = Watchdog::spawn(child.id());
        let running = Arc::new(AtomicBool::new(true));
        let mut stderr = child.stderr.take();
        let flag = running.clone();
        std::thread::spawn(move || {
            let counter = std::thread::spawn(move || {
                let mut total = 0usize;
                let mut buf = [0u8; 8192];
                if let Some(err) = stderr.as_mut() {
                    while let Ok(n) = err.read(&mut buf) {
                        if n == 0 {
                            break;
                        }
                        total += n;
                    }
                }
                total
            });
            let status = child.wait();
            if let Some(w) = watchdog {
                w.disarm();
            }
            flag.store(false, Ordering::SeqCst);
            let code = match status {
                #[cfg(unix)]
                Ok(s) => {
                    use std::os::unix::process::ExitStatusExt;
                    s.code().or(s.signal()).unwrap_or(-1)
                }
                #[cfg(not(unix))]
                Ok(s) => s.code().unwrap_or(-1),
                Err(_) => -1,
            };
            let bytes = counter.join().unwrap_or(0);
            log::info!("call: native exit status {code}, stderr {bytes} bytes");
            on_exit(code);
        });
        Ok(Arc::new(SystemCallProcess { pid, running }))
    }

    fn signal(&self, sig: crate::sys::Signal) {
        if self.running.load(Ordering::SeqCst) {
            crate::sys::signal(self.pid, sig);
        }
    }
}

impl CallProcess for SystemCallProcess {
    fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }
    fn interrupt(&self) {
        self.signal(crate::sys::Signal::Interrupt);
    }
    fn terminate(&self) {
        self.signal(crate::sys::Signal::Terminate);
    }
    fn force_kill(&self) {
        self.signal(crate::sys::Signal::Kill);
    }
    fn pid(&self) -> Option<i32> {
        self.is_running().then_some(self.pid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::time::Duration;

    #[cfg(unix)]
    #[test]
    fn orphan_matching_only_touches_our_stale_directories() {
        let dead = "/tmp/compola-call-999999-AbCdEf";
        let argv = |a: &str, b: &str| vec!["ZaloCall".to_owned(), a.to_owned(), b.to_owned()];
        assert_eq!(stale_owner(&argv(&format!("{dead}/recv"), &format!("{dead}/send"))), Some(999999));
        assert_eq!(stale_owner(&argv("/tmp/szc-999999-Zz9Zz9/recv", "/tmp/szc-999999-Zz9Zz9/send")), Some(999999));
        // Alive owner (this process), the official Zalo's fixed sockets, odd shapes: untouched.
        let mine = format!("/tmp/compola-call-{}-AbCdEf", std::process::id());
        assert_eq!(stale_owner(&argv(&format!("{mine}/recv"), &format!("{mine}/send"))), None);
        assert_eq!(stale_owner(&argv("/tmp/socketzalorecv2021", "/tmp/socketzalosend2021")), None);
        assert_eq!(stale_owner(&argv(&format!("{dead}/recv"), "/elsewhere/send")), None);
        assert_eq!(stale_owner(&["ZaloCall".to_owned()]), None);
    }

    #[test]
    fn proc_args_parsing() {
        let mut data = 3i32.to_ne_bytes().to_vec();
        data.extend_from_slice(b"/x/ZaloCall\0\0\0");
        for arg in ["ZaloCall", "/a/recv", "/a/send"] {
            data.extend_from_slice(arg.as_bytes());
            data.push(0);
        }
        data.extend_from_slice(b"ENV=1\0");
        assert_eq!(parse_proc_args(&data), Some(vec!["ZaloCall".into(), "/a/recv".into(), "/a/send".into()]));
        assert_eq!(parse_proc_args(&[1, 2]), None);
        // Our own argv is readable (same user).
        #[cfg(target_os = "macos")]
        assert!(arguments(std::process::id() as i32).is_some_and(|a| !a.is_empty()));
    }

    #[cfg(unix)]
    #[test]
    fn stale_directories_of_dead_processes_are_removed() {
        let base = PathBuf::from(format!("/tmp/szt-stale-{}", rand::random::<u32>() % 1_000_000));
        std::fs::create_dir_all(&base).unwrap();
        let dead = base.join("compola-call-999999-AbCdEf");
        let mine = base.join(format!("compola-call-{}-AbCdEf", std::process::id()));
        let other = base.join("unrelated");
        for d in [&dead, &mine, &other] {
            std::fs::create_dir_all(d).unwrap();
        }
        remove_stale_directories(&base);
        assert!(!dead.exists());
        assert!(mine.exists());
        assert!(other.exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    fn alive(pid: u32) -> bool {
        crate::sys::pid_is_alive(pid as i32)
    }

    #[cfg(unix)]
    #[test]
    fn watchdog_kills_the_helper_when_its_parent_goes() {
        // Our death closes the pipe; dropping the armed watchdog does exactly that.
        let mut helper = Command::new("/bin/sleep").arg("60").spawn().unwrap();
        let watchdog = Watchdog::spawn(helper.id()).unwrap();
        std::thread::sleep(Duration::from_millis(100));
        assert!(alive(helper.id()));
        drop(watchdog);
        let status = helper.wait().unwrap();
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(status.signal(), Some(libc::SIGTERM));
    }

    #[cfg(unix)]
    #[test]
    fn disarmed_watchdog_leaves_the_helper_alone() {
        let mut helper = Command::new("/bin/sleep").arg("60").spawn().unwrap();
        Watchdog::spawn(helper.id()).unwrap().disarm();
        std::thread::sleep(Duration::from_millis(300));
        assert!(alive(helper.id()));
        let _ = helper.kill();
        let _ = helper.wait();
    }

    #[test]
    fn our_helpers_are_recognised_by_path() {
        let runtime_helper = crate::runtime::root().join("26.1/Contents/ZaloHelper.app/Contents/MacOS/ZaloCall");
        let configured = PathBuf::from("/Applications/Zalo.app/Contents/ZaloHelper.app/Contents/MacOS/ZaloCall");
        assert!(is_our_helper(&runtime_helper, Path::new("/elsewhere/ZaloCall")));
        assert!(is_our_helper(&configured, &configured));
        assert!(!is_our_helper(&configured, &runtime_helper)); // the official app's own helper
        assert!(!is_our_helper(&crate::runtime::root().join("x/ZaloCap"), &runtime_helper));
        assert_eq!(owner_pid("compola-call-123-AbC"), Some(123));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn real_signature_check() {
        // Anything that is not Zalo's helper fails the requirement.
        assert!(verify_signature(Path::new("/bin/echo"), REQUIREMENT).is_err());
        // The installed helper (when a Zalo runtime is present) passes.
        let exe = super::super::helper_executable(&crate::runtime::candidate());
        if exe.exists() {
            verify_signature(&exe, REQUIREMENT).unwrap();
        }
    }
}
