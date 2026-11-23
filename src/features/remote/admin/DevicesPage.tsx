// Quản trị máy chủ › Thiết bị (Framer Sessions + Airtable): every sign-in, grouped by person. The person is the
// header; each device is a row (name · short id, IP, last activity, online dot) with "Ngắt" (DELETE admin/sessions/<id>).

import { Globe, Monitor } from 'lucide-react';
import { useMemo, useState } from 'react';
import { formatRelative, personText, serverAdmin, toDate, type Session } from '../../../engine/serverAdmin';
import { Avatar } from '../../../ui/Avatar';
import { Alert } from '../../../ui/Overlays';
import { Section, Toggle } from '../../settings/SettingsView';
import { Loading, Problem, shortId, useAction, useLoad } from './common';

const time = (t: Session['lastSeenAt'] | undefined) => toDate(t)?.getTime() ?? 0;

export function DevicesPage() {
  const { data, error, reload } = useLoad(serverAdmin.sessions);
  const [onlineOnly, setOnlineOnly] = useState(false);
  const [kicking, setKicking] = useState<Session | null>(null);
  const { problem, busy, run } = useAction();

  const people = useMemo(() => {
    const byUser = new Map<string, { user: Session['user']; sessions: Session[] }>();
    for (const s of data ?? []) {
      if (onlineOnly && !s.online) continue;
      const key = s.user?.id ?? '?';
      const entry = byUser.get(key) ?? { user: s.user, sessions: [] };
      entry.sessions.push(s);
      byUser.set(key, entry);
    }
    for (const e of byUser.values()) e.sessions.sort((a, b) => Number(b.online) - Number(a.online) || time(b.lastSeenAt) - time(a.lastSeenAt));
    return [...byUser.values()].sort(
      (a, b) => Number(b.sessions.some((s) => s.online)) - Number(a.sessions.some((s) => s.online)) || personText(a.user).localeCompare(personText(b.user), 'vi'),
    );
  }, [data, onlineOnly]);

  if (!data) return <Loading error={error} />;
  const online = data.filter((s) => s.online).length;

  return (
    <>
      <div className="sa-toolbar">
        <span className="sa-meta-text">
          {online} đang trực tuyến · {data.length} phiên
        </span>
        <span className="st-field is-inline sa-toolbar-toggle">
          <span>Chỉ đang trực tuyến</span>
          <Toggle label="Chỉ đang trực tuyến" on={onlineOnly} onChange={setOnlineOnly} />
        </span>
      </div>
      <Problem text={problem} />
      {people.length === 0 && (
        <Section>
          <div className="st-row st-muted">Không có phiên đăng nhập nào.</div>
        </Section>
      )}
      {people.map(({ user, sessions }) => (
        <Section
          key={user?.id ?? '?'}
          title={
            <span className="sa-person">
              <Avatar url={null} name={user?.displayName || user?.username || '?'} size={20} />
              {personText(user)}
              <span className="sa-meta-text">· {sessions.length} phiên</span>
            </span>
          }
        >
          {sessions.map((s) => {
            const Icon = s.kind === 'web' ? Globe : Monitor;
            return (
              <div key={s.id} className="st-row rs-session">
                <span className="st-icon-tile rs-session-icon">
                  <Icon size={17} />
                  {s.online && <span className="st-dot is-on rs-session-dot" title="Đang trực tuyến" />}
                </span>
                <div className="st-row-text">
                  <div className="st-row-label rs-session-person truncate">
                    <b>{s.kind === 'web' ? 'Trang quản trị' : s.deviceName || 'Thiết bị không tên'}</b>
                    <span className="rs-session-username">{s.kind === 'web' ? s.deviceName : shortId(s.deviceId)}</span>
                  </div>
                  <div className="st-row-detail truncate">
                    {[s.ip, s.online ? 'Đang trực tuyến' : `Hoạt động ${formatRelative(s.lastSeenAt).toLowerCase()}`, `đăng nhập ${formatRelative(s.createdAt).toLowerCase()}`]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </div>
                <button className="st-button is-danger" disabled={busy} onClick={() => setKicking(s)}>
                  Ngắt
                </button>
              </div>
            );
          })}
        </Section>
      ))}
      {kicking && (
        <Alert
          title="Ngắt phiên này?"
          message={`${personText(kicking.user)} sẽ bị đăng xuất khỏi ${
            kicking.kind === 'web' ? 'trang quản trị' : [kicking.deviceName || 'thiết bị', shortId(kicking.deviceId)].filter(Boolean).join(' · ')
          }; các thiết bị khác của họ vẫn đăng nhập.`}
          buttons={[
            {
              label: 'Ngắt',
              role: 'destructive',
              onClick: () => {
                const id = kicking.id;
                setKicking(null);
                void run(() => serverAdmin.revokeSession(id), reload);
              },
            },
            { label: 'Hủy', role: 'cancel', onClick: () => setKicking(null) },
          ]}
        />
      )}
    </>
  );
}
