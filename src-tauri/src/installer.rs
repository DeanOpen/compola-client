//! Puts a verified Zalo runtime into a folder (port of `ZaloRuntimeInstaller.swift`): `runtime::current()` on first
//! launch, `runtime::pending()` for an upgrade.
//!
//! Sources, in order: an installed Zalo.app of the pinned version (no download), the pinned DMG, and — when that is
//! gone and allowed — the DMG zalo.me/pc offers now. Whatever the source, the whole Zalo.app must pass VNG's code
//! signature (nested code included, which covers app.asar and the helper app) before anything is copied.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::{Context, anyhow, bail, ensure};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::runtime::{self, Release};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step {
    Looking,
    Downloading { received: u64, total: Option<u64> },
    Verifying,
    Installing,
}

pub type Progress = Box<dyn Fn(Step) + Send + Sync>;

/// Zalo's Developer ID team (VNG ONLINE CO.,LTD) and Zalo.app's bundle identifier.
pub const REQUIREMENT: &str =
    r#"anchor apple generic and identifier "com.vng.zalo" and certificate leaf[subject.OU] = "CVB6BX97VM""#;
/// The same team, for the call helper (`ZaloHelper.app`).
pub const HELPER_REQUIREMENT: &str =
    r#"anchor apple generic and identifier "com.vng.zalo.zalocall" and certificate leaf[subject.OU] = "CVB6BX97VM""#;
/// zalo.me only redirects a Mac browser to the Mac installer.
const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";

// ---- public API ----

/// At launch, before anything reads the runtime: drops leftovers of interrupted installs and swaps in a prepared upgrade.
pub fn prepare_for_launch() {
    prepare_at(&runtime::root());
}

/// A runtime older than the pinned Zalo version is upgraded quietly in the background; the new one is swapped in at the
/// next launch. Never falls back to the latest DMG: an upgrade is only ever to the pinned, checksummed release.
pub fn upgrade_if_outdated(installed: &str) {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if !runtime::is_newer(runtime::PINNED_VERSION, installed) {
        return;
    }
    // A development runtime (`COMPOLA_ZALO_APP`) is not ours to upgrade.
    if std::env::var_os("COMPOLA_ZALO_APP").is_some() || STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let installed = installed.to_owned();
    tauri::async_runtime::spawn(async move {
        let installer = Installer { release: runtime::pinned(), allows_latest: false, work: runtime::work(), progress: Box::new(|_| {}) };
        match installer.install(&runtime::pending()).await {
            Ok(version) => log::info!("runtime: Zalo {version} ready, used from the next launch (now {installed})"),
            Err(e) => log::error!("runtime: upgrade to Zalo {} failed — {e:#}", runtime::PINNED_VERSION),
        }
    });
}

/// Installs into `destination`, replacing what is there; returns the Zalo version installed.
pub async fn install_into(destination: &Path, allows_latest: bool, progress: Progress) -> anyhow::Result<String> {
    Installer { release: runtime::pinned(), allows_latest, work: runtime::work(), progress }.install(destination).await
}

/// Installs from a local DMG (no download, no checksum: VNG's signature is still required). `work` is the `work`
/// folder next to `destination`, as in the runtime root.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) async fn install_from_dmg(dmg: &Path, destination: &Path, progress: Progress) -> anyhow::Result<String> {
    let work = destination.parent().context("destination has no parent")?.join("work");
    let installer = Installer { release: runtime::pinned(), allows_latest: false, work, progress };
    tokio::fs::create_dir_all(&installer.work).await?;
    (installer.progress)(Step::Looking);
    installer.install_from_disk_image(dmg, destination).await
}

// ---- launch-time folder swap ----

fn prepare_at(root: &Path) {
    let current = root.join("current");
    let pending = root.join("pending");
    let work = root.join("work");
    let _ = std::fs::remove_dir_all(&work);
    if !pending.exists() {
        return;
    }
    if !runtime::is_complete(&pending) {
        let _ = std::fs::remove_dir_all(&pending);
        return;
    }
    let retired = work.join(format!("retired-{}", uuid::Uuid::new_v4()));
    let swap = || -> std::io::Result<()> {
        std::fs::create_dir_all(&work)?;
        if current.exists() {
            std::fs::rename(&current, &retired)?;
        }
        std::fs::rename(&pending, &current)
    };
    match swap() {
        Ok(()) => log::info!("runtime: switched to Zalo {}", runtime::version_of(&current).as_deref().unwrap_or("?")),
        Err(e) => {
            // Keep the old runtime; the upgrade is prepared again later.
            if !current.exists() && retired.exists() {
                let _ = std::fs::rename(&retired, &current);
            }
            log::error!("runtime: upgrade not applied: {e}");
        }
    }
    let _ = std::fs::remove_dir_all(&retired);
}

// ---- installer ----

struct Installer {
    release: Release,
    /// Whether the DMG zalo.me/pc offers now may stand in when the pinned one cannot be had.
    allows_latest: bool,
    work: PathBuf,
    progress: Progress,
}

