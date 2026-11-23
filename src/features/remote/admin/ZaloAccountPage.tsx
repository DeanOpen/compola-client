// Quản trị máy chủ › Tài khoản Zalo (docs/compola-server.md, M5): every Zalo account of the host (GET admin/accounts,
// polled every 2 s while open) with its state, unread count, order (↑ ↓), on / off, a label, sign-out and removal
// ("default" can only be signed out), and "Thêm tài khoản Zalo" (a new account on its QR). An account opens its detail:
// signed in, the account and "Đăng xuất Zalo"; signed out, its QR with the login card's steps and states (new QR =
// POST admin/accounts/<id>/qr); preparing, the runtime setup's progress and "Thử lại".

import { ArrowDown, ArrowUp, ChevronLeft, LogOut, MoreHorizontal, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import type { RuntimeSetup } from '../../../engine/models/phase';
import {
  accountPhaseKind,
  errorText,
  serverAdmin,
  zaloAccountTitle,
  type ZaloAccount,
  type ZaloAccountDetail,
  type ZaloAccounts,
} from '../../../engine/serverAdmin';
import { Avatar } from '../../../ui/Avatar';
import { openMenuBelow } from '../../../ui/Menu';
import { Alert } from '../../../ui/Overlays';
import { Spinner } from '../../../ui/Spinner';
import { Row, Section, Toggle } from '../../settings/SettingsView';
import { QrBody } from '../../setup/LoginView';
import { Loading, Problem, useAction } from './common';

const pollMs = 2000;

/** Polls `load` every 2 s while mounted. */
function usePoll<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      try {
        const d = await load();
        if (!alive) return;
        setData(d);
        setError(null);
      } catch (e) {
        if (alive) setError(errorText(e));
      }
      if (alive) timer = setTimeout(() => void run(), pollMs);
    };
    void run();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // `load` is fixed per page; `tick` forces a reload after an action.
  }, [tick]);
  return { data, error, reload: () => setTick((t) => t + 1) };
}

export function ZaloAccountsPage() {
  const [openId, setOpenId] = useState<string | null>(null);
  if (openId) return <AccountDetail id={openId} onBack={() => setOpenId(null)} />;
  return <AccountsList onOpen={setOpenId} />;
}

// MARK: - List

const phaseText = (a: ZaloAccount) => {
  if (!a.enabled) return 'Đã tắt';
  switch (accountPhaseKind(a)) {
    case 'ready':
      return a.badge ? `${a.badge} chưa đọc` : 'Đang hoạt động';
    case 'login':
      return 'Chưa đăng nhập — cần quét mã QR';
    case 'signingIn':
      return 'Đang đăng nhập…';
    case 'preparing':
      return 'Đang chuẩn bị Zalo PC…';
    case 'disabled':
      return 'Đã tắt';
    default:
      return 'Đang khởi động…';
  }
};

