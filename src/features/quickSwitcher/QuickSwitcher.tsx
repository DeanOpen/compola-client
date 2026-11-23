// ⌘K palette over the main window (Swift `QuickSwitcher`): jump to a conversation, a friend or a group, or run a
// command. Zalo PC look with command-palette patterns (docs/design-refs/wave4/quick-switcher): scope chips, grouped
// sections with counts, highlighted matches, an "Mở ↵" hint on the active row and a key-hint footer.
// It only searches what the engine lists as visible, so hidden chats (and hidden friends / groups) never appear.

import {
  ArrowRight,
  Cloud,
  CornerDownLeft,
  HardDrive,
  Inbox,
  MessagesSquare,
  RefreshCw,
  Search,
  SearchX,
  Settings,
  UserPlus,
  Users,
  UsersRound,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useContacts, visibleFriends, visibleGroups } from '../../engine/contacts';
import { inboxTitle, typeFilterTitle, TypeFilter, type ConversationSummary } from '../../engine/models/conversations';
import { useEngine, visibleConversations, type EngineState } from '../../engine/store';
import { shell, useShell, type Destination } from '../../shell/shellStore';
import { Avatar } from '../../ui/Avatar';
import { useEscape } from '../../ui/escape';
import { openAddFriend, openCreateGroup } from '../contacts/hosts';
import { conversationTitle, fold, listTime } from '../conversations/support';
import { openSettings } from '../settings/hosts';
import { openTransfer } from '../transfer/hosts';
import './quickSwitcher.css';

type Scope = 'all' | 'chats' | 'friends' | 'groups' | 'commands';

const scopes: { id: Scope; title: string }[] = [
  { id: 'all', title: 'Tất cả' },
  { id: 'chats', title: 'Trò chuyện' },
  { id: 'friends', title: 'Bạn bè' },
  { id: 'groups', title: 'Nhóm' },
  { id: 'commands', title: 'Lệnh' },
];

type Leading = { kind: 'avatar'; url: string | null; name: string; online?: boolean } | { kind: 'cloud' } | { kind: 'symbol'; icon: LucideIcon };

type Row = {
  id: string;
  leading: Leading;
  title: string;
  subtitle?: string;
  /** Right-hand meta (time of the last message, member count). */
  meta?: string;
  unread?: number;
  shortcut?: string;
  run: () => void;
};

type Section = { scope: Exclude<Scope, 'all'>; title: string; rows: Row[]; total: number };

/** Rows per section under "Tất cả" when searching; the section's own scope shows them all. */
const perSection = 5;

const commands: { title: string; icon: LucideIcon; shortcut?: string; keywords?: string; run: () => void }[] = [
  { title: 'Thêm bạn', icon: UserPlus, keywords: 'ket ban so dien thoai add friend', run: () => openAddFriend() },
  { title: 'Tạo nhóm', icon: UsersRound, shortcut: '⇧⌘N', keywords: 'nhom moi new group', run: () => openCreateGroup() },
  { title: `Đi tới ${inboxTitle}`, icon: Inbox, shortcut: '⌥⌘1', run: () => go('inbox') },
  { title: `Đi tới ${typeFilterTitle(TypeFilter.unread)}`, icon: MessagesSquare, shortcut: '⌥⌘3', run: () => go('unread') },
  { title: 'Đi tới Danh bạ', icon: Users, shortcut: '⌥⌘5', keywords: 'ban be contacts', run: () => go('friends') },
  { title: 'Đi tới Lời mời kết bạn', icon: UserPlus, keywords: 'loi moi requests', run: () => go('requests') },
  { title: 'Đi tới zCloud', icon: HardDrive, shortcut: '⌥⌘6', keywords: 'cloud luu tru', run: () => go('zcloud') },
  { title: 'Đồng bộ tin nhắn từ điện thoại…', icon: RefreshCw, keywords: 'sync transfer dong bo', run: () => openTransfer() },
  { title: 'Mở Cài đặt…', icon: Settings, shortcut: '⌘,', keywords: 'settings cai dat', run: () => openSettings() },
];

