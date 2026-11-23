//! Message search for people and for RAG: a local index (`~/Library/Application Support/Compola/search.db`) of every
//! message Compola sees (`mirror.rs`: the conversations' latest messages and the loaded history of opened chats).
//!
//! - Keyword: SQLite FTS5 over the text folded like `tools::fold` (lowercase, Vietnamese accents and đ removed), so
//!   "hop luc 3h" finds "Họp lúc 3h"; ranked by BM25, every word must match (falls back to any word).
//! - Semantic (optional): embeddings from a local Ollama model or an OpenAI-compatible API, computed in the background
//!   and compared by cosine similarity.
//! - Hybrid: both result lists merged by reciprocal-rank fusion. Each hit can carry the messages around it, which is
//!   the context an AI client needs to answer from (`search_messages` MCP tool).
//!
//! The index never leaves the Mac except as text sent to the embeddings provider the user configured.

use std::path::{Path, PathBuf};
use std::time::Duration;

use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::{Value, json};

use super::config::SearchConfig;
use super::mirror::Message;
use super::tools::fold;

const RRF_K: f64 = 60.0;
/// Preview-derived rows are replaced by the real chat message when one arrives within this many ms.
const SAME_MESSAGE_MS: i64 = 3000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    #[serde(flatten)]
    pub message: Message,
    pub score: f64,
    /// `keyword`, `semantic` or `both`.
    pub matched: &'static str,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub context: Vec<Message>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub messages: i64,
    pub conversations: i64,
    pub embedded: i64,
    pub embed_model: String,
    pub oldest: Option<i64>,
    pub newest: Option<i64>,
    pub bytes: u64,
}

pub struct Index {
    conn: Mutex<Connection>,
    path: PathBuf,
}

fn row_message(r: &rusqlite::Row<'_>) -> rusqlite::Result<Message> {
    Ok(Message {
        id: r.get("msg_id")?,
        conversation_id: r.get("conv_id")?,
        conversation_name: r.get("conv_name")?,
        is_group: r.get::<_, i64>("is_group")? != 0,
        sender_name: r.get("sender")?,
        from_me: r.get::<_, i64>("from_me")? != 0,
        text: r.get("text")?,
        date: r.get("date")?,
        source: if r.get::<_, String>("source")? == "chat" { "chat" } else { "preview" },
    })
}

const COLUMNS: &str = "rowid, msg_id, conv_id, conv_name, is_group, sender, from_me, text, date, source";

/// FTS5 MATCH expression: every folded word as a quoted prefix term (`all`), or any of them.
fn fts_query(query: &str, all: bool) -> Option<String> {
    let folded = fold(query);
    let words: Vec<String> = folded
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .take(16)
        .map(|w| format!("\"{w}\"*"))
        .collect();
    if words.is_empty() {
        return None;
    }
    Some(words.join(if all { " " } else { " OR " }))
}

/// Text worth embedding: not a bare type label like "[Hình ảnh]" or a one-word reaction.
fn embeddable(text: &str) -> bool {
    let t = text.trim();
    t.chars().count() >= 4 && !(t.starts_with('[') && t.ends_with(']') && !t[1..t.len() - 1].contains('['))
}

