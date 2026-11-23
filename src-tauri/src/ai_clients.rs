//! "Kết nối ứng dụng AI": finds the AI apps on this Mac (Claude Code, Claude Desktop, Codex, Cursor, …) and writes
//! Compola's MCP server into their config files, so connecting one is a single click instead of a copied snippet.
//!
//! Every JSON config is edited as text ([`jsonc`]) so the user's comments, key order and formatting survive (Zed's
//! settings.json and VS Code's mcp.json are JSON-with-comments). Codex's config.toml gets one managed
//! `[mcp_servers.compola]` table. A file is backed up once (`<name>.compola-backup`) before its first change, written
//! atomically, and the result is re-parsed before it replaces the original: a file we cannot parse is never touched.
//! The bearer token is written into these files (that is how the apps send it); it never reaches the log.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Value, json};

/// The server's name in every app's config.
const NAME: &str = "compola";

#[derive(Clone, Copy)]
enum Format {
    /// A JSON (or JSON-with-comments) file; Compola's entry sits at `container.compola`.
    Json { container: &'static [&'static str], entry: Entry },
    /// `~/.codex/config.toml`: a `[mcp_servers.compola]` table.
    CodexToml,
}

/// The shape of the entry each app expects.
#[derive(Clone, Copy)]
enum Entry {
    /// `{type: "http", url, headers}` — Claude Code, VS Code.
    TypedHttp,
    /// `{url, headers}` — Cursor, Zed, LM Studio, Kiro.
    Url,
    /// `{serverUrl, headers}` — Windsurf.
    ServerUrl,
    /// `{httpUrl, headers}` — Gemini CLI.
    HttpUrl,
    /// stdio only: `npx -y mcp-remote <url>` — Claude Desktop.
    McpRemote,
}

struct Spec {
    id: &'static str,
    name: &'static str,
    /// `.app` bundles (in /Applications or ~/Applications) that mean the app is installed.
    apps: &'static [&'static str],
    /// Paths under $HOME whose existence means the app is installed (CLI tools have no bundle).
    marks: &'static [&'static str],
    /// The config file, under $HOME.
    config: &'static str,
    format: Format,
    /// What the user has to do for the change to take effect.
    apply: &'static str,
}

const SPECS: &[Spec] = &[
    Spec {
        id: "claude-code",
        name: "Claude Code",
        apps: &[],
        marks: &[".claude.json", ".claude", ".local/bin/claude"],
        config: ".claude.json",
        format: Format::Json { container: &["mcpServers"], entry: Entry::TypedHttp },
        apply: "Mở phiên Claude Code mới để dùng.",
    },
    Spec {
        id: "claude-desktop",
        name: "Claude Desktop",
        apps: &["Claude.app"],
        marks: &[],
        config: "Library/Application Support/Claude/claude_desktop_config.json",
        format: Format::Json { container: &["mcpServers"], entry: Entry::McpRemote },
        apply: "Thoát hẳn Claude (⌘Q) rồi mở lại để dùng.",
    },
    Spec {
        id: "codex",
        name: "Codex",
        apps: &["Codex.app"],
        marks: &[".codex"],
        config: ".codex/config.toml",
        format: Format::CodexToml,
        apply: "Mở phiên Codex mới để dùng.",
    },
    Spec {
        id: "cursor",
        name: "Cursor",
        apps: &["Cursor.app"],
        marks: &[".cursor"],
        config: ".cursor/mcp.json",
        format: Format::Json { container: &["mcpServers"], entry: Entry::Url },
        apply: "Cursor tự nạp lại; nếu chưa thấy, bật “compola” trong Cursor Settings › MCP.",
    },
    Spec {
        id: "windsurf",
        name: "Windsurf",
        apps: &["Windsurf.app"],
        marks: &[".codeium/windsurf"],
        config: ".codeium/windsurf/mcp_config.json",
        format: Format::Json { container: &["mcpServers"], entry: Entry::ServerUrl },
        apply: "Bấm Refresh trong Windsurf › MCP để dùng.",
    },
    Spec {
        id: "vscode",
        name: "VS Code",
        apps: &["Visual Studio Code.app"],
        marks: &[],
        config: "Library/Application Support/Code/User/mcp.json",
        format: Format::Json { container: &["servers"], entry: Entry::TypedHttp },
        apply: "Chạy lệnh “MCP: List Servers” trong VS Code và khởi động “compola”.",
    },
    Spec {
        id: "zed",
        name: "Zed",
        apps: &["Zed.app"],
        marks: &[".config/zed"],
        config: ".config/zed/settings.json",
        format: Format::Json { container: &["context_servers"], entry: Entry::Url },
        apply: "Zed tự nạp lại cài đặt.",
    },
    Spec {
        id: "gemini",
        name: "Gemini CLI",
        apps: &[],
        marks: &[".gemini"],
        config: ".gemini/settings.json",
        format: Format::Json { container: &["mcpServers"], entry: Entry::HttpUrl },
        apply: "Mở phiên Gemini CLI mới để dùng.",
    },
    Spec {
        id: "lmstudio",
        name: "LM Studio",
        apps: &["LM Studio.app"],
        marks: &[".lmstudio"],
        config: ".lmstudio/mcp.json",
        format: Format::Json { container: &["mcpServers"], entry: Entry::Url },
        apply: "LM Studio tự nạp lại mcp.json.",
    },
    Spec {
        id: "kiro",
        name: "Kiro",
        apps: &["Kiro.app"],
        marks: &[".kiro"],
        config: ".kiro/settings/mcp.json",
        format: Format::Json { container: &["mcpServers"], entry: Entry::Url },
        apply: "Kiro tự nạp lại mcp.json.",
    },
];

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    /// Compola's entry is there and matches the current address and token.
    Connected,
    /// An entry named `compola` is there but points elsewhere or carries an old token.
    Outdated,
    NotConnected,
    /// The config file exists but could not be read or parsed; we will not touch it.
    Error,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClientView {
    pub id: String,
    pub name: String,
    pub detected: bool,
    pub status: Status,
    pub config_path: String,
    pub apply: String,
    /// Why the client cannot be connected or the file cannot be read (Vietnamese, for the UI).
    pub problem: Option<String>,
}

