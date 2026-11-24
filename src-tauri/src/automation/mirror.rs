//! A Rust-side mirror of what the official renderer posts (`zstate`): the conversation list and the messages of the
//! chats that were opened, plus a feed of new messages across every conversation, derived from the conversation
//! previews (the renderer updates a preview for every incoming message, opened or not). MCP tools and add-ons read
//! from here; nothing is fetched from the server for them.

use std::collections::{HashMap, VecDeque};

use serde::Serialize;
use serde_json::Value;

const FEED_CAP: usize = 2000;
const CHAT_CAP: usize = 300;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub name: String,
    pub is_group: bool,
    pub pinned: bool,
    pub unread: i64,
    pub members: i64,
    pub last_text: String,
    /// Unix ms, 0 when unknown.
    pub last_date: i64,
    pub last_from_me: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub conversation_name: String,
    pub is_group: bool,
    pub sender_name: String,
    pub from_me: bool,
    pub text: String,
    /// Unix ms.
    pub date: i64,
    /// `chat` = from the opened chat (complete), `preview` = from the conversation list preview (latest message only).
    pub source: &'static str,
}

#[derive(Default)]
pub struct Mirror {
    conversations: HashMap<String, Conversation>,
    feed: VecDeque<Message>,
    chats: HashMap<String, Vec<Message>>,
    /// Set once the first full conversation list arrived: previews before that are history, not new messages.
    primed: bool,
    /// Messages for the search index since the last `take_indexable`.
    indexable: Vec<Message>,
}

