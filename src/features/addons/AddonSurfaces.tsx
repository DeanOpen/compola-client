// Where add-ons appear in the app: their `tab` pages, `modal` views, the conversation inspector (notes, panels,
// actions, `inspector` views) and the composer (reply suggestions, `composer` views, `/` quick replies).

import {
  BarChart3,
  Bot,
  Calendar,
  ChevronDown,
  ChevronRight,
  FileText,
  LayoutGrid,
  List,
  type LucideIcon,
  MessageSquareText,
  Pin,
  PinOff,
  Puzzle,
  Send,
  Settings2,
  ShoppingCart,
  Sparkles,
  Star,
  StickyNote,
  Trash2,
  UserRound,
  Users,
  X,
  Zap,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  addons,
  closeAddonModal,
  errorText,
  expandTemplate,
  openAddonView,
  useAddonCatalog,
  useAddonModals,
  useWorkspaces,
  watchWorkspace,
  type AddonAction,
  type AddonNote,
  type AddonPanel,
  type AddonSuggestion,
  type PanelBlock,
  type QuickReply,
} from '../../engine/addons';
import { showToast } from '../../engine/toast';
import { Sheet, SheetHeader } from '../../ui/Overlays';
import { ContentUnavailable } from '../../ui/ContentUnavailable';
import { AddonFrame } from './AddonFrame';
import './addons.css';

const icons: Record<string, LucideIcon> = {
  chart: BarChart3,
  report: BarChart3,
  bot: Bot,
  ai: Sparkles,
  calendar: Calendar,
  file: FileText,
  list: List,
  grid: LayoutGrid,
  message: MessageSquareText,
  note: StickyNote,
  settings: Settings2,
  cart: ShoppingCart,
  shop: ShoppingCart,
  star: Star,
  user: UserRound,
  users: Users,
  puzzle: Puzzle,
  zap: Zap,
};
export const addonIcon = (name: string | undefined): LucideIcon => icons[name ?? ''] ?? Puzzle;

const timeText = (ms: number) => {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  return sameDay ? time : `${time} ${d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })}`;
};

/** The workspace of a conversation, kept fresh while mounted. */
export const useWorkspace = (conversationId: string | null) => {
  useEffect(() => (conversationId ? watchWorkspace(conversationId) : undefined), [conversationId]);
  return useWorkspaces((s) => (conversationId ? s[conversationId] : undefined));
};

// MARK: - Tab page and modals

export function AddonTabPage({ addonId, viewId }: { addonId: string; viewId: string }) {
  const { views, loaded } = useAddonCatalog();
  const view = views.find((v) => v.addonId === addonId && v.id === viewId && v.location === 'tab');
  return (
    <div className="column addon-tab-page">
      <div className="toolbar column-toolbar" data-tauri-drag-region>
        <div className="column-title" data-tauri-drag-region>
          <div className="column-title-main truncate">{view?.title ?? 'Add-on'}</div>
          {view && <div className="column-title-sub truncate">{view.addonName}</div>}
        </div>
      </div>
      <div className="addon-tab-body">
        {view ? (
          <AddonFrame key={`${addonId}:${viewId}`} view={view} fill />
        ) : (
          <ContentUnavailable icon={Puzzle} title={loaded ? 'Add-on đang tắt' : 'Đang tải…'} description={loaded ? 'Bật add-on trong Cài đặt › Add-on.' : undefined} />
        )}
      </div>
    </div>
  );
}

export function AddonModalHost() {
  const open = useAddonModals((s) => s.open);
  return (
    <>
      {open.map((m) => (
        <Sheet key={m.key} onClose={() => closeAddonModal(m.key)} width={m.view.width ?? 520} height={Math.min(m.view.height ?? 560, window.innerHeight - 80)}>
          <SheetHeader title={m.view.title} onClose={() => closeAddonModal(m.key)} />
          <div className="addon-modal-body">
            <AddonFrame view={m.view} fill context={{ conversationId: m.conversationId, params: m.params }} onClose={() => closeAddonModal(m.key)} />
          </div>
        </Sheet>
      ))}
    </>
  );
}

// MARK: - Inspector

function InspectorSection({ title, trailing, children, defaultOpen = true }: { title: string; trailing?: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="inspector-block inspector-section">
      <button className="inspector-section-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span>{title}</span>
        {trailing && <span className="inspector-section-count">{trailing}</span>}
        <span className="conv-tabs-spacer" />
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>
      {open && children}
    </section>
  );
}

const runAction = (a: AddonAction, conversationId: string | null) => {
  if (a.view) return openAddonView(a.addonId, a.view, conversationId);
  void addons.runAction({ addonId: a.addonId, actionId: a.id, conversationId }).catch((e) => showToast(errorText(e), conversationId));
};