struct Ctx {
    home: PathBuf,
    endpoint: String,
    token: String,
}

impl Ctx {
    fn new(endpoint: String, token: String) -> Result<Self, String> {
        let home = dirs::home_dir().ok_or("không tìm thấy thư mục người dùng")?;
        if !endpoint.starts_with("http://127.0.0.1:") && !endpoint.starts_with("http://localhost:") {
            return Err("địa chỉ máy chủ MCP không hợp lệ".into());
        }
        if token.len() < 16 {
            return Err("mã truy cập không hợp lệ".into());
        }
        Ok(Self { home, endpoint, token })
    }

    fn auth(&self) -> String {
        format!("Bearer {}", self.token)
    }

    fn entry(&self, entry: Entry) -> Result<Value, String> {
        let headers = json!({ "Authorization": self.auth() });
        Ok(match entry {
            Entry::TypedHttp => json!({ "type": "http", "url": self.endpoint, "headers": headers }),
            Entry::Url => json!({ "url": self.endpoint, "headers": headers }),
            Entry::ServerUrl => json!({ "serverUrl": self.endpoint, "headers": headers }),
            Entry::HttpUrl => json!({ "httpUrl": self.endpoint, "headers": headers }),
            Entry::McpRemote => {
                // Claude Desktop starts servers with a minimal PATH: name npx by absolute path and give it a PATH that
                // finds `node` next to it. The header goes through an env var (mcp-remote's documented pattern).
                let npx = find_npx(&self.home).ok_or("Cần Node.js (npx) để Claude Desktop kết nối — cài Node.js rồi thử lại.")?;
                let dir = npx.parent().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
                json!({
                    "command": npx.to_string_lossy(),
                    "args": ["-y", "mcp-remote", self.endpoint, "--header", "Authorization:${COMPOLA_AUTH}"],
                    "env": { "COMPOLA_AUTH": self.auth(), "PATH": format!("{dir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin") },
                })
            }
        })
    }

    fn codex_block(&self) -> String {
        format!(
            "[mcp_servers.{NAME}]\nurl = {}\nhttp_headers = {{ Authorization = {} }}\n",
            toml_string(&self.endpoint),
            toml_string(&self.auth())
        )
    }
}

fn detected(spec: &Spec, home: &Path) -> bool {
    let bundle = |name: &str| Path::new("/Applications").join(name).exists() || home.join("Applications").join(name).exists();
    spec.apps.iter().any(|a| bundle(a)) || spec.marks.iter().any(|m| home.join(m).exists())
}

fn spec(id: &str) -> Result<&'static Spec, String> {
    SPECS.iter().find(|s| s.id == id).ok_or_else(|| format!("không biết ứng dụng “{id}”"))
}