function AccountsList({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, error, reload } = usePoll<ZaloAccounts>(serverAdmin.accounts);
  const [labeling, setLabeling] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'logout' | 'remove'; account: ZaloAccount } | null>(null);
  const { problem, busy, run } = useAction();
  if (!data) return <Loading error={error} />;
  const accounts = data.accounts;
  const full = accounts.length >= data.maxAccounts;

  const move = (i: number, d: -1 | 1) => {
    const ids = accounts.map((a) => a.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    void run(() => serverAdmin.reorderAccounts(ids), reload);
  };
  const menu = (el: Element, a: ZaloAccount) =>
    openMenuBelow(
      el,
      [
        { label: accountPhaseKind(a) === 'login' ? 'Quét mã QR để đăng nhập' : 'Mở', onSelect: () => onOpen(a.id) },
        { label: 'Đặt nhãn…', icon: Pencil, onSelect: () => setLabeling(a.id) },
        { kind: 'separator' },
        { label: 'Đăng xuất Zalo', icon: LogOut, destructive: true, disabled: accountPhaseKind(a) !== 'ready', onSelect: () => setConfirm({ kind: 'logout', account: a }) },
        ...(a.id === 'default' ? [] : [{ label: 'Xoá khỏi máy chủ', icon: Trash2, destructive: true, onSelect: () => setConfirm({ kind: 'remove' as const, account: a }) }]),
      ],
      'end',
    );

  return (
    <>
      <div className="sa-toolbar">
        <span className="sa-meta-text">
          {accounts.length}/{data.maxAccounts} tài khoản
        </span>
        <button
          className="st-button is-primary sa-toolbar-end"
          disabled={busy || full}
          title={full ? `Tối đa ${data.maxAccounts} tài khoản` : undefined}
          onClick={() =>
            void run(async () => {
              const r = await serverAdmin.addAccount();
              if (r?.id) onOpen(r.id);
            }, reload)
          }
        >
          <Plus size={14} /> Thêm tài khoản Zalo
        </button>
      </div>
      <Problem text={problem ?? error} />
      <Section footer="Mỗi tài khoản Zalo chạy riêng trên máy chủ. Người dùng chỉ thấy những tài khoản được cấp quyền (Phân quyền); tắt một tài khoản thì nó không nhận tin nhắn nhưng vẫn giữ dữ liệu.">
        {accounts.map((a, i) =>
          labeling === a.id ? (
            <LabelForm key={a.id} account={a} onDone={() => (setLabeling(null), reload())} />
          ) : (
            <div key={a.id} className={`st-row sa-member ${a.enabled ? '' : 'is-disabled'}`}>
              <button className="sa-account-open" onClick={() => onOpen(a.id)} title="Mở">
                <Avatar url={a.avatar || null} name={zaloAccountTitle(a)} size={36} />
                <span className="st-row-text">
                  <span className="st-row-label sa-member-name">
                    <span className="truncate">{zaloAccountTitle(a)}</span>
                    {a.label && a.name && <span className="sa-meta-text truncate">{a.name}</span>}
                    {a.active && <span className="st-chip">Đang hiển thị trên máy chủ</span>}
                  </span>
                  <span className={`st-row-detail ${accountPhaseKind(a) === 'login' ? 'st-bad' : ''}`}>{phaseText(a)}</span>
                </span>
              </button>
              <button className="st-icon-button" disabled={busy || i === 0} title="Lên" aria-label="Lên" onClick={() => move(i, -1)}>
                <ArrowUp size={14} />
              </button>
              <button className="st-icon-button" disabled={busy || i === accounts.length - 1} title="Xuống" aria-label="Xuống" onClick={() => move(i, 1)}>
                <ArrowDown size={14} />
              </button>
              <Toggle label={`Bật ${zaloAccountTitle(a)}`} on={a.enabled} disabled={busy} onChange={(enabled) => void run(() => serverAdmin.updateAccount(a.id, { enabled }), reload)} />
              <button className="st-icon-button sa-more" title="Thao tác" aria-label={`Thao tác với ${zaloAccountTitle(a)}`} disabled={busy} onClick={(e) => menu(e.currentTarget, a)}>
                <MoreHorizontal size={16} />
              </button>
            </div>
          ),
        )}
      </Section>
      {confirm && (
        <Alert
          title={confirm.kind === 'logout' ? `Đăng xuất ${zaloAccountTitle(confirm.account)}?` : `Xoá ${zaloAccountTitle(confirm.account)} khỏi máy chủ?`}
          message={
            confirm.kind === 'logout'
              ? 'Người dùng mất tài khoản này cho đến khi quét lại mã QR.'
              : 'Tài khoản bị đăng xuất, dữ liệu của nó trên máy chủ bị xoá và các quyền cấp riêng cho nó không còn tác dụng.'
          }
          buttons={[
            {
              label: confirm.kind === 'logout' ? 'Đăng xuất' : 'Xoá',
              role: 'destructive',
              onClick: () => {
                const { kind, account } = confirm;
                setConfirm(null);
                void run(() => (kind === 'logout' ? serverAdmin.accountLogout(account.id) : serverAdmin.deleteAccount(account.id)), reload);
              },
            },
            { label: 'Hủy', role: 'cancel', onClick: () => setConfirm(null) },
          ]}
        />
      )}
    </>
  );
}