/** Notes, add-on panels, actions and inspector views of a conversation (in the chat's info panel). */
export function AddonInspectorSections({ conversationId, conversationName, isGroup, readOnly }: { conversationId: string; conversationName: string; isGroup: boolean; readOnly?: boolean }) {
  const ws = useWorkspace(conversationId);
  const allViews = useAddonCatalog((s) => s.views);
  const views = useMemo(() => allViews.filter((v) => v.location === 'inspector'), [allViews]);
  const actions = (ws?.actions ?? []).filter((a) => a.context === 'conversation');
  return (
    <>
      <NotesSection conversationId={conversationId} notes={ws?.notes ?? []} readOnly={readOnly} />
      {!readOnly && actions.length > 0 && (
        <InspectorSection title="Tiện ích">
          <div className="addon-actions">
            {actions.map((a) => {
              const Icon = a.view ? LayoutGrid : Zap;
              return (
                <button key={`${a.addonId}:${a.id}`} className="addon-action" title={a.description || `${a.addonName}: ${a.title}`} onClick={() => runAction(a, conversationId)}>
                  <Icon size={13} />
                  <span className="truncate">{a.title}</span>
                </button>
              );
            })}
          </div>
        </InspectorSection>
      )}
      {(ws?.panels ?? []).map((p) => (
        <InspectorSection key={p.addonId} title={p.title}>
          <PanelView panel={p} conversationId={conversationId} />
        </InspectorSection>
      ))}
      {views.map((v) => (
        <InspectorSection key={`${v.addonId}:${v.id}`} title={v.title}>
          <div className="addon-inline-frame">
            <AddonFrame view={v} context={{ conversationId, conversationName, isGroup }} minHeight={48} />
          </div>
        </InspectorSection>
      ))}
    </>
  );
}

function NotesSection({ conversationId, notes, readOnly }: { conversationId: string; notes: AddonNote[]; readOnly?: boolean }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? notes : notes.slice(0, 5);
  const add = () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    void addons
      .addNote(conversationId, t)
      .then(() => setText(''))
      .catch((e) => showToast(errorText(e), conversationId))
      .finally(() => setBusy(false));
  };
  return (
    <InspectorSection title="Ghi chú" trailing={notes.length ? String(notes.length) : undefined}>
      {!readOnly && (
        <div className="addon-note-compose">
          <textarea
            className="addon-note-input"
            rows={2}
            placeholder="Thêm ghi chú cho đồng nghiệp… (⌘↵ để lưu)"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                add();
              }
            }}
          />
          <button className="btn btn-prominent addon-note-save" disabled={!text.trim() || busy} onClick={add}>
            Lưu
          </button>
        </div>
      )}
      {notes.length === 0 ? (
        <div className="addon-empty">Chưa có ghi chú. Add-on (ví dụ Tóm tắt khách hàng) và đồng nghiệp ghi chú ở đây.</div>
      ) : (
        <div className="addon-notes">
          {shown.map((n) => (
            <NoteRow key={n.id} note={n} conversationId={conversationId} readOnly={readOnly} />
          ))}
          {notes.length > shown.length && (
            <button className="addon-more" onClick={() => setShowAll(true)}>
              Xem thêm {notes.length - shown.length} ghi chú
            </button>
          )}
        </div>
      )}
    </InspectorSection>
  );
}

