//! Byte-level patches applied while serving renderer files — port of the static helpers of `AsarSchemeHandler`.
//! Each patch applies only to an unambiguous match and otherwise serves the original bytes (and logs why).

use regex::bytes::Regex as BytesRegex;

pub fn apply(path: &str, data: Vec<u8>) -> Vec<u8> {
    let is_js = path.ends_with(".js");
    if path.starts_with("/dal-worker.") && is_js {
        let mut out = worker_prelude().into_bytes();
        out.extend_from_slice(&data);
        return out;
    }
    if path.starts_with("/sync-v2-sub-worker.") && is_js {
        let mut body = expose_webpack_require(data);
        if cfg!(debug_assertions) {
            body = forward_sub_worker_import_error(body);
        }
        return body;
    }
    if path.starts_with("/lazy/main-startup.") && is_js {
        return patch_sync_global_id_resolver(data);
    }
    data
}

fn find(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    (from..=hay.len() - needle.len()).find(|&i| &hay[i..i + needle.len()] == needle)
}

/// DEVIATION FROM OFFICIAL (sync-v2 `GET_GLOBAL_NOISED_IDS`, main renderer chunk `lazy/main-startup.*.js`): the
/// lookup callback also asks `window.__swzGlobalIdFallback` (transfer-adapter.js) for ids the profile lookup left
/// unmapped. See the Swift app's `AsarSchemeHandler.patchSyncGlobalIdResolver` for the full rationale.
pub fn patch_sync_global_id_resolver(data: Vec<u8>) -> Vec<u8> {
    let Ok(source) = std::str::from_utf8(&data) else {
        log::error!("main-startup served without global-id fallback: not utf8");
        return data;
    };
    let ident = r"[A-Za-z_$][A-Za-z0-9_$]*";
    // `regex` has no backreferences: match the shape, then check group 3 is reused as the argument.
    let pattern = format!(
        r"({ident})\.resolveWithRetry\(({ident}),\(({ident})=>({ident})\.default\.getGlobalIdsFromUserIds\(({ident})\)\)\)"
    );
    let re = regex::Regex::new(&pattern).unwrap();
    let matches: Vec<_> = re.captures_iter(source).filter(|c| c[3] == c[5]).collect();
    if matches.len() != 1 {
        log::error!(
            "main-startup served without global-id fallback: {}",
            if matches.is_empty() { "resolver shape not found" } else { "resolver shape ambiguous" }
        );
        return data;
    }
    let m = &matches[0];
    let (svc, ids, arg, mgr) = (&m[1], &m[2], &m[3], &m[4]);
    let replacement = format!(
        "{svc}.resolveWithRetry({ids},(async {arg}=>{{let __r=await {mgr}.default.getGlobalIdsFromUserIds({arg})||{{}};const __m={arg}.filter(__i=>!__r[__i]),__f=window.__swzGlobalIdFallback;if(__m.length&&typeof __f===\"function\")try{{__r=Object.assign({{}},__r,await __f(__m))}}catch(__e){{}}return __r}}))"
    );
    let whole = m.get(0).unwrap();
    let mut out = String::with_capacity(source.len() + 256);
    out.push_str(&source[..whole.start()]);
    out.push_str(&replacement);
    out.push_str(&source[whole.end()..]);
    out.into_bytes()
}

/// The sub-worker bundle keeps its webpack `require` private; the DAL worker prelude needs it. Adds
/// `self.__swReq = <require>;` in front of `<require>.e=function(e){var t=[],n=a[e]`.
pub fn expose_webpack_require(data: Vec<u8>) -> Vec<u8> {
    let tail = b"=function(e){var t=[],n=a[e]";
    let unpatched = |why: &str, data: Vec<u8>| {
        log::error!("sync-v2-sub-worker served unpatched: {why}");
        data
    };
    let Some(at) = find(&data, tail, 0) else { return unpatched("runtime shape not found", data) };
    if find(&data, tail, at + tail.len()).is_some() {
        return unpatched("runtime shape ambiguous", data);
    }
    if at < 2 || data[at - 1] != b'e' || data[at - 2] != b'.' {
        return unpatched("no .e accessor", data);
    }
    let is_ident = |c: u8| c.is_ascii_alphanumeric() || c == b'_' || c == b'$';
    let mut start = at - 2;
    while start > 0 && is_ident(data[start - 1]) {
        start -= 1;
    }
    if start >= at - 2 || data[start].is_ascii_digit() || start == 0 || !(data[start - 1] == b'}' || data[start - 1] == b';') {
        return unpatched("not at a statement boundary", data);
    }
    let ident = String::from_utf8_lossy(&data[start..at - 2]).into_owned();
    let mut out = Vec::with_capacity(data.len() + 32);
    out.extend_from_slice(&data[..start]);
    out.extend_from_slice(format!("self.__swReq={ident};").as_bytes());
    out.extend_from_slice(&data[start..]);
    out
}

