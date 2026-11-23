// Mock of `__zaloGroupCreate.members / removeMember` (group-create-adapter.js): "Team Sản phẩm Compola" with an owner,
// two deputies (me among them, so plain members can be removed) and mixed online / last-seen members.

import { ME } from '../mockData';
import { registerMockAdapter } from '../registry';

const min = 60_000;
type Row = { id: string; name: string; avatar: string; role: 'owner' | 'admin' | 'member'; ago: number | null };

const team: Row[] = [
  { id: 'u-pm', name: 'Ngô Thanh Phương', avatar: 'https://i.pravatar.cc/150?img=20', role: 'owner', ago: 0 },
  { id: ME.userId, name: ME.displayName, avatar: '', role: 'admin', ago: 0 },
  { id: 'u-huy', name: 'Lê Quang Huy', avatar: 'https://i.pravatar.cc/150?img=12', role: 'admin', ago: 14 * min },
  { id: 'u-mai', name: 'Phạm Ngọc Mai', avatar: 'https://i.pravatar.cc/150?img=32', role: 'member', ago: 1 * min },
  { id: 'u-tuan', name: 'Đỗ Anh Tuấn', avatar: '', role: 'member', ago: 3 * 60 * min },
  { id: 'u-qa', name: 'Bùi Đức Thịnh', avatar: '', role: 'member', ago: 26 * 60 * min },
  { id: 'u-lan', name: 'Trần Thị Lan', avatar: 'https://i.pravatar.cc/150?img=47', role: 'member', ago: 2 * min },
  { id: 'u-design', name: 'Vũ Gia Bảo', avatar: 'https://i.pravatar.cc/150?img=53', role: 'member', ago: 45 * min },
  { id: 'u-ha', name: 'Hoàng Thu Hà', avatar: 'https://i.pravatar.cc/150?img=44', role: 'member', ago: 5 * 24 * 60 * min },
  { id: 'u-khoa', name: 'Đặng Minh Khoa', avatar: '', role: 'member', ago: null },
  { id: 'u-linh', name: 'Đặng Thuỳ Linh', avatar: 'https://i.pravatar.cc/150?img=25', role: 'member', ago: 12 * 24 * 60 * min },
  { id: 'u-son', name: 'Trịnh Công Sơn', avatar: '', role: 'member', ago: 9 * 60 * min },
];

const groups = new Map<string, Row[]>([['g-team', team.slice()]]);

const rowsOf = (gid: string): Row[] | null => {
  if (groups.has(gid)) return groups.get(gid)!;
  return null;
};

registerMockAdapter('__zaloGroupCreate', {
  members: (gid: string) =>
    new Promise((resolve) => {
      const rows = rowsOf(gid);
      if (!rows) return setTimeout(() => resolve({ status: 'not-found' }), 200);
      const myRole = rows.find((r) => r.id === ME.userId)?.role ?? 'member';
      const now = Date.now();
      setTimeout(
        () =>
          resolve({
            status: 'ok',
            groupId: gid,
            total: rows.length,
            me: ME.userId,
            myRole,
            members: rows.map((r) => ({
              id: r.id,
              name: r.name,
              avatar: r.avatar,
              role: r.role,
              isMe: r.id === ME.userId,
              lastActive: r.ago === null ? 0 : now - r.ago,
              online: r.ago !== null && r.ago <= 3 * min,
              canRemove: r.id !== ME.userId && (myRole === 'owner' || (myRole === 'admin' && r.role === 'member')),
            })),
          }),
        300,
      );
    }),
  removeMember: (gid: string, id: string, block: boolean) =>
    new Promise((resolve) => {
      const rows = rowsOf(gid);
      setTimeout(() => {
        if (!rows) return resolve({ ok: false, text: 'Nhóm không tồn tại' });
        const i = rows.findIndex((r) => r.id === id);
        if (i < 0 || rows[i].role !== 'member') return resolve({ ok: false, text: 'Chỉ có trưởng/phó nhóm thực hiện được tính năng này.' });
        rows.splice(i, 1);
        resolve({ ok: true, text: block ? 'Đã xóa và chặn tham gia lại nhóm' : 'Đã xóa khỏi nhóm' });
      }, 400);
    }),
});
