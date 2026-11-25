// Add-ons in the UI. They run in the Rust core (src-tauri/src/automation/addons: one sandboxed QuickJS runtime each);
// this module is their client: the conversation workspace (notes, reply suggestions, panels, actions), quick replies,
// HTML views (tabs, inspector, composer, settings, modals — `features/addons/AddonFrame.tsx`) and the
// `compola://addons` event. Docs: docs/addons.md.

import { create } from 'zustand';
import { activeAccountId } from './activeAccount';
import { backend } from './backend';
import { refreshAutomation } from './automation';
import { setEngine } from './store';
import { showToast } from './toast';

export interface AddonNote {
  id: string;
  account: string;
  conversationId: string;
  messageId: string | null;
  authorKind: 'addon' | 'user';
  authorId: string;
  authorName: string;
  text: string;
  pinned: boolean;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface AddonSuggestion {
  id: string;
  addonId: string;
  addonName: string;
  account: string;
  conversationId: string;
  title: string;
  text: string;
  createdAt: number;
  expiresAt: number;
}

export type PanelBlock =
  | { type: 'text'; text: string; muted?: boolean }
  | { type: 'heading'; text: string }
  | { type: 'kv'; items: { label: string; value: string }[] }
  | { type: 'list'; items: string[]; ordered?: boolean }
  | { type: 'badges'; items: string[] }
  | { type: 'button'; label: string; action: string; payload: unknown; style: 'primary' | 'default' }
  | { type: 'progress'; label: string; value: number }
  | { type: 'divider' };

export interface AddonPanel {
  addonId: string;
  addonName: string;
  conversationId: string | null;
  title: string;
  blocks: PanelBlock[];
  updatedAt: number;
}

export interface AddonAction {
  id: string;
  title: string;
  context: 'conversation' | 'message' | 'composer';
  description: string;
  addonId: string;
  addonName: string;
  /** Opens this view (a `modal` view) instead of sending an `action` event. */
  view?: string;
}

export type ViewLocation = 'tab' | 'inspector' | 'composer' | 'settings' | 'modal';

export interface AddonViewDef {
  id: string;
  title: string;
  location: ViewLocation;
  entry: string;
  icon: string;
  height: number | null;
  width: number | null;
  addonId: string;
  addonName: string;
}

export interface QuickReply {
  addonId: string;
  shortcut: string;
  title: string;
  text: string;
}

export interface Workspace {
  notes: AddonNote[];
  suggestions: AddonSuggestion[];
  panels: AddonPanel[];
  actions: AddonAction[];
  views: AddonViewDef[];
}

export interface AddonPreview {
  manifest: { id: string; name: string; version: string; description: string; author: string; permissions: string[]; hosts?: string[]; settings?: { type: string }[] };
  warnings: string[];
  files: number;
  bytes: number;
  installedVersion: string | null;
  newPermissions: string[];
  /** Hosts the installed version could not reach. */
  newHosts: string[];
  downgrade: boolean;
  replacesBuiltin: boolean;
}

export interface AddonLogLine {
  at: number;
  level: string;
  text: string;
}

const call = async <T>(command: string, args?: Record<string, unknown>) => (await backend()).invoke<T>(command, args);
/** The account on screen (the host resolves `null` to its active account). */
const acc = () => activeAccountId() ?? undefined;

export const addons = {
  pick: (kind: 'zip' | 'js' | 'folder') => call<string | null>('addons_pick', { kind }),
  inspect: (path: string) => call<AddonPreview>('addons_inspect', { path }),
  install: (path: string) => call<string>('addons_install', { path }),
  setEnabled: (id: string, enabled: boolean) => call<void>('addons_set_enabled', { id, enabled }),
  setSettings: (id: string, settings: Record<string, unknown>) => call<void>('addons_set_settings', { id, settings }),
  setLimits: (id: string, limits: AddonLimits) => call<void>('addons_set_limits', { id, limits }),
  remove: (id: string) => call<void>('addons_remove', { id }),
  restart: (id: string) => call<void>('addons_restart', { id }),
  rollback: (id: string) => call<void>('addons_rollback', { id }),
  logs: (id: string) => call<AddonLogLine[]>('addons_logs', { id }),
  clearLogs: (id: string) => call<void>('addons_clear_logs', { id }),
  setAi: (config: AiConfig) => call<AiConfig>('addons_ai_set', { config }),
  testAi: () => call<{ text: string; model: string }>('addons_ai_test'),

  workspace: (conversationId: string) => call<Workspace>('addons_workspace', { account: acc(), conversationId }),
  quickReplies: () => call<QuickReply[]>('addons_quick_replies', { account: acc() }),
  views: () => call<AddonViewDef[]>('addons_views', { account: acc() }),
  viewDocument: (addonId: string, viewId: string) => call<string>('addons_view_document', { account: acc(), addonId, viewId }),
  viewCall: (addonId: string, viewId: string, name: string, data: unknown, conversationId: string | null, params: unknown) =>
    call<unknown>('addons_view_call', { account: acc(), addonId, viewId, name, data: data ?? null, conversationId, params: params ?? null }),
  addNote: (conversationId: string, text: string, messageId?: string) => call<AddonNote>('addons_note_add', { account: acc(), conversationId, text, messageId: messageId ?? null }),
  updateNote: (conversationId: string, id: string, patch: Partial<Pick<AddonNote, 'text' | 'pinned' | 'tags'>>) =>
    call<AddonNote>('addons_note_update', { account: acc(), conversationId, id, patch }),
  deleteNote: (conversationId: string, id: string) => call<void>('addons_note_delete', { account: acc(), conversationId, id }),
  resolveSuggestion: (conversationId: string, id: string, outcome: 'used' | 'sent' | 'dismissed') =>
    call<void>('addons_suggestion_resolve', { account: acc(), conversationId, id, outcome }),
  runAction: (a: { addonId: string; actionId: string; conversationId?: string | null; messageId?: string | null; text?: string | null; payload?: unknown }) =>
    call<void>('addons_action_run', {
      account: acc(),
      addonId: a.addonId,
      actionId: a.actionId,
      conversationId: a.conversationId ?? null,
      messageId: a.messageId ?? null,
      text: a.text ?? null,
      payload: a.payload ?? null,
    }),
};

export interface AddonLimits {
  sendPerMinute: number;
  sendPerConversationHour: number;
  aiPerHour: number;
  fetchPerMinute: number;
}

export interface AiConfig {
  enabled: boolean;
  provider: 'anthropic' | 'openai';
  url: string;
  apiKey: string;
  model: string;
  effort: string;
  maxTokens: number;
  /** Read only: a key is stored (the key itself never comes back). */
  hasKey?: boolean;
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---- stores ----

/** Views and quick replies of the running add-ons (app-wide). */
export const useAddonCatalog = create<{ views: AddonViewDef[]; quickReplies: QuickReply[]; loaded: boolean }>()(() => ({
  views: [],
  quickReplies: [],
  loaded: false,
}));

/** Workspace per conversation id (only the ones on screen are kept fresh). */
export const useWorkspaces = create<Record<string, Workspace | undefined>>()(() => ({}));

const watched = new Map<string, number>();

export const refreshWorkspace = async (conversationId: string) => {
  try {
    const w = await addons.workspace(conversationId);
    useWorkspaces.setState({ [conversationId]: w });
  } catch {
    // Joined users without access, mock mode…: no add-on content.
    useWorkspaces.setState({ [conversationId]: { notes: [], suggestions: [], panels: [], actions: [], views: [] } });
  }
};

/** Keeps a conversation's workspace loaded while a component shows it. Returns the release function. */
export const watchWorkspace = (conversationId: string) => {
  watched.set(conversationId, (watched.get(conversationId) ?? 0) + 1);
  if (watched.get(conversationId) === 1) void refreshWorkspace(conversationId);
  return () => {
    const n = (watched.get(conversationId) ?? 1) - 1;
    if (n <= 0) watched.delete(conversationId);
    else watched.set(conversationId, n);
  };
};

let catalogTimer: ReturnType<typeof setTimeout> | null = null;
export const refreshCatalog = () => {
  if (catalogTimer) return;
  catalogTimer = setTimeout(() => {
    catalogTimer = null;
    void Promise.all([addons.views().catch(() => []), addons.quickReplies().catch(() => [])]).then(([views, quickReplies]) =>
      useAddonCatalog.setState({ views, quickReplies, loaded: true }),
    );
    for (const id of watched.keys()) void refreshWorkspace(id);
  }, 150);
};

// ---- composer bridge (views and quick replies put text in the message box) ----

export const useComposerInsert = create<{ request: { conversationId: string; text: string; replace: boolean; seq: number } | null }>()(() => ({ request: null }));
let insertSeq = 0;
export const insertIntoComposer = (conversationId: string, text: string, replace = false) =>
  useComposerInsert.setState({ request: { conversationId, text, replace, seq: ++insertSeq } });

/** `{{name}}` (the conversation), `{{date}}`, `{{time}}`, `{{weekday}}`, `{{datetime}}` in a quick reply / suggestion. */
export const expandTemplate = (text: string, conversationName: string) => {
  const now = new Date();
  const weekday = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'][now.getDay()];
  const date = now.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const time = now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  return text
    .replace(/\{\{\s*name\s*\}\}/g, conversationName)
    .replace(/\{\{\s*date\s*\}\}/g, date)
    .replace(/\{\{\s*time\s*\}\}/g, time)
    .replace(/\{\{\s*datetime\s*\}\}/g, `${time} ${date}`)
    .replace(/\{\{\s*weekday\s*\}\}/g, weekday);
};

// ---- modal views ----

export interface OpenModal {
  key: number;
  view: AddonViewDef;
  conversationId: string | null;
  params: unknown;
}

export const useAddonModals = create<{ open: OpenModal[] }>()(() => ({ open: [] }));
let modalSeq = 0;

/** Opens a view: a modal as a dialog, a tab as its page; inline views cannot be opened on their own. */
export const openAddonView = (addonId: string, viewId: string, conversationId: string | null, params: unknown = null) => {
  const view = useAddonCatalog.getState().views.find((v) => v.addonId === addonId && v.id === viewId);
  if (!view) return showToast('Add-on không có giao diện này hoặc đang tắt', null);
  if (view.location === 'tab') {
    void import('../shell/shellStore').then(({ shell }) => shell.setDestination(`addon:${addonId}:${viewId}`));
    return;
  }
  useAddonModals.setState((s) => ({ open: [...s.open, { key: ++modalSeq, view, conversationId, params }] }));
};

export const closeAddonModal = (key: number) => useAddonModals.setState((s) => ({ open: s.open.filter((m) => m.key !== key) }));

export const openConversationFromAddon = (conversationId: string) => setEngine({ navigationRequest: conversationId });

// ---- frames (views on screen), for `compola.views.post` ----

export interface FrameHandle {
  addonId: string;
  viewId: string;
  conversationId: string | null;
  post: (message: unknown) => void;
}

const frames = new Set<FrameHandle>();
export const registerFrame = (f: FrameHandle) => {
  frames.add(f);
  return () => frames.delete(f);
};

const deliverViewMessage = (e: { addonId?: string; viewId?: string | null; conversationId?: string | null; name?: string; data?: unknown }) => {
  for (const f of frames) {
    if (f.addonId !== e.addonId) continue;
    if (e.viewId && f.viewId !== e.viewId) continue;
    if (e.conversationId && f.conversationId && f.conversationId !== e.conversationId) continue;
    f.post({ __compola: 1, type: 'message', name: e.name, data: e.data ?? null });
  }
};

// ---- events ----

let started = false;

/** Listens to `compola://addons` (call once the engine runs; on the host, a joined app and the web client). */
export const startAddonRuntime = async () => {
  if (started) return;
  started = true;
  const b = await backend();
  await b.listen('compola://addons', (payload) => {
    const e = (payload ?? {}) as { kind?: string; conversationId?: string | null; [k: string]: unknown };
    switch (e.kind) {
      case 'status':
        refreshCatalog();
        void refreshAutomation();
        break;
      case 'actions':
      case 'quickReplies':
        refreshCatalog();
        break;
      case 'notes':
      case 'suggestions':
      case 'panels':
        if (e.conversationId) {
          if (watched.has(e.conversationId)) void refreshWorkspace(e.conversationId);
        } else for (const id of watched.keys()) void refreshWorkspace(id);
        break;
      case 'toast':
        showToast(`${String(e.addonName ?? 'Add-on')}: ${String(e.text ?? '')}`, (e.conversationId as string | null) ?? null);
        break;
      case 'openView':
        openAddonView(String(e.addonId), String(e.viewId), (e.conversationId as string | null) ?? null, e.params ?? null);
        break;
      case 'viewMessage':
        deliverViewMessage(e as Parameters<typeof deliverViewMessage>[0]);
        break;
    }
  });
  refreshCatalog();
};
