// Voice / video call buttons of the chat header (Swift `ChatCallButtons`): 1-1 conversations — friends only; groups —
// video only, by the member thresholds of the official header. Disabled with a tooltip while calls are unavailable.
// Plain icon buttons that sit with the header's other right-hand icons (docs/zalo-pc-style.md §3).

import { Phone, Video } from 'lucide-react';
import { callAvailability, startCall, useCalls, type CallAvailability } from '../../engine/calls';
import type { ConversationSummary } from '../../engine/models/conversations';
import { useEngine } from '../../engine/store';

export function CallButtons({ conversation }: { conversation: ConversationSummary }) {
  const selfId = useEngine((s) => s.selfConversationId);
  // The whole call state (small, rarely changing): availability is derived from several of its fields.
  const calls = useCalls();
  const audio = callAvailability(calls, conversation, false, selfId);
  const video = callAvailability(calls, conversation, true, selfId);
  return (
    <>
      {audio.kind !== 'hidden' && <CallButton conversation={conversation} availability={audio} isVideo={false} />}
      {video.kind !== 'hidden' && <CallButton conversation={conversation} availability={video} isVideo />}
    </>
  );
}

function CallButton({ conversation, availability, isVideo }: { conversation: ConversationSummary; availability: CallAvailability; isVideo: boolean }) {
  const title = isVideo ? 'Gọi video' : 'Gọi thoại';
  const tooltip =
    availability.kind === 'disabled'
      ? availability.reason
      : conversation.isGroup
        ? `Gọi video nhóm ${conversation.name}`
        : `${title} với ${conversation.name}`;
  return (
    <button
      className="toolbar-button"
      disabled={availability.kind !== 'available'}
      title={tooltip}
      aria-label={title}
      onClick={() => startCall(conversation.id, isVideo)}
    >
      {isVideo ? <Video size={18} strokeWidth={1.75} /> : <Phone size={17} strokeWidth={1.75} />}
    </button>
  );
}