fn read_text(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(t) => Ok(Some(t)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("không đọc được {}: {e}", path.display())),
    }
}

fn status_of(spec: &Spec, ctx: &Ctx) -> Result<Status, String> {
    let path = ctx.home.join(spec.config);
    let Some(text) = read_text(&path)? else { return Ok(Status::NotConnected) };
    match spec.format {
        Format::Json { container, entry } => {
            let doc = jsonc::parse(&text).map_err(|e| format!("{} không phải JSON hợp lệ ({e}) — Compola sẽ không sửa tệp này.", path.display()))?;
            let mut node = &doc;
            for key in container {
                match node.get(key) {
                    Some(n) => node = n,
                    None => return Ok(Status::NotConnected),
                }
            }
            Ok(match node.get(NAME) {
                None => Status::NotConnected,
                Some(have) if Some(have) == ctx.entry(entry).ok().as_ref() => Status::Connected,
                Some(have) if same_target(have, ctx) => Status::Connected,
                Some(_) => Status::Outdated,
            })
        }
        Format::CodexToml => Ok(match toml_block(&text) {
            None => Status::NotConnected,
            Some((a, b)) if text[a..b].trim() == ctx.codex_block().trim() => Status::Connected,
            Some(_) => Status::Outdated,
        }),
    }
}

/// An entry the user (or an older Compola) wrote in another shape still counts when it reaches the same server with
/// the current token.
fn same_target(entry: &Value, ctx: &Ctx) -> bool {
    let text = entry.to_string();
    text.contains(&ctx.endpoint) && text.contains(&ctx.token)
}

fn view(spec: &Spec, ctx: &Ctx) -> ClientView {
    let (status, problem) = match status_of(spec, ctx) {
        Ok(s) => (s, None),
        Err(e) => (Status::Error, Some(e)),
    };
    ClientView {
        id: spec.id.into(),
        name: spec.name.into(),
        detected: detected(spec, &ctx.home),
        status,
        config_path: ctx.home.join(spec.config).to_string_lossy().into_owned(),
        apply: spec.apply.into(),
        problem,
    }
}

/// Writes `text` over `path`: backup of the original once, temp file in the same folder, original permissions, rename.
fn write_atomic(path: &Path, original: Option<&str>, text: &str) -> Result<(), String> {
    let dir = path.parent().ok_or("đường dẫn không hợp lệ")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("không tạo được {}: {e}", dir.display()))?;
    let file_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if let Some(original) = original {
        let backup = dir.join(format!("{file_name}.compola-backup"));
        if !backup.exists() {
            std::fs::write(&backup, original).map_err(|e| format!("không sao lưu được {}: {e}", path.display()))?;
        }
    }
    let tmp = dir.join(format!(".{file_name}.compola-{}", std::process::id()));
    std::fs::write(&tmp, text).map_err(|e| format!("không ghi được {}: {e}", tmp.display()))?;
    let perms = std::fs::metadata(path).map(|m| m.permissions()).ok();
    let result = (|| {
        if let Some(p) = perms {
            std::fs::set_permissions(&tmp, p)?;
        }
        std::fs::rename(&tmp, path)
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("không ghi được {}: {e}", path.display()));
    }
    Ok(())
}

fn install(spec: &Spec, ctx: &Ctx) -> Result<(), String> {
    let path = ctx.home.join(spec.config);
    let original = read_text(&path)?;
    let text = original.clone().unwrap_or_default();
    let new_text = match spec.format {
        Format::Json { container, entry } => {
            let value = ctx.entry(entry)?;
            let new_text = jsonc::set_member(&text, container, NAME, &value)?;
            // Never write something we cannot read back to exactly what we meant.
            let doc = jsonc::parse(&new_text).map_err(|e| format!("lỗi nội bộ khi sửa {}: {e}", path.display()))?;
            let mut node = &doc;
            for key in container.iter().chain([&NAME]) {
                node = node.get(key).ok_or_else(|| format!("lỗi nội bộ khi sửa {}", path.display()))?;
            }
            if node != &value {
                return Err(format!("lỗi nội bộ khi sửa {}", path.display()));
            }
            new_text
        }
        Format::CodexToml => {
            let mut rest = match toml_block(&text) {
                Some((a, b)) => format!("{}{}", &text[..a], &text[b..]),
                None => text.clone(),
            };
            let trimmed = rest.trim_end().len();
            rest.truncate(trimmed);
            if rest.is_empty() { ctx.codex_block() } else { format!("{rest}\n\n{}", ctx.codex_block()) }
        }
    };
    write_atomic(&path, original.as_deref(), &new_text)?;
    log::info!("ai-clients: connected {} ({})", spec.id, path.display());
    Ok(())
}

