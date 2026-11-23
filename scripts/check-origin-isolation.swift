// Checks the multi-account storage isolation of docs/multi-account.md §2 in a headless WKWebView (no app launch):
// pages served by a `zalo-app` URL scheme handler from `zalo-app://local` and `zalo-app://a1b2c3d4e` must not see each
// other's localStorage, sessionStorage or IndexedDB, and each origin must see its own data again later.
//
//   swiftc -O scripts/check-origin-isolation.swift -o /tmp/check-origin-isolation && /tmp/check-origin-isolation
//
// Uses a non-persistent data store, so nothing is written to disk. Exit status 0 = isolated.
import Foundation
import WebKit

final class SchemeHandler: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let html = Data("<!doctype html><title>t</title>".utf8)
        let response = HTTPURLResponse(url: task.request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "text/html; charset=utf-8"])!
        task.didReceive(response)
        task.didReceive(html)
        task.didFinish()
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

final class Loader: NSObject, WKNavigationDelegate {
    var done: ((Error?) -> Void)?
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { done?(nil) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { done?(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { done?(error) }
}

let write = """
localStorage.setItem('who', origin);
sessionStorage.setItem('who', origin);
await new Promise((resolve, reject) => {
  const open = indexedDB.open('compola-check', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('kv');
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const tx = open.result.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(origin, 'who');
    tx.oncomplete = () => { open.result.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  };
});
return origin;
"""

let read = """
const idb = await new Promise((resolve) => {
  const open = indexedDB.open('compola-check', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('kv');
  open.onerror = () => resolve('error');
  open.onsuccess = () => {
    const tx = open.result.transaction('kv', 'readonly');
    const get = tx.objectStore('kv').get('who');
    get.onsuccess = () => { open.result.close(); resolve(get.result ?? null); };
    get.onerror = () => resolve('error');
  };
});
return JSON.stringify({ origin, local: localStorage.getItem('who'), idb });
"""

@MainActor
func run() async -> Int32 {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    config.setURLSchemeHandler(SchemeHandler(), forURLScheme: "zalo-app")
    let web = WKWebView(frame: .zero, configuration: config)
    let loader = Loader()
    web.navigationDelegate = loader

    func load(_ url: String) async throws {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            loader.done = { error in
                loader.done = nil
                if let error { c.resume(throwing: error) } else { c.resume() }
            }
            web.load(URLRequest(url: URL(string: url)!))
        }
    }
    func js(_ body: String) async throws -> String {
        let value = try await web.callAsyncJavaScript(body, arguments: [:], in: nil, contentWorld: .page)
        return "\(value ?? "nil")"
    }

    var failures = 0
    func expect(_ ok: Bool, _ what: String) {
        print((ok ? "ok   " : "FAIL ") + what)
        if !ok { failures += 1 }
    }
    do {
        try await load("zalo-app://local/index.html")
        let writtenOrigin = try await js(write)
        print("wrote as \(writtenOrigin)")

        try await load("zalo-app://a1b2c3d4e/index.html")
        let other = try await js(read)
        print("a1b2c3d4e sees \(other)")
        expect(other.contains("\"origin\":\"zalo-app://a1b2c3d4e\""), "second account has its own origin")
        expect(other.contains("\"local\":null"), "localStorage not shared with zalo-app://local")
        expect(other.contains("\"idb\":null"), "IndexedDB not shared with zalo-app://local")
        _ = try await js(write)

        try await load("zalo-app://local/other.html")
        let back = try await js(read)
        print("local sees \(back)")
        expect(back.contains("\"local\":\"zalo-app://local\""), "zalo-app://local keeps its localStorage")
        expect(back.contains("\"idb\":\"zalo-app://local\""), "zalo-app://local keeps its IndexedDB")
    } catch {
        print("FAIL \(error)")
        return 2
    }
    return failures == 0 ? 0 : 1
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
Task { @MainActor in
    let status = await run()
    exit(status)
}
app.run()
