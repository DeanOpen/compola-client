// Fabricated account data for the browser mock. Shapes follow the adapter contracts exactly (raw JSON, as the
// host scripts post it), so the real parsing code runs on it.

import type { Json } from '../models/json';

export const ME = { userId: 'u-me', displayName: 'Nguyễn Minh Anh', zaloName: 'Minh Anh', avatar: '', phoneNumber: '0901234567', username: 'minhanh.ng', bio: 'Product @ Compola · Sài Gòn ☕️', gender: 1, birthday: '12/08/1996' };
export const SELF_CONV = 'u-me-cloud';

const now = Date.now();
const min = 60_000;
const hour = 60 * min;
const day = 24 * hour;

export interface MockConversation {
  id: string;
  isGroup: boolean;
  name: string;
  avatar: string;
  pinned: boolean;
  members: number;
  unread: number;
  stranger?: boolean;
  label?: string;
}

export const conversations: MockConversation[] = [
  { id: SELF_CONV, isGroup: false, name: 'My Documents', avatar: '', pinned: true, members: 0, unread: 0 },
  { id: 'g-family', isGroup: true, name: 'Gia đình 🏡', avatar: '', pinned: true, members: 6, unread: 3, label: 'l-family' },
  { id: 'u-lan', isGroup: false, name: 'Trần Thị Lan', avatar: 'https://i.pravatar.cc/150?img=47', pinned: true, members: 0, unread: 0 },
  { id: 'g-team', isGroup: true, name: 'Team Sản phẩm Compola', avatar: '', pinned: false, members: 12, unread: 8, label: 'l-work' },
  { id: 'u-huy', isGroup: false, name: 'Lê Quang Huy', avatar: 'https://i.pravatar.cc/150?img=12', pinned: false, members: 0, unread: 1 },
  { id: 'u-mai', isGroup: false, name: 'Phạm Ngọc Mai', avatar: 'https://i.pravatar.cc/150?img=32', pinned: false, members: 0, unread: 0 },
  { id: 'g-k15', isGroup: true, name: 'Lớp K15 – Bách Khoa', avatar: '', pinned: false, members: 48, unread: 0 },
  { id: 'u-tuan', isGroup: false, name: 'Đỗ Anh Tuấn', avatar: '', pinned: false, members: 0, unread: 0, label: 'l-work' },
  { id: 'u-shop', isGroup: false, name: 'Shop Hoa Tươi Sài Gòn', avatar: '', pinned: false, members: 0, unread: 2, stranger: true },
  { id: 'u-bao', isGroup: false, name: 'Vũ Gia Bảo', avatar: 'https://i.pravatar.cc/150?img=68', pinned: false, members: 0, unread: 0 },
  { id: 'g-run', isGroup: true, name: 'Hội chạy bộ cuối tuần', avatar: '', pinned: false, members: 23, unread: 0 },
  { id: 'u-ha', isGroup: false, name: 'Hoàng Thu Hà', avatar: 'https://i.pravatar.cc/150?img=5', pinned: false, members: 0, unread: 0 },
  { id: 'u-stranger2', isGroup: false, name: 'Nguyễn Văn Khoa', avatar: '', pinned: false, members: 0, unread: 1, stranger: true },
];

export const labels = [
  { id: 'l-family', name: 'Gia đình', color: '#4BC377' },
  { id: 'l-work', name: 'Công việc', color: '#0068FF' },
  { id: 'l-urgent', name: 'Khẩn cấp', color: '#D91B1B' },
];

export const groupMembers: Record<string, { id: string; name: string; avatar: string }[]> = {
  'g-family': [
    { id: 'u-bo', name: 'Bố', avatar: '' },
    { id: 'u-me2', name: 'Mẹ', avatar: '' },
    { id: 'u-lan', name: 'Trần Thị Lan', avatar: 'https://i.pravatar.cc/150?img=47' },
    { id: 'u-em', name: 'Bé Na', avatar: '' },
    { id: 'u-bac', name: 'Bác Hùng', avatar: '' },
  ],
  'g-team': [
    { id: 'u-huy', name: 'Lê Quang Huy', avatar: 'https://i.pravatar.cc/150?img=12' },
    { id: 'u-tuan', name: 'Đỗ Anh Tuấn', avatar: '' },
    { id: 'u-mai', name: 'Phạm Ngọc Mai', avatar: 'https://i.pravatar.cc/150?img=32' },
    { id: 'u-pm', name: 'Ngô Thanh Phương', avatar: 'https://i.pravatar.cc/150?img=20' },
    { id: 'u-qa', name: 'Bùi Đức Thịnh', avatar: '' },
  ],
};

