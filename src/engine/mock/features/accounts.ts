// Multi-account mock (docs/multi-account.md §6): three accounts — `default` and two added ones — each seeing a part of
// the mock data; account_add starts an inactive account on its QR screen that "scans" after 4 s.
import { fakeQr, ME } from '../mockData';
import { mockAccountBoot, mockContext, mockPass, registerMockCommand } from '../registry';

type Phase = 'disabled' | 'starting' | 'preparing' | 'login' | 'signingIn' | 'ready';

interface MockAccount {
  id: string;
  uid: string | null;
  name: string | null;
  label: string | null;
  avatar: string | null;
  enabled: boolean;
  phase: Phase;
  badge: number;
  qrSeed: number;
  /** Conversations this account has (null = all). */
  ids: string[] | null;
}

const accounts: MockAccount[] = [
  { id: 'default', uid: ME.userId, name: ME.displayName, label: null, avatar: null, enabled: true, phase: 'ready', badge: 0, qrSeed: 1, ids: null },
  { id: 'a1b2c3d4e', uid: 'u-me-2', name: 'Minh Anh', label: 'Công việc', avatar: 'https://i.pravatar.cc/150?img=47', enabled: true, phase: 'ready', badge: 3, qrSeed: 2, ids: ['g-team', 'u-huy', 'u-tuan', 'u-mai'] },
  { id: 'a0f0f0f0a', uid: 'u-me-3', name: 'Shop Hoa Minh Anh', label: null, avatar: 'https://i.pravatar.cc/150?img=32', enabled: true, phase: 'ready', badge: 1, qrSeed: 3, ids: ['u-lan', 'u-ha', 'u-bao'] },
];
let active = 'default';
const max = 5;

const list = () => ({
  active,
  maxAccounts: max,
  accounts: accounts.map((a, order) => ({ id: a.id, uid: a.uid, name: a.name, label: a.label, avatar: a.avatar, order, enabled: a.enabled, active: a.id === active, phase: a.phase, badge: a.badge })),
});
const changed = () => mockContext().emit('compola://accounts', { kind: 'changed', list: list() });
const find = (id: unknown) => accounts.find((a) => a.id === id);
const loginPhase = (a: MockAccount) => ({ kind: 'login', account: a.id, login: { step: { kind: 'waitingScan' }, qr: fakeQr(a.qrSeed), isSecondQr: false } });

const show = (a: MockAccount) => {
  active = a.id;
  a.badge = 0;
  mockContext().emit('compola://accounts', { kind: 'active', account: a.id });
  changed();
  mockAccountBoot({ userId: a.uid, displayName: a.label || a.name, avatar: a.avatar, phone: null }, a.ids);
};

registerMockCommand('accounts_list', () => list());
registerMockCommand('account_set_active', (args) => {
  const a = find(args.account);
  if (!a) throw new Error('Tài khoản không tồn tại');
  if (a.id !== active) {
    // The account left gets some unread again (mock numbers).
    const before = find(active);
    if (before) before.badge = before.id === 'default' ? 4 : 2;
    show(a);
  }
  return null;
});
registerMockCommand('account_add', (args) => {
  if (accounts.length >= max) throw new Error(`Đã đạt số tài khoản tối đa (${max})`);
  const id = 'a' + Math.floor(0x10000000 + Math.random() * 0xefffffff).toString(16).slice(0, 8);
  const a: MockAccount = { id, uid: null, name: null, label: null, avatar: null, enabled: true, phase: 'login', badge: 0, qrSeed: 7 + accounts.length, ids: ['u-mai', 'g-family'] };
  accounts.push(a);
  changed();
  if (args.activate !== false) show(a);
  // The fake phone scans and confirms after 4 s.
  setTimeout(() => {
    if (!accounts.includes(a) || a.phase !== 'login') return;
    a.phase = 'ready';
    a.uid = `u-me-${id}`;
    a.name = 'Minh Anh · Gia đình';
    a.avatar = 'https://i.pravatar.cc/150?img=45';
    changed();
  }, 4000);
  return { id };
});
registerMockCommand('account_remove', (args) => {
  const a = find(args.account);
  if (!a) throw new Error('Tài khoản không tồn tại');
  if (a.id === 'default') {
    a.phase = 'login';
  } else {
    accounts.splice(accounts.indexOf(a), 1);
    if (a.id === active && accounts[0]) show(accounts[0]);
  }
  changed();
  return null;
});
registerMockCommand('account_reorder', (args) => {
  const ids = Array.isArray(args.ids) ? args.ids.map(String) : [];
  accounts.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  changed();
  return null;
});
registerMockCommand('account_set_enabled', (args) => {
  const a = find(args.account);
  if (a && a.id !== active) {
    a.enabled = !!args.enabled;
    a.phase = a.enabled ? 'ready' : 'disabled';
  }
  changed();
  return null;
});
registerMockCommand('account_rename', (args) => {
  const a = find(args.account);
  if (a) a.label = String(args.name ?? '').trim() || null;
  changed();
  return null;
});
// Engine commands addressed to another account than the active one (the built-in mock is the active account).
registerMockCommand('engine_phase', (args) => {
  const a = find(args.account);
  if (!a || a.id === active) return mockPass;
  return a.phase === 'login' ? loginPhase(a) : { kind: a.phase === 'disabled' ? 'starting' : a.phase, account: a.id };
});
registerMockCommand('engine_refresh_qr', (args) => {
  const a = find(args.account);
  if (!a || a.id === active) return mockPass;
  a.qrSeed += 11;
  return null;
});
registerMockCommand('engine_logout', (args) => {
  const a = find(args.account);
  if (!a || a.id === active) return mockPass;
  a.phase = 'login';
  changed();
  return null;
});
