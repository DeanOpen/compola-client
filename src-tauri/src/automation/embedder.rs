//! Built-in embeddings for semantic search (provider `builtin`): `intfloat/multilingual-e5-small` (MIT, ~100 languages
//! including Vietnamese, 384 dimensions) run in-process with candle on the CPU. Nothing to install: one click downloads
//! the model (~490 MB, pinned by SHA-256) into `<data>/models/multilingual-e5-small`, then it is loaded once and kept.
//!
//! e5 wants a prefix: `query: ` for what someone searches, `passage: ` for the messages that are indexed. Vectors are
//! mean-pooled over the tokens and L2-normalized (cosine similarity = dot product, as `search.rs` expects).

use std::path::PathBuf;
use std::sync::Arc;

use candle_core::{DType, Device, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::models::bert::{BertModel, Config};
use parking_lot::Mutex;
use serde::Serialize;
use sha2::{Digest, Sha256};

pub const MODEL: &str = "multilingual-e5-small";
const REPO: &str = "intfloat/multilingual-e5-small";
/// Hugging Face first; the mirror when it cannot be reached.
const HOSTS: &[&str] = &["https://huggingface.co", "https://hf-mirror.com"];
/// (file, size, SHA-256) of the pinned revision.
const FILES: &[(&str, u64, &str)] = &[
    ("config.json", 655, "69137736cab8b8903a07fe8afaafdda25aac55415a12a55d1bffa9f581abf959"),
    ("tokenizer.json", 17_082_730, "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39"),
    ("model.safetensors", 470_641_600, "1a55775f53449dac10a2bcbc312469fac40b96d53198c407081a831f81c98477"),
];
const MAX_TOKENS: usize = 256;
const BATCH: usize = 16;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Query,
    Passage,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub model: &'static str,
    pub installed: bool,
    pub downloading: bool,
    pub received: u64,
    pub total: u64,
    pub error: Option<String>,
}

struct Loaded {
    model: BertModel,
    tokenizer: tokenizers::Tokenizer,
}

static STATE: Mutex<Option<Status>> = Mutex::new(None);
static LOADED: Mutex<Option<Arc<Mutex<Loaded>>>> = Mutex::new(None);

pub fn dir() -> PathBuf {
    crate::platform::app_support().join("models").join(MODEL)
}

fn total_bytes() -> u64 {
    FILES.iter().map(|f| f.1).sum()
}

pub fn installed() -> bool {
    FILES.iter().all(|(name, size, _)| std::fs::metadata(dir().join(name)).is_ok_and(|m| m.len() == *size))
}

pub fn status() -> Status {
    let mut s = STATE.lock().clone().unwrap_or_default();
    s.model = MODEL;
    s.installed = installed();
    if s.total == 0 {
        s.total = total_bytes();
    }
    s
}

fn set(f: impl FnOnce(&mut Status)) {
    let mut st = STATE.lock();
    let s = st.get_or_insert_with(Status::default);
    f(s);
}

/// Downloads the model files (each checked against its SHA-256; a finished file is kept, so a retry resumes there).
/// Only one download runs at a time; a second call waits for nothing and returns once the first is done.
pub async fn install(http: &reqwest::Client) -> Result<(), String> {
    {
        let mut st = STATE.lock();
        let s = st.get_or_insert_with(Status::default);
        if s.downloading {
            return Err("đang tải mô hình".into());
        }
        s.downloading = true;
        s.error = None;
        s.received = 0;
        s.total = total_bytes();
    }
    let result = download_all(http).await;
    set(|s| {
        s.downloading = false;
        s.error = result.as_ref().err().cloned();
    });
    result
}

