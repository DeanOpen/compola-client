// Settings › Nâng cao: MCP (Compola's own MCP server + external MCP servers), Lịch tự động (cron / one-time schedules)
// and Add-on. Backed by src/engine/automation.ts (Rust src-tauri/src/automation).

import { CalendarClock, Check, ChevronDown, ChevronRight, Copy, Play, Plus, Puzzle, RefreshCw, Trash2, Wrench } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAddonLogs } from '../../engine/addons';
import {
  addonSettings,
  automation,
  cronPresets,
  describeSchedule,
  formatTime,
  permissionTitles,
  refreshAutomation,
  useAutomation,
  type Addon,
  type AddonSetting,
  type Job,
  type McpClientConfig,
  type McpServerConfig,
  type McpTool,
} from '../../engine/automation';
import { usesMock } from '../../engine/backend';
import { useEngine, visibleConversations } from '../../engine/store';
import { Alert } from '../../ui/Overlays';
import { Spinner } from '../../ui/Spinner';
import { Row, Section, Segmented, Toggle } from './SettingsView';
import { AiClientsSection } from './AiClientsSection';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Loads the automation state once the pane opens; shows why it is unavailable otherwise. */
function useAutomationState() {
  const { state, error } = useAutomation();
  useEffect(() => {
    void refreshAutomation();
  }, []);
  return { state, error };
}

function Unavailable({ error }: { error: string | null }) {
  if (!error) return <div className="st-auto-loading"><Spinner size={18} /></div>;
  return (
    <Section>
      <Row label="Không tải được cài đặt nâng cao" detail={usesMock ? 'Chỉ có khi chạy trong ứng dụng Compola (không có trong chế độ mock).' : error} />
    </Section>
  );
}

function CopyButton({ text, label = 'Sao chép' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="st-button"
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        })
      }
    >
      {done ? <Check size={14} /> : <Copy size={14} />}
      {done ? 'Đã chép' : label}
    </button>
  );
}

function Problem({ text }: { text: string | null }) {
  return text ? <div className="st-auto-error" role="alert">{text}</div> : null;
}

/** A conversation picker over the conversation list the UI already has. */
function ConversationSelect({ value, onChange, allowEmpty = false }: { value: string; onChange: (id: string, name: string) => void; allowEmpty?: boolean }) {
  const conversations = useEngine(visibleConversations);
  const known = conversations.some((c) => c.id === value);
  return (
    <select className="st-input" value={value} onChange={(e) => onChange(e.target.value, conversations.find((c) => c.id === e.target.value)?.name ?? '')}>
      {(allowEmpty || !value) && <option value="">{allowEmpty ? '— Không —' : 'Chọn hội thoại…'}</option>}
      {value && !known && <option value={value}>{value}</option>}
      {conversations.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name || c.id}
          {c.isGroup ? ' (nhóm)' : ''}
        </option>
      ))}
    </select>
  );
}

// MARK: - MCP

export function McpSettings() {
  const { state, error } = useAutomationState();
  if (!state) return <Unavailable error={error} />;
  return (
    <>
      <McpServerSection config={state.server.config} running={state.server.running} url={state.server.url} serverError={state.server.error} />
      <McpClientsSection clients={state.clients} connected={state.connected} />
    </>
  );
}

