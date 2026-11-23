// Quản trị máy chủ › Phân quyền: who may use the Zalo account and how. A grant = a subject (user or group), a role
// (Plain role cards: Người xem / Nhân viên; Quản trị is the user's admin flag) and a scope (everything, or chosen
// conversations and labels from GET admin/conversations). "Ai thấy gì": a user's effective access.

import { Eye, MessageSquare, MoreHorizontal, Pencil, Plus, Search, Trash2, User as UserIcon, Users } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { cssColor } from '../../../engine/models/conversations';
import {
  personText,
  roleHints,
  roleNames,
  scopeText,
  serverAdmin,
  type AccountData,
  type EffectiveAccess,
  type Grant,
  type GrantInput,
  type Group,
  type Role,
  type Subject,
  type User,
} from '../../../engine/serverAdmin';
import { Avatar } from '../../../ui/Avatar';
import { openMenuBelow } from '../../../ui/Menu';
import { Alert } from '../../../ui/Overlays';
import { Spinner } from '../../../ui/Spinner';
import { Row, Section, Segmented } from '../../settings/SettingsView';
import { Loading, Problem, matches, useAction, useLoad } from './common';

interface Data {
  grants: Grant[];
  users: User[];
  groups: Group[];
  account: AccountData;
}

const loadData = async (): Promise<Data> => {
  const [grants, users, groups, account] = await Promise.all([
    serverAdmin.grants(),
    serverAdmin.users(),
    serverAdmin.groups(),
    serverAdmin.accountData().catch(() => ({ conversations: [], labels: [] })),
  ]);
  return { grants, users, groups, account };
};

const subjectName = (s: Subject, data: Pick<Data, 'users' | 'groups'>) => {
  if (s.type === 'group') return data.groups.find((g) => g.id === s.id)?.name ?? 'Nhóm đã xoá';
  const u = data.users.find((x) => x.id === s.id);
  return u ? personText(u) : 'Người dùng đã xoá';
};

export function GrantsPage() {
  const { data, error, reload } = useLoad(loadData);
  const [editing, setEditing] = useState<Grant | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Grant | null>(null);
  const { problem, busy, run } = useAction();
  if (!data) return <Loading error={error} />;

  const menu = (el: Element, g: Grant) =>
    openMenuBelow(
      el,
      [
        { label: 'Sửa quyền', icon: Pencil, onSelect: () => setEditing(g) },
        { kind: 'separator' },
        { label: 'Thu hồi quyền', icon: Trash2, destructive: true, onSelect: () => setDeleting(g) },
      ],
      'end',
    );

  return (
    <>
      <div className="sa-toolbar is-end">
        <button className="st-button is-primary" onClick={() => setEditing('new')}>
          <Plus size={14} /> Cấp quyền
        </button>
      </div>
      {editing === 'new' && <GrantForm data={data} onCancel={() => setEditing(null)} onSaved={() => (setEditing(null), reload())} />}
      <Problem text={problem} />
      <Section
        title="Quyền truy cập"
        footer="Quyền của một người = quyền cao nhất trong các quyền của họ và của nhóm họ; phạm vi được gộp lại. Quản trị viên luôn thấy mọi cuộc trò chuyện."
      >
        {data.grants.length === 0 && <div className="st-row st-muted">Chưa cấp quyền cho ai. Người dùng không có quyền sẽ không thấy cuộc trò chuyện nào.</div>}
        {data.grants.map((g) =>
          editing !== 'new' && editing?.id === g.id ? (
            <GrantForm key={g.id} grant={g} data={data} onCancel={() => setEditing(null)} onSaved={() => (setEditing(null), reload())} />
          ) : (
            <div key={g.id} className="st-row sa-member">
              <span className="st-icon-tile">{g.subject.type === 'group' ? <Users size={17} /> : <UserIcon size={17} />}</span>
              <div className="st-row-text">
                <div className="st-row-label sa-member-name">
                  <span className="truncate">{subjectName(g.subject, data)}</span>
                  <span className={`st-chip ${g.role === 'agent' ? 'is-tool' : ''}`}>{roleNames[g.role]}</span>
                </div>
                <div className="st-row-detail truncate">
                  {scopeText(g.scope)}
                  {g.note ? ` · ${g.note}` : ''}
                </div>
              </div>
              <button className="st-icon-button sa-more" title="Thao tác" aria-label="Thao tác với quyền này" disabled={busy} onClick={(e) => menu(e.currentTarget, g)}>
                <MoreHorizontal size={16} />
              </button>
            </div>
          ),
        )}
      </Section>
      <WhoSeesWhat data={data} />
      {deleting && (
        <Alert
          title="Thu hồi quyền này?"
          message={`${subjectName(deleting.subject, data)} mất quyền ${roleNames[deleting.role].toLowerCase()} với ${scopeText(deleting.scope).toLowerCase()}.`}
          buttons={[
            {
              label: 'Thu hồi',
              role: 'destructive',
              onClick: () => {
                const id = deleting.id;
                setDeleting(null);
                void run(() => serverAdmin.deleteGrant(id), reload);
              },
            },
            { label: 'Hủy', role: 'cancel', onClick: () => setDeleting(null) },
          ]}
        />
      )}
    </>
  );
}

