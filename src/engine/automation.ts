// Automation (src-tauri/src/automation): MCP server + MCP clients, cron schedules and add-ons. Types mirror the Rust
// serde shapes; `useAutomation` keeps the latest `automation_state` and refetches on `compola://automation` `changed`.

import { create } from 'zustand';
import { backend } from './backend';

export interface McpServerConfig {
  enabled: boolean;
  port: number;
  token: string;
  allowSend: boolean;
  allowSchedules: boolean;
  exposeExternal: boolean;
}

export interface McpClientConfig {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
}

export type Schedule = { kind: 'cron'; expr: string } | { kind: 'once'; at: number };

export type JobAction =
  | { kind: 'sendText'; conversationId: string; conversationName: string; text: string }
  | { kind: 'mcpTool'; serverId: string; tool: string; arguments: Record<string, unknown> }
  | { kind: 'addon'; addonId: string; payload: unknown };

export interface Job {
  id: string;
  name: string;
  enabled: boolean;
  schedule: Schedule;
  action: JobAction;
  createdBy: string;
  lastRun: number | null;
  lastStatus: string | null;
  lastOk: boolean | null;
}

export interface RunLog {
  jobId: string;
  jobName: string;
  at: number;
  ok: boolean;
  status: string;
  trigger: string;
}

export interface AddonSetting {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'secret' | 'time' | 'conversation' | 'conversations' | 'cron' | 'url';
  default?: unknown;
  /** `select`: the choices. */
  options?: { value: string; label: string }[];
  /** Shown under the field. */
  description?: string;
}

export interface AddonManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  main: string;
  permissions: string[];
  hosts?: string[];
  homepage?: string;
  settings: AddonSetting[];
  contributes?: { actions?: unknown[]; quickReplies?: unknown[]; views?: { id: string; title: string; location: string; entry: string }[] };
  limits?: { memoryMb?: number; timeoutMs?: number };
}

export type AddonStatus =
  | { state: 'stopped' }
  | { state: 'running'; since: number }
  | { state: 'restarting'; at: number; attempt: number; reason: string }
  | { state: 'faulted'; reason: string };

export interface AddonStats {
  events?: number;
  calls?: number;
  errors?: number;
  busyMs?: number;
  memory?: number;
  inFlight?: number;
  dropped?: number;
  backlog?: number;
  aiRequests?: number;
  aiInputTokens?: number;
  aiOutputTokens?: number;
  subscriptions?: string[];
}

export interface Addon {
  manifest: AddonManifest;
  digest: string;
  path: string;
  builtin: boolean;
  hasBackup: boolean;
  enabled: boolean;
  /** The user's values over the manifest defaults. */
  settings: Record<string, unknown>;
  limits: import('./addons').AddonLimits;
  tools: { name: string; description?: string }[];
  status: AddonStatus;
  stats: AddonStats;
}

export interface AutomationState {
  server: { config: McpServerConfig; running: boolean; url: string | null; error: string | null };
  clients: McpClientConfig[];
  connected: string[];
  jobs: Job[];
  nextDue: Record<string, number>;
  runs: RunLog[];
  addons: Addon[];
  addonDir: string;
  permissions: string[];
  ai: import('./addons').AiConfig;
}

export interface MirrorConversation {
  id: string;
  name: string;
  isGroup: boolean;
  pinned: boolean;
  unread: number;
  members: number;
  lastText: string;
  lastDate: number;
  lastFromMe: boolean;
}

export interface MirrorMessage {
  id: string;
  conversationId: string;
  conversationName: string;
  isGroup: boolean;
  senderName: string;
  fromMe: boolean;
  text: string;
  date: number;
  source: 'chat' | 'preview';
}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: { properties?: Record<string, { type?: string; description?: string }>; required?: string[] };
}

const call = async <T>(command: string, args?: Record<string, unknown>) => (await backend()).invoke<T>(command, args);