fn forward_sub_worker_import_error(data: Vec<u8>) -> Vec<u8> {
    let marker = b"return this.logger.zsymb(18,\"CytfSU\",";
    let Some(at) = find(&data, marker, 0) else { return data };
    let inject = b"self.__zhostFwd&&self.__zhostFwd('insertToDb-failed',e&&((e.name||'')+': '+(e.message||e)+' | '+String(e.stack||'').split('\\n').slice(0,6).join(' < ')));";
    let mut out = Vec::with_capacity(data.len() + inject.len());
    out.extend_from_slice(&data[..at]);
    out.extend_from_slice(inject);
    out.extend_from_slice(&data[at..]);
    out
}

#[allow(dead_code)]
fn _unused(_: BytesRegex) {}

const WORKER_DEBUG_EVAL: &str = r#"
  self.addEventListener('message', async (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object' || typeof d.__zhostEval !== 'string') return;
    e.stopImmediatePropagation();
    try { const r = await (0, eval)(d.__zhostEval); self.postMessage({ __zhostEvalResult: JSON.stringify(r === undefined ? null : r) }); }
    catch (err) { self.postMessage({ __zhostEvalResult: JSON.stringify({ error: errText(err) }) }); }
  });
"#;

const WORKER_PRELUDE_BASE: &str = r#"(() => {
  const fwd = (k, v) => { try { self.postMessage({ __zhostLog: k + ' ' + String(v).slice(0, 300) }); } catch {} };
  self.__zhostFwd = fwd;
  /*DEBUG_EVAL*/
  const errText = (e) => e ? (e.name || '') + ': ' + (e.message || e) : String(e);
  self.addEventListener('error', (e) => fwd('error', e.message));
  self.addEventListener('unhandledrejection', (e) => fwd('unhandledrejection', errText(e.reason)));
  for (const lvl of ['warn', 'error']) { const o = console[lvl]; console[lvl] = (...a) => { fwd('console.' + lvl, a.map((x) => x instanceof Error ? errText(x) : (typeof x === 'string' ? x : '')).join(' ')); return o.apply(console, a); }; }
  const ensureDatabaseClient = () => {
    try {
      const req = self.__swReq;
      if (!req || !req.c) { fwd('webpack require not exposed', ''); return; }
      for (const id of Object.keys(req.c)) {
        try {
          const d = req.c[id] && req.c[id].exports && req.c[id].exports.default;
          if (d && typeof d.getInstance === 'function' && String(d.getInstance).includes('createQueryBuilder')) { d.getInstance(); fwd('database client ready', id); return; }
        } catch (e) { }
      }
      fwd('database client accessor not found', '');
    } catch (e) { fwd('database client setup failed', errText(e)); }
  };
  if (typeof self.importScripts === 'function') {
    const imp = self.importScripts;
    self.importScripts = function (...urls) { const r = imp.apply(this, urls); if (urls.some((u) => /sync-v2-sub-worker/.test(String(u)))) ensureDatabaseClient(); return r; };
  }
  if (typeof IDBDatabase !== 'undefined') {
    const tx = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...a) {
      const t = tx.apply(this, a);
      t.addEventListener('abort', () => fwd('idb-abort', errText(t.error)));
      return t;
    };
    for (const m of ['add', 'put']) {
      const o = IDBObjectStore.prototype[m];
      IDBObjectStore.prototype[m] = function (...a) {
        try { const r = o.apply(this, a); r.addEventListener('error', () => fwd('idb-' + m + '-error', this.name + ' ' + errText(r.error))); return r; }
        catch (e) { fwd('idb-' + m + '-throw', this.name + ' ' + errText(e)); throw e; }
      };
    }
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (...a) {
      const r = open.apply(this, a);
      r.addEventListener('error', () => fwd('idb-open-error', errText(r.error)));
      r.addEventListener('blocked', () => fwd('idb-open-blocked', ''));
      return r;
    };
  }
})();
"#;

pub fn worker_prelude() -> String {
    let debug = if cfg!(debug_assertions) { WORKER_DEBUG_EVAL } else { "" };
    WORKER_PRELUDE_BASE.replace("/*DEBUG_EVAL*/", debug)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_require() {
        let src = b"foo();r.e=function(e){var t=[],n=a[e];}".to_vec();
        let out = String::from_utf8(expose_webpack_require(src)).unwrap();
        assert_eq!(out, "foo();self.__swReq=r;r.e=function(e){var t=[],n=a[e];}");
    }

    #[test]
    fn patches_resolver_once() {
        let src = b"x;s.resolveWithRetry(i,(n=>m.default.getGlobalIdsFromUserIds(n)));y".to_vec();
        let out = String::from_utf8(patch_sync_global_id_resolver(src)).unwrap();
        assert!(out.contains("__swzGlobalIdFallback"));
        assert!(out.starts_with("x;s.resolveWithRetry(i,(async n=>"));
    }
}
