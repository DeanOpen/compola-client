//! Opening a file attachment (Swift `FileCard.open` / `mayExecute`, `MessageBubble.swift`): download it through the
//! client stack into the file cache, then open it with the default app — unless it could run code, in which case it
//! is only revealed in Finder.

use std::io::Read;
use std::path::Path;

/// Extensions Swift blocked by name.
const BLOCKED: &[&str] = &[
    "command", "tool", "terminal", "fileloc", "webloc", "inetloc", "pkg", "mpkg", "app", "scpt", "scptd", "workflow", "action", "sh",
    "bash", "zsh", "csh", "ksh", "jar", "dylib", "bundle",
];

/// What Swift additionally caught through UTType conformance (`.executable`, `.applicationBundle`, `.package`,
/// `.shellScript`, `.script`, `.internetLocation`, installer packages, script binaries), spelled out by extension
/// because there is no UTType database here.
const CONFORMING: &[&str] = &[
    // executables / libraries (incl. Windows ones, which macOS would hand to an emulator or wine)
    "exe", "com", "bat", "cmd", "msi", "msix", "msp", "scr", "pif", "cpl", "dll", "so", "o", "elf", "run", "out", "lnk", "reg", "hta",
    "msc", "jnlp", "application", "gadget",
    // bundles and packages
    "framework", "plugin", "kext", "prefpane", "qlgenerator", "saver", "wdgt", "xpc", "appex", "mdimporter", "rtfd", "shortcut",
    "osax", "component", "vst", "vst3", "mpkg",
    // scripts
    "tcsh", "fish", "py", "pyw", "pyc", "pl", "pm", "rb", "php", "js", "mjs", "cjs", "jse", "vbs", "vbe", "wsf", "wsh", "ps1", "psm1",
    "lua", "tcl", "applescript", "awk", "ahk", "r", "swift",
    // internet locations
    "url", "afploc", "ftploc", "mailloc", "newsloc", "atloc",
];

fn extension_of(name: &str) -> String {
    let base = name.rsplit('/').next().unwrap_or(name);
    match base.rfind('.') {
        Some(i) if i > 0 && i + 1 < base.len() => base[i + 1..].trim().to_ascii_lowercase(),
        _ => String::new(),
    }
}

/// Mach-O / fat binary, or a `#!` script — runnable whatever its name says.
fn looks_executable(head: &[u8]) -> bool {
    const MAGICS: &[[u8; 4]] = &[
        [0xFE, 0xED, 0xFA, 0xCE],
        [0xFE, 0xED, 0xFA, 0xCF],
        [0xCE, 0xFA, 0xED, 0xFE],
        [0xCF, 0xFA, 0xED, 0xFE],
        [0xCA, 0xFE, 0xBA, 0xBE],
        [0xBE, 0xBA, 0xFE, 0xCA],
    ];
    head.starts_with(b"#!") || (head.len() >= 4 && MAGICS.iter().any(|m| head[..4] == m[..]))
}

/// Swift `mayExecute(_:displayName:)`: by the cached file's extension or the name the sender gave it — plus a look
/// at the first bytes (not in Swift: a script or Mach-O binary under a harmless name is caught too).
pub fn may_execute(file: &Path, display_name: &str) -> bool {
    let from_file = file.file_name().map(|n| extension_of(&n.to_string_lossy())).unwrap_or_default();
    for ext in [from_file, extension_of(display_name)] {
        if !ext.is_empty() && (BLOCKED.contains(&ext.as_str()) || CONFORMING.contains(&ext.as_str())) {
            return true;
        }
    }
    let mut head = [0u8; 4];
    let n = std::fs::File::open(file).and_then(|mut f| f.read(&mut head)).unwrap_or(0);
    looks_executable(&head[..n])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(dir: &Path, name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    }

    #[test]
    fn executables_and_scripts_are_only_revealed() {
        let dir = std::env::temp_dir().join(format!("compola-open-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let pdf = file(&dir, "abc.pdf", b"%PDF-1.7");
        assert!(!may_execute(&pdf, "Report.pdf"));
        assert!(!may_execute(&file(&dir, "abc.docx", b"PK\x03\x04"), "Hợp đồng.docx"));
        assert!(!may_execute(&file(&dir, "abc", b"PK\x03\x04"), "photos.zip"));
        // By the cached file's extension or by the display name.
        assert!(may_execute(&file(&dir, "abc.command", b"echo"), "notes.txt"));
        assert!(may_execute(&pdf, "invoice.pdf.app"));
        assert!(may_execute(&pdf, "Setup.EXE"));
        assert!(may_execute(&pdf, "run.sh"));
        assert!(may_execute(&pdf, "helper.py"));
        assert!(may_execute(&pdf, "link.webloc"));
        assert!(may_execute(&pdf, "Installer.pkg"));
        assert!(may_execute(&pdf, "tool.jar"));
        // By content.
        assert!(may_execute(&file(&dir, "abc.txt", b"#!/bin/sh\nrm -rf ~"), "readme.txt"));
        assert!(may_execute(&file(&dir, "def", &[0xCF, 0xFA, 0xED, 0xFE, 7, 0, 0, 1]), "document"));
        assert!(!may_execute(&dir.join("missing.txt"), "missing.txt"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn extensions() {
        assert_eq!(extension_of("a.TAR.GZ"), "gz");
        assert_eq!(extension_of(".bashrc"), "");
        assert_eq!(extension_of("noext"), "");
        assert_eq!(extension_of("dir.app/inner"), "");
        assert_eq!(extension_of("trailing."), "");
    }
}
