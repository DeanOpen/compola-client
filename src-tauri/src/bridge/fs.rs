//! `$znode.fs`, `$znode.fsPromise`, `$znode.fsExtra` — the Node file APIs the preload exposed (port of
//! `FileSystemBridge.swift`; member list taken from the live client).
//!
//! Writes are confined to Compola's data and temp directories ([`Platform::is_writable`]; anything else is `EACCES`) so
//! the renderer cannot touch the rest of the disk. Errors carry Node codes (`"ENOENT: /path"`; `bridge.js` turns the
//! prefix into `err.code`), which the official code branches on (`e.code === 'ENOENT'`).
//!
//! Each operation is registered as async (Node callback / promise; run on the blocking pool) and, where Node has one,
//! as a `*Sync` member.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Value, json};

use super::{BridgeResult, Registry, node_error};
use crate::platform::Platform;
use crate::values::{ArgsExt, bytes, undef};

type Op = fn(&Platform, &[Value]) -> BridgeResult;

/// `(async members, sync members, operation)`.
const MEMBERS: &[(&[&str], &[&str], Op)] = &[
    (&["$znode.fs.access", "$znode.fsPromise.access"], &["$znode.fs.accessSync"], access),
    // Node's legacy `fs.exists(path, cb)` calls back with a bare boolean (handled in bridge.js).
    (&["$znode.fs.exists", "$znode.fsExtra.pathExists"], &["$znode.fs.existsSync", "$znode.fsExtra.existsSync"], exists_op),
    (&["$znode.fs.stat", "$znode.fsPromise.stat"], &["$znode.fs.statSync", "$znode.fsExtra.statSync"], |_, a| stat(path_arg(a), true)),
    (&["$znode.fs.lstat", "$znode.fsPromise.lstat"], &[], |_, a| stat(path_arg(a), false)),
    (&["$znode.fs.mkdir", "$znode.fsPromise.mkdir"], &["$znode.fs.mkdirSync"], |p, a| {
        let recursive = a.obj_at(1).and_then(|o| o.get("recursive")).and_then(Value::as_bool).unwrap_or(false);
        mkdir(p, path_arg(a), recursive).map(|_| undef())
    }),
    (&["$znode.fsExtra.ensureDir"], &["$znode.fsExtra.ensureDirSync"], |p, a| mkdir(p, path_arg(a), true).map(|_| undef())),
    (&["$znode.fs.readdir", "$znode.fsPromise.readdir"], &["$znode.fs.readdirSync"], readdir),
    // rimraf v3 (`rimraf(path, cb(err))`): recursive delete, a missing path is success. Used when a deleted photo's
    // cached copies under ZaloDownloads/resource go, and by the resource / temp-folder cleanups. Paths are taken
    // literally (no glob expansion).
    (
        &[
            "$znode.fs.unlink", "$znode.fsPromise.unlink", "$znode.fs.rmdir", "$znode.fsPromise.rmdir", "$znode.fsPromise.rm",
            "$znode.fsExtra.remove", "$znode.rimraf",
        ],
        &["$znode.fs.unlinkSync", "$znode.fsExtra.removeSync"],
        |p, a| remove(p, path_arg(a)).map(|_| undef()),
    ),
    (&["$znode.fsExtra.move", "$znode.fsExtra.rename"], &["$znode.fsExtra.renameSync"], |p, a| {
        move_item(p, path_arg(a), a.str_at(1).unwrap_or("")).map(|_| undef())
    }),
    (&["$znode.fsExtra.copy"], &["$znode.fsExtra.copySync"], |p, a| copy(p, path_arg(a), a.str_at(1).unwrap_or("")).map(|_| undef())),
    (&["$znode.fs.link", "$znode.fsPromise.link"], &[], link),
    // nativelibs.fileUtilities().detectHardlinksAsync(file, dir) → the paths under `dir` that are hard links of `file`
    // (itself included when it is there). The media cleanup asks it before removing a cached copy that may be shared
    // with another resource.
    (&["$znode.nativelibs.fileUtilitiesAddon.detectHardlinksAsync"], &[], |_, a| {
        Ok(json!(hardlinks(path_arg(a), a.str_at(1).unwrap_or(""), HARDLINK_WALK_LIMIT)))
    }),
    // nativelibs.fileUtils().getDiskUsage(path) — synchronous volume stats.
    (&[], &["$znode.nativelibs.fileUtilsAddon.getDiskUsage"], disk_usage),
    // Whole-file helpers used across $zFileManager.
    (&["$znode.fs.readFile"], &[], read_file),
    (&["$znode.fs.writeFile"], &[], write_file),
];

