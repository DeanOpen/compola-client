//! The client's one cookie jar (the Swift app used `HTTPCookieStorage.shared`), persisted to
//! `<data>/cookies.json` so a session survives relaunch.

use std::path::PathBuf;

use cookie_store::{CookieStore, RawCookie};
use parking_lot::Mutex;

pub struct CookieJar {
    store: Mutex<CookieStore>,
    file: PathBuf,
}

/// Auth domain whose `zpw_sek` cookie means "logged in" (main: `XPAe.DEFAULT_AUTH_DOMAIN`).
pub const AUTH_URL: &str = "https://wpa.zaloapp.com/";
pub const SESSION_COOKIE_DOMAINS: &[&str] = &["zaloapp.com", "zalo.me", "chat.zalo.me"];

impl CookieJar {
    pub fn load(file: PathBuf) -> Self {
        let store = std::fs::File::open(&file)
            .ok()
            .and_then(|f| {
                #[allow(deprecated)]
                cookie_store::serde::json::load(std::io::BufReader::new(f)).ok()
            })
            .unwrap_or_default();
        Self { store: Mutex::new(store), file }
    }

    fn save(&self, store: &CookieStore) {
        if let Some(dir) = self.file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = self.file.with_extension("json.tmp");
        if let Ok(mut f) = std::fs::File::create(&tmp) {
            #[allow(deprecated)]
            if cookie_store::serde::json::save_incl_expired_and_nonpersistent(store, &mut f).is_ok() {
                let _ = std::fs::rename(&tmp, &self.file);
            }
        }
    }

    /// `Cookie:` header value for a request URL.
    pub fn header_for(&self, url: &url::Url) -> Option<String> {
        let store = self.store.lock();
        let pairs: Vec<String> = store.get_request_values(url).map(|(n, v)| format!("{n}={v}")).collect();
        (!pairs.is_empty()).then(|| pairs.join("; "))
    }

    pub fn store_from_headers(&self, url: &url::Url, headers: &[(String, String)]) {
        let mut changed = false;
        let mut store = self.store.lock();
        for (k, v) in headers {
            if k.eq_ignore_ascii_case("set-cookie") && store.parse(v, url).is_ok() {
                changed = true;
            }
        }
        if changed {
            self.save(&store);
        }
    }

    /// Electron's `cookies.set({domain})` creates a *domain* cookie (sent to subdomains such as
    /// `ws5-msg.chat.zalo.me`).
    pub fn set(&self, name: &str, value: &str, domain: &str, days: i64, http_only: bool) {
        let domain = domain.trim_start_matches('.');
        let expires = cookie::time::OffsetDateTime::now_utc() + cookie::time::Duration::days(days);
        let c = RawCookie::build((name.to_owned(), value.to_owned()))
            .domain(domain.to_owned())
            .path("/")
            .secure(true)
            .http_only(http_only)
            .same_site(cookie::SameSite::None)
            .expires(expires)
            .build();
        let Ok(url) = url::Url::parse(&format!("https://{domain}/")) else { return };
        let mut store = self.store.lock();
        let _ = store.insert_raw(&c, &url);
        self.save(&store);
    }

    /// Removes every cookie named `name` (all domains).
    pub fn remove_named(&self, name: &str) {
        let mut store = self.store.lock();
        let doomed: Vec<(String, String, String)> = store
            .iter_any()
            .filter(|c| c.name() == name)
            .map(|c| (c.domain().unwrap_or("").to_owned(), c.path().unwrap_or("/").to_owned(), c.name().to_owned()))
            .collect();
        for (d, p, n) in doomed {
            store.remove(&d, &p, &n);
        }
        self.save(&store);
    }

    pub fn clear_zalo(&self) {
        let mut store = self.store.lock();
        let doomed: Vec<(String, String, String)> = store
            .iter_any()
            .filter(|c| is_zalo_domain(c.domain().unwrap_or("")))
            .map(|c| (c.domain().unwrap_or("").to_owned(), c.path().unwrap_or("/").to_owned(), c.name().to_owned()))
            .collect();
        for (d, p, n) in doomed {
            store.remove(&d, &p, &n);
        }
        self.save(&store);
    }

    pub fn has_session(&self) -> bool {
        let url = url::Url::parse(AUTH_URL).unwrap();
        self.store.lock().get_request_values(&url).any(|(n, v)| n == "zpw_sek" && !v.is_empty())
    }
}

pub fn is_zalo_domain(domain: &str) -> bool {
    let d = domain.trim_start_matches('.');
    ["zalo.me", "zaloapp.com", "zadn.vn", "zdn.vn", "zing.vn"].iter().any(|z| d == *z || d.ends_with(&format!(".{z}")))
}
