//! Request headers for media loads (Swift `MediaLoader.applyClientHeaders` / `clientHeaders` / `sanitizedHeaders` /
//! `redirectedRequest`). Chromium 108 sends a different header set for an `<img>` load than for a `fetch()`
//! (`reanalysis/wire-fingerprint.md`, "Media loads").

use crate::net::fp;

/// Which Chromium load a media request corresponds to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Flavour {
    /// An `<img>` load: no-cors, image Accept.
    Image,
    /// A `fetch()`/XHR by the renderer: cors mode.
    Cors,
}

impl Flavour {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "image" | "" => Some(Self::Image),
            "cors" => Some(Self::Cors),
            _ => None,
        }
    }
}

/// Headers that never travel to a host outside Zalo's domains, nor survive a cross-host redirect.
pub const SENSITIVE_HEADER_NAMES: &[&str] = &["cloud-viewer-key", "cookie", "authorization", "proxy-authorization"];

/// Connection-level headers a caller must not set.
pub const FORBIDDEN_HEADER_NAMES: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
    "expect",
    "accept-encoding",
];

/// Swift `clientHeaders(_:)`: the flavour's Chromium header set, without User-Agent / Accept-Encoding (the
/// fingerprint helper and the transports add those themselves).
pub fn client_headers(flavour: Flavour) -> Vec<(String, String)> {
    let (accept, dest, mode) = match flavour {
        Flavour::Image => (fp::IMAGE_ACCEPT, "image", "no-cors"),
        Flavour::Cors => ("*/*", "empty", "cors"),
    };
    [
        ("sec-ch-ua", fp::SEC_CH_UA.to_owned()),
        ("sec-ch-ua-mobile", fp::SEC_CH_UA_MOBILE.to_owned()),
        ("sec-ch-ua-platform", fp::SEC_CH_UA_PLATFORM.to_owned()),
        ("Accept", accept.to_owned()),
        ("sec-fetch-site", "cross-site".to_owned()),
        ("sec-fetch-mode", mode.to_owned()),
        ("sec-fetch-dest", dest.to_owned()),
        ("accept-language", fp::accept_language()),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v))
    .collect()
}

/// Swift `applyClientHeaders(to:flavour:)`: fills in every flavour header the caller did not set, plus the
/// User-Agent and Chromium's Accept-Encoding (reqwest decodes gzip/deflate/br itself).
pub fn apply_client_headers(headers: &mut Vec<(String, String)>, flavour: Flavour, user_agent: &str) {
    let mut defaults = vec![("User-Agent".to_owned(), user_agent.to_owned())];
    defaults.extend(client_headers(flavour));
    defaults.push(("accept-encoding".to_owned(), fp::ACCEPT_ENCODING.to_owned()));
    for (name, value) in defaults {
        if !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case(&name)) {
            headers.push((name, value));
        }
    }
}

/// Swift `helperHeaders(base:url:flavour:)`: the caller's sanitized headers, then the flavour defaults they lack.
pub fn helper_headers(base: &[(String, String)], url: &url::Url, flavour: Flavour) -> Vec<(String, String)> {
    let mut ordered = sanitized_headers(base, url);
    for (name, value) in client_headers(flavour) {
        if !ordered.iter().any(|(k, _)| k.eq_ignore_ascii_case(&name)) {
            ordered.push((name, value));
        }
    }
    ordered
}

fn is_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || "!#$%&'*+-.^_`|~".contains(c)
}

/// Swift `sanitizedHeaders(_:for:)`: names are RFC 7230 tokens, values hold no CR/LF/control characters,
/// hop-by-hop names are dropped, and sensitive ones only go to https Zalo hosts.
pub fn sanitized_headers(headers: &[(String, String)], url: &url::Url) -> Vec<(String, String)> {
    let to_zalo = url.scheme() == "https" && url.host_str().is_some_and(super::is_zalo_cdn);
    headers
        .iter()
        .filter(|(name, value)| {
            let lower = name.to_ascii_lowercase();
            !name.is_empty()
                && name.chars().all(is_token_char)
                && !FORBIDDEN_HEADER_NAMES.contains(&lower.as_str())
                && value.chars().all(|c| (c as u32 >= 0x20 && c as u32 != 0x7f) || c == '\t')
                && (to_zalo || !SENSITIVE_HEADER_NAMES.contains(&lower.as_str()))
        })
        .cloned()
        .collect()
}

