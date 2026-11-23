// Quản trị máy chủ › Người dùng & nhóm (Base44 / Plane member tables): people with their source, admin flag and
// lock state, a "⋯" menu per row; groups with their members. Usernames are unique and case-insensitive: the server's
// 409 text is shown as is.

import { KeyRound, Lock, LockOpen, MoreHorizontal, Pencil, Plus, Search, Shield, ShieldOff, Trash2, Users } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { formatRelative, serverAdmin, sourceLabel, type Group, type User, type UserInput } from '../../../engine/serverAdmin';
import { Avatar } from '../../../ui/Avatar';
import { openMenuBelow, type MenuItem } from '../../../ui/Menu';
import { Alert } from '../../../ui/Overlays';
import { Spinner } from '../../../ui/Spinner';
import { Section, Segmented, Toggle } from '../../settings/SettingsView';
import { Loading, Problem, matches, useAction, useLoad } from './common';

type Tab = 'users' | 'groups';

interface Data {
  users: User[];
  groups: Group[];
  providers: { id: string; kind: 'ldap' | 'oidc'; name: string }[];
}

const loadData = async (): Promise<Data> => {
  const [users, groups, providers] = await Promise.all([serverAdmin.users(), serverAdmin.groups(), serverAdmin.providers().catch(() => [])]);
  return { users, groups, providers };
};

export function PeoplePage() {
  const [tab, setTab] = useState<Tab>('users');
  const { data, error, reload } = useLoad(loadData);
  if (!data) return <Loading error={error} />;
  return (
    <>
      <div className="sa-toolbar">
        <Segmented
          label="Người dùng hoặc nhóm"
          value={tab}
          options={[
            { value: 'users', title: `Người dùng (${data.users.length})` },
            { value: 'groups', title: `Nhóm (${data.groups.length})` },
          ]}
          onChange={setTab}
        />
      </div>
      {tab === 'users' ? <UsersTab data={data} reload={reload} /> : <GroupsTab data={data} reload={reload} />}
    </>
  );
}

// MARK: - Users

type UserEditor = { kind: 'new' } | { kind: 'edit'; user: User } | { kind: 'password'; user: User };