impl Installer {
    async fn install(&self, destination: &Path) -> anyhow::Result<String> {
        (self.progress)(Step::Looking);
        tokio::fs::create_dir_all(&self.work).await?;
        if cfg!(not(target_os = "macos")) {
            // Off macOS (the Linux server container): the official Windows installer of the pinned release. Its
            // SHA-256 (checked in `fetch`) stands in for VNG's signature; the renderer is read out of it in Rust
            // (`windows_installer`), so nothing (7-Zip…) has to be installed on the machine.
            let release = runtime::pinned_windows();
            let setup = RemoveOnDrop(self.work.join(format!("ZaloSetup-{}.exe", uuid::Uuid::new_v4())));
            self.fetch(&release, &setup.0).await?;
            return self.extract_renderer(&setup.0, &release.version, destination).await;
        }
        if let Some(local) = installed_zalo(&self.release.version) {
            match self.stage(&local, destination).await {
                Ok(version) => return Ok(version),
                Err(e) => log::error!("runtime: installed Zalo.app not usable: {e:#}"),
            }
        }
        let dmg = RemoveOnDrop(self.work.join(format!("ZaloSetup-{}.dmg", uuid::Uuid::new_v4())));
        match self.fetch(&self.release, &dmg.0).await {
            Ok(()) => {}
            Err(e) if self.allows_latest => {
                log::error!("runtime: Zalo {} unavailable: {e:#}", self.release.version);
                self.fetch(&latest_release().await?, &dmg.0).await?;
            }
            Err(e) => return Err(e),
        }
        self.install_from_disk_image(&dmg.0, destination).await
    }

    async fn fetch(&self, release: &Release, file: &Path) -> anyhow::Result<()> {
        let mut last: Option<u64> = None;
        // Download progress, at most once per MB so the window is not redrawn for every packet.
        let mut report = |received: u64, total: Option<u64>| {
            let due = received == 0 || Some(received) == total || last.is_none_or(|l| received >= l + (1 << 20));
            if due {
                last = Some(received);
                (self.progress)(Step::Downloading { received, total });
            }
        };
        report(0, None);
        let digest = match download(&client(None)?, &release.url, file, &mut report).await {
            Err(e) if is_dns_failure(&e) => {
                // Some ISP resolvers fail on *.zadn.vn; resolve over HTTPS as the media loader does.
                log::info!("runtime: system DNS failed for the Zalo download ({e:#}); resolving over HTTPS");
                download(&client(Some(Arc::new(DohResolver::new()?)))?, &release.url, file, &mut report).await?
            }
            other => other?,
        };
        (self.progress)(Step::Verifying);
        if let Some(expected) = &release.sha256 {
            ensure!(digest.eq_ignore_ascii_case(expected), "Bộ cài Zalo {} tải về không khớp mã kiểm tra.", release.version);
        }
        Ok(())
    }

    async fn install_from_disk_image(&self, dmg: &Path, destination: &Path) -> anyhow::Result<String> {
        let mut mount = Mount { path: self.work.join(format!("mount-{}", uuid::Uuid::new_v4())), attached: false };
        tokio::fs::create_dir_all(&mount.path).await?;
        let (mount_arg, dmg_arg) = (mount.path.to_string_lossy().into_owned(), dmg.to_string_lossy().into_owned());
        run(
            "/usr/bin/hdiutil",
            &["attach", "-nobrowse", "-readonly", "-noverify", "-noautoopen", "-mountpoint", &mount_arg, &dmg_arg],
        )
        .await?;
        mount.attached = true;
        let result = match zalo_app(&mount.path) {
            Ok(app) => self.stage(&app, destination).await,
            Err(e) => Err(e),
        };
        mount.detach().await;
        result
    }

    /// Off macOS: the Windows installer is NSIS → `$PLUGINSDIR/app-32.7z` → `Zalo-<version>/resources/app.asar`.
    /// Only `app.asar` is kept (Rust plays the main process; native modules and ZaloCall are not used), laid out as
    /// `Contents/Resources/app.asar` with a minimal `Contents/Info.plist` carrying the version, like the Mac runtime.
    async fn extract_renderer(&self, setup: &Path, version: &str, destination: &Path) -> anyhow::Result<String> {
        (self.progress)(Step::Installing);
        let staging = RemoveOnDrop(self.work.join(format!("staging-{}", uuid::Uuid::new_v4())));
        let target = staging.0.join("Contents/Resources/app.asar");
        tokio::fs::create_dir_all(target.parent().unwrap()).await?;
        let (setup_path, target_path) = (setup.to_owned(), target.clone());
        let built_in = tokio::task::spawn_blocking(move || windows_installer::extract_asar(&setup_path, &target_path)).await?;
        if let Err(e) = built_in {
            // A future installer that compresses its app archive: 7-Zip (from PATH or where it installs) still can.
            log::warn!("runtime: reading the Windows installer failed ({e:#}); trying 7-Zip");
            let seven_zip = windows_installer::find_7zip().ok_or_else(|| e.context("Không đọc được bộ cài Zalo (và không tìm thấy 7-Zip)"))?;
            let unpacked = RemoveOnDrop(self.work.join(format!("unpacked-{}", uuid::Uuid::new_v4())));
            let seven = seven_zip.to_string_lossy().into_owned();
            let out = format!("-o{}", unpacked.0.display());
            let setup_arg = setup.to_string_lossy().into_owned();
            run(&seven, &["x", "-y", "-bd", &out, &setup_arg, "$PLUGINSDIR/app-*.7z"]).await?;
            let archive = std::fs::read_dir(unpacked.0.join("$PLUGINSDIR"))?
                .filter_map(|e| e.ok().map(|e| e.path()))
                .find(|p| p.extension().is_some_and(|e| e == "7z"))
                .ok_or_else(|| anyhow!("Bộ cài Zalo không có gói ứng dụng."))?;
            let archive_arg = archive.to_string_lossy().into_owned();
            run(&seven, &["x", "-y", "-bd", &out, &archive_arg, "*/resources/app.asar"]).await?;
            let asar = std::fs::read_dir(&unpacked.0)?
                .filter_map(|e| e.ok().map(|e| e.path().join("resources/app.asar")))
                .find(|p| p.is_file())
                .ok_or_else(|| anyhow!("Không tìm thấy app.asar trong bộ cài Zalo."))?;
            tokio::fs::rename(&asar, &target).await?;
        }
        let mut info = plist::Dictionary::new();
        info.insert("CFBundleShortVersionString".into(), version.into());
        info.insert("CFBundleIdentifier".into(), "com.vng.zalo".into());
        plist::Value::Dictionary(info).to_file_xml(staging.0.join("Contents/Info.plist"))?;
        ensure!(runtime::is_complete(&staging.0), "Bản sao Zalo không đầy đủ.");
        if destination.exists() {
            let _ = tokio::fs::remove_dir_all(destination).await;
        }
        if let Some(parent) = destination.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::rename(&staging.0, destination).await?;
        log::info!("runtime: Zalo {version} installed (renderer) from the official Windows installer");
        Ok(version.to_owned())
    }

