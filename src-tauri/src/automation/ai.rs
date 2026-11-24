//! `compola.ai` for add-ons: one AI provider configured in Settings › Add-on › AI, so add-ons never hold API keys.
//!
//! - `anthropic`: the Claude Messages API over HTTP (Rust has no official SDK). `anthropic-version: 2026-10-21`, so no
//!   sampling parameters; adaptive thinking is the model default and `output_config.effort` controls depth; only text
//!   blocks are returned; `stop_reason: refusal` is an error. Models that support server-side refusal fallbacks get
//!   `fallbacks: "default"`.
//! - `openai`: any OpenAI-compatible `/chat/completions` (Ollama, LM Studio, vLLM, …) for local or self-hosted models.

use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};

use super::config::AiConfig;

const ANTHROPIC_URL: &str = "https://api.anthropic.com";
const ANTHROPIC_VERSION: &str = "2026-10-21";
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
const OPENAI_LOCAL_URL: &str = "http://127.0.0.1:11434/v1";
/// Models that accept `fallbacks: "default"`.
const FALLBACK_MODELS: &[&str] = &["claude-fable-5-2", "claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"];
const EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];
/// Input an add-on may send in one request (characters), a guard against a runaway prompt.
const MAX_INPUT_CHARS: usize = 400_000;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Completion {
    pub text: String,
    pub model: String,
    pub stop_reason: String,
    pub usage: Usage,
    /// Parsed `text` when the request asked for `json: true` and the answer is JSON.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub json: Option<Value>,
}

/// What an add-on asks: `{system?, prompt? | messages?: [{role: user|assistant, content}], maxTokens?, effort?, json?}`.
pub struct Request {
    pub system: String,
    pub messages: Vec<(String, String)>,
    pub max_tokens: u32,
    pub effort: Option<String>,
    pub json: bool,
}

impl Request {
    pub fn from_value(v: &Value, cfg: &AiConfig) -> Result<Self, String> {
        let mut messages = Vec::new();
        if let Some(list) = v.get("messages").and_then(Value::as_array) {
            for m in list {
                let role = m.get("role").and_then(Value::as_str).unwrap_or("user");
                if role != "user" && role != "assistant" {
                    return Err(format!("messages: role phải là user hoặc assistant (không phải {role})"));
                }
                let content = match m.get("content") {
                    Some(Value::String(s)) => s.clone(),
                    Some(other) => other.to_string(),
                    None => String::new(),
                };
                if !content.trim().is_empty() {
                    messages.push((role.to_owned(), content));
                }
            }
        }
        if let Some(p) = v.get("prompt").and_then(Value::as_str).filter(|p| !p.trim().is_empty()) {
            messages.push(("user".into(), p.to_owned()));
        }
        if messages.is_empty() {
            return Err("cần `prompt` hoặc `messages`".into());
        }
        if messages[0].0 != "user" {
            return Err("tin đầu tiên của `messages` phải là của user".into());
        }
        if messages.last().is_some_and(|m| m.0 == "assistant") {
            return Err("tin cuối của `messages` phải là của user".into());
        }
        let system = v.get("system").and_then(Value::as_str).unwrap_or_default().to_owned();
        let size = system.len() + messages.iter().map(|m| m.1.len()).sum::<usize>();
        if size > MAX_INPUT_CHARS {
            return Err(format!("nội dung gửi AI quá dài ({size} ký tự, tối đa {MAX_INPUT_CHARS})"));
        }
        let cap = cfg.max_tokens.max(256);
        let max_tokens = v.get("maxTokens").and_then(Value::as_u64).map(|n| n as u32).unwrap_or(cap.min(16000)).clamp(16, cap);
        let effort = v.get("effort").and_then(Value::as_str).filter(|e| EFFORTS.contains(e)).map(str::to_owned);
        Ok(Self { system, messages, max_tokens, effort, json: v.get("json").and_then(Value::as_bool).unwrap_or(false) })
    }
}