fn to_blob(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

fn from_blob(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
}

fn normalize(v: &mut [f32]) {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n > 0.0 {
        v.iter_mut().for_each(|x| *x /= n);
    }
}

impl Index {
    pub fn path() -> PathBuf {
        crate::platform::app_support().join("search.db")
    }

    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA cache_size=-16384;
             CREATE TABLE IF NOT EXISTS messages(
                rowid INTEGER PRIMARY KEY, msg_id TEXT NOT NULL UNIQUE, conv_id TEXT NOT NULL, conv_name TEXT NOT NULL DEFAULT '',
                is_group INTEGER NOT NULL DEFAULT 0, sender TEXT NOT NULL DEFAULT '', from_me INTEGER NOT NULL DEFAULT 0,
                text TEXT NOT NULL, date INTEGER NOT NULL, source TEXT NOT NULL, emb BLOB, emb_model TEXT);
             CREATE INDEX IF NOT EXISTS messages_conv_date ON messages(conv_id, date);
             CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(body, tokenize = 'unicode61 remove_diacritics 2');",
        )
        .map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(Self { conn: Mutex::new(conn), path: path.to_owned() })
    }

    /// Adds or updates messages (by id). A changed text drops its embedding; a preview row is dropped when the chat
    /// message it stood for arrives, and not added when that message is already indexed.
    pub fn upsert(&self, messages: &[Message]) -> Result<usize, String> {
        if messages.is_empty() {
            return Ok(0);
        }
        let mut conn = self.conn.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mut written = 0;
        for m in messages {
            if m.text.trim().is_empty() || m.conversation_id.is_empty() {
                continue;
            }
            let near = |source: &str| -> rusqlite::Result<Vec<i64>> {
                let mut st = tx.prepare_cached("SELECT rowid FROM messages WHERE conv_id = ?1 AND source = ?2 AND date BETWEEN ?3 AND ?4")?;
                st.query_map(params![m.conversation_id, source, m.date - SAME_MESSAGE_MS, m.date + SAME_MESSAGE_MS], |r| r.get(0))?.collect()
            };
            if m.source == "preview" {
                if !near("chat").map_err(|e| e.to_string())?.is_empty() {
                    continue;
                }
            } else {
                for rowid in near("preview").map_err(|e| e.to_string())? {
                    tx.execute("DELETE FROM messages WHERE rowid = ?1", [rowid]).map_err(|e| e.to_string())?;
                    tx.execute("DELETE FROM messages_fts WHERE rowid = ?1", [rowid]).map_err(|e| e.to_string())?;
                }
            }
            let existing: Option<(i64, String)> = tx
                .prepare_cached("SELECT rowid, text FROM messages WHERE msg_id = ?1")
                .and_then(|mut st| st.query_row([&m.id], |r| Ok((r.get(0)?, r.get(1)?))).optional())
                .map_err(|e| e.to_string())?;
            match existing {
                Some((rowid, text)) if text == m.text => {
                    tx.execute(
                        "UPDATE messages SET conv_name = ?2, sender = ?3, date = ?4 WHERE rowid = ?1 AND (conv_name != ?2 OR sender != ?3 OR date != ?4)",
                        params![rowid, m.conversation_name, m.sender_name, m.date],
                    )
                    .map_err(|e| e.to_string())?;
                }
                Some((rowid, _)) => {
                    tx.execute(
                        "UPDATE messages SET conv_name = ?2, sender = ?3, date = ?4, text = ?5, emb = NULL, emb_model = NULL WHERE rowid = ?1",
                        params![rowid, m.conversation_name, m.sender_name, m.date, m.text],
                    )
                    .map_err(|e| e.to_string())?;
                    tx.execute("UPDATE messages_fts SET body = ?2 WHERE rowid = ?1", params![rowid, fold(&m.text)]).map_err(|e| e.to_string())?;
                    written += 1;
                }
                None => {
                    tx.execute(
                        "INSERT INTO messages(msg_id, conv_id, conv_name, is_group, sender, from_me, text, date, source) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                        params![m.id, m.conversation_id, m.conversation_name, m.is_group as i64, m.sender_name, m.from_me as i64, m.text, m.date, m.source],
                    )
                    .map_err(|e| e.to_string())?;
                    let rowid = tx.last_insert_rowid();
                    tx.execute("INSERT INTO messages_fts(rowid, body) VALUES(?1, ?2)", params![rowid, fold(&m.text)]).map_err(|e| e.to_string())?;
                    written += 1;
                }
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(written)
    }

    pub fn clear(&self) -> Result<(), String> {
        self.conn.lock().execute_batch("DELETE FROM messages; DELETE FROM messages_fts; VACUUM;").map_err(|e| e.to_string())
    }

    pub fn stats(&self) -> Stats {
        let conn = self.conn.lock();
        let one = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, Option<i64>>(0)).ok().flatten();
        let model = conn
            .query_row("SELECT emb_model FROM messages WHERE length(emb) > 0 GROUP BY emb_model ORDER BY count(*) DESC LIMIT 1", [], |r| r.get::<_, String>(0))
            .unwrap_or_default();
        Stats {
            messages: one("SELECT count(*) FROM messages").unwrap_or(0),
            conversations: one("SELECT count(DISTINCT conv_id) FROM messages").unwrap_or(0),
            embedded: one("SELECT count(*) FROM messages WHERE length(emb) > 0").unwrap_or(0),
            embed_model: model,
            oldest: one("SELECT min(date) FROM messages"),
            newest: one("SELECT max(date) FROM messages"),
            bytes: ["", "-wal"].iter().filter_map(|s| std::fs::metadata(format!("{}{s}", self.path.display())).ok()).map(|m| m.len()).sum(),
        }
    }

    /// Keyword ranking: (rowid, bm25 rank position).
    pub fn keyword(&self, query: &str, conversation: Option<&str>, limit: usize) -> Vec<i64> {
        let conn = self.conn.lock();
        let run = |q: &str| -> Vec<i64> {
            let sql = "SELECT m.rowid FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
                       WHERE messages_fts MATCH ?1 AND (?2 IS NULL OR m.conv_id = ?2)
                       ORDER BY bm25(messages_fts), m.date DESC LIMIT ?3";
            conn.prepare_cached(sql)
                .and_then(|mut st| st.query_map(params![q, conversation, limit as i64], |r| r.get(0))?.collect())
                .unwrap_or_default()
        };
        let Some(all) = fts_query(query, true) else { return Vec::new() };
        let hits = run(&all);
        if !hits.is_empty() {
            return hits;
        }
        fts_query(query, false).filter(|any| *any != all).map(|any| run(&any)).unwrap_or_default()
    }

    /// Semantic ranking by cosine similarity with `query` (normalized), over rows embedded with `model`.
    pub fn semantic(&self, query: &[f32], model: &str, conversation: Option<&str>, limit: usize, min_score: f32) -> Vec<(i64, f32)> {
        let conn = self.conn.lock();
        let mut scored: Vec<(i64, f32)> = Vec::new();
        let Ok(mut st) = conn.prepare_cached("SELECT rowid, emb FROM messages WHERE emb IS NOT NULL AND emb_model = ?1 AND (?2 IS NULL OR conv_id = ?2)") else {
            return scored;
        };
        let Ok(rows) = st.query_map(params![model, conversation], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?))) else { return scored };
        for (rowid, blob) in rows.flatten() {
            let v = from_blob(&blob);
            if v.len() != query.len() {
                continue;
            }
            let s: f32 = v.iter().zip(query).map(|(a, b)| a * b).sum();
            if s >= min_score {
                scored.push((rowid, s));
            }
        }
        scored.sort_by(|a, b| b.1.total_cmp(&a.1));
        scored.truncate(limit);
        scored
    }

    pub fn messages(&self, rowids: &[i64]) -> Vec<(i64, Message)> {
        let conn = self.conn.lock();
        let Ok(mut st) = conn.prepare_cached(&format!("SELECT {COLUMNS} FROM messages WHERE rowid = ?1")) else { return Vec::new() };
        rowids.iter().filter_map(|id| st.query_row([id], |r| Ok((*id, row_message(r)?))).ok()).collect()
    }

    /// `before` messages before and `after` after `m` in its conversation (oldest first, `m` included).
    pub fn context(&self, m: &Message, before: usize, after: usize) -> Vec<Message> {
        let conn = self.conn.lock();
        let older: Vec<Message> = conn
            .prepare_cached(&format!("SELECT {COLUMNS} FROM messages WHERE conv_id = ?1 AND date < ?2 ORDER BY date DESC LIMIT ?3"))
            .and_then(|mut st| st.query_map(params![m.conversation_id, m.date, before as i64], row_message)?.collect())
            .unwrap_or_default();
        let newer: Vec<Message> = conn
            .prepare_cached(&format!("SELECT {COLUMNS} FROM messages WHERE conv_id = ?1 AND date > ?2 ORDER BY date ASC LIMIT ?3"))
            .and_then(|mut st| st.query_map(params![m.conversation_id, m.date, after as i64], row_message)?.collect())
            .unwrap_or_default();
        let mut out: Vec<Message> = older.into_iter().rev().collect();
        out.push(m.clone());
        out.extend(newer);
        out
    }

    /// Rows still to embed with `model`, newest first.
    fn pending(&self, model: &str, n: usize) -> Vec<(i64, String)> {
        let conn = self.conn.lock();
        conn.prepare_cached("SELECT rowid, text FROM messages WHERE emb IS NULL OR emb_model IS NOT ?1 ORDER BY date DESC LIMIT ?2")
            .and_then(|mut st| st.query_map(params![model, (n * 4) as i64], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<Vec<(i64, String)>, _>>())
            .unwrap_or_default()
            .into_iter()
            .filter(|(id, text)| {
                // Not worth embedding: mark it done with an empty vector so it is not picked again.
                if !embeddable(text) {
                    let _ = conn.execute("UPDATE messages SET emb = x'', emb_model = ?2 WHERE rowid = ?1", params![id, model]);
                    return false;
                }
                true
            })
            .take(n)
            .collect()
    }

    fn store_embeddings(&self, model: &str, rows: &[(i64, Vec<f32>)]) -> Result<(), String> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for (id, v) in rows {
            let mut v = v.clone();
            normalize(&mut v);
            tx.execute("UPDATE messages SET emb = ?2, emb_model = ?3 WHERE rowid = ?1", params![id, to_blob(&v), model]).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }
}

