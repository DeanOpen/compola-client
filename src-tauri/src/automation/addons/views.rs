//! HTML views: add-ons ship their own UI (`contributes.views`) and Compola shows it in a sandboxed iframe.
//!
//! ```json
//! "contributes": { "views": [
//!   { "id": "dashboard", "title": "Báo cáo", "location": "tab", "entry": "ui/dashboard.html", "icon": "chart" },
//!   { "id": "crm", "title": "Khách hàng", "location": "inspector", "entry": "ui/crm.html", "height": 240 },
//!   { "id": "tools", "title": "Công cụ", "location": "composer", "entry": "ui/tools.html", "height": 48 },
//!   { "id": "config", "title": "Cấu hình", "location": "settings", "entry": "ui/settings.html" },
//!   { "id": "order", "title": "Tạo đơn", "location": "modal", "entry": "ui/order.html", "width": 520, "height": 600 }
//! ]}
//! ```
//!
//! Locations: `tab` (a page in the app's sidebar), `inspector` (a section of the conversation's info panel),
//! `composer` (a strip above the message box), `settings` (the add-on's page in Settings › Add-on), `modal` (opened
//! by an action with `"view"`, by `compola.ui.openView` or by another view).
//!
//! [`document`] turns the entry into one self-contained HTML document (`srcdoc`): relative `<script src>`,
//! `<link rel=stylesheet>`, `<img src>` and CSS `url()` are inlined from the package, and a CSP, a base stylesheet and
//! the view SDK (`window.compola`, `view-sdk.js`) are injected. The iframe is `sandbox="allow-scripts allow-forms"`
//! (an opaque origin: no access to the app, its storage or Tauri) and the CSP forbids network (`connect-src 'none'`):
//! a view reaches data only through its add-on (`compola.call` → `compola.views.handle`), so it can do exactly what
//! the add-on's permissions allow. The same document works on the host, in a joined app and in the web client.

use std::path::Path;

use base64::Engine;
use serde_json::{Value, json};

use super::workspace::clean_text;

pub const LOCATIONS: &[&str] = &["tab", "inspector", "composer", "settings", "modal"];
const MAX_DOCUMENT_BYTES: usize = 8 * 1024 * 1024;
const MAX_INLINE_FILE: u64 = 4 * 1024 * 1024;
const SDK: &str = include_str!("view-sdk.js");

/// No network from a view: everything goes through its add-on. Remote images / media only for add-ons that hold
/// `network` (otherwise an `<img src="https://…?data">` would be a way out for an add-on that has no network).
fn csp(network: bool) -> String {
    let remote = if network { " https:" } else { "" };
    format!(
        "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; img-src data: blob:{remote}; \
         font-src data:; media-src data: blob:{remote}; connect-src 'none'; frame-src 'none'; worker-src blob:; form-action 'none'; base-uri 'none'"
    )
}

