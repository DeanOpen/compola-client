// Profile card of a person (Zalo PC "Thông tin tài khoản"; Mobbin refs in docs/design-refs/wave4/add-friend): a cover band with a
// ringed avatar, the names, a relationship pill, the actions, then "Thông tin cá nhân" key / value rows. Used by the "Thêm bạn"
// result and by a friend's profile dialog (Swift `FoundUserCard` / `FriendCard`).

import { BadgeCheck, Cloud, Clock, MessageCircle, Settings, UserCheck, UserPlus } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import {
  acceptFriendRequest,
  ago,
  contactProfile,
  openContactConversation,
  sendFriendRequest,
  strangerInfo,
  useContacts,
  type ContactProfile,
  type StrangerInfo,
} from '../../engine/contacts';
import { usePhoneOf } from '../../engine/contactPhones';
import { mediaUrl } from '../../engine/media';
import { setEngine, useEngine } from '../../engine/store';
import { Avatar } from '../../ui/Avatar';
import { openSettings } from '../settings/hosts';
import { Sheet } from '../../ui/Overlays';
import { Spinner } from '../../ui/Spinner';
import { ContactCallActions, DialogHeader } from './ContactsShared';
import type { ProfileHint } from './contactsUi';
import './addFriend.css';

export type Relationship = 'friend' | 'requested' | 'requesting' | 'self' | 'none';

const pills: Record<Exclude<Relationship, 'none'>, { text: string; icon: typeof UserCheck; tone: string }> = {
  friend: { text: 'Bạn bè', icon: UserCheck, tone: 'is-friend' },
  requested: { text: 'Đã gửi lời mời kết bạn', icon: Clock, tone: 'is-pending' },
  requesting: { text: 'Muốn kết bạn với bạn', icon: UserPlus, tone: 'is-incoming' },
  self: { text: 'Tài khoản của bạn', icon: BadgeCheck, tone: 'is-self' },
};