    /// Checks VNG's signature on the whole Zalo.app, then copies `runtime::PARTS` into `destination`.
    async fn stage(&self, app: &Path, destination: &Path) -> anyhow::Result<String> {
        (self.progress)(Step::Verifying);
        verify_signature(app, REQUIREMENT, true).await?;
        let version = runtime::version_of(app).ok_or_else(|| anyhow!("Không đọc được phiên bản Zalo."))?;
        (self.progress)(Step::Installing);
        let staging = RemoveOnDrop(self.work.join(format!("staging-{}", uuid::Uuid::new_v4())));
        let optional = runtime::OPTIONAL_PARTS.iter().filter(|p| app.join(p).exists());
        for part in runtime::PARTS.iter().chain(optional) {
            let target = staging.0.join(part);
            tokio::fs::create_dir_all(target.parent().unwrap()).await?;
            // ditto keeps the extended attributes some signed files carry.
            let (source, target) = (app.join(part).to_string_lossy().into_owned(), target.to_string_lossy().into_owned());
            run("/usr/bin/ditto", &[&source, &target]).await?;
        }
        verify_helper(&runtime::helper("ZaloCall", &staging.0)).await?;
        ensure!(runtime::is_complete(&staging.0), "Bản sao Zalo không đầy đủ.");
        if destination.exists() {
            let _ = tokio::fs::remove_dir_all(destination).await;
        }
        if let Some(parent) = destination.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::rename(&staging.0, destination).await?;
        // ~400 MB that can always be fetched again: not worth a place in Time Machine.
        let _ = run("/usr/bin/tmutil", &["addexclusion", &destination.to_string_lossy()]).await;
        log::info!("runtime: Zalo {version} installed from {}", app.display());
        Ok(version)
    }
}

/// An installed Zalo.app of exactly `version`: copying it saves the download.
fn installed_zalo(version: &str) -> Option<PathBuf> {
    let mut candidates = vec![PathBuf::from("/Applications/Zalo.app")];
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join("Applications/Zalo.app"));
    }
    candidates.into_iter().find(|app| runtime::version_of(app).as_deref() == Some(version))
}

/// The release zalo.me/pc offers now, read from its redirect (nothing is downloaded).
async fn latest_release() -> anyhow::Result<Release> {
    let not_found = || anyhow!("Không tìm thấy bản Zalo PC cho Mac trên zalo.me.");
    // No cookie store: the account's zalo.me cookies have no business on a download link.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(30))
        .build()?;
    let response = client.head(runtime::LATEST_LINK).header(reqwest::header::USER_AGENT, BROWSER_USER_AGENT).send().await?;
    let location = response.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok()).ok_or_else(not_found)?;
    let url = url::Url::parse(runtime::LATEST_LINK)?.join(location).map_err(|_| not_found())?;
    ensure!(url.scheme() == "https", not_found());
    let name = url.path_segments().and_then(|mut s| s.next_back()).unwrap_or_default();
    let version = runtime::version_from_installer_name(name).ok_or_else(not_found)?;
    Ok(Release { version, url: url.to_string(), sha256: None })
}

/// Full static validation (all architectures, strict; nested code with `deep`) against `requirement`.
async fn verify_signature(bundle: &Path, requirement: &str, deep: bool) -> anyhow::Result<()> {
    let requirement = format!("={requirement}");
    let bundle_arg = bundle.to_string_lossy().into_owned();
    let mut args = vec!["--verify", "--strict", "--all-architectures"];
    if deep {
        args.push("--deep");
    }
    args.extend(["-R", &requirement, &bundle_arg]);
    run("/usr/bin/codesign", &args)
        .await
        .map_err(|e| anyhow!("Bộ cài Zalo không có chữ ký hợp lệ của VNG nên Compola không dùng nó ({e:#})."))
}

