// Quản trị máy chủ › Tài khoản Zalo: the host's Zalo account, polled every 2 s while open (GET admin/zalo). Signed in:
// the account and "Đăng xuất Zalo". Signed out: the host's QR with the login card's steps and states (new QR =
// POST admin/zalo/qr). Preparing: the runtime setup's progress, "Thử lại" on failure.

import { LogOut, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { RuntimeSetup } from '../../../engine/models/phase';
import { errorText, serverAdmin, type ZaloStatus } from '../../../engine/serverAdmin';
import { Avatar } from '../../../ui/Avatar';
import { Alert } from '../../../ui/Overlays';
import { Spinner } from '../../../ui/Spinner';
import { Row, Section } from '../../settings/SettingsView';
import { QrBody } from '../../setup/LoginView';
import { Loading, Problem, useAction } from './common';

const pollMs = 2000;

export function ZaloAccountPage() {
  const [status, setStatus] = useState<ZaloStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const { problem, busy, run } = useAction();

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const s = await serverAdmin.zalo();
        if (!alive) return;
        setStatus(s);
        setLoadError(null);
      } catch (e) {
        if (alive) setLoadError(errorText(e));
      }
      if (alive) timer = setTimeout(() => void tick(), pollMs);
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  if (!status) return <Loading error={loadError} />;
  const phase = status.phase;
  const account = status.account;

  return (
    <>
      {phase.kind === 'ready' && (
        <Section
          title="Tài khoản đang dùng chung"
          footer="Mọi người dùng Compola Server dùng tài khoản này theo quyền được cấp. Đăng xuất sẽ ngắt tất cả cho đến khi quét lại mã QR."
        >
          <div className="st-row sa-zalo-account">
            <Avatar url={account?.avatar || null} name={account?.name || 'Zalo'} size={48} />
            <div className="st-row-text">
              <div className="st-row-label sa-strong">{account?.name || 'Tài khoản Zalo'}</div>
              <div className="st-row-detail">Đang đăng nhập trên máy chủ</div>
            </div>
            <span className="st-status">
              <span className="st-status-dot" /> Đã kết nối
            </span>
          </div>
          <Row label="Đăng xuất Zalo" detail="Đăng xuất tài khoản Zalo khỏi máy chủ.">
            <button className="st-button is-danger" disabled={busy} onClick={() => setConfirmLogout(true)}>
              <LogOut size={14} /> Đăng xuất Zalo
            </button>
          </Row>
        </Section>
      )}

      {phase.kind === 'login' && (
        <Section title="Đăng nhập Zalo cho máy chủ" description="Quét mã bằng Zalo trên điện thoại của tài khoản dùng chung. Mã được làm mới trên máy chủ.">
          <div className="sa-qr">
            <QrBody state={phase.login} notice={phase.notice ?? null} refresh={() => void run(() => serverAdmin.zaloNewQr())} />
          </div>
        </Section>
      )}

      {phase.kind === 'preparing' && <PreparingSection setup={phase.setup} busy={busy} onRetry={() => void run(() => serverAdmin.zaloRetry())} />}

      {(phase.kind === 'starting' || phase.kind === 'signingIn') && (
        <Section>
          <div className="st-row">
            <Spinner size={16} />
            <div className="st-row-text">
              <div className="st-row-label">{phase.kind === 'starting' ? 'Máy chủ đang khởi động Zalo…' : 'Đang đăng nhập và đồng bộ dữ liệu…'}</div>
            </div>
          </div>
        </Section>
      )}

      <Problem text={problem ?? loadError} />

      {confirmLogout && (
        <Alert
          title="Đăng xuất Zalo trên máy chủ?"
          message="Mọi người dùng Compola Server sẽ mất tài khoản này cho đến khi quét lại mã QR."
          buttons={[
            {
              label: 'Đăng xuất',
              role: 'destructive',
              onClick: () => {
                setConfirmLogout(false);
                void run(() => serverAdmin.zaloLogout());
              },
            },
            { label: 'Hủy', role: 'cancel', onClick: () => setConfirmLogout(false) },
          ]}
        />
      )}
    </>
  );
}

const stepText: Record<RuntimeSetup['step'], string> = {
  looking: 'Đang tìm Zalo PC…',
  downloading: 'Đang tải Zalo PC…',
  verifying: 'Đang kiểm tra bản tải…',
  installing: 'Đang cài đặt…',
};

function PreparingSection({ setup, busy, onRetry }: { setup: RuntimeSetup; busy: boolean; onRetry: () => void }) {
  const pct = setup.total && setup.received != null ? Math.min(100, Math.round((setup.received / setup.total) * 100)) : null;
  return (
    <Section title="Máy chủ đang chuẩn bị Zalo PC">
      <div className="st-row">
        {!setup.failure && <Spinner size={16} />}
        <div className="st-row-text">
          <div className="st-row-label">{setup.failure ? 'Chưa chuẩn bị được Zalo PC' : stepText[setup.step]}</div>
          {setup.failure ? (
            <div className="st-row-detail st-bad">{setup.failure}</div>
          ) : (
            pct !== null && (
              <div className="sa-progress" aria-label={`${pct}%`}>
                <div style={{ width: `${pct}%` }} />
              </div>
            )
          )}
        </div>
        {setup.failure && (
          <button className="st-button is-primary" disabled={busy} onClick={onRetry}>
            <RefreshCw size={14} /> Thử lại
          </button>
        )}
      </div>
    </Section>
  );
}
