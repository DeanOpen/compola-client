//! `$znode.crypto.*` — Node's `crypto` reproduced byte-for-byte (port of `CryptoBridge.swift`).
//!
//! The preload exposed a thin layer over Node's `crypto` (`preload-render.js`:
//! `encrypt:(e,t,n,r=Buffer.alloc(16,0),a,i)=>A("encrypt",…)`). The official renderer uses it for `zcid` /
//! login-param encryption, request signing and E2EE media, so every output must equal what Node would produce:
//! a single wrong byte and the server rejects the session.
//!
//! Members:
//! - `encrypt` / `decrypt(data, algorithm, key, iv = zeros(16), encodings?, options?)` — one-shot AES;
//! - `hash(data, algorithm, inputEncoding?, outputEncoding?)`, `randomBytes(n)`;
//! - `__cipher*` / `__hash*` — the state behind `createCipheriv` / `createDecipheriv` / `createHash`, whose JS objects
//!   are rebuilt in `local-modules.js` and hold an integer handle.
//!
//! Block modes (CBC/ECB/CTR) are implemented here over the raw AES block so the streaming behaviour is OpenSSL's
//! exactly (what `update()` returns, when the last block is held back for padding, how strictly padding is checked);
//! GCM is one-shot (`aes-gcm`), so — as in the Swift app — `update()` buffers and `final()` returns the whole
//! ciphertext. The concatenation is identical to Node's.

use std::collections::HashMap;
use std::sync::Arc;

use aes::cipher::generic_array::GenericArray;
use aes::cipher::{BlockDecrypt, BlockEncrypt, KeyInit};
use aes_gcm::aead::AeadInPlace;
use aes_gcm::aead::consts::{U12, U16};
use aes_gcm::aead::generic_array::ArrayLength;
use parking_lot::Mutex;
use serde_json::{Value, json};
use sha2::digest::DynDigest;

use super::{BridgeResult, Registry};
use crate::values::{ArgsExt, array_buffer, is_undefined, unb64};

const BLOCK: usize = 16;

type Member = fn(&State, &[Value]) -> BridgeResult;

/// Members as `(path suffix, handler)`; all are synchronous in the preload.
const MEMBERS: &[(&str, Member)] = &[
    ("encrypt", |_, a| one_shot(true, a)),
    ("decrypt", |_, a| one_shot(false, a)),
    ("hash", hash),
    ("randomBytes", random_bytes),
    ("__cipherCreate", State::cipher_create),
    ("__cipherUpdate", State::cipher_update),
    ("__cipherFinal", State::cipher_final),
    ("__cipherOption", State::cipher_option),
    ("__hashCreate", State::hash_create),
    ("__hashUpdate", State::hash_update),
    ("__hashDigest", State::hash_digest),
];

pub fn install(reg: &mut Registry) {
    let state = Arc::new(State::default());
    for &(name, handler) in MEMBERS {
        let state = state.clone();
        reg.sync(&format!("$znode.crypto.{name}"), move |_, args| handler(&state, &args));
    }
}

// MARK: Node encodings

/// Bytes of a JS argument: a `Uint8Array`/`ArrayBuffer` as-is (Node ignores the encoding then), a string decoded with
/// `encoding` (default UTF-8), `null`/`undefined` as empty.
fn input(value: Option<&Value>, encoding: Option<&str>) -> Result<Vec<u8>, String> {
    match value {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(v) if is_undefined(v) => Ok(Vec::new()),
        Some(Value::Object(map)) if map.get("__bytes").is_some() => Ok(map.get("__bytes").and_then(Value::as_str).map(unb64).unwrap_or_default()),
        Some(Value::String(s)) => decode_string(s, encoding),
        Some(other) => Err(format!("Unsupported crypto input {}", type_name(other))),
    }
}

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
        _ => "value",
    }
}

/// `Buffer.from(string, encoding)`.
fn decode_string(s: &str, encoding: Option<&str>) -> Result<Vec<u8>, String> {
    let enc = encoding.unwrap_or("utf8").to_ascii_lowercase();
    Ok(match enc.as_str() {
        "utf8" | "utf-8" => s.as_bytes().to_vec(),
        // Node stops at the first pair that is not hex; an odd trailing nibble is dropped.
        "hex" => s
            .as_bytes()
            .chunks_exact(2)
            .map_while(|p| std::str::from_utf8(p).ok().and_then(|p| u8::from_str_radix(p, 16).ok()))
            .collect(),
        "base64" | "base64url" => base64_lenient(s),
        // One byte per UTF-16 code unit, truncated (`Buffer.from(s, 'latin1')`).
        "binary" | "latin1" | "ascii" => s.encode_utf16().map(|u| u as u8).collect(),
        "ucs2" | "ucs-2" | "utf16le" | "utf-16le" => s.encode_utf16().flat_map(u16::to_le_bytes).collect(),
        _ => return Err(format!("Unknown encoding: {}", encoding.unwrap_or(""))),
    })
}

/// Node's base64 decoder: both alphabets, padding optional, characters outside the alphabet skipped, stops at `=`.
fn base64_lenient(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    out
}