/// `ZaloHelper.app` containing `executable` (`…/ZaloHelper.app/Contents/MacOS/ZaloCall`) is VNG's call helper.
async fn verify_helper(executable: &Path) -> anyhow::Result<()> {
    let bundle = executable.ancestors().nth(3).context("helper path")?;
    verify_signature(bundle, HELPER_REQUIREMENT, false)
        .await
        .map_err(|e| anyhow!("Trình gọi của Zalo không có chữ ký hợp lệ của VNG ({e:#})."))
}

/// The Zalo.app at the top of a mounted installer.
fn zalo_app(volume: &Path) -> anyhow::Result<PathBuf> {
    let is_zalo = |app: &Path| {
        plist::Value::from_file(app.join("Contents/Info.plist"))
            .ok()
            .and_then(|v| v.as_dictionary()?.get("CFBundleIdentifier")?.as_string().map(|s| s == "com.vng.zalo"))
            .unwrap_or(false)
    };
    std::fs::read_dir(volume)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .find(|p| p.extension().is_some_and(|x| x == "app") && is_zalo(p))
        .ok_or_else(|| anyhow!("Bộ cài không chứa Zalo.app."))
}

// ---- plumbing ----

fn client(resolver: Option<Arc<DohResolver>>) -> anyhow::Result<reqwest::Client> {
    // Ephemeral (no cookie store); a stalled transfer fails instead of hanging the setup screen forever.
    let mut builder = reqwest::Client::builder().connect_timeout(Duration::from_secs(30)).read_timeout(Duration::from_secs(60));
    if let Some(resolver) = resolver {
        builder = builder.dns_resolver(resolver);
    }
    Ok(builder.build()?)
}

/// Streams `url` into `file`; returns the SHA-256 (hex) of what was written.
async fn download(
    client: &reqwest::Client,
    url: &str,
    file: &Path,
    report: &mut impl FnMut(u64, Option<u64>),
) -> anyhow::Result<String> {
    let response = client.get(url).header(reqwest::header::USER_AGENT, BROWSER_USER_AGENT).send().await?;
    let status = response.status();
    ensure!(status.is_success(), "Máy chủ tải Zalo trả về lỗi HTTP {}.", status.as_u16());
    let total = response.content_length();
    let mut out = tokio::fs::File::create(file).await?;
    let mut hasher = Sha256::new();
    let mut received = 0u64;
    let mut body = response.bytes_stream();
    while let Some(chunk) = body.next().await {
        let chunk = chunk?;
        out.write_all(&chunk).await?;
        hasher.update(&chunk);
        received += chunk.len() as u64;
        report(received, total);
    }
    out.flush().await?;
    if let Some(total) = total {
        ensure!(received == total, "Bộ cài Zalo tải về bị thiếu ({received}/{total} byte).");
    }
    Ok(hex::encode(hasher.finalize()))
}

fn is_dns_failure(error: &anyhow::Error) -> bool {
    error.chain().any(|e| {
        let text = e.to_string().to_ascii_lowercase();
        text.contains("dns error") || text.contains("failed to lookup address") || text.contains("nodename nor servname")
    })
}

/// Runs a system tool to completion; its stderr becomes the error.
async fn run(tool: &str, args: &[&str]) -> anyhow::Result<()> {
    let output = tokio::process::Command::new(tool)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .output()
        .await
        .with_context(|| format!("cannot run {tool}"))?;
    if output.status.success() {
        return Ok(());
    }
    let name = Path::new(tool).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| tool.into());
    let message = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    let code = output.status.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".into());
    bail!("{name} lỗi {code}: {message}")
}

/// The Zalo Windows installer (electron-builder NSIS) read in Rust: electron-builder stores its `app-*.7z` in the NSIS
/// data without compressing it again, so the archive is found by its signature (checked against the NSIS block length
/// and the 7z start-header CRC) and read in place with a pure-Rust 7z decoder, which checks every CRC of `app.asar`.
pub(crate) mod windows_installer {
    use std::io::{Read, Seek, SeekFrom, Write};
    use std::path::{Path, PathBuf};

    use anyhow::{Context, anyhow, bail, ensure};

    const SIGNATURE: [u8; 6] = [b'7', b'z', 0xBC, 0xAF, 0x27, 0x1C];
    /// The NSIS block length's "compressed" flag.
    const COMPRESSED: u32 = 0x8000_0000;

    /// A 7z archive stored as is inside `file`: (offset, length). The largest one when there are several.
    pub fn embedded_7z(file: &mut (impl Read + Seek)) -> anyhow::Result<Option<(u64, u64)>> {
        let file_len = file.seek(SeekFrom::End(0))?;
        file.seek(SeekFrom::Start(0))?;
        let mut best: Option<(u64, u64)> = None;
        let mut buf = vec![0u8; 8 << 20];
        let mut carry: Vec<u8> = Vec::new();
        let mut base = 0u64; // file offset of carry[0]
        loop {
            let n = file.read(&mut buf)?;
            if n == 0 {
                break;
            }
            let mut window = std::mem::take(&mut carry);
            window.extend_from_slice(&buf[..n]);
            let mut hits = Vec::new();
            let mut from = 0;
            while let Some(i) = window[from..].windows(SIGNATURE.len()).position(|w| w == SIGNATURE) {
                hits.push(base + (from + i) as u64);
                from += i + 1;
            }
            let pos = file.stream_position()?;
            for at in hits {
                if let Some(len) = check(file, at, file_len)? {
                    if best.is_none_or(|b| len > b.1) {
                        best = Some((at, len));
                    }
                }
            }
            file.seek(SeekFrom::Start(pos))?;
            // Keep the tail so a signature across two reads is still seen.
            let keep = window.len().min(SIGNATURE.len() - 1);
            base += (window.len() - keep) as u64;
            carry = window[window.len() - keep..].to_vec();
        }
        Ok(best)
    }

