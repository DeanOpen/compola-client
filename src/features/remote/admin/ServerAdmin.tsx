// Settings › Compola Server › Quản trị máy chủ: the server's admin screens inside the app (list → detail, like the
// settings dialog's own link rows). Shown on the host once its server runs and has an admin (`remote_api` acts as the
// owner there), and on joined apps whose user is an admin. The full web console stays one click away.

import { ChevronRight, ExternalLink, History, MonitorSmartphone, ShieldCheck, Smartphone, Users, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { errorText, openAdminConsole } from '../../../engine/serverAdmin';
import { Section } from '../../settings/SettingsView';
import { BackBar, Problem } from './common';
import { DevicesPage } from './DevicesPage';
import { GrantsPage } from './GrantsPage';
import { PeoplePage } from './PeoplePage';
import { ZaloAccountsPage } from './ZaloAccountPage';
import './admin.css';

export type AdminPage = 'zalo' | 'people' | 'grants' | 'devices';

const pages: { id: AdminPage; title: string; detail: string; icon: LucideIcon }[] = [
  { id: 'zalo', title: 'Tài khoản Zalo', detail: 'Các tài khoản Zalo của máy chủ: thêm, đăng nhập bằng mã QR, đăng xuất, bật / tắt.', icon: Smartphone },
  { id: 'people', title: 'Người dùng & nhóm', detail: 'Tạo tài khoản, khoá, đặt lại mật khẩu, quản trị viên, nhóm.', icon: Users },
  { id: 'grants', title: 'Phân quyền', detail: 'Ai được dùng tài khoản Zalo, vai trò và phạm vi cuộc trò chuyện.', icon: ShieldCheck },
  { id: 'devices', title: 'Thiết bị', detail: 'Phiên đăng nhập theo từng người; ngắt từ xa.', icon: MonitorSmartphone },
];

export function ServerAdminSection({ onOpen }: { onOpen: (page: AdminPage) => void }) {
  const [problem, setProblem] = useState<string | null>(null);
  const open = (next?: string) => {
    setProblem(null);
    void openAdminConsole(next).catch((e) => setProblem(errorText(e)));
  };
  return (
    <>
      <Section title="Quản trị máy chủ">
        {pages.map((p) => (
          <button key={p.id} className="st-row st-link-row sa-link" onClick={() => onOpen(p.id)}>
            <span className="st-icon-tile">
              <p.icon size={17} />
            </span>
            <span className="st-row-text">
              <span className="st-row-label">{p.title}</span>
              <span className="st-row-detail">{p.detail}</span>
            </span>
            <ChevronRight size={16} className="st-chevron" />
          </button>
        ))}
        <button className="st-row st-link-row sa-link" onClick={() => open('/admin/#/audit')}>
          <span className="st-icon-tile">
            <History size={17} />
          </span>
          <span className="st-row-text">
            <span className="st-row-label">Nhật ký hoạt động</span>
            <span className="st-row-detail">Đăng nhập, thay đổi quyền, tin đã gửi… (mở trong trình duyệt)</span>
          </span>
          <ExternalLink size={15} className="st-chevron" />
        </button>
        <button className="st-row st-link-row sa-link" onClick={() => open()}>
          <span className="st-icon-tile">
            <ExternalLink size={17} />
          </span>
          <span className="st-row-text">
            <span className="st-row-label">Mở trang quản trị đầy đủ</span>
            <span className="st-row-detail">Đăng nhập LDAP / SSO, cài đặt máy chủ và mọi thứ khác.</span>
          </span>
          <ExternalLink size={15} className="st-chevron" />
        </button>
      </Section>
      <Problem text={problem} />
    </>
  );
}

export function ServerAdminPage({ page, onBack }: { page: AdminPage; onBack: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // A sub-page starts at the top of the pane (braces: newer engines return a promise from `scrollTo`).
  useEffect(() => {
    ref.current?.closest('.st-pane-body')?.scrollTo(0, 0);
  }, [page]);
  const title = pages.find((p) => p.id === page)?.title ?? '';
  return (
    <div ref={ref} className="sa-page">
      <BackBar title={title} onBack={onBack} />
      {page === 'zalo' && <ZaloAccountsPage />}
      {page === 'people' && <PeoplePage />}
      {page === 'grants' && <GrantsPage />}
      {page === 'devices' && <DevicesPage />}
    </div>
  );
}
