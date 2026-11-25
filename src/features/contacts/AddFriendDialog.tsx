// "Thêm bạn" dialog (Swift AddFriendForm + AddFriendDetail + FoundUserCard, in Zalo PC's dialog layout): country code + phone →
// the official find-by-phone → the profile card with its friend state → "Kết bạn" → the message step → the official
// `requestAddFriend`. Nothing is sent until "Gửi" is pressed; the search is reset when the dialog closes.

import { Check, ChevronDown, Clock, MessageCircle, Smartphone, UserCheck, UserPlus, UserX, X, XCircle, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { countries, phoneText, prettyPhone, rememberPhone, type Country } from '../../engine/contactPhones';
import { Avatar } from '../../ui/Avatar';
import { openMenuBelow } from '../../ui/Menu';
import { Sheet } from '../../ui/Overlays';
import { Spinner } from '../../ui/Spinner';
import { DialogHeader } from './ContactsShared';
import { ProfileDetails, ProfileHero, type Relationship } from './ProfileCard';
import './addFriend.css';

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
    <section className="af-section">
      <SectionTitle icon={UserPlus} title="Có thể bạn quen" count={visible.length} />
      {visible.map((x) => {
        const st = state[x.id];
        return (
          <div key={x.id} className="af-row">
            <button className="af-row-main" onClick={() => openContactConversation(x.id, { name: x.name, avatar: x.avatar })} title="Nhắn tin">
              <Avatar url={x.avatar} name={x.name} size={40} />
              <span className="af-row-text">
                <span className="af-row-name truncate">{x.name || 'Người dùng Zalo'}</span>
                <span className="af-row-sub truncate">{x.reason || 'Có thể bạn quen'}</span>
              </span>
            </button>
            {st === 'sent' ? (
              <span className="af-row-done">
                <Check size={14} /> Đã gửi
              </span>
            ) : (
              <button
                className="ct-btn ct-btn-tonal af-row-add"
                disabled={st === 'sending'}
                onClick={() => void add(x)}
                title="Gửi lời mời kết bạn"
                aria-label={`Kết bạn với ${x.name}`}
              >
                {st === 'sending' ? <Spinner size={13} /> : 'Kết bạn'}
              </button>
            )}
            {st !== 'sent' && (
              <button
                className="af-row-remove"
                title="Ẩn gợi ý"
                aria-label={`Ẩn gợi ý ${x.name}`}
                disabled={st === 'sending'}
                onClick={() => dismissSuggestion(x.id)}
              >
                <X size={14} />
              </button>
            )}
          </div>
        );
      })}
    </section>
  );
}