function McpServerSection({ config, running, url, serverError }: { config: McpServerConfig; running: boolean; url: string | null; serverError: string | null }) {
  const [port, setPort] = useState(String(config.port));
  const [problem, setProblem] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);
  useEffect(() => setPort(String(config.port)), [config.port]);

  const save = (patch: Partial<McpServerConfig>) => {
    setProblem(null);
    void automation
      .setServer({ ...config, ...patch })
      .then(refreshAutomation)
      .catch((e) => setProblem(errorText(e)));
  };
  const endpoint = url ?? `http://127.0.0.1:${config.port}/mcp`;
  const claudeCode = `claude mcp add --transport http compola ${endpoint} --header "Authorization: Bearer ${config.token}"`;
  const jsonConfig = JSON.stringify(
    { mcpServers: { compola: { command: 'npx', args: ['-y', 'mcp-remote', endpoint, '--header', `Authorization: Bearer ${config.token}`] } } },
    null,
    2,
  );

  return (
    <>
      <Section
        title="Máy chủ MCP của Compola"
        footer="Cho Claude, Cursor và các ứng dụng AI khác dùng tài khoản Zalo này qua giao thức MCP. Máy chủ chỉ nhận kết nối từ máy này và cần mã truy cập."
      >
        <Row label="Bật máy chủ MCP" detail={running ? `Đang chạy · ${endpoint}` : serverError ? `Lỗi: ${serverError}` : 'Đang tắt'}>
          <Toggle label="Bật máy chủ MCP" on={config.enabled} onChange={(enabled) => save({ enabled })} />
        </Row>
        <Row label="Cổng" detail="Từ 1024 đến 65535. Đổi cổng sẽ khởi động lại máy chủ.">
          <input
            className="st-input is-narrow nums"
            inputMode="numeric"
            value={port}
            onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
            onBlur={() => {
              const n = Number(port);
              if (n !== config.port) {
                if (n >= 1024 && n <= 65535) save({ port: n });
                else {
                  setProblem('Cổng phải từ 1024 đến 65535');
                  setPort(String(config.port));
                }
              }
            }}
          />
        </Row>
        <Row label="Mã truy cập (Bearer token)" detail={<code className="st-code selectable">{showToken ? config.token : `${config.token.slice(0, 6)}••••••••••••`}</code>}>
          <div className="st-auto-actions">
            <button className="st-button" onClick={() => setShowToken((s) => !s)}>
              {showToken ? 'Ẩn' : 'Hiện'}
            </button>
            <CopyButton text={config.token} />
            <button
              className="st-button"
              title="Tạo mã mới — các ứng dụng đang dùng mã cũ sẽ mất kết nối"
              onClick={() => void automation.regenerateToken().then(refreshAutomation).catch((e) => setProblem(errorText(e)))}
            >
              <RefreshCw size={14} />
              Tạo mới
            </button>
          </div>
        </Row>
        <Row label="Cho phép gửi tin nhắn" detail="Công cụ send_message và lịch gửi tin. Tắt = MCP chỉ đọc.">
          <Toggle label="Cho phép gửi tin nhắn" on={config.allowSend} onChange={(allowSend) => save({ allowSend })} />
        </Row>
        <Row label="Cho phép quản lý lịch" detail="Tạo, sửa, xoá và chạy lịch tự động qua MCP.">
          <Toggle label="Cho phép quản lý lịch" on={config.allowSchedules} onChange={(allowSchedules) => save({ allowSchedules })} />
        </Row>
        <Row label="Chia sẻ công cụ MCP bên ngoài" detail="Cho ứng dụng AI gọi công cụ của các máy chủ MCP bên dưới qua Compola.">
          <Toggle label="Chia sẻ công cụ MCP bên ngoài" on={config.exposeExternal} onChange={(exposeExternal) => save({ exposeExternal })} />
        </Row>
      </Section>
      <Problem text={problem} />
      <AiClientsSection
        endpoint={endpoint}
        token={config.token}
        serverEnabled={config.enabled}
        onEnableServer={() => save({ enabled: true })}
        manual={
          <>
            <Row column label="Claude Code" detail="Chạy lệnh này trong Terminal.">
              <pre className="st-snippet selectable">{claudeCode}</pre>
              <CopyButton text={claudeCode} label="Sao chép lệnh" />
            </Row>
            <Row column label="Claude Desktop, Cursor, Windsurf…" detail="Thêm vào tệp cấu hình MCP (cần Node.js cho mcp-remote).">
              <pre className="st-snippet selectable">{jsonConfig}</pre>
              <CopyButton text={jsonConfig} label="Sao chép cấu hình" />
            </Row>
          </>
        }
      />
    </>
  );
}

const emptyClient = (): McpClientConfig => ({ id: '', name: '', transport: 'stdio', command: '', args: [], env: {}, url: '', headers: {}, enabled: true });

