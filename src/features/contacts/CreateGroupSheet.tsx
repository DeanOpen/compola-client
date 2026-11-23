// "Tạo nhóm": the official group compose (CREATE_GROUP_COMPOSE) as a native sheet (Swift CreateGroupSheet.swift) — group photo
// and name, friends to pick ("Trò chuyện gần đây" then A–Z), the picks as removable chips. Rules and limits are the official ones
// (engine/groupCreate.ts); "Tạo nhóm" runs the official create, then the new group opens.

import { Ban, Camera, CheckCircle2, Circle, Search, Trash2, Users, XCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useContacts } from '../../engine/contacts';
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

/** Why the group was not created. `closes`: the official compose closes after this one (quota check). */
interface Problem {
  title: string;
  message: string;
  closes: boolean;
}

export function CreateGroupSheet({ request, onClose }: { request: GroupComposeRequest; onClose: () => void }) {
  const friendsLoaded = useContacts((s) => s.friendsLoaded);
  const allFriends = useContacts((s) => s.friends);
  const hiddenKnown = useEngine((s) => s.conversationActions.hiddenKnown);
  const conversations = useEngine((s) => s.conversations);
  const actions = useEngine((s) => s.conversationActions);
  const selfId = useEngine((s) => s.selfConversationId);
  const friends = useVisibleFriends();

  const [limits, setLimits] = useState<GroupCreateLimits>(defaultLimits);
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState<string[]>(request.members);
  const [avatar, setAvatar] = useState<GroupAvatarImage | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<{ id: number; text: string } | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const chipsRef = useRef<HTMLDivElement>(null);

  const roster = useMemo(
    () => makeRoster(friends, visibleConversations(useEngine.getState()), selfId, limits.officialAccounts),
    [friends, conversations, actions, selfId, limits],
  );
  const nameIsValid = isValidGroupName(limits, name);
  const canCreate = selection.length > 1 && nameIsValid && !creating;

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

  useEffect(() => {
    const el = chipsRef.current;
    if (el) el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' });
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

  const searching = query.trim().length > 0;
  const row = (person: RosterPerson, keyPrefix = '') => {
    const blocked = limits.blocked.has(person.id);
    const checked = selection.includes(person.id);
    return (
      <button
        key={keyPrefix + person.id}
        className={`compose-row ${blocked ? 'is-blocked' : ''}`}
        onClick={() => toggle(person.id)}
        aria-label={person.name}
        aria-pressed={checked}
      >
        {blocked ? (
          <Ban size={18} className="compose-check" />
        ) : checked ? (
          <CheckCircle2 size={18} className="compose-check is-checked" fill="currentColor" stroke="#fff" />
        ) : (
          <Circle size={18} className="compose-check" />
        )}
        <Avatar url={person.avatar} name={person.name} size={34} />
        <span className="compose-row-text">
          <span className="truncate">{person.name}</span>
          {blocked && <span className="compose-row-sub">Đã chặn</span>}
        </span>
      </button>
    );
  };

  let list: ReactNode;
  if (!friendsLoaded || !hiddenKnown) {
    list = (
      <div className="contacts-loading">
        <Spinner size={14} />
        <span>Đang tải danh sách bạn bè…</span>
      </div>
    );
  } else if (roster.friends.length === 0) {
    list = <ContentUnavailable icon={Users} title="Chưa có bạn bè" description="Nhóm được tạo từ danh sách bạn bè của bạn." />;
  } else if (searching) {
    const results = rosterMatching(roster, query);
    list = results.length ? (
      <div className="compose-list">{results.map((p) => row(p))}</div>
    ) : (
      <ContentUnavailable icon={Search} title={`Không có kết quả cho “${query.trim()}”`} description="Hãy kiểm tra chính tả hoặc thử tìm kiếm khác." />
    );
  } else {
    list = (
      <div className="compose-list">
        {roster.recent.length > 0 && (
          <>
            <div className="compose-heading" role="heading" aria-level={3}>
              Trò chuyện gần đây
            </div>
            {roster.recent.map((p) => row(p, 'recent-'))}
          </>
        )}
        {rosterSections(roster).map((section) => (
          <div key={section.title}>
            <div className="compose-heading" role="heading" aria-level={3}>
              {section.title}
            </div>
            {section.people.map((p) => row(p))}
          </div>
        ))}
      </div>
    );
  }

  const avatarFace = avatar ? (
    <img src={avatar.dataUrl} alt="" draggable={false} />
  ) : (
    <span className="compose-avatar-empty">
      <Camera size={18} />
    </span>
  );

  return (
    <Sheet onClose={cancel} width={440} height={640}>
      <div className={`compose ${creating ? 'is-creating' : ''}`}>
        <div className="compose-title">Tạo nhóm</div>

        <div className="compose-identity">
          <button
            className="compose-avatar"
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
          <div className="compose-name">
            <input
              ref={nameInput}
              className={`compose-field ${nameIsValid ? '' : 'is-invalid'}`}
              value={name}
              placeholder="Nhập tên nhóm..."
              disabled={creating}
              onChange={(e) => setName(clampGroupName(limits, e.target.value))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) void create();
              }}
              aria-label="Tên nhóm"
            />
            <div className={`compose-name-hint ${nameIsValid ? '' : 'is-invalid'}`}>{nameIsValid ? 'Để trống để dùng tên các thành viên' : invalidNameText}</div>
          </div>
        </div>

        <label className="ct-search compose-search">
          <Search size={15} className="ct-search-icon" />
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
            <button className="ct-search-clear" onClick={() => setQuery('')} aria-label="Xoá tìm kiếm">
              <XCircle size={15} fill="currentColor" stroke="var(--ct-layer)" />
            </button>
          )}
        </label>

        {selection.length > 0 && (
          <div className="compose-chips" ref={chipsRef}>
            {selection.map((id) => {
              const person = personOf(id);
              return (
                <span key={id} className="compose-chip">
                  <Avatar url={person?.avatar} name={person?.name ?? ''} size={20} />
                  <span className="truncate">{person?.name ?? 'Người dùng Zalo'}</span>
                  <button onClick={() => toggle(id)} aria-label={`Bỏ chọn ${person?.name ?? ''}`} disabled={creating}>
                    <XCircle size={13} fill="currentColor" stroke="var(--ct-selected)" />
                  </button>
                </span>
              );
            })}
          </div>
        )}

        <div className="compose-body">{list}</div>

        <div className="compose-footer">
          {notice && <div className="compose-notice fade-in">{notice.text}</div>}
          <div className="compose-footer-row">
            <span className="compose-count nums">{selection.length < 2 ? 'Chọn ít nhất 2 người' : `Đã chọn ${selection.length}/${limits.maxMembers}`}</span>
            <span style={{ flex: 1 }} />
            <button className="ct-btn ct-btn-secondary" onClick={cancel} disabled={creating}>
              Hủy
            </button>
            <button className="ct-btn ct-btn-primary ct-btn-min" onClick={() => void create()} disabled={!canCreate}>
              {creating ? <Spinner size={13} className="on-accent" /> : 'Tạo nhóm'}
            </button>
          </div>
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
