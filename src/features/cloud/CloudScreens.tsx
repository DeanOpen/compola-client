// The zCloud screens other than browsing (Swift CloudView.swift): storage card, "Theo trò chuyện", "Thông tin gói",
// "Cài đặt zCloud", and "Cloud của tôi".

import {
  ChevronRight,
  CheckCircle2,
  HardDrive,
  Info,
  MessagesSquare,
  MinusCircle,
  Search,
  Settings,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  breakdownBytes,
  cloudKinds,
  cloudKindTitle,
  cloudSetOffload,
  planIsPaid,
  planRemaining,
  useCloud,
  type CloudBreakdown,
  type CloudConversation,
  type CloudItemKind,
  type CloudPlan,
} from '../../engine/cloud';
import { displayName } from '../../engine/models/conversations';
import { useEngine } from '../../engine/store';
import { Avatar } from '../../ui/Avatar';
import { ContentUnavailable } from '../../ui/ContentUnavailable';
import { Alert } from '../../ui/Overlays';
import { Spinner } from '../../ui/Spinner';
import { fold } from '../conversations/support';
import { CloudMediaView } from './CloudMediaView';
import { HeaderIcon, Segmented } from './Segmented';
import { cloudUi, formatDate, formatDateTime, formatSize, kindIcon, useCloudUi } from './support';

const mediaColor = '#ff9500';
const backupColor = '#34c759';
const myCloudColor = '#ffcc00';
const familyColor = 'rgb(92, 133, 199)';

// MARK: - Storage card

/** Quota bar with the official legend (Tin nhắn media / Sao lưu tin nhắn / Cloud của tôi / Gia đình). */
export function CloudUsageBar({ plan, height = 8 }: { plan: CloudPlan; height?: number }) {
  const quota = Math.max(plan.quota, 1);
  const segments: [string, number][] = [
    [mediaColor, plan.cloudMedia],
    [backupColor, plan.messageBackup],
    [myCloudColor, plan.myCloud],
    [familyColor, plan.family],
  ];
  return (
    <div className="cloud-usage-bar" style={{ height }}>
      {segments
        .filter(([, bytes]) => bytes > 0)
        .map(([color, bytes], i) => (
          <span key={i} style={{ background: color, width: `max(2px, ${Math.min(100, (bytes / quota) * 100)}%)` }} />
        ))}
    </div>
  );
}

export function CloudStorageCard() {
  const plan = useCloud((s) => s.plan);
  return (
    <div className="cloud-storage-card">
      <div className="cloud-storage-head">
        <span className="cloud-storage-title">Dung lượng lưu trữ</span>
        {plan && <span className="cloud-storage-used">{`${formatSize(plan.usage + plan.family)} / ${formatSize(plan.quota)}`}</span>}
      </div>
      {plan ? (
        <>
          <CloudUsageBar plan={plan} />
          <div className="cloud-legend-wrap">
            <Legend color={mediaColor} title="Media" />
            <Legend color={backupColor} title="Sao lưu" />
            <Legend color={myCloudColor} title="Cloud của tôi" />
            {plan.family > 0 && <Legend color={familyColor} title="Gia đình" />}
          </div>
          <div className="cloud-storage-free">Còn trống {formatSize(planRemaining(plan))}</div>
        </>
      ) : (
        <div className="cloud-storage-loading">
          <Spinner size={12} /> Đang tính toán…
        </div>
      )}
    </div>
  );
}

function Legend({ color, title }: { color: string; title: string }) {
  return (
    <span className="cloud-legend">
      <span className="cloud-dot" style={{ background: color, width: 6, height: 6 }} />
      {title}
    </span>
  );
}

function LegendRow({ color, title, bytes }: { color: string; title: string; bytes: number }) {
  return (
    <div className="cloud-legend-row">
      <span className="cloud-dot" style={{ background: color }} />
      <span className="cloud-legend-row-title">{title}</span>
      <span className="cloud-legend-row-bytes nums">{formatSize(bytes)}</span>
    </div>
  );
}

// MARK: - My Cloud

/** "Cloud của tôi" documents (needs the official My Cloud conversation id). */
export function CloudMyCloudScreen() {
  const cloudSelf = useCloud((s) => s.selfId);
  const engineSelf = useEngine((s) => s.selfConversationId);
  const id = cloudSelf ?? engineSelf;
  if (!id) {
    return (
      <div className="column cloud-root cloud-detail">
        <div className="cloud-header" data-tauri-drag-region />
        <div className="cloud-center">
          <Spinner size={18} />
        </div>
      </div>
    );
  }
  return <CloudMediaView key={`my:${id}`} scope={{ kind: 'myCloud', id }} />;
}

// MARK: - Conversations

