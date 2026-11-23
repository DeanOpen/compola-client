// "Chia sẻ": the conversations a message is forwarded to — the official SHARE_MSG_COMPOSE picker, native (Swift
// `ForwardSheet`).

import { CheckCircle2, Circle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { dismissForward, forward } from '../../engine/messageActions';
import { displayName, selfConversationTitle, type ConversationSummary } from '../../engine/models/conversations';
import { useEngine, visibleConversations, type ForwardRequest } from '../../engine/store';
import { showToast } from '../../engine/toast';
import { Avatar } from '../../ui/Avatar';
import { Sheet, SheetHeader } from '../../ui/Overlays';
import { RemoteImage } from '../../ui/RemoteImage';
import { Spinner } from '../../ui/Spinner';
import { fold } from '../conversations/support';

/** Official `forward_conv_limit`. */
const maxTargets = 100;

export function ForwardSheet({ request }: { request: ForwardRequest }) {
  const conversations = useEngine((s) => s.conversations);
  const selfId = useEngine((s) => s.selfConversationId);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const title = (c: ConversationSummary) => (c.id === selfId ? selfConversationTitle : displayName(c));
  const rows = useMemo(() => {
    const all = [...visibleConversations(useEngine.getState())].sort((a, b) => (b.preview?.date ?? 0) - (a.preview?.date ?? 0));
    const needle = fold(search.trim());
    return needle ? all.filter((c) => fold(title(c)).includes(needle)) : all;
  }, [conversations, search, selfId]);

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length < maxTargets ? [...s, id] : s));

  const send = async () => {
    if (!selected.length || busy) return;
    setBusy(true);
    setFailure(null);
    const outcome = await forward(request.message, selected);
    setBusy(false);
    if (outcome.kind === 'done') {
      showToast(outcome.text ?? 'Đã chia sẻ tin nhắn', request.conversationId);
      dismissForward();
    } else if (outcome.kind === 'pending') {
      showToast(outcome.text, request.conversationId);
      dismissForward();
    } else setFailure(outcome.kind === 'failed' ? outcome.text : 'Có lỗi khi chia sẻ tin nhắn');
  };

  const m = request.message;
  const thumb =
    m.kind.type === 'photo' ? (m.isE2EE ? null : m.kind.url) : m.kind.type === 'video' ? m.kind.thumbnail : m.kind.type === 'gif' || m.kind.type === 'sticker' ? m.kind.url : m.kind.type === 'link' ? m.kind.thumbnail : null;

  return (
    <Sheet onClose={dismissForward} width={440} height={580}>
      <SheetHeader title="Chia sẻ" onClose={dismissForward} />
      <div className="forward-top">
        <div className="forward-preview">
          {thumb && <RemoteImage url={thumb} className="forward-thumb" placeholder={<span />} />}
          <div style={{ minWidth: 0 }}>
            <div className="secondary" style={{ fontSize: 11 }}>
              Nội dung chia sẻ
            </div>
            <div className="clamp-3" style={{ fontSize: 12.5 }}>
              {m.text || 'Tin nhắn'}
            </div>
          </div>
        </div>
        <input className="text-field" autoFocus placeholder="Tìm kiếm hội thoại cần chia sẻ" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div className="forward-list">
        {rows.map((c) => {
          const on = selected.includes(c.id);
          return (
            <button key={c.id} className="forward-row" onClick={() => toggle(c.id)} disabled={!on && selected.length >= maxTargets} aria-pressed={on}>
              {on ? <CheckCircle2 size={17} className="tint" /> : <Circle size={17} className="tertiary" />}
              <Avatar url={c.avatar} name={title(c)} size={30} />
              <span className="truncate">{title(c)}</span>
            </button>
          );
        })}
      </div>
      <div className="sheet-footer">
        <span className={failure ? 'sheet-footer-error' : 'secondary'}>{failure ?? (selected.length ? `Đã chọn ${selected.length}` : 'Chọn hội thoại để chia sẻ')}</span>
        <button className="btn btn-glass" onClick={dismissForward}>
          Hủy
        </button>
        <button className="btn btn-prominent" disabled={!selected.length || busy} onClick={() => void send()}>
          {busy ? <Spinner size={13} /> : 'Chia sẻ'}
        </button>
      </div>
    </Sheet>
  );
}
