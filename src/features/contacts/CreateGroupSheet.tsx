// "Tạo nhóm": the official group compose (CREATE_GROUP_COMPOSE) as a Zalo PC-style dialog (Swift CreateGroupSheet.swift; wave-4
// refs in docs/design-refs/wave4/create-group). Group photo + name on top, a search, tabs Tất cả / Trò chuyện gần đây / Phân loại,
// then two panes: the friends to pick (round checkboxes, A–Z letters) and the picks ("Đã chọn N/100", × to remove). Rules and
// limits are the official ones (engine/groupCreate.ts); "Tạo nhóm" runs the official create, then the new group opens.

import { Ban, Camera, Check, ChevronDown, Search, Tag, Trash2, UserRound, Users, X, XCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usesMock } from '../../engine/backend';
import { contactFold, useContacts } from '../../engine/contacts';
import {
  blockedText,
  clampGroupName,
  createGroup,
  defaultLimits,
  groupCreateLimitsWhenReady,
  invalidNameText,
  isValidGroupName,
  makeGroupAvatar,
  makeRoster,
  overLimitText,
  rosterMatching,
  rosterPerson,
  rosterSections,
  toggleSelection,
  type GroupAvatarImage,
  type GroupCreateLimits,
  type RosterPerson,
} from '../../engine/groupCreate';
import { useEngine, visibleConversations } from '../../engine/store';
import { Avatar } from '../../ui/Avatar';
import { ContentUnavailable } from '../../ui/ContentUnavailable';
import { openMenuBelow } from '../../ui/Menu';
import { Alert, Sheet } from '../../ui/Overlays';
import { Spinner } from '../../ui/Spinner';
import { useVisibleFriends } from './ContactsView';
import type { GroupComposeRequest } from './contactsUi';
import './contacts.css';
import './createGroup.css';

/** Why the group was not created. `closes`: the official compose closes after this one (quota check). */
interface Problem {
  title: string;
  message: string;
  closes: boolean;
}

/** The list tab: everyone, the recent 1:1 chats, or the friends of one "Phân loại" label. */
type Tab = { kind: 'all' } | { kind: 'recent' } | { kind: 'label'; id: string };

/** Mock-only dev aid: `&cgTab=recent|label` opens the sheet on that tab (screenshots). */
const initialTab = (): Tab => {
  if (!usesMock) return { kind: 'all' };
  const t = new URLSearchParams(location.search).get('cgTab');
  if (t === 'recent') return { kind: 'recent' };
  if (t === 'label') return { kind: 'label', id: 'l-work' };
  return { kind: 'all' };
};