export function CloudConversationsView() {
  const open = useCloudUi((s) => s.openConversation);
  if (open) {
    return <CloudMediaView key={`conv:${open.id}`} scope={{ kind: 'conversation', id: open.id, name: open.name }} onBack={() => cloudUi.openConversation(null)} />;
  }
  return <ConversationsList />;
}

function ConversationsList() {
  const cloud = useCloud();
  const known = useEngine((s) => s.conversations);
  const [search, setSearch] = useState('');
  const [bySize, setBySize] = useState(true);

  /** Conversations with a resolved display name (conversation list first, then the official cloud name). */
  const rows = useMemo(() => {
    const byId = new Map(known.map((c) => [c.id, c]));
    let list: CloudConversation[] = cloud.conversations.map((conv) => {
      const match = byId.get(conv.id);
      const name = conv.name || (match ? displayName(match) : conv.isGroup ? 'Nhóm' : 'Trò chuyện');
      return { ...conv, name, avatar: conv.avatar ?? match?.avatar ?? null };
    });
    const q = fold(search.trim());
    if (q) list = list.filter((c) => fold(c.name).includes(q));
    list.sort((a, b) => (bySize ? b.total - a.total : (b.lastActivity ?? 0) - (a.lastActivity ?? 0)));
    return list;
  }, [cloud.conversations, known, search, bySize]);

  let body;
  if (!cloud.loaded) {
    body = (
      <div className="cloud-center">
        <Spinner size={18} />
        <span className="secondary">Đang tính toán…</span>
      </div>
    );
  } else if (!cloud.hiddenLookup) {
    body = (
      <ContentUnavailable
        icon={ShieldAlert}
        title="Chưa thể hiển thị"
        description="Chưa xác định được các trò chuyện ẩn nên dữ liệu theo trò chuyện tạm thời bị ẩn."
      />
    );
  } else if (!rows.length) {
    body = <ContentUnavailable icon={MessagesSquare} title={search ? 'Không tìm thấy' : 'Chưa có dữ liệu'} />;
  } else {
    body = (
      <div className="cloud-scroll">
        <div className="cloud-list">
          {rows.map((conv) => (
            <button key={conv.id} className="cloud-row cloud-conv-row" onClick={() => cloudUi.openConversation({ id: conv.id, name: conv.name })}>
              <Avatar url={conv.avatar} name={conv.name} size={40} />
              <span className="cloud-row-text">
                <span className="cloud-row-name truncate">{conv.name}</span>
                <span className="cloud-row-sub">{conv.isGroup ? 'Nhóm' : 'Cá nhân'}</span>
              </span>
              <span className="cloud-conv-total nums">{formatSize(conv.total)}</span>
              <span className="cloud-row-date nums">{conv.lastActivity ? formatDate(conv.lastActivity) : '--'}</span>
              <ChevronRight size={14} className="tertiary" />
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="column cloud-root cloud-detail">
      <div className="cloud-header" data-tauri-drag-region>
        <HeaderIcon icon={MessagesSquare} />
        <div className="cloud-header-titles" data-tauri-drag-region>
          <div className="cloud-header-title truncate">Theo trò chuyện</div>
        </div>
      </div>
      <div className="cloud-filter cloud-conv-filter">
        <label className="cz-search">
          <Search size={13} className="secondary" />
          <input value={search} placeholder="Nhập tên trò chuyện" spellCheck={false} onChange={(e) => setSearch(e.target.value)} aria-label="Nhập tên trò chuyện" />
          {search && (
            <button className="icon-button" onClick={() => setSearch('')} title="Xoá" aria-label="Xoá nội dung tìm kiếm">
              <XCircle size={14} fill="currentColor" stroke="var(--content)" />
            </button>
          )}
        </label>
        <Segmented
          options={[
            { value: true, label: 'Dung lượng' },
            { value: false, label: 'Hoạt động gần nhất' },
          ]}
          value={bySize}
          onChange={setBySize}
          label="Sắp xếp"
        />
      </div>
      <div className="cloud-body">{body}</div>
    </div>
  );
}

// MARK: - Plan

const planTitle = (plan: CloudPlan) => (planIsPaid(plan) ? plan.name : 'Gói miễn phí');

const planStatus = (plan: CloudPlan): string => {
  switch (plan.kind) {
    case 'paid':
      return plan.expireAt ? `Đang hoạt động • hết hạn ${formatDate(plan.expireAt)}` : 'Đang hoạt động';
    case 'grace':
      return 'Đã hết hạn — dữ liệu còn được giữ trong thời gian gia hạn';
    case 'free':
      return 'Chỉ lưu trữ Cloud của tôi';
    case 'afterGrace':
      return 'Đã hết thời gian gia hạn zCloud';
  }
};

const kindColor = (k: CloudItemKind) => (k === 'photo' ? '#ff9500' : k === 'video' ? '#34c759' : k === 'file' ? '#ffcc00' : familyColor);

export function CloudPlanView() {
  const plan = useCloud((s) => s.plan);
  const media = useCloud((s) => s.media);
  const mine = useCloud((s) => s.myCloudTypes);
  return (
    <div className="column cloud-root cloud-detail">
      <div className="cloud-header" data-tauri-drag-region>
        <HeaderIcon icon={HardDrive} />
        <div className="cloud-header-titles" data-tauri-drag-region>
          <div className="cloud-header-title truncate">Thông tin gói</div>
        </div>
      </div>
      <div className="cloud-scroll">
        {plan ? (
          <div className="cloud-page">
            <div className="cloud-card cloud-plan-header">
              <span className="cloud-plan-icon">
                <HardDrive size={26} />
              </span>
              <span className="cloud-plan-text">
                <span className="cloud-plan-title">{planTitle(plan)}</span>
                <span className="cloud-plan-status">{planStatus(plan)}</span>
              </span>
              <span className="cloud-plan-quota">{formatSize(plan.quota)}</span>
            </div>

            <div className="cloud-card">
              <div className="cloud-card-head">
                <span className="cloud-card-title">Dung lượng lưu trữ</span>
                <span className="cloud-card-aside">
                  <b>Đã dùng {formatSize(plan.usage + plan.family)}</b> <span className="tertiary">•</span>{' '}
                  <span className="secondary">Còn trống {formatSize(planRemaining(plan))}</span>
                </span>
              </div>
              <CloudUsageBar plan={plan} height={12} />
              <div className="cloud-legend-rows">
                <LegendRow color={mediaColor} title="Tin nhắn media" bytes={plan.cloudMedia} />
                <LegendRow color={backupColor} title="Sao lưu tin nhắn" bytes={plan.messageBackup} />
                <LegendRow color={myCloudColor} title="Cloud của tôi" bytes={plan.myCloud} />
                {plan.family > 0 && <LegendRow color={familyColor} title="Gia đình" bytes={plan.family} />}
              </div>
            </div>

            <TypeCard media={media} mine={mine} />

            <div className="cloud-card cloud-info-card">
              <InfoRow title="Gói" value={planTitle(plan)} />
              {planIsPaid(plan) && (
                <>
                  <InfoRow title="Hết hạn vào" value={formatDate(plan.expireAt)} />
                  {plan.autoRenew !== null && <InfoRow title="Tự động gia hạn" value={plan.autoRenew ? 'Bật' : 'Tắt'} />}
                  {plan.months > 0 && <InfoRow title="Chu kỳ" value={`${plan.months} tháng`} />}
                </>
              )}
              {plan.fileLimit > 0 && <InfoRow title="Dung lượng tối đa mỗi file" value={formatSize(plan.fileLimit)} />}
              <InfoRow title="Khoá cloud" value={plan.hasKey ? 'Đã có' : 'Chưa có — mở Zalo trên điện thoại để đồng bộ'} />
            </div>

            <div className="cloud-card">
              <span className="cloud-card-title">Tự động lưu trữ lên zCloud</span>
              <ToggleRow title="Tin nhắn media" on={plan.backupMedia} />
              <ToggleRow title="Cloud của tôi" on={plan.backupMyCloud} />
              <ToggleRow title="Sao lưu tin nhắn" on={plan.backupMessages} />
              <span className="cloud-card-note">Cài đặt lưu trữ được điều khiển từ Zalo trên điện thoại.</span>
            </div>

            <div className="cloud-hint">
              <Info size={13} /> Bạn có thể quản lý gói này trên điện thoại.
            </div>
          </div>
        ) : (
          <div className="cloud-center" style={{ minHeight: 300 }}>
            <Spinner size={18} />
            <span className="secondary">Đang tính toán…</span>
          </div>
        )}
      </div>
    </div>
  );
}

function TypeCard({ media, mine }: { media: CloudBreakdown; mine: CloudBreakdown }) {
  const bytes = (k: CloudItemKind) => breakdownBytes(media, k) + breakdownBytes(mine, k);
  const max = Math.max(1, ...cloudKinds.map(bytes));
  return (
    <div className="cloud-card">
      <span className="cloud-card-title">Dung lượng của tôi</span>
      {cloudKinds.map((k) => {
        const Icon = kindIcon(k);
        const b = bytes(k);
        return (
          <div key={k} className="cloud-type-row">
            <div className="cloud-type-head">
              <span className="cloud-type-label">
                <Icon size={14} className="tint" /> {cloudKindTitle(k)}
              </span>
              <span className="secondary nums">{formatSize(b)}</span>
            </div>
            <div className="cloud-type-track">
              <span style={{ background: kindColor(k), width: b > 0 ? `max(4px, ${(b / max) * 100}%)` : 0 }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ToggleRow({ title, on }: { title: string; on: boolean }) {
  return (
    <div className="cloud-toggle-row">
      <span>{title}</span>
      <span className={`cloud-toggle-state ${on ? 'is-on' : ''}`}>
        {on ? <CheckCircle2 size={13} /> : <MinusCircle size={13} />} {on ? 'Bật' : 'Tắt'}
      </span>
    </div>
  );
}

function InfoRow({ title, value }: { title: string; value: string }) {
  return (
    <div className="cloud-info-row">
      <span className="secondary">{title}</span>
      <span className="cloud-info-value">{value}</span>
    </div>
  );
}

// MARK: - Settings

export function CloudSettingsView() {
  const settings = useCloud((s) => s.settings);
  const plan = useCloud((s) => s.plan);
  const [confirming, setConfirming] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const days = Math.max(settings.ttlDays, 1);
  const description = `Nội dung đã lưu trên zCloud sẽ được gỡ khỏi máy sau ${days} ngày. Bạn có thể xem lại những nội dung này bất kỳ lúc nào.`;

  const unavailableHint = (() => {
    if (settings.offloadAvailable) return null;
    if (!plan) return 'Đang tải thông tin gói…';
    if (!planIsPaid(plan)) return 'Tính năng này chỉ hoạt động khi bạn nâng cấp zCloud.';
    if (!plan.hasKey) return 'Vui lòng mở Zalo trên điện thoại để hoàn tất đồng bộ.';
    return 'Tính năng tạm thời chưa khả dụng, vui lòng thử lại sau.';
  })();

  const lastInfo =
    settings.lastOffloadAt && settings.lastOffloadSize > 0
      ? `Tối ưu dung lượng gần nhất lúc ${formatDateTime(settings.lastOffloadAt)}, giải phóng ${formatSize(settings.lastOffloadSize)} trên máy tính.`
      : 'Quá trình dọn dẹp diễn ra tự động, bạn sẽ nhận được thông báo khi hoàn tất.';

  const apply = async (enable: boolean) => {
    setBusy(true);
    setMessage(null);
    const result = await cloudSetOffload(enable);
    setBusy(false);
    if (!result.ok) setMessage(result.error ?? 'Không thay đổi được cài đặt.');
  };

  return (
    <div className="column cloud-root cloud-detail">
      <div className="cloud-header" data-tauri-drag-region>
        <HeaderIcon icon={Settings} />
        <div className="cloud-header-titles" data-tauri-drag-region>
          <div className="cloud-header-title truncate">Cài đặt zCloud</div>
        </div>
      </div>
      <div className="cloud-scroll">
        <div className="cloud-page" style={{ maxWidth: 680 }}>
          <div className="cloud-card">
            <div className="cloud-setting-row">
              <span className="cloud-setting-text">
                <span className="cloud-card-title">Tự động giải phóng dung lượng</span>
                <span className="cloud-card-desc">{description}</span>
              </span>
              <Switch on={settings.offloadEnabled} disabled={!settings.offloadAvailable || busy} onChange={(v) => setConfirming(v)} label="Tự động giải phóng dung lượng" />
            </div>
            {unavailableHint ? (
              <span className="cloud-card-note">
                <Info size={12} /> {unavailableHint}
              </span>
            ) : settings.offloadEnabled ? (
              <span className="cloud-card-note">{lastInfo}</span>
            ) : null}
            {message && <span className="cloud-card-warning">{message}</span>}
          </div>
          <div className="cloud-card">
            <span className="cloud-card-title">Hỗ trợ</span>
            <span className="cloud-card-desc">
              Quản lý gói, gia hạn và cài đặt lưu trữ (Tin nhắn media, Cloud của tôi, Sao lưu tin nhắn) được thực hiện trên Zalo điện thoại.
            </span>
          </div>
        </div>
      </div>
      {confirming !== null && (
        <Alert
          title={confirming ? 'Bật tự động giải phóng dung lượng?' : 'Tắt tự động giải phóng dung lượng?'}
          message={confirming ? description : 'Zalo sẽ không tự động gỡ nội dung đã lưu trên zCloud khỏi máy nữa.'}
          buttons={[
            {
              label: confirming ? 'Bật' : 'Tắt',
              onClick: () => {
                const enable = confirming;
                setConfirming(null);
                void apply(enable);
              },
            },
            { label: 'Huỷ', role: 'cancel', onClick: () => setConfirming(null) },
          ]}
        />
      )}
    </div>
  );
}

/** macOS-style switch (SwiftUI `.toggleStyle(.switch)`). */
function Switch({ on, disabled, onChange, label }: { on: boolean; disabled?: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} className={`cloud-switch ${on ? 'is-on' : ''}`} disabled={disabled} onClick={() => onChange(!on)}>
      <span className="cloud-switch-knob" />
    </button>
  );
}