let seq = 1000;
export const nextId = () => `m${(seq += 1)}`;

const menuFor = (mine: boolean, kind: string) => ({
  forward: kind === 'recalled' ? '' : 'ok',
  recall: mine && kind !== 'recalled',
  delete: 'forMe',
  pin: kind !== 'recalled',
  star: kind === 'recalled' ? '' : 'star',
  starred: false,
  protected: false,
  pinned: false,
});

interface MsgInit {
  from: string;
  name?: string;
  avatar?: string;
  text?: string;
  kind?: Json;
  ago: number;
  status?: string;
  quote?: Json | null;
  reactions?: Json[];
  mentions?: Json[];
  buttons?: Json[];
}

export const message = (convId: string, m: MsgInit): Json => {
  const mine = m.from === ME.userId;
  const kind = m.kind ?? { type: 'text' };
  return {
    id: nextId(),
    conversationId: convId,
    senderId: m.from,
    senderName: mine ? ME.displayName : (m.name ?? ''),
    senderAvatar: mine ? '' : (m.avatar ?? ''),
    isMine: mine,
    text: m.text ?? '',
    date: now - m.ago,
    status: m.status ?? (mine ? 'seen' : 'sent'),
    kind,
    quote: m.quote ?? null,
    reactions: m.reactions ?? [],
    mentions: m.mentions ?? [],
    isE2EE: false,
    buttons: m.buttons,
    menu: menuFor(mine, String(kind.type)),
  };
};

const heart = { type: '/-heart', key: '/-heart', emoji: '❤️', image: '' };
const like = { type: '/-strong', key: '/-strong', emoji: '👍', image: '' };

const lan = { from: 'u-lan', name: 'Trần Thị Lan', avatar: 'https://i.pravatar.cc/150?img=47' };
const huy = { from: 'u-huy', name: 'Lê Quang Huy', avatar: 'https://i.pravatar.cc/150?img=12' };
const mai = { from: 'u-mai', name: 'Phạm Ngọc Mai', avatar: 'https://i.pravatar.cc/150?img=32' };
const tuan = { from: 'u-tuan', name: 'Đỗ Anh Tuấn', avatar: '' };
const pm = { from: 'u-pm', name: 'Ngô Thanh Phương', avatar: 'https://i.pravatar.cc/150?img=20' };
const me = { from: ME.userId };
const bo = { from: 'u-bo', name: 'Bố', avatar: '' };
const meMom = { from: 'u-me2', name: 'Mẹ', avatar: '' };