fn base(cfg: &AiConfig) -> String {
    let url = cfg.url.trim().trim_end_matches('/');
    if !url.is_empty() {
        return url.to_owned();
    }
    if cfg.provider == "openai" { OPENAI_LOCAL_URL } else { ANTHROPIC_URL }.to_owned()
}

fn json_of(text: &str) -> Option<Value> {
    let t = text.trim();
    let t = t.strip_prefix("```json").or_else(|| t.strip_prefix("```")).map(|s| s.trim_end_matches("```")).unwrap_or(t).trim();
    serde_json::from_str(t).ok()
}

pub async fn complete(http: &reqwest::Client, cfg: &AiConfig, req: Request) -> Result<Completion, String> {
    if !cfg.enabled {
        return Err("AI chưa được bật (Cài đặt › Add-on › AI)".into());
    }
    if cfg.model.trim().is_empty() {
        return Err("chưa chọn model AI".into());
    }
    let mut system = req.system.clone();
    if req.json {
        if !system.is_empty() {
            system.push_str("\n\n");
        }
        system.push_str("Answer with one JSON value only, no prose and no code fence.");
    }
    let mut out = match cfg.provider.as_str() {
        "openai" => openai(http, cfg, &system, &req).await?,
        _ => anthropic(http, cfg, &system, &req).await?,
    };
    if req.json {
        out.json = json_of(&out.text);
    }
    Ok(out)
}