/// `buffer.toString(encoding)`; without an encoding the bytes go back as an `ArrayBuffer` (the preload returned
/// `buffer.buffer`).
fn encode(data: &[u8], encoding: Option<&str>) -> Value {
    let Some(encoding) = encoding else { return array_buffer(data) };
    match encoding.to_ascii_lowercase().as_str() {
        "hex" => json!(hex::encode(data)),
        "base64" => json!(crate::values::b64(data)),
        "base64url" => {
            use base64::Engine as _;
            json!(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(data))
        }
        "binary" | "latin1" => json!(data.iter().map(|&b| b as char).collect::<String>()),
        "ascii" => json!(data.iter().map(|&b| (b & 0x7f) as char).collect::<String>()),
        "ucs2" | "ucs-2" | "utf16le" | "utf-16le" => {
            let units: Vec<u16> = data.chunks_exact(2).map(|p| u16::from_le_bytes([p[0], p[1]])).collect();
            json!(String::from_utf16_lossy(&units))
        }
        // utf8 and anything unrecognised (the Swift app's fallback).
        _ => json!(String::from_utf8_lossy(data)),
    }
}

// MARK: Ciphers

enum Aes {
    A128(aes::Aes128),
    A192(aes::Aes192),
    A256(aes::Aes256),
}

impl Aes {
    fn new(key: &[u8]) -> Result<Self, String> {
        Ok(match key.len() {
            16 => Aes::A128(aes::Aes128::new_from_slice(key).map_err(|_| "Invalid key length")?),
            24 => Aes::A192(aes::Aes192::new_from_slice(key).map_err(|_| "Invalid key length")?),
            32 => Aes::A256(aes::Aes256::new_from_slice(key).map_err(|_| "Invalid key length")?),
            _ => return Err("Invalid key length".into()),
        })
    }

    fn encrypt(&self, block: &mut [u8; BLOCK]) {
        let b = GenericArray::from_mut_slice(block);
        match self {
            Aes::A128(c) => c.encrypt_block(b),
            Aes::A192(c) => c.encrypt_block(b),
            Aes::A256(c) => c.encrypt_block(b),
        }
    }