// ---- embeddings providers ----

pub async fn embed(http: &reqwest::Client, cfg: &SearchConfig, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
    let base = cfg.url.trim().trim_end_matches('/');
    if base.is_empty() || cfg.model.trim().is_empty() {
        return Err("chưa cấu hình URL hoặc model embeddings".into());
    }
    let (url, body) = match cfg.provider.as_str() {
        "openai" => (format!("{base}/embeddings"), json!({ "model": cfg.model, "input": texts })),
        _ => (format!("{base}/api/embed"), json!({ "model": cfg.model, "input": texts })),
    };
    let mut req = http.post(&url).header("Content-Type", "application/json").body(body.to_string());
    if !cfg.api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {}", cfg.api_key));
    }
    let resp = req.send().await.map_err(|e| format!("không kết nối được {url}: {e}"))?;
    let status = resp.status();
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_slice(&bytes).map_err(|e| format!("trả lời không hợp lệ: {e}"))?;
    if !status.is_success() {
        let msg = v.pointer("/error/message").or_else(|| v.get("error")).map(|e| e.as_str().map(str::to_owned).unwrap_or_else(|| e.to_string()));
        return Err(format!("HTTP {status}: {}", msg.unwrap_or_default()));
    }
    let vectors: Vec<Vec<f32>> = match cfg.provider.as_str() {
        "openai" => v.get("data").and_then(Value::as_array).into_iter().flatten().filter_map(|d| d.get("embedding")).map(vector).collect(),
        _ => v.get("embeddings").and_then(Value::as_array).into_iter().flatten().map(vector).collect(),
    };
    if vectors.len() != texts.len() || vectors.iter().any(Vec::is_empty) {
        return Err("nhà cung cấp trả về số vector không khớp".into());
    }
    Ok(vectors)
}

