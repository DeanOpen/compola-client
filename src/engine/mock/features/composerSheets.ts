// Mock of the composer's "Gửi danh thiếp" and "Tạo nhắc hẹn" (`__zaloCompose.myCard / sendMyCard / reminderInfo /
// createReminder`): sends post the official card / reminder e-card into the chat.
import { groupMembers, ME, message } from '../mockData';
import { mockContext, onMockBoot, registerMockAdapter } from '../registry';

const later = <T>(v: T, ms = 300) => new Promise<T>((r) => setTimeout(() => r(v), ms));
const repeatTitle = ['', 'Hàng ngày', 'Hàng tuần', 'Hàng tháng'];
const post = (convId: string, m: ReturnType<typeof message>) => mockContext().post({ chat: { convId, messages: [m], removed: [], hasMore: true, reset: false } });

registerMockAdapter('__zaloCompose', {
  myCard: () => later({ uid: ME.userId, name: ME.displayName, avatar: '', phone: ME.phoneNumber, withPhone: true }, 200),
  sendMyCard: (convId: string, withPhone: boolean) => {
    post(
      convId,
      message(convId, {
        from: ME.userId,
        kind: { type: 'contactCard', name: ME.displayName, uid: ME.userId, avatar: '', phone: withPhone ? ME.phoneNumber : '', qr: '', oaLink: '', isOA: false },
        text: `[Danh thiếp] ${ME.displayName}`,
        ago: 0,
      }),
    );
    return later({ status: 'done' });
  },
  reminderInfo: (convId: string) =>
    later(
      convId.startsWith('u-shop')
        ? { allowed: false, hidden: true, text: '' }
        : { allowed: true, hidden: false, text: '', isGroup: convId.startsWith('g-'), canPin: convId.startsWith('g-'), pinToggle: convId.startsWith('g-'), titleMaxChars: 3000, titleMaxBytes: 3700 },
      150,
    ),
  createReminder: (convId: string, o: { title: string; startTime: number; repeat: number; needPin: boolean }) => {
    if (o.title.trim().toLowerCase() === 'lỗi') return later({ status: 'error', text: 'Không tạo được nhắc hẹn. Hãy thử lại.' });
    postReminder(convId, ME.userId, ME.displayName, o.title, o.startTime, repeatTitle[o.repeat] ?? '');
    return later({ status: 'done' });
  },
});

// MARK: The official reminder controller (`__zaloChat.reminderWatch / reminderRespond / reminderResponders`)

interface MockReminder {
  rid: string;
  convId: string;
  title: string;
  start: number;
  repeat: string;
  creatorName: string;
  mine: 'accept' | 'reject' | null;
  accept: string[];
  reject: string[];
  seq: number;
}
const reminders = new Map<string, MockReminder>();
const waiters = new Set<() => void>();
const changed = () => {
  for (const w of [...waiters]) w();
};

const snapshot = (r: MockReminder) => {
  const isGroup = r.convId.startsWith('g-');
  return {
    variant: 'invite',
    rid: r.rid,
    title: r.title,
    start: r.start,
    repeat: r.repeat,
    creatorName: r.creatorName,
    onlyMe: false,
    isGroup,
    mine: r.mine ?? '',
    pending: '',
    accepted: r.accept.length + (r.mine === 'accept' ? 1 : 0),
    rejected: r.reject.length + (r.mine === 'reject' ? 1 : 0),
    canRsvp: isGroup,
    canView: true,
    deleted: false,
    sig: `${r.rid}:${r.seq}`,
  };
};

const postReminder = (convId: string, from: string, creatorName: string, title: string, start: number, repeat: string, accept: string[] = [], reject: string[] = []) => {
  const m = message(convId, {
    from,
    name: creatorName,
    kind: { type: 'ecard', style: 'reminder', image: '', thumb: '', title, description: '', actions: [], avatars: [], reminderTitle: title, reminderStart: start, reminderRepeat: repeat },
    text: `[Nhắc hẹn] ${title}`,
    ago: 0,
  });
  reminders.set(String(m.id), { rid: `r-${String(m.id)}`, convId, title, start, repeat, creatorName, mine: null, accept, reject, seq: 0 });
  post(convId, m);
};

registerMockAdapter('__zaloChat', {
  reminderWatch: (_convId: string, msgId: string, sig: string) => {
    const r = reminders.get(msgId);
    if (!r) return null;
    if (snapshot(r).sig !== sig) return snapshot(r);
    // Long poll: answers on a change, or after a while with the same state.
    return new Promise((resolve) => {
      const done = () => {
        waiters.delete(done);
        clearTimeout(t);
        resolve(snapshot(r));
      };
      const t = setTimeout(done, 20_000);
      waiters.add(done);
    });
  },
  reminderRespond: (_convId: string, msgId: string, answer: 'accept' | 'reject') => {
    const r = reminders.get(msgId);
    if (!r) return { ok: false, text: 'Có lỗi xảy ra' };
    return later(null, 600).then(() => {
      r.mine = answer;
      r.seq += 1;
      changed();
      return { ok: true, text: '', snapshot: snapshot(r) };
    });
  },
  reminderResponders: (convId: string, msgId: string) => {
    const r = reminders.get(msgId);
    if (!r) return { ok: false };
    const people = groupMembers[convId] ?? [];
    const person = (uid: string) => {
      const p = people.find((x) => x.id === uid);
      return { uid, name: p?.name ?? 'Người dùng Zalo', avatar: p?.avatar ?? '', isMe: false };
    };
    const me = { uid: ME.userId, name: ME.displayName, avatar: '', isMe: true };
    const accept = [...(r.mine === 'accept' ? [me] : []), ...r.accept.map(person)];
    const reject = [...(r.mine === 'reject' ? [me] : []), ...r.reject.map(person)];
    return later({ ok: true, accept, reject, acceptTotal: accept.length, rejectTotal: reject.length, acceptMore: 0, rejectMore: 0 }, 400);
  },
});

// A group reminder from a teammate, waiting for my answer (after the first history load, which resets the chat).
onMockBoot(() => setTimeout(seedReminder, 1500));
const seedReminder = () => {
  const members = groupMembers['g-team'] ?? [];
  const mai = members.find((m) => m.name.includes('Mai')) ?? members[0];
  if (!mai) return;
  const start = new Date();
  start.setDate(start.getDate() + 2);
  start.setHours(14, 0, 0, 0);
  postReminder('g-team', mai.id, mai.name, 'Demo Compola cho khách hàng', start.getTime(), 'Không lặp lại', members.slice(1, 3).map((m) => m.id), members.slice(3, 4).map((m) => m.id));
};
