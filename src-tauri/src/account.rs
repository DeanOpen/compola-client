//! Several Zalo accounts in one Compola — the account registry, ids and per-account paths (docs/multi-account.md
//! §1, §2, §9). Pure file logic: everything takes the data root, so tests never touch the user's
//! `~/Library/Application Support/Compola`.
//!
//! ```text
//! accounts.json                  {version, active, maxAccounts, accounts: [{id, uid, name, label, avatar, order, enabled, addedAt}]}
//! ZaloData/  cookies.json        the `default` account (the layout from before multi-account: nothing moves)
//! Accounts/<id>/ZaloData/        each account added later
//! Accounts/<id>/cookies.json
//! ```

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const DEFAULT_ID: &str = "default";
pub const DEFAULT_MAX_ACCOUNTS: usize = 5;
pub const REGISTRY_FILE: &str = "accounts.json";
pub const ACCOUNTS_DIR: &str = "Accounts";
const VERSION: u32 = 1;

/// `default` or `a` + 8 lowercase hex: ids end up in paths, webview labels and origins.
pub fn valid_id(id: &str) -> bool {
    id == DEFAULT_ID
        || (id.len() == 9 && id.starts_with('a') && id[1..].chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)))
}

fn new_id(taken: &[&str]) -> String {
    loop {
        let id = format!("a{:08x}", rand::random::<u32>());
        if !taken.contains(&id.as_str()) {
            return id;
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------------------------------

/// Where an account lives on disk and in WebKit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountPaths {
    pub id: String,
    /// `<root>` for `default`, `<root>/Accounts/<id>` otherwise.
    pub data_root: PathBuf,
}

impl AccountPaths {
    pub fn new(root: &Path, id: &str) -> Self {
        let data_root = if id == DEFAULT_ID { root.to_path_buf() } else { root.join(ACCOUNTS_DIR).join(id) };
        Self { id: id.to_owned(), data_root }
    }

    pub fn is_default(&self) -> bool {
        self.id == DEFAULT_ID
    }

    /// Electron `userData` (the SQLite host root and electron-store files live below it).
    pub fn user_data(&self) -> PathBuf {
        self.data_root.join("ZaloData")
    }

    pub fn cookies(&self) -> PathBuf {
        self.data_root.join("cookies.json")
    }

    /// Host of the account's `zalo-app://` origin: WebKit partitions localStorage / IndexedDB / service workers by it.
    pub fn origin_host(&self) -> &str {
        if self.is_default() { "local" } else { &self.id }
    }

    /// Webview label of one of the account's hidden windows (`zalo-host` → `zalo-host-<id>`).
    pub fn label(&self, base: &str) -> String {
        if self.is_default() { base.to_owned() } else { format!("{base}-{}", self.id) }
    }
}

/// The account a webview label belongs to (`zalo-host-a1b2c3d4e` → `a1b2c3d4e`, `zalo-host` → `default`).
pub fn account_of_label(label: &str, base: &str) -> Option<String> {
    if label == base {
        return Some(DEFAULT_ID.to_owned());
    }
    let id = label.strip_prefix(base)?.strip_prefix('-')?;
    (valid_id(id) && id != DEFAULT_ID).then(|| id.to_owned())
}

/// The account an origin host names (`local` → `default`).
pub fn account_of_origin_host(host: &str) -> Option<String> {
    if host == "local" {
        return Some(DEFAULT_ID.to_owned());
    }
    (valid_id(host) && host != DEFAULT_ID).then(|| host.to_owned())
}

// ---------------------------------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub id: String,
    /// Zalo user id, known once signed in.
    #[serde(default)]
    pub uid: Option<String>,
    /// Zalo display name (from the renderer's signed-in user).
    #[serde(default)]
    pub name: Option<String>,
    /// A local name an admin gave the account (shown instead of `name`).
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub avatar: Option<String>,
    #[serde(default)]
    pub order: u32,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub added_at: u64,
}

fn yes() -> bool {
    true
}

impl Record {
    fn new(id: &str, order: u32, added_at: u64) -> Self {
        Self { id: id.to_owned(), uid: None, name: None, label: None, avatar: None, order, enabled: true, added_at }
    }

    /// What the switcher and notifications call the account.
    pub fn display_name(&self) -> Option<&str> {
        self.label.as_deref().or(self.name.as_deref()).filter(|s| !s.is_empty())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Registry {
    #[serde(default)]
    pub version: u32,
    #[serde(default = "default_id")]
    pub active: String,
    #[serde(default = "default_max")]
    pub max_accounts: usize,
    #[serde(default)]
    pub accounts: Vec<Record>,
}

fn default_id() -> String {
    DEFAULT_ID.to_owned()
}
fn default_max() -> usize {
    DEFAULT_MAX_ACCOUNTS
}

/// What `remove` did.
#[derive(Debug, PartialEq, Eq)]
pub enum Removed {
    /// The row is gone; delete `Accounts/<id>/`.
    Deleted { new_active: String },
    /// `default` stays registered: only its session goes (sign out).
    SignedOutOnly,
}

impl Default for Registry {
    fn default() -> Self {
        Self { version: VERSION, active: default_id(), max_accounts: DEFAULT_MAX_ACCOUNTS, accounts: vec![Record::new(DEFAULT_ID, 0, 0)] }
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl Registry {
    pub fn path(root: &Path) -> PathBuf {
        root.join(REGISTRY_FILE)
    }

    /// Reads `<root>/accounts.json`. An install from before multi-account (no file) becomes the single `default` account
    /// with its paths unchanged; the file is written then. An unreadable file is kept as `accounts.json.bad` and the
    /// registry is rebuilt from what is on disk. Valid `Accounts/<id>/` folders without a row are adopted.
    pub fn load(root: &Path) -> Self {
        let path = Self::path(root);
        let mut registry = match std::fs::read(&path) {
            Ok(data) => match serde_json::from_slice::<Registry>(&data) {
                Ok(r) => r,
                Err(e) => {
                    log::warn!("accounts.json unreadable ({e}): rebuilt from disk");
                    let _ = std::fs::rename(&path, root.join(format!("{REGISTRY_FILE}.bad")));
                    Registry::default()
                }
            },
            Err(_) => Registry::default(),
        };
        let before = registry.clone();
        registry.normalize(root);
        if registry != before || !path.exists() {
            if let Err(e) = registry.save(root) {
                log::warn!("accounts.json not written: {e}");
            }
        }
        registry
    }

    /// Invariants: valid unique ids, `default` present, orphaned account folders adopted, dense order, a registered
    /// active account, a sane cap.
    fn normalize(&mut self, root: &Path) {
        self.version = VERSION;
        let mut seen = std::collections::HashSet::new();
        self.accounts.retain(|r| valid_id(&r.id) && seen.insert(r.id.clone()));
        if !self.accounts.iter().any(|r| r.id == DEFAULT_ID) {
            self.accounts.insert(0, Record::new(DEFAULT_ID, 0, 0));
        }
        if let Ok(entries) = std::fs::read_dir(root.join(ACCOUNTS_DIR)) {
            let mut orphans: Vec<String> = entries
                .flatten()
                .filter(|e| e.path().is_dir())
                .filter_map(|e| e.file_name().to_str().map(str::to_owned))
                .filter(|id| valid_id(id) && id != DEFAULT_ID && !self.accounts.iter().any(|r| &r.id == id))
                .collect();
            orphans.sort();
            for id in orphans {
                let order = self.accounts.len() as u32;
                self.accounts.push(Record::new(&id, order, now_ms()));
            }
        }
        self.accounts.sort_by_key(|r| r.order);
        for (i, r) in self.accounts.iter_mut().enumerate() {
            r.order = i as u32;
        }
        if !self.accounts.iter().any(|r| r.id == self.active) {
            self.active = self.accounts[0].id.clone();
        }
        if self.max_accounts == 0 {
            self.max_accounts = DEFAULT_MAX_ACCOUNTS;
        }
    }

    /// Atomic write (tmp + rename).
    pub fn save(&self, root: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(root)?;
        let path = Self::path(root);
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        std::fs::rename(tmp, path)
    }

    pub fn get(&self, id: &str) -> Option<&Record> {
        self.accounts.iter().find(|r| r.id == id)
    }

    fn get_mut(&mut self, id: &str) -> Result<&mut Record, String> {
        self.accounts.iter_mut().find(|r| r.id == id).ok_or_else(|| "Tài khoản không tồn tại".to_owned())
    }

    pub fn ids(&self) -> Vec<String> {
        self.accounts.iter().map(|r| r.id.clone()).collect()
    }

    /// Resolves an optional account argument: `None` → the active account; an unknown or invalid id is an error.
    pub fn resolve(&self, account: Option<&str>) -> Result<String, String> {
        match account {
            None => Ok(self.active.clone()),
            Some(id) if valid_id(id) && self.get(id).is_some() => Ok(id.to_owned()),
            Some(_) => Err("Tài khoản không tồn tại".into()),
        }
    }

    /// A new account at the end of the list (not yet active).
    pub fn add(&mut self) -> Result<String, String> {
        if self.accounts.len() >= self.max_accounts {
            return Err(format!("Đã đạt số tài khoản tối đa ({})", self.max_accounts));
        }
        let taken: Vec<&str> = self.accounts.iter().map(|r| r.id.as_str()).collect();
        let id = new_id(&taken);
        let order = self.accounts.len() as u32;
        self.accounts.push(Record::new(&id, order, now_ms()));
        Ok(id)
    }

    pub fn remove(&mut self, id: &str) -> Result<Removed, String> {
        self.get_mut(id)?;
        if id == DEFAULT_ID {
            let r = self.get_mut(id)?;
            r.uid = None;
            r.name = None;
            r.avatar = None;
            return Ok(Removed::SignedOutOnly);
        }
        self.accounts.retain(|r| r.id != id);
        for (i, r) in self.accounts.iter_mut().enumerate() {
            r.order = i as u32;
        }
        if self.active == id {
            self.active = self.accounts[0].id.clone();
        }
        Ok(Removed::Deleted { new_active: self.active.clone() })
    }

    pub fn set_active(&mut self, id: &str) -> Result<(), String> {
        self.get_mut(id)?;
        self.active = id.to_owned();
        Ok(())
    }

    /// `ids` must be exactly the registered ids, in the new order.
    pub fn reorder(&mut self, ids: &[String]) -> Result<(), String> {
        let mut current = self.ids();
        let mut wanted = ids.to_vec();
        current.sort();
        wanted.sort();
        if current != wanted {
            return Err("Danh sách tài khoản không khớp".into());
        }
        for r in &mut self.accounts {
            r.order = ids.iter().position(|i| i == &r.id).unwrap_or(0) as u32;
        }
        self.accounts.sort_by_key(|r| r.order);
        Ok(())
    }

    pub fn set_enabled(&mut self, id: &str, enabled: bool) -> Result<(), String> {
        self.get_mut(id)?.enabled = enabled;
        Ok(())
    }

    pub fn rename(&mut self, id: &str, label: Option<String>) -> Result<(), String> {
        self.get_mut(id)?.label = label.map(|l| l.trim().to_owned()).filter(|l| !l.is_empty());
        Ok(())
    }

    /// The renderer reported its signed-in user. Returns the *other* account already signed in with this uid (the
    /// caller then removes `id`: one Zalo account is never signed in twice); `Ok(None)` when recorded.
    pub fn record_profile(&mut self, id: &str, uid: &str, name: Option<&str>, avatar: Option<&str>) -> Result<Option<String>, String> {
        if let Some(other) = self.accounts.iter().find(|r| r.id != id && r.uid.as_deref() == Some(uid)) {
            return Ok(Some(other.id.clone()));
        }
        let r = self.get_mut(id)?;
        r.uid = Some(uid.to_owned());
        if let Some(n) = name.filter(|n| !n.is_empty()) {
            r.name = Some(n.to_owned());
        }
        if let Some(a) = avatar.filter(|a| !a.is_empty()) {
            r.avatar = Some(a.to_owned());
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("compola-accounts-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn ids_are_validated() {
        assert!(valid_id("default"));
        assert!(valid_id("a1b2c3d4e"));
        for bad in ["", "a1b2c3d4", "a1b2c3d4e5", "b1b2c3d4e", "a1B2c3d4e", "a1b2c3g4e", "../a1b2c3", "local", "a1b2/3d4e"] {
            assert!(!valid_id(bad), "{bad}");
        }
        let id = new_id(&[]);
        assert!(valid_id(id.as_str()) && id != DEFAULT_ID);
    }

    #[test]
    fn default_account_keeps_the_pre_multi_account_layout() {
        let root = Path::new("/data/Compola");
        let d = AccountPaths::new(root, DEFAULT_ID);
        assert_eq!(d.user_data(), root.join("ZaloData"));
        assert_eq!(d.cookies(), root.join("cookies.json"));
        assert_eq!(d.origin_host(), "local");
        assert_eq!(d.label("zalo-host"), "zalo-host");
        let a = AccountPaths::new(root, "a1b2c3d4e");
        assert_eq!(a.user_data(), root.join("Accounts/a1b2c3d4e/ZaloData"));
        assert_eq!(a.cookies(), root.join("Accounts/a1b2c3d4e/cookies.json"));
        assert_eq!(a.origin_host(), "a1b2c3d4e");
        assert_eq!(a.label("zalo-worker"), "zalo-worker-a1b2c3d4e");
        assert_eq!(account_of_label("zalo-worker-a1b2c3d4e", "zalo-worker").as_deref(), Some("a1b2c3d4e"));
        assert_eq!(account_of_label("zalo-host", "zalo-host").as_deref(), Some("default"));
        assert_eq!(account_of_label("zalo-host-default", "zalo-host"), None);
        assert_eq!(account_of_label("main", "zalo-host"), None);
        assert_eq!(account_of_origin_host("local").as_deref(), Some("default"));
        assert_eq!(account_of_origin_host("a1b2c3d4e").as_deref(), Some("a1b2c3d4e"));
        assert_eq!(account_of_origin_host("evil"), None);
    }

    #[test]
    fn migration_of_an_existing_install_moves_nothing() {
        let root = temp_root();
        // A signed-in install from before multi-account.
        std::fs::create_dir_all(root.join("ZaloData/sqlite")).unwrap();
        std::fs::write(root.join("cookies.json"), b"[cookies]").unwrap();
        std::fs::write(root.join("ZaloData/sqlite/x.db"), b"db").unwrap();
        let r = Registry::load(&root);
        assert_eq!(r.active, DEFAULT_ID);
        assert_eq!(r.max_accounts, 5);
        assert_eq!(r.ids(), vec!["default"]);
        assert!(r.accounts[0].enabled);
        // Written, and nothing moved.
        assert!(root.join("accounts.json").exists());
        assert_eq!(std::fs::read(root.join("cookies.json")).unwrap(), b"[cookies]");
        assert_eq!(std::fs::read(root.join("ZaloData/sqlite/x.db")).unwrap(), b"db");
        assert!(!root.join("Accounts").exists());
        // Loading again is stable.
        assert_eq!(Registry::load(&root), r);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn registry_round_trip_and_operations() {
        let root = temp_root();
        let mut r = Registry::load(&root);
        let a = r.add().unwrap();
        let b = r.add().unwrap();
        assert_ne!(a, b);
        r.set_active(&b).unwrap();
        r.rename(&a, Some("  Sales 2 ".into())).unwrap();
        assert_eq!(r.record_profile(&a, "111", Some("Nguyễn A"), Some("https://ava")).unwrap(), None);
        r.reorder(&[b.clone(), DEFAULT_ID.into(), a.clone()]).unwrap();
        assert!(r.reorder(&[b.clone()]).is_err());
        r.set_enabled(&a, false).unwrap();
        r.save(&root).unwrap();

        let loaded = Registry::load(&root);
        assert_eq!(loaded, r);
        assert_eq!(loaded.ids(), vec![b.clone(), DEFAULT_ID.into(), a.clone()]);
        assert_eq!(loaded.active, b);
        let ra = loaded.get(&a).unwrap();
        assert_eq!(ra.display_name(), Some("Sales 2"));
        assert_eq!(ra.uid.as_deref(), Some("111"));
        assert!(!ra.enabled);
        assert_eq!(loaded.resolve(None).unwrap(), b);
        assert_eq!(loaded.resolve(Some(&a)).unwrap(), a);
        assert!(loaded.resolve(Some("a00000000")).is_err());
        assert!(loaded.resolve(Some("../x")).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn cap_duplicates_and_removal() {
        let mut r = Registry::default();
        for _ in 1..DEFAULT_MAX_ACCOUNTS {
            r.add().unwrap();
        }
        assert!(r.add().unwrap_err().contains("(5)"));
        let ids = r.ids();
        let (x, y) = (ids[1].clone(), ids[2].clone());
        // The same Zalo account cannot be signed in twice.
        assert_eq!(r.record_profile(&x, "42", Some("A"), None).unwrap(), None);
        assert_eq!(r.record_profile(&y, "42", Some("A"), None).unwrap(), Some(x.clone()));
        assert_eq!(r.get(&y).unwrap().uid, None);
        // Removing the active account activates the first remaining one; `default` only loses its session.
        r.set_active(&y).unwrap();
        assert_eq!(r.remove(&y).unwrap(), Removed::Deleted { new_active: DEFAULT_ID.into() });
        assert!(r.get(&y).is_none());
        assert_eq!(r.accounts.iter().map(|a| a.order).collect::<Vec<_>>(), vec![0, 1, 2, 3]);
        r.record_profile(DEFAULT_ID, "7", Some("Me"), None).unwrap();
        assert_eq!(r.remove(DEFAULT_ID).unwrap(), Removed::SignedOutOnly);
        assert!(r.get(DEFAULT_ID).is_some_and(|d| d.uid.is_none()));
        assert!(r.remove("a00000000").is_err());
        assert!(r.add().is_ok()); // a slot is free again
    }

    #[test]
    fn broken_file_and_orphaned_folders_are_recovered() {
        let root = temp_root();
        std::fs::write(root.join("accounts.json"), b"{not json").unwrap();
        std::fs::create_dir_all(root.join("Accounts/a0000000a/ZaloData")).unwrap();
        std::fs::create_dir_all(root.join("Accounts/not-an-id")).unwrap();
        let r = Registry::load(&root);
        assert!(root.join("accounts.json.bad").exists());
        assert_eq!(r.ids(), vec!["default", "a0000000a"]);
        assert_eq!(r.active, DEFAULT_ID);
        // Rows with invalid or duplicate ids and a missing default are repaired.
        let raw = r#"{"version":1,"active":"a0000000b","accounts":[{"id":"a0000000b"},{"id":"a0000000b"},{"id":"../x"}]}"#;
        std::fs::write(root.join("accounts.json"), raw).unwrap();
        let r = Registry::load(&root);
        assert_eq!(r.ids(), vec!["default", "a0000000b", "a0000000a"]);
        assert_eq!(r.active, "a0000000b");
        let _ = std::fs::remove_dir_all(&root);
    }
}