fn remove(spec: &Spec, ctx: &Ctx) -> Result<(), String> {
    let path = ctx.home.join(spec.config);
    let Some(text) = read_text(&path)? else { return Ok(()) };
    let new_text = match spec.format {
        Format::Json { container, .. } => {
            jsonc::parse(&text).map_err(|e| format!("{} không phải JSON hợp lệ ({e})", path.display()))?;
            let new_text = jsonc::remove_member(&text, container, NAME)?;
            jsonc::parse(&new_text).map_err(|e| format!("lỗi nội bộ khi sửa {}: {e}", path.display()))?;
            new_text
        }
        Format::CodexToml => match toml_block(&text) {
            Some((a, b)) => {
                let head = text[..a].trim_end();
                let tail = text[b..].trim_start();
                match (head.is_empty(), tail.is_empty()) {
                    (true, _) => tail.to_string(),
                    (false, true) => format!("{head}\n"),
                    (false, false) => format!("{head}\n\n{tail}"),
                }
            }
            None => return Ok(()),
        },
    };
    if new_text != text {
        write_atomic(&path, Some(&text), &new_text)?;
        log::info!("ai-clients: disconnected {} ({})", spec.id, path.display());
    }
    Ok(())
}

// ---- Node.js (Claude Desktop needs npx for mcp-remote) ----

fn find_npx(home: &Path) -> Option<PathBuf> {
    let fixed = ["/opt/homebrew/bin/npx", "/usr/local/bin/npx"].map(PathBuf::from);
    let volta = home.join(".volta/bin/npx");
    let nvm = newest_nvm_npx(home);
    fixed.into_iter().chain([volta]).chain(nvm).find(|p| crate::calls::is_executable(p))
}

/// The npx of the newest Node installed with nvm (`~/.nvm/versions/node/vX.Y.Z/bin/npx`).
fn newest_nvm_npx(home: &Path) -> Option<PathBuf> {
    let dir = home.join(".nvm/versions/node");
    let parse = |name: &str| -> Option<(u32, u32, u32)> {
        let mut it = name.strip_prefix('v')?.split('.').map(|p| p.parse::<u32>().ok());
        Some((it.next()??, it.next()??, it.next()??))
    };
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter_map(|e| Some((parse(&e.file_name().to_string_lossy())?, e.path().join("bin/npx"))))
        .filter(|(_, p)| crate::calls::is_executable(p))
        .max_by_key(|(v, _)| *v)
        .map(|(_, p)| p)
}

// ---- Codex TOML ----

fn toml_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_default() // a JSON string is a valid TOML basic string
}

/// Byte range of the `[mcp_servers.compola]` table and its sub-tables (`[mcp_servers.compola.env]`), up to the next
/// table header.
fn toml_block(text: &str) -> Option<(usize, usize)> {
    let is_ours = |header: &str| {
        let h = header.trim().trim_start_matches('[').trim_end_matches(']').replace(['"', '\'', ' '], "");
        h == format!("mcp_servers.{NAME}") || h.starts_with(&format!("mcp_servers.{NAME}."))
    };
    let mut start = None;
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_start();
        if trimmed.starts_with('[') {
            let header = trimmed.split('#').next().unwrap_or("");
            match (start, is_ours(header)) {
                (None, true) => start = Some(offset),
                (Some(s), false) => return Some((s, offset)),
                _ => {}
            }
        }
        offset += line.len();
    }
    start.map(|s| (s, text.len()))
}

// ---- commands ----

#[tauri::command]
pub fn ai_clients_detect(endpoint: String, token: String) -> Result<Vec<ClientView>, String> {
    let ctx = Ctx::new(endpoint, token)?;
    Ok(SPECS.iter().map(|s| view(s, &ctx)).collect())
}

#[tauri::command]
pub fn ai_clients_install(id: String, endpoint: String, token: String) -> Result<ClientView, String> {
    let ctx = Ctx::new(endpoint, token)?;
    let spec = spec(&id)?;
    install(spec, &ctx)?;
    Ok(view(spec, &ctx))
}