const histories: Record<string, () => Json[]> = {
  'g-team': () => [
    message('g-team', { ...pm, text: 'Chào cả nhà, mình chốt lịch demo bản Compola 1.0 vào thứ Sáu nhé.', ago: 2 * day + 3 * hour }),
    message('g-team', { ...huy, text: 'Ok anh, em sẽ chuẩn bị build.', ago: 2 * day + 2.9 * hour }),
    message('g-team', { kind: { type: 'notice', symbol: 'person.badge.plus', text: 'Bùi Đức Thịnh đã tham gia nhóm' }, from: 'u-qa', ago: 2 * day + 2 * hour }),
    message('g-team', { ...tuan, text: 'Tài liệu thiết kế mới nhất ở đây', ago: 1 * day + 5 * hour }),
    message('g-team', {
      ...tuan,
      text: 'https://www.figma.com/file/compola-design',
      kind: { type: 'link', title: 'Compola – Thiết kế giao diện macOS', url: 'https://www.figma.com/file/compola-design', thumbnail: 'https://picsum.photos/id/180/560/300', description: 'Bản thiết kế Liquid Glass cho sidebar, danh sách và khung chat.', source: 'figma.com' },
      ago: 1 * day + 5 * hour - 30_000,
    }),
    message('g-team', { ...mai, text: '[Hình ảnh]', kind: { type: 'photo', url: 'https://picsum.photos/id/1/1200/800', width: 1200, height: 800 }, ago: 1 * day + 4 * hour, reactions: [{ ...heart, count: 3, includesMe: true, names: ['Bạn', 'Lê Quang Huy', 'Đỗ Anh Tuấn'], people: 3 }] }),
    message('g-team', { ...mai, text: 'Màn hình đăng nhập mới nè 😍', ago: 1 * day + 4 * hour - 20_000 }),
    message('g-team', { ...me, text: 'Đẹp quá! Mình góp ý thêm phần QR nhé', ago: 1 * day + 3 * hour, quote: { senderName: 'Phạm Ngọc Mai', text: 'Màn hình đăng nhập mới nè 😍' } }),
    message('g-team', { ...huy, kind: { type: 'file', name: 'Compola-1.0-build-42.dmg', size: 182_334_112, url: 'https://example.com/compola.dmg' }, text: '[File] Compola-1.0-build-42.dmg', ago: 3 * hour }),
    message('g-team', { ...pm, text: '@Lê Quang Huy build này đã fix lỗi đồng bộ chưa em?', mentions: [{ uid: 'u-huy', pos: 0, len: 13, isAll: false }], ago: 2 * hour }),
    message('g-team', { ...huy, text: 'Dạ rồi anh, em đã test trên 3 máy.', ago: 2 * hour - 60_000, reactions: [{ ...like, count: 2, includesMe: false, names: ['Ngô Thanh Phương', 'Đỗ Anh Tuấn'], people: 2 }] }),
    message('g-team', { ...tuan, kind: { type: 'poll', question: 'Ăn trưa ở đâu hôm demo?', header: 'Đỗ Anh Tuấn đã tạo bình chọn', anonymous: false, pollId: 'p1', conversationId: 'g-team' }, text: '[Bình chọn] Ăn trưa ở đâu hôm demo?', ago: 50 * min }),
    message('g-team', { ...mai, kind: { type: 'sticker', url: 'https://picsum.photos/id/237/260/260' }, text: '[Sticker]', ago: 30 * min }),
    message('g-team', { ...pm, text: '@All nhớ cập nhật tiến độ trước 5h chiều nay nhé!', mentions: [{ uid: '-1', pos: 0, len: 4, isAll: true }], ago: 12 * min }),
  ],
  'g-family': () => [
    message('g-family', { ...bo, text: 'Cuối tuần này cả nhà về quê ăn giỗ ông nhé.', ago: 3 * day }),
    message('g-family', { ...meMom, text: 'Mẹ đã đặt xe rồi, 7h sáng thứ Bảy xuất phát.', ago: 3 * day - 10 * min }),
    message('g-family', { ...me, text: 'Dạ con nhớ rồi ạ ❤️', ago: 3 * day - 5 * min, reactions: [{ ...heart, count: 2, includesMe: false, names: ['Bố', 'Mẹ'], people: 2 }] }),
    message('g-family', { ...lan, kind: { type: 'location', title: 'Nhà thờ họ', address: 'Xã Phú Lộc, Huyện Nam Đàn, Nghệ An', hasCoordinates: true, latitude: 18.69, longitude: 105.51, thumbnail: '' }, text: '[Vị trí]', ago: 2 * day }),
    message('g-family', { ...meMom, kind: { type: 'voice', url: '', duration: 17 }, text: '[Tin nhắn thoại]', ago: 1 * day }),
    message('g-family', { ...bo, kind: { type: 'video', thumbnail: 'https://picsum.photos/id/1015/520/320', duration: 74, url: '' }, text: '[Video]', ago: 5 * hour }),
    message('g-family', { ...lan, text: 'Ảnh hôm qua đây cả nhà', ago: 40 * min }),
    message('g-family', { ...lan, kind: { type: 'photo', url: 'https://picsum.photos/id/1043/800/1000', width: 800, height: 1000 }, text: '[Hình ảnh]', ago: 39 * min }),
    message('g-family', { ...lan, kind: { type: 'photo', url: 'https://picsum.photos/id/1039/1000/700', width: 1000, height: 700 }, text: '[Hình ảnh]', ago: 39 * min - 1000 }),
  ],
  'u-lan': () => [
    message('u-lan', { ...lan, text: 'Chiều nay đi cà phê không?', ago: 6 * hour }),
    message('u-lan', { ...me, text: 'Ok luôn, 4h ở chỗ cũ nhé', ago: 6 * hour - 2 * min }),
    message('u-lan', { ...lan, kind: { type: 'call', video: true, missed: true, duration: 0, title: 'Bạn bị nhỡ', detail: 'Cuộc gọi video' }, text: '[Cuộc gọi video nhỡ]', ago: 5 * hour, buttons: [{ ref: 'call:back', label: 'GỌI LẠI', enabled: true, help: '' }] }),
    message('u-lan', { ...me, kind: { type: 'call', video: false, missed: false, duration: 125, title: 'Cuộc gọi đi', detail: '2 phút 5 giây' }, text: '[Cuộc gọi thoại]', ago: 4 * hour }),
    message('u-lan', { ...lan, kind: { type: 'contactCard', name: 'Hoàng Thu Hà', uid: 'u-ha', avatar: 'https://i.pravatar.cc/150?img=5', phone: '0912 345 678', qr: '', oaLink: '', isOA: false }, text: '[Danh thiếp] Hoàng Thu Hà', ago: 3 * hour }),
    message('u-lan', { ...lan, text: 'Đây là số của Hà, bạn mình làm thiết kế', ago: 3 * hour - min }),
    message('u-lan', { ...me, kind: { type: 'recalled' }, text: '', ago: 2 * hour }),
    message('u-lan', { ...me, text: 'Cảm ơn nhé! Mình sẽ liên hệ ạ 🙏', ago: 2 * hour - min, status: 'seen' }),
  ],
  'u-huy': () => [
    message('u-huy', { ...huy, text: 'Anh ơi review PR giúp em với', ago: 26 * hour }),
    message('u-huy', { ...me, text: 'Ok để tối anh xem', ago: 25 * hour }),
    message('u-huy', { ...huy, text: 'Em vừa đẩy thêm commit sửa theo góp ý rồi ạ', ago: 20 * min }),
  ],
  [SELF_CONV]: () => [
    message(SELF_CONV, { ...me, text: 'Mật khẩu wifi văn phòng: compola@2026', ago: 10 * day }),
    message(SELF_CONV, { ...me, kind: { type: 'file', name: 'Hop-dong-thue-nha.pdf', size: 2_400_000, url: 'https://example.com/a.pdf' }, text: '[File] Hop-dong-thue-nha.pdf', ago: 4 * day }),
  ],
  'u-shop': () => [
    message('u-shop', { from: 'u-shop', name: 'Shop Hoa Tươi Sài Gòn', text: 'Chào bạn, shop có ưu đãi 20% hoa sinh nhật tuần này ạ 🌸', ago: 7 * hour }),
    message('u-shop', { from: 'u-shop', name: 'Shop Hoa Tươi Sài Gòn', kind: { type: 'ecard', style: 'banner', image: 'https://picsum.photos/id/306/600/340', thumb: '', title: 'Ưu đãi tháng 11', description: 'Giảm 20% cho mọi bó hoa', actions: [], avatars: [], reminderTitle: '', reminderStart: 0, reminderRepeat: '' }, text: '[Thiệp]', ago: 6 * hour, buttons: [{ ref: 'ecard:0', label: 'Xem chi tiết', enabled: true, help: '' }] }),
  ],
};

