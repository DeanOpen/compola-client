//! JS value conventions shared with the host scripts (`bridge.js`, `network-shim.js`).
//!
//! Values cross the WebKit boundary as JSON. Binary travels as `{"__bytes": base64}` (a `Uint8Array` in JS;
//! with `"__arraybuffer": true` an `ArrayBuffer`), `undefined` as `{"__undefined": true}`, and Node `fs.Stats`
//! as `{"__stats": true, …}`. Mirrors `ZaloBridge.toJS` / `fromJS` of the Swift app.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::{Map, Value, json};

pub type Args = Vec<Value>;

/// JS `undefined`.
pub fn undef() -> Value {
    json!({ "__undefined": true })
}

/// A `Uint8Array`.
pub fn bytes(data: &[u8]) -> Value {
    json!({ "__bytes": B64.encode(data) })
}

/// An `ArrayBuffer`.
pub fn array_buffer(data: &[u8]) -> Value {
    json!({ "__bytes": B64.encode(data), "__arraybuffer": true })
}

pub fn b64(data: &[u8]) -> String {
    B64.encode(data)
}

pub fn unb64(text: &str) -> Vec<u8> {
    B64.decode(text.trim()).unwrap_or_default()
}

/// Bytes of a JS value: `{__bytes}` decodes, a string is taken as UTF-8 (Node accepts both for most APIs).
pub fn js_bytes(value: &Value) -> Option<Vec<u8>> {
    match value {
        Value::Object(map) => map.get("__bytes").and_then(Value::as_str).map(unb64),
        Value::String(s) => Some(s.as_bytes().to_vec()),
        _ => None,
    }
}

pub fn is_undefined(value: &Value) -> bool {
    matches!(value, Value::Object(m) if m.get("__undefined").and_then(Value::as_bool) == Some(true))
}

/// Typed access to handler arguments (`args.string(0)` etc. in the Swift app).
pub trait ArgsExt {
    fn str_at(&self, i: usize) -> Option<&str>;
    fn string_at(&self, i: usize) -> Option<String> {
        self.str_at(i).map(str::to_owned)
    }
    fn i64_at(&self, i: usize) -> Option<i64>;
    fn bool_at(&self, i: usize) -> Option<bool>;
    fn obj_at(&self, i: usize) -> Option<&Map<String, Value>>;
    fn bytes_at(&self, i: usize) -> Option<Vec<u8>>;
    fn value_at(&self, i: usize) -> Option<&Value>;
}

impl ArgsExt for [Value] {
    fn str_at(&self, i: usize) -> Option<&str> {
        self.get(i).and_then(Value::as_str)
    }
    fn i64_at(&self, i: usize) -> Option<i64> {
        self.get(i).and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
    }
    fn bool_at(&self, i: usize) -> Option<bool> {
        self.get(i).and_then(Value::as_bool)
    }
    fn obj_at(&self, i: usize) -> Option<&Map<String, Value>> {
        self.get(i).and_then(Value::as_object)
    }
    fn bytes_at(&self, i: usize) -> Option<Vec<u8>> {
        self.get(i).and_then(js_bytes)
    }
    fn value_at(&self, i: usize) -> Option<&Value> {
        self.get(i).filter(|v| !v.is_null() && !is_undefined(v))
    }
}

/// Serialises a value for embedding in a JS source string.
pub fn js_literal(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".into())
}

pub fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}