pub fn install(reg: &mut Registry, platform: &Arc<Platform>) {
    for &(async_paths, sync_paths, op) in MEMBERS {
        for path in async_paths {
            let p = platform.clone();
            reg.async_(path, move |_, args| {
                let p = p.clone();
                async move { tauri::async_runtime::spawn_blocking(move || op(&p, &args)).await.map_err(|e| e.to_string())? }
            });
        }
        for path in sync_paths {
            let p = platform.clone();
            reg.sync(path, move |_, args| op(&p, &args));
        }
    }
}

// MARK: helpers

fn path_arg(args: &[Value]) -> &str {
    args.str_at(0).unwrap_or("")
}

/// An I/O error as `"CODE: path"`, the code being the errno name Node would report.
fn io_error(error: std::io::Error, path: &str) -> String {
    let code = match error.raw_os_error() {
        Some(libc::ENOENT) => "ENOENT",
        Some(libc::EEXIST) => "EEXIST",
        Some(libc::EACCES) => "EACCES",
        Some(libc::EPERM) => "EPERM",
        Some(libc::ENOTEMPTY) => "ENOTEMPTY",
        Some(libc::ENOTDIR) => "ENOTDIR",
        Some(libc::EISDIR) => "EISDIR",
        Some(libc::EXDEV) => "EXDEV",
        Some(libc::ELOOP) => "ELOOP",
        Some(libc::ENAMETOOLONG) => "ENAMETOOLONG",
        Some(libc::EBUSY) => "EBUSY",
        Some(libc::EROFS) => "EROFS",
        Some(libc::ENOSPC) => "ENOSPC",
        Some(libc::EMFILE) => "EMFILE",
        Some(libc::EINVAL) => "EINVAL",
        _ => match error.kind() {
            std::io::ErrorKind::NotFound => "ENOENT",
            std::io::ErrorKind::AlreadyExists => "EEXIST",
            std::io::ErrorKind::PermissionDenied => "EACCES",
            _ => "EIO",
        },
    };
    node_error(code, path)
}

fn writable<'a>(platform: &Platform, path: &'a str) -> Result<&'a str, String> {
    if platform.is_writable(path) { Ok(path) } else { Err(node_error("EACCES", path)) }
}

/// Follows symlinks, like `FileManager.fileExists` / Node `existsSync`.
fn exists(path: &str) -> bool {
    !path.is_empty() && Path::new(path).exists()
}

fn require_exists(path: &str) -> Result<&str, String> {
    if exists(path) { Ok(path) } else { Err(node_error("ENOENT", path)) }
}

/// Present as a directory entry, even a dangling symlink.
fn present(path: &str) -> bool {
    !path.is_empty() && std::fs::symlink_metadata(path).is_ok()
}

fn ms(time: std::io::Result<std::time::SystemTime>) -> f64 {
    time.ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}

fn unix_ms(secs: i64, nanos: i64) -> f64 {
    secs as f64 * 1000.0 + nanos as f64 / 1_000_000.0
}

fn remove_any(path: &Path) -> std::io::Result<()> {
    if std::fs::symlink_metadata(path)?.is_dir() { std::fs::remove_dir_all(path) } else { std::fs::remove_file(path) }
}

/// `FileManager.copyItem`: directories recursively, symlinks as symlinks, file permissions kept.
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(from)?;
    if meta.file_type().is_symlink() {
        std::os::unix::fs::symlink(std::fs::read_link(from)?, to)
    } else if meta.is_dir() {
        std::fs::create_dir(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(from, to).map(|_| ())
    }
}

// MARK: operations

