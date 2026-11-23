//! `$zFileManager` — preload-local file helpers (port of `FileManagerBridge` in `BridgeImplementation.swift`).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::json;

use super::{Registry, node_error};
use crate::platform::Platform;
use crate::values::{ArgsExt, array_buffer, bytes, undef};

pub fn install(reg: &mut Registry, platform: &Arc<Platform>) {
    reg.sync("$zFileManager.getSentryConfig", |_, _| Ok(undef()));
    reg.async_("$zFileManager.saveSentryConfig", |_, _| async { Ok(undef()) });

    // Viewer key: <userData>/z_u.txt; must reject when missing.
    let p = platform.clone();
    reg.async_("$zFileManager.getViewerkey", move |_, a| {
        let dir = a.string_at(0).map(PathBuf::from).unwrap_or_else(|| p.user_data.clone());
        async move { std::fs::read_to_string(dir.join("z_u.txt")).map(|s| json!(s)).map_err(|_| "z_u.txt not found".to_owned()) }
    });
    let p = platform.clone();
    reg.async_("$zFileManager.writeRecentId", move |_, a| {
        let file = p.user_data.join("z_u.txt");
        let text = a.string_at(0).unwrap_or_default();
        async move { std::fs::write(file, text).map(|_| undef()).map_err(|e| e.to_string()) }
    });

    // Client-side log files (zlog / QoS / action log). Kept local; never uploaded.
    let log_dir = platform.user_data.join("cal");
    let log_path = {
        let d = log_dir.clone();
        move |name: &str| d.join(Path::new(name).file_name().map(|s| s.to_owned()).unwrap_or_else(|| "z.log".into()))
    };
    {
        let (d, lp) = (log_dir.clone(), log_path.clone());
        reg.async_("$zFileManager.writeZLog", move |_, a| {
            let url = lp(a.str_at(0).unwrap_or("z.log"));
            let data = a.bytes_at(1).unwrap_or_default();
            let overwrite = a.obj_at(2).and_then(|o| o.get("overwrite")).and_then(|v| v.as_bool()).unwrap_or(false);
            let d = d.clone();
            async move {
                std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
                if overwrite || !url.exists() {
                    std::fs::write(&url, data).map_err(|e| e.to_string())?;
                } else {
                    std::fs::OpenOptions::new().append(true).open(&url).and_then(|mut f| f.write_all(&data)).map_err(|e| e.to_string())?;
                }
                Ok(undef())
            }
        });
    }
    {
        let (d, lp) = (log_dir.clone(), log_path.clone());
        reg.async_("$zFileManager.writeZLogBetween", move |_, a| {
            let url = lp(a.str_at(0).unwrap_or("z.log"));
            let data = a.bytes_at(1).unwrap_or_default();
            let d = d.clone();
            async move {
                std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
                std::fs::OpenOptions::new().create(true).append(true).open(&url).and_then(|mut f| f.write_all(&data)).map_err(|e| e.to_string())?;
                Ok(undef())
            }
        });
    }
    {
        let lp = log_path.clone();
        reg.async_("$zFileManager.readZLog", move |_, a| {
            let url = lp(a.str_at(0).unwrap_or(""));
            async move { Ok(std::fs::read_to_string(url).map(|s| json!(s)).unwrap_or_else(|_| undef())) }
        });
    }
    {
        let d = log_dir.clone();
        reg.async_("$zFileManager.scandirLog", move |_, _| {
            let d = d.clone();
            async move {
                let names: Vec<String> = std::fs::read_dir(d)
                    .map(|it| it.filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned())).collect())
                    .unwrap_or_default();
                Ok(json!(names))
            }
        });
    }
    reg.async_("$zFileManager.getExtraLogFiles", |_, _| async { Ok(json!([])) });
    for name in ["getQosLog", "getActionLog", "readUptimeLog"] {
        reg.async_(&format!("$zFileManager.{name}"), |_, _| async { Ok(json!("")) });
    }
    for name in [
        "removeQosLog", "removeActionLog", "writeActionLog", "writeUptimeLog", "truncateFileUpto", "cleanupLogFileDescriptors",
        "initBinaryLogFile", "sealCalfLog", "mergeCalfLogGroup", "writeLogRange", "trustBlob",
    ] {
        reg.async_(&format!("$zFileManager.{name}"), |_, _| async { Ok(undef()) });
    }
    reg.async_("$zFileManager.getInstallSource", |_, _| async { Err(node_error("ENOENT", "install source")) });

    // File access for attachments the user picked (paths come from open panels).
    reg.async_("$zFileManager.getFileArrayBuffer", |_, a| {
        let path = a.string_at(0).unwrap_or_default();
        async move { std::fs::read(&path).map(|d| array_buffer(&d)).map_err(|_| node_error("ENOENT", &path)) }
    });
    reg.async_("$zFileManager.readFileAsync", |_, a| {
        let path = a.string_at(0).unwrap_or_default();
        let as_text = a.value_at(1).is_some();
        async move {
            let d = std::fs::read(&path).map_err(|_| node_error("ENOENT", &path))?;
            Ok(if as_text { json!(String::from_utf8_lossy(&d)) } else { bytes(&d) })
        }
    });
    reg.async_("$zFileManager.svcStatAsync", |_, a| {
        let path = a.string_at(0).unwrap_or_default();
        async move { std::fs::metadata(&path).map(|m| json!({ "size": m.len() })).map_err(|e| node_error("ENOENT", e)) }
    });
    let p = platform.clone();
    reg.async_("$zFileManager.writeBufferToPath", move |_, a| {
        let target = a.string_at(0).unwrap_or_default();
        let data = a.bytes_at(1).unwrap_or_default();
        let ok = p.is_writable(&target);
        async move {
            if !ok {
                return Err(node_error("EACCES", &target));
            }
            if let Some(parent) = Path::new(&target).parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(&target, data).map_err(|e| e.to_string())?;
            Ok(json!(true))
        }
    });
}