function NoteRow({ note, conversationId, readOnly }: { note: AddonNote; conversationId: string; readOnly?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.text);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const long = note.text.length > 280 || note.text.split('\n').length > 6;
  const fail = (e: unknown) => showToast(errorText(e), conversationId);
  const Icon = note.authorKind === 'addon' ? Bot : UserRound;
  return (
    <div className={`addon-note ${note.pinned ? 'is-pinned' : ''}`}>
      <div className="addon-note-head">
        <Icon size={12} />
        <span className="addon-note-author truncate">{note.authorName || (note.authorKind === 'addon' ? 'Add-on' : 'Người dùng')}</span>
        <span className="addon-note-time" title={new Date(note.updatedAt).toLocaleString('vi-VN')}>
          {timeText(note.updatedAt)}
        </span>
        {!readOnly && (
          <span className="addon-note-tools">
            <button className="icon-button" title={note.pinned ? 'Bỏ ghim' : 'Ghim'} aria-label={note.pinned ? 'Bỏ ghim' : 'Ghim'} onClick={() => void addons.updateNote(conversationId, note.id, { pinned: !note.pinned }).catch(fail)}>
              {note.pinned ? <PinOff size={12} /> : <Pin size={12} />}
            </button>
            {note.authorKind === 'user' && (
              <button className="icon-button" title="Sửa" aria-label="Sửa" onClick={() => setEditing(true)}>
                <FileText size={12} />
              </button>
            )}
            <button
              className={`icon-button ${confirmDelete ? 'is-danger' : ''}`}
              title={confirmDelete ? 'Bấm lần nữa để xoá' : 'Xoá'}
              aria-label="Xoá"
              onClick={() => (confirmDelete ? void addons.deleteNote(conversationId, note.id).catch(fail) : setConfirmDelete(true))}
              onBlur={() => setConfirmDelete(false)}
            >
              <Trash2 size={12} />
            </button>
          </span>
        )}
      </div>
      {editing ? (
        <div className="addon-note-compose">
          <textarea className="addon-note-input" rows={3} value={text} autoFocus onChange={(e) => setText(e.target.value)} />
          <div className="addon-row-end">
            <button className="btn" onClick={() => (setEditing(false), setText(note.text))}>
              Huỷ
            </button>
            <button
              className="btn btn-prominent"
              disabled={!text.trim()}
              onClick={() => void addons.updateNote(conversationId, note.id, { text: text.trim() }).then(() => setEditing(false), fail)}
            >
              Lưu
            </button>
          </div>
        </div>
      ) : (
        <div className={`addon-note-text selectable ${long && !expanded ? 'is-clamped' : ''}`} onClick={() => long && setExpanded(true)}>
          {note.text}
        </div>
      )}
      {note.tags.length > 0 && (
        <div className="addon-badges">
          {note.tags.map((t) => (
            <span key={t} className="addon-badge">
              {t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function PanelView({ panel, conversationId }: { panel: AddonPanel; conversationId: string }) {
  return (
    <div className="addon-panel">
      {panel.blocks.map((b, i) => (
        <Block key={i} block={b} addonId={panel.addonId} conversationId={conversationId} />
      ))}
    </div>
  );
}

function Block({ block: b, addonId, conversationId }: { block: PanelBlock; addonId: string; conversationId: string }) {
  switch (b.type) {
    case 'heading':
      return <div className="addon-panel-heading">{b.text}</div>;
    case 'text':
      return <div className={`addon-panel-text selectable ${b.muted ? 'is-muted' : ''}`}>{b.text}</div>;
    case 'kv':
      return (
        <dl className="addon-kv">
          {b.items.map((it, i) => (
            <div key={i} className="addon-kv-row">
              <dt>{it.label}</dt>
              <dd className="selectable">{it.value}</dd>
            </div>
          ))}
        </dl>
      );
    case 'list': {
      const Tag = b.ordered ? 'ol' : 'ul';
      return (
        <Tag className="addon-panel-list">
          {b.items.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </Tag>
      );
    }
    case 'badges':
      return (
        <div className="addon-badges">
          {b.items.map((t) => (
            <span key={t} className="addon-badge">
              {t}
            </span>
          ))}
        </div>
      );
    case 'progress':
      return (
        <div className="addon-progress" title={`${Math.round(b.value * 100)}%`}>
          <div className="addon-progress-label">
            <span>{b.label}</span>
            <span className="nums">{Math.round(b.value * 100)}%</span>
          </div>
          <div className="addon-progress-track">
            <div className="addon-progress-bar" style={{ width: `${b.value * 100}%` }} />
          </div>
        </div>
      );
    case 'button':
      return (
        <button
          className={`btn ${b.style === 'primary' ? 'btn-prominent' : ''} addon-panel-button`}
          onClick={() => void addons.runAction({ addonId, actionId: b.action, conversationId, payload: b.payload }).catch((e) => showToast(errorText(e), conversationId))}
        >
          {b.label}
        </button>
      );
    case 'divider':
      return <hr className="addon-divider" />;
    default:
      return null;
  }
}

// MARK: - Composer

/** `/word` at the start of an otherwise empty draft. */
const slashQuery = (text: string): string | null => {
  const m = /^\/([^\s/]*)$/.exec(text);
  return m ? m[1].toLowerCase() : null;
};

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').toLowerCase();

/**
 * Above the composer: the add-ons' reply suggestions, `composer` views and actions, and the `/` quick reply picker
 * (keys: ↑ ↓ choose, Enter / Tab insert, Esc close — taken before the composer sees them).
 */
export function AddonComposerBar({
  conversationId,
  conversationName,
  isGroup,
  draftText,
  onReplaceDraft,
}: {
  conversationId: string;
  conversationName: string;
  isGroup: boolean;
  draftText: string;
  onReplaceDraft: (text: string) => void;
}) {
  const ws = useWorkspace(conversationId);
  const quickReplies = useAddonCatalog((s) => s.quickReplies);
  const allViews = useAddonCatalog((s) => s.views);
  const views = useMemo(() => allViews.filter((v) => v.location === 'composer'), [allViews]);
  const composerActions = (ws?.actions ?? []).filter((a) => a.context === 'composer');
  const suggestions = ws?.suggestions ?? [];

  const query = slashQuery(draftText);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const matches = useMemo(() => {
    if (query === null) return [];
    const q = fold(query);
    return quickReplies.filter((r) => fold(r.shortcut).startsWith(q) || (q.length > 1 && fold(`${r.title} ${r.text}`).includes(q))).slice(0, 8);
  }, [query, quickReplies]);
  const open = query !== null && matches.length > 0 && dismissedFor !== draftText;
  const [index, setIndex] = useState(0);
  useEffect(() => setIndex(0), [query]);

  const choose = (r: QuickReply) => onReplaceDraft(expandTemplate(r.text, conversationName));

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest('.chat-bottom')) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
      } else if ((e.key === 'Enter' && !e.shiftKey && !e.isComposing) || e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        const r = matches[Math.min(index, matches.length - 1)];
        if (r) choose(r);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setDismissedFor(draftText);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, matches, index, draftText]);

  if (!open && suggestions.length === 0 && views.length === 0 && composerActions.length === 0) return null;
  return (
    <div className="addon-composer-bar">
      {open && (
        <div className="addon-quick-replies glass-strong" role="listbox" aria-label="Tin nhắn nhanh">
          <div className="addon-quick-head">
            <Zap size={12} /> Tin nhắn nhanh · ↑↓ chọn · Enter chèn
          </div>
          {matches.map((r, i) => (
            <button
              key={`${r.addonId}:${r.shortcut}`}
              role="option"
              aria-selected={i === index}
              className={`addon-quick-row ${i === index ? 'is-selected' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(r);
              }}
            >
              <span className="addon-quick-shortcut">/{r.shortcut}</span>
              <span className="addon-quick-text truncate">{expandTemplate(r.text, conversationName).replace(/\n/g, ' ↵ ')}</span>
            </button>
          ))}
        </div>
      )}
      {suggestions.map((s) => (
        <SuggestionCard key={s.id} suggestion={s} conversationId={conversationId} onEdit={(t) => onReplaceDraft(t)} />
      ))}
      {composerActions.length > 0 && (
        <div className="addon-actions is-composer">
          {composerActions.map((a) => (
            <button key={`${a.addonId}:${a.id}`} className="addon-action" title={a.description || a.addonName} onClick={() => runAction(a, conversationId)}>
              <Sparkles size={12} />
              <span className="truncate">{a.title}</span>
            </button>
          ))}
        </div>
      )}
      {views.map((v) => (
        <div key={`${v.addonId}:${v.id}`} className="addon-inline-frame is-composer">
          <AddonFrame view={v} context={{ conversationId, conversationName, isGroup }} minHeight={28} />
        </div>
      ))}
    </div>
  );
}

function SuggestionCard({ suggestion: s, conversationId, onEdit }: { suggestion: AddonSuggestion; conversationId: string; onEdit: (text: string) => void }) {
  const [busy, setBusy] = useState(false);
  const resolve = (outcome: 'used' | 'sent' | 'dismissed') => {
    setBusy(true);
    if (outcome === 'used') onEdit(s.text);
    void addons
      .resolveSuggestion(conversationId, s.id, outcome)
      .catch((e) => showToast(errorText(e), conversationId))
      .finally(() => setBusy(false));
  };
  return (
    <div className="addon-suggestion" role="group" aria-label={`Gợi ý từ ${s.addonName}`}>
      <div className="addon-suggestion-head">
        <Sparkles size={12} />
        <span className="truncate">{s.title || 'Gợi ý trả lời'}</span>
        <span className="addon-suggestion-from truncate">· {s.addonName}</span>
        <span className="conv-tabs-spacer" />
        <button className="icon-button" disabled={busy} onClick={() => resolve('dismissed')} title="Bỏ qua" aria-label="Bỏ qua gợi ý">
          <X size={13} />
        </button>
      </div>
      <div className="addon-suggestion-text selectable">{s.text}</div>
      <div className="addon-row-end">
        <button className="btn" disabled={busy} onClick={() => resolve('used')}>
          Sửa trước khi gửi
        </button>
        <button className="btn btn-prominent" disabled={busy} onClick={() => resolve('sent')}>
          <Send size={12} /> Gửi
        </button>
      </div>
    </div>
  );
}
