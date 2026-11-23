// "Thêm bạn" dialog (Swift AddFriendForm + AddFriendDetail + FoundUserCard, in Zalo PC's dialog layout): country code + phone →
// the official find-by-phone → the profile card with its friend state → "Kết bạn" → the message step → the official
// `requestAddFriend`. Nothing is sent until "Gửi" is pressed; the search is reset when the dialog closes.

import { ChevronDown, Clock, MessageCircle, UserCheck, UserPlus, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  acceptFriendRequest,
  cancelFriendRequest,
  dismissSuggestion,
  findFriend,
  openContactConversation,
  resetFriendSearch,
  sendFriendRequest,
  useContacts,
  type FoundUser,
  type FriendSuggestion,
} from '../../engine/contacts';
import { Avatar } from '../../ui/Avatar';
import { openMenuBelow } from '../../ui/Menu';
import { Sheet } from '../../ui/Overlays';
import { Spinner } from '../../ui/Spinner';
import { DialogHeader } from './ContactsShared';
import { ProfileCover } from './ContactsView';

interface Country {
  iso: string;
  code: string;
  name: string;
}

const countries: Country[] = [
  { iso: 'VN', code: '+84', name: 'Việt Nam' },
  { iso: 'US', code: '+1', name: 'Hoa Kỳ' },
  { iso: 'AU', code: '+61', name: 'Úc' },
  { iso: 'CA', code: '+1', name: 'Canada' },
  { iso: 'CN', code: '+86', name: 'Trung Quốc' },
  { iso: 'DE', code: '+49', name: 'Đức' },
  { iso: 'FR', code: '+33', name: 'Pháp' },
  { iso: 'GB', code: '+44', name: 'Anh' },
  { iso: 'JP', code: '+81', name: 'Nhật Bản' },
  { iso: 'KH', code: '+855', name: 'Campuchia' },
  { iso: 'KR', code: '+82', name: 'Hàn Quốc' },
  { iso: 'LA', code: '+856', name: 'Lào' },
  { iso: 'MY', code: '+60', name: 'Malaysia' },
  { iso: 'SG', code: '+65', name: 'Singapore' },
  { iso: 'TH', code: '+66', name: 'Thái Lan' },
  { iso: 'TW', code: '+886', name: 'Đài Loan' },
];

// MARK: - "Có thể bạn quen"

/**
 * Suggestions of the official recommendation cache under the phone field: "Kết bạn" sends the official greeting right away,
 * ✕ asks the server to stop suggesting the person. People already requested or befriended drop out.
 */
