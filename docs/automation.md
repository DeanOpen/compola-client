# Automation: MCP, Cron schedules, Add-ons

Settings › Nâng cao › **MCP**, **Lịch tự động**, **Add-on**. Rust: `src-tauri/src/automation/`; UI: `src/engine/automation.ts`,
`src/engine/addons.ts`, `src/features/settings/AutomationSettings.tsx`. Config: `~/Library/Application Support/Compola/automation.json` (0600).

## MCP server (AI apps → Compola)
Streamable HTTP on `http://127.0.0.1:39217/mcp` (loopback only, `Authorization: Bearer <token>`, non-local `Origin` refused).
Off by default; sending is off by default (read-only).

    claude mcp add --transport http compola http://127.0.0.1:39217/mcp --header "Authorization: Bearer <token>"

Tools: `status`, `list_conversations`, `get_messages`, `list_schedules`, `preview_cron`; with "Cho phép gửi tin nhắn":
`send_message`; with "Cho phép quản lý lịch": `create_schedule`, `update_schedule`, `delete_schedule`, `run_schedule`;
with "Chia sẻ công cụ MCP bên ngoài": `list_external_tools`, `call_external_tool`; plus `addon_<id>__<tool>` for tools that
enabled add-ons register. Messages come from what the renderer posts: every conversation's latest message since launch,
and the full loaded history of chats opened in the app (nothing extra is fetched from Zalo).

## MCP client (Compola → other MCP servers)
stdio (spawned with the login-shell `PATH`, so `npx`/`uvx` work from a Finder launch) or Streamable HTTP (JSON or SSE answers,
`Mcp-Session-Id`). Used by schedules (`mcpTool` action), add-ons (`compola.mcp.*`) and optionally re-exposed by the server.

## Cron
5 fields `minute hour day month weekday`, local time: `*`, `a-b`, `*/n`, `a-b/n`, lists, `jan..dec`, `sun..sat` (7 = Sunday),
`@hourly @daily @weekly @monthly @yearly`; day-of-month and day-of-week OR when both are set. One-time jobs use `at`.
Actions: send a message (`{{date}} {{time}} {{weekday}} {{datetime}}` filled in), call an MCP tool, or wake an add-on.
Jobs run while Compola is open; missed runs are not replayed.

## Add-ons
`addons/<id>/manifest.json` + `main.js` (or one `.js` with a `/* @compola-addon {…manifest…} */` comment). Each runs in its own Web
Worker with a `compola` global — see the "Viết add-on" example in Settings and `src-tauri/addons/*` (built-ins, installed
disabled): **Trả lời tự động**, **Cảnh báo từ khoá**, **Tóm tắt hằng ngày**. Permissions: `messages:read`, `messages:send`,
`schedules`, `mcp`, `network`, `notifications`. Without `network`, fetch/XHR/WebSocket/importScripts are removed (best effort,
not a sandbox: install only add-ons you trust).

## Search / RAG
The conversation list's search field (⌘F) lists matching conversations, then **Tin nhắn**: message hits from the index
(hybrid when semantic search is on, ✦ marks a hit found by meaning only); a hit opens its chat at the message and keeps the
search. "Tìm kiếm tin nhắn" in the chat header (⇧⌘F) limits the search to that conversation (a chip in the field; Esc or
⌫ on empty text drops it). Hidden chats' messages show only after their PIN, like their rows (`MessageSearchResults.tsx`).
Also: Settings › Nâng cao › **Tìm kiếm**; MCP tool `search_messages`; add-ons `compola.search(query, {conversationId, limit, context})`.
Index: `~/Library/Application Support/Compola/search.db` (0600), cleared on sign-out. It holds what Compola sees — every
conversation's latest message plus the loaded history of opened chats — so coverage grows as you use the app.
- Keyword: FTS5 on accent-folded text (`hop` finds `Họp`, `dinh` finds `Đinh`), BM25, all words then any word.
- Semantic (opt-in): embeddings via Ollama (`ollama pull bge-m3`, local) or any OpenAI-compatible `/embeddings` API,
  computed in the background; cosine similarity, merged with keyword hits by reciprocal-rank fusion. Each hit can carry
  the surrounding messages, which is what an AI client needs to answer from.

## SQLite
Fresh installs use the native SQLite backend; an install that already has IndexedDB data stays on it until
Settings › Engine › "Chuyển sang SQLite…" (signs out; history re-syncs from the phone). The SQLite host now caches
prepared statements (the DAL repeats the same queries) and opens each database with a 32 MB page cache and a 256 MB mmap.