/** `a "b c" d` → ['a', 'b c', 'd']. */
const splitArgs = (line: string): string[] => [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
const joinArgs = (args: string[]) => args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
const parsePairs = (text: string, sep: string): Record<string, string> =>
  Object.fromEntries(
    text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf(sep);
        return i < 0 ? [l, ''] : [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
  );
const showPairs = (pairs: Record<string, string>, sep: string) =>
  Object.entries(pairs)
    .map(([k, v]) => `${k}${sep}${sep === ':' ? ' ' : ''}${v}`)
    .join('\n');

function McpClientsSection({ clients, connected }: { clients: McpClientConfig[]; connected: string[] }) {
  const [editing, setEditing] = useState<McpClientConfig | null>(null);
  const [deleting, setDeleting] = useState<McpClientConfig | null>(null);
  return (
    <>
      <Section
        title="Máy chủ MCP bên ngoài"
        footer="Compola kết nối tới các máy chủ này như một ứng dụng MCP: lịch tự động và add-on có thể gọi công cụ của chúng."
      >
        {clients.length === 0 && !editing && <Row label="Chưa có máy chủ nào" detail="Ví dụ: npx -y @modelcontextprotocol/server-filesystem ~/Documents" />}
        {clients.map((c) =>
          editing?.id === c.id ? null : (
            <McpClientRow key={c.id} client={c} connected={connected.includes(c.id)} onEdit={() => setEditing(c)} onDelete={() => setDeleting(c)} />
          ),
        )}
        {editing ? (
          <McpClientEditor initial={editing} onDone={() => setEditing(null)} />
        ) : (
          <div className="st-auto-footer-actions">
            <button className="st-button" onClick={() => setEditing(emptyClient())}>
              <Plus size={14} />
              Thêm máy chủ MCP
            </button>
          </div>
        )}
      </Section>
      {deleting && (
        <Alert
          title={`Xoá máy chủ “${deleting.name}”?`}
          message="Các lịch đang dùng máy chủ này sẽ chạy lỗi cho đến khi bạn sửa chúng."
          buttons={[
            { label: 'Huỷ', role: 'cancel', onClick: () => setDeleting(null) },
            {
              label: 'Xoá',
              role: 'destructive',
              onClick: () => {
                const id = deleting.id;
                setDeleting(null);
                void automation.deleteClient(id).then(refreshAutomation);
              },
            },
          ]}
        />
      )}
    </>
  );
}

function McpClientRow({ client, connected, onEdit, onDelete }: { client: McpClientConfig; connected: boolean; onEdit: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const [tools, setTools] = useState<McpTool[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const load = () => {
    setLoading(true);
    setProblem(null);
    void automation
      .clientTools(client.id)
      .then((r) => setTools(r.tools))
      .catch((e) => setProblem(errorText(e)))
      .finally(() => setLoading(false));
  };
  const target = client.transport === 'stdio' ? `${client.command} ${joinArgs(client.args)}` : client.url;
  return (
    <div className="st-auto-item">
      <Row
        label={
          <span className="st-auto-title">
            <span className={`st-dot ${connected ? 'is-on' : ''}`} title={connected ? 'Đã kết nối' : 'Chưa kết nối'} />
            {client.name}
            <span className="st-chip">{client.transport === 'stdio' ? 'stdio' : 'HTTP'}</span>
          </span>
        }
        detail={<span className="st-auto-mono truncate">{target}</span>}
      >
        <div className="st-auto-actions">
          <Toggle
            label="Bật"
            on={client.enabled}
            onChange={(enabled) => void automation.saveClient({ ...client, enabled }).then(refreshAutomation)}
          />
          <button
            className="st-button"
            onClick={() => {
              setOpen((o) => !o);
              if (!tools && !open) load();
            }}
          >
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            Công cụ
          </button>
          <button className="st-button" onClick={onEdit}>
            Sửa
          </button>
          <button className="st-icon-button" title="Xoá" aria-label="Xoá" onClick={onDelete}>
            <Trash2 size={15} />
          </button>
        </div>
      </Row>
      {open && (
        <div className="st-auto-sub">
          {loading && <Spinner size={16} />}
          <Problem text={problem} />
          {tools && tools.length === 0 && <div className="st-muted">Máy chủ không có công cụ nào.</div>}
          {tools?.map((t) => <McpToolRow key={t.name} serverId={client.id} tool={t} />)}
          {!loading && (
            <button className="st-link" onClick={load}>
              Tải lại
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function McpToolRow({ serverId, tool }: { serverId: string; tool: McpTool }) {
  const [trying, setTrying] = useState(false);
  const [args, setArgs] = useState('{}');
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const params = Object.keys(tool.inputSchema?.properties ?? {});
  const run = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(args || '{}');
    } catch {
      setResult('Tham số phải là JSON hợp lệ');
      return;
    }
    setBusy(true);
    void automation
      .clientCall(serverId, tool.name, parsed)
      .then((r) => setResult(JSON.stringify(r, null, 2)))
      .catch((e) => setResult(errorText(e)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="st-auto-tool">
      <div className="st-auto-tool-head">
        <Wrench size={13} />
        <code>{tool.name}</code>
        {params.length > 0 && <span className="st-muted">({params.join(', ')})</span>}
        <button
          className="st-link"
          onClick={() => {
            setTrying((t) => !t);
            if (!trying) setArgs(JSON.stringify(Object.fromEntries(params.map((p) => [p, ''])), null, 1));
          }}
        >
          Thử
        </button>
      </div>
      {tool.description && <div className="st-row-detail">{tool.description}</div>}
      {trying && (
        <div className="st-auto-try">
          <textarea className="st-input st-auto-mono" rows={3} value={args} onChange={(e) => setArgs(e.target.value)} spellCheck={false} />
          <button className="st-button is-primary" disabled={busy} onClick={run}>
            <Play size={13} />
            Gọi
          </button>
          {result && <pre className="st-snippet selectable">{result}</pre>}
        </div>
      )}
    </div>
  );
}

function McpClientEditor({ initial, onDone }: { initial: McpClientConfig; onDone: () => void }) {
  const [draft, setDraft] = useState(initial);
  const [args, setArgs] = useState(joinArgs(initial.args));
  const [env, setEnv] = useState(showPairs(initial.env, '='));
  const [headers, setHeaders] = useState(showPairs(initial.headers, ':'));
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = () => {
    setBusy(true);
    setProblem(null);
    const client: McpClientConfig = { ...draft, args: splitArgs(args), env: parsePairs(env, '='), headers: parsePairs(headers, ':') };
    void automation
      .saveClient(client)
      // Try it right away so a wrong command shows up here.
      .then((saved) => automation.clientTools(saved.id).then(() => saved))
      .then(() => {
        void refreshAutomation();
        onDone();
      })
      .catch((e) => {
        setProblem(`Đã lưu, nhưng chưa kết nối được: ${errorText(e)}`);
        void refreshAutomation();
      })
      .finally(() => setBusy(false));
  };
  return (
    <div className="st-auto-editor">
      <label className="st-field">
        <span>Tên</span>
        <input className="st-input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Ví dụ: Tệp tài liệu" autoFocus />
      </label>
      <div className="st-field">
        <span>Kiểu kết nối</span>
        <Segmented
          label="Kiểu kết nối"
          value={draft.transport}
          options={[
            { value: 'stdio', title: 'Chạy lệnh (stdio)' },
            { value: 'http', title: 'URL (HTTP)' },
          ]}
          onChange={(transport) => setDraft({ ...draft, transport })}
        />
      </div>
      {draft.transport === 'stdio' ? (
        <>
          <label className="st-field">
            <span>Lệnh</span>
            <input className="st-input st-auto-mono" value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} placeholder="npx" spellCheck={false} />
          </label>
          <label className="st-field">
            <span>Tham số</span>
            <input className="st-input st-auto-mono" value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y @modelcontextprotocol/server-filesystem ~/Documents" spellCheck={false} />
          </label>
          <label className="st-field">
            <span>Biến môi trường (KEY=VALUE mỗi dòng)</span>
            <textarea className="st-input st-auto-mono" rows={2} value={env} onChange={(e) => setEnv(e.target.value)} spellCheck={false} />
          </label>
        </>
      ) : (
        <>
          <label className="st-field">
            <span>URL</span>
            <input className="st-input st-auto-mono" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder="https://example.com/mcp" spellCheck={false} />
          </label>
          <label className="st-field">
            <span>Header (Tên: giá trị mỗi dòng)</span>
            <textarea className="st-input st-auto-mono" rows={2} value={headers} onChange={(e) => setHeaders(e.target.value)} placeholder="Authorization: Bearer …" spellCheck={false} />
          </label>
        </>
      )}
      <Problem text={problem} />
      <div className="st-auto-actions is-end">
        <button className="st-button" onClick={onDone}>
          {problem ? 'Đóng' : 'Huỷ'}
        </button>
        <button className="st-button is-primary" disabled={busy || !draft.name.trim()} onClick={save}>
          {busy && <Spinner size={12} />}
          Lưu và kết nối
        </button>
      </div>
    </div>
  );
}

// MARK: - Lịch tự động

export function ScheduleSettings() {
  const { state, error } = useAutomationState();
  const [editing, setEditing] = useState<Job | null>(null);
  const [deleting, setDeleting] = useState<Job | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  if (!state) return <Unavailable error={error} />;
  const addonName = (id: string) => state.addons.find((a) => a.manifest.id === id)?.manifest.name ?? id;
  const serverName = (id: string) => state.clients.find((c) => c.id === id)?.name ?? 'máy chủ đã xoá';
  const actionText = (j: Job) =>
    j.action.kind === 'sendText'
      ? `Gửi tới ${j.action.conversationName || j.action.conversationId}: “${j.action.text.slice(0, 60)}${j.action.text.length > 60 ? '…' : ''}”`
      : j.action.kind === 'mcpTool'
        ? `Gọi ${j.action.tool} trên ${serverName(j.action.serverId)}`
        : `Add-on ${addonName(j.action.addonId)}`;
  return (
    <>
      <Section
        title="Lịch"
        footer="Lịch chạy khi Compola đang mở. Biểu thức cron theo giờ máy: phút giờ ngày tháng thứ. Nội dung tin nhắn có thể dùng {{date}}, {{time}}, {{weekday}}."
      >
        {state.jobs.length === 0 && !editing && <Row label="Chưa có lịch nào" detail="Tạo lịch để tự gửi tin nhắn, gọi công cụ MCP hoặc chạy add-on." />}
        {state.jobs.map((j) =>
          editing?.id === j.id ? (
            <JobEditor key={j.id} initial={j} onDone={() => setEditing(null)} />
          ) : (
            <div className="st-auto-item" key={j.id}>
              <Row
                label={
                  <span className="st-auto-title">
                    {j.name}
                    {j.createdBy && j.createdBy !== 'ui' && <span className="st-chip">{j.createdBy === 'mcp' ? 'MCP' : 'add-on'}</span>}
                  </span>
                }
                detail={
                  <>
                    <span>{actionText(j)}</span>
                    <br />
                    <span className="st-auto-mono">{describeSchedule(j.schedule)}</span>
                    {state.nextDue[j.id] && <span> · lần tới {formatTime(state.nextDue[j.id])}</span>}
                    {j.lastRun && (
                      <span className={j.lastOk ? 'st-ok' : 'st-bad'}>
                        {' '}
                        · lần trước {formatTime(j.lastRun)}: {j.lastStatus}
                      </span>
                    )}
                  </>
                }
              >
                <div className="st-auto-actions">
                  <Toggle label="Bật" on={j.enabled} onChange={(enabled) => void automation.saveJob({ ...j, enabled }).then(refreshAutomation).catch((e) => setProblem(errorText(e)))} />
                  <button
                    className="st-icon-button"
                    title="Chạy ngay"
                    aria-label="Chạy ngay"
                    onClick={() =>
                      void automation
                        .runJob(j.id)
                        .then((r) => setProblem(r.ok ? null : `${j.name}: ${r.status}`))
                        .then(refreshAutomation)
                        .catch((e) => setProblem(errorText(e)))
                    }
                  >
                    <Play size={15} />
                  </button>
                  {j.action.kind !== 'addon' && (
                    <button className="st-button" onClick={() => setEditing(j)}>
                      Sửa
                    </button>
                  )}
                  <button className="st-icon-button" title="Xoá" aria-label="Xoá" onClick={() => setDeleting(j)}>
                    <Trash2 size={15} />
                  </button>
                </div>
              </Row>
            </div>
          ),
        )}
        {editing && !editing.id && <JobEditor initial={editing} onDone={() => setEditing(null)} />}
        {!editing && (
          <div className="st-auto-footer-actions">
            <button className="st-button" onClick={() => setEditing(newJob())}>
              <Plus size={14} />
              Tạo lịch
            </button>
          </div>
        )}
      </Section>
      <Problem text={problem} />
      {state.runs.length > 0 && (
        <Section title="Lần chạy gần đây">
          {state.runs.slice(0, 15).map((r, i) => (
            <Row
              key={`${r.at}-${i}`}
              label={
                <span className="st-auto-title">
                  <span className={`st-dot ${r.ok ? 'is-on' : 'is-bad'}`} />
                  {r.jobName}
                </span>
              }
              detail={`${formatTime(r.at)}${r.trigger === 'manual' ? ' (chạy tay)' : ''} · ${r.status}`}
            />
          ))}
        </Section>
      )}
      {deleting && (
        <Alert
          title={`Xoá lịch “${deleting.name}”?`}
          buttons={[
            { label: 'Huỷ', role: 'cancel', onClick: () => setDeleting(null) },
            {
              label: 'Xoá',
              role: 'destructive',
              onClick: () => {
                const id = deleting.id;
                setDeleting(null);
                void automation.deleteJob(id).then(refreshAutomation);
              },
            },
          ]}
        />
      )}
    </>
  );
}

const newJob = (): Job => ({
  id: '',
  name: '',
  enabled: true,
  schedule: { kind: 'cron', expr: '0 8 * * mon-fri' },
  action: { kind: 'sendText', conversationId: '', conversationName: '', text: '' },
  createdBy: 'ui',
  lastRun: null,
  lastStatus: null,
  lastOk: null,
});

/** `datetime-local` value ↔ Unix ms (local time). */
const toLocalInput = (ms: number) => {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
};

function CronField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [preview, setPreview] = useState<{ times: number[] } | { error: string } | null>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      void automation
        .cronPreview(value, 3)
        .then((times) => setPreview({ times }))
        .catch((e) => setPreview({ error: errorText(e) }));
    }, 250);
    return () => clearTimeout(t);
  }, [value]);
  return (
    <div className="st-field">
      <span>Biểu thức cron</span>
      <input className="st-input st-auto-mono" value={value} onChange={(e) => onChange(e.target.value)} placeholder="0 8 * * mon-fri" spellCheck={false} />
      <div className="st-auto-chips">
        {cronPresets.map((p) => (
          <button key={p.expr} className={`st-chip is-button ${p.expr === value ? 'is-selected' : ''}`} onClick={() => onChange(p.expr)}>
            {p.title}
          </button>
        ))}
      </div>
      {preview && 'error' in preview && <div className="st-bad">{preview.error}</div>}
      {preview && 'times' in preview && <div className="st-muted">Lần chạy tới: {preview.times.map((t) => formatTime(t)).join(' · ')}</div>}
    </div>
  );
}

function JobEditor({ initial, onDone }: { initial: Job; onDone: () => void }) {
  const clients = useAutomation((s) => s.state?.clients ?? []);
  const [job, setJob] = useState<Job>(initial);
  const [tools, setTools] = useState<McpTool[]>([]);
  const [argsText, setArgsText] = useState(initial.action.kind === 'mcpTool' ? JSON.stringify(initial.action.arguments ?? {}, null, 1) : '{}');
  const [problem, setProblem] = useState<string | null>(null);
  const serverId = job.action.kind === 'mcpTool' ? job.action.serverId : '';
  useEffect(() => {
    if (!serverId) return setTools([]);
    void automation
      .clientTools(serverId)
      .then((r) => setTools(r.tools))
      .catch((e) => setProblem(errorText(e)));
  }, [serverId]);

  const setAction = (kind: 'sendText' | 'mcpTool') =>
    setJob({
      ...job,
      action:
        kind === 'sendText'
          ? { kind, conversationId: '', conversationName: '', text: '' }
          : { kind, serverId: clients.find((c) => c.enabled)?.id ?? '', tool: '', arguments: {} },
    });

  const save = () => {
    let next = job;
    if (job.action.kind === 'mcpTool') {
      try {
        next = { ...job, action: { ...job.action, arguments: JSON.parse(argsText || '{}') } };
      } catch {
        return setProblem('Tham số công cụ phải là JSON hợp lệ');
      }
    }
    void automation
      .saveJob(next)
      .then(() => {
        void refreshAutomation();
        onDone();
      })
      .catch((e) => setProblem(errorText(e)));
  };

  return (
    <div className="st-auto-editor">
      <label className="st-field">
        <span>Tên (tuỳ chọn)</span>
        <input className="st-input" value={job.name} onChange={(e) => setJob({ ...job, name: e.target.value })} placeholder="Ví dụ: Chào buổi sáng nhóm" />
      </label>
      <div className="st-field">
        <span>Khi nào</span>
        <Segmented
          label="Khi nào"
          value={job.schedule.kind}
          options={[
            { value: 'cron', title: 'Lặp lại (cron)' },
            { value: 'once', title: 'Một lần' },
          ]}
          onChange={(kind) =>
            setJob({ ...job, schedule: kind === 'cron' ? { kind, expr: '0 8 * * *' } : { kind, at: Date.now() + 3600000 - (Date.now() % 60000) } })
          }
        />
      </div>
      {job.schedule.kind === 'cron' ? (
        <CronField value={job.schedule.expr} onChange={(expr) => setJob({ ...job, schedule: { kind: 'cron', expr } })} />
      ) : (
        <label className="st-field">
          <span>Thời điểm</span>
          <input
            className="st-input is-narrow"
            type="datetime-local"
            value={toLocalInput(job.schedule.at)}
            onChange={(e) => {
              const at = new Date(e.target.value).getTime();
              if (Number.isFinite(at)) setJob({ ...job, schedule: { kind: 'once', at } });
            }}
          />
        </label>
      )}
      {job.action.kind !== 'addon' && (
        <div className="st-field">
          <span>Làm gì</span>
          <Segmented
            label="Làm gì"
            value={job.action.kind}
            options={[
              { value: 'sendText', title: 'Gửi tin nhắn' },
              { value: 'mcpTool', title: 'Gọi công cụ MCP' },
            ]}
            onChange={setAction}
          />
        </div>
      )}
      {job.action.kind === 'sendText' && (
        <>
          <label className="st-field">
            <span>Hội thoại</span>
            <ConversationSelect
              value={job.action.conversationId}
              onChange={(conversationId, conversationName) => job.action.kind === 'sendText' && setJob({ ...job, action: { ...job.action, conversationId, conversationName } })}
            />
          </label>
          <label className="st-field">
            <span>Nội dung</span>
            <textarea
              className="st-input"
              rows={3}
              value={job.action.text}
              onChange={(e) => job.action.kind === 'sendText' && setJob({ ...job, action: { ...job.action, text: e.target.value } })}
              placeholder="Chào buổi sáng! Hôm nay {{weekday}}, {{date}}."
            />
          </label>
        </>
      )}
      {job.action.kind === 'mcpTool' &&
        (clients.length === 0 ? (
          <div className="st-muted">Chưa có máy chủ MCP nào. Thêm trong Cài đặt › MCP.</div>
        ) : (
          <>
            <label className="st-field">
              <span>Máy chủ MCP</span>
              <select
                className="st-input"
                value={job.action.serverId}
                onChange={(e) => job.action.kind === 'mcpTool' && setJob({ ...job, action: { ...job.action, serverId: e.target.value, tool: '' } })}
              >
                <option value="">Chọn máy chủ…</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id} disabled={!c.enabled}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="st-field">
              <span>Công cụ</span>
              <select
                className="st-input"
                value={job.action.tool}
                onChange={(e) => {
                  if (job.action.kind !== 'mcpTool') return;
                  setJob({ ...job, action: { ...job.action, tool: e.target.value } });
                  const props = Object.keys(tools.find((t) => t.name === e.target.value)?.inputSchema?.properties ?? {});
                  setArgsText(JSON.stringify(Object.fromEntries(props.map((p) => [p, ''])), null, 1));
                }}
              >
                <option value="">Chọn công cụ…</option>
                {job.action.tool && !tools.some((t) => job.action.kind === 'mcpTool' && t.name === job.action.tool) && <option value={job.action.tool}>{job.action.tool}</option>}
                {tools.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="st-field">
              <span>Tham số (JSON)</span>
              <textarea className="st-input st-auto-mono" rows={3} value={argsText} onChange={(e) => setArgsText(e.target.value)} spellCheck={false} />
            </label>
          </>
        ))}
      <Problem text={problem} />
      <div className="st-auto-actions is-end">
        <button className="st-button" onClick={onDone}>
          Huỷ
        </button>
        <button className="st-button is-primary" onClick={save}>
          <CalendarClock size={14} />
          Lưu lịch
        </button>
      </div>
    </div>
  );
}

// MARK: - Add-on

export function AddonSettings() {
  const { state, error } = useAutomationState();
  const [problem, setProblem] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Addon | null>(null);
  if (!state) return <Unavailable error={error} />;
  const install = (folder: boolean) => {
    setProblem(null);
    void automation
      .installAddon(folder)
      .then(refreshAutomation)
      .catch((e) => setProblem(errorText(e)));
  };
  return (
    <>
      <Section title="Add-on đã cài" footer={<>Thư mục add-on: <code className="selectable">{state.addonDir}</code></>}>
        {state.addons.length === 0 && <Row label="Chưa có add-on nào" />}
        {state.addons.map((a) => (
          <AddonCard key={a.manifest.id} addon={a} onRemove={() => setRemoving(a)} />
        ))}
        <div className="st-auto-footer-actions">
          <button className="st-button" onClick={() => install(false)}>
            <Plus size={14} />
            Cài từ tệp .js…
          </button>
          <button className="st-button" onClick={() => install(true)}>
            <Plus size={14} />
            Cài từ thư mục…
          </button>
        </div>
      </Section>
      <Problem text={problem} />
      <AddonGuide />
      {removing && (
        <Alert
          title={`Gỡ add-on “${removing.manifest.name}”?`}
          message="Cài đặt, dữ liệu và lịch của add-on này cũng bị xoá."
          buttons={[
            { label: 'Huỷ', role: 'cancel', onClick: () => setRemoving(null) },
            {
              label: 'Gỡ',
              role: 'destructive',
              onClick: () => {
                const id = removing.manifest.id;
                setRemoving(null);
                void automation.removeAddon(id).then(refreshAutomation).catch((e) => setProblem(errorText(e)));
              },
            },
          ]}
        />
      )}
    </>
  );
}

function AddonCard({ addon, onRemove }: { addon: Addon; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const logs = useAddonLogs((s) => s[addon.manifest.id]);
  const m = addon.manifest;
  return (
    <div className="st-auto-item">
      <Row
        label={
          <span className="st-auto-title">
            <Puzzle size={14} />
            {m.name}
            {m.version && <span className="st-muted">v{m.version}</span>}
            {addon.builtin && <span className="st-chip">có sẵn</span>}
          </span>
        }
        detail={
          <>
            {m.description}
            <span className="st-auto-chips">
              {m.permissions.map((p) => (
                <span key={p} className="st-chip" title={p}>
                  {permissionTitles[p] ?? p}
                </span>
              ))}
              {addon.tools.map((t) => (
                <span key={t.name} className="st-chip is-tool" title={t.description}>
                  MCP: {t.name}
                </span>
              ))}
            </span>
          </>
        }
      >
        <div className="st-auto-actions">
          <Toggle label={`Bật ${m.name}`} on={addon.enabled} onChange={(enabled) => void automation.setAddonEnabled(m.id, enabled).then(refreshAutomation)} />
          <button className="st-button" onClick={() => setOpen((o) => !o)}>
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            Tuỳ chỉnh
          </button>
        </div>
      </Row>
      {open && (
        <div className="st-auto-sub">
          {m.settings.length > 0 ? <AddonSettingsForm addon={addon} /> : <div className="st-muted">Add-on này không có tuỳ chỉnh.</div>}
          <div className="st-field">
            <span>Nhật ký</span>
            <pre className="st-snippet selectable st-auto-log">
              {logs?.length ? logs.map((l) => `${new Date(l.at).toLocaleTimeString('vi-VN')}  ${l.text}`).join('\n') : addon.enabled ? 'Chưa có dòng nào.' : 'Add-on đang tắt.'}
            </pre>
          </div>
          <div className="st-auto-actions">
            <span className="st-muted st-auto-mono truncate">{addon.path}</span>
            <button className="st-button is-danger" onClick={onRemove}>
              <Trash2 size={14} />
              Gỡ add-on
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function AddonSettingsForm({ addon }: { addon: Addon }) {
  const initial = useMemo(() => addonSettings(addon), [addon]);
  const [values, setValues] = useState(initial);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const dirty = JSON.stringify(values) !== JSON.stringify(initial);
  const set = (key: string, v: unknown) => {
    setSaved(false);
    setValues((s) => ({ ...s, [key]: v }));
  };
  const field = (s: AddonSetting): ReactNode => {
    const v = values[s.key];
    switch (s.type) {
      case 'boolean':
        return (
          <div className="st-field is-inline" key={s.key}>
            <span>{s.label}</span>
            <Toggle label={s.label} on={!!v} onChange={(on) => set(s.key, on)} />
          </div>
        );
      case 'textarea':
        return (
          <label className="st-field" key={s.key}>
            <span>{s.label}</span>
            <textarea className="st-input" rows={3} value={String(v ?? '')} onChange={(e) => set(s.key, e.target.value)} />
          </label>
        );
      case 'number':
        return (
          <label className="st-field" key={s.key}>
            <span>{s.label}</span>
            <input className="st-input is-narrow nums" type="number" value={String(v ?? '')} onChange={(e) => set(s.key, e.target.value === '' ? '' : Number(e.target.value))} />
          </label>
        );
      case 'conversation':
        return (
          <label className="st-field" key={s.key}>
            <span>{s.label}</span>
            <ConversationSelect allowEmpty value={String(v ?? '')} onChange={(id) => set(s.key, id)} />
          </label>
        );
      case 'cron':
        return <CronField key={s.key} value={String(v ?? '')} onChange={(expr) => set(s.key, expr)} />;
      default:
        return (
          <label className="st-field" key={s.key}>
            <span>{s.label}</span>
            <input className="st-input" value={String(v ?? '')} onChange={(e) => set(s.key, e.target.value)} />
          </label>
        );
    }
  };
  return (
    <div className="st-auto-editor is-flat">
      {addon.manifest.settings.map(field)}
      <Problem text={problem} />
      <div className="st-auto-actions is-end">
        {saved && <span className="st-ok">Đã lưu</span>}
        <button
          className="st-button is-primary"
          disabled={!dirty}
          onClick={() =>
            void automation
              .setAddonSettings(addon.manifest.id, values)
              .then(() => {
                setSaved(true);
                return refreshAutomation();
              })
              .catch((e) => setProblem(errorText(e)))
          }
        >
          Lưu tuỳ chỉnh
        </button>
      </div>
    </div>
  );
}

const guide = `/* @compola-addon {"id":"hello","name":"Xin chào","version":"1.0.0",
   "permissions":["messages:read","messages:send"],
   "settings":[{"key":"reply","label":"Câu trả lời","type":"text","default":"Chào bạn!"}]} */

compola.on('message', async (m) => {
  // m: {conversationId, conversationName, isGroup, senderName, fromMe, text, date}
  if (!m.fromMe && /^xin chào/i.test(m.text)) await compola.sendText(m.conversationId, compola.settings.reply);
});

// Khác: compola.conversations({query}), compola.messages(convId, limit), compola.notify(title, body),
// compola.storage.get/set, compola.schedules.save({cron | at, payload}) + compola.on('schedule', fn),
// compola.mcp.servers()/tools(id)/call(id, tool, args), compola.tools.register({name, description, inputSchema}, fn),
// compola.on('ready' | 'settings', fn), compola.log(...)
// Quyền: messages:read, messages:send, schedules, mcp, network, notifications`;

function AddonGuide() {
  const [open, setOpen] = useState(false);
  return (
    <Section title="Viết add-on">
      <Row
        label="Add-on là tệp JavaScript chạy trong một worker riêng"
        detail="Một tệp .js có chú thích @compola-addon, hoặc một thư mục có manifest.json và main.js."
      >
        <button className="st-button" onClick={() => setOpen((o) => !o)}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          Ví dụ
        </button>
      </Row>
      {open && (
        <div className="st-auto-sub">
          <pre className="st-snippet selectable">{guide}</pre>
          <CopyButton text={guide} />
        </div>
      )}
    </Section>
  );
}