    /// The archive's length when a valid 7z start header sits at `at`, preceded by an uncompressed NSIS block of
    /// exactly that length.
    fn check(file: &mut (impl Read + Seek), at: u64, file_len: u64) -> anyhow::Result<Option<u64>> {
        if at < 4 || at + 32 > file_len {
            return Ok(None);
        }
        let mut head = [0u8; 36];
        file.seek(SeekFrom::Start(at - 4))?;
        file.read_exact(&mut head)?;
        let block = u32::from_le_bytes(head[0..4].try_into()?);
        let h = &head[4..];
        if crc32fast::hash(&h[12..32]) != u32::from_le_bytes(h[8..12].try_into()?) {
            return Ok(None);
        }
        let next_offset = u64::from_le_bytes(h[12..20].try_into()?);
        let next_size = u64::from_le_bytes(h[20..28].try_into()?);
        let Some(len) = 32u64.checked_add(next_offset).and_then(|l| l.checked_add(next_size)) else { return Ok(None) };
        if block & COMPRESSED != 0 || u64::from(block) != len || at + len > file_len {
            return Ok(None);
        }
        Ok(Some(len))
    }

    /// A part of a file seen as a whole one (the 7z reader seeks from its own start).
    struct Window<R> {
        inner: R,
        start: u64,
        len: u64,
        pos: u64,
    }