#[tauri::command]
pub fn ai_clients_remove(id: String, endpoint: String, token: String) -> Result<ClientView, String> {
    let ctx = Ctx::new(endpoint, token)?;
    let spec = spec(&id)?;
    remove(spec, &ctx)?;
    Ok(view(spec, &ctx))
}

/// Minimal JSON-with-comments editing: finds object members by scanning the text (strings, `//` and `/* */`
/// comments, trailing commas) and splices new text in, so everything else in the file stays byte-for-byte the same.
mod jsonc {
    use serde_json::Value;

    /// Parses JSON with comments and trailing commas. An empty file is `{}`.
    pub fn parse(text: &str) -> Result<Value, String> {
        if text.trim().is_empty() {
            return Ok(Value::Object(Default::default()));
        }
        serde_json::from_str(&strip(text)).map_err(|e| e.to_string())
    }

    /// Comments become spaces and trailing commas are dropped; positions of everything else are kept.
    fn strip(text: &str) -> String {
        let b = text.as_bytes();
        let mut out = b.to_vec();
        let mut i = 0;
        let mut last_comma: Option<usize> = None;
        while i < b.len() {
            match b[i] {
                b'"' => {
                    i = string_end(b, i).unwrap_or(b.len());
                    last_comma = None;
                    continue;
                }
                b'/' if b.get(i + 1) == Some(&b'/') || b.get(i + 1) == Some(&b'*') => {
                    let end = comment_end(b, i);
                    for c in &mut out[i..end] {
                        if *c != b'\n' {
                            *c = b' ';
                        }
                    }
                    i = end;
                    continue;
                }
                b',' => last_comma = Some(i),
                b'}' | b']' => {
                    if let Some(c) = last_comma.take() {
                        out[c] = b' ';
                    }
                }
                c if c.is_ascii_whitespace() => {}
                _ => last_comma = None,
            }
            i += 1;
        }
        String::from_utf8(out).unwrap_or_default()
    }

    /// `i` at a `"`: index just past the closing quote.
    fn string_end(b: &[u8], i: usize) -> Option<usize> {
        let mut j = i + 1;
        while j < b.len() {
            match b[j] {
                b'\\' => j += 2,
                b'"' => return Some(j + 1),
                _ => j += 1,
            }
        }
        None
    }

    /// `i` at `//` or `/*`: index just past the comment.
    fn comment_end(b: &[u8], i: usize) -> usize {
        if b[i + 1] == b'/' {
            b[i..].iter().position(|&c| c == b'\n').map_or(b.len(), |p| i + p)
        } else {
            b[i + 2..].windows(2).position(|w| w == b"*/").map_or(b.len(), |p| i + 2 + p + 2)
        }
    }

    fn skip_ws(b: &[u8], mut i: usize) -> usize {
        while i < b.len() {
            if b[i].is_ascii_whitespace() {
                i += 1;
            } else if b[i] == b'/' && matches!(b.get(i + 1), Some(b'/') | Some(b'*')) {
                i = comment_end(b, i);
            } else {
                break;
            }
        }
        i
    }

    /// `i` at the first byte of a value: index just past it.
    fn value_end(b: &[u8], i: usize) -> Result<usize, String> {
        match b.get(i) {
            Some(b'"') => string_end(b, i).ok_or_else(|| "chuỗi chưa đóng".to_string()),
            Some(b'{') | Some(b'[') => {
                let mut depth = 0usize;
                let mut j = i;
                while j < b.len() {
                    match b[j] {
                        b'"' => {
                            j = string_end(b, j).ok_or("chuỗi chưa đóng")?;
                            continue;
                        }
                        b'/' if matches!(b.get(j + 1), Some(b'/') | Some(b'*')) => {
                            j = comment_end(b, j);
                            continue;
                        }
                        b'{' | b'[' => depth += 1,
                        b'}' | b']' => {
                            depth -= 1;
                            if depth == 0 {
                                return Ok(j + 1);
                            }
                        }
                        _ => {}
                    }
                    j += 1;
                }
                Err("thiếu dấu đóng".into())
            }
            Some(_) => {
                let mut j = i;
                while j < b.len() && !matches!(b[j], b',' | b'}' | b']' | b'/') && !b[j].is_ascii_whitespace() {
                    j += 1;
                }
                if j == i { Err("thiếu giá trị".into()) } else { Ok(j) }
            }
            None => Err("tệp bị cắt ngang".into()),
        }
    }

