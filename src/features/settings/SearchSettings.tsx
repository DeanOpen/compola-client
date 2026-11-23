// Settings › Nâng cao › Tìm kiếm: search the message index (keyword + semantic), its status, and the embeddings
// provider for semantic search / RAG. Backed by src/engine/search.ts (Rust src-tauri/src/automation/search.rs).

import { Search, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatTime } from '../../engine/automation';
import { usesMock } from '../../engine/backend';
import { openConversation } from '../../engine/chat';
import { embeddingPresets, messageSearch, type SearchConfig, type SearchResult, type SearchStatus } from '../../engine/search';
import { Highlight } from '../../ui/Highlight';
import { Alert } from '../../ui/Overlays';
import { Spinner } from '../../ui/Spinner';
import { closeSettings } from './hosts';
import { Row, Section, Segmented, Toggle } from './SettingsView';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const size = (bytes: number) => (bytes > 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export function SearchSettings() {
  const [status, setStatus] = useState<SearchStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    messageSearch
      .status()
      .then((s) => {
        setStatus(s);
        setError(null);
      })
      .catch((e) => setError(errorText(e)));
  useEffect(() => {
    void load();
    // Embeddings progress while the pane is open.
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, []);
  if (!status) {
    return error ? (
      <Section>
        <Row label="Không tải được tìm kiếm" detail={usesMock ? 'Chỉ có khi chạy trong ứng dụng Compola.' : error} />
      </Section>
    ) : (
      <div className="st-auto-loading">
        <Spinner size={18} />
      </div>
    );
  }
  return (
    <>
      <SearchBox status={status} />
      <IndexSection status={status} reload={load} />
      <SemanticSection status={status} reload={load} />
    </>
  );
}

function SearchBox({ status }: { status: SearchStatus }) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const run = () => {
    if (!query.trim()) return;
    setBusy(true);
    setProblem(null);
    void messageSearch
      .search(query, { limit: 30, context: 1 })
      .then(setResult)
      .catch((e) => setProblem(errorText(e)))
      .finally(() => setBusy(false));
  };
  const disabled = !status.config.enabled;
  return (
    <Section
      title="Tìm tin nhắn"
      footer="Không phân biệt dấu: “hop thu 6” tìm được “Họp thứ 6”. Khi bật tìm theo ý nghĩa, câu hỏi như “ai hẹn đi ăn tối?” cũng tìm được tin liên quan."
    >
      <div className="st-search-bar">
        <Search size={15} />
        <input
          className="st-input"
          value={query}
          disabled={disabled}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && run()}
          placeholder={disabled ? 'Đang tắt lập chỉ mục' : 'Tìm trong tin nhắn…'}
          autoFocus
          spellCheck={false}
        />
        <button className="st-button is-primary" disabled={busy || disabled || !query.trim()} onClick={run}>
          {busy ? <Spinner size={12} /> : 'Tìm'}
        </button>
      </div>
      {problem && <div className="st-auto-error">{problem}</div>}
      {result && (
        <div className="st-search-results">
          <div className="st-muted st-search-meta">
            {result.hits.length} kết quả · {result.mode === 'hybrid' ? 'từ khoá + ý nghĩa' : 'từ khoá'}
            {result.semanticError && ` · tìm theo ý nghĩa lỗi: ${result.semanticError}`}
          </div>
          {result.hits.map((h) => (
            <button
              key={h.id}
              className="st-search-hit"
              title="Mở hội thoại"
              onClick={() => {
                openConversation(h.conversationId);
                closeSettings();
              }}
            >
              <span className="st-search-hit-head">
                <strong className="truncate">{h.conversationName || h.conversationId}</strong>
                {h.matched !== 'keyword' && (
                  <span className="st-chip is-tool" title="Khớp theo ý nghĩa">
                    <Sparkles size={11} />
                  </span>
                )}
                <span className="st-muted">{formatTime(h.date)}</span>
              </span>
              <span className="st-search-hit-text">
                {h.senderName && <span className="st-muted">{h.fromMe ? 'Bạn' : h.senderName}: </span>}
                <Highlight text={h.text} query={query} />
              </span>
            </button>
          ))}
        </div>
      )}
    </Section>
  );
}

