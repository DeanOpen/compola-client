//! Port of `FingerprintProxyTests.swift` and the network-free parts of `ClientFingerprintTests.swift`:
//! the frame parser and wire JSON (pure), then the helper process + unix-socket protocol (HTTP, streaming,
//! websockets) against local servers, and the official header set / order.
//!
//! The helper binary is built by `scripts/build-fingerprint-helper.sh`; the process tests skip when it is
//! absent. `peet_ws_fingerprint` (ignored) checks the real TLS / HTTP-2 fingerprint over the network:
//! `cargo test peet_ws -- --ignored --nocapture`.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

use super::connection::{Frame, FrameParser, MAX_WS_MESSAGE, decode_response, encode_request, upstream_error};
use super::*;
use crate::net::{apply_client_headers, fp, helper_request_headers};

// ---- Frame parser ----

fn feed_all(parser: &mut FrameParser, pieces: &[&[u8]]) -> Vec<Frame> {
    let mut out = Vec::new();
    for piece in pieces {
        parser.feed(piece, &mut out).expect("valid stream");
    }
    out
}

fn line(command: &str, id: &str, rest: &str) -> Frame {
    Frame::Line { command: command.into(), id: id.into(), rest: rest.into() }
}

#[test]
fn parser_splits_lines_and_keeps_json_spaces() {
    let mut parser = FrameParser::default();
    let frames = feed_all(&mut parser, &[b"OK 1 chrome_108\nRES r1 {\"status\": 200, ", b"\"url\": \"a b\"}\nEND r2\n"]);
    assert_eq!(
        frames,
        vec![line("OK", "1", "chrome_108"), line("RES", "r1", r#"{"status": 200, "url": "a b"}"#), line("END", "r2", "")]
    );
}

#[test]
fn parser_reads_binary_payloads_byte_exact_across_reads() {
    // Payloads may contain newlines and arrive split anywhere.
    let stream = b"CHUNK r1 5\na\nb\ncWSMSG w1 text 4\npingWSMSG w1 binary 3\n\x01\n\x03WSCLOSED w1 1000 {}\n";
    for split in 1..stream.len() {
        let mut parser = FrameParser::default();
        let frames = feed_all(&mut parser, &[&stream[..split], &stream[split..]]);
        assert_eq!(
            frames,
            vec![
                Frame::Chunk { id: "r1".into(), data: b"a\nb\nc".to_vec() },
                Frame::WsMessage { id: "w1".into(), text: true, data: b"ping".to_vec() },
                Frame::WsMessage { id: "w1".into(), text: false, data: vec![1, b'\n', 3] },
                line("WSCLOSED", "w1", "1000 {}"),
            ],
            "split at {split}"
        );
    }
}

#[test]
fn parser_handles_empty_payloads_and_byte_at_a_time_feeding() {
    let stream = b"CHUNK r1 0\nWSMSG w1 text 0\nEND r1\n";
    let mut parser = FrameParser::default();
    let pieces: Vec<&[u8]> = stream.chunks(1).collect();
    assert_eq!(
        feed_all(&mut parser, &pieces),
        vec![
            Frame::Chunk { id: "r1".into(), data: vec![] },
            Frame::WsMessage { id: "w1".into(), text: true, data: vec![] },
            line("END", "r1", ""),
        ]
    );
}

#[test]
fn parser_skips_oversized_websocket_messages_and_stays_in_sync() {
    let mut parser = FrameParser::default();
    let mut out = Vec::new();
    parser.feed(format!("WSMSG w1 binary {}\n", MAX_WS_MESSAGE + 1).as_bytes(), &mut out).unwrap();
    let block = vec![0u8; 1 << 20];
    let mut remaining = MAX_WS_MESSAGE + 1;
    while remaining > 0 {
        let take = remaining.min(block.len());
        parser.feed(&block[..take], &mut out).unwrap();
        remaining -= take;
    }
    parser.feed(b"END r9\n", &mut out).unwrap();
    assert_eq!(out, vec![Frame::WsOversized { id: "w1".into() }, line("END", "r9", "")]);
}

#[test]
fn parser_rejects_bad_binary_lengths() {
    for bad in [&b"CHUNK r1 x\n"[..], b"CHUNK r1 -1\n", b"CHUNK r1 99999999999\n", b"WSMSG w1 text\n"] {
        let mut parser = FrameParser::default();
        assert!(parser.feed(bad, &mut Vec::new()).is_err(), "{:?}", String::from_utf8_lossy(bad));
    }
}

// ---- Wire JSON ----

#[test]
fn request_json_matches_protocol_go() {
    let mut request = Request::new("POST", "https://example.com/a?b=c d");
    request.headers = vec![("X-B".into(), "2".into()), ("x-a".into(), "1".into())];
    request.body = b"hello".to_vec();
    request.timeout_ms = 1500;
    let json: serde_json::Value = serde_json::from_str(&encode_request(&request)).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "method": "POST", "url": "https://example.com/a?b=c d",
            "headers": [["X-B", "2"], ["x-a", "1"]], // order preserved
            "bodyB64": "aGVsbG8=", "timeoutMs": 1500, "stream": false, "follow": true,
            "maxBytes": 0, "idleMs": 30000, "firstByteMs": 0,
        })
    );
    // No body: no bodyB64 at all (Swift's nil).
    let json: serde_json::Value = serde_json::from_str(&encode_request(&Request::new("GET", "https://x/"))).unwrap();
    assert!(json.get("bodyB64").is_none());
    // One line on the wire.
    assert!(!encode_request(&request).contains('\n'));
}

