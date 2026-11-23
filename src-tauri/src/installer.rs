//! Puts a verified Zalo runtime into a folder (port of `ZaloRuntimeInstaller.swift`). TODO(port): full port.

use std::path::Path;

pub enum Step {
    Looking,
    Downloading { received: u64, total: Option<u64> },
    Verifying,
    Installing,
}

pub type Progress = Box<dyn Fn(Step) + Send + Sync>;

/// At launch, before anything reads the runtime: drops leftovers of interrupted installs and swaps in a prepared upgrade.
pub fn prepare_for_launch() {}

/// A runtime older than the pinned Zalo version is upgraded quietly in the background.
pub fn upgrade_if_outdated(_installed: &str) {}

/// Installs into `destination`, replacing what is there; returns the Zalo version installed.
pub async fn install_into(_destination: &Path, _allows_latest: bool, progress: Progress) -> anyhow::Result<String> {
    progress(Step::Looking);
    anyhow::bail!("runtime installer not ported yet — set COMPOLA_ZALO_APP to a Zalo.app")
}
