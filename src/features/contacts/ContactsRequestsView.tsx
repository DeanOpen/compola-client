// Friend requests (Lời mời kết bạn) and group invitations (Lời mời vào nhóm) (Swift ContactsRequestsView.swift) in Zalo PC's
// layout: cards for received requests (Từ chối / Đồng ý) and sent ones (Thu hồi lời mời), group invitations (Từ chối / Tham gia).
// Every action goes through the official client's services; its result comes back as a `notice` (a toast). Wave 4
// (docs/design-refs/wave4/contacts): card heads with a "new" dot, quoted greetings, primary accept / join, an expiry chip,
// and the sent requests as dense rows.

import { Clock, MailOpen, MessageCircle, RefreshCw, UserPlus, UsersRound } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  acceptFriendRequest,
  acceptGroupInvite,
  ago,
  cancelFriendRequest,
  declineFriendRequest,
  declineGroupInvite,
  inviteExpiryText,
  loadMoreGroupInvites,
  openContactConversation,
  refreshContacts,
  useContacts,
  watchGroupInvites,
  type FriendRequest,
  type GroupInvite,
} from '../../engine/contacts';
import { usePhoneOf } from '../../engine/contactPhones';
import { Avatar } from '../../ui/Avatar';
import { Sheet } from '../../ui/Overlays';
import { Spinner } from '../../ui/Spinner';
import { ContactsEmpty, ContactsLoading, ContactsPageHeader, DialogHeader } from './ContactsShared';
import './contactsPages.css';

type RequestAction = 'accept' | 'decline' | 'cancel';

/** "Lời mời kết bạn": received requests, then the ones the user sent (a person never appears in both). */
export function RequestsPage() {
  const received = useContacts((s) => s.received);
  const allSent = useContacts((s) => s.sent);
  const loading = useContacts((s) => s.loadingRequests);
  const notice = useContacts((s) => s.notice);
  const sent = useMemo(() => {
    const receivedIds = new Set(received.map((r) => r.id));
    return allSent.filter((r) => !receivedIds.has(r.id));
  }, [received, allSent]);

  /** Requests with an action in flight (cleared when the official client reports the result). */
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => setBusy(new Set()), [notice]);
  useEffect(() => {
    const known = new Set([...received, ...allSent].map((r) => r.id));
    setBusy((b) => (b.size ? new Set([...b].filter((id) => known.has(id))) : b));
  }, [received, allSent]);

  const perform = (id: string, action: RequestAction) => {
    setBusy((b) => new Set([...b, id]));
    if (action === 'accept') acceptFriendRequest(id);
    else if (action === 'decline') declineFriendRequest(id);
    else cancelFriendRequest(id);
  };

  const reload = loading ? (
    <span className="ct-header-spinner" title="Đang tải lời mời…">
      <Spinner size={15} />
    </span>
  ) : (
    <button className="ct-icon-button" onClick={refreshContacts} title="Tải lại" aria-label="Tải lại">
      <RefreshCw size={16} />
    </button>
  );

  let body;
  if (received.length === 0 && sent.length === 0) {
    body = loading ? (
      <div className="ct-panel">
        <ContactsLoading text="Đang tải lời mời…" />
      </div>
    ) : (
      <div className="ct-panel">
        <ContactsEmpty icon={MailOpen} title="Bạn không có lời mời nào" description="Lời mời kết bạn sẽ hiện ở đây." />
      </div>
    );
  } else {
    body = (
      <>
        {received.length > 0 && (
          <>
            <SectionTitle title="Lời mời đã nhận" count={received.length} />
            <div className="ct-cards">
              {received.map((r) => (
                <ReceivedCard key={r.id} request={r} busy={busy.has(r.id)} perform={(a) => perform(r.id, a)} />
              ))}
            </div>
          </>
        )}
        {sent.length > 0 && (
          <>
            <SectionTitle title="Lời mời đã gửi" count={sent.length} />
            <div className="ct-panel cp-sent">
              {sent.map((r) => (
                <SentRow key={r.id} request={r} busy={busy.has(r.id)} perform={(a) => perform(r.id, a)} />
              ))}
            </div>
          </>
        )}
      </>
    );
  }

  return (
    <div className="ct-page">
      <ContactsPageHeader icon={UserPlus} title="Lời mời kết bạn">
        {reload}
      </ContactsPageHeader>
      <div className="ct-page-scroll">{body}</div>
    </div>
  );
}

/** Section heading of a requests page: title + count chip. */
function SectionTitle({ title, count }: { title: string; count: number }) {
  return (
    <div className="ct-list-title cp-section-title">
      {title}
      <span className="cp-count nums">{count}</span>
    </div>
  );
}

/** Requests younger than a day get the "new" dot (Lovable / Teams inbox pattern). */
const isRecent = (date: number | null) => !!date && Date.now() - date < 86_400_000;

