fn main() {
    ensure_fingerprint_helper();
    // The Compola Server admin console is embedded (`include_dir!`): rebuild when `npm run build:admin` changed it.
    println!("cargo:rerun-if-changed=admin-dist");
    println!("cargo:rerun-if-changed=web-dist");
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows_attributes()))
        .expect("failed to run tauri-build");
}

/// tauri-build embeds its app manifest (Common Controls v6, which the dialog APIs import from) into the app binary
/// only: a test executable then fails to load (`STATUS_ENTRYPOINT_NOT_FOUND`). The linker embeds the same manifest
/// into every artifact instead, tests included.
fn windows_attributes() -> tauri_build::WindowsAttributes {
    if !std::env::var("TARGET").is_ok_and(|t| t.ends_with("-windows-msvc")) {
        return tauri_build::WindowsAttributes::new();
    }
    let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed=windows-app-manifest.xml");
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    tauri_build::WindowsAttributes::new_without_app_manifest()
}

/// tauri-build refuses to build when a `bundle.externalBin` file is missing. On a fresh checkout, build the Go
/// fingerprint helper for this target (`scripts/build-fingerprint-helper.sh`); without Go, leave a stub that exits
/// at once, so the app still builds and runs on its fallback stack (reqwest / tokio-tungstenite).
fn ensure_fingerprint_helper() {
    use std::path::PathBuf;
    let (Ok(target), Ok(manifest)) = (std::env::var("TARGET"), std::env::var("CARGO_MANIFEST_DIR")) else { return };
    let manifest = PathBuf::from(manifest);
    let exe = if target.contains("windows") { ".exe" } else { "" };
    let binary = manifest.join("binaries").join(format!("compola-fingerprint-helper-{target}{exe}"));
    if binary.exists() {
        return;
    }
    // Through bash: Windows cannot execute a shell script directly (Git Bash provides `bash` there).
    let script = manifest.join("../scripts/build-fingerprint-helper.sh");
    let status = std::process::Command::new("bash").arg(&script).arg(&target).status();
    if binary.exists() {
        return;
    }
    println!(
        "cargo:warning=fingerprint helper not built ({status:?}); installed a stub — run scripts/build-fingerprint-helper.sh"
    );
    let _ = std::fs::create_dir_all(manifest.join("binaries"));
    let stub = "#!/bin/sh\necho 'compola-fingerprint-helper stub: run scripts/build-fingerprint-helper.sh' >&2\nexit 1\n";
    if std::fs::write(&binary, stub).is_ok() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755));
        }
    }
}
