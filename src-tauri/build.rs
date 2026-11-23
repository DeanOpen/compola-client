fn main() {
    ensure_fingerprint_helper();
    tauri_build::build()
}

/// tauri-build refuses to build when a `bundle.externalBin` file is missing. On a fresh checkout, build the Go
/// fingerprint helper for this target (`scripts/build-fingerprint-helper.sh`); without Go, leave a stub that exits
/// at once, so the app still builds and runs on its fallback stack (reqwest / tokio-tungstenite).
fn ensure_fingerprint_helper() {
    use std::path::PathBuf;
    let (Ok(target), Ok(manifest)) = (std::env::var("TARGET"), std::env::var("CARGO_MANIFEST_DIR")) else { return };
    let manifest = PathBuf::from(manifest);
    let binary = manifest.join("binaries").join(format!("compola-fingerprint-helper-{target}"));
    if binary.exists() {
        return;
    }
    let script = manifest.join("../scripts/build-fingerprint-helper.sh");
    let status = std::process::Command::new(&script).arg(&target).status();
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