function UsersTab({ data, reload }: { data: Data; reload: () => Promise<unknown> }) {
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<UserEditor | null>(null);
  const [deleting, setDeleting] = useState<User | null>(null);
  const { problem, busy, run } = useAction();
  const users = useMemo(
    () =>
      data.users
        .filter((u) => matches(query, u.username, u.displayName, u.email))
        .sort((a, b) => Number(b.isAdmin) - Number(a.isAdmin) || (a.displayName || a.username).localeCompare(b.displayName || b.username, 'vi')),
    [data.users, query],
  );
  const groupsOf = (id: string) => data.groups.filter((g) => g.members.includes(id)).map((g) => g.name);

  const menu = (el: Element, u: User) => {
    const items: MenuItem[] = [
      { label: 'Sửa thông tin', icon: Pencil, onSelect: () => setEditor({ kind: 'edit', user: u }) },
      ...(u.source === 'local' ? [{ label: 'Đặt lại mật khẩu', icon: KeyRound, onSelect: () => setEditor({ kind: 'password', user: u }) }] : []),
      u.isAdmin
        ? { label: 'Bỏ quyền quản trị', icon: ShieldOff, onSelect: () => void run(() => serverAdmin.updateUser(u.id, { isAdmin: false }), reload) }
        : { label: 'Đặt làm quản trị viên', icon: Shield, onSelect: () => void run(() => serverAdmin.updateUser(u.id, { isAdmin: true }), reload) },
      u.disabled
        ? { label: 'Mở khoá', icon: LockOpen, onSelect: () => void run(() => serverAdmin.updateUser(u.id, { disabled: false }), reload) }
        : { label: 'Khoá tài khoản', icon: Lock, onSelect: () => void run(() => serverAdmin.updateUser(u.id, { disabled: true }), reload) },
      { kind: 'separator' },
      { label: 'Xoá người dùng', icon: Trash2, destructive: true, onSelect: () => setDeleting(u) },
    ];
    openMenuBelow(el, items, 'end');
  };

  return (
    <>
      <div className="sa-toolbar">
        <label className="sa-search">
          <Search size={14} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Tìm theo tên, @username, email" spellCheck={false} />
        </label>
        <button className="st-button is-primary" onClick={() => setEditor({ kind: 'new' })}>
          <Plus size={14} /> Thêm người dùng
        </button>
      </div>
      {editor?.kind === 'new' && (
        <UserForm providers={data.providers} onCancel={() => setEditor(null)} onSaved={() => (setEditor(null), reload())} />
      )}
      <Problem text={problem} />
      <Section>
        {users.length === 0 && <div className="st-row st-muted">Không có người dùng phù hợp.</div>}
        {users.map((u) =>
          editor && editor.kind !== 'new' && editor.user.id === u.id ? (
            editor.kind === 'edit' ? (
              <UserForm key={u.id} user={u} providers={data.providers} onCancel={() => setEditor(null)} onSaved={() => (setEditor(null), reload())} />
            ) : (
              <PasswordForm key={u.id} user={u} onDone={() => setEditor(null)} />
            )
          ) : (
            <div key={u.id} className={`st-row sa-member ${u.disabled ? 'is-disabled' : ''}`}>
              <Avatar url={null} name={u.displayName || u.username} size={34} />
              <div className="st-row-text">
                <div className="st-row-label sa-member-name">
                  <span className="truncate">{u.displayName || u.username}</span>
                  {u.isAdmin && <span className="st-chip is-tool">Quản trị viên</span>}
                  {u.disabled && <span className="st-chip sa-chip-danger">Đã khoá</span>}
                </div>
                <div className="st-row-detail truncate">
                  {[`@${u.username}`, u.email, groupsOf(u.id).join(', ')].filter(Boolean).join(' · ')}
                </div>
              </div>
              <div className="sa-member-meta">
                <span className="st-chip">{sourceLabel(u.source, data.providers)}</span>
                <span className="sa-meta-text">{formatRelative(u.lastLoginAt, 'Chưa đăng nhập')}</span>
              </div>
              <button className="st-icon-button sa-more" title="Thao tác" aria-label={`Thao tác với ${u.username}`} disabled={busy} onClick={(e) => menu(e.currentTarget, u)}>
                <MoreHorizontal size={16} />
              </button>
            </div>
          ),
        )}
      </Section>
      {deleting && (
        <Alert
          title={`Xoá @${deleting.username}?`}
          message="Người này bị đăng xuất khỏi mọi thiết bị và mất mọi quyền đã cấp."
          buttons={[
            {
              label: 'Xoá',
              role: 'destructive',
              onClick: () => {
                const id = deleting.id;
                setDeleting(null);
                void run(() => serverAdmin.deleteUser(id), reload);
              },
            },
            { label: 'Hủy', role: 'cancel', onClick: () => setDeleting(null) },
          ]}
        />
      )}
    </>
  );
}