#[test]
fn response_json_decodes_go_shapes() {
    let response = decode_response(
        r#"{"status":200,"statusText":"200 OK","headers":[["Set-Cookie","a=1"],["Set-Cookie","b=2"],["X-Answer","42"]],"url":"https://x/y","bodyB64":"aGk="}"#,
    )
    .unwrap();
    assert_eq!(response.status, 200);
    assert_eq!(response.status_text, "OK");
    assert_eq!(response.headers.iter().filter(|(k, _)| k == "Set-Cookie").count(), 2);
    assert_eq!(response.url, "https://x/y");
    assert_eq!(response.body, b"hi");

    // Go marshals nil slices as null; an h2 status line has no reason phrase.
    let response = decode_response(r#"{"status":404,"statusText":"404","headers":null,"url":""}"#).unwrap();
    assert_eq!(response.status_text, "Not Found");
    assert!(response.headers.is_empty() && response.body.is_empty());

    assert!(matches!(decode_response("not json"), Err(Error::Failed(_))));
}

#[test]
fn upstream_errors_are_real_results_not_unavailability() {
    assert_eq!(upstream_error("body too large; use stream"), Error::TooLarge);
    assert_eq!(upstream_error("body too large"), Error::TooLarge);
    assert_eq!(upstream_error("request: dial tcp: connection refused"), Error::Failed("request: dial tcp: connection refused".into()));
}

#[test]
fn restart_backoff_is_capped() {
    assert_eq!(retry_delay(0), Duration::from_secs(1));
    assert_eq!(retry_delay(3), Duration::from_secs(8));
    assert_eq!(retry_delay(6), Duration::from_secs(60));
    assert_eq!(retry_delay(40), Duration::from_secs(60));
}

// ---- ClientFingerprint (network-free) ----

#[test]
fn user_agent_follows_runtime_client_version() {
    assert_eq!(fp::user_agent("695"), "ZaloPC-darwin-23v695");
    assert_eq!(fp::user_agent(fp::DEFAULT_CLIENT_VERSION), "ZaloPC-darwin-23v694");
}

#[test]
fn accept_language_single_entry_has_no_q_values() {
    assert_eq!(fp::accept_language_from(&["en-US".into()]), "en-US");
    assert_eq!(fp::accept_language_from(&["vi-VN".into()]), "vi-VN");
}

#[test]
fn accept_language_multiple_entries_descend_by_tenth() {
    assert_eq!(fp::accept_language_from(&["vi-VN".into(), "en-US".into()]), "vi-VN,en-US;q=0.9");
    assert_eq!(fp::accept_language_from(&["vi-VN".into(), "vi".into(), "en-US".into()]), "vi-VN,vi;q=0.9,en-US;q=0.8");
    assert!(!fp::accept_language_from(&[]).is_empty());
    assert!(!fp::accept_language().is_empty());
}

#[test]
fn form_boundary_matches_chromium_format() {
    let pattern = regex::Regex::new(r"^----WebKitFormBoundary[0-9A-Za-z]{16}$").unwrap();
    for _ in 0..5 {
        let boundary = fp::form_boundary();
        assert!(pattern.is_match(&boundary), "boundary not in Chromium's format: {boundary}");
    }
    assert_ne!(fp::form_boundary(), fp::form_boundary());
}

/// What the page (axios) sets on an API call.
fn axios_headers() -> Vec<(String, String)> {
    vec![
        ("Accept".into(), "application/json, text/plain, */*".into()),
        ("Content-Type".into(), "application/x-www-form-urlencoded".into()),
    ]
}

#[test]
fn proxied_requests_get_the_official_header_set() {
    let mut headers = axios_headers();
    apply_client_headers(&mut headers);
    let headers = helper_request_headers(&headers, &fp::user_agent("694"), Some("zpw_sek=a; zpw_sek=b"));
    let get = |name: &str| -> Vec<&str> {
        headers.iter().filter(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str()).collect()
    };
    assert_eq!(get("sec-ch-ua"), [fp::SEC_CH_UA]);
    assert_eq!(get("sec-ch-ua"), [r#""Not?A_Brand";v="8", "Chromium";v="108""#]);
    assert_eq!(get("sec-ch-ua-mobile"), ["?0"]);
    assert_eq!(get("sec-ch-ua-platform"), [r#""macOS""#]);
    assert_eq!(get("sec-fetch-dest"), ["empty"]);
    assert_eq!(get("sec-fetch-mode"), ["cors"]);
    assert_eq!(get("sec-fetch-site"), ["cross-site"]);
    assert_eq!(get("accept-encoding"), ["gzip, deflate, br"]);
    assert_eq!(get("accept-language"), [fp::accept_language().as_str()]);
    assert_eq!(get("user-agent"), ["ZaloPC-darwin-23v694"]);
    assert_eq!(get("cookie"), ["zpw_sek=a; zpw_sek=b"]);
    // Page-set headers survive untouched.
    assert_eq!(get("accept"), ["application/json, text/plain, */*"]);
    // The official client sends neither on the wire.
    assert!(get("origin").is_empty() && get("referer").is_empty());
    // Every name once.
    let mut names: Vec<String> = headers.iter().map(|(k, _)| k.to_ascii_lowercase()).collect();
    names.sort();
    names.dedup();
    assert_eq!(names.len(), headers.len());
}

#[test]
fn helper_header_order_is_page_then_browser_defaults_then_cookie() {
    let mut page = axios_headers();
    page.push(("sec-fetch-site".into(), "same-origin".into())); // a page value wins over the default
    page.push(("cookie".into(), "forged=1".into())); // forbidden header: the jar's cookie replaces it
    let headers = helper_request_headers(&page, "UA", Some("zpw_sek=x"));
    let names: Vec<&str> = headers.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(
        names,
        [
            "Accept",
            "Content-Type",
            "sec-fetch-site",
            "User-Agent",
            "sec-ch-ua",
            "sec-ch-ua-mobile",
            "sec-ch-ua-platform",
            "sec-fetch-dest",
            "sec-fetch-mode",
            "accept-language",
            "accept-encoding",
            "Cookie",
        ]
    );
    assert_eq!(headers[2].1, "same-origin");
    assert_eq!(headers.last().unwrap().1, "zpw_sek=x");
    // Without a jar cookie nothing is added at the end.
    assert_eq!(helper_request_headers(&axios_headers(), "UA", None).last().unwrap().0, "accept-encoding");
}

// ---- The helper process (skipped without a built helper) ----

/// The started shared proxy, like the app uses (one helper per test process).
async fn helper() -> Option<&'static FingerprintProxy> {
    if helper_path().is_none() {
        eprintln!("fingerprint helper not built — skipping (scripts/build-fingerprint-helper.sh)");
        return None;
    }
    let proxy = FingerprintProxy::shared().ready(Duration::from_secs(10)).await;
    if proxy.is_none() {
        eprintln!("fingerprint helper did not become ready — skipping");
    }
    proxy
}

type Handler = Arc<dyn Fn(&str, &[u8]) -> (u16, Vec<(String, String)>, Vec<u8>) + Send + Sync>;

/// A tiny local HTTP/1.1 server (keep-alive, Content-Length bodies): one handler call per request, which
/// gets the raw request head and body.
async fn local_http_server(handler: Handler) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let handler = handler.clone();
            tokio::spawn(async move {
                let mut buffer = Vec::new();
                let mut chunk = vec![0u8; 64 << 10];
                loop {
                    let Some(end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") else {
                        match stream.read(&mut chunk).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => buffer.extend_from_slice(&chunk[..n]),
                        }
                        continue;
                    };
                    let head = String::from_utf8_lossy(&buffer[..end]).into_owned();
                    let length: usize = head
                        .lines()
                        .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().to_owned()))
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(0);
                    while buffer.len() < end + 4 + length {
                        match stream.read(&mut chunk).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => buffer.extend_from_slice(&chunk[..n]),
                        }
                    }
                    let body = buffer[end + 4..end + 4 + length].to_vec();
                    buffer.drain(..end + 4 + length);
                    let (status, headers, payload) = handler(&head, &body);
                    let mut response = format!("HTTP/1.1 {status} X\r\nContent-Length: {}\r\n", payload.len());
                    for (name, value) in headers {
                        response.push_str(&format!("{name}: {value}\r\n"));
                    }
                    response.push_str("\r\n");
                    let mut bytes = response.into_bytes();
                    bytes.extend_from_slice(&payload);
                    if stream.write_all(&bytes).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
    port
}

#[tokio::test]
async fn hello_and_request_roundtrip() {
    let Some(proxy) = helper().await else { return };
    let seen = Arc::new(Mutex::new(Vec::<String>::new()));
    let log = seen.clone();
    let port = local_http_server(Arc::new(move |head, body| {
        log.lock().push(format!("{head}\n[body {}]", String::from_utf8_lossy(body)));
        (200, vec![("Content-Type".into(), "text/plain".into()), ("X-Answer".into(), "42".into())], b"hello".to_vec())
    }))
    .await;

    let headers = vec![("X-Compola-Test".to_owned(), "yes".to_owned()), ("Accept".to_owned(), "*/*".to_owned())];
    let response =
        proxy.perform("POST", &format!("http://127.0.0.1:{port}/a"), &headers, b"payload", Some(Duration::from_secs(10))).await;
    let response = response.expect("response");
    assert_eq!(response.status, 200);
    assert_eq!(response.status_text, "X");
    assert_eq!(response.body, b"hello");
    assert_eq!(response.url, format!("http://127.0.0.1:{port}/a"));
    let answer = response.headers.iter().find(|(k, _)| k == "X-Answer").expect("X-Answer");
    assert_eq!(answer.1, "42");
    let request = seen.lock()[0].clone();
    assert!(request.starts_with("POST /a HTTP/1.1"), "{request}");
    assert!(request.contains("X-Compola-Test: yes"), "{request}");
    assert!(request.ends_with("[body payload]"), "{request}");
}

#[tokio::test]
async fn header_order_is_pinned_on_the_wire() {
    let Some(proxy) = helper().await else { return };
    let seen = Arc::new(Mutex::new(String::new()));
    let log = seen.clone();
    let port = local_http_server(Arc::new(move |head, _| {
        *log.lock() = head.to_owned();
        (204, vec![], vec![])
    }))
    .await;
    let mut headers = axios_headers();
    apply_client_headers(&mut headers);
    let headers = helper_request_headers(&headers, "ZaloPC-darwin-23v694", Some("zpw_sek=x"));
    let response = proxy.perform("GET", &format!("http://127.0.0.1:{port}/order"), &headers, b"", None).await.unwrap();
    assert_eq!(response.status, 204);

    // fhttp sends exactly our headers in our order and adds nothing but Host (which it writes last on
    // HTTP/1.1; on HTTP/2 — Zalo's servers — it is the `:authority` pseudo-header, ordered m,a,s,p).
    let head = seen.lock().clone();
    let wire: Vec<String> = head.lines().skip(1).map(|l| l.split(':').next().unwrap().to_ascii_lowercase()).collect();
    let mut expected: Vec<String> = headers.iter().map(|(k, _)| k.to_ascii_lowercase()).collect();
    expected.push("host".to_owned());
    assert_eq!(wire, expected, "{head}");
}

#[tokio::test]
async fn stream_roundtrip_delivers_chunks_in_order() {
    let Some(proxy) = helper().await else { return };
    let payload: Vec<u8> = (0..(300 << 10)).map(|i| (i % 251) as u8).collect(); // several 64 KiB chunks
    let body = payload.clone();
    let port = local_http_server(Arc::new(move |_, _| (200, vec![], body.clone()))).await;

    let mut request = Request::new("GET", &format!("http://127.0.0.1:{port}/big"));
    request.max_bytes = 1 << 20;
    let StreamStart::Head(head, mut stream) = proxy.stream(&request).await.expect("stream") else {
        panic!("expected a streamed head")
    };
    assert_eq!(head.status, 200);
    let mut collected = Vec::new();
    while let Some(chunk) = stream.next_chunk().await.expect("chunk") {
        collected.extend_from_slice(&chunk);
    }
    assert_eq!(collected, payload);
}

#[tokio::test]
async fn max_bytes_aborts_the_stream() {
    let Some(proxy) = helper().await else { return };
    let port = local_http_server(Arc::new(|_, _| (200, vec![], vec![0x61; 1 << 20]))).await;
    let mut request = Request::new("GET", &format!("http://127.0.0.1:{port}/big"));
    request.max_bytes = 1024;
    let StreamStart::Head(_, mut stream) = proxy.stream(&request).await.expect("stream") else {
        panic!("expected a streamed head")
    };
    let result = loop {
        match stream.next_chunk().await {
            Ok(Some(_)) => continue,
            other => break other,
        }
    };
    assert_eq!(result, Err(Error::TooLarge));
}

#[tokio::test]
async fn buffered_body_limit_is_too_large() {
    let Some(proxy) = helper().await else { return };
    let port = local_http_server(Arc::new(|_, _| (200, vec![], vec![0x61; 4096]))).await;
    let mut request = Request::new("GET", &format!("http://127.0.0.1:{port}/big"));
    request.max_bytes = 1024;
    assert_eq!(proxy.perform_request(&request).await.err().expect("an error"), Error::TooLarge);
}

#[tokio::test]
async fn upstream_failures_are_failed_not_unavailable() {
    let Some(proxy) = helper().await else { return };
    // Connection refused: a real answer the caller must not retry on reqwest.
    let closed = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = closed.local_addr().unwrap().port();
    drop(closed);
    let error = proxy.perform("GET", &format!("http://127.0.0.1:{port}/"), &[], b"", None).await.err().expect("an error");
    assert!(matches!(error, Error::Failed(_)), "{error:?}");

    // A timeout too — and it must read as one (NetworkProxy reports `timedOut` from the message).
    let silent = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = silent.local_addr().unwrap().port();
    let _hold = tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((stream, _)) = silent.accept().await {
            held.push(stream);
        }
    });
    let error =
        proxy.perform("GET", &format!("http://127.0.0.1:{port}/"), &[], b"", Some(Duration::from_millis(500))).await.err().expect("an error");
    let Error::Failed(message) = error else { panic!("{error:?}") };
    assert!(crate::net::is_timeout_message(&message), "{message}");
}