fn access(_: &Platform, args: &[Value]) -> BridgeResult {
    require_exists(path_arg(args)).map(|_| undef())
}

fn exists_op(_: &Platform, args: &[Value]) -> BridgeResult {
    Ok(json!(exists(path_arg(args))))
}

/// Node `fs.Stats`-shaped object; its methods are rebuilt in JS (`bridge.js` decodes `__stats`).
fn stat(path: &str, follow: bool) -> BridgeResult {
    use std::os::unix::fs::MetadataExt;
    let meta = if follow { std::fs::metadata(path) } else { std::fs::symlink_metadata(path) };
    let meta = meta.map_err(|e| io_error(e, path))?;
    Ok(json!({
        "__stats": true,
        "size": meta.size(),
        "mode": meta.mode(),
        "mtimeMs": unix_ms(meta.mtime(), meta.mtime_nsec()),
        "ctimeMs": unix_ms(meta.ctime(), meta.ctime_nsec()),
        "atimeMs": unix_ms(meta.atime(), meta.atime_nsec()),
        "birthtimeMs": ms(meta.created()),
        "isFile": meta.is_file(),
        "isDirectory": meta.is_dir(),
        "isSymbolicLink": meta.file_type().is_symlink(),
    }))
}

fn mkdir(platform: &Platform, path: &str, recursive: bool) -> Result<(), String> {
    // fs-extra ensureDir / mkdir -p: an existing directory is success.
    if recursive && Path::new(path).is_dir() {
        return Ok(());
    }
    let path = writable(platform, path)?;
    let result = if recursive { std::fs::create_dir_all(path) } else { std::fs::create_dir(path) };
    result.map_err(|e| io_error(e, path))
}

fn remove(platform: &Platform, path: &str) -> Result<(), String> {
    if !present(path) {
        return Ok(());
    }
    remove_any(Path::new(writable(platform, path)?)).map_err(|e| io_error(e, path))
}

/// Names in the directory, sorted (`FileManager.contentsOfDirectory` order as the Swift app returned it).
fn readdir(_: &Platform, args: &[Value]) -> BridgeResult {
    let path = require_exists(path_arg(args))?;
    let mut names: Vec<String> = std::fs::read_dir(path)
        .map_err(|e| io_error(e, path))?
        .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
        .collect();
    names.sort();
    Ok(json!(names))
}

/// Replaces `to`. Only the destination is checked against the write policy, as in the Swift app.
fn move_item(platform: &Platform, from: &str, to: &str) -> Result<(), String> {
    writable(platform, to)?;
    let from = require_exists(from)?;
    if present(to) {
        remove_any(Path::new(to)).map_err(|e| io_error(e, to))?;
    }
    match std::fs::rename(from, to) {
        // Across volumes, as `FileManager.moveItem`: copy, then delete the source.
        Err(e) if e.raw_os_error() == Some(libc::EXDEV) => {
            copy_tree(Path::new(from), Path::new(to)).map_err(|e| io_error(e, to))?;
            remove_any(Path::new(from)).map_err(|e| io_error(e, from))
        }
        other => other.map_err(|e| io_error(e, to)),
    }
}

fn copy(platform: &Platform, from: &str, to: &str) -> Result<(), String> {
    writable(platform, to)?;
    let from = require_exists(from)?;
    if present(to) {
        remove_any(Path::new(to)).map_err(|e| io_error(e, to))?;
    }
    if let Some(parent) = Path::new(to).parent() {
        std::fs::create_dir_all(parent).map_err(|e| io_error(e, to))?;
    }
    copy_tree(Path::new(from), Path::new(to)).map_err(|e| io_error(e, to))
}

fn link(platform: &Platform, args: &[Value]) -> BridgeResult {
    let from = require_exists(path_arg(args))?;
    let to = writable(platform, args.str_at(1).unwrap_or(""))?;
    std::fs::hard_link(from, to).map(|_| undef()).map_err(|e| io_error(e, to))
}

const HARDLINK_WALK_LIMIT: usize = 200_000;