export const automation = {
  state: () => call<AutomationState>('automation_state'),
  setServer: (server: McpServerConfig) => call<void>('automation_set_server', { server }),
  regenerateToken: () => call<string>('automation_regenerate_token'),
  saveClient: (client: McpClientConfig) => call<McpClientConfig>('automation_save_client', { client }),
  deleteClient: (id: string) => call<void>('automation_delete_client', { id }),
  clientTools: (id: string) => call<{ tools: McpTool[]; serverInfo: { name?: string; version?: string } | null }>('automation_client_tools', { id }),
  clientCall: (id: string, tool: string, args: unknown) => call<unknown>('automation_client_call', { id, tool, arguments: args ?? {} }),
  saveJob: (job: Job) => call<Job>('automation_save_job', { job }),
  deleteJob: (id: string) => call<boolean>('automation_delete_job', { id }),
  runJob: (id: string) => call<RunLog>('automation_run_job', { id }),
  cronPreview: (expr: string, count = 5) => call<number[]>('automation_cron_preview', { expr, count }),
  conversations: (query?: string, limit = 50) => call<MirrorConversation[]>('automation_conversations', { query: query ?? null, limit }),
  messages: (conversationId: string | null, limit = 50) => call<MirrorMessage[]>('automation_messages', { conversationId, limit }),
  sendText: (conversationId: string, text: string) => call<void>('automation_send_text', { conversationId, text }),
};

export const useAutomation = create<{ state: AutomationState | null; error: string | null }>()(() => ({ state: null, error: null }));

let refreshing: Promise<void> | null = null;
export const refreshAutomation = () => {
  if (!refreshing) {
    refreshing = automation
      .state()
      .then((state) => useAutomation.setState({ state, error: null }))
      .catch((e) => useAutomation.setState({ error: String(e) }))
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
};

/** Merges an add-on's settings with its manifest defaults (the host already sends them merged). */
export const addonSettings = (addon: Pick<Addon, 'manifest' | 'settings'>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const s of addon.manifest.settings ?? []) out[s.key] = s.default ?? (s.type === 'boolean' ? false : s.type === 'conversations' ? [] : '');
  return { ...out, ...addon.settings };
};

export const permissionTitles: Record<string, string> = {
  'messages:read': 'Đọc tin nhắn đến',
  'messages:send': 'Gửi tin nhắn',
  schedules: 'Tạo lịch tự động',
  mcp: 'Dùng máy chủ MCP',
  network: 'Truy cập mạng',
  notifications: 'Hiện thông báo',
  notes: 'Ghi chú hội thoại',
  ui: 'Giao diện trong ứng dụng',
  ai: 'Dùng AI',
};

/**
 * Where an add-on could carry what it reads (the host enforces each limit: add-ons/host.rs). Empty: nowhere — it can
 * read and show things inside Compola, but has no way to send them out.
 */
export const dataExits = (m: Pick<AddonManifest, 'permissions' | 'hosts'> & { settings?: { type: string }[] }): string[] => {
  const out: string[] = [];
  if (m.permissions.includes('network')) {
    const to = [...(m.hosts ?? [])];
    if (m.settings?.some((s) => s.type === 'url')) to.push('địa chỉ bạn nhập trong tuỳ chỉnh');
    out.push(`Internet: ${to.join(', ') || 'không địa chỉ nào'}`);
  }
  if (m.permissions.includes('messages:send')) out.push('tin Zalo, chỉ vào hội thoại vừa nhắn đến, hội thoại bạn chọn hoặc nơi bạn vừa dùng add-on');
  if (m.permissions.includes('mcp')) out.push('các máy chủ MCP bạn đã cấu hình');
  return out;
};

export const describeSchedule = (s: Schedule): string => (s.kind === 'cron' ? `cron ${s.expr}` : `một lần · ${formatTime(s.at)}`);

export const formatTime = (ms: number | null | undefined): string => {
  if (!ms) return '—';
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  return sameDay ? `${time} hôm nay` : `${time} ${d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' })}`;
};

/** Cron presets offered in the schedule editor. */
export const cronPresets: { expr: string; title: string }[] = [
  { expr: '0 8 * * *', title: 'Mỗi ngày 8:00' },
  { expr: '0 8 * * mon-fri', title: 'Ngày làm việc 8:00' },
  { expr: '0 9 * * mon', title: 'Thứ hai 9:00' },
  { expr: '0 * * * *', title: 'Mỗi giờ' },
  { expr: '*/15 * * * *', title: 'Mỗi 15 phút' },
  { expr: '0 9 1 * *', title: 'Ngày 1 hằng tháng' },
];