function ReceivedCard({ request, busy, perform }: { request: FriendRequest; busy: boolean; perform: (a: RequestAction) => void }) {
  const phone = usePhoneOf(request.id);
  return (
    <div className={`ct-card cp-card ${busy ? 'is-busy' : ''}`}>
      <div className="cp-card-head">
        <span className="cp-card-avatar">
          <Avatar url={request.avatar} name={request.name} size={48} />
          {isRecent(request.date) && <span className="cp-new-dot" title="Lời mời mới" />}
        </span>
        <div className="ct-card-name">
          <span className="ct-card-title truncate">{request.name || 'Người dùng Zalo'}</span>
          <span className="ct-card-extra truncate">{request.date ? `${ago(request.date)} · Muốn kết bạn` : 'Muốn kết bạn với bạn'}</span>
          {phone && (
            <span className="ct-card-extra cp-phone nums truncate" title="Số điện thoại bạn đã tìm">
              {phone}
            </span>
          )}
        </div>
        <button
          className="cp-card-icon"
          title="Nhắn tin"
          aria-label={`Nhắn tin cho ${request.name}`}
          onClick={() => openContactConversation(request.id, { name: request.name, avatar: request.avatar })}
        >
          <MessageCircle size={17} />
        </button>
      </div>
      <div className={`cp-quote ${request.message ? '' : 'is-empty'}`}>{request.message || 'Không có lời nhắn'}</div>
      <div className="ct-card-cta">
        <button className="ct-btn ct-btn-secondary" disabled={busy} onClick={() => perform('decline')}>
          Từ chối
        </button>
        <button className="ct-btn ct-btn-primary" disabled={busy} onClick={() => perform('accept')}>
          {busy ? <Spinner size={13} className="on-accent" /> : 'Đồng ý'}
        </button>
      </div>
    </div>
  );
}

/** A sent request: one dense row (OpenAI / Upwork pending-invites pattern) with "Thu hồi". */
function SentRow({ request, busy, perform }: { request: FriendRequest; busy: boolean; perform: (a: RequestAction) => void }) {
  const phone = usePhoneOf(request.id);
  const when = request.date ? `Đã gửi ${ago(request.date)}` : 'Đang chờ người này chấp nhận';
  return (
    <div className={`cp-sent-row ${busy ? 'is-busy' : ''}`}>
      <Avatar url={request.avatar} name={request.name} size={40} />
      <span className="ct-row-text">
        <span className="ct-row-name truncate">{request.name || 'Người dùng Zalo'}</span>
        <span className="ct-row-sub truncate">
          {phone ? (
            <>
              <span className="cp-phone nums" title="Số điện thoại bạn đã tìm">
                {phone}
              </span>
              {' · '}
              {when}
            </>
          ) : (
            when
          )}
        </span>
      </span>
      <button
        className="cp-card-icon"
        title="Nhắn tin"
        aria-label={`Nhắn tin cho ${request.name}`}
        onClick={() => openContactConversation(request.id, { name: request.name, avatar: request.avatar })}
      >
        <MessageCircle size={17} />
      </button>
      <button className="ct-btn ct-btn-secondary cp-sent-cancel" disabled={busy} onClick={() => perform('cancel')}>
        {busy ? <Spinner size={13} /> : 'Thu hồi lời mời'}
      </button>
    </div>
  );
}

/**
 * "Lời mời vào nhóm và cộng đồng": the official invitation box (it loads only while this page is open). Cards show the group,
 * who invited me and when the invitation expires; "Tham gia" joins and opens the group, "Từ chối" asks first (optionally
 * blocking the group's invitations and the inviter), like Zalo PC.
 */
