// Mock of `automation_state` and the add-on management commands (Rust src-tauri/src/automation) for the browser
// preview: the real built-in add-on manifests, in the shape `automation_state` returns.

import { registerMockCommand } from '../registry';
import { builtinPackages } from './builtinAddons';

type Manifest = { id: string; settings?: { key: string; type?: string; default?: unknown }[] } & Record<string, unknown>;

const limits = { sendPerMinute: 20, sendPerConversationHour: 30, aiPerHour: 300, fetchPerMinute: 120 };
const enabled = new Set(['quick-replies', 'ai-reply', ...builtinPackages.filter((p) => (p.manifest.contributes?.views ?? []).length > 0).map((p) => p.id)]);
const saved: Record<string, Record<string, unknown>> = {};

const view = (m: Manifest) => {
  const settings: Record<string, unknown> = {};
  for (const s of m.settings ?? []) settings[s.key] = s.default ?? (s.type === 'boolean' ? false : s.type === 'conversations' ? [] : '');
  const on = enabled.has(m.id);
  return {
    manifest: { contributes: { actions: [], quickReplies: [], views: [] }, limits: {}, ...m },
    digest: 'mock',
    path: `~/Library/Application Support/Compola/addons/${m.id}`,
    builtin: true,
    hasBackup: false,
    enabled: on,
    settings: { ...settings, ...saved[m.id] },
    limits,
    tools: [],
    status: on ? { state: 'running', since: Date.now() - 3600_000 } : { state: 'stopped' },
    stats: on ? { events: 42, calls: 17, errors: 0, busyMs: 120, memory: 3_400_000, inFlight: 0, dropped: 0, backlog: 0, aiRequests: 3, aiInputTokens: 2100, aiOutputTokens: 480, subscriptions: ['message'] } : {},
  };
};

const manifests = builtinPackages.map((p) => p.manifest) as unknown as Manifest[];

registerMockCommand('automation_state', () => ({
  server: { config: { enabled: false, port: 39217, token: 'mock', allowSend: false, allowSchedules: true, exposeExternal: false }, running: false, url: null, error: null },
  clients: [],
  connected: [],
  jobs: [],
  nextDue: {},
  runs: [],
  addons: manifests.map(view),
  addonDir: '~/Library/Application Support/Compola/addons',
  permissions: ['messages:read', 'messages:send', 'notes', 'ui', 'ai', 'schedules', 'mcp', 'network', 'notifications'],
  ai: { enabled: false, provider: 'anthropic', url: '', apiKey: '', model: 'claude-opus-5-5', effort: 'medium', maxTokens: 16000, hasKey: false },
}));
registerMockCommand('addons_logs', (a) => [{ at: Date.now(), level: 'info', text: `${String(a.id)}: khởi động v1.0.0` }]);
registerMockCommand('addons_set_enabled', (a) => void (a.enabled ? enabled.add(String(a.id)) : enabled.delete(String(a.id))));
registerMockCommand('addons_set_settings', (a) => void (saved[String(a.id)] = a.settings as Record<string, unknown>));
registerMockCommand('automation_cron_preview', () => [Date.now() + 3600_000, Date.now() + 90_000_000, Date.now() + 176_400_000]);
