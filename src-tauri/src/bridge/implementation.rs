//! Assembles the bridge the official renderer sees (port of `BridgeImplementation.swift`):
//! - table-driven members → IPC channels answered by [`crate::main_process`];
//! - preload-local members (Node `fs`/`path`/`os`/`crypto`, electron-store, `$zFileManager` file helpers) → handlers
//!   here, in [`super::fs`], [`super::crypto`], [`super::file_manager`] and `local-modules.js`.

use std::sync::Arc;

use serde_json::{Value, json};

use super::Registry;
use crate::platform::Platform;
use crate::values::{ArgsExt, undef};

pub const GLOBALS: &[&str] = &[
    "$zcommon", "$znode", "$zwindow", "$zresource", "$zlogger", "$zupdater", "$zapp", "$zdownload", "$zdb",
    "$zsessionManager", "$zmulti", "$zcall", "$zsharedWorker", "$zelectron", "$zelectronNative", "$zuri", "$zscreencap",
    "$zlogin", "$zperf", "$zconfig", "$zMetric", "$zFileManager", "$zpc", "$zFeatures", "$zcloud", "$zMsgChannel",
    "$zscript", "$zInAppPayment", "$capp", "$zbackup", "$zpreload", "$zsqlitebw", "$zsafeStorage", "$zMigrateDrive",
    "$zTFModels", "$znetwork", "$zprotocol", "$znoti", "$zsqlite", "__SENTRY_IPC__", "MetriczGlobal",
];

pub fn install(reg: &mut Registry, platform: &Arc<Platform>) {
    for g in GLOBALS {
        reg.declare_global(g);
    }
    reg.value("$zenv.isPreloaded", json!(true));
    reg.value("$zenv.isRenderer", json!(true));

    // electron-store backing for local-modules.js `getElectronStore`
    let p = platform.clone();
    reg.sync("$zelectron.storePath", move |_, a| Ok(json!(p.store_path(a.str_at(0).unwrap_or("config")).to_string_lossy())));
    let p = platform.clone();
    reg.sync("$zelectron.storeRead", move |_, a| Ok(Value::Object(p.read_store(a.str_at(0).unwrap_or("config")))));
    let p = platform.clone();
    reg.sync("$zelectron.storeWrite", move |_, a| {
        let obj = a.obj_at(1).cloned().unwrap_or_default();
        p.write_store(a.str_at(0).unwrap_or("config"), &obj).map_err(|e| e.to_string())?;
        Ok(undef())
    });

    // $znode.os (values consumed by local-modules.js)
    let uname = uname();
    reg.value(
        "$znode.os.__info",
        json!({
            "release": uname.0,
            "version": uname.1,
            "arch": if uname.2 == "x86_64" { "x64" } else { "arm64" },
            // Node's os.hostname() is gethostname(); Zalo sends it (computer_name) to its servers.
            "hostname": hostname(),
            "homedir": dirs::home_dir().unwrap_or_default().to_string_lossy(),
            "tmpdir": format!("{}/", std::env::temp_dir().to_string_lossy().trim_end_matches('/')),
            "totalmem": total_memory(),
            "cpus": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(8),
            "uptime": uptime_seconds(),
            "username": std::env::var("USER").unwrap_or_default(),
            "networkInterfaces": network_interfaces_json(),
        }),
    );
    let consts = json!({ "F_OK": 0, "R_OK": 4, "W_OK": 2, "X_OK": 1 });
    reg.value("$znode.fs.constants", consts.clone());
    reg.value("$znode.fs.constanst", consts);

    // $zelectronNative clipboard (Electron `clipboard`)
    reg.sync("$zelectronNative.clipboardText", |_, _| {
        Ok(json!(arboard::Clipboard::new().and_then(|mut c| c.get_text()).unwrap_or_default()))
    });
    reg.sync("$zelectronNative.clipboardWriteText", |_, a| {
        if let Ok(mut c) = arboard::Clipboard::new() {
            let _ = c.set_text(a.str_at(0).unwrap_or("").to_owned());
        }
        Ok(undef())
    });
    reg.sync("$zelectronNative.clipboardFormats", |_, _| {
        let mut formats = Vec::new();
        if let Ok(mut c) = arboard::Clipboard::new() {
            if c.get_text().is_ok() {
                formats.push("text/plain");
            }
            if c.get_image().is_ok() {
                formats.push("image/png");
            }
        }
        Ok(json!(formats))
    });

    super::fs::install(reg, platform);
    super::crypto::install(reg);
    super::file_manager::install(reg, platform);
}