const genericHistory = (c: MockConversation): Json[] => {
  const other = { from: c.id, name: c.name, avatar: c.avatar };
  return [
    message(c.id, { ...other, text: `Chào ${ME.zaloName}!`, ago: 9 * day }),
    message(c.id, { ...me, text: 'Chào bạn, lâu quá không gặp 😄', ago: 9 * day - 5 * min }),
    message(c.id, { ...other, text: 'Dạo này bạn thế nào?', ago: 8 * day }),
  ];
};

/**
 * `?mock=1&history=N`: N extra messages of every common kind before the scripted ones (scroll / render profiling).
 * Images are inline SVG, so the numbers do not depend on the network.
 */
const stressCount = (() => {
  try {
    return Math.min(5000, Math.max(0, Number(new URLSearchParams(location.search).get('history')) || 0));
  } catch {
    return 0;
  }
})();
const svgImage = (i: number, w: number, h: number) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="hsl(${(i * 47) % 360} 60% 70%)"/><circle cx="${w / 2}" cy="${h / 2}" r="${Math.min(w, h) / 4}" fill="hsl(${(i * 91) % 360} 60% 45%)"/></svg>`)}`;
const stressHistory = (c: MockConversation, n: number): Json[] => {
  const people = c.isGroup ? [lan, huy, mai, tuan, pm, me] : [{ from: c.id, name: c.name, avatar: c.avatar }, me];
  const lines = ['Ok em', 'Chiều nay họp lúc mấy giờ anh?', 'Gửi lại file giúp mình với nhé, bản hôm qua bị lỗi font 😅', 'Đã nhận', 'Cảm ơn bạn nhiều!', 'Bên mình đang kiểm tra lại số liệu tháng 11, có gì báo bạn sau nha. Nếu cần gấp thì gọi mình.', '👍', 'https://compola.vn/bang-gia'];
  return Array.from({ length: n }, (_, i) => {
    const who = people[i % people.length];
    const ago = (n - i) * 7 * min + 10 * day;
    const r = i % 10;
    if (r === 3) return message(c.id, { ...who, text: '[Hình ảnh]', kind: { type: 'photo', url: svgImage(i, 1200, 800), width: 1200, height: 800 }, ago });
    if (r === 6) return message(c.id, { ...who, text: '[Sticker]', kind: { type: 'sticker', url: svgImage(i, 260, 260) }, ago });
    if (r === 8) return message(c.id, { ...who, text: '[Video]', kind: { type: 'video', thumbnail: svgImage(i, 520, 320), duration: 30 + i, url: '' }, ago });
    if (r === 9 && i % 20 === 9) return message(c.id, { ...who, text: lines[7], kind: { type: 'link', title: 'Bảng giá Compola', url: lines[7], thumbnail: svgImage(i, 560, 300), description: 'Gói dành cho doanh nghiệp', source: 'compola.vn' }, ago });
    return message(c.id, { ...who, text: lines[i % 7], ago, reactions: i % 13 === 0 ? [{ ...heart, count: 2, includesMe: true, names: ['Bạn', 'Lan'], people: 2 }] : [] });
  });
};