async fn read_json(resp: reqwest::Response) -> Result<Value, String> {
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

async fn anthropic(http: &reqwest::Client, cfg: &AiConfig, system: &str, req: &Request) -> Result<Completion, String> {
    if cfg.api_key.trim().is_empty() {
        return Err("chưa nhập API key của Claude".into());
    }
    let model = cfg.model.trim();
    let mut body = json!({
        "model": model,
        "max_tokens": req.max_tokens,
        "messages": req.messages.iter().map(|(role, content)| json!({ "role": role, "content": content })).collect::<Vec<_>>(),
    });
    if !system.is_empty() {
        body["system"] = json!(system);
    }
    let effort = req.effort.clone().or_else(|| Some(cfg.effort.clone()).filter(|e| EFFORTS.contains(&e.as_str())));
    if let Some(effort) = effort {
        body["output_config"] = json!({ "effort": effort });
    }
    let mut request = http
        .post(format!("{}/v1/messages", base(cfg)))
        .header("x-api-key", cfg.api_key.trim())
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .timeout(Duration::from_secs(600));
    if FALLBACK_MODELS.contains(&model) {
        body["fallbacks"] = json!("default");
        request = request.header("anthropic-beta", FALLBACK_BETA);
    }
    let resp = request.body(body.to_string()).send().await.map_err(|e| format!("không gọi được Claude: {e}"))?;
    let status = resp.status();
    let v = read_json(resp).await.map_err(|e| format!("Claude trả lời không đọc được: {e}"))?;
    if !status.is_success() {
        let msg = v.pointer("/error/message").and_then(Value::as_str).unwrap_or("lỗi không rõ");
        return Err(match status.as_u16() {
            401 => "API key của Claude không hợp lệ".to_owned(),
            429 => format!("Claude đang giới hạn tần suất, thử lại sau ({msg})"),
            529 => "Claude đang quá tải, thử lại sau".to_owned(),
            _ => format!("Claude báo lỗi {status}: {msg}"),
        });
    }
    let stop = v.get("stop_reason").and_then(Value::as_str).unwrap_or_default().to_owned();
    if stop == "refusal" {
        let why = v.pointer("/stop_details/explanation").and_then(Value::as_str).unwrap_or_default();
        return Err(format!("Claude từ chối yêu cầu này{}", if why.is_empty() { String::new() } else { format!(": {why}") }));
    }
    let text = v
        .get("content")
        .and_then(Value::as_array)
        .map(|blocks| blocks.iter().filter(|b| b.get("type").and_then(Value::as_str) == Some("text")).filter_map(|b| b.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join(""))
        .unwrap_or_default();
    Ok(Completion {
        text,
        model: v.get("model").and_then(Value::as_str).unwrap_or(model).to_owned(),
        stop_reason: stop,
        usage: Usage {
            input_tokens: v.pointer("/usage/input_tokens").and_then(Value::as_u64).unwrap_or(0),
            output_tokens: v.pointer("/usage/output_tokens").and_then(Value::as_u64).unwrap_or(0),
        },
        json: None,
    })
}

async fn openai(http: &reqwest::Client, cfg: &AiConfig, system: &str, req: &Request) -> Result<Completion, String> {
    let mut messages = Vec::new();
    if !system.is_empty() {
        messages.push(json!({ "role": "system", "content": system }));
    }
    messages.extend(req.messages.iter().map(|(role, content)| json!({ "role": role, "content": content })));
    let body = json!({ "model": cfg.model.trim(), "messages": messages, "max_tokens": req.max_tokens, "stream": false });
    let mut request = http
        .post(format!("{}/chat/completions", base(cfg)))
        .timeout(Duration::from_secs(600))
        .header("content-type", "application/json")
        .body(body.to_string());
    if !cfg.api_key.trim().is_empty() {
        request = request.bearer_auth(cfg.api_key.trim());
    }
    let resp = request.send().await.map_err(|e| format!("không gọi được máy chủ AI: {e}"))?;
    let status = resp.status();
    let v = read_json(resp).await.map_err(|e| format!("máy chủ AI trả lời không đọc được: {e}"))?;
    if !status.is_success() {
        let msg = v.pointer("/error/message").and_then(Value::as_str).or_else(|| v.get("error").and_then(Value::as_str)).unwrap_or("lỗi không rõ");
        return Err(format!("máy chủ AI báo lỗi {status}: {msg}"));
    }
    Ok(Completion {
        text: v.pointer("/choices/0/message/content").and_then(Value::as_str).unwrap_or_default().to_owned(),
        model: v.get("model").and_then(Value::as_str).unwrap_or(&cfg.model).to_owned(),
        stop_reason: v.pointer("/choices/0/finish_reason").and_then(Value::as_str).unwrap_or_default().to_owned(),
        usage: Usage {
            input_tokens: v.pointer("/usage/prompt_tokens").and_then(Value::as_u64).unwrap_or(0),
            output_tokens: v.pointer("/usage/completion_tokens").and_then(Value::as_u64).unwrap_or(0),
        },
        json: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_are_checked() {
        let cfg = AiConfig { max_tokens: 4000, ..AiConfig::default() };
        let r = Request::from_value(&json!({ "prompt": "hi", "maxTokens": 99999, "effort": "turbo" }), &cfg).unwrap();
        assert_eq!((r.max_tokens, r.effort, r.messages.len()), (4000, None, 1));
        assert!(Request::from_value(&json!({}), &cfg).is_err());
        assert!(Request::from_value(&json!({ "messages": [{ "role": "assistant", "content": "x" }] }), &cfg).is_err());
        assert!(Request::from_value(&json!({ "messages": [{ "role": "system", "content": "x" }] }), &cfg).is_err());
        let r = Request::from_value(&json!({ "messages": [{ "role": "user", "content": "a" }, { "role": "assistant", "content": "b" }], "prompt": "c", "effort": "low" }), &cfg).unwrap();
        assert_eq!(r.messages.len(), 3);
        assert_eq!(r.effort.as_deref(), Some("low"));
    }

    #[test]
    fn json_answers() {
        assert_eq!(json_of("```json\n{\"a\":1}\n```"), Some(json!({ "a": 1 })));
        assert_eq!(json_of(" [1,2] "), Some(json!([1, 2])));
        assert_eq!(json_of("nope"), None);
    }

    #[test]
    fn default_urls() {
        let mut cfg = AiConfig::default();
        assert_eq!(base(&cfg), ANTHROPIC_URL);
        cfg.provider = "openai".into();
        assert_eq!(base(&cfg), OPENAI_LOCAL_URL);
        cfg.url = "http://x:1/v1/".into();
        assert_eq!(base(&cfg), "http://x:1/v1");
    }
}
