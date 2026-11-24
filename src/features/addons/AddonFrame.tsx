// One add-on HTML view in a sandboxed iframe (src-tauri/src/automation/addons/views.rs builds its document).
//
// Isolation: `sandbox="allow-scripts allow-forms"` without `allow-same-origin` gives the view an opaque origin — no
// access to this page, its storage, cookies or Tauri — and its CSP forbids network. It talks to us only by
// postMessage; a message counts only when it comes from this iframe's own window. What it may ask for: call its add-on
// (`compola.call` → `addons_view_call`, checked on the host like any add-on call), show a toast, put text in the
// composer of the conversation it belongs to, open a conversation or another of its add-on's views, resize, close.

import { AlertTriangle, RotateCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  addons,
  errorText,
  insertIntoComposer,
  openAddonView,
  openConversationFromAddon,
  registerFrame,
  type AddonViewDef,
} from '../../engine/addons';
import { useAutomation } from '../../engine/automation';
import { useEngine } from '../../engine/store';
import { showToast } from '../../engine/toast';
import { Spinner } from '../../ui/Spinner';
import './addons.css';

/** Built documents, by add-on + view + code version (a new version of the add-on refetches). */
const documents = new Map<string, Promise<string>>();

const docKey = (v: AddonViewDef, digest: string) => `${v.addonId}|${v.id}|${digest}`;

const themeNow = (): 'light' | 'dark' => {
  const set = document.documentElement.dataset.theme;
  if (set === 'light' || set === 'dark') return set;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

export interface FrameContext {
  conversationId?: string | null;
  conversationName?: string | null;
  isGroup?: boolean;
  params?: unknown;
}

export function AddonFrame({
  view,
  context = {},
  fill = false,
  minHeight = 40,
  onClose,
}: {
  view: AddonViewDef;
  context?: FrameContext;
  /** Fills its container (tabs, modals) instead of growing with its content (inspector, composer, settings). */
  fill?: boolean;
  minHeight?: number;
  onClose?: (result: unknown) => void;
}) {
  const digest = useAutomation((s) => s.state?.addons.find((a) => a.manifest.id === view.addonId)?.digest ?? '');
  const [doc, setDoc] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [height, setHeight] = useState<number>(view.height ?? minHeight);
  const [reload, setReload] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const conversationId = context.conversationId ?? null;
  // Views opened without the conversation's details (modals, tabs) still get them.
  const known = useEngine((s) => (conversationId ? s.conversations.find((c) => c.id === conversationId) : undefined));
  const conversationName = context.conversationName ?? known?.name ?? null;
  const isGroup = context.isGroup ?? known?.isGroup ?? false;

  // Latest context, read by the message handler without re-subscribing.
  const ctx = useMemo(
    () => ({
      addonId: view.addonId,
      viewId: view.id,
      location: view.location,
      conversationId,
      conversationName,
      isGroup,
      params: context.params ?? null,
    }),
    [view.addonId, view.id, view.location, conversationId, conversationName, isGroup, context.params],
  );
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    let alive = true;
    setProblem(null);
    const key = docKey(view, digest);
    if (reload > 0) documents.delete(key);
    let p = documents.get(key);
    if (!p) {
      p = addons.viewDocument(view.addonId, view.id);
      documents.set(key, p);
      p.catch(() => documents.delete(key));
    }
    p.then(
      (d) => alive && setDoc(d),
      (e) => alive && setProblem(errorText(e)),
    );
    return () => {
      alive = false;
    };
  }, [view.addonId, view.id, digest, reload]);

  const post = (message: unknown) => frame.current?.contentWindow?.postMessage(message, '*');
  const sendContext = () => post({ __compola: 1, type: 'context', context: { ...ctxRef.current, theme: themeNow() } });

  // Context changes (another conversation, theme) reach a view that is already loaded.
  useEffect(() => {
    sendContext();
  }, [ctx]);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onChange = () => sendContext();
    mq?.addEventListener('change', onChange);
    const observer = new MutationObserver(onChange);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      mq?.removeEventListener('change', onChange);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const unregister = registerFrame({ addonId: view.addonId, viewId: view.id, conversationId, post });
    return () => {
      unregister();
    };
  }, [view.addonId, view.id, conversationId]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const win = frame.current?.contentWindow;
      if (!win || e.source !== win) return;
      const m = e.data as { __compola?: number; type?: string; id?: number; payload?: Record<string, unknown> | null };
      if (!m || m.__compola !== 1 || typeof m.type !== 'string') return;
      const p = (m.payload ?? {}) as Record<string, unknown>;
      const reply = (promise: Promise<unknown>) => {
        if (typeof m.id !== 'number') return;
        promise.then(
          (value) => post({ __compola: 1, type: 'reply', id: m.id, ok: true, value: value ?? null }),
          (err) => post({ __compola: 1, type: 'reply', id: m.id, ok: false, error: errorText(err) }),
        );
      };
      const c = ctxRef.current;
      switch (m.type) {
        case 'hello':
          sendContext();
          break;
        case 'call':
          reply(addons.viewCall(c.addonId, c.viewId, String(p.name ?? ''), p.data ?? null, c.conversationId, c.params));
          break;
        case 'toast':
          showToast(String(p.text ?? '').slice(0, 300), c.conversationId);
          reply(Promise.resolve(null));
          break;
        case 'insertText':
          if (!c.conversationId) reply(Promise.reject(new Error('view này không gắn với hội thoại nào')));
          else {
            insertIntoComposer(c.conversationId, String(p.text ?? '').slice(0, 5000));
            reply(Promise.resolve(null));
          }
          break;
        case 'openConversation':
          openConversationFromAddon(String(p.conversationId ?? ''));
          reply(Promise.resolve(null));
          break;
        case 'openView':
          openAddonView(c.addonId, String(p.viewId ?? ''), c.conversationId, p.params ?? null);
          reply(Promise.resolve(null));
          break;
        case 'resize': {
          const h = Number(p.height);
          if (!fill && Number.isFinite(h)) setHeight(Math.max(minHeight, Math.min(h, view.height ?? 1200)));
          break;
        }
        case 'close':
          closeRef.current?.(p ?? null);
          break;
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [fill, minHeight, view.height]);

  if (problem) {
    return (
      <div className="addon-frame-problem">
        <AlertTriangle size={14} />
        <span className="truncate" title={problem}>
          {view.title}: {problem}
        </span>
        <button className="icon-button" onClick={() => setReload((r) => r + 1)} title="Tải lại" aria-label="Tải lại">
          <RotateCw size={13} />
        </button>
      </div>
    );
  }
  if (doc === null) {
    return (
      <div className="addon-frame-loading" style={fill ? undefined : { height: Math.min(height, 120) }}>
        <Spinner size={16} />
      </div>
    );
  }
  return (
    <iframe
      ref={frame}
      className={`addon-frame ${fill ? 'is-fill' : ''}`}
      title={`${view.addonName} · ${view.title}`}
      sandbox="allow-scripts allow-forms"
      referrerPolicy="no-referrer"
      srcDoc={doc}
      style={fill ? undefined : { height }}
      onLoad={sendContext}
    />
  );
}
