// Mock of `window.__zaloContacts` (contacts-adapter.js), `__zaloGroupCreate` (group-create-adapter.js) and the contact profile of
// the card-actions adapter. Dev aids: `&dest=friends|groups|requests|groupInvites|addFriend`, `&demo=stranger`, `&select=<id>`, `&sheet=createGroup`.

import type { Json } from '../../models/json';
import { conversations, groupMembers, ME } from '../mockData';
import { onMockBoot, registerMockAdapter, type MockContext } from '../registry';

const now = Date.now();
const min = 60_000;
const day = 24 * 60 * min;

interface MockFriend {
  id: string;
  name: string;
  zaloName: string;
  avatar: string;
  lastActive: number;
  online: boolean;
  bio?: string;
}

const friends: MockFriend[] = [
  ...conversations
    .filter((c) => !c.isGroup && !c.stranger && c.id !== 'u-me-cloud')
    .map((c, i) => ({ id: c.id, name: c.name, zaloName: c.name.split(' ').slice(-2).join(' '), avatar: c.avatar, lastActive: now - (i + 1) * 37 * min, online: i % 3 === 0 })),
  ...[...groupMembers['g-team'], ...groupMembers['g-family']]
    .filter((m, i, all) => !conversations.some((c) => c.id === m.id) && all.findIndex((x) => x.id === m.id) === i)
    .map((m, i) => ({ id: m.id, name: m.name, zaloName: '', avatar: m.avatar, lastActive: now - (i + 2) * day, online: false })),
  { id: 'u-an', name: 'Âu Dương An', zaloName: 'An Âu', avatar: 'https://i.pravatar.cc/150?img=15', lastActive: now - 3 * min, online: true },
  { id: 'u-chi', name: 'Cao Minh Chi', zaloName: '', avatar: 'https://i.pravatar.cc/150?img=44', lastActive: 0, online: false },
  { id: 'u-yen', name: 'Đinh Hải Yến', zaloName: 'Yến', avatar: '', lastActive: now - 5 * day, online: false },
  { id: 'u-kim', name: 'Kim Ji-woo', zaloName: '', avatar: 'https://i.pravatar.cc/150?img=25', lastActive: now - 2 * 60 * min, online: false },
  { id: 'u-num', name: '123 Taxi', zaloName: '', avatar: '', lastActive: 0, online: false },
];

const bios: Record<string, string> = {
  'u-lan': 'Yêu mèo, thích cà phê sữa đá ☕️',
  'u-huy': 'Product @ Compola · Hà Nội',
  'u-an': 'Sống chậm lại một chút 🌿',
};

let groups: Json[] = conversations.filter((c) => c.isGroup).map((c) => ({ id: c.id, name: c.name, avatar: c.avatar, members: c.members, type: 0 }));
groups.push({ id: 'g-cd-runners', name: 'Cộng đồng Runner Việt', avatar: '', members: 1840, type: 1 });

let received: Json[] = [
  { id: 'u-r1', name: 'Lý Thanh Tâm', avatar: 'https://i.pravatar.cc/150?img=56', message: 'Chào bạn, mình là Tâm, đồng nghiệp cũ ở công ty ABC. Kết bạn nhé!', time: now - 25 * min },
  { id: 'u-r2', name: 'Mai Phương Thảo', avatar: 'https://i.pravatar.cc/150?img=41', message: 'Xin chào, mình tìm thấy bạn qua số điện thoại.', time: now - 2 * day },
  { id: 'u-r3', name: 'Trịnh Công Sơn', avatar: '', message: '', time: 0 },
];
let sent: Json[] = [{ id: 'u-s1', name: 'Phan Văn Đức', avatar: 'https://i.pravatar.cc/150?img=60', message: 'Xin chào, mình là Minh Anh.', time: now - 3 * day }];

// Group invitations (official invitation box): read only while watched.
let groupInvites: Json[] = [
  {
    id: 'g-inv-book', name: 'Hội đọc sách Sài Gòn', avatar: 'https://picsum.photos/id/24/200/200', members: 342, community: false,
    inviterId: 'u-lan', inviterName: 'Lan', inviterAvatar: conversations.find((c) => c.id === 'u-lan')?.avatar ?? '', inviterIsOwner: true,
    expiresAt: now + 6 * day + 3 * 60 * min, pendingReview: false,
  },
  {
    id: 'g-inv-dev', name: 'Cộng đồng Lập trình viên Việt Nam', avatar: '', members: 12_480, community: true,
    inviterId: 'u-an', inviterName: 'Âu Dương An', inviterAvatar: 'https://i.pravatar.cc/150?img=15', inviterIsOwner: false,
    expiresAt: now + 5 * 60 * min, pendingReview: false,
  },
];
let invitesWatched = false;