async fn download_all(http: &reqwest::Client) -> Result<(), String> {
    let folder = dir();
    tokio::fs::create_dir_all(&folder).await.map_err(|e| e.to_string())?;
    let mut done = 0u64;
    for (name, size, sha) in FILES {
        let target = folder.join(name);
        if std::fs::metadata(&target).is_ok_and(|m| m.len() == *size) {
            done += size;
            set(|s| s.received = done);
            continue;
        }
        let mut last = String::new();
        let mut ok = false;
        for host in HOSTS {
            let url = format!("{host}/{REPO}/resolve/main/{name}");
            match download_one(http, &url, &target, *size, sha, done).await {
                Ok(()) => {
                    ok = true;
                    break;
                }
                Err(e) => {
                    log::warn!("embedder: {url}: {e}");
                    last = e;
                }
            }
        }
        if !ok {
            return Err(format!("không tải được mô hình ({last})"));
        }
        done += size;
        set(|s| s.received = done);
    }
    log::info!("embedder: {MODEL} installed in {}", folder.display());
    Ok(())
}

async fn download_one(http: &reqwest::Client, url: &str, target: &std::path::Path, size: u64, sha: &str, before: u64) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let part = target.with_extension("part");
    let mut resp = http.get(url).timeout(std::time::Duration::from_secs(3600)).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let mut file = tokio::fs::File::create(&part).await.map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut got = 0u64;
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        got += chunk.len() as u64;
        if got > size {
            let _ = tokio::fs::remove_file(&part).await;
            return Err("tệp lớn hơn dự kiến".into());
        }
        hash.update(&chunk);
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        set(|s| s.received = before + got);
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    if got != size || hex::encode(hash.finalize()) != sha {
        let _ = tokio::fs::remove_file(&part).await;
        return Err("tệp tải về không khớp mã kiểm tra".into());
    }
    tokio::fs::rename(&part, target).await.map_err(|e| e.to_string())
}