    struct Member {
        key: String,
        key_start: usize,
        value_start: usize,
        value_end: usize,
    }

    /// Members of the object whose `{` is at `open`, and the index of its `}`.
    fn members(b: &[u8], open: usize) -> Result<(Vec<Member>, usize), String> {
        let mut out = Vec::new();
        let mut i = skip_ws(b, open + 1);
        loop {
            match b.get(i) {
                Some(b'}') => return Ok((out, i)),
                Some(b'"') => {}
                _ => return Err("cấu trúc JSON không hợp lệ".into()),
            }
            let key_end = string_end(b, i).ok_or("chuỗi chưa đóng")?;
            let key: String = serde_json::from_slice(&b[i..key_end]).map_err(|e| e.to_string())?;
            let colon = skip_ws(b, key_end);
            if b.get(colon) != Some(&b':') {
                return Err("thiếu dấu “:”".into());
            }
            let value_start = skip_ws(b, colon + 1);
            let value_end = value_end(b, value_start)?;
            out.push(Member { key, key_start: i, value_start, value_end });
            i = skip_ws(b, value_end);
            if b.get(i) == Some(&b',') {
                i = skip_ws(b, i + 1);
            }
        }
    }

    fn line_indent(text: &str, pos: usize) -> String {
        let line_start = text[..pos].rfind('\n').map_or(0, |p| p + 1);
        text[line_start..].chars().take_while(|c| *c == ' ' || *c == '\t').collect()
    }

    /// One indentation step, as the file uses it (the leading whitespace of its first indented line).
    fn indent_unit(text: &str) -> String {
        text.lines()
            .map(|l| l.chars().take_while(|c| *c == ' ' || *c == '\t').collect::<String>())
            .find(|w| !w.is_empty())
            .unwrap_or_else(|| "  ".into())
    }

    fn render(value: &Value, indent: &str, unit: &str) -> String {
        let pretty = serde_json::to_string_pretty(value).unwrap_or_default();
        let pretty = if unit == "  " { pretty } else { pretty.lines().map(|l| reindent(l, unit)).collect::<Vec<_>>().join("\n") };
        pretty.replace('\n', &format!("\n{indent}"))
    }

    fn reindent(line: &str, unit: &str) -> String {
        let n = line.len() - line.trim_start_matches(' ').len();
        format!("{}{}", unit.repeat(n / 2), &line[n..])
    }

    fn root(b: &[u8]) -> Result<usize, String> {
        let r = skip_ws(b, 0);
        if b.get(r) == Some(&b'{') { Ok(r) } else { Err("tệp cấu hình không phải một đối tượng JSON".into()) }
    }

    /// Sets `path…/key` to `value`, creating the containing objects as needed.
    pub fn set_member(text: &str, path: &[&str], key: &str, value: &Value) -> Result<String, String> {
        if text.trim().is_empty() {
            let mut v = value.clone();
            for p in std::iter::once(&key).chain(path.iter().rev()) {
                v = serde_json::json!({ *p: v });
            }
            return Ok(format!("{}\n", serde_json::to_string_pretty(&v).unwrap_or_default()));
        }
        let b = text.as_bytes();
        let unit = indent_unit(text);
        let mut obj = root(b)?;
        // Walk down; at the first missing level, insert the rest of the path as one nested value.
        let mut nested: Option<(&str, Value)> = None;
        for (depth, p) in path.iter().enumerate() {
            let (ms, _) = members(b, obj)?;
            match ms.into_iter().find(|m| m.key == *p) {
                Some(m) if b[m.value_start] == b'{' => obj = m.value_start,
                Some(m) => {
                    // Present but not an object (e.g. `null`): replace its value.
                    let mut v = serde_json::json!({ key: value });
                    for q in path[depth + 1..].iter().rev() {
                        v = serde_json::json!({ *q: v });
                    }
                    let indent = line_indent(text, m.key_start);
                    return Ok(splice(text, m.value_start, m.value_end, &render(&v, &indent, &unit)));
                }
                None => {
                    let mut v = serde_json::json!({ key: value });
                    for q in path[depth + 1..].iter().rev() {
                        v = serde_json::json!({ *q: v });
                    }
                    nested = Some((p, v));
                    break;
                }
            }
        }
        let (name, v) = nested.unwrap_or((key, value.clone()));
        let (ms, close) = members(b, obj)?;
        if let Some(m) = ms.iter().find(|m| m.key == name) {
            let indent = line_indent(text, m.key_start);
            return Ok(splice(text, m.value_start, m.value_end, &render(&v, &indent, &unit)));
        }
        let encoded_key = serde_json::to_string(name).unwrap_or_default();
        match ms.last() {
            Some(last) => {
                let indent = line_indent(text, ms[0].key_start);
                let member = format!(",\n{indent}{encoded_key}: {}", render(&v, &indent, &unit));
                Ok(splice(text, last.value_end, last.value_end, &member))
            }
            None => {
                let outer = line_indent(text, obj);
                let indent = format!("{outer}{unit}");
                let member = format!("\n{indent}{encoded_key}: {}", render(&v, &indent, &unit));
                if text[obj + 1..close].trim().is_empty() {
                    Ok(splice(text, obj + 1, close, &format!("{member}\n{outer}")))
                } else {
                    // Only comments inside: keep them after the new member.
                    Ok(splice(text, obj + 1, obj + 1, &member))
                }
            }
        }
    }