// MARK: - Editor

function GrantForm({ grant, data, onCancel, onSaved }: { grant?: Grant; data: Data; onCancel: () => void; onSaved: () => void }) {
  const [subjectType, setSubjectType] = useState<Subject['type']>(grant?.subject.type ?? 'user');
  const [subjectId, setSubjectId] = useState(grant?.subject.id ?? '');
  const [role, setRole] = useState<Role>(grant?.role ?? 'agent');
  const [all, setAll] = useState(grant?.scope.all ?? true);
  const [conversations, setConversations] = useState(() => new Set(grant?.scope.conversations ?? []));
  const [labels, setLabels] = useState(() => new Set(grant?.scope.labels ?? []));
  const [note, setNote] = useState(grant?.note ?? '');
  const [query, setQuery] = useState('');
  const { problem, setProblem, busy, run } = useAction();

  const subjects = subjectType === 'user' ? data.users.map((u) => ({ id: u.id, name: personText(u), admin: u.isAdmin })) : data.groups.map((g) => ({ id: g.id, name: g.name, admin: false }));
  const pickedAdmin = subjectType === 'user' && data.users.find((u) => u.id === subjectId)?.isAdmin;
  const shown = useMemo(() => data.account.conversations.filter((c) => matches(query, c.name)), [data.account.conversations, query]);

  const toggle = (set: Set<string>, id: string, apply: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    apply(next);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!subjectId) return setProblem(subjectType === 'user' ? 'Chọn người dùng.' : 'Chọn nhóm.');
    if (!all && !conversations.size && !labels.size) return setProblem('Chọn ít nhất một cuộc trò chuyện hoặc nhãn, hoặc chọn Tất cả.');
    const input: GrantInput = {
      subject: { type: subjectType, id: subjectId },
      role,
      scope: { all, conversations: all ? [] : [...conversations], labels: all ? [] : [...labels] },
      note: note.trim(),
    };
    void run(() => (grant ? serverAdmin.updateGrant(grant.id, input) : serverAdmin.createGrant(input)), onSaved);
  };

  return (
    <form className="st-auto-editor sa-form" onSubmit={submit}>
      <div className="sa-form-title">{grant ? 'Sửa quyền' : 'Cấp quyền'}</div>

      <div className="st-field">
        <span>Cấp cho</span>
        <div className="sa-inline">
          <Segmented
            label="Người dùng hoặc nhóm"
            value={subjectType}
            options={[
              { value: 'user', title: 'Người dùng' },
              { value: 'group', title: 'Nhóm' },
            ]}
            onChange={(t) => {
              setSubjectType(t);
              setSubjectId('');
            }}
          />
          <select className="st-input" value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
            <option value="">{subjectType === 'user' ? 'Chọn người dùng…' : 'Chọn nhóm…'}</option>
            {subjects.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.admin ? ' — quản trị viên' : ''}
              </option>
            ))}
          </select>
        </div>
        {pickedAdmin && <span className="sa-hint">Người này là quản trị viên: họ đã thấy mọi cuộc trò chuyện với quyền nhân viên.</span>}
      </div>

      <div className="st-field">
        <span>Vai trò</span>
        <div className="sa-role-cards" role="radiogroup" aria-label="Vai trò">
          {(['viewer', 'agent'] as Role[]).map((r) => (
            <button key={r} type="button" role="radio" aria-checked={role === r} className={`sa-role-card ${role === r ? 'is-selected' : ''}`} onClick={() => setRole(r)}>
              <span className="sa-role-title">
                {r === 'viewer' ? <Eye size={15} /> : <MessageSquare size={15} />} {roleNames[r]}
              </span>
              <span className="sa-role-hint">{roleHints[r]}</span>
            </button>
          ))}
        </div>
        <span className="sa-hint">Quản trị viên không phải một vai trò ở đây: bật “Quản trị viên” cho người đó ở trang Người dùng & nhóm.</span>
      </div>

      <div className="st-field">
        <span>Phạm vi</span>
        <div className="sa-scope-choice" role="radiogroup" aria-label="Phạm vi">
          <label className="sa-radio">
            <input type="radio" checked={all} onChange={() => setAll(true)} /> Tất cả cuộc trò chuyện
          </label>
          <label className="sa-radio">
            <input type="radio" checked={!all} onChange={() => setAll(false)} /> Chọn cuộc trò chuyện và nhãn
          </label>
        </div>
        {!all && (
          <div className="sa-scope">
            {data.account.labels.length > 0 && (
              <div className="sa-label-chips" aria-label="Nhãn">
                {data.account.labels.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    className={`sa-label-chip ${labels.has(l.id) ? 'is-selected' : ''}`}
                    aria-pressed={labels.has(l.id)}
                    onClick={() => toggle(labels, l.id, setLabels)}
                    style={{ ['--label-color' as string]: cssColor(l.color) ?? 'var(--accent)' }}
                  >
                    <span className="sa-label-dot" />
                    {l.name}
                  </button>
                ))}
              </div>
            )}
            <label className="sa-search">
              <Search size={14} />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Tìm cuộc trò chuyện" spellCheck={false} />
            </label>
            <div className="sa-pick-list is-tall">
              {shown.length === 0 && <div className="sa-meta-text sa-pad">Không có cuộc trò chuyện phù hợp.</div>}
              {shown.map((c) => (
                <label key={c.id} className="sa-pick">
                  <input type="checkbox" checked={conversations.has(c.id)} onChange={() => toggle(conversations, c.id, setConversations)} />
                  <Avatar url={c.avatar || null} name={c.name} size={26} />
                  <span className="truncate">{c.name}</span>
                  {c.isGroup && <Users size={13} className="sa-meta-text" aria-label="Nhóm" />}
                  <span className="sa-pick-labels">
                    {c.labels.map((id) => {
                      const l = data.account.labels.find((x) => x.id === id);
                      return l ? <span key={id} className="sa-label-dot" style={{ ['--label-color' as string]: cssColor(l.color) ?? 'var(--accent)' }} title={l.name} /> : null;
                    })}
                  </span>
                </label>
              ))}
            </div>
            <span className="sa-hint">
              {conversations.size} cuộc trò chuyện, {labels.size} nhãn. Cuộc trò chuyện mang một nhãn đã chọn cũng được thấy.
            </span>
          </div>
        )}
      </div>

      <label className="st-field">
        <span>Ghi chú</span>
        <input className="st-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ví dụ: trực ca tối" />
      </label>

      <Problem text={problem} />
      <div className="st-auto-actions is-end">
        <button type="button" className="st-button" onClick={onCancel}>
          Hủy
        </button>
        <button className="st-button is-primary" disabled={busy}>
          {busy && <Spinner size={12} />} {grant ? 'Lưu' : 'Cấp quyền'}
        </button>
      </div>
    </form>
  );
}

