//! Small OS primitives with a Unix implementation and a Windows one, so the rest of the code does not need `cfg`s
//! for file modes, process liveness/signals or the host name.

use std::path::Path;

/// A regular file that can be executed (Unix: any `x` bit; Windows: any file).
pub fn is_executable_file(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    std::fs::metadata(path).is_ok_and(|m| m.is_file())
}

/// `chmod(path, mode)` (best effort). Windows has no mode bits: files under the user profile are private already.
pub fn set_mode(path: &Path, mode: u32) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
    }
    #[cfg(not(unix))]
    let _ = (path, mode);
}

/// A symlink to a file or a directory.
pub fn symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    return std::os::unix::fs::symlink(target, link);
    #[cfg(windows)]
    {
        let resolved = if target.is_absolute() { target.to_path_buf() } else { link.parent().unwrap_or(Path::new("")).join(target) };
        if resolved.is_dir() {
            std::os::windows::fs::symlink_dir(target, link)
        } else {
            std::os::windows::fs::symlink_file(target, link)
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Signal {
    Interrupt,
    Terminate,
    Kill,
}

/// Sends `signal` to `pid` (best effort). Windows has no signals: every one of them ends the process.
pub fn signal(pid: i32, signal: Signal) {
    #[cfg(unix)]
    {
        let sig = match signal {
            Signal::Interrupt => libc::SIGINT,
            Signal::Terminate => libc::SIGTERM,
            Signal::Kill => libc::SIGKILL,
        };
        // SAFETY: plain syscall.
        unsafe { libc::kill(pid, sig) };
    }
    #[cfg(windows)]
    {
        let _ = signal;
        win::terminate(pid);
    }
}

/// Windows: the helper `child` ends when this process ends (a kill-on-close job object).
#[cfg(windows)]
pub fn kill_with_us(child: &std::process::Child) {
    win::kill_with_us(child)
}

/// Whether `pid` names a running process.
pub fn pid_is_alive(pid: i32) -> bool {
    #[cfg(unix)]
    // SAFETY: signal 0 only checks for existence/permission.
    return unsafe { libc::kill(pid, 0) } == 0;
    #[cfg(windows)]
    win::is_alive(pid)
}

/// Whether `pid` certainly does not exist any more (Unix: `ESRCH`; a process of another user is not gone).
pub fn pid_is_gone(pid: i32) -> bool {
    #[cfg(unix)]
    // SAFETY: signal 0 only checks for existence/permission.
    return unsafe { libc::kill(pid, 0) } != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
    #[cfg(windows)]
    !win::is_alive(pid)
}

/// The current user id (Unix); `None` where there is none.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))] // Orphan reaping (macOS).
pub fn uid() -> Option<u32> {
    #[cfg(unix)]
    // SAFETY: plain syscall.
    return Some(unsafe { libc::getuid() });
    #[cfg(not(unix))]
    None
}

/// Whether the current user owns `meta` (always true where files carry no owner id).
pub fn owned_by_me(meta: &std::fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some(meta.uid()) == uid()
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        true
    }
}

/// Node's `os.hostname()`.
pub fn hostname() -> String {
    #[cfg(unix)]
    {
        let mut buf = [0u8; 256];
        // SAFETY: the buffer outlives the call and its length is passed along.
        let ok = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } == 0;
        let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
        if ok { String::from_utf8_lossy(&buf[..end]).into_owned() } else { String::new() }
    }
    #[cfg(not(unix))]
    std::env::var("COMPUTERNAME").unwrap_or_default()
}

/// `{total, available}` bytes of the volume holding `path`.
pub fn disk_space(path: &Path) -> std::io::Result<(u64, u64)> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let c_path = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_| std::io::ErrorKind::InvalidInput)?;
        // SAFETY: `statvfs` only writes into the zeroed struct we own.
        let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statvfs(c_path.as_ptr(), &mut s) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        let frsize = s.f_frsize as u64;
        Ok((s.f_blocks as u64 * frsize, s.f_bavail as u64 * frsize))
    }
    #[cfg(windows)]
    win::disk_space(path)
}

#[cfg(windows)]
mod win {
    use std::path::Path;

    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE, TerminateProcess,
    };

    pub fn is_alive(pid: i32) -> bool {
        if pid <= 0 {
            return false;
        }
        // SAFETY: the handle is checked and closed.
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid as u32);
            if h.is_null() {
                return false;
            }
            let mut code = 0u32;
            let ok = GetExitCodeProcess(h, &mut code) != 0;
            CloseHandle(h);
            ok && code == STILL_ACTIVE as u32
        }
    }

    /// Puts `child` in a job that kills it when the job's last handle closes: ours, which we never close, so it
    /// closes when this process ends however it ends (Windows has no parent-death signal).
    pub fn kill_with_us(child: &std::process::Child) {
        use std::os::windows::io::AsRawHandle;
        use std::sync::OnceLock;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JobObjectExtendedLimitInformation, SetInformationJobObject,
        };
        // One job for every helper (the handle as usize: raw handles are not Send).
        static JOB: OnceLock<usize> = OnceLock::new();
        let job = *JOB.get_or_init(|| {
            // SAFETY: a fresh unnamed job object; the limit struct lives for the call.
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return 0;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let size = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
                SetInformationJobObject(job, JobObjectExtendedLimitInformation, (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(), size);
                job as usize
            }
        });
        if job == 0 {
            log::warn!("helper job object not created: the helper may outlive a crash");
            return;
        }
        // SAFETY: both handles are valid (the child's for as long as `child` lives).
        if unsafe { AssignProcessToJobObject(job as _, child.as_raw_handle() as _) } == 0 {
            log::warn!("helper not assigned to the job object");
        }
    }

    pub fn terminate(pid: i32) {
        if pid <= 0 {
            return;
        }
        // SAFETY: the handle is checked and closed.
        unsafe {
            let h = OpenProcess(PROCESS_TERMINATE, 0, pid as u32);
            if !h.is_null() {
                TerminateProcess(h, 1);
                CloseHandle(h);
            }
        }
    }

    pub fn disk_space(path: &Path) -> std::io::Result<(u64, u64)> {
        use std::os::windows::ffi::OsStrExt;
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let (mut available, mut total) = (0u64, 0u64);
        // SAFETY: `wide` is NUL-terminated; the out pointers are valid u64s.
        let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut available, &mut total, std::ptr::null_mut()) } != 0;
        if ok { Ok((total, available)) } else { Err(std::io::Error::last_os_error()) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn own_process_is_alive() {
        let me = std::process::id() as i32;
        assert!(pid_is_alive(me));
        assert!(!pid_is_gone(me));
    }

    #[test]
    fn disk_space_of_temp() {
        let (total, available) = disk_space(&std::env::temp_dir()).unwrap();
        assert!(total > 0 && available <= total);
    }
}
