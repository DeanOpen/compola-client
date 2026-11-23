// Mock card-action sheets (card-actions-adapter.js contract): `__zaloChat.performAction` answers `present` effects for
// the demo e-card's buttons, plus alias save, group invite preview / join and a sticker category.
// Dev aids: `&cardDemo=1` adds an e-card with those buttons to the open chat; `&cardSheet=alias|invite|stickers|poll`
// presents one sheet directly on the open conversation (e.g. `&open=u-lan&cardSheet=alias`).

import type { Json } from '../../models/json';
import { message } from '../mockData';
import { onMockBoot, registerMockAdapter } from '../registry';

const effects: Record<string, Json> = {
  'demo:alias': { type: 'alias', uid: '84901234567', name: 'Trần Thị Lan', suggest: 'Lan', placeholder: 'Nhập tên gợi nhớ', max: 50, hasAlias: false },
  'demo:invite': { type: 'groupInvite', url: 'https://zalo.me/g/abcxyz123' },
  'demo:stickers': { type: 'stickers', cateId: 10421 },
  'demo:poll': { type: 'poll', pollId: '1' },
  'demo:tab': { type: 'tab', tab: 'groups' },
};

const demoCard = (convId: string) =>
  message(convId, {
    from: 'u-lan',
    name: 'Trần Thị Lan',
    avatar: 'https://i.pravatar.cc/150?img=47',
    kind: {
      type: 'ecard',
      style: 'banner',
      image: 'https://picsum.photos/id/1025/600/340',
      thumb: '',
      title: 'Lan đã gửi lời mời tham gia nhóm “Hội yêu mèo”',
      description: 'Đặt tên gợi nhớ, xem nhóm hoặc gửi sticker chào nhé!',
      actions: [],
      avatars: [],
      reminderTitle: '',
      reminderStart: 0,
      reminderRepeat: '',
    },
    text: '[Thiệp]',
    ago: 0,
    buttons: [
      { ref: 'demo:alias', label: 'Đặt tên gợi nhớ', enabled: true, help: '' },
      { ref: 'demo:invite', label: 'Xem nhóm', enabled: true, help: '' },
    ],
  });

const stickerUrl = (i: number) => `https://picsum.photos/seed/sticker${i}/160/160`;

registerMockAdapter('__zaloChat', {
  performAction: async (_convId: string, _msgId: string, ref: string) => {
    await new Promise((r) => setTimeout(r, 300));
    if (effects[ref]) return { status: 'effect', effect: effects[ref] };
    if (ref === 'call:back') return { status: 'unsupported', text: 'Cuộc gọi chưa hỗ trợ trên ứng dụng này' };
    return { status: 'effect', effect: { type: 'openURL', url: 'https://zalo.me' } };
  },
  aliasSave: async (_uid: string, name: string) => {
    await new Promise((r) => setTimeout(r, 600));
    if (name.includes('#fail')) return { ok: false, text: 'Có lỗi xảy ra, vui lòng thử lại sau' };
    return { ok: true, text: name.trim() ? 'Đã đổi tên gợi nhớ' : 'Đã xóa tên gợi nhớ' };
  },
  groupPreview: async () => {
    await new Promise((r) => setTimeout(r, 500));
    return {
      state: 'preview',
      groupId: 'g8801234',
      name: 'Hội yêu mèo Sài Gòn 🐱',
      avatar: 'https://picsum.photos/id/40/200/200',
      totalMember: 1284,
      desc: 'Nơi chia sẻ kinh nghiệm nuôi mèo, nhận nuôi và cứu hộ mèo ở TP.HCM.',
      community: false,
      creatorName: 'Phạm Ngọc Mai',
      members: [
        { id: 'u-mai', name: 'Phạm Ngọc Mai', avatar: 'https://i.pravatar.cc/150?img=32', admin: true },
        { id: 'u-lan', name: 'Trần Thị Lan', avatar: 'https://i.pravatar.cc/150?img=47', admin: false },
        { id: 'u-bao', name: 'Vũ Gia Bảo', avatar: 'https://i.pravatar.cc/150?img=68', admin: false },
        { id: 'u-ha', name: 'Hoàng Thu Hà', avatar: 'https://i.pravatar.cc/150?img=5', admin: false },
      ],
    };
  },
  groupJoin: async () => {
    await new Promise((r) => setTimeout(r, 700));
    return { state: 'pending', text: 'Đã gửi yêu cầu tham gia nhóm. Vui lòng chờ trưởng/phó nhóm duyệt.' };
  },
  stickerCategory: async (id: number) => {
    await new Promise((r) => setTimeout(r, 400));
    return {
      id,
      name: 'Mèo Bông',
      icon: stickerUrl(0),
      stickers: Array.from({ length: 16 }, (_, i) => ({ ref: `${id}_${i + 1}`, url: stickerUrl(i + 1) })),
    };
  },
  stickerCategorySend: async () => {
    await new Promise((r) => setTimeout(r, 500));
    return { status: 'done' };
  },
  cardReset: () => null,
});

onMockBoot((c) => {
  const sheet = c.params.get('cardSheet');
  const demo = c.params.has('cardDemo');
  if (!sheet && !demo) return;
  setTimeout(() => {
    void Promise.all([import('../../store'), import('../../cardSheets')]).then(([store, cards]) => {
      const convId = store.getEngine().openConversationId;
      if (!convId) return;
      if (demo) {
        const m = demoCard(convId);
        c.post({ chat: { convId, messages: [m], removed: [], hasMore: true, reset: false } });
      }
      const key = sheet === 'invite' ? 'demo:invite' : sheet ? `demo:${sheet}` : null;
      if (key && effects[key]) cards.presentCardEffect(effects[key], convId);
    });
  }, 1600);
});
