// Multi-account mock (provisional transport of engine/accounts.ts): three accounts; switching re-posts the mock data as
// that account; "+" adds a fourth after a fake QR scan (3 s).
import { fakeQr, ME } from '../mockData';
import { mockAccountBoot, mockContext, registerMockCommand } from '../registry';

interface MockAccount {
  id: string;
  name: string;
  avatar: string;
  phone: string;
  unread: number;
  state: 'signedIn' | 'signingIn' | 'signedOut';
  login?: unknown;
  /** Conversations this account has (null = all). */
  ids: string[] | null;
  userId: string;
}

const accounts: MockAccount[] = [
  { id: 'acc-1', name: ME.displayName, avatar: '', phone: ME.phoneNumber, unread: 0, state: 'signedIn', ids: null, userId: ME.userId },
  { id: 'acc-2', name: 'Minh Anh · Công việc', avatar: 'https://i.pravatar.cc/150?img=47', phone: '0912 000 222', unread: 3, state: 'signedIn', ids: ['g-team', 'u-huy', 'u-tuan', 'u-mai'], userId: 'u-me-2' },
  { id: 'acc-3', name: 'Shop Hoa Minh Anh', avatar: 'https://i.pravatar.cc/150?img=32', phone: '0938 555 777', unread: 1, state: 'signedIn', ids: ['u-lan', 'u-ha', 'u-bao'], userId: 'u-me-3' },
];
let activeId = 'acc-1';
let seq = 3;

const snapshot = () => ({ accounts: accounts.map(({ ids: _ids, userId: _u, ...a }) => a), activeId });
const publish = () => mockContext().emit('compola://accounts', snapshot());

registerMockCommand('accounts_list', () => snapshot());
registerMockCommand('account_switch', (args) => {
  const a = accounts.find((x) => x.id === args.id);
  if (!a || a.state !== 'signedIn') return null;
  const before = accounts.find((x) => x.id === activeId);
  // The account left keeps its unread count on the rail (the mock's numbers).
  if (before) before.unread = before.id === 'acc-1' ? 4 : before.unread;
  activeId = a.id;
  a.unread = 0;
  publish();
  mockAccountBoot({ userId: a.userId, displayName: a.name, avatar: a.avatar || null, phone: a.phone }, a.ids);
  return null;
});
registerMockCommand('account_add', () => {
  seq += 1;
  const a: MockAccount = {
    id: `acc-${seq}`,
    name: 'Tài khoản mới',
    avatar: '',
    phone: '',
    unread: 0,
    state: 'signingIn',
    login: { step: { kind: 'waitingScan' }, qr: fakeQr(seq), isSecondQr: false },
    ids: ['u-mai'],
    userId: `u-me-${seq}`,
  };
  accounts.push(a);
  publish();
  // The fake phone scans the QR after 3 s.
  setTimeout(() => {
    if (!accounts.includes(a) || a.state !== 'signingIn') return;
    a.state = 'signedIn';
    a.login = undefined;
    a.name = 'Minh Anh · Gia đình';
    a.avatar = 'https://i.pravatar.cc/150?img=45';
    a.phone = '0977 123 456';
    publish();
  }, 3000);
  return { id: a.id };
});
registerMockCommand('account_cancel_add', (args) => {
  const i = accounts.findIndex((x) => x.id === args.id && x.state === 'signingIn');
  if (i >= 0) accounts.splice(i, 1);
  publish();
  return null;
});
registerMockCommand('account_logout', (args) => {
  const a = accounts.find((x) => x.id === args.id);
  if (a) a.state = 'signedOut';
  publish();
  return null;
});
registerMockCommand('account_remove', (args) => {
  const i = accounts.findIndex((x) => x.id === args.id);
  if (i >= 0 && accounts[i].id !== activeId) accounts.splice(i, 1);
  publish();
  return null;
});
registerMockCommand('accounts_reorder', (args) => {
  const ids = Array.isArray(args.ids) ? args.ids.map(String) : [];
  accounts.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  publish();
  return null;
});
registerMockCommand('account_refresh_qr', (args) => {
  const a = accounts.find((x) => x.id === args.id);
  if (a?.state === 'signingIn') a.login = { step: { kind: 'waitingScan' }, qr: fakeQr(++seq), isSecondQr: false };
  publish();
  return null;
});