const BASE_CSS: &str = r#"
:root { color-scheme: light dark; --c-bg: #ffffff; --c-fg: #081b3a; --c-muted: #5a6981; --c-border: #dfe2e7; --c-accent: #0068ff;
  --c-accent-fg: #ffffff; --c-surface: #f3f5f8; --c-danger: #e53935; --radius: 8px;
  font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
:root[data-theme="dark"] { --c-bg: #1b1d21; --c-fg: #e7e9ee; --c-muted: #9aa3b2; --c-border: #33373e; --c-accent: #3b8bff;
  --c-surface: #24272c; --c-danger: #ff6b66; }
html, body { margin: 0; background: transparent; color: var(--c-fg); }
body { padding: 0; }
button { font: inherit; border: 1px solid var(--c-border); background: var(--c-surface); color: var(--c-fg); border-radius: var(--radius);
  padding: 5px 10px; cursor: pointer; }
button.primary { background: var(--c-accent); border-color: var(--c-accent); color: var(--c-accent-fg); }
input, textarea, select { font: inherit; color: var(--c-fg); background: var(--c-bg); border: 1px solid var(--c-border);
  border-radius: var(--radius); padding: 5px 8px; box-sizing: border-box; }
a { color: var(--c-accent); }
"#;

/// The views a manifest declares (invalid ones dropped).
pub fn declared(manifest_views: &[Value]) -> Vec<Value> {
    manifest_views.iter().filter_map(sanitize).collect()
}

fn sanitize(v: &Value) -> Option<Value> {
    let id = clean_text(v.get("id").and_then(Value::as_str)?, 64);
    let entry = v.get("entry").and_then(Value::as_str)?.trim().trim_start_matches("./").to_owned();
    let location = v.get("location").and_then(Value::as_str).filter(|l| LOCATIONS.contains(l))?;
    if id.is_empty() || !safe_path(&entry) {
        return None;
    }
    let num = |k: &str, min: u64, max: u64| v.get(k).and_then(Value::as_u64).map(|n| n.clamp(min, max));
    Some(json!({
        "id": id,
        "title": clean_text(v.get("title").and_then(Value::as_str).unwrap_or(&id), 60),
        "location": location,
        "entry": entry,
        "icon": clean_text(v.get("icon").and_then(Value::as_str).unwrap_or("puzzle"), 32),
        "height": num("height", 24, 2000),
        "width": num("width", 240, 1600),
    }))
}

/// Checks the manifest's views (ids unique, entries present in the package).
pub fn validate(views: &[Value], has_file: &dyn Fn(&str) -> bool) -> Result<(), String> {
    let mut ids = std::collections::HashSet::new();
    for v in views {
        let id = v.get("id").and_then(Value::as_str).unwrap_or_default();
        if id.is_empty() || !ids.insert(id) {
            return Err(format!("contributes.views: thiếu hoặc trùng \"id\" ({id})"));
        }
        let location = v.get("location").and_then(Value::as_str).unwrap_or_default();
        if !LOCATIONS.contains(&location) {
            return Err(format!("view \"{id}\": location phải là một trong {}", LOCATIONS.join(", ")));
        }
        let entry = v.get("entry").and_then(Value::as_str).unwrap_or_default().trim_start_matches("./");
        if !safe_path(entry) || !entry.ends_with(".html") && !entry.ends_with(".htm") {
            return Err(format!("view \"{id}\": entry phải là một tệp .html trong add-on"));
        }
        if !has_file(entry) {
            return Err(format!("view \"{id}\": không có tệp {entry} trong gói"));
        }
    }
    Ok(())
}

fn safe_path(p: &str) -> bool {
    !p.is_empty() && !p.starts_with('/') && !p.contains('\\') && !p.split('/').any(|s| s == ".." || s.is_empty() || s.starts_with('.'))
}

/// `rel` resolved against the folder of `from` (both package-relative); None when it leaves the package or is not a
/// plain relative reference (http:, data:, //host, #, …).
fn resolve(from: &str, rel: &str) -> Option<String> {
    let rel = rel.trim();
    if rel.is_empty() || rel.starts_with('#') || rel.starts_with("//") || rel.contains(':') {
        return None;
    }
    let rel = rel.split(['?', '#']).next()?;
    let mut parts: Vec<&str> = if rel.starts_with('/') { Vec::new() } else { from.split('/').collect() };
    if !rel.starts_with('/') {
        parts.pop();
    }
    for seg in rel.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            s => parts.push(s),
        }
    }
    let out = parts.join("/");
    safe_path(&out).then_some(out)
}

fn mime(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or_default().to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "css" => "text/css",
        "js" | "mjs" => "text/javascript",
        "json" => "application/json",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        _ => "application/octet-stream",
    }
}

struct Package<'a> {
    folder: &'a Path,
}

impl Package<'_> {
    fn read(&self, rel: &str) -> Option<Vec<u8>> {
        if !safe_path(rel) {
            return None;
        }
        let p = self.folder.join(rel);
        let meta = std::fs::symlink_metadata(&p).ok()?;
        (meta.is_file() && meta.len() <= MAX_INLINE_FILE).then(|| std::fs::read(p).ok()).flatten()
    }

    fn data_url(&self, rel: &str) -> Option<String> {
        let bytes = self.read(rel)?;
        Some(format!("data:{};base64,{}", mime(rel), base64::engine::general_purpose::STANDARD.encode(bytes)))
    }

    /// CSS with relative `url(…)` and `@import "…"` inlined.
    fn css(&self, from: &str, css: &str, depth: u8) -> String {
        let url_re = regex::Regex::new(r#"url\(\s*(['"]?)([^'")]+)(['"]?)\s*\)"#).unwrap();
        let out = url_re
            .replace_all(css, |c: &regex::Captures<'_>| match resolve(from, &c[2]).and_then(|p| self.data_url(&p)) {
                Some(d) => format!("url(\"{d}\")"),
                None => c[0].to_owned(),
            })
            .into_owned();
        if depth == 0 {
            return out;
        }
        let import_re = regex::Regex::new(r#"@import\s+(?:url\()?\s*['"]([^'"]+)['"]\s*\)?\s*;"#).unwrap();
        import_re
            .replace_all(&out, |c: &regex::Captures<'_>| {
                match resolve(from, &c[1]).and_then(|p| self.read(&p).map(|b| (p, b))) {
                    Some((p, b)) => self.css(&p, &String::from_utf8_lossy(&b), depth - 1),
                    None => String::new(),
                }
            })
            .into_owned()
    }
}