export const historyFor = (c: MockConversation): Json[] => [
  ...(stressCount ? stressHistory(c, stressCount) : []),
  ...(histories[c.id] ?? (() => genericHistory(c)))(),
];

/** An older page for "load more" (two pages at most). */
export const olderPage = (c: MockConversation, before: number, page: number): Json[] => {
  const other = { from: c.isGroup ? 'u-older' : c.id, name: c.isGroup ? 'Thành viên cũ' : c.name, avatar: '' };
  return Array.from({ length: 12 }, (_, i) =>
    message(c.id, {
      ...(i % 3 === 0 ? me : other),
      text: `Tin nhắn cũ #${page * 12 + (12 - i)} — nội dung trò chuyện trước đây.`,
      ago: now - before + (i + 1) * 3 * hour + page * 2 * day,
    }),
  ).reverse();
};

/** Simple QR-looking SVG for the login screen (not a real QR). */
export const fakeQr = (seed: number): string => {
  const n = 25;
  let rects = '';
  let x = seed * 9301 + 49297;
  const rnd = () => ((x = (x * 9301 + 49297) % 233280) / 233280);
  const finder = (cx: number, cy: number) =>
    `<rect x="${cx}" y="${cy}" width="7" height="7" fill="#000"/><rect x="${cx + 1}" y="${cy + 1}" width="5" height="5" fill="#fff"/><rect x="${cx + 2}" y="${cy + 2}" width="3" height="3" fill="#000"/>`;
  for (let i = 0; i < n; i += 1)
    for (let j = 0; j < n; j += 1) {
      const inFinder = (i < 8 && j < 8) || (i < 8 && j > n - 9) || (i > n - 9 && j < 8);
      if (!inFinder && rnd() > 0.5) rects += `<rect x="${i}" y="${j}" width="1" height="1"/>`;
    }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 ${n + 2} ${n + 2}" shape-rendering="crispEdges"><rect x="-1" y="-1" width="${n + 2}" height="${n + 2}" fill="#fff"/>${rects}${finder(0, 0)}${finder(n - 7, 0)}${finder(0, n - 7)}</svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
};
