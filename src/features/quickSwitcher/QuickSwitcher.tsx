// ⌘K palette over the main window (Swift `QuickSwitcher`): jump to a conversation or run a command. It only searches
// what the engine lists as visible, so hidden chats never appear. (Danh bạ hits arrive with the contacts wave.)

import { Cloud, HardDrive, HelpCircle, Inbox, MessagesSquare, Search, Settings, Users, XCircle, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { inboxTitle, typeFilterTitle, TypeFilter, type ConversationSummary } from '../../engine/models/conversations';
import { useEngine, visibleConversations } from '../../engine/store';
import { shell, useShell, type Destination } from '../../shell/shellStore';
import { Avatar } from '../../ui/Avatar';
import { useEscape } from '../../ui/escape';
import { appName } from '../setup/SplashView';
import { conversationTitle, fold } from '../conversations/support';
import './quickSwitcher.css';

type Row = {
  id: string;
  leading: { kind: 'avatar'; url: string | null; name: string } | { kind: 'cloud' } | { kind: 'symbol'; icon: LucideIcon };
  title: string;
  subtitle?: string;
  unread?: number;
  shortcut?: string;
  run: () => void;
  disabled?: boolean;
};

const commands: { title: string; icon: LucideIcon; shortcut?: string; destination?: Destination; disabled?: boolean }[] = [
  { title: `Đi tới ${inboxTitle}`, icon: Inbox, shortcut: '⌥⌘1', destination: 'inbox' },
  { title: `Đi tới ${typeFilterTitle(TypeFilter.unread)}`, icon: MessagesSquare, shortcut: '⌥⌘3', destination: 'unread' },
  { title: 'Đi tới Danh bạ', icon: Users, shortcut: '⌥⌘5', destination: 'friends' },
  { title: 'Đi tới zCloud', icon: HardDrive, shortcut: '⌥⌘6', destination: 'zcloud' },
  { title: 'Mở Cài đặt…', icon: Settings, shortcut: '⌘,', disabled: true },
  { title: `Hướng dẫn sử dụng ${appName}`, icon: HelpCircle, disabled: true },
];

export function QuickSwitcher() {
  const open = useShell((s) => s.showQuickSwitcher);
  return open ? <QuickSwitcherPanel /> : null;
}

function QuickSwitcherPanel() {
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const ignoreHoverUntil = useRef(Date.now() + 350);
  const list = useRef<HTMLDivElement>(null);
  const conversations = useEngine((s) => s.conversations);
  const selfId = useEngine((s) => s.selfConversationId);
  const hiddenKnown = useEngine((s) => s.conversationActions.hiddenKnown);
  useEscape(true, shell.closeQuickSwitcher);

  const sections = useMemo(() => {
    const needle = fold(query.trim());
    const recent = [...visibleConversations(useEngine.getState())].sort((a, b) => (b.preview?.date ?? 0) - (a.preview?.date ?? 0));
    const hits = needle ? recent.filter((c) => fold(conversationTitle(c, selfId)).includes(needle)).slice(0, 8) : recent.slice(0, 8);
    const out: { title: string; rows: Row[] }[] = [];
    if (hits.length) out.push({ title: needle ? 'Cuộc trò chuyện' : 'Gần đây', rows: hits.map((c) => conversationRow(c, selfId)) });
    const cmds = commands.filter((c) => !needle || fold(c.title).includes(needle));
    if (cmds.length) {
      out.push({
        title: 'Lệnh',
        rows: cmds.map((c) => ({
          id: `k:${c.title}`,
          leading: { kind: 'symbol', icon: c.icon },
          title: c.title,
          shortcut: c.shortcut,
          disabled: c.disabled,
          run: () => c.destination && shell.setDestination(c.destination),
        })),
      });
    }
    return out;
  }, [query, conversations, selfId]);

  const rows = sections.flatMap((s) => s.rows);
  const current = rows.find((r) => r.id === highlighted) ?? rows[0];

  useEffect(() => setHighlighted(null), [query]);

  const perform = (row: Row) => {
    if (row.disabled) return;
    shell.closeQuickSwitcher();
    row.run();
  };

  const move = (step: number) => {
    if (!rows.length) return;
    const index = current ? rows.findIndex((r) => r.id === current.id) : 0;
    const next = rows[Math.min(Math.max(index + step, 0), rows.length - 1)];
    ignoreHoverUntil.current = Date.now() + 400;
    setHighlighted(next.id);
    list.current?.querySelector(`[data-row="${CSS.escape(next.id)}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (current) perform(current);
    }
  };

  const text = query.trim();
  const empty = !hiddenKnown ? 'Đang đồng bộ hội thoại…' : text ? `Không có kết quả cho “${text}”` : 'Chưa có cuộc trò chuyện';

  return (
    <div className="qs-layer fade-in" onMouseDown={(e) => e.target === e.currentTarget && shell.closeQuickSwitcher()}>
      <div className="qs-panel glass-strong pop-in" role="dialog" aria-label="Đi tới">
        <div className="qs-search">
          <Search size={18} className="secondary" />
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeyDown} placeholder="Đi tới cuộc trò chuyện, người hoặc lệnh" spellCheck={false} />
          {query && (
            <button className="icon-button" onClick={() => setQuery('')} aria-label="Xóa">
              <XCircle size={15} fill="currentColor" stroke="var(--content)" />
            </button>
          )}
        </div>
        {sections.length === 0 ? (
          <div className="qs-empty">{empty}</div>
        ) : (
          <div className="qs-results" ref={list}>
            {sections.map((section) => (
              <div key={section.title}>
                <div className="qs-section">{section.title}</div>
                {section.rows.map((row) => (
                  <button
                    key={row.id}
                    data-row={row.id}
                    className={`qs-row ${row.id === current?.id ? 'is-highlighted' : ''}`}
                    disabled={row.disabled}
                    onClick={() => perform(row)}
                    onMouseMove={() => Date.now() >= ignoreHoverUntil.current && setHighlighted(row.id)}
                  >
                    <Leading row={row} />
                    <span className="qs-row-text">
                      <span className={`truncate ${row.unread ? 'is-unread' : ''}`}>{row.title}</span>
                      {row.subtitle && <span className="qs-row-sub truncate">{row.subtitle}</span>}
                    </span>
                    {!!row.unread && <span className="qs-unread nums">{row.unread > 99 ? '99+' : row.unread}</span>}
                    {row.shortcut && <span className="qs-shortcut">{row.shortcut}</span>}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
        <div className="qs-footer" aria-hidden>
          <Hint k="↑↓" label="Chọn" />
          <Hint k="↩" label="Mở" />
          <Hint k="esc" label="Đóng" />
        </div>
      </div>
    </div>
  );
}

const conversationRow = (c: ConversationSummary, selfId: string | null): Row => {
  const isSelf = c.id === selfId;
  const title = conversationTitle(c, selfId);
  const subtitle = c.preview?.text ? (c.preview.fromMe ? 'Bạn: ' : '') + c.preview.text : c.isGroup && c.members > 0 ? `${c.members} thành viên` : undefined;
  return {
    id: `c:${c.id}`,
    leading: isSelf ? { kind: 'cloud' } : { kind: 'avatar', url: c.avatar, name: title },
    title,
    subtitle,
    unread: c.unread,
    run: () => shell.open(c.id),
  };
};

function Leading({ row }: { row: Row }) {
  const l = row.leading;
  if (l.kind === 'avatar') return <Avatar url={l.url} name={l.name} size={28} className="qs-avatar" />;
  if (l.kind === 'cloud')
    return (
      <span className="qs-cloud">
        <Cloud size={13} fill="currentColor" />
      </span>
    );
  const Icon = l.icon;
  return (
    <span className="qs-symbol">
      <Icon size={14} />
    </span>
  );
}

function Hint({ k, label }: { k: string; label: string }) {
  return (
    <span className="qs-hint">
      <span className="kbd">{k}</span>
      {label}
    </span>
  );
}