#[tokio::test]
async fn cancelled_request_does_not_disturb_the_connection() {
    let Some(proxy) = helper().await else { return };
    let silent = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let silent_port = silent.local_addr().unwrap().port();
    let _hold = tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((stream, _)) = silent.accept().await {
            held.push(stream);
        }
    });
    let url = format!("http://127.0.0.1:{silent_port}/");
    let dropped = tokio::time::timeout(Duration::from_millis(300), proxy.perform("GET", &url, &[], b"", None)).await;
    assert!(dropped.is_err(), "the silent server cannot have answered");

    let port = local_http_server(Arc::new(|_, _| (200, vec![], b"still fine".to_vec()))).await;
    let response = proxy.perform("GET", &format!("http://127.0.0.1:{port}/"), &[], b"", None).await.unwrap();
    assert_eq!(response.body, b"still fine");
    assert!(proxy.is_ready());
}

// ---- WebSocket ----

/// A websocket echo server that records the upgrade request's headers and selects the first offered
/// subprotocol. A text "bye" makes it close with 4000.
async fn local_ws_echo_server() -> (u16, Arc<Mutex<Vec<(String, String)>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let log = log.clone();
            tokio::spawn(async move {
                let callback = |request: &tokio_tungstenite::tungstenite::handshake::server::Request,
                                mut response: tokio_tungstenite::tungstenite::handshake::server::Response| {
                    *log.lock() = request
                        .headers()
                        .iter()
                        .map(|(k, v)| (k.as_str().to_owned(), v.to_str().unwrap_or("").to_owned()))
                        .collect();
                    if let Some(offered) = request.headers().get("sec-websocket-protocol").and_then(|v| v.to_str().ok()) {
                        let first = offered.split(',').next().unwrap().trim().to_owned();
                        response.headers_mut().insert("sec-websocket-protocol", first.parse().unwrap());
                    }
                    Ok(response)
                };
                let Ok(mut ws) = tokio_tungstenite::accept_hdr_async(stream, callback).await else { return };
                while let Some(Ok(message)) = ws.next().await {
                    match message {
                        Message::Text(text) if text.as_str() == "bye" => {
                            let frame = tokio_tungstenite::tungstenite::protocol::CloseFrame { code: 4000.into(), reason: "bye".into() };
                            let _ = ws.send(Message::Close(Some(frame))).await;
                        }
                        Message::Text(_) | Message::Binary(_) => {
                            if ws.send(message).await.is_err() {
                                return;
                            }
                        }
                        Message::Close(_) => return,
                        _ => {}
                    }
                }
            });
        }
    });
    (port, seen)
}