fn s(v: &Value, k: &str) -> String {
    match v.get(k) {
        Some(Value::String(x)) => x.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

fn ms(v: Option<&Value>) -> i64 {
    let n = v.and_then(Value::as_f64).unwrap_or(0.0);
    if n <= 0.0 {
        0
    } else if n > 1e12 {
        n as i64
    } else {
        (n * 1000.0) as i64
    }
}

impl Mirror {
    pub fn clear(&mut self) {
        *self = Self::default();
    }

    /// Applies one `zstate` post; returns the new incoming/outgoing messages it reveals.
    pub fn apply(&mut self, state: &Value) -> Vec<Message> {
        let mut new = Vec::new();
        if let Some(rows) = state.get("conversations").and_then(Value::as_array).filter(|_| state.get("chat").is_none()) {
            let reset = state.get("reset").and_then(Value::as_bool).unwrap_or(state.get("removed").is_none());
            if reset {
                self.conversations.clear();
            }
            if let Some(removed) = state.get("removed").and_then(Value::as_array) {
                for id in removed.iter().filter_map(Value::as_str) {
                    self.conversations.remove(id);
                }
            }
            for row in rows {
                let id = s(row, "id");
                if id.is_empty() {
                    continue;
                }
                let p = row.get("preview").cloned().unwrap_or(Value::Null);
                let conv = Conversation {
                    name: s(row, "name"),
                    is_group: row.get("isGroup").and_then(Value::as_bool).unwrap_or(false),
                    pinned: row.get("pinned").and_then(Value::as_bool).unwrap_or(false),
                    unread: row.get("unread").and_then(Value::as_i64).unwrap_or(0),
                    members: row.get("members").and_then(Value::as_i64).unwrap_or(0),
                    last_text: s(&p, "text"),
                    last_date: ms(p.get("ts")),
                    last_from_me: p.get("fromMe").and_then(Value::as_bool).unwrap_or(false),
                    id: id.clone(),
                };
                let previous = self.conversations.get(&id);
                let is_new_message = self.primed
                    && !reset
                    && conv.last_date > 0
                    && match previous {
                        Some(old) => conv.last_date > old.last_date,
                        // A conversation that just appeared: only a fresh message counts.
                        None => conv.last_date > chrono::Utc::now().timestamp_millis() - 120_000,
                    };
                if is_new_message {
                    let msg = Message {
                        id: format!("preview:{id}:{}", conv.last_date),
                        conversation_id: id.clone(),
                        conversation_name: conv.name.clone(),
                        is_group: conv.is_group,
                        sender_name: if conv.last_from_me { "Tôi".into() } else if conv.is_group { String::new() } else { conv.name.clone() },
                        from_me: conv.last_from_me,
                        text: conv.last_text.clone(),
                        date: conv.last_date,
                        source: "preview",
                    };
                    self.indexable.push(msg.clone());
                    self.feed.push_back(msg.clone());
                    while self.feed.len() > FEED_CAP {
                        self.feed.pop_front();
                    }
                    new.push(msg);
                }
                // The first list: every conversation's latest message goes to the search index (history, not an event).
                if reset && conv.last_date > 0 && !conv.last_text.is_empty() {
                    self.indexable.push(Message {
                        id: format!("preview:{id}:{}", conv.last_date),
                        conversation_id: id.clone(),
                        conversation_name: conv.name.clone(),
                        is_group: conv.is_group,
                        sender_name: if conv.last_from_me { "Tôi".into() } else if conv.is_group { String::new() } else { conv.name.clone() },
                        from_me: conv.last_from_me,
                        text: conv.last_text.clone(),
                        date: conv.last_date,
                        source: "preview",
                    });
                }
                self.conversations.insert(id, conv);
            }
            if reset {
                self.primed = true;
            }
        }
        if let Some(chat) = state.get("chat") {
            let conv_id = s(chat, "convId");
            if !conv_id.is_empty() {
                self.apply_chat(&conv_id, chat);
            }
        }
        new
    }

    fn apply_chat(&mut self, conv_id: &str, chat: &Value) {
        let (name, is_group) = self.conversations.get(conv_id).map(|c| (c.name.clone(), c.is_group)).unwrap_or_default();
        let list = self.chats.entry(conv_id.to_owned()).or_default();
        if chat.get("reset").and_then(Value::as_bool) == Some(true) {
            list.clear();
        }
        if let Some(removed) = chat.get("removed").and_then(Value::as_array) {
            let ids: Vec<&str> = removed.iter().filter_map(Value::as_str).collect();
            list.retain(|m| !ids.contains(&m.id.as_str()));
        }
        for m in chat.get("messages").and_then(Value::as_array).into_iter().flatten() {
            let id = s(m, "id");
            if id.is_empty() {
                continue;
            }
            let msg = Message {
                conversation_id: conv_id.to_owned(),
                conversation_name: name.clone(),
                is_group,
                sender_name: s(m, "senderName"),
                from_me: m.get("isMine").and_then(Value::as_bool).unwrap_or(false),
                text: s(m, "text"),
                date: ms(m.get("date")),
                source: "chat",
                id,
            };
            if msg.date > 0 && !msg.text.is_empty() {
                self.indexable.push(msg.clone());
            }
            match list.iter_mut().find(|x| x.id == msg.id) {
                Some(slot) => *slot = msg,
                None => list.push(msg),
            }
        }
        list.sort_by_key(|m| m.date);
        if list.len() > CHAT_CAP {
            let extra = list.len() - CHAT_CAP;
            list.drain(..extra);
        }
    }

    pub fn take_indexable(&mut self) -> Vec<Message> {
        std::mem::take(&mut self.indexable)
    }

    pub fn conversations(&self) -> Vec<Conversation> {
        let mut list: Vec<Conversation> = self.conversations.values().cloned().collect();
        list.sort_by(|a, b| b.pinned.cmp(&a.pinned).then(b.last_date.cmp(&a.last_date)).then(a.name.cmp(&b.name)));
        list
    }

    /// This account has seen the conversation (in its list or as an opened chat).
    pub fn knows(&self, id: &str) -> bool {
        self.conversations.contains_key(id) || self.chats.contains_key(id)
    }

    pub fn conversation(&self, id: &str) -> Option<Conversation> {
        self.conversations.get(id).cloned()
    }

    /// Newest last. With a conversation: the opened chat's messages when it was opened, else that conversation's feed
    /// entries (and its latest preview).
    pub fn messages(&self, conversation_id: Option<&str>, limit: usize) -> Vec<Message> {
        let mut out: Vec<Message> = match conversation_id {
            Some(id) => match self.chats.get(id).filter(|l| !l.is_empty()) {
                Some(list) => list.clone(),
                None => {
                    let mut l: Vec<Message> = self.feed.iter().filter(|m| m.conversation_id == id).cloned().collect();
                    if l.is_empty() {
                        if let Some(c) = self.conversations.get(id).filter(|c| c.last_date > 0) {
                            l.push(Message {
                                id: format!("preview:{}:{}", c.id, c.last_date),
                                conversation_id: c.id.clone(),
                                conversation_name: c.name.clone(),
                                is_group: c.is_group,
                                sender_name: if c.last_from_me { "Tôi".into() } else { String::new() },
                                from_me: c.last_from_me,
                                text: c.last_text.clone(),
                                date: c.last_date,
                                source: "preview",
                            });
                        }
                    }
                    l
                }
            },
            None => self.feed.iter().cloned().collect(),
        };
        if out.len() > limit {
            out.drain(..out.len() - limit);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn previews_after_the_first_list_become_feed_messages() {
        let mut m = Mirror::default();
        let first = json!({"conversations":[{"id":"1","name":"An","isGroup":false,"preview":{"text":"cũ","ts":1000,"fromMe":false}}],"reset":true});
        assert!(m.apply(&first).is_empty());
        let same = json!({"conversations":[{"id":"1","name":"An","unread":0,"preview":{"text":"cũ","ts":1000,"fromMe":false}}],"removed":[],"reset":false});
        assert!(m.apply(&same).is_empty());
        let next = json!({"conversations":[{"id":"1","name":"An","unread":1,"preview":{"text":"chào","ts":2000,"fromMe":false}}],"removed":[],"reset":false});
        let new = m.apply(&next);
        assert_eq!(new.len(), 1);
        assert_eq!(new[0].text, "chào");
        assert_eq!(new[0].date, 2_000_000);
        assert_eq!(m.messages(Some("1"), 10).len(), 1);
        assert_eq!(m.conversations()[0].unread, 1);
    }

    #[test]
    fn chat_posts_merge_by_id() {
        let mut m = Mirror::default();
        m.apply(&json!({"chat":{"convId":"9","reset":true,"messages":[{"id":"a","text":"x","date":1.0},{"id":"b","text":"y","date":2.0}]}}));
        m.apply(&json!({"chat":{"convId":"9","messages":[{"id":"b","text":"y2","date":2.0}],"removed":["a"]}}));
        let msgs = m.messages(Some("9"), 10);
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].text, "y2");
    }
}