    fn decrypt(&self, block: &mut [u8; BLOCK]) {
        let b = GenericArray::from_mut_slice(block);
        match self {
            Aes::A128(c) => c.decrypt_block(b),
            Aes::A192(c) => c.decrypt_block(b),
            Aes::A256(c) => c.decrypt_block(b),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Cbc,
    Ecb,
    Ctr,
    Gcm,
}

/// Parses `aes-<bits>-<mode>` (and Node's `aes<bits>` alias for CBC) into (key bytes, mode).
fn parse_algorithm(algorithm: &str) -> Result<(usize, Mode), String> {
    let lower = algorithm.to_ascii_lowercase();
    let unsupported = || format!("Unsupported cipher {algorithm}");
    let (bits, mode) = match lower.split('-').collect::<Vec<_>>().as_slice() {
        ["aes", bits, mode] => (*bits, *mode),
        [alias] if alias.starts_with("aes") => (&alias[3..], "cbc"),
        _ => return Err(unsupported()),
    };
    let mode = match mode {
        "cbc" => Mode::Cbc,
        "ecb" => Mode::Ecb,
        "ctr" => Mode::Ctr,
        "gcm" => Mode::Gcm,
        _ => return Err(unsupported()),
    };
    match bits {
        "128" => Ok((16, mode)),
        "192" => Ok((24, mode)),
        "256" => Ok((32, mode)),
        _ => Err(unsupported()),
    }
}

struct CipherSession {
    encrypting: bool,
    mode: Mode,
    auto_padding: bool,
    key: Vec<u8>,
    iv: Vec<u8>,
    /// `None` for GCM (one-shot `aes-gcm`).
    aes: Option<Aes>,
    /// CBC: previous ciphertext block; CTR: the counter block.
    chain: [u8; BLOCK],
    /// CBC/ECB: input not yet processed (OpenSSL's partial block, plus the held-back last block when decrypting with
    /// padding). GCM: everything, since the AEAD is one-shot.
    pending: Vec<u8>,
    /// CTR keystream of the current counter and how much of it is used.
    keystream: [u8; BLOCK],
    keystream_used: usize,
    auth_tag: Option<Vec<u8>>,
    aad: Vec<u8>,
    /// Node's `StringDecoder` for the output encoding: bytes that cannot be encoded yet (a partial base64 group,
    /// an incomplete UTF-8 / UTF-16 sequence) wait for the next `update()` or `final()`.
    decoder: Option<(String, Vec<u8>)>,
}

impl CipherSession {
    fn new(encrypting: bool, algorithm: &str, key: Vec<u8>, iv: Vec<u8>) -> Result<Self, String> {
        let (key_len, mode) = parse_algorithm(algorithm)?;
        if key.len() != key_len {
            return Err("Invalid key length".into());
        }
        let iv_ok = match mode {
            Mode::Cbc | Mode::Ctr => iv.len() == BLOCK,
            Mode::Ecb => true,
            Mode::Gcm => matches!(iv.len(), 12 | 16),
        };
        if !iv_ok {
            return Err("Invalid initialization vector".into());
        }
        let mut chain = [0u8; BLOCK];
        if iv.len() == BLOCK {
            chain.copy_from_slice(&iv);
        }
        let aes = if mode == Mode::Gcm { None } else { Some(Aes::new(&key)?) };
        Ok(Self {
            encrypting,
            mode,
            auto_padding: true,
            key,
            iv,
            aes,
            chain,
            pending: Vec::new(),
            keystream: [0; BLOCK],
            keystream_used: BLOCK,
            auth_tag: None,
            aad: Vec::new(),
            decoder: None,
        })
    }

    /// Output of `update()`/`final()` as Node returns it: `cipher.update(data, inEnc, 'base64')` keeps the bytes past
    /// the last whole 3-byte group for the next call, so the chunks differ from encoding each output on its own (the
    /// concatenation is the same). Without an encoding the bytes go back as they are.
    fn output(&mut self, data: Vec<u8>, encoding: Option<&str>, end: bool) -> Value {
        let Some(encoding) = encoding else { return array_buffer(&data) };
        let lower = encoding.to_ascii_lowercase();
        let mut buf = match self.decoder.take() {
            Some((enc, mut carry)) if enc == lower => {
                carry.extend(data);
                carry
            }
            _ => data,
        };
        let keep = if end {
            0
        } else {
            match lower.as_str() {
                "hex" | "binary" | "latin1" | "ascii" => 0,
                "base64" | "base64url" => buf.len() % 3,
                "ucs2" | "ucs-2" | "utf16le" | "utf-16le" => utf16_incomplete(&buf),
                _ => utf8_incomplete(&buf),
            }
        };
        let carry = buf.split_off(buf.len() - keep);
        self.decoder = Some((lower, carry));
        encode(&buf, Some(encoding))
    }

    fn is_gcm(&self) -> bool {
        self.mode == Mode::Gcm
    }

    /// Decrypt with PKCS#7: OpenSSL keeps the last full block until `final()` so the padding can be checked.
    fn strips_padding(&self) -> bool {
        !self.encrypting && self.auto_padding && matches!(self.mode, Mode::Cbc | Mode::Ecb)
    }

    fn block_op(&mut self, block: &mut [u8; BLOCK]) {
        let aes = self.aes.as_ref().expect("block mode has a cipher");
        match (self.mode, self.encrypting) {
            (Mode::Ecb, true) => aes.encrypt(block),
            (Mode::Ecb, false) => aes.decrypt(block),
            (Mode::Cbc, true) => {
                block.iter_mut().zip(self.chain).for_each(|(b, c)| *b ^= c);
                aes.encrypt(block);
                self.chain = *block;
            }
            (Mode::Cbc, false) => {
                let cipher_text = *block;
                aes.decrypt(block);
                block.iter_mut().zip(self.chain).for_each(|(b, c)| *b ^= c);
                self.chain = cipher_text;
            }
            _ => unreachable!("stream modes do not use block_op"),
        }
    }

    fn run_blocks(&mut self, count: usize) -> Vec<u8> {
        let data: Vec<u8> = self.pending.drain(..count * BLOCK).collect();
        let mut out = Vec::with_capacity(data.len());
        for chunk in data.chunks_exact(BLOCK) {
            let mut block: [u8; BLOCK] = chunk.try_into().expect("full block");
            self.block_op(&mut block);
            out.extend_from_slice(&block);
        }
        out
    }

    fn update(&mut self, input: &[u8]) -> Vec<u8> {
        match self.mode {
            Mode::Gcm => {
                self.pending.extend_from_slice(input);
                Vec::new()
            }
            Mode::Ctr => {
                let mut out = Vec::with_capacity(input.len());
                for &byte in input {
                    if self.keystream_used == BLOCK {
                        let mut block = self.chain;
                        self.aes.as_ref().expect("ctr has a cipher").encrypt(&mut block);
                        self.keystream = block;
                        self.keystream_used = 0;
                        // 128-bit big-endian counter, as OpenSSL.
                        self.chain = u128::from_be_bytes(self.chain).wrapping_add(1).to_be_bytes();
                    }
                    out.push(byte ^ self.keystream[self.keystream_used]);
                    self.keystream_used += 1;
                }
                out
            }
            Mode::Cbc | Mode::Ecb => {
                self.pending.extend_from_slice(input);
                let mut blocks = self.pending.len() / BLOCK;
                if self.strips_padding() && self.pending.len().is_multiple_of(BLOCK) && blocks > 0 {
                    blocks -= 1;
                }
                self.run_blocks(blocks)
            }
        }
    }

    fn finish(&mut self) -> Result<Vec<u8>, String> {
        match self.mode {
            Mode::Gcm => self.finish_gcm(),
            Mode::Ctr => Ok(Vec::new()),
            Mode::Cbc | Mode::Ecb if self.encrypting => {
                if self.auto_padding {
                    let pad = BLOCK - self.pending.len() % BLOCK;
                    self.pending.extend(std::iter::repeat_n(pad as u8, pad));
                } else if !self.pending.is_empty() {
                    return Err("cipher final failed".into());
                }
                let blocks = self.pending.len() / BLOCK;
                Ok(self.run_blocks(blocks))
            }
            Mode::Cbc | Mode::Ecb => {
                if !self.auto_padding {
                    return if self.pending.is_empty() { Ok(Vec::new()) } else { Err("bad decrypt".into()) };
                }
                if self.pending.len() != BLOCK {
                    return Err("bad decrypt".into());
                }
                let block = self.run_blocks(1);
                let pad = *block.last().expect("one block") as usize;
                if !(1..=BLOCK).contains(&pad) || !block[BLOCK - pad..].iter().all(|&b| b as usize == pad) {
                    return Err("bad decrypt".into());
                }
                Ok(block[..BLOCK - pad].to_vec())
            }
        }
    }

    fn finish_gcm(&mut self) -> Result<Vec<u8>, String> {
        let mut buffer = std::mem::take(&mut self.pending);
        let tag = if self.encrypting {
            None
        } else {
            Some(self.auth_tag.clone().ok_or(GCM_AUTH_FAILED)?)
        };
        let result = match (self.key.len(), self.iv.len()) {
            (16, 12) => gcm::<aes::Aes128, U12>(&self.key, &self.iv, &self.aad, &mut buffer, tag.as_deref()),
            (24, 12) => gcm::<aes::Aes192, U12>(&self.key, &self.iv, &self.aad, &mut buffer, tag.as_deref()),
            (32, 12) => gcm::<aes::Aes256, U12>(&self.key, &self.iv, &self.aad, &mut buffer, tag.as_deref()),
            (16, 16) => gcm::<aes::Aes128, U16>(&self.key, &self.iv, &self.aad, &mut buffer, tag.as_deref()),
            (24, 16) => gcm::<aes::Aes192, U16>(&self.key, &self.iv, &self.aad, &mut buffer, tag.as_deref()),
            (32, 16) => gcm::<aes::Aes256, U16>(&self.key, &self.iv, &self.aad, &mut buffer, tag.as_deref()),
            _ => Err("Invalid initialization vector".into()),
        }?;
        if self.encrypting {
            self.auth_tag = result;
        }
        Ok(buffer)
    }
}

/// Trailing bytes of an unfinished UTF-8 sequence (Node's `utf8CheckIncomplete`).
fn utf8_incomplete(buf: &[u8]) -> usize {
    for back in 1..=3.min(buf.len()) {
        let byte = buf[buf.len() - back];
        let needed = match byte {
            0x00..=0x7f => return 0,
            0x80..=0xbf => continue, // continuation byte: look further back
            0xc0..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf7 => 4,
            _ => return 0,
        };
        return if needed > back { back } else { 0 };
    }
    0
}

/// An odd trailing byte, plus a trailing high surrogate waiting for its pair.
fn utf16_incomplete(buf: &[u8]) -> usize {
    let odd = buf.len() % 2;
    let even = buf.len() - odd;
    if even >= 2 && (0xd8..=0xdb).contains(&buf[even - 1]) { odd + 2 } else { odd }
}

const GCM_AUTH_FAILED: &str = "Unsupported state or unable to authenticate data";

/// AES-GCM in place: seals (returning the 16-byte tag) when `tag` is `None`, otherwise opens and verifies.
fn gcm<C, N>(key: &[u8], iv: &[u8], aad: &[u8], buffer: &mut [u8], tag: Option<&[u8]>) -> Result<Option<Vec<u8>>, String>
where
    C: aes::cipher::BlockCipher + aes::cipher::BlockSizeUser<BlockSize = U16> + BlockEncrypt + KeyInit,
    N: ArrayLength<u8>,
{
    let cipher = aes_gcm::AesGcm::<C, N>::new_from_slice(key).map_err(|_| "Invalid key length")?;
    let nonce = GenericArray::from_slice(iv);
    match tag {
        None => {
            let tag = cipher.encrypt_in_place_detached(nonce, aad, buffer).map_err(|_| "cipher final failed")?;
            Ok(Some(tag.to_vec()))
        }
        Some(tag) if tag.len() == BLOCK => {
            cipher.decrypt_in_place_detached(nonce, aad, buffer, GenericArray::from_slice(tag)).map_err(|_| GCM_AUTH_FAILED)?;
            Ok(None)
        }
        Some(_) => Err(GCM_AUTH_FAILED.into()),
    }
}

/// `encrypt`/`decrypt(data, algorithm, key, iv = zeros(16), encodings?, options?)`, `encodings` being
/// `{key, iv, input, output}`. The key/iv encoding rules are the Swift app's (which mirrored the preload): the key uses
/// `encodings.key` (default UTF-8); the iv uses `encodings.key` only when `encodings.iv` is present.
fn one_shot(encrypting: bool, args: &[Value]) -> BridgeResult {
    let encodings = args.obj_at(4);
    let enc = |name: &str| encodings.and_then(|e| e.get(name)).and_then(Value::as_str);
    let algorithm = args.str_at(1).unwrap_or("aes-256-cbc");
    let key_encoding = enc("key");
    let key = input(args.get(2), key_encoding)?;
    let iv = match args.value_at(3) {
        None => vec![0u8; BLOCK],
        Some(iv) => {
            let has_iv_encoding = encodings.is_some_and(|e| e.contains_key("iv"));
            input(Some(iv), if has_iv_encoding { key_encoding } else { None })?
        }
    };
    let data = input(args.first(), enc("input"))?;
    let mut session = CipherSession::new(encrypting, algorithm, key, iv)?;
    let mut out = session.update(&data);
    out.extend(session.finish()?);
    if !encrypting && std::env::var_os("COMPOLA_DEBUG_RESPONSES").is_some() {
        log_response_shape(&out);
    }
    Ok(encode(&out, enc("output")))
}

/// Shape only — never values (they can contain session tokens).
fn log_response_shape(plain: &[u8]) {
    let Ok(Value::Object(json)) = serde_json::from_slice::<Value>(plain) else { return };
    let keys = |m: &serde_json::Map<String, Value>| m.keys().cloned().collect::<Vec<_>>().join(",");
    let data_keys = json.get("data").and_then(Value::as_object).map(keys).unwrap_or_default();
    let error_code = json.get("error_code").map(Value::to_string).unwrap_or_else(|| "-".into());
    log::info!("[crypto] decrypted keys=[{}] error_code={error_code} data.keys=[{data_keys}]", keys(&json));
}

// MARK: Hashes

fn hasher(algorithm: &str) -> Result<Box<dyn DynDigest + Send>, String> {
    Ok(match algorithm.to_ascii_lowercase().replace('-', "").as_str() {
        "md5" => Box::new(md5::Md5::default()),
        "sha1" => Box::new(sha1::Sha1::default()),
        "sha224" => Box::new(sha2::Sha224::default()),
        "sha256" => Box::new(sha2::Sha256::default()),
        "sha384" => Box::new(sha2::Sha384::default()),
        "sha512" => Box::new(sha2::Sha512::default()),
        _ => return Err(format!("Digest method not supported: {algorithm}")),
    })
}

/// `hash(data, algorithm, inputEncoding?, outputEncoding?, options?)`.
fn hash(_: &State, args: &[Value]) -> BridgeResult {
    let data = input(args.first(), args.str_at(2))?;
    let mut h = hasher(args.str_at(1).unwrap_or("sha256"))?;
    h.update(&data);
    Ok(encode(&h.finalize(), args.str_at(3)))
}

fn random_bytes(_: &State, args: &[Value]) -> BridgeResult {
    use rand::RngCore as _;
    let mut data = vec![0u8; args.i64_at(0).unwrap_or(0).max(0) as usize];
    rand::rngs::OsRng.fill_bytes(&mut data);
    Ok(array_buffer(&data))
}

// MARK: Stateful objects (handles held by local-modules.js)

#[derive(Default)]
struct State {
    inner: Mutex<Handles>,
}

#[derive(Default)]
struct Handles {
    next: i64,
    sessions: HashMap<i64, CipherSession>,
    hashes: HashMap<i64, Box<dyn DynDigest + Send>>,
}

impl Handles {
    fn allocate(&mut self) -> i64 {
        self.next += 1;
        self.next
    }
}

impl State {
    /// `__cipherCreate("cipher" | "decipher", algorithm, key, iv)` → handle. String keys/ivs are UTF-8.
    fn cipher_create(&self, args: &[Value]) -> BridgeResult {
        let encrypting = args.str_at(0) == Some("cipher");
        let key = input(args.get(2), Some("utf8"))?;
        let iv = input(args.get(3), Some("utf8"))?;
        let session = CipherSession::new(encrypting, args.str_at(1).unwrap_or(""), key, iv)?;
        let mut h = self.inner.lock();
        let handle = h.allocate();
        h.sessions.insert(handle, session);
        Ok(json!(handle))
    }

    /// `__cipherUpdate(handle, data, inputEncoding?, outputEncoding?)`.
    fn cipher_update(&self, args: &[Value]) -> BridgeResult {
        let data = input(args.get(1), args.str_at(2))?;
        let mut h = self.inner.lock();
        let session = h.sessions.get_mut(&args.i64_at(0).unwrap_or(0)).ok_or("cipher released")?;
        let out = session.update(&data);
        Ok(session.output(out, args.str_at(3), false))
    }

    /// `__cipherFinal(handle, outputEncoding?)`. The session is released, except a GCM cipher whose tag is still to be
    /// read with `getAuthTag`.
    fn cipher_final(&self, args: &[Value]) -> BridgeResult {
        let handle = args.i64_at(0).unwrap_or(0);
        let mut h = self.inner.lock();
        let mut session = h.sessions.remove(&handle).ok_or("cipher released")?;
        let out = session.finish().map(|out| session.output(out, args.str_at(1), true));
        if session.is_gcm() && session.encrypting {
            h.sessions.insert(handle, session);
        }
        out
    }

    /// `__cipherOption(handle, "autoPadding" | "authTag" | "aad" | "getAuthTag", value?)`.
    fn cipher_option(&self, args: &[Value]) -> BridgeResult {
        let handle = args.i64_at(0).unwrap_or(0);
        let mut h = self.inner.lock();
        let Some(session) = h.sessions.get_mut(&handle) else { return Ok(crate::values::undef()) };
        match args.str_at(1) {
            Some("autoPadding") => session.auto_padding = args.bool_at(2).unwrap_or(true),
            Some("authTag") => session.auth_tag = Some(input(args.get(2), None)?),
            Some("aad") => session.aad = input(args.get(2), None)?,
            Some("getAuthTag") => {
                let tag = session.auth_tag.clone();
                h.sessions.remove(&handle);
                return Ok(tag.map(|t| array_buffer(&t)).unwrap_or_else(crate::values::undef));
            }
            _ => {}
        }
        Ok(crate::values::undef())
    }

    /// `__hashCreate(algorithm = "sha256")` → handle.
    fn hash_create(&self, args: &[Value]) -> BridgeResult {
        let digest = hasher(args.str_at(0).unwrap_or("sha256"))?;
        let mut h = self.inner.lock();
        let handle = h.allocate();
        h.hashes.insert(handle, digest);
        Ok(json!(handle))
    }

    /// `__hashUpdate(handle, data, inputEncoding?)`.
    fn hash_update(&self, args: &[Value]) -> BridgeResult {
        let data = input(args.get(1), args.str_at(2))?;
        let mut h = self.inner.lock();
        let digest = h.hashes.get_mut(&args.i64_at(0).unwrap_or(0)).ok_or("Digest already called")?;
        digest.update(&data);
        Ok(crate::values::undef())
    }

    /// `__hashDigest(handle, outputEncoding?)` — releases the handle, as Node forbids a second `digest()`.
    fn hash_digest(&self, args: &[Value]) -> BridgeResult {
        let digest = self.inner.lock().hashes.remove(&args.i64_at(0).unwrap_or(0)).ok_or("Digest already called")?;
        Ok(encode(&digest.finalize(), args.str_at(1)))
    }
}

#[cfg(test)]
mod tests {
    //! Parity with Node (port of `CryptoBridgeParity` in `RuntimeTests.swift`). The hardcoded vectors were produced
    //! by Node; `matches_node_live` re-derives a wider set from the installed `node` when there is one.

    use super::*;
    use crate::values::bytes;

    fn call(state: &State, member: &str, args: Vec<Value>) -> BridgeResult {
        let (_, handler) = MEMBERS.iter().find(|(name, _)| *name == member).expect("member");
        handler(state, &args)
    }

    fn hex_of(value: &Value) -> String {
        hex::encode(unb64(value["__bytes"].as_str().expect("bytes")))
    }

    #[test]
    fn zcid_encrypt_matches_node() {
        let out = call(&State::default(), "encrypt", vec![
            json!("23,abc-imei,1792963077777"), json!("aes-256-cbc"), json!("3FC4F0D2AB50057BCE0D90D9187A22B1"), Value::Null,
            json!({"key": "utf-8", "input": "utf-8", "output": "hex"}),
        ]);
        assert_eq!(out.unwrap(), json!("a1a69db6a344da4d883865c637f979495dd86112a4534347b462259bfdeb641b"));
    }

    #[test]
    fn params_round_trip_base64() {
        let state = State::default();
        let key = "DE71B7D4C57C0749158CB90D5E431AE3";
        let encrypted = call(&state, "encrypt", vec![
            json!("{\"language\":\"vi\"}"), json!("aes-256-cbc"), json!(key), Value::Null,
            json!({"key": "utf-8", "input": "utf-8", "output": "base64"}),
        ])
        .unwrap();
        assert_eq!(encrypted, json!("V5p1S6tTwaE91W8UDCagn9vVP9wUQ3QzA04wG7xh+5E="));
        let decrypted = call(&state, "decrypt", vec![
            encrypted, json!("aes-256-cbc"), json!(key), Value::Null, json!({"key": "utf-8", "input": "base64", "output": "utf-8"}),
        ]);
        assert_eq!(decrypted.unwrap(), json!("{\"language\":\"vi\"}"));
    }

    #[test]
    fn streaming_ctr_and_gcm() {
        let state = State::default();
        let ctr = call(&state, "__cipherCreate", vec![json!("cipher"), json!("aes-128-ctr"), bytes(&[7; 16]), bytes(&[1; 16])]).unwrap();
        let out = call(&state, "__cipherUpdate", vec![ctr, json!("hello zalo ctr mode!"), json!("utf8"), json!("hex")]);
        assert_eq!(out.unwrap(), json!("324a84ef5fc3a21b11456b948b319aab1c6e924d"));

        let gcm = call(&state, "__cipherCreate", vec![json!("cipher"), json!("aes-256-gcm"), bytes(&[3; 32]), bytes(&[9; 12])]).unwrap();
        call(&state, "__cipherUpdate", vec![gcm.clone(), json!("gcm payload"), json!("utf8"), Value::Null]).unwrap();
        let sealed = call(&state, "__cipherFinal", vec![gcm.clone(), json!("hex")]).unwrap();
        assert_eq!(sealed, json!("636b00fbfe1c3505e56f0c"));
        let tag = call(&state, "__cipherOption", vec![gcm.clone(), json!("getAuthTag")]).unwrap();
        assert_eq!(hex_of(&tag), "377ee9d6cfa423566629c0cfbb8eb885");
        assert_eq!(tag["__arraybuffer"], json!(true));

        // …and it opens again with the tag.
        let dec = call(&state, "__cipherCreate", vec![json!("decipher"), json!("aes-256-gcm"), bytes(&[3; 32]), bytes(&[9; 12])]).unwrap();
        call(&state, "__cipherOption", vec![dec.clone(), json!("authTag"), tag]).unwrap();
        call(&state, "__cipherUpdate", vec![dec.clone(), json!("636b00fbfe1c3505e56f0c"), json!("hex"), Value::Null]).unwrap();
        assert_eq!(call(&state, "__cipherFinal", vec![dec, json!("utf8")]).unwrap(), json!("gcm payload"));
    }

    #[test]
    fn hashes() {
        let state = State::default();
        let h = call(&state, "__hashCreate", vec![json!("md5")]).unwrap();
        call(&state, "__hashUpdate", vec![h.clone(), json!("841630ae41f"), Value::Null]).unwrap();
        assert_eq!(call(&state, "__hashDigest", vec![h.clone(), json!("hex")]).unwrap(), json!("d9e97c18b27cd54e969268d9b39e8680"));
        assert!(call(&state, "__hashDigest", vec![h, json!("hex")]).is_err(), "digest twice");
        let out = call(&state, "hash", vec![json!("zalo"), json!("sha256"), Value::Null, json!("base64")]);
        assert_eq!(out.unwrap(), json!("PpYUHCFwTpavYlfqQcD8aQzgUEyFKdxCTciyRbY0PA8="));
    }

    #[test]
    fn bad_decrypt_throws() {
        let out = call(&State::default(), "decrypt", vec![
            json!("AAAAAAAAAAAAAAAAAAAAAA=="), json!("aes-256-cbc"), json!("DE71B7D4C57C0749158CB90D5E431AE3"), Value::Null,
            json!({"key": "utf-8", "input": "base64", "output": "utf-8"}),
        ]);
        assert!(out.is_err());
    }

    #[test]
    fn rejects_bad_key_and_iv() {
        let state = State::default();
        assert!(call(&state, "__cipherCreate", vec![json!("cipher"), json!("aes-256-cbc"), json!("short"), bytes(&[0; 16])]).is_err());
        assert!(call(&state, "__cipherCreate", vec![json!("cipher"), json!("aes-128-cbc"), bytes(&[0; 16]), bytes(&[0; 8])]).is_err());
        assert!(call(&state, "__hashCreate", vec![json!("whirlpool")]).is_err());
    }

    #[test]
    fn decoders_follow_node() {
        assert_eq!(decode_string("0a0Bzz11", Some("hex")).unwrap(), vec![0x0a, 0x0b]);
        assert_eq!(decode_string("abc", Some("hex")).unwrap(), vec![0xab]);
        assert_eq!(base64_lenient("-_8 =AAAA"), vec![0xfb, 0xff]);
        assert_eq!(decode_string("é", Some("latin1")).unwrap(), vec![0xe9]);
        assert_eq!(encode(&[0xe9, 0x41], Some("ascii")), json!("iA"));
        assert_eq!(encode(&[0xfb, 0xff], Some("base64url")), json!("-_8"));
        assert!(decode_string("x", Some("klingon")).is_err());
    }

    /// Streaming ciphers, padding modes, encodings and hashes against the installed Node (skipped without `node`).
    #[test]
    fn matches_node_live() {
        let script = r#"
            const c = require('crypto');
            const key = Buffer.alloc(32, 5), key16 = Buffer.alloc(16, 6), iv = Buffer.alloc(16, 2);
            const run = (alg, k, i, chunks, pad, inEnc, outEnc) => {
              const ci = c.createCipheriv(alg, k, i); if (pad === false) ci.setAutoPadding(false);
              const parts = chunks.map(x => ci.update(x, inEnc, outEnc)); parts.push(ci.final(outEnc)); return parts;
            };
            const out = {
              cbc: run('aes-256-cbc', key, iv, ['a', 'bcdefghijklmnopqrstuvwxyz0123456789', '', 'tail'], true, 'utf8', 'hex'),
              cbcAligned: run('aes-128-cbc', key16, iv, ['0123456789abcdef'], true, 'utf8', 'base64'),
              cbcNoPad: run('aes-256-cbc', key, iv, ['00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'], false, 'hex', 'hex'),
              ecb: run('aes-256-ecb', key, null, ['ecb mode text'], true, 'utf8', 'hex'),
              ctr: run('aes-256-ctr', key, Buffer.from('ffffffffffffffffffffffffffffffff', 'hex'), ['x'.repeat(5), 'y'.repeat(40)], true, 'latin1', 'base64url'),
              gcm16: (() => { const ci = c.createCipheriv('aes-128-gcm', key16, iv); ci.setAAD(Buffer.from('aad'));
                return [Buffer.concat([ci.update('sixteen byte iv'), ci.final()]).toString('hex'), ci.getAuthTag().toString('hex')]; })(),
              decStream: (() => { const all = c.createCipheriv('aes-256-cbc', key, iv); const ct = Buffer.concat([all.update('y'.repeat(48)), all.final()]);
                const d = c.createDecipheriv('aes-256-cbc', key, iv); return [ct.toString('hex'), d.update(ct.subarray(0, 32), null, 'hex'), d.update(ct.subarray(32), null, 'hex'), d.final('hex')]; })(),
              // Decipher output split inside a multi-byte character; utf16le with odd chunks.
              utf8Split: (() => { const ct = c.createCipheriv('aes-128-ctr', key16, iv).update('h\u00e9 \u20ac!', 'utf8');
                const d = c.createDecipheriv('aes-128-ctr', key16, iv);
                return [ct.toString('hex'), d.update(ct.subarray(0, 2), null, 'utf8'), d.update(ct.subarray(2, 5), null, 'utf8'), d.update(ct.subarray(5), null, 'utf8'), d.final('utf8')]; })(),
              utf16: run('aes-128-ctr', key16, iv, ['abc', 'defgh', 'i'], true, 'utf8', 'utf16le'),
              sha1: c.createHash('sha1').update('zalo').digest('hex'),
              sha512: c.createHash('sha512').update('7a616c6f', 'hex').digest('base64'),
              sha384: c.createHash('sha384').update('zalo').digest('hex'),
            };
            console.log(JSON.stringify(out));
        "#;
        let Ok(output) = std::process::Command::new("node").arg("-e").arg(script).output() else {
            eprintln!("node not found; skipping live parity");
            return;
        };
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let node: Value = serde_json::from_slice(&output.stdout).unwrap();

        let state = State::default();
        let stream = |alg: &str, key: Value, iv: Value, chunks: &[&str], pad: bool, in_enc: &str, out_enc: &str| -> Value {
            let h = call(&state, "__cipherCreate", vec![json!("cipher"), json!(alg), key, iv]).unwrap();
            if !pad {
                call(&state, "__cipherOption", vec![h.clone(), json!("autoPadding"), json!(false)]).unwrap();
            }
            let mut parts: Vec<Value> =
                chunks.iter().map(|c| call(&state, "__cipherUpdate", vec![h.clone(), json!(c), json!(in_enc), json!(out_enc)]).unwrap()).collect();
            parts.push(call(&state, "__cipherFinal", vec![h, json!(out_enc)]).unwrap());
            json!(parts)
        };
        let (key, key16, iv) = (bytes(&[5; 32]), bytes(&[6; 16]), bytes(&[2; 16]));
        assert_eq!(stream("aes-256-cbc", key.clone(), iv.clone(), &["a", "bcdefghijklmnopqrstuvwxyz0123456789", "", "tail"], true, "utf8", "hex"), node["cbc"]);
        assert_eq!(stream("aes-128-cbc", key16.clone(), iv.clone(), &["0123456789abcdef"], true, "utf8", "base64"), node["cbcAligned"]);
        let no_pad = ["00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"];
        assert_eq!(stream("aes-256-cbc", key.clone(), iv.clone(), &no_pad, false, "hex", "hex"), node["cbcNoPad"]);
        assert_eq!(stream("aes-256-ecb", key.clone(), Value::Null, &["ecb mode text"], true, "utf8", "hex"), node["ecb"]);
        let ctr_iv = bytes(&[0xff; 16]);
        assert_eq!(stream("aes-256-ctr", key.clone(), ctr_iv, &["xxxxx", &"y".repeat(40)], true, "latin1", "base64url"), node["ctr"]);

        let gcm = call(&state, "__cipherCreate", vec![json!("cipher"), json!("aes-128-gcm"), key16, iv.clone()]).unwrap();
        call(&state, "__cipherOption", vec![gcm.clone(), json!("aad"), bytes(b"aad")]).unwrap();
        call(&state, "__cipherUpdate", vec![gcm.clone(), json!("sixteen byte iv"), Value::Null, Value::Null]).unwrap();
        let ct = call(&state, "__cipherFinal", vec![gcm.clone(), json!("hex")]).unwrap();
        let tag = call(&state, "__cipherOption", vec![gcm, json!("getAuthTag")]).unwrap();
        assert_eq!(json!([ct, hex_of(&tag)]), node["gcm16"]);

        // Decrypt streaming: OpenSSL holds back the last block of an aligned update until final().
        let ct_hex = node["decStream"][0].as_str().unwrap();
        let ct = hex::decode(ct_hex).unwrap();
        let d = call(&state, "__cipherCreate", vec![json!("decipher"), json!("aes-256-cbc"), key, iv]).unwrap();
        let p1 = call(&state, "__cipherUpdate", vec![d.clone(), bytes(&ct[..32]), Value::Null, json!("hex")]).unwrap();
        let p2 = call(&state, "__cipherUpdate", vec![d.clone(), bytes(&ct[32..]), Value::Null, json!("hex")]).unwrap();
        let p3 = call(&state, "__cipherFinal", vec![d, json!("hex")]).unwrap();
        assert_eq!(json!([ct_hex, p1, p2, p3]), node["decStream"]);

        let ct = hex::decode(node["utf8Split"][0].as_str().unwrap()).unwrap();
        let d = call(&state, "__cipherCreate", vec![json!("decipher"), json!("aes-128-ctr"), bytes(&[6; 16]), bytes(&[2; 16])]).unwrap();
        let mut parts = vec![node["utf8Split"][0].clone()];
        for chunk in [&ct[..2], &ct[2..5], &ct[5..]] {
            parts.push(call(&state, "__cipherUpdate", vec![d.clone(), bytes(chunk), Value::Null, json!("utf8")]).unwrap());
        }
        parts.push(call(&state, "__cipherFinal", vec![d, json!("utf8")]).unwrap());
        assert_eq!(json!(parts), node["utf8Split"]);
        assert_eq!(stream("aes-128-ctr", bytes(&[6; 16]), bytes(&[2; 16]), &["abc", "defgh", "i"], true, "utf8", "utf16le"), node["utf16"]);

        let digest = |alg: &str, data: &str, in_enc: Value, out: &str| call(&state, "hash", vec![json!(data), json!(alg), in_enc, json!(out)]).unwrap();
        assert_eq!(digest("sha1", "zalo", Value::Null, "hex"), node["sha1"]);
        assert_eq!(digest("SHA-512", "7a616c6f", json!("hex"), "base64"), node["sha512"]);
        assert_eq!(digest("sha384", "zalo", Value::Null, "hex"), node["sha384"]);
    }
}