fn vector(v: &Value) -> Vec<f32> {
    v.as_array().map(|a| a.iter().filter_map(Value::as_f64).map(|x| x as f32).collect()).unwrap_or_default()
}

/// One background pass: embeds up to `batch` pending rows. Returns how many were embedded.
pub async fn embed_pending(index: &Index, http: &reqwest::Client, cfg: &SearchConfig, batch: usize) -> Result<usize, String> {
    let rows = index.pending(&cfg.model, batch);
    if rows.is_empty() {
        return Ok(0);
    }
    let texts: Vec<String> = rows.iter().map(|(_, t)| t.chars().take(2000).collect()).collect();
    let vectors = tokio::time::timeout(Duration::from_secs(120), embed(http, cfg, &texts)).await.map_err(|_| "hết thời gian chờ embeddings".to_owned())??;
    let pairs: Vec<(i64, Vec<f32>)> = rows.iter().map(|(id, _)| *id).zip(vectors).collect();
    index.store_embeddings(&cfg.model, &pairs)?;
    Ok(pairs.len())
}

/// Hybrid search. `query_vector` is the (unnormalized) query embedding when semantic search is available.
pub fn search(index: &Index, query: &str, query_vector: Option<(&str, Vec<f32>)>, conversation: Option<&str>, limit: usize, context: usize) -> Vec<Hit> {
    let pool = (limit * 4).max(40);
    let keyword = index.keyword(query, conversation, pool);
    let semantic = query_vector
        .map(|(model, mut v)| {
            normalize(&mut v);
            index.semantic(&v, model, conversation, pool, 0.35)
        })
        .unwrap_or_default();
    // Reciprocal-rank fusion.
    let mut scores: std::collections::HashMap<i64, (f64, bool, bool)> = Default::default();
    for (rank, id) in keyword.iter().enumerate() {
        let e = scores.entry(*id).or_insert((0.0, false, false));
        e.0 += 1.0 / (RRF_K + rank as f64 + 1.0);
        e.1 = true;
    }
    for (rank, (id, _)) in semantic.iter().enumerate() {
        let e = scores.entry(*id).or_insert((0.0, false, false));
        e.0 += 1.0 / (RRF_K + rank as f64 + 1.0);
        e.2 = true;
    }
    let mut ranked: Vec<(i64, (f64, bool, bool))> = scores.into_iter().collect();
    ranked.sort_by(|a, b| b.1.0.total_cmp(&a.1.0));
    ranked.truncate(limit);
    let ids: Vec<i64> = ranked.iter().map(|(id, _)| *id).collect();
    let rows: std::collections::HashMap<i64, Message> = index.messages(&ids).into_iter().collect();
    ranked
        .into_iter()
        .filter_map(|(id, (score, kw, sem))| {
            let message = rows.get(&id)?.clone();
            let ctx = if context > 0 { index.context(&message, context, context) } else { Vec::new() };
            Some(Hit { matched: match (kw, sem) { (true, true) => "both", (true, false) => "keyword", _ => "semantic" }, score, context: ctx, message })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(id: &str, conv: &str, text: &str, date: i64, source: &'static str) -> Message {
        Message {
            id: id.into(),
            conversation_id: conv.into(),
            conversation_name: format!("Hội thoại {conv}"),
            is_group: false,
            sender_name: "An".into(),
            from_me: false,
            text: text.into(),
            date,
            source,
        }
    }

    fn index() -> (Index, PathBuf) {
        let dir = std::env::temp_dir().join(format!("compola-search-{}-{}", std::process::id(), uuid::Uuid::new_v4().simple()));
        let ix = Index::open(&dir.join("search.db")).unwrap();
        (ix, dir)
    }

    #[test]
    fn keyword_search_ignores_accents_and_ranks() {
        let (ix, dir) = index();
        ix.upsert(&[
            msg("1", "a", "Họp lúc 3h chiều nay nhé", 1000, "chat"),
            msg("2", "a", "Đi ăn trưa không?", 2000, "chat"),
            msg("3", "b", "Báo cáo họp tuần đã gửi", 3000, "chat"),
            msg("4", "b", "ok", 4000, "chat"),
        ])
        .unwrap();
        let hits = search(&ix, "hop", None, None, 10, 0);
        assert_eq!(hits.len(), 2);
        assert!(search(&ix, "di an trua", None, None, 10, 0)[0].message.id == "2");
        assert!(search(&ix, "Đi", None, None, 10, 0).iter().any(|h| h.message.id == "2"));
        assert_eq!(search(&ix, "hop", None, Some("b"), 10, 0).len(), 1);
        // Every word must match; otherwise any word.
        assert_eq!(search(&ix, "họp báo cáo", None, None, 10, 0)[0].message.id, "3");
        assert_eq!(search(&ix, "họp xyzzy", None, None, 10, 0).len(), 2);
        let ctx = search(&ix, "trua", None, None, 10, 1)[0].context.clone();
        assert_eq!(ctx.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["1", "2"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn previews_give_way_to_chat_messages_and_edits_reindex() {
        let (ix, dir) = index();
        ix.upsert(&[msg("preview:a:1000", "a", "xin chao", 1000, "preview")]).unwrap();
        ix.upsert(&[msg("m1", "a", "xin chào", 1200, "chat")]).unwrap();
        ix.upsert(&[msg("preview:a:1000b", "a", "xin chao", 1100, "preview")]).unwrap();
        assert_eq!(ix.stats().messages, 1);
        ix.upsert(&[msg("m1", "a", "tạm biệt", 1200, "chat")]).unwrap();
        assert!(search(&ix, "chao", None, None, 5, 0).is_empty());
        assert_eq!(search(&ix, "tam biet", None, None, 5, 0).len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn semantic_and_hybrid_fusion() {
        let (ix, dir) = index();
        ix.upsert(&[msg("1", "a", "meeting at three", 1000, "chat"), msg("2", "a", "lunch tomorrow?", 2000, "chat"), msg("3", "a", "[Hình ảnh]", 3000, "chat")]).unwrap();
        let pending = ix.pending("m", 10);
        assert_eq!(pending.len(), 2, "type labels are not embedded");
        ix.store_embeddings("m", &[(pending[0].0, vec![0.0, 1.0]), (pending[1].0, vec![1.0, 0.0])]).unwrap();
        assert_eq!(ix.stats().embedded, 2);
        // pending[0] is the newest ("lunch"), embedded as [0, 1].
        let hits = search(&ix, "zzz", Some(("m", vec![0.1, 0.9])), None, 5, 0);
        assert_eq!(hits[0].message.id, "2");
        assert_eq!(hits[0].matched, "semantic");
        let hits = search(&ix, "meeting", Some(("m", vec![0.9, 0.1])), None, 5, 0);
        assert_eq!((hits[0].message.id.as_str(), hits[0].matched), ("1", "both"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn embeds_through_ollama_and_openai_shapes() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let (mut s, _) = listener.accept().await.unwrap();
                let mut buf = vec![0u8; 8192];
                let n = s.read(&mut buf).await.unwrap();
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let body = if req.starts_with("POST /api/embed") {
                    r#"{"embeddings":[[0.1,0.2,0.3]]}"#
                } else if req.starts_with("POST /v1/embeddings") && req.contains("Bearer k") {
                    r#"{"data":[{"embedding":[1,2]}]}"#
                } else {
                    r#"{"error":{"message":"bad key"}}"#
                };
                let status = if body.contains("error") { "401 Unauthorized" } else { "200 OK" };
                let resp = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                s.write_all(resp.as_bytes()).await.unwrap();
            }
        });
        let http = reqwest::Client::new();
        let texts = vec!["xin chào".to_owned()];
        let ollama = SearchConfig { semantic: true, url: format!("http://127.0.0.1:{port}"), ..Default::default() };
        assert_eq!(embed(&http, &ollama, &texts).await.unwrap()[0].len(), 3);
        let mut openai = SearchConfig { provider: "openai".into(), url: format!("http://127.0.0.1:{port}/v1"), model: "m".into(), api_key: "k".into(), ..Default::default() };
        assert_eq!(embed(&http, &openai, &texts).await.unwrap()[0], vec![1.0, 2.0]);
        openai.api_key = "wrong".into();
        assert!(embed(&http, &openai, &texts).await.unwrap_err().contains("bad key"));
    }
}
