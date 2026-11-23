// zCloud in the shell (Swift Shell/CloudColumns.swift): the content column lists the storage summary and the zCloud
// screens; the detail column shows the picked one.

import { useEffect, type ReactNode } from 'react';
import { HardDrive, Images, Folder, MessagesSquare, Settings, type LucideIcon } from 'lucide-react';
import { hasMediaScreens, refreshCloud, useCloud } from '../../engine/cloud';
import { CloudMediaView } from './CloudMediaView';
import { CloudConversationsView, CloudMyCloudScreen, CloudPlanView, CloudSettingsView, CloudStorageCard } from './CloudScreens';
import { cloudUi, formatSize, useCloudUi, type CloudRoute } from './support';
import './cloud.css';

export function CloudContentColumn() {
  const plan = useCloud((s) => s.plan);
  const hasMedia = useCloud(hasMediaScreens);
  const route = useCloudUi((s) => s.route);

  useEffect(() => refreshCloud(), []);

  // Free accounts only have "Cloud của tôi": leave the hidden media screens.
  useEffect(() => {
    if (!hasMedia && (route === 'media' || route === 'conversations')) cloudUi.setRoute('myCloud');
  }, [hasMedia, route]);

  const row = (title: string, icon: LucideIcon, r: CloudRoute): ReactNode => (
    <button key={r} className={`cloud-route ${route === r ? 'is-selected' : ''}`} onClick={() => cloudUi.setRoute(r)} aria-current={route === r}>
      {(() => {
        const Icon = icon;
        return <Icon size={16} className="cloud-route-icon" />;
      })()}
      <span className="truncate">{title}</span>
    </button>
  );

  return (
    <div className="column cloud-root cloud-list-column">
      <div className="cloud-list-header" data-tauri-drag-region>
        <div className="cloud-header-titles" data-tauri-drag-region>
          <div className="cloud-header-title truncate">zCloud</div>
          {plan && <div className="cloud-header-sub truncate">{`${formatSize(plan.usage + plan.family)} / ${formatSize(plan.quota)}`}</div>}
        </div>
      </div>
      <div className="cloud-routes">
        <CloudStorageCard />
        <div className="cloud-route-section">
          {hasMedia && row('Tin nhắn media', Images, 'media')}
          {hasMedia && row('Theo trò chuyện', MessagesSquare, 'conversations')}
          {row('Cloud của tôi', Folder, 'myCloud')}
        </div>
        <div className="cloud-route-section">
          {row('Thông tin gói', HardDrive, 'plan')}
          {row('Cài đặt zCloud', Settings, 'settings')}
        </div>
      </div>
    </div>
  );
}

export function CloudDetailColumn() {
  const route = useCloudUi((s) => s.route);
  const hasMedia = useCloud(hasMediaScreens);
  switch (route) {
    case 'media':
      return hasMedia ? <CloudMediaView key="media" scope={{ kind: 'all' }} /> : <CloudMyCloudScreen />;
    case 'conversations':
      return <CloudConversationsView />;
    case 'myCloud':
      return <CloudMyCloudScreen />;
    case 'plan':
      return <CloudPlanView />;
    case 'settings':
      return <CloudSettingsView />;
  }
}