    impl<R: Read + Seek> Read for Window<R> {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let n = buf.len().min(self.len.saturating_sub(self.pos) as usize);
            if n == 0 {
                return Ok(0);
            }
            self.inner.seek(SeekFrom::Start(self.start + self.pos))?;
            let read = self.inner.read(&mut buf[..n])?;
            self.pos += read as u64;
            Ok(read)
        }
    }

    impl<R: Read + Seek> Seek for Window<R> {
        fn seek(&mut self, to: SeekFrom) -> std::io::Result<u64> {
            let pos = match to {
                SeekFrom::Start(p) => p as i128,
                SeekFrom::End(d) => self.len as i128 + d as i128,
                SeekFrom::Current(d) => self.pos as i128 + d as i128,
            };
            if pos < 0 {
                return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "seek before start"));
            }
            self.pos = pos as u64;
            Ok(self.pos)
        }
    }

    /// Writes `<…>/resources/app.asar` of the installer `setup` to `target`.
    pub fn extract_asar(setup: &Path, target: &Path) -> anyhow::Result<()> {
        let mut file = std::io::BufReader::with_capacity(1 << 20, std::fs::File::open(setup).context("mở bộ cài Zalo")?);
        let (start, len) = embedded_7z(&mut file)?.ok_or_else(|| anyhow!("bộ cài không chứa gói 7z đọc trực tiếp được"))?;
        let window = Window { inner: file, start, len, pos: 0 };
        let mut reader = sevenz_rust2::ArchiveReader::new(window, sevenz_rust2::Password::empty()).map_err(|e| anyhow!("gói ứng dụng Zalo: {e}"))?;
        let name = reader
            .archive()
            .files
            .iter()
            .map(|f| f.name.replace('\\', "/"))
            .find(|n| n.ends_with("/resources/app.asar") || n == "resources/app.asar")
            .ok_or_else(|| anyhow!("không tìm thấy app.asar trong bộ cài Zalo"))?;
        let mut out = std::fs::File::create(target).with_context(|| format!("tạo {}", target.display()))?;
        let mut written: Option<u64> = None;
        reader
            .for_each_entries_with_decision(|entry, data| {
                if written.is_some() {
                    return Ok(sevenz_rust2::EntryDecision::Stop);
                }
                if entry.name.replace('\\', "/") != name {
                    return Ok(sevenz_rust2::EntryDecision::SkipBlock);
                }
                // Read to the end: `Continue` then checks the entry's CRC.
                written = Some(std::io::copy(data, &mut out)?);
                Ok(sevenz_rust2::EntryDecision::Continue)
            })
            .map_err(|e| anyhow!("giải nén app.asar: {e}"))?;
        out.flush()?;
        let size = written.ok_or_else(|| anyhow!("không đọc được app.asar"))?;
        ensure!(size > 1 << 20, "app.asar quá nhỏ ({size} byte)");
        let mut magic = [0u8; 4];
        std::fs::File::open(target)?.read_exact(&mut magic)?;
        if magic != [4, 0, 0, 0] {
            bail!("app.asar không hợp lệ");
        }
        Ok(())
    }

    /// 7-Zip's command line: on PATH, or where its installers put it (the official installer does not add itself to
    /// PATH on Windows).
    pub fn find_7zip() -> Option<PathBuf> {
        let names: &[&str] = if cfg!(windows) { &["7z.exe", "7zz.exe", "7za.exe"] } else { &["7z", "7zz", "7za"] };
        let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
        if cfg!(windows) {
            for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
                if let Some(d) = std::env::var_os(var) {
                    dirs.push(PathBuf::from(d).join("7-Zip"));
                }
            }
            if let Some(d) = std::env::var_os("LOCALAPPDATA") {
                dirs.push(PathBuf::from(d).join("Programs").join("7-Zip"));
            }
            if let Some(d) = std::env::var_os("USERPROFILE") {
                dirs.push(PathBuf::from(d).join("scoop").join("shims"));
            }
            if let Some(d) = std::env::var_os("ProgramData") {
                dirs.push(PathBuf::from(d).join("chocolatey").join("bin"));
            }
        } else {
            dirs.extend(["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"].map(PathBuf::from));
        }
        dirs.iter().flat_map(|d| names.iter().map(move |n| d.join(n))).find(|p| p.is_file())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// A fake installer: junk, an NSIS block length, a stored 7z holding `Zalo-1.0.0/resources/app.asar`.
        fn fake_installer(asar: &[u8]) -> Vec<u8> {
            let dir = std::env::temp_dir().join(format!("compola-nsis-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(dir.join("Zalo-1.0.0/resources")).unwrap();
            std::fs::write(dir.join("Zalo-1.0.0/resources/app.asar"), asar).unwrap();
            std::fs::write(dir.join("Zalo-1.0.0/LICENSE"), b"license").unwrap();
            let archive = dir.with_extension("7z");
            sevenz_rust2::compress_to_path(&dir, &archive).unwrap();
            let seven = std::fs::read(&archive).unwrap();
            let _ = std::fs::remove_dir_all(&dir);
            let _ = std::fs::remove_file(&archive);
            let mut exe = b"MZ fake stub ".repeat(1000);
            // A stray signature with a bad header must be ignored.
            exe.extend_from_slice(&SIGNATURE);
            exe.extend_from_slice(&[0u8; 40]);
            exe.extend_from_slice(&(seven.len() as u32).to_le_bytes());
            exe.extend_from_slice(&seven);
            exe.extend_from_slice(b"trailing NSIS data");
            exe
        }

        fn asar_bytes() -> Vec<u8> {
            let mut a = vec![4u8, 0, 0, 0];
            a.extend((0..3_000_000u32).map(|i| (i % 251) as u8));
            a
        }

        #[test]
        fn reads_app_asar_without_7zip() {
            let asar = asar_bytes();
            let exe = fake_installer(&asar);
            let dir = std::env::temp_dir().join(format!("compola-nsis-out-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let (setup, target) = (dir.join("ZaloSetup.exe"), dir.join("app.asar"));
            std::fs::write(&setup, &exe).unwrap();
            extract_asar(&setup, &target).unwrap();
            assert_eq!(std::fs::read(&target).unwrap(), asar);
            let _ = std::fs::remove_dir_all(dir);
        }

        #[test]
        fn compressed_or_mismatched_blocks_are_not_used() {
            let exe = fake_installer(&asar_bytes());
            let at = exe.windows(6).rposition(|w| w == SIGNATURE).unwrap();
            let mut flagged = exe.clone();
            flagged[at - 1] |= 0x80;
            assert!(embedded_7z(&mut std::io::Cursor::new(flagged)).unwrap().is_none());
            let mut wrong = exe.clone();
            wrong[at - 4] ^= 1;
            assert!(embedded_7z(&mut std::io::Cursor::new(wrong)).unwrap().is_none());
            assert_eq!(embedded_7z(&mut std::io::Cursor::new(exe)).unwrap().map(|x| x.0), Some(at as u64));
            assert!(embedded_7z(&mut std::io::Cursor::new(b"no archive here".to_vec())).unwrap().is_none());
        }

        /// The real pinned installer: `COMPOLA_ZALO_WIN_SETUP=<ZaloSetup-26.10.20.exe> cargo test -- --ignored`.
        #[test]
        #[ignore]
        fn reads_the_real_zalo_installer() {
            let Some(setup) = std::env::var_os("COMPOLA_ZALO_WIN_SETUP") else { return };
            let target = std::env::temp_dir().join(format!("compola-real-asar-{}", uuid::Uuid::new_v4()));
            extract_asar(Path::new(&setup), &target).unwrap();
            assert!(std::fs::metadata(&target).unwrap().len() > 100 << 20);
            let _ = std::fs::remove_file(target);
        }
    }
}

/// A file or folder in `work` that goes away however the install ends (including a dropped future).
struct RemoveOnDrop(PathBuf);

impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        if self.0.is_dir() {
            let _ = std::fs::remove_dir_all(&self.0);
        } else {
            let _ = std::fs::remove_file(&self.0);
        }
    }
}

/// A mounted installer image: always detached, even when the install is cancelled.
struct Mount {
    path: PathBuf,
    attached: bool,
}

impl Mount {
    async fn detach(&mut self) {
        if std::mem::take(&mut self.attached) {
            let path = self.path.to_string_lossy().into_owned();
            if let Err(e) = run("/usr/bin/hdiutil", &["detach", &path, "-force"]).await {
                log::error!("runtime: {e:#}");
            }
        }
        let _ = tokio::fs::remove_dir(&self.path).await;
    }
}