#[tokio::test]
async fn websocket_echo_roundtrip() {
    let Some(proxy) = helper().await else { return };
    let (port, seen) = local_ws_echo_server().await;
    let headers = vec![
        ("User-Agent".to_owned(), "ZaloPC-darwin-23v694".to_owned()),
        ("Origin".to_owned(), "file://".to_owned()),
        ("Cookie".to_owned(), "zpw_sek=x".to_owned()),
    ];
    let mut socket = proxy.ws_open(&format!("ws://127.0.0.1:{port}/rt"), &headers, &["chat".into()]).await.expect("open");
    assert_eq!(socket.protocol, "chat");

    socket.send_text("ping");
    socket.send_binary(&[1, 2, 3]);
    let mut next = async || tokio::time::timeout(Duration::from_secs(5), socket.next_event()).await.expect("event in time");
    assert_eq!(next().await, Some(WsEvent::Text("ping".into())));
    assert_eq!(next().await, Some(WsEvent::Binary(vec![1, 2, 3])));

    let upgrade = seen.lock().clone();
    let get = |name: &str| upgrade.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone());
    assert_eq!(get("user-agent").as_deref(), Some("ZaloPC-darwin-23v694"));
    assert_eq!(get("origin").as_deref(), Some("file://"));
    assert_eq!(get("cookie").as_deref(), Some("zpw_sek=x"));
    assert!(get("sec-websocket-extensions").is_some_and(|v| v.contains("permessage-deflate")), "{upgrade:?}");

    socket.close(1000);
}