/// Hard links of `file` under `scope` (same device and inode). A missing file, or one with a single link, has none:
/// the official callers treat both as "not shared". The walk is bounded so a huge resource folder cannot stall a
/// cleanup; symlinked directories are not followed.
fn hardlinks(file: &str, scope: &str, limit: usize) -> Vec<String> {
    use std::os::unix::fs::MetadataExt;
    let Ok(target) = std::fs::symlink_metadata(file) else { return Vec::new() };
    if file.is_empty() || scope.is_empty() || target.nlink() <= 1 {
        return Vec::new();
    }
    let root = PathBuf::from(scope.trim_end_matches('/'));
    let mut links = Vec::new();
    let mut stack = vec![root];
    let mut seen = 0;
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            if seen >= limit {
                return links;
            }
            seen += 1;
            let path = entry.path();
            let Ok(info) = std::fs::symlink_metadata(&path) else { continue };
            if info.is_dir() {
                stack.push(path);
            } else if info.is_file() && info.ino() == target.ino() && info.dev() == target.dev() {
                links.push(path.to_string_lossy().into_owned());
            }
        }
    }
    links
}

/// `{total, free, available, used}` in bytes for the volume holding `path`.
fn disk_usage(_: &Platform, args: &[Value]) -> BridgeResult {
    let path = args.str_at(0).unwrap_or("/");
    let c_path = std::ffi::CString::new(path).map_err(|_| node_error("EINVAL", path))?;
    // SAFETY: `statvfs` only writes into the zeroed struct we own.
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c_path.as_ptr(), &mut s) } != 0 {
        return Err(io_error(std::io::Error::last_os_error(), path));
    }
    let frsize = s.f_frsize as u64;
    let total = s.f_blocks as u64 * frsize;
    let available = s.f_bavail as u64 * frsize;
    Ok(json!({ "total": total, "free": available, "available": available, "used": total.saturating_sub(available) }))
}

/// `readFile(path, encoding | {encoding}?)`: a string when an encoding is given (UTF-8), otherwise a `Uint8Array`.
fn read_file(_: &Platform, args: &[Value]) -> BridgeResult {
    let path = require_exists(path_arg(args))?;
    let data = std::fs::read(path).map_err(|e| io_error(e, path))?;
    let encoding = args.str_at(1).or_else(|| args.obj_at(1).and_then(|o| o.get("encoding")).and_then(Value::as_str));
    Ok(if encoding.is_some() { json!(String::from_utf8_lossy(&data)) } else { bytes(&data) })
}

/// `writeFile(path, data)`: parent directories are created; the write is atomic (temp file + rename).
fn write_file(platform: &Platform, args: &[Value]) -> BridgeResult {
    let path = Path::new(writable(platform, path_arg(args))?);
    let err = |e| io_error(e, &path.to_string_lossy());
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(err)?;
    }
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&tmp, args.bytes_at(1).unwrap_or_default()).map_err(err)?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        err(e)
    })?;
    Ok(undef())
}

#[cfg(test)]
mod tests {
    //! Behaviour of the fs members on a scratch data directory: write policy, Node error codes, stats shape.

    use super::*;

    struct Scratch {
        root: PathBuf,
        platform: Platform,
    }

