// Mock of the composer's "Gửi danh thiếp" and "Tạo nhắc hẹn" (`__zaloCompose.myCard / sendMyCard / reminderInfo /
// createReminder`): sends post the official card / reminder e-card into the chat.
import { ME, message } from '../mockData';
import { mockContext, registerMockAdapter } from '../registry';

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
    post(
      convId,
      message(convId, {
        from: ME.userId,
        kind: { type: 'ecard', style: 'reminder', image: '', thumb: '', title: o.title, description: '', actions: [], avatars: [], reminderTitle: o.title, reminderStart: o.startTime, reminderRepeat: repeatTitle[o.repeat] ?? '' },
        text: `[Nhắc hẹn] ${o.title}`,
        ago: 0,
      }),
    );
    return later({ status: 'done' });
  },
});