    /// Removes `path…/key` if present.
    pub fn remove_member(text: &str, path: &[&str], key: &str) -> Result<String, String> {
        if text.trim().is_empty() {
            return Ok(text.to_string());
        }
        let b = text.as_bytes();
        let mut obj = root(b)?;
        for p in path {
            let (ms, _) = members(b, obj)?;
            match ms.into_iter().find(|m| m.key == *p) {
                Some(m) if b[m.value_start] == b'{' => obj = m.value_start,
                _ => return Ok(text.to_string()),
            }
        }
        let (ms, close) = members(b, obj)?;
        let Some(k) = ms.iter().position(|m| m.key == key) else { return Ok(text.to_string()) };
        Ok(if ms.len() == 1 {
            splice(text, obj + 1, close, "")
        } else if k + 1 < ms.len() {
            splice(text, ms[k].key_start, ms[k + 1].key_start, "")
        } else {
            splice(text, ms[k - 1].value_end, ms[k].value_end, "")
        })
    }

    fn splice(text: &str, from: usize, to: usize, with: &str) -> String {
        format!("{}{with}{}", &text[..from], &text[to..])
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use serde_json::json;

        #[test]
        fn parses_comments_and_trailing_commas() {
            let v = parse("// top\n{ \"a\": 1, /* x */ \"b\": [1,2,], }\n").unwrap();
            assert_eq!(v, json!({ "a": 1, "b": [1, 2] }));
            assert_eq!(parse("   ").unwrap(), json!({}));
            assert_eq!(parse("{\"u\": \"http://x//y\"}").unwrap(), json!({ "u": "http://x//y" }));
        }

        #[test]
        fn inserts_into_existing_container_keeping_comments() {
            let text = "{\n  // my servers\n  \"mcpServers\": {\n    \"other\": { \"command\": \"x\" }\n  },\n  \"theme\": \"dark\" // keep\n}\n";
            let out = set_member(text, &["mcpServers"], "compola", &json!({ "url": "u" })).unwrap();
            assert!(out.contains("// my servers") && out.contains("// keep"));
            let v = parse(&out).unwrap();
            assert_eq!(v["mcpServers"]["compola"], json!({ "url": "u" }));
            assert_eq!(v["mcpServers"]["other"], json!({ "command": "x" }));
            assert!(out.contains("\n    \"compola\": {\n      \"url\": \"u\"\n    }"), "{out}");
        }

        #[test]
        fn creates_missing_container_and_file() {
            let out = set_member("{\n  \"a\": 1\n}", &["context_servers"], "compola", &json!({ "url": "u" })).unwrap();
            assert_eq!(parse(&out).unwrap(), json!({ "a": 1, "context_servers": { "compola": { "url": "u" } } }));
            let out = set_member("", &["mcpServers"], "compola", &json!(1)).unwrap();
            assert_eq!(parse(&out).unwrap(), json!({ "mcpServers": { "compola": 1 } }));
            let out = set_member("{}", &["mcpServers"], "compola", &json!(1)).unwrap();
            assert_eq!(parse(&out).unwrap(), json!({ "mcpServers": { "compola": 1 } }));
            let out = set_member("{ \"mcpServers\": {} }", &["mcpServers"], "compola", &json!(1)).unwrap();
            assert_eq!(parse(&out).unwrap(), json!({ "mcpServers": { "compola": 1 } }));
            let out = set_member("{ \"mcpServers\": null }", &["mcpServers"], "compola", &json!(1)).unwrap();
            assert_eq!(parse(&out).unwrap(), json!({ "mcpServers": { "compola": 1 } }));
            let out = set_member("{\n  // only a comment\n}", &["mcpServers"], "compola", &json!(1)).unwrap();
            assert_eq!(parse(&out).unwrap(), json!({ "mcpServers": { "compola": 1 } }));
            assert!(out.contains("// only a comment"));
        }

        #[test]
        fn replaces_and_removes() {
            let text = "{\"mcpServers\": {\"a\": 1, \"compola\": {\"url\": \"old\"}, \"b\": 2,}}";
            let out = set_member(text, &["mcpServers"], "compola", &json!({ "url": "new" })).unwrap();
            assert_eq!(parse(&out).unwrap(), json!({ "mcpServers": { "a": 1, "compola": { "url": "new" }, "b": 2 } }));
            let out = remove_member(&out, &["mcpServers"], "compola").unwrap();
            assert_eq!(parse(&out).unwrap(), json!({ "mcpServers": { "a": 1, "b": 2 } }));
            let out = remove_member(&out, &["mcpServers"], "b").unwrap();
            assert_eq!(parse(&out).unwrap(), json!({ "mcpServers": { "a": 1 } }));
            let out = remove_member(&out, &["mcpServers"], "a").unwrap();
            assert_eq!(parse(&out).unwrap(), json!({ "mcpServers": {} }));
            assert_eq!(remove_member("{}", &["mcpServers"], "x").unwrap(), "{}");
        }

        #[test]
        fn keeps_tab_indentation() {
            let out = set_member("{\n\t\"mcpServers\": {\n\t\t\"a\": 1\n\t}\n}", &["mcpServers"], "compola", &json!({ "url": "u" })).unwrap();
            assert!(out.contains("\n\t\t\"compola\": {\n\t\t\t\"url\": \"u\"\n\t\t}"), "{out}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(home: &Path) -> Ctx {
        Ctx { home: home.to_path_buf(), endpoint: "http://127.0.0.1:39217/mcp".into(), token: "0123456789abcdef0123".into() }
    }

    fn temp_home(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("compola-ai-clients-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn codex_block_roundtrip() {
        let home = temp_home("codex");
        let c = ctx(&home);
        let spec = spec("codex").unwrap();
        let path = home.join(spec.config);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let original = "model = \"gpt\"\n\n[mcp_servers.other]\ncommand = \"x\"\n\n[mcp_servers.compola]\nurl = \"old\"\n\n[mcp_servers.compola.env]\nA = \"b\"\n\n[profiles.fast]\nmodel = \"y\"\n";
        std::fs::write(&path, original).unwrap();
        assert_eq!(status_of(spec, &c).unwrap(), Status::Outdated);
        install(spec, &c).unwrap();
        assert_eq!(status_of(spec, &c).unwrap(), Status::Connected);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("[mcp_servers.other]\ncommand = \"x\"") && text.contains("[profiles.fast]\nmodel = \"y\""));
        assert!(!text.contains("url = \"old\"") && !text.contains("A = \"b\""));
        assert_eq!(std::fs::read_to_string(home.join(".codex/config.toml.compola-backup")).unwrap(), original);
        remove(spec, &c).unwrap();
        assert_eq!(status_of(spec, &c).unwrap(), Status::NotConnected);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("[profiles.fast]") && !text.contains("compola"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn json_install_status_remove() {
        let home = temp_home("json");
        let c = ctx(&home);
        let spec = spec("cursor").unwrap();
        assert_eq!(status_of(spec, &c).unwrap(), Status::NotConnected);
        install(spec, &c).unwrap();
        assert_eq!(status_of(spec, &c).unwrap(), Status::Connected);
        let other = Ctx { token: "ffffffffffffffffffff".into(), ..ctx(&home) };
        assert_eq!(status_of(spec, &other).unwrap(), Status::Outdated);
        remove(spec, &c).unwrap();
        assert_eq!(status_of(spec, &c).unwrap(), Status::NotConnected);
        // A file we cannot parse is reported, never rewritten.
        std::fs::write(home.join(spec.config), "{ broken").unwrap();
        assert_eq!(status_of(spec, &c).unwrap_err().contains("không phải JSON hợp lệ"), true);
        assert!(install(spec, &c).is_err());
        assert_eq!(std::fs::read_to_string(home.join(spec.config)).unwrap(), "{ broken");
        let _ = std::fs::remove_dir_all(&home);
    }
}