function LabelForm({ account, onDone }: { account: ZaloAccount; onDone: () => void }) {
  const [label, setLabel] = useState(account.label);
  const { problem, busy, run } = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(() => serverAdmin.updateAccount(account.id, { label: label.trim() }), onDone);
  };
  return (
    <form className="st-auto-editor sa-form" onSubmit={submit}>
      <div className="sa-form-title">Nhãn cho {account.name || zaloAccountTitle(account)}</div>
      <label className="st-field">
        <span>Nhãn (để trống = tên Zalo)</span>
        <input className="st-input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={account.name || 'Ví dụ: Kho Hà Nội'} autoFocus maxLength={40} />
      </label>
      <Problem text={problem} />
      <div className="st-auto-actions is-end">
        <button type="button" className="st-button" onClick={onDone}>
          Hủy
        </button>
        <button className="st-button is-primary" disabled={busy}>
          Lưu
        </button>
      </div>
    </form>
  );
}

// MARK: - One account

function AccountDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { data, error } = usePoll<ZaloAccountDetail>(() => serverAdmin.account(id));
  const [confirmLogout, setConfirmLogout] = useState(false);
  const { problem, busy, run } = useAction();
  const account = data?.account ?? null;
  const phase = data?.phase ?? null;
  const title = zaloAccountTitle(account);

  return (
    <>
      <button className="sa-back-button sa-sub-back" onClick={onBack}>
        <ChevronLeft size={16} /> Tất cả tài khoản
      </button>
      {!data ? (
        <Loading error={error} />
      ) : (
        <>
          {phase?.kind === 'ready' && (
            <Section title={title} footer="Người dùng dùng tài khoản này theo quyền được cấp. Đăng xuất sẽ ngắt tất cả cho đến khi quét lại mã QR.">
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
              <Row label="Đăng xuất Zalo" detail="Đăng xuất tài khoản này khỏi máy chủ.">
                <button className="st-button is-danger" disabled={busy} onClick={() => setConfirmLogout(true)}>
                  <LogOut size={14} /> Đăng xuất Zalo
                </button>
              </Row>
            </Section>
          )}

          {phase?.kind === 'login' && (
            <Section title={`Đăng nhập Zalo: ${title}`} description="Quét mã bằng Zalo trên điện thoại của tài khoản này. Mã được làm mới trên máy chủ.">
              <div className="sa-qr">
                <QrBody state={phase.login} notice={phase.notice ?? null} refresh={() => void run(() => serverAdmin.accountQr(id))} />
              </div>
            </Section>
          )}

          {phase?.kind === 'preparing' && <PreparingSection setup={phase.setup} busy={busy} onRetry={() => void run(() => serverAdmin.zaloRetry())} />}

          {(!phase || phase.kind === 'starting' || phase.kind === 'signingIn') && (
            <Section title={title}>
              <div className="st-row">
                <Spinner size={16} />
                <div className="st-row-text">
                  <div className="st-row-label">
                    {account && !account.enabled ? 'Tài khoản đã tắt.' : phase?.kind === 'signingIn' ? 'Đang đăng nhập và đồng bộ dữ liệu…' : 'Máy chủ đang khởi động tài khoản này…'}
                  </div>
                </div>
              </div>
            </Section>
          )}
        </>
      )}

      <Problem text={problem ?? (data ? error : null)} />

      {confirmLogout && (
        <Alert
          title={`Đăng xuất ${title}?`}
          message="Người dùng mất tài khoản này cho đến khi quét lại mã QR."
          buttons={[
            {
              label: 'Đăng xuất',
              role: 'destructive',
              onClick: () => {
                setConfirmLogout(false);
                void run(() => serverAdmin.accountLogout(id));
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