    impl Scratch {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("compola-fs-test-{}", uuid::Uuid::new_v4()));
            let user_data = root.join("data");
            std::fs::create_dir_all(&user_data).unwrap();
            let platform = Platform { app_version: "0".into(), client_type: "0".into(), client_version: "0".into(), user_data };
            Self { root, platform }
        }

        fn data(&self, rel: &str) -> String {
            self.platform.user_data.join(rel).to_string_lossy().into_owned()
        }

        fn call(&self, member: &str, args: Vec<Value>) -> BridgeResult {
            let (_, _, op) = MEMBERS
                .iter()
                .find(|(a, s, _)| a.contains(&member) || s.contains(&member))
                .unwrap_or_else(|| panic!("no member {member}"));
            op(&self.platform, &args)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn code(result: BridgeResult) -> String {
        let err = result.expect_err("expected an error");
        err.split(':').next().unwrap().to_owned()
    }

    #[test]
    fn write_read_round_trip() {
        let s = Scratch::new();
        let file = s.data("a/b/c.txt");
        s.call("$znode.fs.writeFile", vec![json!(file), bytes(b"hello")]).unwrap();
        assert_eq!(s.call("$znode.fs.readFile", vec![json!(file)]).unwrap(), bytes(b"hello"));
        assert_eq!(s.call("$znode.fs.readFile", vec![json!(file), json!("utf8")]).unwrap(), json!("hello"));
        assert_eq!(s.call("$znode.fs.readFile", vec![json!(file), json!({"encoding": "utf8"})]).unwrap(), json!("hello"));
        s.call("$znode.fs.writeFile", vec![json!(file), json!("text")]).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "text");
        assert_eq!(s.call("$znode.fs.readdir", vec![json!(s.data("a/b"))]).unwrap(), json!(["c.txt"]), "no temp file left");
    }

    #[test]
    fn writes_outside_data_are_refused() {
        let s = Scratch::new();
        let outside = s.root.join("outside/x.txt").to_string_lossy().into_owned();
        assert_eq!(code(s.call("$znode.fs.writeFile", vec![json!(outside), json!("x")])), "EACCES");
        assert_eq!(code(s.call("$znode.fs.mkdirSync", vec![json!(outside), json!({"recursive": true})])), "EACCES");
        // A traversal out of the data directory is still outside.
        let sneaky = s.data("../outside2");
        assert_eq!(code(s.call("$znode.fsExtra.ensureDir", vec![json!(sneaky)])), "EACCES");
        std::fs::create_dir_all(s.root.join("outside")).unwrap();
        std::fs::write(&outside, "keep").unwrap();
        assert_eq!(code(s.call("$znode.fsExtra.remove", vec![json!(outside)])), "EACCES");
        assert!(Path::new(&outside).exists());
        assert_eq!(code(s.call("$znode.fsExtra.copy", vec![json!(outside), json!(s.root.join("outside/y").to_string_lossy())])), "EACCES");
    }

    #[test]
    fn node_error_codes() {
        let s = Scratch::new();
        let missing = s.data("missing");
        assert_eq!(code(s.call("$znode.fs.access", vec![json!(missing)])), "ENOENT");
        assert_eq!(code(s.call("$znode.fs.statSync", vec![json!(missing)])), "ENOENT");
        assert_eq!(code(s.call("$znode.fs.readFile", vec![json!(missing)])), "ENOENT");
        assert_eq!(code(s.call("$znode.fs.readdir", vec![json!(missing)])), "ENOENT");
        assert_eq!(code(s.call("$znode.fsExtra.move", vec![json!(missing), json!(s.data("to"))])), "ENOENT");
        let dir = s.data("d");
        s.call("$znode.fs.mkdirSync", vec![json!(dir)]).unwrap();
        assert_eq!(code(s.call("$znode.fs.mkdirSync", vec![json!(dir)])), "EEXIST");
        s.call("$znode.fs.mkdir", vec![json!(dir), json!({"recursive": true})]).unwrap();
        assert_eq!(code(s.call("$znode.fs.mkdirSync", vec![json!(s.data("x/y/z"))])), "ENOENT");
    }

    #[test]
    fn stats_shape() {
        let s = Scratch::new();
        let file = s.data("f.bin");
        std::fs::write(&file, [1, 2, 3]).unwrap();
        let st = s.call("$znode.fs.statSync", vec![json!(file)]).unwrap();
        assert_eq!(st["__stats"], json!(true));
        assert_eq!(st["size"], json!(3));
        assert_eq!((st["isFile"].clone(), st["isDirectory"].clone()), (json!(true), json!(false)));
        assert!(st["mtimeMs"].as_f64().unwrap() > 1.0e12);
        let link = s.data("l");
        std::os::unix::fs::symlink(&file, &link).unwrap();
        assert_eq!(s.call("$znode.fs.stat", vec![json!(link)]).unwrap()["isFile"], json!(true));
        assert_eq!(s.call("$znode.fs.lstat", vec![json!(link)]).unwrap()["isSymbolicLink"], json!(true));
        let dir = s.call("$znode.fs.statSync", vec![json!(s.data(""))]).unwrap();
        assert_eq!(dir["isDirectory"], json!(true));
    }

    #[test]
    fn existence() {
        let s = Scratch::new();
        let file = s.data("e");
        assert_eq!(s.call("$znode.fs.existsSync", vec![json!(file)]).unwrap(), json!(false));
        std::fs::write(&file, "").unwrap();
        assert_eq!(s.call("$znode.fsExtra.pathExists", vec![json!(file)]).unwrap(), json!(true));
        assert_eq!(s.call("$znode.fs.existsSync", vec![json!("")]).unwrap(), json!(false));
        assert_eq!(s.call("$znode.fs.accessSync", vec![json!(file)]).unwrap(), undef());
    }

    #[test]
    fn copy_move_remove() {
        let s = Scratch::new();
        let src = s.data("src");
        std::fs::create_dir_all(format!("{src}/inner")).unwrap();
        std::fs::write(format!("{src}/inner/a.txt"), "A").unwrap();
        std::fs::write(format!("{src}/b.txt"), "B").unwrap();

        let copied = s.data("deep/copy");
        s.call("$znode.fsExtra.copySync", vec![json!(src), json!(copied)]).unwrap();
        assert_eq!(std::fs::read_to_string(format!("{copied}/inner/a.txt")).unwrap(), "A");
        // An existing destination is replaced.
        std::fs::write(s.data("dst.txt"), "old").unwrap();
        s.call("$znode.fsExtra.copy", vec![json!(format!("{src}/b.txt")), json!(s.data("dst.txt"))]).unwrap();
        assert_eq!(std::fs::read_to_string(s.data("dst.txt")).unwrap(), "B");

        let moved = s.data("moved");
        s.call("$znode.fsExtra.move", vec![json!(src), json!(moved)]).unwrap();
        assert!(!Path::new(&src).exists());
        assert_eq!(s.call("$znode.fs.readdirSync", vec![json!(moved)]).unwrap(), json!(["b.txt", "inner"]));

        s.call("$znode.rimraf", vec![json!(moved)]).unwrap();
        assert!(!Path::new(&moved).exists());
        s.call("$znode.fs.unlinkSync", vec![json!(moved)]).unwrap(); // missing is success
    }

    #[test]
    fn detects_hardlinks() {
        let s = Scratch::new();
        let file = s.data("res/a.jpg");
        std::fs::create_dir_all(s.data("res/sub")).unwrap();
        std::fs::write(&file, "img").unwrap();
        std::fs::write(s.data("res/other.jpg"), "img").unwrap();
        assert_eq!(s.call("$znode.nativelibs.fileUtilitiesAddon.detectHardlinksAsync", vec![json!(file), json!(s.data("res"))]).unwrap(), json!([]));
        s.call("$znode.fs.link", vec![json!(file), json!(s.data("res/sub/b.jpg"))]).unwrap();
        let mut found: Vec<String> = serde_json::from_value(
            s.call("$znode.nativelibs.fileUtilitiesAddon.detectHardlinksAsync", vec![json!(file), json!(s.data("res/"))]).unwrap(),
        )
        .unwrap();
        found.sort();
        assert_eq!(found, vec![s.data("res/a.jpg"), s.data("res/sub/b.jpg")]);
        assert!(hardlinks(&file, &s.data("res"), 1).len() <= 1, "walk is bounded");
        assert!(hardlinks(&s.data("res/missing"), &s.data("res"), 10).is_empty());
    }

    #[test]
    fn disk_usage_reports_volume() {
        let s = Scratch::new();
        let u = s.call("$znode.nativelibs.fileUtilsAddon.getDiskUsage", vec![json!(s.data(""))]).unwrap();
        let (total, avail, used) = (u["total"].as_u64().unwrap(), u["available"].as_u64().unwrap(), u["used"].as_u64().unwrap());
        assert!(total > 0 && avail <= total && used == total - avail);
        assert_eq!(code(s.call("$znode.nativelibs.fileUtilsAddon.getDiskUsage", vec![json!(s.data("nope"))])), "ENOENT");
    }
}