/** The hero of a profile: cover, avatar (with presence), names, status line and the relationship pill. */
export function ProfileHero({
  avatar,
  name,
  secondaryName,
  status,
  online = false,
  relationship = 'none',
  cover = null,
}: {
  avatar: string | null;
  name: string;
  secondaryName?: string | null;
  status?: string | null;
  online?: boolean;
  relationship?: Relationship;
  /** Cover photo URL; the brand band when absent. */
  cover?: string | null;
}) {
  const coverSrc = mediaUrl(cover);
  const pill = relationship === 'none' ? null : pills[relationship];
  return (
    <div className="af-hero">
      <div
        className="af-hero-band"
        aria-hidden
        style={coverSrc ? { backgroundImage: `url("${coverSrc}")`, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined}
      />
      <span className="af-hero-avatar">
        <Avatar url={avatar} name={name} size={84} />
        {online && <span className="af-hero-presence" aria-label="Đang hoạt động" />}
      </span>
      <div className="af-hero-name selectable">{name || 'Người dùng Zalo'}</div>
      {secondaryName && secondaryName !== name && <div className="af-hero-secondary">{secondaryName}</div>}
      {status && <div className={`af-hero-status ${online ? 'is-online' : ''}`}>{status}</div>}
      {pill && (
        <span className={`af-pill ${pill.tone}`}>
          <pill.icon size={13} /> {pill.text}
        </span>
      )}
    </div>
  );
}

/** "Thông tin cá nhân": label / value rows (values selectable). Nothing when every value is empty. */
export function ProfileDetails({ rows }: { rows: { label: string; value: ReactNode }[] }) {
  const shown = rows.filter((r) => r.value !== null && r.value !== undefined && r.value !== '');
  if (!shown.length) return null;
  return (
    <section className="af-details" aria-label="Thông tin cá nhân">
      <div className="af-details-title">Thông tin cá nhân</div>
      {shown.map((r) => (
        <div key={r.label} className="af-detail">
          <span className="af-detail-key">{r.label}</span>
          <span className="af-detail-value selectable">{r.value}</span>
        </div>
      ))}
    </section>
  );
}

type RequestPhase = 'idle' | 'busy' | 'sent' | 'accepted';

/** "Thông tin tài khoản" of anyone (Swift `FriendCard` / Zalo PC's profile popup): a friend, someone with a pending request,
 * or a stranger met in a group. Friend-list data first, then the official profile (`contactProfile`), then what the opener
 * knew (`hint`: the sender / member row it was opened from). Message for everyone; calls for friends; Kết bạn / Đồng ý for
 * the rest (official greeting, as the stranger bar sends it). */
export function PersonProfileDialog({ id, hint, onClose }: { id: string; hint: ProfileHint | null; onClose: () => void }) {
  const friend = useContacts((s) => s.friends.find((f) => f.id === id) ?? null);
  const known = useContacts((s) => s.known[id] ?? null);
  const inSent = useContacts((s) => s.sent.some((r) => r.id === id));
  const inReceived = useContacts((s) => s.received.some((r) => r.id === id));
  const phone = usePhoneOf(id);
  const [profile, setProfile] = useState<ContactProfile | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [info, setInfo] = useState<StrangerInfo | null>(null);
  const [phase, setPhase] = useState<RequestPhase>('idle');
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setProfile(null);
    setLoaded(false);
    void contactProfile(id).then((p) => {
      // Another profile meanwhile: never show someone else's data.
      if (cancelled) return;
      if (p?.uid === id) setProfile(p);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const isFriend = !!friend || !!profile?.isFriend || !!info?.isFriend || phase === 'accepted';
  // Request state only matters for non-friends; asked once the profile says so.
  useEffect(() => {
    if (!loaded || isFriend || profile?.isSelf) return;
    let live = true;
    void strangerInfo(id).then((i) => live && setInfo(i));
    return () => {
      live = false;
    };
  }, [id, loaded, isFriend, profile?.isSelf]);

  const name = friend?.name || profile?.name || known?.name || hint?.name || '';
  const avatar = friend?.avatar ?? profile?.avatar ?? known?.avatar ?? hint?.avatar ?? null;
  if (!name && !avatar) {
    return (
      <Sheet onClose={onClose} width={400}>
        <DialogHeader title="Thông tin tài khoản" onClose={onClose} />
        <div className="ct-dialog-body af-profile af-profile-empty">
          {loaded ? <span className="af-profile-note">Không tải được thông tin người này.</span> : <Spinner size={18} />}
        </div>
      </Sheet>
    );
  }

  const requested = !isFriend && (phase === 'sent' || inSent || !!info?.requested);
  const requesting = !isFriend && !requested && (inReceived || !!info?.requesting);
  const relationship: Relationship = profile?.isSelf ? 'self' : isFriend ? 'friend' : requested ? 'requested' : requesting ? 'requesting' : 'none';
  const status = friend ? (friend.online ? 'Đang hoạt động' : friend.lastActive ? `Truy cập ${ago(friend.lastActive)}` : null) : null;

  const message = () => {
    onClose();
    openContactConversation(id, { name, avatar });
  };
  const addFriend = async () => {
    setPhase('busy');
    setProblem(null);
    const fresh = info ?? (await strangerInfo(id));
    const result = await sendFriendRequest(id, fresh?.defaultMessage || `Xin chào ${name}, kết bạn với mình nhé!`);
    if (result.ok || result.pending) setPhase('sent');
    else {
      setPhase('idle');
      setProblem(result.text || 'Không thể gửi lời mời kết bạn.');
    }
  };
  const accept = () => {
    acceptFriendRequest(id);
    setPhase('accepted');
  };

  return (
    <Sheet onClose={onClose} width={400}>
      <DialogHeader title="Thông tin tài khoản" onClose={onClose} />
      <div className="ct-dialog-body af-profile">
        <ProfileHero
          avatar={avatar}
          name={name}
          secondaryName={friend?.zaloName || profile?.zaloName}
          status={status}
          online={friend?.online ?? false}
          relationship={relationship}
        />
        <div className="af-actions">
          {!isFriend && !profile?.isSelf && !requested && (
            <button
              className="ct-btn ct-btn-primary af-action-main"
              disabled={phase === 'busy' || !loaded}
              onClick={requesting ? accept : () => void addFriend()}
            >
              {phase === 'busy' ? <Spinner size={13} /> : requesting ? <UserCheck size={15} /> : <UserPlus size={15} />}
              {requesting ? 'Đồng ý kết bạn' : 'Kết bạn'}
            </button>
          )}
          <button className={`ct-btn ${isFriend || requested ? 'ct-btn-primary af-action-main' : ''}`} onClick={message}>
            <MessageCircle size={15} /> Nhắn tin
          </button>
        </div>
        {problem && <div className="af-profile-note is-error">{problem}</div>}
        {isFriend && (
          <div className="ct-profile-actions">
            <ContactCallActions id={id} name={name} onStart={onClose} />
          </div>
        )}
        <ProfileDetails
          rows={[
            { label: 'Điện thoại', value: phone },
            { label: 'Giới thiệu', value: profile?.bio || null },
            { label: 'Loại tài khoản', value: profile?.isOfficialAccount ? 'Tài khoản chính thức' : null },
          ]}
        />
      </div>
    </Sheet>
  );
}

const genderText = (g: number | null | undefined) => (g === 0 ? 'Nam' : g === 1 ? 'Nữ' : null);

/** "Hồ sơ của bạn": the signed-in account (official user slice), with "Cloud của tôi" and Cài đặt. */
export function MyProfileDialog({ onClose }: { onClose: () => void }) {
  const profile = useEngine((s) => s.profile);
  const selfId = useEngine((s) => s.selfConversationId);
  if (!profile) return null;
  return (
    <Sheet onClose={onClose} width={400}>
      <DialogHeader title="Hồ sơ của bạn" onClose={onClose} />
      <div className="ct-dialog-body af-profile">
        <ProfileHero
          avatar={profile.avatar}
          name={profile.displayName}
          secondaryName={profile.zaloName}
          relationship="self"
          cover={profile.cover}
        />
        <div className="af-actions">
          <button
            className="ct-btn ct-btn-primary af-action-main"
            disabled={!selfId}
            onClick={() => {
              onClose();
              if (selfId) setEngine({ navigationRequest: selfId });
            }}
          >
            <Cloud size={15} /> Cloud của tôi
          </button>
          <button
            className="ct-btn"
            onClick={() => {
              onClose();
              openSettings();
            }}
          >
            <Settings size={15} /> Cài đặt
          </button>
        </div>
        <ProfileDetails
          rows={[
            { label: 'Điện thoại', value: profile.phone },
            { label: 'Tên Zalo', value: profile.zaloName && profile.zaloName !== profile.displayName ? profile.zaloName : null },
            { label: 'Username', value: profile.username ? `@${profile.username}` : null },
            { label: 'Giới thiệu', value: profile.bio },
            { label: 'Giới tính', value: genderText(profile.gender) },
            { label: 'Ngày sinh', value: profile.birthday },
          ]}
        />
      </div>
    </Sheet>
  );
}
