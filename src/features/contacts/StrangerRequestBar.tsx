// Request bar at the bottom of a stranger's chat (design wave 3 #8, Instagram's message-request bar in Zalo PC colours):
// "<Tên> chưa có trong danh bạ của bạn" + Chặn / Kết bạn. "Kết bạn" sends the official greeting through
// `__zaloContacts.sendRequest` (source: chat); "Chặn" asks first, then blocks messages and calls (official `blockFriend`).
// The bar hides itself once the person is a friend, and shows "Đồng ý" when they already asked me.

import { Ban, Check, UserCheck, UserPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  acceptFriendRequest,
  blockContact,
  sendFriendRequest,
  strangerInfo,
  useContacts,
  type StrangerInfo,
} from '../../engine/contacts';
import { Alert } from '../../ui/Overlays';
import { Spinner } from '../../ui/Spinner';
import './contacts.css';

type Phase = 'idle' | 'sending' | 'sent' | 'accepting' | 'blocking' | 'blocked';

export interface StrangerRequestBarProps {
  /** The stranger's user id (= the 1-1 conversation id). */
  conversationId: string;
  /** Display name shown in the bar. */
  name: string;
}

export function StrangerRequestBar({ conversationId, name }: StrangerRequestBarProps) {
  const [info, setInfo] = useState<StrangerInfo | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [confirmBlock, setConfirmBlock] = useState(false);
  const isFriend = useContacts((s) => s.friends.some((f) => f.id === conversationId));
  const inSent = useContacts((s) => s.sent.some((r) => r.id === conversationId));
  const inReceived = useContacts((s) => s.received.some((r) => r.id === conversationId));

  useEffect(() => {
    let live = true;
    setInfo(null);
    setPhase('idle');
    void strangerInfo(conversationId).then((i) => live && setInfo(i));
    return () => {
      live = false;
    };
  }, [conversationId]);

  if (isFriend || info?.isFriend || phase === 'blocked') return null;

  const requested = phase === 'sent' || inSent || !!info?.requested;
  const requesting = !requested && (inReceived || !!info?.requesting);
  const who = name || 'Người này';

  const add = async () => {
    setPhase('sending');
    const fresh = info ?? (await strangerInfo(conversationId));
    const result = await sendFriendRequest(conversationId, fresh?.defaultMessage || `Xin chào, mình là bạn của ${who}. Kết bạn với mình nhé!`);
    setPhase(result.ok || result.pending ? 'sent' : 'idle');
  };

  const accept = () => {
    setPhase('accepting');
    acceptFriendRequest(conversationId);
  };

  const block = async () => {
    setConfirmBlock(false);
    setPhase('blocking');
    const result = await blockContact(conversationId);
    setPhase(result.ok ? 'blocked' : 'idle');
  };

  const busy = phase === 'sending' || phase === 'accepting' || phase === 'blocking';

  return (
    <div className="ct-stranger-bar" role="region" aria-label="Người lạ">
      <div className="ct-stranger-title">
        <b>{who}</b> chưa có trong danh bạ của bạn
      </div>
      <div className="ct-stranger-sub">
        {requested
          ? 'Đã gửi lời mời kết bạn. Bạn vẫn có thể nhắn tin trong lúc chờ.'
          : requesting
            ? `${who} đã gửi lời mời kết bạn cho bạn.`
            : 'Hãy cẩn trọng với tin nhắn từ người lạ. Kết bạn để dễ liên lạc hơn.'}
      </div>
      <div className="ct-stranger-actions">
        <button className="ct-stranger-block" disabled={busy} onClick={() => setConfirmBlock(true)}>
          {phase === 'blocking' ? <Spinner size={13} /> : <Ban size={16} />} Chặn
        </button>
        {requested ? (
          <button className="ct-stranger-done" disabled>
            <Check size={16} /> Đã gửi lời mời kết bạn
          </button>
        ) : requesting ? (
          <button className="ct-stranger-add" disabled={busy} onClick={accept}>
            {phase === 'accepting' ? <Spinner size={13} /> : <UserCheck size={16} />} Đồng ý kết bạn
          </button>
        ) : (
          <button className="ct-stranger-add" disabled={busy} onClick={() => void add()}>
            {phase === 'sending' ? <Spinner size={13} /> : <UserPlus size={16} />} Kết bạn
          </button>
        )}
      </div>
      {confirmBlock && (
        <Alert
          title={`Chặn ${who}?`}
          message="Bạn sẽ không nhận được tin nhắn và cuộc gọi từ người này nữa."
          buttons={[
            { label: 'Chặn', role: 'destructive', onClick: () => void block() },
            { label: 'Hủy', role: 'cancel', onClick: () => setConfirmBlock(false) },
          ]}
        />
      )}
    </div>
  );
}