// MARK: - Ai thấy gì

function WhoSeesWhat({ data }: { data: Data }) {
  const [userId, setUserId] = useState('');
  const [access, setAccess] = useState<EffectiveAccess | null>(null);
  const { problem, busy, run } = useAction();
  const pick = (id: string) => {
    setUserId(id);
    setAccess(null);
    if (id) void run(() => serverAdmin.access(id).then(setAccess));
  };
  const roleText = (r: EffectiveAccess['role']) => (r === 'admin' ? 'Quản trị viên' : r ? roleNames[r] : 'Chưa có quyền');
  return (
    <Section title="Ai thấy gì" description="Chọn một người để xem quyền thực tế của họ (gộp từ quyền riêng và quyền của nhóm).">
      <Row label="Người dùng">
        <select className="st-input is-narrow" value={userId} onChange={(e) => pick(e.target.value)}>
          <option value="">Chọn người dùng…</option>
          {data.users.map((u) => (
            <option key={u.id} value={u.id}>
              {personText(u)}
            </option>
          ))}
        </select>
      </Row>
      {busy && (
        <div className="st-row">
          <Spinner size={14} />
        </div>
      )}
      {access && (
        <>
          <Row label="Vai trò" detail={access.role ? roleHints[access.role] : 'Không thấy cuộc trò chuyện nào.'}>
            <span className="st-value">{roleText(access.role)}</span>
          </Row>
          <Row label="Phạm vi">
            <span className="st-value">{access.role === 'admin' ? 'Tất cả cuộc trò chuyện' : scopeText(access.scope)}</span>
          </Row>
          {access.via.length > 0 && (
            <Row
              label="Từ các quyền"
              detail={access.via.map((v) => `${v.subject.type === 'group' ? 'Nhóm ' : ''}${subjectName(v.subject, data)}: ${roleNames[v.role]}`).join(' · ')}
            />
          )}
        </>
      )}
      {problem && <Problem text={problem} />}
    </Section>
  );
}