// "Có thể bạn quen" (recommendation cache, recommType 1).
let suggestions: Json[] = [
  { id: 'u-sg1', name: 'Trần Bảo Ngọc', avatar: 'https://i.pravatar.cc/150?img=47', reason: 'Từ số điện thoại', defaultMessage: 'Xin chào, mình là Nguyễn Minh Anh. Mình tìm thấy bạn bằng số điện thoại. Kết bạn với mình nhé!' },
  { id: 'u-sg2', name: 'Võ Quốc Việt', avatar: 'https://i.pravatar.cc/150?img=13', reason: 'Từ nhóm trò chuyện', defaultMessage: 'Xin chào, mình là Nguyễn Minh Anh. Kết bạn với mình nhé!' },
  { id: 'u-sg3', name: 'Hà My', avatar: '', reason: 'Có thể bạn quen', defaultMessage: 'Xin chào, mình là Nguyễn Minh Anh. Kết bạn với mình nhé!' },
  { id: 'u-sg4', name: 'Lâm Gia Huy', avatar: 'https://i.pravatar.cc/150?img=59', reason: 'Từ danh bạ máy', defaultMessage: 'Xin chào, mình là Nguyễn Minh Anh. Kết bạn với mình nhé!' },
];
const invitesSnapshot = (loading = false) => ({
  available: true, watching: invitesWatched, loading, total: groupInvites.length, hasMore: false, items: invitesWatched ? groupInvites : [],
});

let noticeSeq = 0;
let lastFound: Json | null = null;
const blocked = ['u-qa'];

const friendRows = () => friends.map(({ bio: _b, ...f }) => f);

export const mockFriendIds = () => friends.map((f) => f.id);

onMockBoot((ctx) => {
  setTimeout(() => {
    ctx.post({
      contacts: {
        friends: friendRows(),
        groups,
        received,
        sent,
        pendingRequestCount: received.length,
        loading: { requests: false },
        groupInvites: invitesSnapshot(),
        groupInviteUnread: groupInvites.length,
        suggestions,
      },
    });
  }, 300);
  void devAids(ctx);
});

const devAids = async (ctx: MockContext) => {
  const dest = ctx.params.get('dest');
  const dialog = ctx.params.get('dialog');
  const sheet = ctx.params.get('sheet');
  const demo = ctx.params.get('demo');
  if (!dest && !dialog && sheet !== 'createGroup' && demo !== 'stranger') return;
  const [{ shell }, { contactsUi }] = await Promise.all([import('../../../shell/shellStore'), import('../../../features/contacts/contactsUi')]);
  setTimeout(() => {
    if (demo === 'stranger' && !ctx.params.get('open')) shell.select('u-stranger2');
    if (dest === 'friends' || dest === 'groups' || dest === 'requests' || dest === 'addFriend' || dest === 'groupInvites') shell.setDestination(dest);
    if (dialog === 'addFriend') {
      contactsUi.openAddFriend();
      // `&phone=…`: search right away (…111 friend, …222 requested, …333 requesting, …000 not found).
      const phone = ctx.params.get('phone');
      if (phone)
        setTimeout(() => {
          const input = document.querySelector<HTMLInputElement>('.ct-phone-input');
          if (!input) return;
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, phone);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          setTimeout(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })), 50);
        }, 200);
    }
    if (dialog?.startsWith('profile:')) contactsUi.showProfile(dialog.slice(8));
    if (sheet === 'createGroup') {
      const picks = ctx.params.get('picks');
      contactsUi.composeGroup(picks ? picks.split(',') : []);
    }
  }, 500);
};

const later = (ctx: () => void, ms = 600) => setTimeout(ctx, ms);

let post: ((s: Json) => void) | null = null;
onMockBoot((ctx) => {
  post = ctx.post;
});
const postContacts = (contacts: Json) => post?.({ contacts });
const notice = (ok: boolean, text: string) => {
  noticeSeq += 1;
  return { seq: noticeSeq, ok, text };
};