function UserForm({
  user,
  providers,
  onCancel,
  onSaved,
}: {
  user?: User;
  providers: Data['providers'];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [username, setUsername] = useState(user?.username ?? '');
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [source, setSource] = useState<string>(user?.source ?? 'local');
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(user?.isAdmin ?? false);
  const { problem, setProblem, busy, run } = useAction();
  const isNew = !user;
  const local = source === 'local';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (isNew) {
      if (!username.trim()) return setProblem('Nhập tên đăng nhập.');
      if (local && password.length < 8) return setProblem('Mật khẩu cần ít nhất 8 ký tự.');
      const input: UserInput = { username: username.trim(), displayName: displayName.trim() || username.trim(), email: email.trim(), isAdmin };
      if (local) input.password = password;
      else input.source = source;
      void run(() => serverAdmin.createUser(input), onSaved);
    } else {
      void run(() => serverAdmin.updateUser(user.id, { displayName: displayName.trim(), email: email.trim(), isAdmin }), onSaved);
    }
  };

  return (
    <form className="st-auto-editor sa-form" onSubmit={submit}>
      <div className="sa-form-title">{isNew ? 'Thêm người dùng' : `Sửa @${user.username}`}</div>
      <div className="sa-grid">
        {isNew && (
          <label className="st-field">
            <span>Đăng nhập bằng</span>
            <select className="st-input" value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="local">Tài khoản nội bộ (mật khẩu)</option>
              {providers.map((p) => (
                <option key={p.id} value={`${p.kind}:${p.id}`}>
                  {p.kind === 'ldap' ? 'LDAP' : 'SSO'} · {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {isNew && (
          <label className="st-field">
            <span>Tên đăng nhập</span>
            <input className="st-input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" spellCheck={false} autoFocus />
          </label>
        )}
        <label className="st-field">
          <span>Tên hiển thị</span>
          <input className="st-input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoFocus={!isNew} />
        </label>
        <label className="st-field">
          <span>Email</span>
          <input className="st-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} spellCheck={false} />
        </label>
        {isNew && local && (
          <label className="st-field">
            <span>Mật khẩu</span>
            <input className="st-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          </label>
        )}
      </div>
      {isNew && !local && <div className="sa-hint">Người này đăng nhập bằng {sourceLabel(source, providers)} với đúng tên đăng nhập này; tạo trước để cấp quyền ngay.</div>}
      <div className="st-field is-inline">
        <span>Quản trị viên (quản lý máy chủ, thấy mọi cuộc trò chuyện)</span>
        <Toggle label="Quản trị viên" on={isAdmin} onChange={setIsAdmin} />
      </div>
      <Problem text={problem} />
      <div className="st-auto-actions is-end">
        <button type="button" className="st-button" onClick={onCancel}>
          Hủy
        </button>
        <button className="st-button is-primary" disabled={busy}>
          {busy && <Spinner size={12} />} {isNew ? 'Tạo người dùng' : 'Lưu'}
        </button>
      </div>
    </form>
  );
}

function PasswordForm({ user, onDone }: { user: User; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const { problem, setProblem, busy, run } = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 8) return setProblem('Mật khẩu cần ít nhất 8 ký tự.');
    if (password !== again) return setProblem('Hai mật khẩu không khớp.');
    void run(() => serverAdmin.setPassword(user.id, password), onDone);
  };
  return (
    <form className="st-auto-editor sa-form" onSubmit={submit}>
      <div className="sa-form-title">Đặt lại mật khẩu cho @{user.username}</div>
      <div className="sa-grid">
        <label className="st-field">
          <span>Mật khẩu mới</span>
          <input className="st-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" autoFocus />
        </label>
        <label className="st-field">
          <span>Nhập lại</span>
          <input className="st-input" type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" />
        </label>
      </div>
      <Problem text={problem} />
      <div className="st-auto-actions is-end">
        <button type="button" className="st-button" onClick={onDone}>
          Hủy
        </button>
        <button className="st-button is-primary" disabled={busy || !password}>
          Đặt mật khẩu
        </button>
      </div>
    </form>
  );
}

// MARK: - Groups

type GroupEditor = { kind: 'new' } | { kind: 'edit'; group: Group } | { kind: 'members'; group: Group };

function GroupsTab({ data, reload }: { data: Data; reload: () => Promise<unknown> }) {
  const [editor, setEditor] = useState<GroupEditor | null>(null);
  const [deleting, setDeleting] = useState<Group | null>(null);
  const { problem, busy, run } = useAction();
  const nameOf = (id: string) => {
    const u = data.users.find((x) => x.id === id);
    return u ? u.displayName || u.username : 'Không rõ';
  };
  const menu = (el: Element, g: Group) =>
    openMenuBelow(
      el,
      [
        { label: 'Thành viên', icon: Users, onSelect: () => setEditor({ kind: 'members', group: g }) },
        { label: 'Đổi tên', icon: Pencil, onSelect: () => setEditor({ kind: 'edit', group: g }) },
        { kind: 'separator' },
        { label: 'Xoá nhóm', icon: Trash2, destructive: true, onSelect: () => setDeleting(g) },
      ],
      'end',
    );
  return (
    <>
      <div className="sa-toolbar is-end">
        <button className="st-button is-primary" onClick={() => setEditor({ kind: 'new' })}>
          <Plus size={14} /> Tạo nhóm
        </button>
      </div>
      {editor?.kind === 'new' && <GroupForm onCancel={() => setEditor(null)} onSaved={() => (setEditor(null), reload())} />}
      <Problem text={problem} />
      <Section>
        {data.groups.length === 0 && <div className="st-row st-muted">Chưa có nhóm. Nhóm giúp cấp quyền cho nhiều người cùng lúc.</div>}
        {data.groups.map((g) =>
          editor && editor.kind !== 'new' && editor.group.id === g.id ? (
            editor.kind === 'edit' ? (
              <GroupForm key={g.id} group={g} onCancel={() => setEditor(null)} onSaved={() => (setEditor(null), reload())} />
            ) : (
              <MembersForm key={g.id} group={g} users={data.users} onCancel={() => setEditor(null)} onSaved={() => (setEditor(null), reload())} />
            )
          ) : (
            <div key={g.id} className="st-row sa-member">
              <span className="st-icon-tile">
                <Users size={17} />
              </span>
              <div className="st-row-text">
                <div className="st-row-label sa-member-name">
                  <span className="truncate">{g.name}</span>
                  {g.source !== 'local' && <span className="st-chip">LDAP</span>}
                </div>
                <div className="st-row-detail truncate">
                  {g.members.length ? `${g.members.length} thành viên · ${g.members.slice(0, 4).map(nameOf).join(', ')}${g.members.length > 4 ? '…' : ''}` : 'Chưa có thành viên'}
                  {g.description ? ` · ${g.description}` : ''}
                </div>
              </div>
              <button className="st-icon-button sa-more" title="Thao tác" aria-label={`Thao tác với nhóm ${g.name}`} disabled={busy} onClick={(e) => menu(e.currentTarget, g)}>
                <MoreHorizontal size={16} />
              </button>
            </div>
          ),
        )}
      </Section>
      {deleting && (
        <Alert
          title={`Xoá nhóm ${deleting.name}?`}
          message="Các thành viên mất những quyền được cấp qua nhóm này; tài khoản của họ vẫn giữ nguyên."
          buttons={[
            {
              label: 'Xoá nhóm',
              role: 'destructive',
              onClick: () => {
                const id = deleting.id;
                setDeleting(null);
                void run(() => serverAdmin.deleteGroup(id), reload);
              },
            },
            { label: 'Hủy', role: 'cancel', onClick: () => setDeleting(null) },
          ]}
        />
      )}
    </>
  );
}

function GroupForm({ group, onCancel, onSaved }: { group?: Group; onCancel: () => void; onSaved: () => void }) {
  const [name, setName] = useState(group?.name ?? '');
  const [description, setDescription] = useState(group?.description ?? '');
  const { problem, setProblem, busy, run } = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setProblem('Nhập tên nhóm.');
    const g = { name: name.trim(), description: description.trim() };
    void run(() => (group ? serverAdmin.updateGroup(group.id, g) : serverAdmin.createGroup(g)), onSaved);
  };
  return (
    <form className="st-auto-editor sa-form" onSubmit={submit}>
      <div className="sa-form-title">{group ? `Sửa nhóm ${group.name}` : 'Tạo nhóm'}</div>
      <div className="sa-grid">
        <label className="st-field">
          <span>Tên nhóm</span>
          <input className="st-input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <label className="st-field">
          <span>Mô tả</span>
          <input className="st-input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
      </div>
      <Problem text={problem} />
      <div className="st-auto-actions is-end">
        <button type="button" className="st-button" onClick={onCancel}>
          Hủy
        </button>
        <button className="st-button is-primary" disabled={busy}>
          {group ? 'Lưu' : 'Tạo nhóm'}
        </button>
      </div>
    </form>
  );
}

function MembersForm({ group, users, onCancel, onSaved }: { group: Group; users: User[]; onCancel: () => void; onSaved: () => void }) {
  const [selected, setSelected] = useState(() => new Set(group.members));
  const [query, setQuery] = useState('');
  const { problem, busy, run } = useAction();
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const shown = users.filter((u) => matches(query, u.username, u.displayName, u.email));
  return (
    <div className="st-auto-editor sa-form">
      <div className="sa-form-title">
        Thành viên nhóm {group.name} · {selected.size} đã chọn
      </div>
      {group.source !== 'local' && <div className="sa-hint">Nhóm LDAP được đồng bộ khi thành viên đăng nhập; thay đổi ở đây có thể bị ghi đè.</div>}
      <label className="sa-search">
        <Search size={14} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Tìm người dùng" spellCheck={false} autoFocus />
      </label>
      <div className="sa-pick-list">
        {shown.map((u) => (
          <label key={u.id} className="sa-pick">
            <input type="checkbox" checked={selected.has(u.id)} onChange={() => toggle(u.id)} />
            <Avatar url={null} name={u.displayName || u.username} size={24} />
            <span className="truncate">{u.displayName || u.username}</span>
            <span className="sa-meta-text">@{u.username}</span>
          </label>
        ))}
      </div>
      <Problem text={problem} />
      <div className="st-auto-actions is-end">
        <button type="button" className="st-button" onClick={onCancel}>
          Hủy
        </button>
        <button className="st-button is-primary" disabled={busy} onClick={() => void run(() => serverAdmin.setGroupMembers(group.id, [...selected]), onSaved)}>
          Lưu thành viên
        </button>
      </div>
    </div>
  );
}
