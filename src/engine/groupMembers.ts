// Members of a group (the official members panel), bridged to `host-scripts/group-create-adapter.js`
// (`window.__zaloGroupCreate`):
//   members(groupId) → {status:'ok', groupId, total, me, myRole, members:[{id, name, avatar, role:'owner'|'admin'|'member',
//     isMe, lastActive (ms, 0 unknown), online, canRemove}]} | {status:'not-found'|'not-ready'}
//   removeMember(groupId, memberId, block) → {ok, text}
// Roles come from the group info (`creatorId` = "Trưởng nhóm", `adminIds` = "Phó nhóm"); who may remove whom is the
// panel's own rule (the owner anyone, a deputy plain members), answered per member as `canRemove`.

import { create } from 'zustand';
import { callAdapter, log } from './call';
import { arr, bool, int, obj, optStr, str } from './models/json';
import { onAccountReset } from './store';
import { showToast } from './toast';

export type MemberRole = 'owner' | 'admin' | 'member';

export interface GroupMember {
  id: string;
  name: string;
  avatar: string | null;
  role: MemberRole;
  isMe: boolean;
  /** Epoch ms of the last activity, null when unknown. */
  lastActive: number | null;
  online: boolean;
  canRemove: boolean;
}

export interface GroupMemberList {
  groupId: string;
  /** The group's member count (the list may hold fewer: the official info keeps the members it knows). */
  total: number;
  myRole: MemberRole;
  members: GroupMember[];
}

export type MembersPhase = { kind: 'loading' } | { kind: 'ok'; list: GroupMemberList } | { kind: 'failed'; text: string };

const roles: MemberRole[] = ['owner', 'admin', 'member'];

export const parseGroupMembers = (v: unknown): GroupMemberList | null => {
  const root = obj(v);
  if (!root || str(root.status) !== 'ok') return null;
  const role = (x: unknown): MemberRole => (roles.includes(x as MemberRole) ? (x as MemberRole) : 'member');
  const members = arr(root.members)
    .map(obj)
    .filter((m): m is NonNullable<typeof m> => !!m && !!str(m.id))
    .map((m) => {
      const last = int(m.lastActive);
      return {
        id: str(m.id),
        name: str(m.name) || 'Thành viên',
        avatar: optStr(m.avatar),
        role: role(m.role),
        isMe: bool(m.isMe),
        lastActive: last > 0 ? last : null,
        online: bool(m.online),
        canRemove: bool(m.canRemove),
      };
    });
  return { groupId: str(root.groupId), total: Math.max(int(root.total), members.length), myRole: role(root.myRole), members: sortMembers(members) };
};

const rank: Record<MemberRole, number> = { owner: 0, admin: 1, member: 2 };

/** Trưởng nhóm, then Phó nhóm, then everyone else; within each, online first, then by name (Vietnamese order). */
export const sortMembers = (list: GroupMember[]) =>
  [...list].sort(
    (a, b) => rank[a.role] - rank[b.role] || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name, 'vi', { sensitivity: 'base' }),
  );

export const roleTitle = (role: MemberRole): string | null => (role === 'owner' ? 'Trưởng nhóm' : role === 'admin' ? 'Phó nhóm' : null);

/** "Đang hoạt động", "Truy cập 5 phút trước", "Truy cập 3 giờ trước", "Truy cập hôm qua", "Truy cập 12/11". */
export const lastSeenText = (m: GroupMember, now = Date.now()): string | null => {
  if (m.isMe) return null;
  if (m.online) return 'Đang hoạt động';
  if (!m.lastActive) return null;
  const minutes = Math.max(1, Math.floor((now - m.lastActive) / 60_000));
  if (minutes < 60) return `Truy cập ${minutes} phút trước`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Truy cập ${hours} giờ trước`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Truy cập hôm qua';
  if (days < 7) return `Truy cập ${days} ngày trước`;
  const d = new Date(m.lastActive);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `Truy cập ${pad(d.getDate())}/${pad(d.getMonth() + 1)}${d.getFullYear() === new Date(now).getFullYear() ? '' : `/${d.getFullYear()}`}`;
};

/** Case / diacritic-insensitive search (`đ` folds to `d`). */
export const foldText = (text: string) =>
  text
    .trim()
    .replace(/[đĐ]/g, 'd')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();

// MARK: - Store

export const useGroupMembers = create<{ byGroup: Record<string, MembersPhase> }>()(() => ({ byGroup: {} }));
const set = (groupId: string, phase: MembersPhase) => useGroupMembers.setState((s) => ({ byGroup: { ...s.byGroup, [groupId]: phase } }));

const loading = new Set<string>();

/** Reads the members (quietly when a list is already shown). */
export const loadGroupMembers = async (groupId: string) => {
  if (!groupId || loading.has(groupId)) return;
  loading.add(groupId);
  const shown = useGroupMembers.getState().byGroup[groupId]?.kind === 'ok';
  if (!shown) set(groupId, { kind: 'loading' });
  try {
    let answer: unknown = null;
    // The services come up with the renderer: a first read right after launch may be early.
    for (let attempt = 0; attempt < 3; attempt++) {
      answer = await callAdapter('__zaloGroupCreate', 'members', groupId);
      if (str(obj(answer)?.status) !== 'not-ready') break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    const list = parseGroupMembers(answer);
    if (list) set(groupId, { kind: 'ok', list });
    else if (!shown) {
      const status = str(obj(answer)?.status);
      set(groupId, { kind: 'failed', text: status === 'not-found' ? 'Không tìm thấy nhóm này.' : 'Không tải được danh sách thành viên.' });
    }
  } catch (e) {
    log(`groupMembers.members: ${String(e)}`);
    if (!shown) set(groupId, { kind: 'failed', text: 'Không tải được danh sách thành viên.' });
  } finally {
    loading.delete(groupId);
  }
};

/** "Xóa khỏi nhóm" (with "Chặn người này tham gia lại" when `block`). The list reloads either way. */
export const removeGroupMember = async (groupId: string, memberId: string, block: boolean): Promise<boolean> => {
  let ok = false;
  let text = 'Xóa khỏi nhóm không thành công';
  try {
    const r = obj(await callAdapter('__zaloGroupCreate', 'removeMember', groupId, memberId, block));
    ok = bool(r?.ok);
    text = str(r?.text) || (ok ? 'Đã xóa khỏi nhóm' : text);
  } catch (e) {
    log(`groupMembers.removeMember: ${String(e)}`);
  }
  if (ok) {
    // Optimistic: the official info updates when the server's group event arrives.
    useGroupMembers.setState((s) => {
      const phase = s.byGroup[groupId];
      if (phase?.kind !== 'ok') return s;
      const members = phase.list.members.filter((m) => m.id !== memberId);
      return { byGroup: { ...s.byGroup, [groupId]: { kind: 'ok', list: { ...phase.list, members, total: Math.max(members.length, phase.list.total - 1) } } } };
    });
    setTimeout(() => void loadGroupMembers(groupId), 1500);
  }
  showToast(text, groupId);
  return ok;
};

onAccountReset(() => {
  loading.clear();
  useGroupMembers.setState({ byGroup: {} });
});