registerMockAdapter('__zaloContacts', {
  watchGroupInvites: (on: boolean) => {
    invitesWatched = !!on;
    if (!invitesWatched) return postContacts({ groupInvites: invitesSnapshot() });
    postContacts({ groupInvites: { ...invitesSnapshot(true), items: [] }, groupInviteUnread: 0 });
    later(() => postContacts({ groupInvites: invitesSnapshot() }), 700);
  },
  loadMoreGroupInvites: () => {},
  dismissSuggestion: (id: string) => {
    suggestions = suggestions.filter((x) => x.id !== id);
    postContacts({ suggestions });
  },
  requestInfo: (id: string) => ({
    isFriend: friends.some((f) => f.id === id),
    requested: sent.some((x) => x.id === id),
    requesting: received.some((x) => x.id === id),
    defaultMessage: 'Xin chào, mình là Nguyễn Minh Anh. Kết bạn với mình nhé!',
    maxMessage: 150,
  }),
  block: async (_id: string) => {
    await new Promise((r) => setTimeout(r, 400));
    const text = 'Bạn đã chặn tin nhắn và cuộc gọi từ người này';
    postContacts({ notice: notice(true, text) });
    return { ok: true, text };
  },
  acceptGroupInvite: async (id: string) => {
    await new Promise((r) => setTimeout(r, 600));
    const inv = groupInvites.find((x) => x.id === id);
    if (!inv) return { ok: false, text: 'Lời mời tham gia nhóm không tồn tại' };
    if (inv.community) {
      inv.pendingReview = true;
      const text = 'Yêu cầu của bạn đã được gửi đến trưởng/phó cộng đồng chờ phê duyệt';
      postContacts({ groupInvites: invitesSnapshot(), notice: notice(true, text) });
      return { ok: false, pending: true, text };
    }
    groupInvites = groupInvites.filter((x) => x.id !== id);
    groups = [...groups, { id, name: inv.name, avatar: inv.avatar, members: Number(inv.members) + 1, type: 0 }];
    postContacts({ groupInvites: invitesSnapshot(), groups, notice: notice(true, 'Đã tham gia nhóm.') });
    return { ok: true, text: 'Đã tham gia nhóm.' };
  },
  declineGroupInvite: async (id: string) => {
    await new Promise((r) => setTimeout(r, 500));
    const inv = groupInvites.find((x) => x.id === id);
    groupInvites = groupInvites.filter((x) => x.id !== id);
    const text = inv?.community ? 'Đã xoá lời mời vào cộng đồng' : 'Đã xoá lời mời vào nhóm';
    postContacts({ groupInvites: invitesSnapshot(), notice: notice(true, text) });
    return { ok: true, text };
  },
  refresh: () => {
    postContacts({ loading: { requests: true } });
    later(() => postContacts({ loading: { requests: false }, received, sent, pendingRequestCount: received.length }), 900);
  },
  accept: (id: string) => {
    const r = received.find((x) => x.id === id);
    later(() => {
      received = received.filter((x) => x.id !== id);
      if (r) friends.push({ id, name: String(r.name), zaloName: '', avatar: String(r.avatar), lastActive: Date.now(), online: true });
      postContacts({ received, friends: friendRows(), pendingRequestCount: received.length, notice: notice(true, 'Đã chấp nhận lời mời kết bạn.') });
    });
  },
  decline: (id: string) => {
    later(() => {
      received = received.filter((x) => x.id !== id);
      postContacts({ received, pendingRequestCount: received.length, notice: notice(true, 'Đã từ chối lời mời kết bạn.') });
    });
  },
  cancel: (id: string) => {
    later(() => {
      sent = sent.filter((x) => x.id !== id);
      postContacts({ sent, notice: notice(true, 'Đã thu hồi lời mời kết bạn.') });
    });
  },
  search: (phone: string, _iso?: string) => {
    postContacts({ search: { seq: 1, status: 'searching' } });
    later(() => {
      const digits = phone.replace(/\D/g, '');
      if (digits.length < 9) {
        postContacts({ search: { seq: 2, status: 'error', error: 'Số điện thoại không hợp lệ' } });
        return;
      }
      if (digits.endsWith('000')) {
        postContacts({ search: { seq: 2, status: 'error', error: 'Số điện thoại chưa đăng ký tài khoản hoặc không cho phép tìm kiếm' } });
        return;
      }
      const isSelf = digits.endsWith(ME.phoneNumber.slice(-9));
      // …111 a friend, …333 someone who sent me a request (Lý Thanh Tâm), …222 someone I asked, anything else a stranger.
      const who = isSelf ? null : digits.endsWith('111') ? 'u-lan' : digits.endsWith('333') ? 'u-r1' : digits.endsWith('222') ? 'u-s1' : 'u-found';
      const friend = friends.find((f) => f.id === who);
      const req = [...received, ...sent].find((r) => r.id === who);
      lastFound = {
        id: isSelf ? ME.userId : who,
        name: isSelf ? ME.displayName : friend?.name ?? (req ? String(req.name) : 'Đặng Thuỳ Linh'),
        zaloName: isSelf ? ME.zaloName : friend?.zaloName ?? (req ? '' : 'Linh Đặng'),
        avatar: isSelf ? '' : friend?.avatar ?? (req ? String(req.avatar) : 'https://i.pravatar.cc/150?img=9'),
        bio: who && bios[who] ? bios[who] : 'Thích du lịch và chụp ảnh 📷',
        isFriend: !!friend,
        isSelf,
        requested: sent.some((r) => r.id === who),
        requesting: received.some((r) => r.id === who),
        defaultMessage: `Xin chào, mình là ${ME.displayName}. Mình tìm thấy bạn qua số điện thoại. Kết bạn với mình nhé!`,
        maxMessage: 150,
      };
      postContacts({ search: { seq: 2, status: 'found', user: lastFound } });
    }, 800);
  },
  resetSearch: () => {},
  sendRequest: async (id: string, message: string) => {
    await new Promise((r) => setTimeout(r, 900));
    if (message.includes('#fail')) {
      const n = notice(false, 'Không thể gửi lời mời kết bạn.');
      postContacts({ notice: n });
      return { ok: false, text: n.text };
    }
    const who = suggestions.find((x) => x.id === id) ?? conversations.find((c) => c.id === id) ?? (lastFound?.id === id ? lastFound : null);
    sent = [{ id, name: String(who?.name ?? 'Người dùng Zalo'), avatar: String(who?.avatar ?? ''), message, time: Date.now() }, ...sent];
    postContacts({ sent, notice: notice(true, 'Đã gửi lời mời kết bạn.') });
    if (lastFound && lastFound.id === id) postContacts({ search: { seq: 3, status: 'found', user: { ...lastFound, requested: true } } });
    return { ok: true, text: 'Đã gửi lời mời kết bạn.' };
  },
});