function SectionTitle({ icon: Icon, title, count }: { icon: LucideIcon; title: string; count?: number }) {
  return (
    <div className="af-section-title">
      <Icon size={14} />
      <span>{title}</span>
      {count ? <span className="af-section-count nums">{count}</span> : null}
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
  const suggestionCount = useContacts((s) => s.suggestions.length);
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
      // Who this number belongs to, kept after the request goes out (requests page, profile, friend list).
      rememberPhone(user.id, lastQuery.phone, lastQuery.iso, user.name);
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
    <Sheet onClose={onClose} width={420} height={600}>
      {step === 'form' || !user ? (
        <>
          <DialogHeader title="Thêm bạn" onClose={onClose} />
          <div className="ct-dialog-body af-form">
            <div className={`af-phone ${search.status === 'error' ? 'is-error' : ''}`}>
              <button
                className="af-country"
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
                title={country.name}
              >
                <span className="nums">
                  {country.iso === 'VN' ? '🇻🇳 ' : ''}
                  {country.code}
                </span>
                <ChevronDown size={14} />
              </button>
              <span className="af-phone-divider" aria-hidden />
              <input
                ref={input}
                className="af-phone-input nums"
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
              {phone && !searching && (
                <button
                  className="af-phone-clear"
                  onClick={() => {
                    setPhone('');
                    resetFriendSearch();
                    input.current?.focus();
                  }}
                  title="Xoá"
                  aria-label="Xoá số điện thoại"
                >
                  <XCircle size={16} fill="currentColor" stroke="var(--ct-layer)" />
                </button>
              )}
            </div>
            {searching ? (
              <div className="af-status" role="status">
                <Spinner size={14} />
                <span>
                  Đang tìm <b className="nums">{prettyPhone(lastQuery?.phone ?? phone)}</b>…
                </span>
              </div>
            ) : search.status === 'error' ? (
              <div className="af-notfound" role="alert">
                <span className="af-notfound-icon">
                  <UserX size={20} />
                </span>
                <span className="af-notfound-text">
                  <b>Không tìm thấy</b>
                  <span>{search.error ?? 'Số điện thoại chưa đăng ký tài khoản hoặc không cho phép tìm kiếm.'}</span>
                </span>
              </div>
            ) : (
              <div className="af-hint">Nhập số điện thoại Việt Nam, hoặc số quốc tế bắt đầu bằng +</div>
            )}
            {recent.length > 0 && (
              <section className="af-section">
                <SectionTitle icon={Clock} title="Kết quả gần nhất" />
                {recent.map((r) => (
                  <div key={r.id} className="af-row">
                    <button
                      className="af-row-main"
                      disabled={searching}
                      onClick={() => {
                        setPhone(r.phone);
                        const c = countries.find((x) => x.iso === r.iso) ?? countries[0];
                        setCountry(c);
                        find(r.phone, c.iso);
                      }}
                    >
                      <Avatar url={r.avatar} name={r.name} size={40} />
                      <span className="af-row-text">
                        <span className="af-row-name truncate">{r.name || 'Người dùng Zalo'}</span>
                        <span className="af-row-sub nums">{phoneText(r)}</span>
                      </span>
                    </button>
                    <button
                      className="af-row-remove"
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
              </section>
            )}
            <Suggestions />
            {recent.length === 0 && suggestionCount === 0 && (
              <div className="af-empty">
                <span className="af-empty-icon">
                  <Smartphone size={26} />
                </span>
                <span>Tìm bạn bè bằng số điện thoại đã đăng ký Zalo.</span>
              </div>
            )}
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
          <div className="ct-dialog-body af-profile">
            <ProfileHero avatar={user.avatar} name={user.name} secondaryName={user.zaloName} relationship={relationshipOf(user)} />
            <FriendState
              user={user}
              busy={acting || searching}
              onAdd={() => setStep('message')}
              onMessage={() => message(user)}
              onAccept={() => act(() => acceptFriendRequest(user.id))}
              onCancel={() => act(() => cancelFriendRequest(user.id))}
            />
            <ProfileDetails
              rows={[
                { label: 'Điện thoại', value: lastQuery ? phoneText(lastQuery) : null },
                { label: 'Giới thiệu', value: user.bio || null },
              ]}
            />
          </div>
        </>
      ) : (
        <MessageStep user={user} onBack={() => setStep('profile')} onClose={onClose} onSent={() => setStep('profile')} />
      )}
    </Sheet>
  );
}

const relationshipOf = (user: FoundUser): Relationship =>
  user.isSelf ? 'self' : user.isFriend ? 'friend' : user.requesting ? 'requesting' : user.requested ? 'requested' : 'none';

/** The buttons of the found person: Kết bạn / Nhắn tin, Đồng ý, Thu hồi (the state itself is the hero's pill). */
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
  if (user.isSelf) return null;
  const messageButton = (primary: boolean) => (
    <button className={`ct-btn ${primary ? 'ct-btn-primary' : 'ct-btn-tonal'} ct-btn-grow`} onClick={onMessage}>
      <MessageCircle size={15} /> Nhắn tin
    </button>
  );
  let main: ReactNode;
  if (user.isFriend) main = messageButton(true);
  else if (user.requesting)
    main = (
      <>
        <button className="ct-btn ct-btn-primary ct-btn-grow" disabled={busy} onClick={onAccept}>
          {busy ? <Spinner size={14} className="on-accent" /> : (
            <>
              <UserCheck size={15} /> Đồng ý
            </>
          )}
        </button>
        {messageButton(false)}
      </>
    );
  else if (user.requested)
    main = (
      <>
        <button className="ct-btn ct-btn-secondary ct-btn-grow" disabled={busy} onClick={onCancel}>
          {busy ? <Spinner size={14} /> : 'Thu hồi lời mời'}
        </button>
        {messageButton(false)}
      </>
    );
  else
    main = (
      <>
        <button className="ct-btn ct-btn-primary ct-btn-grow" disabled={busy} onClick={onAdd}>
          <UserPlus size={15} /> Kết bạn
        </button>
        {messageButton(false)}
      </>
    );
  return <div className="af-actions">{main}</div>;
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
      <DialogHeader title="Gửi lời mời kết bạn" onBack={sending ? undefined : onBack} onClose={onClose} />
      <div className="ct-dialog-body af-message">
        <div className="af-message-who">
          <Avatar url={user.avatar} name={user.name} size={44} />
          <div className="af-row-text">
            <span className="af-row-name truncate">{user.name}</span>
            <span className="af-row-sub truncate">{user.zaloName && user.zaloName !== user.name ? user.zaloName : 'Lời nhắn sẽ đi kèm lời mời'}</span>
          </div>
        </div>
        <label className="af-message-label" htmlFor="af-greeting">
          Lời nhắn
        </label>
        <div className="af-textarea">
          <textarea
            id="af-greeting"
            ref={area}
            value={text}
            rows={6}
            disabled={sending}
            onChange={(e) => setText(e.target.value.slice(0, user.maxMessage))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className={`af-counter nums ${text.length >= user.maxMessage ? 'is-full' : ''}`}>
            {text.length}/{user.maxMessage}
          </div>
        </div>
        {problem && (
          <div className="af-error" role="alert">
            {problem}
          </div>
        )}
      </div>
      <div className="ct-dialog-footer">
        <button className="ct-btn ct-btn-secondary" disabled={sending} onClick={onBack}>
          Hủy
        </button>
        <button className="ct-btn ct-btn-primary ct-btn-min" disabled={sending || !text.trim()} onClick={() => void send()} title="⌘↩">
          {sending ? <Spinner size={14} className="on-accent" /> : 'Gửi lời mời'}
        </button>
      </div>
    </>
  );
}
