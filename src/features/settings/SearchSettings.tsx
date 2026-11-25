// Settings › Nâng cao › Tìm kiếm: search the message index (keyword + semantic), its status, and the embeddings
// provider for semantic search / RAG. Backed by src/engine/search.ts (Rust src-tauri/src/automation/search.rs).

import { ChevronRight, Search, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatTime } from '../../engine/automation';
import { usesMock } from '../../engine/backend';
import { openExternal } from '../../engine/system';
import { openConversation } from '../../engine/chat';
import { embedProblem, embeddingPresets, messageSearch, type BuiltinStatus, type SearchConfig, type SearchResult, type SearchStatus } from '../../engine/search';
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

const mb = (bytes: number) => `${Math.round(bytes / 1e6).toLocaleString('vi-VN')} MB`;

/**
 * Tìm theo ý nghĩa. Default: the built-in model — one switch downloads it (with progress), checks it and turns semantic
 * search on; nothing to install or configure. Ollama and OpenAI-compatible APIs are under "Tuỳ chỉnh nâng cao".
 */
function SemanticSection({ status, reload }: { status: SearchStatus; reload: () => void }) {
  const saved = status.config;
  const [builtin, setBuiltin] = useState<BuiltinStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(saved.provider !== 'builtin');
  const s = status.stats;
  const isBuiltin = saved.provider === 'builtin';

  const refreshBuiltin = () => void messageSearch.builtinStatus().then(setBuiltin, () => {});
  useEffect(() => {
    refreshBuiltin();
  }, []);
  // Progress while the model downloads.
  const downloading = !!builtin?.downloading;
  useEffect(() => {
    if (!downloading && !busy) return;
    const t = setInterval(refreshBuiltin, 700);
    return () => clearInterval(t);
  }, [downloading, busy]);

  /** One click: download the built-in model if needed, check it, save. */
  const enable = async (config: SearchConfig = saved) => {
    setBusy(true);
    setProblem(null);
    try {
      const next: SearchConfig = { ...config, semantic: true };
      if (next.provider === 'builtin') {
        next.url = '';
        next.model = embeddingPresets.builtin.model;
        const st = await messageSearch.builtinStatus();
        if (!st.installed) await messageSearch.builtinInstall();
      }
      await messageSearch.test(next);
      await messageSearch.setConfig(next);
      reload();
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setBusy(false);
      refreshBuiltin();
    }
  };
  const disable = () => void messageSearch.setConfig({ ...saved, semantic: false }).then(reload);

  const progress = builtin && builtin.total > 0 ? builtin.received / builtin.total : 0;
  const detail = (() => {
    if (busy && downloading) return `Đang tải mô hình… ${mb(builtin?.received ?? 0)} / ${mb(builtin?.total ?? 0)}`;
    if (busy) return 'Đang chuẩn bị…';
    if (saved.semantic && s) {
      const err = status.embedError ? ` · lỗi: ${embedProblem(status.embedError).text}` : '';
      return `${s.embedded.toLocaleString('vi-VN')} / ${s.messages.toLocaleString('vi-VN')} tin đã được hiểu theo ý nghĩa${err}`;
    }
    return isBuiltin
      ? 'Tìm “ai hẹn đi ăn tối?” ra đúng tin nhắn dù không trùng chữ. Bật lên là xong: Compola tự tải mô hình (khoảng 490 MB, một lần) và chạy ngay trên máy này.'
      : `Dùng ${saved.provider === 'ollama' ? 'Ollama' : 'API'} · ${saved.model}`;
  })();

  return (
    <Section
      title="Tìm theo ý nghĩa (RAG)"
      footer="Mỗi tin nhắn được biến thành vector để tìm theo ý nghĩa, và để ứng dụng AI (qua MCP) hay add-on lấy đúng đoạn hội thoại khi trả lời câu hỏi. Với mô hình tích hợp, tin nhắn không rời máy này."
    >
      <Row label="Bật tìm theo ý nghĩa" detail={detail}>
        {busy ? <Spinner size={16} /> : <Toggle label="Bật tìm theo ý nghĩa" on={saved.semantic} onChange={(on) => (on ? void enable() : disable())} />}
      </Row>
      {busy && downloading && (
        <div className="st-auto-sub">
          <div className="st-progress" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div className="st-progress-bar" style={{ width: `${Math.max(2, progress * 100)}%` }} />
          </div>
        </div>
      )}
      {problem && (
        <div className="st-auto-sub">
          <div className="st-auto-error">{embedProblem(problem).text}</div>
          <div className="st-auto-actions is-end">
            <button className="st-button is-primary" onClick={() => void enable()}>
              Thử lại
            </button>
          </div>
        </div>
      )}
      {isBuiltin && builtin?.installed && !busy && (
        <Row label="Mô hình tích hợp" detail={`${builtin.model} · đã cài trên máy này · ${mb(builtin.total)}`}>
          <button
            className="st-button"
            title="Xoá tệp mô hình (tắt tìm theo ý nghĩa)"
            onClick={() => void messageSearch.setConfig({ ...saved, semantic: false }).then(() => messageSearch.builtinRemove()).then(() => (refreshBuiltin(), reload()))}
          >
            Xoá mô hình
          </button>
        </Row>
      )}
      <button className="st-row st-link-row st-search-link" onClick={() => setAdvanced((o) => !o)} aria-expanded={advanced}>
        <span className="st-row-text">
          <span className="st-row-label">Tuỳ chỉnh nâng cao</span>
          <span className="st-row-detail">Dùng Ollama hoặc một API embeddings thay cho mô hình tích hợp</span>
        </span>
        <ChevronRight size={16} className={`st-chevron ${advanced ? 'is-open' : ''}`} />
      </button>
      {advanced && <ProviderEditor status={status} reload={reload} onEnable={(c) => void enable(c)} busy={busy} />}
    </Section>
  );
}