impl Drop for Mount {
    fn drop(&mut self) {
        if self.attached {
            let _ = std::process::Command::new("/usr/bin/hdiutil")
                .args(["detach", "-force"])
                .arg(&self.path)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
        let _ = std::fs::remove_dir(&self.path);
    }
}

/// DNS-over-HTTPS (JSON API) for hosts the system resolver cannot find; TLS is still checked against the host name.
/// The hostname endpoints normally resolve through the system resolver; the IP-literal ones are the last resort.
struct DohResolver {
    client: reqwest::Client,
}

impl DohResolver {
    const ENDPOINTS: [&str; 4] = [
        "https://dns.google/resolve",
        "https://cloudflare-dns.com/dns-query",
        "https://8.8.8.8/resolve",
        "https://1.1.1.1/dns-query",
    ];

    fn new() -> anyhow::Result<Self> {
        let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(5)).timeout(Duration::from_secs(8)).build()?;
        Ok(Self { client })
    }

    async fn lookup(client: reqwest::Client, host: String) -> anyhow::Result<Vec<Ipv4Addr>> {
        for endpoint in Self::ENDPOINTS {
            let request = client.get(endpoint).query(&[("name", host.as_str()), ("type", "A")]).header("Accept", "application/dns-json");
            let Ok(response) = request.send().await else { continue };
            let Ok(body) = response.bytes().await else { continue };
            let Ok(reply) = serde_json::from_slice::<serde_json::Value>(&body) else { continue };
            let addresses: Vec<Ipv4Addr> = reply["Answer"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|a| a["type"].as_u64() == Some(1))
                .filter_map(|a| a["data"].as_str()?.parse().ok())
                .collect();
            if !addresses.is_empty() {
                return Ok(addresses);
            }
            if reply["Status"].as_u64() == Some(3) {
                bail!("DoH: no A record for {host}");
            }
        }
        bail!("DoH: all resolvers failed for {host}")
    }
}

