// Settings › MCP › "Kết nối ứng dụng AI": the AI apps found on this Mac, each with a one-click button that writes Compola's
// MCP server into its config file (src-tauri/src/ai_clients.rs). Manual snippets stay available below.

import { ChevronDown, ChevronRight, Plug, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { backend, usesMock } from '../../engine/backend';
import { Spinner } from '../../ui/Spinner';
import { Row, Section } from './SettingsView';
import './ai-clients.css';

type Status = 'connected' | 'outdated' | 'notConnected' | 'error';

interface AiClient {
  id: string;
  name: string;
  detected: boolean;
  status: Status;
  configPath: string;
  apply: string;
  problem: string | null;
}

const call = async <T,>(command: string, args: Record<string, unknown>) => (await backend()).invoke<T>(command, args);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const statusText: Record<Status, string> = {
  connected: 'Đã kết nối',
  outdated: 'Cấu hình cũ — cổng hoặc mã truy cập đã đổi',
  notConnected: 'Chưa kết nối',
  error: 'Không đọc được tệp cấu hình',
};

export function AiClientsSection({
  endpoint,
  token,
  serverEnabled,
  onEnableServer,
  manual,
}: {
  endpoint: string;
  token: string;
  serverEnabled: boolean;
  onEnableServer: () => void;
  /** The copy-paste snippets, shown under "Cấu hình thủ công". */
  manual: ReactNode;
}) {
  const [clients, setClients] = useState<AiClient[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** Apps changed in this visit: show what to do next instead of the plain status. */
  const [justChanged, setJustChanged] = useState<Record<string, 'installed' | 'removed'>>({});
  const [showManual, setShowManual] = useState(usesMock);

  const scan = useCallback(() => {
    if (usesMock) return;
    setProblem(null);
    void call<AiClient[]>('ai_clients_detect', { endpoint, token })
      .then(setClients)
      .catch((e) => setProblem(errorText(e)));
  }, [endpoint, token]);

  useEffect(scan, [scan]);
  // Another app may have rewritten its config meanwhile (or the user installed one): rescan on focus.
  useEffect(() => {
    window.addEventListener('focus', scan);
    return () => window.removeEventListener('focus', scan);
  }, [scan]);

  const act = (client: AiClient, action: 'install' | 'remove') => {
    setBusy(client.id);
    setProblem(null);
    void call<AiClient>(`ai_clients_${action}`, { id: client.id, endpoint, token })
      .then((updated) => {
        setClients((cs) => cs?.map((c) => (c.id === updated.id ? updated : c)) ?? null);
        setJustChanged((j) => ({ ...j, [client.id]: action === 'install' ? 'installed' : 'removed' }));
      })
      .catch((e) => setProblem(`${client.name}: ${errorText(e)}`))
      .finally(() => setBusy(null));
  };

  const found = clients?.filter((c) => c.detected || c.status !== 'notConnected') ?? [];
  const missing = clients?.filter((c) => !found.includes(c)) ?? [];

  return (
    <>
      <Section
        title="Kết nối ứng dụng AI"
        footer={
          missing.length > 0 ? `Cũng hỗ trợ: ${missing.map((c) => c.name).join(', ')} — chưa thấy trên máy này.` : undefined
        }
      >
        {!serverEnabled && !usesMock && (
          <Row label="Máy chủ MCP đang tắt" detail="Ứng dụng AI chỉ dùng được Compola khi máy chủ đang bật.">
            <button className="st-button" onClick={onEnableServer}>
              Bật máy chủ
            </button>
          </Row>
        )}
        {usesMock && <Row label="Tự nhận ứng dụng AI" detail="Chỉ có khi chạy trong ứng dụng Compola (không có trong chế độ mock)." />}
        {!usesMock && clients === null && !problem && (
          <div className="st-aic-loading">
            <Spinner size={16} />
          </div>
        )}
        {clients !== null && found.length === 0 && (
          <Row
            label="Chưa thấy ứng dụng AI nào"
            detail="Cài Claude, Codex, Cursor… rồi bấm Quét lại, hoặc dùng cấu hình thủ công bên dưới."
          />
        )}
        {found.map((c) => (
          <ClientRow key={c.id} client={c} busy={busy === c.id} disabled={busy !== null} changed={justChanged[c.id]} onAct={(a) => act(c, a)} />
        ))}
        {!usesMock && (
          <div className="st-auto-footer-actions">
            <button className="st-button" onClick={scan} disabled={busy !== null}>
              <RefreshCw size={14} />
              Quét lại
            </button>
          </div>
        )}
      </Section>
      {problem && (
        <div className="st-auto-error" role="alert">
          {problem}
        </div>
      )}
      <div className="st-aic-manual">
        <button className="st-aic-disclosure" aria-expanded={showManual} onClick={() => setShowManual((s) => !s)}>
          {showManual ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          Cấu hình thủ công
        </button>
      </div>
      {showManual && <Section>{manual}</Section>}
    </>
  );
}

function ClientRow({
  client,
  busy,
  disabled,
  changed,
  onAct,
}: {
  client: AiClient;
  busy: boolean;
  disabled: boolean;
  changed?: 'installed' | 'removed';
  onAct: (action: 'install' | 'remove') => void;
}) {
  const { status } = client;
  const detail =
    status === 'error'
      ? client.problem ?? statusText.error
      : changed === 'installed' && status === 'connected'
        ? `Đã kết nối. ${client.apply}`
        : changed === 'removed' && status === 'notConnected'
          ? 'Đã gỡ khỏi cấu hình.'
          : statusText[status];
  return (
    <Row
      label={
        <span className="st-auto-title" title={client.configPath}>
          <span className={`st-dot ${status === 'connected' ? 'is-on' : status === 'error' || status === 'outdated' ? 'is-bad' : ''}`} />
          {client.name}
        </span>
      }
      detail={<span className={status === 'error' ? 'st-bad' : undefined}>{detail}</span>}
    >
      <div className="st-auto-actions">
        {busy && <Spinner size={14} />}
        {status === 'connected' ? (
          <button className="st-button" disabled={disabled} onClick={() => onAct('remove')}>
            Gỡ
          </button>
        ) : status === 'error' ? null : (
          <button className="st-button is-primary" disabled={disabled} onClick={() => onAct('install')}>
            <Plug size={14} />
            {status === 'outdated' ? 'Cập nhật' : 'Kết nối'}
          </button>
        )}
      </div>
    </Row>
  );
}