#[cfg(unix)]
fn uname() -> (String, String, String) {
    // SAFETY: plain libc call into a zeroed struct.
    unsafe {
        let mut u: libc::utsname = std::mem::zeroed();
        if libc::uname(&mut u) != 0 {
            return Default::default();
        }
        let f = |s: &[libc::c_char]| std::ffi::CStr::from_ptr(s.as_ptr()).to_string_lossy().into_owned();
        (f(&u.release), f(&u.version), f(&u.machine))
    }
}

#[cfg(not(unix))]
fn uname() -> (String, String, String) {
    (String::new(), String::new(), std::env::consts::ARCH.to_owned())
}

/// Node's `os.hostname()` = `gethostname(3)`.
pub fn hostname() -> String {
    crate::sys::hostname()
}

#[cfg(target_os = "macos")]
fn sysctl_u64(name: &str) -> Option<u64> {
    let cname = std::ffi::CString::new(name).ok()?;
    let mut value: u64 = 0;
    let mut size = std::mem::size_of::<u64>();
    // SAFETY: value/size describe a valid u64 buffer.
    let rc = unsafe { libc::sysctlbyname(cname.as_ptr(), (&mut value as *mut u64).cast(), &mut size, std::ptr::null_mut(), 0) };
    (rc == 0).then_some(value)
}

#[cfg(target_os = "macos")]
fn total_memory() -> u64 {
    sysctl_u64("hw.memsize").unwrap_or(8 << 30)
}

#[cfg(target_os = "linux")]
fn linux_sysinfo() -> Option<libc::sysinfo> {
    // SAFETY: `sysinfo` only writes into the zeroed struct we own.
    let mut info: libc::sysinfo = unsafe { std::mem::zeroed() };
    (unsafe { libc::sysinfo(&mut info) } == 0).then_some(info)
}

#[cfg(target_os = "linux")]
fn total_memory() -> u64 {
    linux_sysinfo().map(|i| i.totalram as u64 * u64::from(i.mem_unit)).filter(|t| *t > 0).unwrap_or(8 << 30)
}