function IndexSection({ status, reload }: { status: SearchStatus; reload: () => void }) {
  const [confirmClear, setConfirmClear] = useState(false);
  const s = status.stats;
  const save = (patch: Partial<SearchConfig>) => void messageSearch.setConfig({ ...status.config, ...patch }).then(reload);
  return (
    <>
      <Section
        title="Chỉ mục"
        footer="Compola lập chỉ mục tin nhắn nó thấy: tin mới nhất của mọi hội thoại và lịch sử đã tải của các cuộc trò chuyện bạn mở. Chỉ mục nằm trên máy này và bị xoá khi đăng xuất."
      >
        <Row label="Lập chỉ mục tin nhắn" detail="Dùng cho ô tìm kiếm này, công cụ MCP search_messages và add-on.">
          <Toggle label="Lập chỉ mục tin nhắn" on={status.config.enabled} onChange={(enabled) => save({ enabled })} />
        </Row>
        {s && (
          <Row
            label="Đã lập chỉ mục"
            detail={`${s.messages.toLocaleString('vi-VN')} tin nhắn · ${s.conversations.toLocaleString('vi-VN')} hội thoại · ${size(s.bytes)}${s.oldest ? ` · từ ${formatTime(s.oldest)}` : ''}`}
          >
            <button className="st-button is-danger" onClick={() => setConfirmClear(true)}>
              Xoá chỉ mục
            </button>
          </Row>
        )}
      </Section>
      {confirmClear && (
        <Alert
          title="Xoá chỉ mục tìm kiếm?"
          message="Tin nhắn trong Zalo không bị ảnh hưởng. Chỉ mục sẽ được lập lại dần khi có tin nhắn mới."
          buttons={[
            { label: 'Huỷ', role: 'cancel', onClick: () => setConfirmClear(false) },
            {
              label: 'Xoá',
              role: 'destructive',
              onClick: () => {
                setConfirmClear(false);
                void messageSearch.clear().then(() => setTimeout(reload, 300));
              },
            },
          ]}
        />
      )}
    </>
  );
}

function SemanticSection({ status, reload }: { status: SearchStatus; reload: () => void }) {
  const [draft, setDraft] = useState<SearchConfig>(status.config);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const saved = status.config;
  const dirty = JSON.stringify({ ...draft, enabled: saved.enabled }) !== JSON.stringify(saved);
  const s = status.stats;
  const preset = embeddingPresets[draft.provider];
  const save = (next: SearchConfig) => {
    setBusy(true);
    setTest(null);
    void messageSearch
      .test(next)
      .then((dims) => {
        setTest({ ok: true, text: `Kết nối được · vector ${dims} chiều` });
        return messageSearch.setConfig(next);
      })
      .then(reload)
      .catch((e) => setTest({ ok: false, text: errorText(e) }))
      .finally(() => setBusy(false));
  };
  return (
    <Section
      title="Tìm theo ý nghĩa (RAG)"
      footer="Embeddings biến mỗi tin nhắn thành vector để tìm theo ý nghĩa và để ứng dụng AI (qua MCP) lấy đúng đoạn hội thoại khi trả lời câu hỏi."
    >
      <Row
        label="Bật tìm theo ý nghĩa"
        detail={
          saved.semantic && s
            ? `${s.embedded.toLocaleString('vi-VN')} / ${s.messages.toLocaleString('vi-VN')} tin đã có vector${s.embedModel ? ` (${s.embedModel})` : ''}${status.embedError ? ` · lỗi: ${status.embedError}` : ''}`
            : 'Cần một mô hình embeddings: Ollama trên máy hoặc một API.'
        }
      >
        <Toggle
          label="Bật tìm theo ý nghĩa"
          on={saved.semantic}
          onChange={(semantic) => (semantic ? save({ ...draft, enabled: saved.enabled, semantic }) : void messageSearch.setConfig({ ...saved, semantic }).then(reload))}
        />
      </Row>
      <div className="st-auto-editor is-flat st-search-provider">
        <div className="st-field">
          <span>Nhà cung cấp</span>
          <Segmented
            label="Nhà cung cấp"
            value={draft.provider}
            options={[
              { value: 'ollama', title: 'Ollama (trên máy)' },
              { value: 'openai', title: 'API tương thích OpenAI' },
            ]}
            onChange={(provider) => setDraft({ ...draft, provider, url: embeddingPresets[provider].url, model: embeddingPresets[provider].model })}
          />
          <span className="st-muted">{preset.note}</span>
        </div>
        <label className="st-field">
          <span>URL</span>
          <input className="st-input st-auto-mono" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} spellCheck={false} />
        </label>
        <label className="st-field">
          <span>Model</span>
          <input className="st-input st-auto-mono" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} spellCheck={false} />
        </label>
        {draft.provider === 'openai' && (
          <label className="st-field">
            <span>API key</span>
            <input className="st-input st-auto-mono" type="password" value={draft.apiKey} onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} spellCheck={false} />
          </label>
        )}
        {test && <div className={test.ok ? 'st-ok' : 'st-auto-error'}>{test.text}</div>}
        <div className="st-auto-actions is-end">
          {dirty && saved.model !== draft.model && saved.semantic && <span className="st-muted">Đổi model sẽ tính lại toàn bộ vector.</span>}
          <button className="st-button is-primary" disabled={busy || (!dirty && !!test?.ok)} onClick={() => save({ ...draft, enabled: saved.enabled, semantic: true })}>
            {busy && <Spinner size={12} />}
            Kiểm tra và lưu
          </button>
        </div>
      </div>
    </Section>
  );
}