impl reqwest::dns::Resolve for DohResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let (client, host) = (self.client.clone(), name.as_str().to_owned());
        Box::pin(async move {
            let addresses = Self::lookup(client, host).await.map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { e.into() })?;
            let addrs: reqwest::dns::Addrs = Box::new(addresses.into_iter().map(|ip| SocketAddr::new(IpAddr::V4(ip), 0)));
            Ok(addrs)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("compola-runtime-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&root).unwrap();
            Self(root)
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// The files `runtime::is_complete` looks for.
    fn make_runtime(dir: &Path, version: &str) {
        std::fs::create_dir_all(dir.join("Contents/Resources")).unwrap();
        let mut info = plist::Dictionary::new();
        info.insert("CFBundleShortVersionString".into(), version.into());
        plist::Value::Dictionary(info).to_file_xml(dir.join("Contents/Info.plist")).unwrap();
        std::fs::write(dir.join("Contents/Resources/app.asar"), "asar").unwrap();
        let helper = runtime::helper("ZaloCall", dir);
        std::fs::create_dir_all(helper.parent().unwrap()).unwrap();
        std::fs::write(&helper, "#!/bin/sh\n").unwrap();
        crate::sys::set_mode(&helper, 0o755);
    }

    #[test]
    fn reads_version_from_installer_name() {
        assert_eq!(runtime::version_from_installer_name("ZaloSetup-universal-26.10.20.dmg").as_deref(), Some("26.10.20"));
        assert_eq!(runtime::version_from_installer_name("ZaloSetup-universal-26.10.20-RC4.zip"), None);
        assert_eq!(runtime::version_from_installer_name("Zalo-3.2.64.dmg"), None);
        let pinned = runtime::pinned();
        let name = pinned.url.rsplit('/').next().unwrap();
        assert_eq!(runtime::version_from_installer_name(name), Some(pinned.version));
    }

    #[test]
    fn compares_versions_numerically() {
        assert!(runtime::is_newer("26.10.20", "26.9.10"));
        assert!(runtime::is_newer("27.1.5", "26.12.31"));
        assert!(!runtime::is_newer("26.10.20", "26.10.20"));
        assert!(!runtime::is_newer("26.10", "26.10.0"));
        assert!(!runtime::is_newer("26.9.10", "26.10.20"));
    }

    // macOS only: elsewhere the runtime is the renderer alone (ZaloCall is a macOS program, not required).
    #[cfg(target_os = "macos")]
    #[test]
    fn completeness_requires_executable_call_helper() {
        let root = TempRoot::new();
        let dir = root.0.join("current");
        make_runtime(&dir, "26.10.20");
        assert!(runtime::is_complete(&dir));
        let helper = runtime::helper("ZaloCall", &dir);
        crate::sys::set_mode(&helper, 0o644);
        assert!(!runtime::is_complete(&dir));
        std::fs::remove_file(&helper).unwrap();
        assert!(!runtime::is_complete(&dir));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn completeness_off_macos_needs_only_the_renderer() {
        let root = TempRoot::new();
        let dir = root.0.join("current");
        make_runtime(&dir, "26.10.20");
        std::fs::remove_dir_all(dir.join("Contents/ZaloHelper.app")).unwrap();
        assert!(runtime::is_complete(&dir));
        std::fs::remove_file(dir.join("Contents/Resources/app.asar")).unwrap();
        assert!(!runtime::is_complete(&dir));
    }

    #[test]
    fn launch_swaps_in_prepared_upgrade() {
        let root = TempRoot::new();
        make_runtime(&root.0.join("current"), "26.9.10");
        make_runtime(&root.0.join("pending"), "26.10.20");
        std::fs::create_dir_all(root.0.join("work/staging-x")).unwrap();

        prepare_at(&root.0);

        assert_eq!(runtime::version_of(&root.0.join("current")).as_deref(), Some("26.10.20"));
        assert!(runtime::is_complete(&root.0.join("current")));
        assert!(!root.0.join("pending").exists());
        let leftovers = std::fs::read_dir(root.0.join("work")).map(|d| d.count()).unwrap_or(0);
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn launch_swaps_in_upgrade_without_current() {
        let root = TempRoot::new();
        make_runtime(&root.0.join("pending"), "26.10.20");

        prepare_at(&root.0);

        assert_eq!(runtime::version_of(&root.0.join("current")).as_deref(), Some("26.10.20"));
        assert!(!root.0.join("pending").exists());
    }

    #[test]
    fn launch_drops_incomplete_upgrade() {
        let root = TempRoot::new();
        make_runtime(&root.0.join("current"), "26.9.10");
        std::fs::create_dir_all(root.0.join("pending/Contents")).unwrap();

        prepare_at(&root.0);

        assert_eq!(runtime::version_of(&root.0.join("current")).as_deref(), Some("26.9.10"));
        assert!(!root.0.join("pending").exists());
    }

    #[test]
    fn launch_without_pending_only_cleans_work() {
        let root = TempRoot::new();
        make_runtime(&root.0.join("current"), "26.9.10");
        std::fs::create_dir_all(root.0.join("work/mount-x")).unwrap();

        prepare_at(&root.0);

        assert_eq!(runtime::version_of(&root.0.join("current")).as_deref(), Some("26.9.10"));
        assert!(!root.0.join("work").exists());
    }

    #[tokio::test]
    async fn refuses_apps_not_signed_by_vng() {
        assert!(verify_signature(Path::new("/System/Applications/Calculator.app"), REQUIREMENT, true).await.is_err());
        assert!(verify_signature(Path::new("/nonexistent/Zalo.app"), REQUIREMENT, true).await.is_err());
    }

    #[tokio::test]
    async fn installed_zalo_passes_signature_when_present() {
        let app = Path::new("/Applications/Zalo.app");
        if !app.exists() {
            return;
        }
        verify_signature(app, REQUIREMENT, true).await.unwrap();
        verify_helper(&runtime::helper("ZaloCall", app)).await.unwrap();
        // The helper is not Zalo.app itself.
        assert!(verify_signature(app, HELPER_REQUIREMENT, false).await.is_err());
    }

    #[test]
    fn finds_no_zalo_app_in_empty_volume() {
        let root = TempRoot::new();
        assert!(zalo_app(&root.0).is_err());
    }

    /// The whole DMG path (mount, signature, copy, detach) against the official pinned DMG:
    /// `COMPOLA_ZALO_DMG=/path/to/ZaloSetup-universal-<pinned>.dmg cargo test -- --ignored installs_from_official_disk_image`
    #[tokio::test]
    #[ignore = "needs the official Zalo DMG on disk (COMPOLA_ZALO_DMG)"]
    async fn installs_from_official_disk_image() {
        let dmg = PathBuf::from(std::env::var_os("COMPOLA_ZALO_DMG").expect("set COMPOLA_ZALO_DMG"));
        let mut file = std::fs::File::open(&dmg).unwrap();
        let mut hasher = Sha256::new();
        std::io::copy(&mut file, &mut hasher).unwrap();
        assert_eq!(hex::encode(hasher.finalize()), runtime::PINNED_SHA256, "not the pinned DMG");

        let root = TempRoot::new();
        let destination = root.0.join("current");
        let steps = Arc::new(Mutex::new(Vec::new()));
        let log = steps.clone();
        let version = install_from_dmg(&dmg, &destination, Box::new(move |s| log.lock().unwrap().push(s))).await.unwrap();

        assert_eq!(version, runtime::PINNED_VERSION);
        assert!(runtime::is_complete(&destination));
        let info = runtime::locate(&destination).unwrap();
        assert!(info.asar.contains("pc-dist/index.html"));
        verify_helper(&runtime::helper("ZaloCall", &destination)).await.unwrap();
        assert!(runtime::is_executable_file(&runtime::helper("ZaloCap", &destination)));
        let steps = steps.lock().unwrap().clone();
        assert!(steps.contains(&Step::Verifying) && steps.contains(&Step::Installing));
        let leftovers: Vec<_> = std::fs::read_dir(root.0.join("work")).unwrap().flatten().map(|e| e.file_name()).collect();
        assert!(leftovers.is_empty(), "work not cleaned: {leftovers:?}");
    }

    /// zalo.me still redirects a Mac to a DMG whose name carries the version (a HEAD request, nothing downloaded).
    #[tokio::test]
    #[ignore = "network"]
    async fn zalo_me_offers_mac_installer() {
        let latest = latest_release().await.unwrap();
        assert!(latest.url.ends_with(".dmg"));
        assert!(!runtime::is_newer(runtime::PINNED_VERSION, &latest.version));
    }
}