/// Escapes `</script` inside an inlined script.
fn script_safe(js: &str) -> String {
    js.replace("</script", "<\\/script").replace("</SCRIPT", "<\\/SCRIPT")
}

/// The view's entry as one self-contained document for `<iframe srcdoc sandbox="allow-scripts allow-forms">`.
pub fn document(folder: &Path, view: &Value, network: bool) -> Result<String, String> {
    let entry = view.get("entry").and_then(Value::as_str).ok_or("view không có entry")?;
    let pkg = Package { folder };
    let html = String::from_utf8_lossy(&pkg.read(entry).ok_or_else(|| format!("không đọc được {entry}"))?).into_owned();

    let script_re = regex::Regex::new(r#"(?is)<script\b([^>]*)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>\s*</script>"#).unwrap();
    let html = script_re
        .replace_all(&html, |c: &regex::Captures<'_>| match resolve(entry, &c[2]).and_then(|p| pkg.read(&p)) {
            Some(b) => {
                let attrs = format!("{}{}", &c[1], &c[3]);
                let module = if attrs.contains("module") { " type=\"module\"" } else { "" };
                format!("<script{module}>{}</script>", script_safe(&String::from_utf8_lossy(&b)))
            }
            // Remote scripts are blocked by the CSP anyway; drop them so the page does not hang on them.
            None => format!("<!-- script {} not inlined -->", clean_text(&c[2], 200).replace("--", "")),
        })
        .into_owned();
    let link_re = regex::Regex::new(r#"(?is)<link\b[^>]*>"#).unwrap();
    let href_re = regex::Regex::new(r#"(?is)\bhref\s*=\s*["']([^"']+)["']"#).unwrap();
    let html = link_re
        .replace_all(&html, |c: &regex::Captures<'_>| {
            let tag = &c[0];
            let lower = tag.to_ascii_lowercase();
            let Some(href) = href_re.captures(tag).map(|h| h[1].to_owned()) else { return tag.to_owned() };
            if lower.contains("stylesheet") {
                if let Some((p, b)) = resolve(entry, &href).and_then(|p| pkg.read(&p).map(|b| (p, b))) {
                    return format!("<style>{}</style>", pkg.css(&p, &String::from_utf8_lossy(&b), 3).replace("</style", "<\\/style"));
                }
            } else if lower.contains("icon") {
                return String::new();
            }
            tag.to_owned()
        })
        .into_owned();
    let src_re = regex::Regex::new(r#"(?is)(<(?:img|source|audio|video)\b[^>]*?\bsrc\s*=\s*)["']([^"']+)["']"#).unwrap();
    let html = src_re
        .replace_all(&html, |c: &regex::Captures<'_>| match resolve(entry, &c[2]).and_then(|p| pkg.data_url(&p)) {
            Some(d) => format!("{}\"{d}\"", &c[1]),
            None => c[0].to_owned(),
        })
        .into_owned();
    let style_re = regex::Regex::new(r#"(?is)(<style\b[^>]*>)(.*?)(</style>)"#).unwrap();
    let html = style_re.replace_all(&html, |c: &regex::Captures<'_>| format!("{}{}{}", &c[1], pkg.css(entry, &c[2], 3), &c[3])).into_owned();

    // What every view gets first: the CSP, the base look and `window.compola`.
    let inject = format!(
        "<meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"{}\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
         <style>{BASE_CSS}</style><script>{}</script>",
        csp(network),
        script_safe(SDK)
    );
    let head_re = regex::Regex::new(r"(?i)<head\b[^>]*>").unwrap();
    let doc = if let Some(m) = head_re.find(&html) {
        format!("{}{inject}{}", &html[..m.end()], &html[m.end()..])
    } else if let Some(m) = regex::Regex::new(r"(?i)<html\b[^>]*>").unwrap().find(&html) {
        format!("{}<head>{inject}</head>{}", &html[..m.end()], &html[m.end()..])
    } else {
        format!("<!doctype html><html><head>{inject}</head><body>{html}</body></html>")
    };
    // A `<meta http-equiv=Content-Security-Policy>` of the add-on's own can only narrow ours (CSPs intersect).
    if doc.len() > MAX_DOCUMENT_BYTES {
        return Err(format!("view quá lớn sau khi đóng gói (tối đa {} MB)", MAX_DOCUMENT_BYTES / 1024 / 1024));
    }
    Ok(doc)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_inside_the_package() {
        assert_eq!(resolve("ui/index.html", "app.js").as_deref(), Some("ui/app.js"));
        assert_eq!(resolve("ui/index.html", "./css/a.css?v=2").as_deref(), Some("ui/css/a.css"));
        assert_eq!(resolve("ui/index.html", "../img/logo.png").as_deref(), Some("img/logo.png"));
        assert_eq!(resolve("ui/index.html", "/shared/x.js").as_deref(), Some("shared/x.js"));
        assert_eq!(resolve("ui/index.html", "../../etc/passwd"), None);
        assert_eq!(resolve("index.html", "https://cdn.x/y.js"), None);
        assert_eq!(resolve("index.html", "data:image/png;base64,xx"), None);
        assert_eq!(resolve("index.html", "//cdn.x/y.js"), None);
        assert_eq!(resolve("index.html", ".env"), None);
    }

    #[test]
    fn declared_views_are_checked() {
        let views = vec![json!({ "id": "d", "title": "D", "location": "tab", "entry": "ui/d.html" })];
        assert!(validate(&views, &|p| p == "ui/d.html").is_ok());
        assert!(validate(&views, &|_| false).is_err());
        assert!(validate(&[json!({ "id": "d", "location": "sidebar", "entry": "d.html" })], &|_| true).is_err());
        assert!(validate(&[json!({ "id": "d", "location": "tab", "entry": "../d.html" })], &|_| true).is_err());
        assert!(validate(&[json!({ "id": "d", "location": "tab", "entry": "d.js" })], &|_| true).is_err());
        let v = declared(&[json!({ "id": "x", "location": "inspector", "entry": "./x.html", "height": 99999 })]);
        assert_eq!(v[0]["entry"], "x.html");
        assert_eq!(v[0]["height"], 2000);
    }

    #[test]
    fn documents_are_self_contained_and_locked_down() {
        let dir = std::env::temp_dir().join(format!("compola-view-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("ui/img")).unwrap();
        std::fs::write(
            dir.join("ui/index.html"),
            r#"<!doctype html><html><head><title>T</title><link rel="stylesheet" href="style.css"><script src="https://cdn.evil/x.js"></script></head>
            <body><img src="img/a.png"><script src="app.js"></script><style>.b{background:url(img/a.png)}</style></body></html>"#,
        )
        .unwrap();
        std::fs::write(dir.join("ui/style.css"), "body{color:red} .x{background:url('img/a.png')}").unwrap();
        std::fs::write(dir.join("ui/app.js"), "document.title = '</script>';").unwrap();
        std::fs::write(dir.join("ui/img/a.png"), [0x89, b'P', b'N', b'G']).unwrap();
        let doc = document(&dir, &json!({ "entry": "ui/index.html" }), false).unwrap();
        assert!(doc.contains("Content-Security-Policy") && doc.contains("connect-src 'none'"));
        assert!(!doc.contains("https:;"), "no remote images without `network`");
        assert!(document(&dir, &json!({ "entry": "ui/index.html" }), true).unwrap().contains("img-src data: blob: https:"));
        assert!(doc.contains("window.compola"), "sdk injected");
        assert!(doc.contains("body{color:red}"), "css inlined");
        assert!(doc.contains("document.title = '<\\/script>'"), "script inlined and escaped");
        assert!(!doc.contains("cdn.evil/x.js\"></script>"), "remote script dropped");
        assert_eq!(doc.matches("data:image/png;base64,").count(), 3, "img + 2 css urls");
        assert!(doc.find("Content-Security-Policy").unwrap() < doc.find("<title>").unwrap(), "CSP first in head");
        // A fragment without <html>/<head>.
        std::fs::write(dir.join("frag.html"), "<p>hi</p>").unwrap();
        let doc = document(&dir, &json!({ "entry": "frag.html" }), false).unwrap();
        assert!(doc.starts_with("<!doctype html><html><head><meta charset"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
