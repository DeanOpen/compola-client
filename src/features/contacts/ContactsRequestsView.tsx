// Friend requests (Lời mời kết bạn) and group invitations (Lời mời vào nhóm) (Swift ContactsRequestsView.swift) in Zalo PC's
// layout: cards for received requests (Từ chối / Đồng ý) and sent ones (Thu hồi lời mời). Every action goes through the official
// client's friend-request service; its result comes back as a `notice` (a toast).

import { MailOpen, MessageCircle, RefreshCw, UserPlus, UsersRound } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  acceptFriendRequest,
  ago,
  cancelFriendRequest,
  declineFriendRequest,
  openContactConversation,
  refreshContacts,
  useContacts,
  type FriendRequest,
} from '../../engine/contacts';
import { Avatar } from '../../ui/Avatar';
import { Spinner } from '../../ui/Spinner';
import { ContactsEmpty, ContactsLoading, ContactsPageHeader } from './ContactsShared';

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
            <div className="ct-list-title">Lời mời đã nhận ({received.length})</div>
            <div className="ct-cards">
              {received.map((r) => (
                <ReceivedCard key={r.id} request={r} busy={busy.has(r.id)} perform={(a) => perform(r.id, a)} />
              ))}
            </div>
          </>
        )}
        {sent.length > 0 && (
          <>
            <div className="ct-list-title">Lời mời đã gửi ({sent.length})</div>
            <div className="ct-cards">
              {sent.map((r) => (
                <SentCard key={r.id} request={r} busy={busy.has(r.id)} perform={(a) => perform(r.id, a)} />
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

function CardUser({ request, extra }: { request: FriendRequest; extra: string }) {
  return (
    <div className="ct-card-user">
      <Avatar url={request.avatar} name={request.name} size={48} />
      <div className="ct-card-name">
        <span className="ct-card-title truncate">{request.name || 'Người dùng Zalo'}</span>
        <span className="ct-card-extra truncate">{extra}</span>
      </div>
    </div>
  );
}

function ReceivedCard({ request, busy, perform }: { request: FriendRequest; busy: boolean; perform: (a: RequestAction) => void }) {
  const extra = request.date ? ago(request.date) : 'Muốn kết bạn với bạn';
  return (
    <div className={`ct-card ${busy ? 'is-busy' : ''}`}>
      <CardUser request={request} extra={extra} />
      <button
        className="ct-card-corner"
        title="Nhắn tin"
        aria-label={`Nhắn tin cho ${request.name}`}
        onClick={() => openContactConversation(request.id, { name: request.name, avatar: request.avatar })}
      >
        <MessageCircle size={18} />
      </button>
      <div className={`ct-card-message ${request.message ? '' : 'is-empty'}`}>{request.message || 'Không có lời nhắn'}</div>
      <div className="ct-card-cta">
        <button className="ct-btn ct-btn-secondary" disabled={busy} onClick={() => perform('decline')}>
          Từ chối
        </button>
        <button className="ct-btn ct-btn-tonal" disabled={busy} onClick={() => perform('accept')}>
          {busy ? <Spinner size={13} /> : 'Đồng ý'}
        </button>
      </div>
    </div>
  );
}

function SentCard({ request, busy, perform }: { request: FriendRequest; busy: boolean; perform: (a: RequestAction) => void }) {
  const extra = request.date ? ago(request.date) : 'Đang chờ người này chấp nhận';
  return (
    <div className={`ct-card is-sent ${busy ? 'is-busy' : ''}`}>
      <CardUser request={request} extra={extra} />
      <button
        className="ct-card-corner"
        title="Nhắn tin"
        aria-label={`Nhắn tin cho ${request.name}`}
        onClick={() => openContactConversation(request.id, { name: request.name, avatar: request.avatar })}
      >
        <MessageCircle size={18} />
      </button>
      <div className="ct-card-cta">
        <button className="ct-btn ct-btn-secondary ct-btn-grow" disabled={busy} onClick={() => perform('cancel')}>
          {busy ? <Spinner size={13} /> : 'Thu hồi lời mời'}
        </button>
      </div>
    </div>
  );
}

/** "Lời mời vào nhóm": the contacts adapter does not read group invitations; the page says there are none to show. */
export function GroupInvitesPage() {
  return (
    <div className="ct-page">
      <ContactsPageHeader icon={UsersRound} title="Lời mời vào nhóm và cộng đồng" />
      <div className="ct-page-scroll">
        <div className="ct-panel">
          <ContactsEmpty
            icon={MailOpen}
            title="Không có lời mời vào nhóm"
            description="Khi có ai đó mời bạn vào nhóm, lời mời sẽ hiện trong cuộc trò chuyện với người đó."
          />
        </div>
      </div>
    </div>
  );
}
