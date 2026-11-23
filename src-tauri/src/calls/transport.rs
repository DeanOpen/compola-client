//! Wire format between the Zalo main process and its native call helper (`ZaloCall`, zcall-v2) — port of
//! `CallTransport.swift`. Source: `main-dist/main.js` modules "3Zc2" (call transport), "vqv6" (encrypt / decrypt) and
//! "4KIH" (buildListMsgs); key: module "5NUA" `ZPC_SECRET_VALUES.callV2TransportAesKey`.

use aes::Aes128;
use aes::cipher::block_padding::Pkcs7;
use aes::cipher::{BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use serde_json::{Map, Value};

/// `callV2TransportAesKey` (base64 of a 16-byte AES key), a constant of the official client.
const KEY_BASE64: &str = "yjAF9oqMWl6XfXYJn9mA7w==";
/// `Buffer.from("0".repeat(32), "hex")`: sixteen zero bytes.
const IV: [u8; 16] = [0; 16];

pub fn default_key() -> Vec<u8> {
    crate::values::unb64(KEY_BASE64)
}

/// `encrypt(text, key)`: AES-128-CBC (zero IV, PKCS#7), lower-case hex.
pub fn encrypt(text: &str, key: &[u8]) -> Option<String> {
    let enc = cbc::Encryptor::<Aes128>::new_from_slices(key, &IV).ok()?;
    Some(hex::encode(enc.encrypt_padded_vec_mut::<Pkcs7>(text.as_bytes())))
}

/// `decrypt(hex, key)`: the inverse; `None` when the frame is not valid hex / padding / UTF-8.
pub fn decrypt(hex_text: &str, key: &[u8]) -> Option<String> {
    let bytes = hex::decode(hex_text).ok().filter(|b| !b.is_empty() && b.len() % 16 == 0)?;
    let dec = cbc::Decryptor::<Aes128>::new_from_slices(key, &IV).ok()?;
    let plain = dec.decrypt_padded_vec_mut::<Pkcs7>(&bytes).ok()?;
    String::from_utf8(plain).ok()
}

/// `buildListMsgs`: payloads longer than 4000 characters are cut into `<chunk>#<sequence>#<count>#<index>#$` pieces;
/// a single piece is `<payload>$`.
pub struct Chunker {
    /// `r` in module 4KIH: starts at 1 and becomes `max(r + 1, Date.now())` per message.
    sequence: i64,
}

impl Default for Chunker {
    fn default() -> Self {
        Self { sequence: 1 }
    }
}

pub const CHUNK_SIZE: usize = 4000;

impl Chunker {
    pub fn chunks(&mut self, payload: &str) -> Vec<String> {
        self.chunks_at(payload, crate::values::now_ms() as i64)
    }

    pub fn chunks_at(&mut self, payload: &str, now_ms: i64) -> Vec<String> {
        let count = payload.len().div_ceil(CHUNK_SIZE);
        self.sequence = (self.sequence + 1).max(now_ms);
        if count <= 1 {
            return vec![format!("{payload}$")];
        }
        // `payload` is lower-case hex (ASCII): UTF-16 offsets equal byte offsets.
        let bytes = payload.as_bytes();
        (0..count)
            .map(|i| {
                let slice = &bytes[i * CHUNK_SIZE..bytes.len().min((i + 1) * CHUNK_SIZE)];
                format!("{}#{}#{count}#{i}#$", String::from_utf8_lossy(slice), self.sequence)
            })
            .collect()
    }
}

/// Splits the native → main byte stream on `$` (main does `data.toString().split(/\$/)`, but a frame may straddle two
/// reads, so incomplete tails are buffered until their `$` arrives).
#[derive(Default)]
pub struct FrameDecoder {
    buffer: Vec<u8>,
}

impl FrameDecoder {
    /// Messages (decrypted JSON objects) completed by `data`. Frames that fail to decrypt or parse are dropped
    /// (`cannot parse payload`) and counted in `dropped`.
    pub fn feed(&mut self, data: &[u8], key: &[u8], dropped: &mut usize) -> Vec<Map<String, Value>> {
        self.buffer.extend_from_slice(data);
        let mut messages = Vec::new();
        while let Some(end) = self.buffer.iter().position(|b| *b == b'$') {
            let frame: Vec<u8> = self.buffer.drain(..=end).take(end).collect();
            if frame.is_empty() {
                continue;
            }
            match parse(&frame, key) {
                Some(m) => messages.push(m),
                None => *dropped += 1,
            }
        }
        // An unterminated tail waits for its `$`.
        if self.buffer.len() > 4_000_000 {
            self.buffer.clear();
            *dropped += 1;
        }
        messages
    }
}

/// `decrypt(frame, R)` → strip NULs → `JSON.parse`.
pub fn parse(frame: &[u8], key: &[u8]) -> Option<Map<String, Value>> {
    let text = String::from_utf8_lossy(frame);
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let plain = decrypt(text, key)?.replace('\0', "");
    match serde_json::from_str::<Value>(&plain).ok()? {
        Value::Object(m) => Some(m),
        _ => None,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    // Produced by Node with main's own `encrypt` (aes-128-cbc, key = base64 secret, zero IV) -> hex.
    pub const READY_PLAIN: &str = r#"{"type": "update", "command": "native-ready"}"#;
    pub const READY_HEX: &str = "aa86e40365c48c1c63fe6b0e0ba67b1e6714eff63021aea7244d4a005c2af764eb549f87c9aa3970730fbe89426fdb22";
    const MAKE_CALL_PLAIN: &str = r#"{"type":"request","command":"makeCall","data":{"partner":[{"id":"123","name":"Nguyễn Văn Á 😀"}],"type":1}}"#;
    const MAKE_CALL_HEX: &str = "4d8c2a9b25501aa04cb54e198212e58862cba9a3ebf2b085db3fae014058cc44934645a90f7b159785adfa1838e03fe7a31469c518d7a0b38e3753b51a932e02748a204ea14a71609d4cae6c4b61734608756225655836b743a8c3e7a3c175958342d42bdcfab6a5c055b10163783b98a9c38f30385fc2a0d7c812c19ed1944d";

    fn key() -> Vec<u8> {
        default_key()
    }

    #[test]
    fn encrypt_matches_node() {
        assert_eq!(encrypt(READY_PLAIN, &key()).unwrap(), READY_HEX);
        assert_eq!(encrypt(MAKE_CALL_PLAIN, &key()).unwrap(), MAKE_CALL_HEX);
    }

    #[test]
    fn decrypt_matches_node() {
        assert_eq!(decrypt(READY_HEX, &key()).as_deref(), Some(READY_PLAIN));
        assert_eq!(decrypt(MAKE_CALL_HEX, &key()).as_deref(), Some(MAKE_CALL_PLAIN));
        // main's decrypt() throws on bad padding / non-hex; so do we (None).
        assert_eq!(decrypt("zz", &key()), None);
        assert_eq!(decrypt(&READY_HEX[..READY_HEX.len() - 2], &key()), None);
        assert_eq!(decrypt("", &key()), None);
    }

    #[test]
    fn round_trip_large_unicode() {
        let text = "Xin chào 😀 Zalo — ".repeat(500);
        assert_eq!(decrypt(&encrypt(&text, &key()).unwrap(), &key()), Some(text));
    }

    #[test]
    fn key_is_sixteen_bytes() {
        assert_eq!(key().len(), 16);
    }

    #[test]
    fn single_chunk_is_payload_and_dollar() {
        let mut c = Chunker::default();
        assert_eq!(c.chunks("abcd"), vec!["abcd$"]);
        assert_eq!(c.chunks(&"a".repeat(4000)), vec!["a".repeat(4000) + "$"]);
        assert_eq!(c.chunks(""), vec!["$"]);
    }

    #[test]
    fn chunks_match_build_list_msgs() {
        // Node: build(hex(10112 chars), 77) -> lengths [4009, 4009, 2121], suffixes "#77#3#<i>#$"
        let mut c = Chunker::default();
        let payload = "0123456789abcdef".repeat(632);
        let chunks = c.chunks_at(&payload, 77);
        assert_eq!(chunks.iter().map(String::len).collect::<Vec<_>>(), vec![4009, 4009, 2121]);
        for (i, chunk) in chunks.iter().enumerate() {
            assert!(chunk.ends_with(&format!("#77#3#{i}#$")));
        }
        let rebuilt: String = chunks.iter().map(|c| &c[..c.len() - "#77#3#0#$".len()]).collect();
        assert_eq!(rebuilt, payload);
        // Sequence is `max(r + 1, Date.now())`: strictly increasing even within one millisecond.
        assert!(c.chunks_at(&payload, 77)[0].ends_with("#78#3#0#$"));
    }

    #[test]
    fn decoder_handles_split_and_joined_frames() {
        let mut d = FrameDecoder::default();
        let mut dropped = 0;
        let wire = format!("{READY_HEX}${MAKE_CALL_HEX}$").into_bytes();
        let mut messages = d.feed(&wire[..40], &key(), &mut dropped);
        assert!(messages.is_empty());
        messages.extend(d.feed(&wire[40..140], &key(), &mut dropped));
        assert!(messages.len() <= 1);
        messages.extend(d.feed(&wire[140..], &key(), &mut dropped));
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["command"], "native-ready");
        assert_eq!(messages[1]["command"], "makeCall");
        assert_eq!(dropped, 0);
    }

    #[test]
    fn decoder_waits_for_the_terminator() {
        let mut d = FrameDecoder::default();
        let mut dropped = 0;
        assert!(d.feed(READY_HEX.as_bytes(), &key(), &mut dropped).is_empty());
        let messages = d.feed(b"$", &key(), &mut dropped);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["type"], "update");
        // No plaintext fallback: main's decrypt() throws on it.
        assert!(d.feed(br#"{"type":"update"}$"#, &key(), &mut dropped).is_empty());
        assert_eq!(dropped, 1);
    }

    #[test]
    fn decoder_drops_garbage_and_keeps_going() {
        let mut d = FrameDecoder::default();
        let mut dropped = 0;
        let messages = d.feed(format!("not-hex${READY_HEX}$$").as_bytes(), &key(), &mut dropped);
        assert_eq!(messages.len(), 1);
        assert_eq!(dropped, 1);
    }

    #[test]
    fn decoder_strips_nul_bytes() {
        // main: JSON.parse(plain.replace(/[\0]/g, ""))
        let hex = encrypt("{\"type\":\"update\"\0,\"command\":\"x\"}\0", &key()).unwrap();
        let mut d = FrameDecoder::default();
        let mut dropped = 0;
        let messages = d.feed(format!("{hex}$").as_bytes(), &key(), &mut dropped);
        assert_eq!(messages[0]["command"], "x");
    }
}
