// "Chia sẻ": the conversations a message is forwarded to (Swift `ForwardSheet`).

import { dismissForward, forward } from '../../engine/messageActions';
import type { ForwardRequest } from '../../engine/store';
import { showToast } from '../../engine/toast';
import { RemoteImage } from '../../ui/RemoteImage';
import { ConversationPickerSheet } from './ConversationPickerSheet';

/** Official `forward_conv_limit`. */
const maxTargets = 100;

export function ForwardSheet({ request }: { request: ForwardRequest }) {
  const m = request.message;
  const k = m.kind;
  const thumb =
    k.type === 'photo' ? (m.isE2EE ? null : k.url) : k.type === 'video' ? k.thumbnail : k.type === 'gif' || k.type === 'sticker' ? k.url : k.type === 'link' ? k.thumbnail : null;
  return (
    <ConversationPickerSheet
      title="Chia sẻ"
      maxTargets={maxTargets}
      hint={(n) => (n ? `Đã chọn ${n}` : 'Chọn hội thoại để chia sẻ')}
      onClose={dismissForward}
      preview={
        <>
          {thumb && <RemoteImage url={thumb} className="forward-thumb" placeholder={<span />} />}
          <div style={{ minWidth: 0 }}>
            <div className="secondary" style={{ fontSize: 11 }}>
              Nội dung chia sẻ
            </div>
            <div className="clamp-3" style={{ fontSize: 12.5 }}>
              {m.text || 'Tin nhắn'}
            </div>
          </div>
        </>
      }
      onSubmit={async (ids) => {
        const outcome = await forward(m, ids);
        if (outcome.kind === 'done' || outcome.kind === 'pending') {
          showToast(outcome.kind === 'done' ? (outcome.text ?? 'Đã chia sẻ tin nhắn') : outcome.text, request.conversationId);
          dismissForward();
          return null;
        }
        return outcome.kind === 'failed' ? outcome.text : 'Có lỗi khi chia sẻ tin nhắn';
      }}
    />
  );
}