/// Swift `redirectedRequest(_:originHost:)`: the headers to send to a redirect target — sensitive ones do not
/// leave the host they were meant for. (reqwest already strips cookie/authorization on cross-host redirects; this is
/// for callers that re-issue redirects with their own headers, e.g. Zalo Cloud's `cloud-viewer-key` downloads.)
#[allow(dead_code)]
pub fn redirected_headers(headers: &[(String, String)], origin_host: &str, next: &url::Url) -> Vec<(String, String)> {
    let same_host = next.host_str().is_some_and(|h| h.eq_ignore_ascii_case(origin_host));
    headers
        .iter()
        .filter(|(name, _)| same_host || !SENSITIVE_HEADER_NAMES.contains(&name.to_ascii_lowercase().as_str()))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    fn get<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
        headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    #[test]
    fn image_and_cors_flavours_match_the_wire_capture() {
        let image = client_headers(Flavour::Image);
        assert_eq!(get(&image, "accept"), Some("image/webp,image/apng,image/*,*/*;q=0.8"));
        assert_eq!(get(&image, "sec-fetch-dest"), Some("image"));
        assert_eq!(get(&image, "sec-fetch-mode"), Some("no-cors"));
        let cors = client_headers(Flavour::Cors);
        assert_eq!(get(&cors, "accept"), Some("*/*"));
        assert_eq!(get(&cors, "sec-fetch-dest"), Some("empty"));
        assert_eq!(get(&cors, "sec-fetch-mode"), Some("cors"));
        for set in [&image, &cors] {
            assert_eq!(get(set, "sec-fetch-site"), Some("cross-site"));
            assert_eq!(get(set, "sec-ch-ua"), Some(fp::SEC_CH_UA));
            assert_eq!(get(set, "sec-ch-ua-mobile"), Some("?0"));
            assert_eq!(get(set, "sec-ch-ua-platform"), Some("\"macOS\""));
            assert!(get(set, "accept-language").is_some());
            // No Origin / Referer: a file:// renderer page sends neither.
            assert!(get(set, "origin").is_none() && get(set, "referer").is_none());
            assert!(get(set, "user-agent").is_none() && get(set, "accept-encoding").is_none());
        }
    }

    #[test]
    fn apply_fills_only_missing_headers() {
        let mut headers = h(&[("Accept", "text/custom")]);
        apply_client_headers(&mut headers, Flavour::Image, "ZaloPC-darwin-23v694");
        assert_eq!(get(&headers, "accept"), Some("text/custom"));
        assert_eq!(get(&headers, "user-agent"), Some("ZaloPC-darwin-23v694"));
        assert_eq!(get(&headers, "accept-encoding"), Some("gzip, deflate, br"));
        assert_eq!(get(&headers, "sec-fetch-dest"), Some("image"));
        assert_eq!(headers.iter().filter(|(k, _)| k.eq_ignore_ascii_case("accept")).count(), 1);
    }

    #[test]
    fn flavour_parsing() {
        assert_eq!(Flavour::parse("image"), Some(Flavour::Image));
        assert_eq!(Flavour::parse(""), Some(Flavour::Image));
        assert_eq!(Flavour::parse("cors"), Some(Flavour::Cors));
        assert_eq!(Flavour::parse("video"), None);
    }

    #[test]
    fn helper_headers_keep_caller_values_and_add_defaults() {
        let url = url::Url::parse("https://zcld.chat.zalo.me/a").unwrap();
        let out = helper_headers(&h(&[("cloud-viewer-key", "k"), ("Accept", "x/y")]), &url, Flavour::Cors);
        assert_eq!(out[0], ("cloud-viewer-key".into(), "k".into()));
        assert_eq!(get(&out, "accept"), Some("x/y"));
        assert_eq!(get(&out, "sec-fetch-mode"), Some("cors"));
    }

    #[test]
    fn sensitive_headers_only_go_to_zalo_hosts() {
        let headers = h(&[("cloud-viewer-key", "k"), ("Cookie", "c"), ("X-Ok", "1")]);
        let zalo = url::Url::parse("https://zcld.chat.zalo.me/a").unwrap();
        assert_eq!(sanitized_headers(&headers, &zalo), headers);
        assert_eq!(sanitized_headers(&headers, &url::Url::parse("https://evil.example/a").unwrap()), h(&[("X-Ok", "1")]));
        assert_eq!(sanitized_headers(&headers, &url::Url::parse("http://zcld.chat.zalo.me/a").unwrap()), h(&[("X-Ok", "1")]));
    }

    #[test]
    fn rejects_injection_and_hop_by_hop_headers() {
        let zalo = url::Url::parse("https://zcld.chat.zalo.me/a").unwrap();
        let headers = h(&[
            ("X-A", "ok"),
            ("X-B", "a\r\nX-Evil: 1"),
            ("X-C", "a\u{0}b"),
            ("Bad Name", "v"),
            ("X:D", "v"),
            ("", "v"),
            ("Connection", "close"),
            ("Transfer-Encoding", "chunked"),
            ("Host", "evil"),
            ("Content-Length", "5"),
            ("X-Tab", "a\tb"),
        ]);
        assert_eq!(sanitized_headers(&headers, &zalo), h(&[("X-A", "ok"), ("X-Tab", "a\tb")]));
    }

    #[test]
    fn cross_host_redirect_drops_sensitive_headers() {
        let headers = h(&[("cloud-viewer-key", "k"), ("Cookie", "c"), ("X-Ok", "1")]);
        let cross = redirected_headers(&headers, "zcld.chat.zalo.me", &url::Url::parse("https://other.example/x").unwrap());
        assert_eq!(cross, h(&[("X-Ok", "1")]));
        let same = redirected_headers(&headers, "zcld.chat.zalo.me", &url::Url::parse("https://ZCLD.chat.zalo.me/y").unwrap());
        assert_eq!(same, headers);
    }
}