export function GroupInvitesPage() {
  const invites = useContacts((s) => s.groupInvites);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [declining, setDeclining] = useState<GroupInvite | null>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    watchGroupInvites(true);
    // Expiry texts count down like the official card.
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => {
      clearInterval(t);
      watchGroupInvites(false);
    };
  }, []);

  const run = async (id: string, action: () => Promise<unknown>) => {
    setBusy((b) => new Set([...b, id]));
    try {
      await action();
    } finally {
      setBusy((b) => new Set([...b].filter((x) => x !== id)));
    }
  };

  const items = invites.items;
  let body;
  if (items.length === 0) {
    body = (
      <div className="ct-panel">
        {invites.loading ? (
          <ContactsLoading text="Đang tải lời mời…" />
        ) : (
          <ContactsEmpty
            icon={MailOpen}
            title={invites.available ? 'Không có lời mời vào nhóm và cộng đồng' : 'Chưa đọc được lời mời vào nhóm'}
            description={
              invites.available
                ? 'Lời mời tham gia nhóm và cộng đồng từ người lạ hoặc bạn bè sẽ hiện ở đây.'
                : 'Ứng dụng chưa sẵn sàng. Hãy mở lại mục này sau giây lát.'
            }
          />
        )}
      </div>
    );
  } else {
    body = (
      <>
        <SectionTitle title="Lời mời đã nhận" count={Math.max(invites.total, items.length)} />
        <div className="ct-cards">
          {items.map((inv) => (
            <GroupInviteCard
              key={inv.id}
              invite={inv}
              busy={busy.has(inv.id)}
              onJoin={() => void run(inv.id, () => acceptGroupInvite(inv.id))}
              onDecline={() => setDeclining(inv)}
            />
          ))}
        </div>
        {invites.hasMore && (
          <div className="ct-more">
            <button className="ct-btn ct-btn-secondary" disabled={invites.loading} onClick={loadMoreGroupInvites}>
              {invites.loading ? <Spinner size={13} /> : 'Xem thêm'}
            </button>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="ct-page">
      <ContactsPageHeader icon={UsersRound} title="Lời mời vào nhóm và cộng đồng">
        {invites.loading && items.length > 0 && (
          <span className="ct-header-spinner" title="Đang tải lời mời…">
            <Spinner size={15} />
          </span>
        )}
      </ContactsPageHeader>
      <div className="ct-page-scroll">{body}</div>
      {declining && (
        <DeclineGroupInviteDialog
          invite={declining}
          onClose={() => setDeclining(null)}
          onDecline={(blockGroup, blockInviter) => {
            const inv = declining;
            setDeclining(null);
            void run(inv.id, () => declineGroupInvite(inv.id, blockGroup, blockInviter));
          }}
        />
      )}
    </div>
  );
}

function GroupInviteCard({ invite, busy, onJoin, onDecline }: { invite: GroupInvite; busy: boolean; onJoin: () => void; onDecline: () => void }) {
  const expiry = inviteExpiryText(invite.expiresAt);
  const kind = invite.community ? 'Cộng đồng' : 'Nhóm';
  return (
    <div className={`ct-card cp-card ct-invite-card ${busy ? 'is-busy' : ''}`}>
      <div className="cp-card-head">
        <Avatar url={invite.avatar} name={invite.name} size={48} />
        <div className="ct-card-name">
          <span className="ct-card-title truncate">{invite.name}</span>
          <span className="ct-card-extra truncate">
            {kind} · {invite.members.toLocaleString('vi-VN')} thành viên
          </span>
        </div>
      </div>
      {(invite.pendingReview || expiry) && (
        <span className={`cp-chip ${invite.pendingReview ? 'is-pending' : ''}`}>
          <Clock size={12} /> {invite.pendingReview ? 'Chờ phê duyệt' : expiry}
        </span>
      )}
      <div className="cp-invite-from">
        <Avatar url={invite.inviterAvatar} name={invite.inviterName} size={22} />
        <span className="cp-invite-from-text truncate">
          <span className="ct-invite-from-label">Lời mời từ </span>
          <b>{invite.inviterName || 'Người dùng Zalo'}</b>
        </span>
        {invite.inviterIsOwner && <span className="ct-invite-owner">{invite.community ? 'Trưởng cộng đồng' : 'Trưởng nhóm'}</span>}
      </div>
      <div className="ct-card-cta">
        {invite.pendingReview ? (
          <button className="ct-btn ct-btn-tonal ct-btn-grow" disabled>
            Đã yêu cầu tham gia
          </button>
        ) : (
          <>
            <button className="ct-btn ct-btn-secondary" disabled={busy} onClick={onDecline}>
              Từ chối
            </button>
            <button className="ct-btn ct-btn-primary" disabled={busy} onClick={onJoin}>
              {busy ? <Spinner size={13} className="on-accent" /> : 'Tham gia'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Official GROUP_INVITATION_DECLINE confirm: two optional blocks, then "Từ chối". */
function DeclineGroupInviteDialog({
  invite,
  onClose,
  onDecline,
}: {
  invite: GroupInvite;
  onClose: () => void;
  onDecline: (blockGroup: boolean, blockInviter: boolean) => void;
}) {
  const [blockGroup, setBlockGroup] = useState(false);
  const [blockInviter, setBlockInviter] = useState(false);
  const community = invite.community;
  return (
    <Sheet onClose={onClose} width={420}>
      <DialogHeader title={community ? 'Từ chối lời mời vào cộng đồng?' : 'Từ chối lời mời vào nhóm?'} onClose={onClose} />
      <div className="ct-dialog-body ct-decline">
        <p>{community ? 'Nếu thấy phiền, bạn cũng có thể chặn người mời và cộng đồng này.' : 'Nếu thấy phiền, bạn cũng có thể chặn người mời và nhóm này.'}</p>
        <label className="ct-check">
          <input type="checkbox" checked={blockGroup} onChange={(e) => setBlockGroup(e.target.checked)} />
          <span>{community ? 'Chặn tất cả lời mời tham gia cộng đồng này' : 'Chặn tất cả lời mời tham gia nhóm này'}</span>
        </label>
        <label className="ct-check">
          <input type="checkbox" checked={blockInviter} onChange={(e) => setBlockInviter(e.target.checked)} />
          <span>Chặn {invite.inviterName || 'người mời'}</span>
        </label>
      </div>
      <div className="ct-dialog-footer">
        <button className="ct-btn ct-btn-secondary ct-btn-min" onClick={onClose}>
          Hủy
        </button>
        <button className="ct-btn ct-btn-danger ct-btn-min" onClick={() => onDecline(blockGroup, blockInviter)}>
          Từ chối
        </button>
      </div>
    </Sheet>
  );
}