#[cfg(target_os = "linux")]
fn uptime_seconds() -> u64 {
    linux_sysinfo().map(|i| i.uptime.max(0) as u64).unwrap_or(0)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn total_memory() -> u64 {
    8 << 30
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn uptime_seconds() -> u64 {
    0
}

#[cfg(target_os = "macos")]
fn uptime_seconds() -> u64 {
    let mut tv = libc::timeval { tv_sec: 0, tv_usec: 0 };
    let mut size = std::mem::size_of::<libc::timeval>();
    let name = std::ffi::CString::new("kern.boottime").unwrap();
    // SAFETY: tv/size describe a valid timeval buffer.
    let rc = unsafe { libc::sysctlbyname(name.as_ptr(), (&mut tv as *mut libc::timeval).cast(), &mut size, std::ptr::null_mut(), 0) };
    if rc != 0 {
        return 0;
    }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    now.saturating_sub(tv.tv_sec as u64)
}

/// Node's `os.networkInterfaces()` as a JSON array of `[name, [addresses…]]` pairs (getifaddrs order kept: the
/// official QoS code takes the *first* non-internal IPv4 as the local IP). Address objects match Node's shape.
/// Windows (no `getifaddrs`) reports none.
#[cfg(not(unix))]
pub fn network_interfaces_json() -> String {
    "[]".into()
}

#[cfg(unix)]
pub fn network_interfaces_json() -> String {
    use std::collections::HashMap;
    let mut order: Vec<String> = Vec::new();
    let mut addresses: HashMap<String, Vec<Value>> = HashMap::new();
    let mut macs: HashMap<String, String> = HashMap::new();

    fn prefix_len(bytes: &[u8]) -> Option<u32> {
        let mut bits = 0;
        let mut gap = false;
        for &b in bytes {
            let ones = b.count_ones();
            if gap && ones != 0 {
                return None;
            }
            if ones != 0 && b != ((0xFFu16 << (8 - ones)) & 0xFF) as u8 {
                return None;
            }
            if ones < 8 {
                gap = true;
            }
            bits += ones;
        }
        Some(bits)
    }

    // SAFETY: standard getifaddrs walk; pointers are valid until freeifaddrs.
    unsafe {
        let mut ifap: *mut libc::ifaddrs = std::ptr::null_mut();
        if libc::getifaddrs(&mut ifap) != 0 {
            return "[]".into();
        }
        let mut cur = ifap;
        while !cur.is_null() {
            let ifa = &*cur;
            cur = ifa.ifa_next;
            if let Some(mac) = link_address(ifa) {
                let name = std::ffi::CStr::from_ptr(ifa.ifa_name).to_string_lossy().into_owned();
                macs.insert(name, mac.iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(":"));
            }
        }

        let mut cur = ifap;
        while !cur.is_null() {
            let ifa = &*cur;
            cur = ifa.ifa_next;
            if ifa.ifa_addr.is_null() {
                continue;
            }
            let name = std::ffi::CStr::from_ptr(ifa.ifa_name).to_string_lossy().into_owned();
            let internal = ifa.ifa_flags & (libc::IFF_LOOPBACK as u32) != 0;
            let family = (*ifa.ifa_addr).sa_family as i32;
            let mac = macs.get(&name).cloned().unwrap_or_default();
            let entry = if family == libc::AF_INET {
                let sin = &*(ifa.ifa_addr as *const libc::sockaddr_in);
                let addr = std::net::Ipv4Addr::from(u32::from_be(sin.sin_addr.s_addr));
                let mask_bytes = if ifa.ifa_netmask.is_null() {
                    vec![]
                } else {
                    let m = &*(ifa.ifa_netmask as *const libc::sockaddr_in);
                    u32::from_be(m.sin_addr.s_addr).to_be_bytes().to_vec()
                };
                let netmask = if mask_bytes.len() == 4 { std::net::Ipv4Addr::new(mask_bytes[0], mask_bytes[1], mask_bytes[2], mask_bytes[3]).to_string() } else { String::new() };
                let mut e = json!({ "address": addr.to_string(), "netmask": netmask, "family": "IPv4", "mac": mac, "internal": internal });
                if let Some(p) = prefix_len(&mask_bytes) {
                    e["cidr"] = json!(format!("{addr}/{p}"));
                }
                e
            } else if family == libc::AF_INET6 {
                let sin6 = &*(ifa.ifa_addr as *const libc::sockaddr_in6);
                let addr = std::net::Ipv6Addr::from(sin6.sin6_addr.s6_addr);
                let mut text = addr.to_string();
                if sin6.sin6_scope_id != 0 {
                    text.push('%');
                    text.push_str(&name);
                }
                let mask_bytes = if ifa.ifa_netmask.is_null() {
                    vec![]
                } else {
                    (*(ifa.ifa_netmask as *const libc::sockaddr_in6)).sin6_addr.s6_addr.to_vec()
                };
                let netmask = if mask_bytes.len() == 16 {
                    let mut b = [0u8; 16];
                    b.copy_from_slice(&mask_bytes);
                    std::net::Ipv6Addr::from(b).to_string()
                } else {
                    String::new()
                };
                let mut e = json!({ "address": text, "netmask": netmask, "family": "IPv6", "mac": mac, "internal": internal });
                if let Some(p) = prefix_len(&mask_bytes) {
                    e["cidr"] = json!(format!("{text}/{p}"));
                }
                e
            } else {
                continue;
            };
            if !addresses.contains_key(&name) {
                order.push(name.clone());
            }
            addresses.entry(name).or_default().push(entry);
        }
        libc::freeifaddrs(ifap);
    }
    let pairs: Vec<Value> = order.iter().map(|n| json!([n, addresses.remove(n).unwrap_or_default()])).collect();
    serde_json::to_string(&pairs).unwrap_or_else(|_| "[]".into())
}

/// The 6-byte hardware address of a link-layer `ifaddrs` entry (macOS `AF_LINK`, Linux `AF_PACKET`).
///
/// SAFETY: `ifa` comes from a live `getifaddrs` list.
#[cfg(target_os = "macos")]
unsafe fn link_address(ifa: &libc::ifaddrs) -> Option<[u8; 6]> {
    unsafe {
        if ifa.ifa_addr.is_null() || (*ifa.ifa_addr).sa_family as i32 != libc::AF_LINK {
            return None;
        }
        let dl = &*(ifa.ifa_addr as *const libc::sockaddr_dl);
        if dl.sdl_alen != 6 {
            return None;
        }
        let data = std::slice::from_raw_parts(dl.sdl_data.as_ptr() as *const u8, dl.sdl_data.len());
        let start = dl.sdl_nlen as usize;
        data.get(start..start + 6)?.try_into().ok()
    }
}

#[cfg(target_os = "linux")]
unsafe fn link_address(ifa: &libc::ifaddrs) -> Option<[u8; 6]> {
    unsafe {
        if ifa.ifa_addr.is_null() || (*ifa.ifa_addr).sa_family as i32 != libc::AF_PACKET {
            return None;
        }
        let ll = &*(ifa.ifa_addr as *const libc::sockaddr_ll);
        if ll.sll_halen != 6 {
            return None;
        }
        ll.sll_addr[..6].try_into().ok()
    }
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
unsafe fn link_address(_ifa: &libc::ifaddrs) -> Option<[u8; 6]> {
    None
}