function Suggestions() {
  const suggestions = useContacts((s) => s.suggestions);
  const sent = useContacts((s) => s.sent);
  const friends = useContacts((s) => s.friends);
  const [state, setState] = useState<Record<string, 'sending' | 'sent'>>({});
  const visible = useMemo(() => {
    const taken = new Set([...sent.map((r) => r.id), ...friends.map((f) => f.id)]);
    return suggestions.filter((x) => !taken.has(x.id) || state[x.id] === 'sent').slice(0, 20);
  }, [suggestions, sent, friends, state]);
  if (visible.length === 0) return null;

  const add = async (x: FriendSuggestion) => {
    setState((m) => ({ ...m, [x.id]: 'sending' }));
    const result = await sendFriendRequest(x.id, x.defaultMessage || 'Xin chào, mình kết bạn nhé!');
    setState((m) => {
      const next = { ...m };
      if (result.ok || result.pending) next[x.id] = 'sent';
      else delete next[x.id];
      return next;
    });
  };

  return (
    <div className="ct-suggest">
      <div className="ct-recent-title">
        <UserPlus size={13} /> Có thể bạn quen
      </div>
      {visible.map((x) => {
        const st = state[x.id];
        return (
          <div key={x.id} className="ct-suggest-row">
            <button className="ct-recent-main" onClick={() => openContactConversation(x.id, { name: x.name, avatar: x.avatar })} title="Nhắn tin">
              <Avatar url={x.avatar} name={x.name} size={36} />
              <span className="ct-recent-text">
                <span className="truncate">{x.name || 'Người dùng Zalo'}</span>
                <span className="ct-recent-phone truncate">{x.reason || 'Có thể bạn quen'}</span>
              </span>
            </button>
            {st === 'sent' ? (
              <span className="ct-suggest-sent">Đã gửi</span>
            ) : (
              <button
                className="ct-btn ct-btn-tonal ct-suggest-add"
                disabled={st === 'sending'}
                onClick={() => void add(x)}
                title="Gửi lời mời kết bạn"
                aria-label={`Kết bạn với ${x.name}`}
              >
                {st === 'sending' ? <Spinner size={13} /> : 'Kết bạn'}
              </button>
            )}
            <button
              className="ct-recent-remove"
              title="Ẩn gợi ý"
              aria-label={`Ẩn gợi ý ${x.name}`}
              disabled={st === 'sending'}
              onClick={() => dismissSuggestion(x.id)}
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// MARK: - Recent searches (this device only)

interface RecentSearch {
  id: string;
  name: string;
  avatar: string | null;
  phone: string;
  iso: string;
}

const recentKey = 'compola.addFriend.recent';

const loadRecent = (): RecentSearch[] => {
  try {
    const list = JSON.parse(localStorage.getItem(recentKey) ?? '[]');
    return Array.isArray(list) ? list.filter((r) => r && typeof r.id === 'string' && typeof r.phone === 'string').slice(0, 5) : [];
  } catch {
    return [];
  }
};

const saveRecent = (list: RecentSearch[]) => {
  try {
    localStorage.setItem(recentKey, JSON.stringify(list.slice(0, 5)));
  } catch {
    /* storage unavailable: nothing is remembered */
  }
};

// MARK: - Dialog

type Step = 'form' | 'profile' | 'message';

export function AddFriendDialog({ onClose }: { onClose: () => void }) {
  const search = useContacts((s) => s.search);
  const notice = useContacts((s) => s.notice);
  const [step, setStep] = useState<Step>('form');
  const [country, setCountry] = useState<Country>(countries[0]);
  const [phone, setPhone] = useState('');
  const [recent, setRecent] = useState<RecentSearch[]>(loadRecent);
  /** The last person shown (kept while the same number is read again after an answer). */
  const [shown, setShown] = useState<FoundUser | null>(null);
  const [lastQuery, setLastQuery] = useState<{ phone: string; iso: string } | null>(null);
  /** An accept / cancel started here: its notice re-reads the person's state. */
  const awaiting = useRef<number | null>(null);
  const [acting, setActing] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    resetFriendSearch();
    input.current?.focus();
    return () => resetFriendSearch();
  }, []);

  // A found person opens the profile step (and joins the recent searches).
  useEffect(() => {
    if (search.status !== 'found' || !search.user) return;
    const user = search.user;
    setShown(user);
    setStep((s) => (s === 'message' ? s : 'profile'));
    if (lastQuery && !user.isSelf) {
      const entry: RecentSearch = { id: user.id, name: user.name, avatar: user.avatar, phone: lastQuery.phone, iso: lastQuery.iso };
      setRecent((list) => {
        const next = [entry, ...list.filter((r) => r.id !== user.id)].slice(0, 5);
        saveRecent(next);
        return next;
      });
    }
  }, [search]);

  // The result of an accept / cancel started here: read the person's state again.
  useEffect(() => {
    if (awaiting.current === null || !notice || notice.seq === awaiting.current) return;
    awaiting.current = null;
    setActing(false);
    if (notice.ok && lastQuery) findFriend(lastQuery.phone, lastQuery.iso);
  }, [notice]);

  const searching = search.status === 'searching';
  const find = (p = phone, iso = country.iso) => {
    if (!p.trim() || searching) return;
    setLastQuery({ phone: p.trim(), iso });
    findFriend(p, iso);
  };

  const act = (run: () => void) => {
    awaiting.current = useContacts.getState().notice?.seq ?? -1;
    setActing(true);
    run();
  };

  const backToForm = () => {
    setStep('form');
    setShown(null);
    resetFriendSearch();
    setTimeout(() => input.current?.focus(), 0);
  };

  const message = (user: FoundUser) => {
    onClose();
    openContactConversation(user.id, { name: user.name, avatar: user.avatar });
  };

  const user = shown;

  return (
    <Sheet onClose={onClose} width={400}>
      {step === 'form' || !user ? (
        <>
          <DialogHeader title="Thêm bạn" onClose={onClose} />
          <div className="ct-dialog-body ct-addfriend">
            <div className="ct-phone-row">
              <button
                className="ct-country"
                onClick={(e) =>
                  openMenuBelow(
                    e.currentTarget,
                    countries.map((c) => ({
                      label: `${c.name} (${c.code})`,
                      checked: c.iso === country.iso,
                      onSelect: () => {
                        setCountry(c);
                        input.current?.focus();
                      },
                    })),
                  )
                }
                aria-label={`Mã quốc gia ${country.name} ${country.code}`}
              >
                <span>
                  {country.iso === 'VN' ? '🇻🇳 ' : ''}
                  {country.code}
                </span>
                <ChevronDown size={14} />
              </button>
              <input
                ref={input}
                className="ct-phone-input"
                value={phone}
                placeholder="Số điện thoại"
                inputMode="tel"
                spellCheck={false}
                onChange={(e) => setPhone(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    find();
                  }
                }}
                aria-label="Số điện thoại"
              />
            </div>
            {search.status === 'error' ? (
              <div className="ct-phone-error" role="alert">
                {search.error ?? 'Không tìm thấy người dùng.'}
              </div>
            ) : (
              <div className="ct-phone-hint">Nhập số điện thoại Việt Nam, hoặc số quốc tế bắt đầu bằng +</div>
            )}
            {recent.length > 0 && (
              <div className="ct-recent">
                <div className="ct-recent-title">
                  <Clock size={13} /> Kết quả gần nhất
                </div>
                {recent.map((r) => (
                  <div key={r.id} className="ct-recent-row">
                    <button
                      className="ct-recent-main"
                      disabled={searching}
                      onClick={() => {
                        setPhone(r.phone);
                        const c = countries.find((x) => x.iso === r.iso) ?? countries[0];
                        setCountry(c);
                        find(r.phone, c.iso);
                      }}
                    >
                      <Avatar url={r.avatar} name={r.name} size={36} />
                      <span className="ct-recent-text">
                        <span className="truncate">{r.name || 'Người dùng Zalo'}</span>
                        <span className="ct-recent-phone nums">{r.phone}</span>
                      </span>
                    </button>
                    <button
                      className="ct-recent-remove"
                      title="Xoá khỏi danh sách"
                      aria-label={`Xoá ${r.name} khỏi kết quả gần nhất`}
                      onClick={() =>
                        setRecent((list) => {
                          const next = list.filter((x) => x.id !== r.id);
                          saveRecent(next);
                          return next;
                        })
                      }
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <Suggestions />
          </div>
          <div className="ct-dialog-footer">
            <button className="ct-btn ct-btn-secondary" onClick={onClose}>
              Hủy
            </button>
            <button className="ct-btn ct-btn-primary ct-btn-min" disabled={!phone.trim() || searching} onClick={() => find()}>
              {searching ? <Spinner size={14} className="on-accent" /> : 'Tìm kiếm'}
            </button>
          </div>
        </>
      ) : step === 'profile' ? (
        <>
          <DialogHeader title="Thông tin tài khoản" onBack={backToForm} onClose={onClose} />
          <div className="ct-dialog-body">
            <ProfileCover avatar={user.avatar} name={user.name} secondaryName={user.zaloName} status={user.bio || null} />
            <FriendState
              user={user}
              busy={acting || searching}
              onAdd={() => setStep('message')}
              onMessage={() => message(user)}
              onAccept={() => act(() => acceptFriendRequest(user.id))}
              onCancel={() => act(() => cancelFriendRequest(user.id))}
            />
          </div>
        </>
      ) : (
        <MessageStep user={user} onBack={() => setStep('profile')} onClose={onClose} onSent={() => setStep('profile')} />
      )}
    </Sheet>
  );
}

/** The buttons of the found person: Kết bạn / Nhắn tin, or their state (friend, requested, requesting, me). */
function FriendState({
  user,
  busy,
  onAdd,
  onMessage,
  onAccept,
  onCancel,
}: {
  user: FoundUser;
  busy: boolean;
  onAdd: () => void;
  onMessage: () => void;
  onAccept: () => void;
  onCancel: () => void;
}) {
  if (user.isSelf) return <div className="ct-state-note">Đây là tài khoản của bạn.</div>;
  const messageButton = (
    <button className="ct-btn ct-btn-tonal ct-btn-grow" onClick={onMessage}>
      <MessageCircle size={15} /> Nhắn tin
    </button>
  );
  if (user.isFriend)
    return (
      <>
        <div className="ct-state-note is-ok">
          <UserCheck size={14} /> Đã là bạn bè
        </div>
        <div className="ct-profile-buttons">{messageButton}</div>
      </>
    );
  if (user.requesting)
    return (
      <>
        <div className="ct-state-note">Người này đã gửi lời mời kết bạn cho bạn.</div>
        <div className="ct-profile-buttons">
          <button className="ct-btn ct-btn-primary ct-btn-grow" disabled={busy} onClick={onAccept}>
            {busy ? <Spinner size={14} className="on-accent" /> : 'Đồng ý'}
          </button>
          {messageButton}
        </div>
      </>
    );
  if (user.requested)
    return (
      <>
        <div className="ct-state-note">Bạn đã gửi lời mời kết bạn. Đang chờ người này chấp nhận.</div>
        <div className="ct-profile-buttons">
          <button className="ct-btn ct-btn-secondary ct-btn-grow" disabled={busy} onClick={onCancel}>
            {busy ? <Spinner size={14} /> : 'Thu hồi lời mời'}
          </button>
          {messageButton}
        </div>
      </>
    );
  return (
    <div className="ct-profile-buttons">
      <button className="ct-btn ct-btn-secondary ct-btn-grow" disabled={busy} onClick={onAdd}>
        <UserPlus size={15} /> Kết bạn
      </button>
      {messageButton}
    </div>
  );
}

/** "Kết bạn": the greeting (official default, editable up to `maxMessage`), then the official request. */
function MessageStep({ user, onBack, onClose, onSent }: { user: FoundUser; onBack: () => void; onClose: () => void; onSent: () => void }) {
  const [text, setText] = useState(user.defaultMessage.slice(0, user.maxMessage));
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    area.current?.focus();
    area.current?.setSelectionRange(area.current.value.length, area.current.value.length);
  }, []);

  const send = async () => {
    if (sending || !text.trim()) return;
    setSending(true);
    setProblem(null);
    const result = await sendFriendRequest(user.id, text);
    setSending(false);
    if (result.ok || result.pending) {
      // The adapter marks the open profile as requested; a pending request must not be sent twice.
      onSent();
      return;
    }
    setProblem(result.text || 'Không thể gửi lời mời kết bạn.');
  };

  return (
    <>
      <DialogHeader title="Kết bạn" onBack={sending ? undefined : onBack} onClose={onClose} />
      <div className="ct-dialog-body ct-message-step">
        <div className="ct-message-who">
          <Avatar url={user.avatar} name={user.name} size={48} />
          <div className="ct-message-who-text">
            <span className="ct-card-title truncate">{user.name}</span>
            {user.zaloName && user.zaloName !== user.name && <span className="ct-card-extra truncate">{user.zaloName}</span>}
          </div>
        </div>
        <div className="ct-textarea-wrap">
          <textarea
            ref={area}
            className="ct-textarea"
            value={text}
            rows={5}
            disabled={sending}
            onChange={(e) => setText(e.target.value.slice(0, user.maxMessage))}
            aria-label="Lời nhắn"
          />
          <div className="ct-counter nums">
            {text.length}/{user.maxMessage}
          </div>
        </div>
        {problem && (
          <div className="ct-phone-error" role="alert">
            {problem}
          </div>
        )}
      </div>
      <div className="ct-dialog-footer">
        <button className="ct-btn ct-btn-secondary" disabled={sending} onClick={onBack}>
          Hủy
        </button>
        <button className="ct-btn ct-btn-primary ct-btn-min" disabled={sending || !text.trim()} onClick={() => void send()}>
          {sending ? <Spinner size={14} className="on-accent" /> : 'Gửi'}
        </button>
      </div>
    </>
  );
}