function ProviderEditor({ status, reload, onEnable, busy }: { status: SearchStatus; reload: () => void; onEnable: (c: SearchConfig) => void; busy: boolean }) {
  const saved = status.config;
  const [draft, setDraft] = useState<SearchConfig>(saved);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [pulling, setPulling] = useState(false);
  useEffect(() => setDraft(saved), [JSON.stringify(saved)]);
  const dirty = JSON.stringify({ ...draft, enabled: saved.enabled, semantic: saved.semantic }) !== JSON.stringify(saved);
  const preset = embeddingPresets[draft.provider];
  const check = (next: SearchConfig) => {
    setChecking(true);
    setTest(null);
    void messageSearch
      .test(next)
      .then((dims) => {
        setTest({ ok: true, text: `Kết nối được · vector ${dims} chiều` });
        return messageSearch.setConfig(next);
      })
      .then(reload)
      .catch((e) => setTest({ ok: false, text: errorText(e) }))
      .finally(() => setChecking(false));
  };
  const problem = test && !test.ok ? embedProblem(test.text) : null;
  const pull = () => {
    const next = { ...draft, enabled: saved.enabled, semantic: true };
    setPulling(true);
    setTest(null);
    void messageSearch
      .pullModel(next)
      .then(() => check(next))
      .catch((e) => setTest({ ok: false, text: errorText(e) }))
      .finally(() => setPulling(false));
  };
  return (
    <div className="st-auto-sub st-search-advanced">
      <div className="st-field">
        <span>Nhà cung cấp</span>
        <Segmented
          label="Nhà cung cấp"
          value={draft.provider}
          options={[
            { value: 'builtin', title: 'Tích hợp (khuyên dùng)' },
            { value: 'ollama', title: 'Ollama' },
            { value: 'openai', title: 'API tương thích OpenAI' },
          ]}
          onChange={(provider) => {
            setTest(null);
            setDraft({ ...draft, provider, url: embeddingPresets[provider].url, model: embeddingPresets[provider].model });
          }}
        />
        <span className="st-muted">{preset.note}</span>
      </div>
      {draft.provider !== 'builtin' && (
        <>
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
        </>
      )}
      {test && <div className={test.ok ? 'st-ok' : 'st-auto-error'}>{problem ? problem.text : test.text}</div>}
      {problem?.kind === 'ollama-missing' && (
        <div className="st-auto-actions">
          <span className="st-muted">Chưa có Ollama trên máy. Dùng mô hình tích hợp thì không cần cài gì.</span>
          <button className="st-button" onClick={() => void openExternal('https://ollama.com/download')}>
            Tải Ollama
          </button>
        </div>
      )}
      {(problem?.kind === 'ollama-model' || pulling) && (
        <div className="st-auto-actions">
          <span className="st-muted">{pulling ? `Đang tải ${draft.model} vào Ollama…` : `Ollama chưa có ${draft.model}.`}</span>
          <button className="st-button is-primary" disabled={pulling} onClick={pull}>
            {pulling && <Spinner size={12} />}
            Tải model {draft.model}
          </button>
        </div>
      )}
      <div className="st-auto-actions is-end">
        {dirty && saved.model !== draft.model && saved.semantic && <span className="st-muted">Đổi mô hình sẽ tính lại toàn bộ vector.</span>}
        <button
          className="st-button is-primary"
          disabled={busy || checking || pulling || !dirty}
          onClick={() => (draft.provider === 'builtin' ? onEnable({ ...draft, enabled: saved.enabled }) : check({ ...draft, enabled: saved.enabled, semantic: true }))}
        >
          {checking && <Spinner size={12} />}
          {draft.provider === 'builtin' ? 'Dùng mô hình tích hợp' : 'Kiểm tra và lưu'}
        </button>
      </div>
    </div>
  );
}