#[tokio::test]
async fn websocket_server_close_is_reported() {
    let Some(proxy) = helper().await else { return };
    let (port, _) = local_ws_echo_server().await;
    let mut socket = proxy.ws_open(&format!("ws://127.0.0.1:{port}/rt"), &[], &[]).await.expect("open");
    assert_eq!(socket.protocol, "");
    socket.send_text("bye");
    let event = tokio::time::timeout(Duration::from_secs(5), socket.next_event()).await.unwrap();
    assert_eq!(event, Some(WsEvent::Closed { code: 4000, reason: "bye".into() }));
    assert_eq!(socket.next_event().await, None);
}

#[tokio::test]
async fn websocket_refused_upgrade_is_failed() {
    let Some(proxy) = helper().await else { return };
    let port = local_http_server(Arc::new(|_, _| (403, vec![], b"no".to_vec()))).await;
    let error = proxy.ws_open(&format!("ws://127.0.0.1:{port}/rt"), &[], &[]).await.err().expect("refused");
    let Error::Failed(message) = error else { panic!("{error:?}") };
    assert!(message.contains("403"), "{message}");
}

// ---- The real fingerprint (network) ----

/// One request through the helper to tls.peet.ws: the JA3 / JA4 / Akamai HTTP-2 fingerprint must be Chromium
/// 108's, as captured from the official client (`reanalysis/wire-fingerprint.md`).
#[tokio::test]
#[ignore = "network: https://tls.peet.ws"]
async fn peet_ws_fingerprint() {
    let proxy = FingerprintProxy::shared().ready(Duration::from_secs(10)).await.expect("helper ready");
    let mut headers = axios_headers();
    apply_client_headers(&mut headers);
    let headers = helper_request_headers(&headers, &fp::user_agent(fp::DEFAULT_CLIENT_VERSION), None);
    let response = proxy
        .perform("GET", "https://tls.peet.ws/api/clean", &headers, b"", Some(Duration::from_secs(30)))
        .await
        .expect("peet.ws response");
    assert_eq!(response.status, 200);
    let json: serde_json::Value = serde_json::from_slice(&response.body).expect("json body");
    println!("{}", serde_json::to_string_pretty(&json).unwrap());

    assert_eq!(
        json["ja3"],
        "771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,\
         0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513-21,29-23-24,0"
    );
    assert_eq!(json["ja4"], "t13d1516h2_8daaf6152771_e5627efa2ab1");
    assert_eq!(json["akamai"], "1:65536;2:0;3:1000;4:6291456;6:262144|15663105|0|m,a,s,p");
}