export function CreateGroupSheet({ request, onClose }: { request: GroupComposeRequest; onClose: () => void }) {
  const friendsLoaded = useContacts((s) => s.friendsLoaded);
  const allFriends = useContacts((s) => s.friends);
  const hiddenKnown = useEngine((s) => s.conversationActions.hiddenKnown);
  const conversations = useEngine((s) => s.conversations);
  const actions = useEngine((s) => s.conversationActions);
  const selfId = useEngine((s) => s.selfConversationId);
  const labels = useEngine((s) => s.extras.labels);
  const friends = useVisibleFriends();

  const [limits, setLimits] = useState<GroupCreateLimits>(defaultLimits);
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<Tab>(initialTab);
  const [selection, setSelection] = useState<string[]>(request.members);
  const [avatar, setAvatar] = useState<GroupAvatarImage | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<{ id: number; text: string } | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pickedRef = useRef<HTMLDivElement>(null);

  const roster = useMemo(
    () => makeRoster(friends, visibleConversations(useEngine.getState()), selfId, limits.officialAccounts),
    [friends, conversations, actions, selfId, limits],
  );
  const nameIsValid = isValidGroupName(limits, name);
  const canCreate = selection.length > 1 && nameIsValid && !creating;
  const atLimit = selection.length >= limits.maxMembers;
  const label = tab.kind === 'label' ? (labels.find((l) => l.id === tab.id) ?? null) : null;

  useEffect(() => {
    nameInput.current?.focus();
    // Picks handed in by the caller that are not friends are dropped (only friends can be added). A friend whose chat is hidden
    // stays picked — the official compose adds the conversation's user whatever its state — even though the list does not show them.
    const state = useContacts.getState();
    if (state.friendsLoaded) {
      const ids = new Set(state.friends.map((f) => f.id));
      setSelection((s) => s.filter((id) => ids.has(id)));
    }
    let cancelled = false;
    void groupCreateLimitsWhenReady(() => cancelled).then((loaded) => {
      if (!loaded || cancelled) return;
      setLimits(loaded);
      setSelection((s) => s.filter((id) => !loaded.blocked.has(id)));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // A label deleted meanwhile takes its tab with it.
  useEffect(() => {
    if (tab.kind === 'label' && !label && useEngine.getState().extras.loaded) setTab({ kind: 'all' });
  }, [tab, label, labels]);

  // The newest pick scrolls into view at the bottom of the "Đã chọn" pane.
  useEffect(() => {
    const el = pickedRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [selection.length]);

  const flash = (text: string) => {
    const shown = { id: Date.now(), text };
    setNotice(shown);
    setTimeout(() => setNotice((n) => (n === shown ? null : n)), 2500);
  };

  const toggle = (id: string) => {
    const { ids, change } = toggleSelection(selection, id, limits);
    setSelection(ids);
    if (change === 'added' && query) {
      setQuery('');
      searchInput.current?.focus();
    } else if (change === 'overLimit') flash(overLimitText(limits));
    else if (change === 'blocked') flash(blockedText);
  };

  /** Official `onCancel`: with a group ready to create (2 picks) it asks first. */
  const cancel = () => {
    if (creating) return;
    if (selection.length > 1) setConfirmCancel(true);
    else onClose();
  };

  const create = async () => {
    if (!canCreate) return;
    setCreating(true);
    const outcome = await createGroup(name.trim(), selection, avatar);
    setCreating(false);
    switch (outcome.kind) {
      case 'created':
      case 'exists':
      case 'pending':
        onClose();
        return;
      case 'invalid':
        setSelection((s) => s.filter((id) => !outcome.dropped.includes(id)));
        setProblem({ title: 'Không thể tạo nhóm', message: outcome.text, closes: false });
        return;
      case 'failed':
        setProblem({ title: outcome.title ?? 'Không thể tạo nhóm', message: outcome.message, closes: outcome.closes });
    }
  };

  const loadAvatar = async (file: File | undefined) => {
    if (!file) return;
    const result = await makeGroupAvatar(file);
    if ('ok' in result) setAvatar(result.ok);
    else setProblem({ title: 'Không thể dùng ảnh này', message: result.error, closes: false });
  };

  const personOf = (id: string): RosterPerson | null => {
    const known = roster.friends.find((p) => p.id === id);
    if (known) return known;
    const friend = allFriends.find((f) => f.id === id);
    return friend ? rosterPerson(friend) : null;
  };

  // MARK: List

  const needle = contactFold(query).trim();
  const matches = (p: RosterPerson) => !needle || p.sortKey.includes(needle) || p.zaloKey.includes(needle);
  const labelPeople = (): RosterPerson[] => {
    if (!label) return [];
    const ids = new Set(label.convIds);
    return roster.friends.filter((p) => ids.has(p.id));
  };

  const row = (person: RosterPerson, keyPrefix = '') => {
    const blocked = limits.blocked.has(person.id);
    const checked = selection.includes(person.id);
    const unavailable = !checked && !blocked && atLimit;
    return (
      <button
        key={keyPrefix + person.id}
        className={`cg-row ${checked ? 'is-checked' : ''} ${blocked ? 'is-blocked' : ''} ${unavailable ? 'is-unavailable' : ''}`}
        onClick={() => toggle(person.id)}
        aria-label={person.name}
        aria-pressed={checked}
        title={blocked ? blockedText : unavailable ? overLimitText(limits) : undefined}
      >
        <span className={`cg-check ${checked ? 'is-on' : ''}`} aria-hidden>
          {blocked ? <Ban size={14} /> : checked ? <Check size={12} strokeWidth={3} /> : null}
        </span>
        <Avatar url={person.avatar} name={person.name} size={36} />
        <span className="cg-row-text">
          <span className="cg-row-name truncate">{person.name}</span>
          {blocked && <span className="cg-row-sub">Đã chặn</span>}
        </span>
      </button>
    );
  };

  const noResults = (
    <ContentUnavailable icon={Search} title={`Không có kết quả cho “${query.trim()}”`} description="Hãy kiểm tra chính tả hoặc thử tìm kiếm khác." />
  );

  let list: ReactNode;
  if (!friendsLoaded || !hiddenKnown) {
    list = (
      <div className="cg-loading">
        <Spinner size={14} />
        <span>Đang tải danh sách bạn bè…</span>
      </div>
    );
  } else if (roster.friends.length === 0) {
    list = <ContentUnavailable icon={Users} title="Chưa có bạn bè" description="Nhóm được tạo từ danh sách bạn bè của bạn." />;
  } else if (tab.kind === 'recent') {
    const people = roster.recent.filter(matches);
    list = people.length ? (
      <div className="cg-list">{people.map((p) => row(p, 'recent-'))}</div>
    ) : needle ? (
      noResults
    ) : (
      <ContentUnavailable icon={UserRound} title="Chưa có trò chuyện gần đây" description="Các cuộc trò chuyện 1-1 mới nhất với bạn bè sẽ hiện ở đây." />
    );
  } else if (tab.kind === 'label') {
    const people = labelPeople().filter(matches);
    list = people.length ? (
      <div className="cg-list">{people.map((p) => row(p, 'label-'))}</div>
    ) : needle ? (
      noResults
    ) : (
      <ContentUnavailable icon={Tag} title="Không có bạn bè trong thẻ này" description="Gắn thẻ phân loại cho cuộc trò chuyện 1-1 để lọc bạn bè ở đây." />
    );
  } else if (needle) {
    const results = rosterMatching(roster, query);
    list = results.length ? <div className="cg-list">{results.map((p) => row(p))}</div> : noResults;
  } else {
    list = (
      <div className="cg-list">
        {roster.recent.length > 0 && (
          <>
            <div className="cg-heading" role="heading" aria-level={3}>
              Trò chuyện gần đây
            </div>
            {roster.recent.map((p) => row(p, 'recent-'))}
          </>
        )}
        {rosterSections(roster).map((section) => (
          <div key={section.title}>
            <div className="cg-heading" role="heading" aria-level={3}>
              {section.title}
            </div>
            {section.people.map((p) => row(p))}
          </div>
        ))}
      </div>
    );
  }

  // MARK: Tabs

  const labelMenu = (el: Element) =>
    openMenuBelow(
      el,
      labels.length
        ? labels.map((l) => ({
            label: l.name,
            dot: l.colorHex,
            checked: tab.kind === 'label' && tab.id === l.id,
            onSelect: () => setTab({ kind: 'label', id: l.id }),
          }))
        : [{ label: 'Chưa có thẻ phân loại', disabled: true, onSelect: () => {} }],
    );

  const avatarFace = avatar ? (
    <img src={avatar.dataUrl} alt="" draggable={false} />
  ) : (
    <span className="cg-avatar-empty">
      <Camera size={20} />
    </span>
  );

  const remaining = Math.max(0, limits.maxMembers - selection.length);

  return (
    <Sheet onClose={cancel} width={720} height={620}>
      <div className={`cg ${creating ? 'is-creating' : ''}`}>
        <div className="cg-header">
          <div className="cg-title">Tạo nhóm</div>
          <button className="cg-close" onClick={cancel} aria-label="Đóng" title="Đóng" disabled={creating}>
            <X size={18} />
          </button>
        </div>

        <div className="cg-identity">
          <button
            className="cg-avatar"
            title={avatar ? 'Ảnh đại diện của nhóm' : 'Chọn ảnh đại diện cho nhóm (hoặc kéo ảnh vào đây)'}
            aria-label="Ảnh đại diện nhóm"
            disabled={creating}
            onClick={(e) => {
              if (!avatar) return fileInput.current?.click();
              openMenuBelow(e.currentTarget, [
                { label: 'Đổi ảnh đại diện', icon: Camera, onSelect: () => fileInput.current?.click() },
                { label: 'Xoá ảnh đại diện', icon: Trash2, destructive: true, onSelect: () => setAvatar(null) },
              ]);
            }}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('Files')) e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
              void loadAvatar(e.dataTransfer.files[0]);
            }}
          >
            {avatarFace}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              void loadAvatar(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <div className="cg-name">
            <input
              ref={nameInput}
              className={`cg-name-field ${nameIsValid ? '' : 'is-invalid'}`}
              value={name}
              placeholder="Nhập tên nhóm..."
              disabled={creating}
              onChange={(e) => setName(clampGroupName(limits, e.target.value))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) void create();
              }}
              aria-label="Tên nhóm"
            />
            <div className={`cg-name-hint ${nameIsValid ? '' : 'is-invalid'}`}>
              {nameIsValid ? 'Để trống để dùng tên các thành viên' : invalidNameText}
            </div>
          </div>
        </div>

        <label className="cg-search">
          <Search size={15} className="cg-search-icon" />
          <input
            ref={searchInput}
            value={query}
            placeholder="Nhập tên bạn bè"
            spellCheck={false}
            disabled={creating}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Nhập tên bạn bè"
          />
          {query && (
            <button className="cg-search-clear" onClick={() => setQuery('')} aria-label="Xoá tìm kiếm">
              <XCircle size={15} fill="currentColor" stroke="var(--surface)" />
            </button>
          )}
        </label>

        <div className="cg-tabs" role="tablist">
          <button role="tab" aria-selected={tab.kind === 'all'} className={`cg-tab ${tab.kind === 'all' ? 'is-active' : ''}`} onClick={() => setTab({ kind: 'all' })}>
            Tất cả
          </button>
          <button
            role="tab"
            aria-selected={tab.kind === 'recent'}
            className={`cg-tab ${tab.kind === 'recent' ? 'is-active' : ''}`}
            onClick={() => setTab({ kind: 'recent' })}
          >
            Trò chuyện gần đây
          </button>
          <button
            role="tab"
            aria-selected={tab.kind === 'label'}
            aria-haspopup="menu"
            className={`cg-tab cg-tab-menu ${tab.kind === 'label' ? 'is-active' : ''}`}
            onClick={(e) => labelMenu(e.currentTarget)}
          >
            {label && <span className="cg-tab-dot" style={{ background: label.colorHex }} />}
            <span className="truncate">{label ? label.name : 'Phân loại'}</span>
            <ChevronDown size={13} />
          </button>
        </div>

        <div className="cg-body">
          <div className="cg-pane cg-pane-list">{list}</div>

          <aside className="cg-pane cg-pane-picked" aria-label="Đã chọn">
            <div className="cg-picked-head">
              <span>
                Đã chọn{' '}
                <span className="nums">
                  {selection.length}/{limits.maxMembers}
                </span>
              </span>
              {selection.length > 0 && (
                <button className="cg-link" onClick={() => setSelection([])} disabled={creating}>
                  Bỏ chọn tất cả
                </button>
              )}
            </div>
            {selection.length === 0 ? (
              <div className="cg-picked-empty">
                <Users size={28} strokeWidth={1.5} />
                <span>Chọn ít nhất 2 người bạn để tạo nhóm</span>
              </div>
            ) : (
              <div className="cg-picked-list" ref={pickedRef}>
                {selection.map((id) => {
                  const person = personOf(id);
                  const shown = person?.name ?? 'Người dùng Zalo';
                  return (
                    <div key={id} className="cg-picked">
                      <Avatar url={person?.avatar} name={shown} size={28} />
                      <span className="cg-picked-name truncate">{shown}</span>
                      <button className="cg-picked-remove" onClick={() => toggle(id)} aria-label={`Bỏ chọn ${shown}`} title="Bỏ chọn" disabled={creating}>
                        <X size={13} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <div className={`cg-picked-foot ${atLimit ? 'is-limit' : ''}`}>
              {atLimit ? `Đã đạt giới hạn ${limits.maxMembers} thành viên` : `Có thể thêm ${remaining} người nữa`}
            </div>
          </aside>
        </div>

        <div className="cg-footer">
          <span className={`cg-footer-note ${notice ? 'is-notice' : ''}`} role="status">
            {notice ? notice.text : selection.length < 2 ? 'Chọn ít nhất 2 người' : ''}
          </span>
          <button className="ct-btn ct-btn-secondary" onClick={cancel} disabled={creating}>
            Hủy
          </button>
          <button className="ct-btn ct-btn-primary ct-btn-min" onClick={() => void create()} disabled={!canCreate}>
            {creating ? <Spinner size={13} className="on-accent" /> : 'Tạo nhóm'}
          </button>
        </div>
      </div>

      {confirmCancel && (
        <Alert
          title="Bạn muốn hủy tạo nhóm này?"
          buttons={[
            { label: 'Có', role: 'destructive', onClick: onClose },
            { label: 'Không', role: 'cancel', onClick: () => setConfirmCancel(false) },
          ]}
        />
      )}
      {problem && (
        <Alert
          title={problem.title}
          message={problem.message}
          buttons={[
            {
              label: problem.closes ? 'Đã hiểu' : 'OK',
              role: 'cancel',
              onClick: () => {
                const closes = problem.closes;
                setProblem(null);
                if (closes) onClose();
              },
            },
          ]}
        />
      )}
    </Sheet>
  );
}