registerMockAdapter('__zaloChat', {
  contactProfile: (uid: string) => {
    const f = friends.find((x) => x.id === uid);
    if (!f) return null;
    return { uid, name: f.name, zaloName: f.zaloName, avatar: f.avatar, bio: bios[uid] ?? '', isSelf: false, isFriend: true, isOA: uid === 'u-num' };
  },
});

let groupSeq = 0;

registerMockAdapter('__zaloGroupCreate', {
  info: () => ({
    status: 'ok',
    maxMembers: Number(new URLSearchParams(location.search).get('groupMax')) || 100, // &groupMax=N: the limit warning
    maxNameLength: 50,
    nameRegex: '`|~|!|@|#|%|\\*|\\^|\\$',
    blocked,
    officialAccounts: ['u-num'],
  }),
  create: async (input: { name: string; members: string[]; avatar: Json | null }) => {
    await new Promise((r) => setTimeout(r, 900));
    if (input.name.toLowerCase().includes('quota')) {
      return { status: 'failed', title: 'Không thể tạo nhóm/cộng đồng', text: 'Bạn đã tham gia số nhóm tối đa của gói hiện tại.', close: true };
    }
    if (input.members.some((m) => blocked.includes(m))) return { status: 'invalid', text: 'Bỏ chặn để thêm người này', dropped: blocked };
    groupSeq += 1;
    const id = `g-new-${groupSeq}`;
    const names = input.members.map((m) => friends.find((f) => f.id === m)?.zaloName || friends.find((f) => f.id === m)?.name || 'Người dùng Zalo');
    const name = input.name || [ME.zaloName, ...names].join(', ').slice(0, 50);
    const avatar = input.avatar ? `data:image/jpeg;base64,${String(input.avatar.data)}` : '';
    post?.({
      conversations: [{ id, isGroup: true, name, avatar, pinned: false, members: input.members.length + 1, unread: 0, preview: { text: 'Bạn đã tạo nhóm', ts: Date.now(), fromMe: true } }],
      removed: [],
      reset: false,
    });
    groups = [...groups, { id, name, avatar, members: input.members.length + 1, type: 0 }];
    postContacts({ groups });
    return { status: 'created', convId: id, failed: input.members.includes('u-chi') ? ['u-chi'] : [] };
  },
});
