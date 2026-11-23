// Mock of call-adapter.js (`__zaloCall`) and the native helper events (`compola://call-event`).
// Scenarios: `&incomingCall=1` (1-1) / `&incomingCall=group`, `&callPicker=1` (group participant picker),
// `&callHelper=missing` (helper unavailable), `&callUnsupported=1` (account without calls).

import { useEngine } from '../../store';
import { conversations, groupMembers } from '../mockData';
import { mockContext, onMockBoot, registerMockAdapter } from '../registry';

let busy = false;
let pickerToken = 0;
let openPicker: { token: string; convId: string; video: boolean } | null = null;

const status = () => {
  const { post, params } = mockContext();
  const id = useEngine.getState().openConversationId;
  const conv = conversations.find((c) => c.id === id);
  const self = id === useEngine.getState().selfConversationId;
  post({
    call: {
      kind: 'status',
      ready: true,
      supported: !params.has('callUnsupported'),
      video: true,
      busy,
      conv: conv && !self ? { id: conv.id, can: !conv.isGroup && !conv.stranger, group: conv.isGroup ? { disabled: conv.members > 40, feature: true } : null } : null,
    },
  });
};

const showPicker = (convId: string, video: boolean, add = false) => {
  const conv = conversations.find((c) => c.id === convId);
  const members = groupMembers[convId] ?? [
    { id: 'u-huy', name: 'Lê Quang Huy', avatar: 'https://i.pravatar.cc/150?img=12' },
    { id: 'u-mai', name: 'Phạm Ngọc Mai', avatar: 'https://i.pravatar.cc/150?img=32' },
  ];
  pickerToken += 1;
  openPicker = { token: `pk${pickerToken}`, convId, video };
  mockContext().post({
    call: {
      kind: 'picker',
      token: openPicker.token,
      add,
      video: add ? null : video,
      group: { id: convId, name: conv?.name ?? 'Nhóm', avatar: conv?.avatar ?? '' },
      max: 4,
      existing: add ? [members[0]?.id] : [],
      note: convId === 'g-k15' ? 'Bạn chỉ có thể gọi cho trưởng/phó nhóm.' : '',
      members,
    },
  });
};

/** A call that rings for a while then ends (the helper reports `incall` then `free`). */
const runCall = () => {
  const { emit } = mockContext();
  busy = true;
  status();
  emit('compola://call-event', { kind: 'callState', state: 'incall' });
  setTimeout(() => {
    busy = false;
    emit('compola://call-event', { kind: 'callState', state: 'free' });
    status();
  }, 12_000);
};

registerMockAdapter('__zaloCall', {
  start: (uid: string, video: boolean, seq: number) => {
    const { post } = mockContext();
    const group = uid.startsWith('g');
    if (busy) {
      post({ call: { kind: 'result', seq, video, result: 'busy', group } });
      return 'busy';
    }
    if (useEngine.getState().openConversationId !== uid) post({ call: { kind: 'open', uid } });
    if (group) {
      setTimeout(() => showPicker(uid, true), 300);
      return 'started';
    }
    const result = uid === 'u-tuan' ? 'unavailable' : 'started';
    post({ call: { kind: 'result', seq, video, result, group } });
    if (result === 'started') runCall();
    return result;
  },
  pickerConfirm: (token: string, ids: string[]) => {
    if (!openPicker || openPicker.token !== token) return 'stale';
    openPicker = null;
    if (!ids.length) return 'invalid';
    runCall();
    return 'started';
  },
  pickerCancel: (token: string) => {
    if (!openPicker || openPicker.token !== token) return 'stale';
    openPicker = null;
    return 'cancelled';
  },
  refresh: () => status(),
});

onMockBoot(({ emit, post, params }) => {
  if (params.get('callHelper') === 'missing') {
    emit('compola://call-event', {
      kind: 'helperUnavailable',
      reason: 'Không tìm thấy trình gọi của Zalo (ZaloHelper.app/Contents/MacOS/ZaloCall). Hãy mở lại ứng dụng để cài lại.',
    });
  } else {
    emit('compola://call-event', { kind: 'helperStarted', pid: 4242 });
    setTimeout(() => emit('compola://call-event', { kind: 'ready' }), 200);
  }
  status();
  // The adapter re-publishes when the open conversation changes.
  useEngine.subscribe((s, prev) => {
    if (s.openConversationId !== prev.openConversationId) setTimeout(status, 120);
  });
  const incoming = params.get('incomingCall');
  if (incoming) {
    setTimeout(
      () =>
        post({
          call:
            incoming === 'group'
              ? { kind: 'incoming', uid: 'g-team', name: 'Team Sản phẩm Compola', caller: 'Lê Quang Huy', avatar: '', group: true, busy: false }
              : { kind: 'incoming', uid: 'u-lan', name: 'Trần Thị Lan', caller: '', avatar: 'https://i.pravatar.cc/150?img=47', group: false, busy: false },
        }),
      1200,
    );
  }
  if (params.has('callPicker')) setTimeout(() => showPicker(params.get('callPicker') === 'k15' ? 'g-k15' : 'g-team', true, params.get('callPicker') === 'add'), 1200);
});
