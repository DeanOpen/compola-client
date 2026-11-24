//! What add-ons put in front of people, per account and conversation:
//!
//! - **notes** (comments on a conversation, by an add-on or a person) — SQLite `addons.db`, kept across restarts;
//! - **suggestions** — reply drafts above the composer (sent, edited or dismissed by a person); in memory, expire;
//! - **panels** — small declarative cards in the chat inspector (text, key/value rows, lists, buttons); in memory;
//! - **quick replies** and runtime **actions** each add-on registers; in memory (re-registered when it starts).
//!
//! The UI reads it all with `addons_workspace` and listens to `compola://addons`.

use std::collections::HashMap;
use std::path::Path;

use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::{Value, json};

const MAX_NOTE_CHARS: usize = 20_000;
const MAX_NOTES_PER_CONVERSATION: i64 = 2_000;
const MAX_SUGGESTIONS_PER_CONVERSATION: usize = 5;
const MAX_SUGGESTION_CHARS: usize = 5_000;
const DEFAULT_SUGGESTION_TTL_MS: i64 = 6 * 3600 * 1000;
const MAX_PANEL_BYTES: usize = 64 * 1024;
const MAX_QUICK_REPLIES: usize = 500;

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub account: String,
    pub conversation_id: String,
    pub message_id: Option<String>,
    /// `addon` or `user`.
    pub author_kind: String,
    pub author_id: String,
    pub author_name: String,
    pub text: String,
    pub pinned: bool,
    pub tags: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub id: String,
    pub addon_id: String,
    pub addon_name: String,
    pub account: String,
    pub conversation_id: String,
    pub title: String,
    pub text: String,
    pub created_at: i64,
    pub expires_at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Panel {
    pub addon_id: String,
    pub addon_name: String,
    pub account: String,
    /// None: shown for every conversation of the account.
    pub conversation_id: Option<String>,
    pub title: String,
    pub blocks: Vec<Value>,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickReply {
    pub addon_id: String,
    pub shortcut: String,
    pub title: String,
    pub text: String,
}

#[derive(Default)]
struct Live {
    suggestions: Vec<Suggestion>,
    panels: Vec<Panel>,
    quick_replies: HashMap<String, Vec<QuickReply>>,
    actions: HashMap<String, Vec<Value>>,
}

pub struct Workspace {
    db: Option<Mutex<Connection>>,
    live: Mutex<Live>,
}

pub fn clean_text(s: &str, max: usize) -> String {
    s.chars().filter(|c| *c == '\n' || *c == '\t' || !c.is_control()).take(max).collect::<String>().trim().to_owned()
}

/// A note's fields from a row.
fn row_note(r: &rusqlite::Row<'_>) -> rusqlite::Result<Note> {
    let tags: String = r.get("tags")?;
    Ok(Note {
        id: r.get("id")?,
        account: r.get("account")?,
        conversation_id: r.get("conv_id")?,
        message_id: r.get("message_id")?,
        author_kind: r.get("author_kind")?,
        author_id: r.get("author_id")?,
        author_name: r.get("author_name")?,
        text: r.get("text")?,
        pinned: r.get::<_, i64>("pinned")? != 0,
        tags: serde_json::from_str(&tags).unwrap_or_default(),
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
    })
}

/// Who writes a note.
pub struct Author {
    pub kind: &'static str,
    pub id: String,
    pub name: String,
}

#[derive(Default)]
pub struct NoteInput {
    pub message_id: Option<String>,
    pub pinned: bool,
    pub tags: Vec<String>,
    /// Replaces the add-on's earlier note with the same key in this conversation (a daily summary updates in place).
    pub key: Option<String>,
}

impl Workspace {
    pub fn open(path: &Path) -> Self {
        let db = match Self::open_db(path) {
            Ok(c) => Some(Mutex::new(c)),
            Err(e) => {
                log::warn!("add-on notes unavailable ({}): {e}", path.display());
                None
            }
        };
        Self { db, live: Mutex::default() }
    }

    #[cfg(test)]
    pub fn in_memory() -> Self {
        Self { db: Self::init(Connection::open_in_memory().expect("sqlite")).ok().map(Mutex::new), live: Mutex::default() }
    }

    fn open_db(path: &Path) -> Result<Connection, String> {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
        Self::init(conn)
    }

    fn init(conn: Connection) -> Result<Connection, String> {
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;
             CREATE TABLE IF NOT EXISTS notes(
               id TEXT PRIMARY KEY, account TEXT NOT NULL, conv_id TEXT NOT NULL, message_id TEXT,
               author_kind TEXT NOT NULL, author_id TEXT NOT NULL, author_name TEXT NOT NULL DEFAULT '',
               note_key TEXT, text TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '[]',
               created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
             CREATE INDEX IF NOT EXISTS notes_conv ON notes(account, conv_id, created_at);
             CREATE UNIQUE INDEX IF NOT EXISTS notes_key ON notes(account, conv_id, author_id, note_key) WHERE note_key IS NOT NULL;",
        )
        .map_err(|e| e.to_string())?;
        Ok(conn)
    }

    fn db(&self) -> Result<parking_lot::MutexGuard<'_, Connection>, String> {
        self.db.as_ref().map(|m| m.lock()).ok_or_else(|| "kho ghi chú không mở được".to_owned())
    }

    // ---- notes ----

    pub fn notes(&self, account: &str, conversation_id: &str, limit: usize) -> Result<Vec<Note>, String> {
        let db = self.db()?;
        let mut st = db
            .prepare_cached("SELECT * FROM notes WHERE account = ?1 AND conv_id = ?2 ORDER BY pinned DESC, created_at DESC LIMIT ?3")
            .map_err(|e| e.to_string())?;
        st.query_map(params![account, conversation_id, limit.clamp(1, 1000) as i64], row_note)
            .and_then(|rows| rows.collect())
            .map_err(|e| e.to_string())
    }

    pub fn note(&self, id: &str) -> Result<Option<Note>, String> {
        let db = self.db()?;
        db.query_row("SELECT * FROM notes WHERE id = ?1", [id], row_note).optional().map_err(|e| e.to_string())
    }

    pub fn add_note(&self, account: &str, conversation_id: &str, text: &str, author: &Author, input: NoteInput) -> Result<Note, String> {
        let text = clean_text(text, MAX_NOTE_CHARS);
        if text.is_empty() {
            return Err("ghi chú trống".into());
        }
        if conversation_id.trim().is_empty() {
            return Err("thiếu conversationId".into());
        }
        let tags: Vec<String> = input.tags.iter().map(|t| clean_text(t, 40)).filter(|t| !t.is_empty()).take(10).collect();
        let key = input.key.map(|k| clean_text(&k, 100)).filter(|k| !k.is_empty());
        let at = now();
        let db = self.db()?;
        if let Some(key) = &key {
            let existing: Option<String> = db
                .query_row(
                    "SELECT id FROM notes WHERE account = ?1 AND conv_id = ?2 AND author_id = ?3 AND note_key = ?4",
                    params![account, conversation_id, author.id, key],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if let Some(id) = existing {
                db.execute(
                    "UPDATE notes SET text = ?1, pinned = ?2, tags = ?3, message_id = ?4, author_name = ?5, updated_at = ?6 WHERE id = ?7",
                    params![text, input.pinned as i64, serde_json::to_string(&tags).unwrap_or_default(), input.message_id, author.name, at, id],
                )
                .map_err(|e| e.to_string())?;
                return db.query_row("SELECT * FROM notes WHERE id = ?1", [&id], row_note).map_err(|e| e.to_string());
            }
        }
        let count: i64 = db
            .query_row("SELECT COUNT(*) FROM notes WHERE account = ?1 AND conv_id = ?2", params![account, conversation_id], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if count >= MAX_NOTES_PER_CONVERSATION {
            // Oldest unpinned add-on notes make room (people's notes are never dropped silently).
            db.execute(
                "DELETE FROM notes WHERE id IN (SELECT id FROM notes WHERE account = ?1 AND conv_id = ?2 AND pinned = 0 AND author_kind = 'addon' ORDER BY created_at ASC LIMIT 1)",
                params![account, conversation_id],
            )
            .map_err(|e| e.to_string())?;
        }
        let note = Note {
            id: format!("note_{}", uuid::Uuid::new_v4().simple()),
            account: account.to_owned(),
            conversation_id: conversation_id.to_owned(),
            message_id: input.message_id,
            author_kind: author.kind.to_owned(),
            author_id: author.id.clone(),
            author_name: author.name.clone(),
            text,
            pinned: input.pinned,
            tags,
            created_at: at,
            updated_at: at,
        };
        db.execute(
            "INSERT INTO notes(id, account, conv_id, message_id, author_kind, author_id, author_name, note_key, text, pinned, tags, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                note.id,
                note.account,
                note.conversation_id,
                note.message_id,
                note.author_kind,
                note.author_id,
                note.author_name,
                key,
                note.text,
                note.pinned as i64,
                serde_json::to_string(&note.tags).unwrap_or_default(),
                note.created_at,
                note.updated_at
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(note)
    }

    /// `text` / `pinned` / `tags`; returns the updated note.
    pub fn update_note(&self, id: &str, patch: &Value) -> Result<Note, String> {
        let mut note = self.note(id)?.ok_or("không tìm thấy ghi chú")?;
        if let Some(t) = patch.get("text").and_then(Value::as_str) {
            let t = clean_text(t, MAX_NOTE_CHARS);
            if t.is_empty() {
                return Err("ghi chú trống".into());
            }
            note.text = t;
        }
        if let Some(p) = patch.get("pinned").and_then(Value::as_bool) {
            note.pinned = p;
        }
        if let Some(tags) = patch.get("tags").and_then(Value::as_array) {
            note.tags = tags.iter().filter_map(Value::as_str).map(|t| clean_text(t, 40)).filter(|t| !t.is_empty()).take(10).collect();
        }
        note.updated_at = now();
        self.db()?
            .execute(
                "UPDATE notes SET text = ?1, pinned = ?2, tags = ?3, updated_at = ?4 WHERE id = ?5",
                params![note.text, note.pinned as i64, serde_json::to_string(&note.tags).unwrap_or_default(), note.updated_at, id],
            )
            .map_err(|e| e.to_string())?;
        Ok(note)
    }

    pub fn remove_note(&self, id: &str) -> Result<Option<Note>, String> {
        let note = self.note(id)?;
        if note.is_some() {
            self.db()?.execute("DELETE FROM notes WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
        }
        Ok(note)
    }

    /// How many notes each conversation of an account has (conversation list badges).
    pub fn note_counts(&self, account: &str) -> Result<HashMap<String, i64>, String> {
        let db = self.db()?;
        let mut st = db.prepare_cached("SELECT conv_id, COUNT(*) FROM notes WHERE account = ?1 GROUP BY conv_id").map_err(|e| e.to_string())?;
        st.query_map([account], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .and_then(|rows| rows.collect())
            .map_err(|e| e.to_string())
    }

    // ---- suggestions ----

    pub fn suggest(&self, addon_id: &str, addon_name: &str, account: &str, conversation_id: &str, text: &str, opts: &Value) -> Result<Suggestion, String> {
        let text = clean_text(text, MAX_SUGGESTION_CHARS);
        if text.is_empty() {
            return Err("gợi ý trống".into());
        }
        let ttl = opts.get("ttlMinutes").and_then(Value::as_f64).map(|m| (m * 60_000.0) as i64).filter(|t| *t > 0).unwrap_or(DEFAULT_SUGGESTION_TTL_MS);
        let at = now();
        let s = Suggestion {
            id: opts
                .get("id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(|s| format!("{addon_id}:{}", clean_text(s, 64)))
                .unwrap_or_else(|| format!("sg_{}", uuid::Uuid::new_v4().simple())),
            addon_id: addon_id.to_owned(),
            addon_name: addon_name.to_owned(),
            account: account.to_owned(),
            conversation_id: conversation_id.to_owned(),
            title: opts.get("title").and_then(Value::as_str).map(|t| clean_text(t, 80)).unwrap_or_default(),
            text,
            created_at: at,
            expires_at: at + ttl.min(7 * 86_400_000),
        };
        let mut live = self.live.lock();
        live.suggestions.retain(|x| x.expires_at > at && x.id != s.id);
        live.suggestions.push(s.clone());
        // Newest few per conversation.
        let mut same: Vec<usize> = live.suggestions.iter().enumerate().filter(|(_, x)| x.account == account && x.conversation_id == conversation_id).map(|(i, _)| i).collect();
        while same.len() > MAX_SUGGESTIONS_PER_CONVERSATION {
            live.suggestions.remove(same.remove(0));
            same = live.suggestions.iter().enumerate().filter(|(_, x)| x.account == account && x.conversation_id == conversation_id).map(|(i, _)| i).collect();
        }
        Ok(s)
    }

    pub fn clear_suggestions(&self, addon_id: Option<&str>, account: &str, conversation_id: &str) -> usize {
        let mut live = self.live.lock();
        let before = live.suggestions.len();
        live.suggestions.retain(|s| !(s.account == account && s.conversation_id == conversation_id && addon_id.is_none_or(|a| s.addon_id == a)));
        before - live.suggestions.len()
    }

    pub fn take_suggestion(&self, id: &str) -> Option<Suggestion> {
        let mut live = self.live.lock();
        let i = live.suggestions.iter().position(|s| s.id == id)?;
        Some(live.suggestions.remove(i))
    }

    pub fn suggestions(&self, account: &str, conversation_id: &str) -> Vec<Suggestion> {
        let at = now();
        let mut live = self.live.lock();
        live.suggestions.retain(|s| s.expires_at > at);
        live.suggestions.iter().filter(|s| s.account == account && s.conversation_id == conversation_id).cloned().collect()
    }

    // ---- panels ----

    /// Sets (or with `panel` null, removes) the add-on's panel for a conversation (`None`: every conversation).
    pub fn set_panel(&self, addon_id: &str, addon_name: &str, account: &str, conversation_id: Option<&str>, panel: &Value) -> Result<(), String> {
        let mut live = self.live.lock();
        live.panels.retain(|p| !(p.addon_id == addon_id && p.account == account && p.conversation_id.as_deref() == conversation_id));
        if panel.is_null() {
            return Ok(());
        }
        if panel.to_string().len() > MAX_PANEL_BYTES {
            return Err(format!("panel quá lớn (tối đa {} KB)", MAX_PANEL_BYTES / 1024));
        }
        let blocks = panel.get("blocks").and_then(Value::as_array).cloned().unwrap_or_default().into_iter().filter_map(sanitize_block).take(100).collect();
        live.panels.push(Panel {
            addon_id: addon_id.to_owned(),
            addon_name: addon_name.to_owned(),
            account: account.to_owned(),
            conversation_id: conversation_id.map(str::to_owned),
            title: panel.get("title").and_then(Value::as_str).map(|t| clean_text(t, 80)).unwrap_or_else(|| addon_name.to_owned()),
            blocks,
            updated_at: now(),
        });
        Ok(())
    }

    pub fn panels(&self, account: &str, conversation_id: &str) -> Vec<Panel> {
        let live = self.live.lock();
        // A conversation's own panel wins over the add-on's account-wide one.
        let mut out: Vec<Panel> = live.panels.iter().filter(|p| p.account == account && p.conversation_id.as_deref() == Some(conversation_id)).cloned().collect();
        for p in live.panels.iter().filter(|p| p.account == account && p.conversation_id.is_none()) {
            if !out.iter().any(|o| o.addon_id == p.addon_id) {
                out.push(p.clone());
            }
        }
        out.sort_by(|a, b| a.addon_name.cmp(&b.addon_name));
        out
    }

    // ---- quick replies / actions ----

    pub fn set_quick_replies(&self, addon_id: &str, list: &[Value]) -> usize {
        let replies: Vec<QuickReply> = list
            .iter()
            .filter_map(|q| {
                let shortcut = clean_text(q.get("shortcut").and_then(Value::as_str).unwrap_or_default(), 40).trim_start_matches('/').to_owned();
                let text = clean_text(q.get("text").and_then(Value::as_str).unwrap_or_default(), MAX_SUGGESTION_CHARS);
                (!shortcut.is_empty() && !text.is_empty() && !shortcut.contains(char::is_whitespace)).then(|| QuickReply {
                    addon_id: addon_id.to_owned(),
                    title: q.get("title").and_then(Value::as_str).map(|t| clean_text(t, 80)).unwrap_or_default(),
                    shortcut,
                    text,
                })
            })
            .take(MAX_QUICK_REPLIES)
            .collect();
        let n = replies.len();
        let mut live = self.live.lock();
        if replies.is_empty() {
            live.quick_replies.remove(addon_id);
        } else {
            live.quick_replies.insert(addon_id.to_owned(), replies);
        }
        n
    }

    /// Every enabled add-on's quick replies (`enabled` filters), sorted by shortcut.
    pub fn quick_replies(&self, enabled: &dyn Fn(&str) -> bool) -> Vec<QuickReply> {
        let live = self.live.lock();
        let mut out: Vec<QuickReply> = live.quick_replies.iter().filter(|(id, _)| enabled(id)).flat_map(|(_, l)| l.iter().cloned()).collect();
        out.sort_by(|a, b| a.shortcut.cmp(&b.shortcut));
        out
    }

    pub fn set_actions(&self, addon_id: &str, list: &[Value]) {
        let actions: Vec<Value> = list.iter().filter_map(sanitize_action).take(50).collect();
        let mut live = self.live.lock();
        if actions.is_empty() {
            live.actions.remove(addon_id);
        } else {
            live.actions.insert(addon_id.to_owned(), actions);
        }
    }

    pub fn runtime_actions(&self, addon_id: &str) -> Vec<Value> {
        self.live.lock().actions.get(addon_id).cloned().unwrap_or_default()
    }

    /// An add-on stopped or was removed: its live contributions go (its notes stay: people may rely on them).
    pub fn forget_addon(&self, addon_id: &str) {
        let mut live = self.live.lock();
        live.suggestions.retain(|s| s.addon_id != addon_id);
        live.panels.retain(|p| p.addon_id != addon_id);
        live.quick_replies.remove(addon_id);
        live.actions.remove(addon_id);
    }
}

/// `{id, title, context: conversation|message|composer, icon?, description?}`.
pub fn sanitize_action(a: &Value) -> Option<Value> {
    let id = clean_text(a.get("id").and_then(Value::as_str)?, 64);
    let title = clean_text(a.get("title").and_then(Value::as_str).unwrap_or(&id), 80);
    let context = match a.get("context").and_then(Value::as_str).unwrap_or("conversation") {
        c @ ("conversation" | "message" | "composer") => c,
        _ => "conversation",
    };
    (!id.is_empty()).then(|| {
        json!({
            "id": id, "title": title, "context": context,
            "description": a.get("description").and_then(Value::as_str).map(|d| clean_text(d, 200)).unwrap_or_default(),
        })
    })
}

/// Panel blocks the UI draws (anything else is dropped): `text`, `heading`, `kv`, `list`, `badges`, `button`,
/// `divider`, `progress`. Text only: no HTML, no images, no links that run code.
pub fn sanitize_block(b: Value) -> Option<Value> {
    let s = |k: &str, max: usize| b.get(k).and_then(Value::as_str).map(|t| clean_text(t, max)).unwrap_or_default();
    let kind = b.get("type").and_then(Value::as_str)?;
    Some(match kind {
        "text" => json!({ "type": "text", "text": s("text", 4000), "muted": b.get("muted").and_then(Value::as_bool).unwrap_or(false) }),
        "heading" => json!({ "type": "heading", "text": s("text", 200) }),
        "kv" => {
            let items: Vec<Value> = b
                .get("items")
                .and_then(Value::as_array)?
                .iter()
                .take(50)
                .map(|i| json!({ "label": clean_text(i.get("label").and_then(Value::as_str).unwrap_or_default(), 80), "value": clean_text(&match i.get("value") { Some(Value::String(v)) => v.clone(), Some(v) => v.to_string(), None => String::new() }, 500) }))
                .collect();
            json!({ "type": "kv", "items": items })
        }
        "list" => {
            let items: Vec<Value> = b.get("items").and_then(Value::as_array)?.iter().filter_map(Value::as_str).take(100).map(|t| json!(clean_text(t, 500))).collect();
            json!({ "type": "list", "items": items, "ordered": b.get("ordered").and_then(Value::as_bool).unwrap_or(false) })
        }
        "badges" => {
            let items: Vec<Value> = b.get("items").and_then(Value::as_array)?.iter().filter_map(Value::as_str).take(20).map(|t| json!(clean_text(t, 40))).collect();
            json!({ "type": "badges", "items": items })
        }
        "button" => {
            let action = s("action", 64);
            if action.is_empty() {
                return None;
            }
            let payload = b.get("payload").cloned().unwrap_or(Value::Null);
            if payload.to_string().len() > 4096 {
                return None;
            }
            json!({ "type": "button", "label": s("label", 60), "action": action, "payload": payload, "style": if s("style", 16) == "primary" { "primary" } else { "default" } })
        }
        "progress" => json!({ "type": "progress", "label": s("label", 80), "value": b.get("value").and_then(Value::as_f64).unwrap_or(0.0).clamp(0.0, 1.0) }),
        "divider" => json!({ "type": "divider" }),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bot() -> Author {
        Author { kind: "addon", id: "daily-summary".into(), name: "Tóm tắt".into() }
    }

    #[test]
    fn notes_crud_and_keyed_upsert() {
        let w = Workspace::in_memory();
        let a = w.add_note("default", "u1", "  Khách hỏi giá  ", &bot(), NoteInput::default()).unwrap();
        assert_eq!(a.text, "Khách hỏi giá");
        let k1 = w.add_note("default", "u1", "Tóm tắt 1", &bot(), NoteInput { key: Some("day".into()), ..Default::default() }).unwrap();
        let k2 = w.add_note("default", "u1", "Tóm tắt 2", &bot(), NoteInput { key: Some("day".into()), pinned: true, ..Default::default() }).unwrap();
        assert_eq!(k1.id, k2.id, "same key updates in place");
        let list = w.notes("default", "u1", 50).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].text, "Tóm tắt 2", "pinned first");
        assert!(w.notes("a1234abcd", "u1", 50).unwrap().is_empty(), "per account");
        let up = w.update_note(&a.id, &json!({ "text": "Đã báo giá", "tags": ["giá", ""] })).unwrap();
        assert_eq!((up.text.as_str(), up.tags.len()), ("Đã báo giá", 1));
        assert!(w.update_note(&a.id, &json!({ "text": "  " })).is_err());
        assert!(w.remove_note(&a.id).unwrap().is_some());
        assert_eq!(w.note_counts("default").unwrap().get("u1"), Some(&1));
        assert!(w.add_note("default", "u1", "\u{0}\u{7}", &bot(), NoteInput::default()).is_err());
    }

    #[test]
    fn suggestions_expire_and_cap() {
        let w = Workspace::in_memory();
        for i in 0..8 {
            w.suggest("ai", "AI", "default", "u1", &format!("gợi ý {i}"), &json!({})).unwrap();
        }
        let list = w.suggestions("default", "u1");
        assert_eq!(list.len(), MAX_SUGGESTIONS_PER_CONVERSATION);
        assert_eq!(list.last().unwrap().text, "gợi ý 7");
        // Same id replaces.
        w.suggest("ai", "AI", "default", "u2", "a", &json!({ "id": "reply" })).unwrap();
        w.suggest("ai", "AI", "default", "u2", "b", &json!({ "id": "reply" })).unwrap();
        assert_eq!(w.suggestions("default", "u2").len(), 1);
        let id = w.suggestions("default", "u2")[0].id.clone();
        assert_eq!(w.take_suggestion(&id).unwrap().text, "b");
        assert_eq!(w.clear_suggestions(Some("ai"), "default", "u1"), MAX_SUGGESTIONS_PER_CONVERSATION);
    }

    #[test]
    fn panels_are_sanitized() {
        let w = Workspace::in_memory();
        let panel = json!({ "title": "Khách hàng", "blocks": [
            { "type": "kv", "items": [{ "label": "Đơn", "value": 3 }] },
            { "type": "html", "html": "<script>" },
            { "type": "button", "label": "Tóm tắt", "action": "summarize" },
            { "type": "button", "label": "no action" },
        ]});
        w.set_panel("crm", "CRM", "default", None, &panel).unwrap();
        w.set_panel("crm", "CRM", "default", Some("u1"), &json!({ "blocks": [{ "type": "text", "text": "riêng" }] })).unwrap();
        let p = w.panels("default", "u1");
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].blocks[0]["text"], "riêng");
        let p = w.panels("default", "u2");
        assert_eq!(p[0].blocks.len(), 2);
        assert_eq!(p[0].blocks[0]["items"][0]["value"], "3");
        w.set_panel("crm", "CRM", "default", None, &Value::Null).unwrap();
        assert!(w.panels("default", "u2").is_empty());
    }

    #[test]
    fn quick_replies() {
        let w = Workspace::in_memory();
        let n = w.set_quick_replies("q", &[json!({ "shortcut": "/chao", "text": "Xin chào" }), json!({ "shortcut": "bad one", "text": "x" }), json!({ "shortcut": "gia", "text": "" })]);
        assert_eq!(n, 1);
        assert_eq!(w.quick_replies(&|_| true)[0].shortcut, "chao");
        assert!(w.quick_replies(&|id| id != "q").is_empty());
        w.forget_addon("q");
        assert!(w.quick_replies(&|_| true).is_empty());
    }
}