const go = (d: Destination) => shell.setDestination(d);

export function QuickSwitcher() {
  const open = useShell((s) => s.showQuickSwitcher);
  return open ? <QuickSwitcherPanel /> : null;
}

function QuickSwitcherPanel() {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<Scope>('all');
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const ignoreHoverUntil = useRef(Date.now() + 350);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const conversations = useEngine((s) => s.conversations);
  const selfId = useEngine((s) => s.selfConversationId);
  const hiddenKnown = useEngine((s) => s.conversationActions.hiddenKnown);
  const hiddenIds = useEngine((s) => s.conversationActions.hiddenIds);
  const contacts = useContacts();
  useEscape(true, shell.closeQuickSwitcher);

  const needle = fold(query.trim());

  const sections = useMemo(
    () => buildSections(useEngine.getState(), contacts, needle, scope, selfId),
    [needle, scope, conversations, selfId, hiddenKnown, hiddenIds, contacts],
  );

  const rows = sections.flatMap((s) => s.rows);
  const total = sections.reduce((n, s) => n + s.total, 0);
  const current = rows.find((r) => r.id === highlighted) ?? rows[0];

  useEffect(() => setHighlighted(null), [query, scope]);

  const perform = (row: Row) => {
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

  const cycleScope = (step: number) => {
    const i = scopes.findIndex((s) => s.id === scope);
    setScope(scopes[(i + step + scopes.length) % scopes.length].id);
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
    } else if (e.key === 'Tab') {
      e.preventDefault();
      cycleScope(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Backspace' && !query && scope !== 'all') {
      setScope('all');
    }
  };

  const text = query.trim();
  const looksLikePhone = /^\+?[\d\s.-]{6,}$/.test(text);

  return (
    <div className="qs-layer fade-in" onMouseDown={(e) => e.target === e.currentTarget && shell.closeQuickSwitcher()}>
      <div className="qs-panel pop-in" role="dialog" aria-label="Đi tới">
        <div className="qs-search">
          <Search size={18} className="qs-search-icon" />
          <input
            ref={input}
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Tìm trò chuyện, bạn bè, nhóm hoặc lệnh"
            spellCheck={false}
            aria-label="Tìm kiếm"
          />
          {query ? (
            <button className="qs-clear" onClick={() => (setQuery(''), input.current?.focus())} aria-label="Xóa" title="Xóa">
              <XCircle size={16} fill="currentColor" stroke="var(--content)" />
            </button>
          ) : (
            <span className="qs-kbd">⌘K</span>
          )}
        </div>

        <div className="qs-scopes" role="tablist" aria-label="Phạm vi tìm kiếm">
          {scopes.map((s) => (
            <button
              key={s.id}
              role="tab"
              aria-selected={scope === s.id}
              className={`qs-scope ${scope === s.id ? 'is-on' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setScope(s.id)}
            >
              {s.title}
            </button>
          ))}
        </div>

        {sections.length === 0 ? (
          <div className="qs-empty">
            <SearchX size={30} strokeWidth={1.5} className="qs-empty-icon" />
            <div className="qs-empty-title">
              {!hiddenKnown ? 'Đang đồng bộ hội thoại…' : text ? `Không có kết quả cho “${text}”` : 'Chưa có gì để hiển thị'}
            </div>
            {hiddenKnown && text && (
              <div className="qs-empty-desc">
                {looksLikePhone ? 'Tìm người dùng Zalo theo số điện thoại này?' : 'Thử tên khác, bỏ dấu, hoặc tìm bạn mới bằng số điện thoại.'}
              </div>
            )}
            {hiddenKnown && text && (
              <button className="qs-empty-action" onClick={() => (shell.closeQuickSwitcher(), openAddFriend())}>
                <UserPlus size={14} /> {looksLikePhone ? 'Tìm số điện thoại' : 'Thêm bạn'}
              </button>
            )}
          </div>
        ) : (
          <div className="qs-results" ref={list} role="listbox">
            {sections.map((section) => (
              <div key={section.scope} className="qs-group">
                <div className="qs-section">
                  <span>{section.title}</span>
                  {needle && <span className="qs-section-count nums">{section.total}</span>}
                  {scope === 'all' && section.total > section.rows.length && (
                    <button className="qs-see-all" onMouseDown={(e) => e.preventDefault()} onClick={() => setScope(section.scope)}>
                      Xem tất cả <ArrowRight size={12} />
                    </button>
                  )}
                </div>
                {section.rows.map((row) => {
                  const active = row.id === current?.id;
                  return (
                    <button
                      key={row.id}
                      data-row={row.id}
                      role="option"
                      aria-selected={active}
                      className={`qs-row ${active ? 'is-highlighted' : ''}`}
                      onClick={() => perform(row)}
                      onMouseMove={() => Date.now() >= ignoreHoverUntil.current && setHighlighted(row.id)}
                    >
                      <LeadingView leading={row.leading} />
                      <span className="qs-row-text">
                        <span className={`qs-row-title truncate ${row.unread ? 'is-unread' : ''}`}>
                          <Highlight text={row.title} needle={needle} />
                        </span>
                        {row.subtitle && <span className="qs-row-sub truncate">{row.subtitle}</span>}
                      </span>
                      <span className="qs-row-trailing">
                        {active ? (
                          <span className="qs-open">
                            Mở <CornerDownLeft size={12} />
                          </span>
                        ) : (
                          <>
                            {row.meta && <span className="qs-meta nums">{row.meta}</span>}
                            {!!row.unread && <span className="qs-unread nums">{row.unread > 99 ? '99+' : row.unread}</span>}
                            {row.shortcut && <span className="qs-shortcut">{row.shortcut}</span>}
                          </>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        <div className="qs-footer">
          <span className="qs-count nums">{sections.length ? (needle ? `${total} kết quả` : 'Gợi ý') : ''}</span>
          <span className="qs-hints" aria-hidden>
            <Hint keys={['↑', '↓']} label="Chọn" />
            <Hint keys={['↵']} label="Mở" />
            <Hint keys={['tab']} label="Đổi mục" />
            <Hint keys={['esc']} label="Đóng" />
          </span>
        </div>
      </div>
    </div>
  );
}

// MARK: - Sources

const buildSections = (
  engine: EngineState,
  contacts: ReturnType<typeof useContacts.getState>,
  needle: string,
  scope: Scope,
  selfId: string | null,
): Section[] => {
  const want = (s: Exclude<Scope, 'all'>) => scope === 'all' || scope === s;
  const cap = (rows: Row[]) => (scope === 'all' ? rows.slice(0, needle ? perSection : 6) : rows.slice(0, 60));
  const out: Section[] = [];

  const recent = [...visibleConversations(engine)].sort((a, b) => (b.preview?.date ?? 0) - (a.preview?.date ?? 0));
  const convHits = needle ? recent.filter((c) => fold(conversationTitle(c, selfId)).includes(needle)) : recent;
  const shownIds = new Set<string>();
  if (want('chats') && convHits.length) {
    const rows = cap(convHits.map((c) => conversationRow(c, selfId)));
    rows.forEach((r) => shownIds.add(r.id.slice(2)));
    out.push({ scope: 'chats', title: needle ? 'Trò chuyện' : 'Trò chuyện gần đây', rows, total: convHits.length });
  }

  // Friends and groups only when searching (or in their own scope): with an empty query "Gần đây" already lists them.
  if (want('friends') && (needle || scope === 'friends')) {
    const friends = visibleFriends(contacts, engine).filter(
      (f) => (!needle || f.sortKey.includes(needle) || fold(f.zaloName).includes(needle)) && (scope === 'friends' || !shownIds.has(f.id)),
    );
    if (friends.length) {
      out.push({
        scope: 'friends',
        title: 'Bạn bè',
        total: friends.length,
        rows: cap(
          friends.map((f) => ({
            id: `f:${f.id}`,
            leading: { kind: 'avatar', url: f.avatar, name: f.name, online: f.online },
            title: f.name,
            subtitle: f.online ? 'Đang hoạt động' : f.zaloName && f.zaloName !== f.name ? f.zaloName : 'Bạn bè',
            run: () => shell.open(f.id),
          })),
        ),
      });
    }
  }

  if (want('groups') && (needle || scope === 'groups')) {
    const groups = visibleGroups(contacts, engine).filter(
      (g) => (!needle || g.sortKey.includes(needle)) && (scope === 'groups' || !shownIds.has(g.id)),
    );
    if (groups.length) {
      out.push({
        scope: 'groups',
        title: 'Nhóm',
        total: groups.length,
        rows: cap(
          groups.map((g) => ({
            id: `g:${g.id}`,
            leading: { kind: 'avatar', url: g.avatar, name: g.name },
            title: g.name,
            subtitle: g.members > 0 ? `${g.members.toLocaleString('vi-VN')} thành viên` : 'Nhóm',
            run: () => shell.open(g.id),
          })),
        ),
      });
    }
  }

  if (want('commands')) {
    const cmds = commands.filter((c) => !needle || fold(c.title).includes(needle) || (c.keywords ?? '').includes(needle));
    if (cmds.length) {
      out.push({
        scope: 'commands',
        title: 'Lệnh',
        total: cmds.length,
        rows: (scope === 'all' && needle ? cmds.slice(0, perSection) : cmds).map((c) => ({
          id: `k:${c.title}`,
          leading: { kind: 'symbol', icon: c.icon },
          title: c.title,
          shortcut: c.shortcut,
          run: c.run,
        })),
      });
    }
  }
  return out;
};

const conversationRow = (c: ConversationSummary, selfId: string | null): Row => {
  const isSelf = c.id === selfId;
  const title = conversationTitle(c, selfId);
  const subtitle = c.preview?.text ? (c.preview.fromMe ? 'Bạn: ' : '') + c.preview.text : c.isGroup && c.members > 0 ? `${c.members} thành viên` : undefined;
  return {
    id: `c:${c.id}`,
    leading: isSelf ? { kind: 'cloud' } : { kind: 'avatar', url: c.avatar, name: title },
    title,
    subtitle,
    meta: c.preview?.date ? listTime(c.preview.date) : undefined,
    unread: c.unread,
    run: () => shell.open(c.id),
  };
};

// MARK: - Pieces

/** The matched part of `text` in bold primary, found diacritic-insensitively (one folded char per source char). */
function Highlight({ text, needle }: { text: string; needle: string }): ReactNode {
  if (!needle) return text;
  const chars = [...text];
  const folded = chars.map((ch) => fold(ch).charAt(0) || ch);
  const at = folded.join('').indexOf(needle);
  if (at < 0) return text;
  // `folded` has one entry per code point, so the indices map back onto `chars`.
  const end = at + [...needle].length;
  return (
    <Fragment>
      {chars.slice(0, at).join('')}
      <mark className="qs-match">{chars.slice(at, end).join('')}</mark>
      {chars.slice(end).join('')}
    </Fragment>
  );
}

function LeadingView({ leading: l }: { leading: Leading }) {
  if (l.kind === 'avatar')
    return (
      <span className="qs-avatar-wrap">
        <Avatar url={l.url} name={l.name} size={36} className="qs-avatar" />
        {l.online && <span className="qs-online" aria-label="Đang hoạt động" />}
      </span>
    );
  if (l.kind === 'cloud')
    return (
      <span className="qs-cloud">
        <Cloud size={16} fill="currentColor" />
      </span>
    );
  const Icon = l.icon;
  return (
    <span className="qs-symbol">
      <Icon size={16} />
    </span>
  );
}

function Hint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span className="qs-hint">
      {keys.map((k) => (
        <span key={k} className="qs-key">
          {k}
        </span>
      ))}
      {label}
    </span>
  );
}