fn load() -> Result<Arc<Mutex<Loaded>>, String> {
    if let Some(l) = LOADED.lock().clone() {
        return Ok(l);
    }
    if !installed() {
        return Err(format!("{MISSING} Mô hình {MODEL} chưa được tải."));
    }
    let folder = dir();
    let config: Config = serde_json::from_slice(&std::fs::read(folder.join("config.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let mut tokenizer = tokenizers::Tokenizer::from_file(folder.join("tokenizer.json")).map_err(|e| e.to_string())?;
    tokenizer.with_padding(Some(tokenizers::PaddingParams { strategy: tokenizers::PaddingStrategy::BatchLongest, ..Default::default() }));
    tokenizer
        .with_truncation(Some(tokenizers::TruncationParams { max_length: MAX_TOKENS, ..Default::default() }))
        .map_err(|e| e.to_string())?;
    // SAFETY: the file is ours (checked by size and SHA-256 when downloaded) and is not modified while mapped.
    let vb = unsafe { VarBuilder::from_mmaped_safetensors(&[folder.join("model.safetensors")], DType::F32, &Device::Cpu) }.map_err(|e| e.to_string())?;
    let model = BertModel::load(vb, &config).map_err(|e| e.to_string())?;
    let loaded = Arc::new(Mutex::new(Loaded { model, tokenizer }));
    *LOADED.lock() = Some(loaded.clone());
    log::info!("embedder: {MODEL} loaded");
    Ok(loaded)
}

/// Marks an error the settings turn into a "download the model" button (`src/engine/search.ts` `embedProblem`).
pub const MISSING: &str = "[builtin-missing]";

/// Embeds texts (blocking: call from `spawn_blocking`). Vectors are L2-normalized.
pub fn embed(texts: &[String], kind: Kind) -> Result<Vec<Vec<f32>>, String> {
    let loaded = load()?;
    let loaded = loaded.lock();
    let prefix = if kind == Kind::Query { "query: " } else { "passage: " };
    let mut out = Vec::with_capacity(texts.len());
    for chunk in texts.chunks(BATCH) {
        let inputs: Vec<String> = chunk.iter().map(|t| format!("{prefix}{}", t.trim())).collect();
        let enc = loaded.tokenizer.encode_batch(inputs, true).map_err(|e| e.to_string())?;
        let e = |err: candle_core::Error| err.to_string();
        let ids: Vec<Tensor> = enc.iter().map(|x| Tensor::new(x.get_ids(), &Device::Cpu)).collect::<candle_core::Result<_>>().map_err(e)?;
        let mask: Vec<Tensor> = enc.iter().map(|x| Tensor::new(x.get_attention_mask(), &Device::Cpu)).collect::<candle_core::Result<_>>().map_err(e)?;
        let ids = Tensor::stack(&ids, 0).map_err(e)?;
        let mask = Tensor::stack(&mask, 0).map_err(e)?;
        let types = ids.zeros_like().map_err(e)?;
        let hidden = loaded.model.forward(&ids, &types, Some(&mask)).map_err(e)?;
        let m = mask.to_dtype(DType::F32).and_then(|m| m.unsqueeze(2)).map_err(e)?;
        let summed = hidden.broadcast_mul(&m).and_then(|h| h.sum(1)).map_err(e)?;
        let mean = summed.broadcast_div(&m.sum(1).map_err(e)?).map_err(e)?;
        let norm = mean.sqr().and_then(|x| x.sum_keepdim(1)).and_then(|x| x.sqrt()).map_err(e)?;
        let vectors: Vec<Vec<f32>> = mean.broadcast_div(&norm).and_then(|x| x.to_vec2()).map_err(e)?;
        out.extend(vectors);
    }
    Ok(out)
}

/// Frees the model (it is loaded again on the next search).
pub fn unload() {
    *LOADED.lock() = None;
}

/// Deletes the downloaded files.
pub fn remove() -> Result<(), String> {
    unload();
    match std::fs::remove_dir_all(dir()) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// With the model files in COMPOLA_E5_DIR: `COMPOLA_E5_DIR=<dir> cargo test embedder -- --ignored`.
    #[test]
    #[ignore]
    fn ranks_vietnamese_by_meaning() {
        let Some(src) = std::env::var_os("COMPOLA_E5_DIR") else { return };
        let data = std::env::temp_dir().join(format!("compola-e5-{}", uuid::Uuid::new_v4()));
        let folder = data.join("models").join(MODEL);
        std::fs::create_dir_all(&folder).unwrap();
        for (name, _, _) in FILES {
            std::os::unix::fs::symlink(std::path::Path::new(&src).join(name), folder.join(name)).unwrap();
        }
        // SAFETY: test-only, single-threaded at this point.
        unsafe { std::env::set_var("COMPOLA_DATA_DIR", &data) };
        assert!(installed());
        let passages = ["Tối nay 7h đi ăn lẩu ở Hai Bà Trưng nhé", "Gửi anh báo giá combo 3 áo thun size M là 450.000đ", "Họp team lúc 9h sáng thứ 6"]
            .map(String::from);
        let p = embed(&passages, Kind::Passage).unwrap();
        let q = embed(&["ai hẹn đi ăn tối?".to_owned(), "giá áo bao nhiêu".to_owned()], Kind::Query).unwrap();
        assert_eq!(p[0].len(), 384);
        let best = |v: &Vec<f32>| (0..3).max_by(|&a, &b| dot(v, &p[a]).total_cmp(&dot(v, &p[b]))).unwrap();
        assert_eq!(best(&q[0]), 0);
        assert_eq!(best(&q[1]), 1);
        let _ = std::fs::remove_dir_all(data);
    }

    /// The real download (~490 MB): `COMPOLA_E5_DOWNLOAD=1 cargo test embedder -- --ignored`.
    #[test]
    #[ignore]
    fn downloads_and_verifies_the_pinned_files() {
        if std::env::var_os("COMPOLA_E5_DOWNLOAD").is_none() {
            return;
        }
        let data = std::env::temp_dir().join(format!("compola-e5-dl-{}", uuid::Uuid::new_v4()));
        // SAFETY: test-only.
        unsafe { std::env::set_var("COMPOLA_DATA_DIR", &data) };
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(install(&reqwest::Client::new())).unwrap();
        assert!(installed() && status().received == total_bytes());
        let v = embed(&["xin chào".to_owned()], Kind::Query).unwrap();
        assert_eq!(v[0].len(), 384);
        let _ = std::fs::remove_dir_all(data);
    }

    fn dot(a: &[f32], b: &[f32]) -> f32 {
        a.iter().zip(b).map(|(x, y)| x * y).sum()
    }
}
