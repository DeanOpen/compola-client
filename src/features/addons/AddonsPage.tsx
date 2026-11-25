// Every add-on on one full page (the "Add-on" item in the rail): install, turn on, configure, see their health,
// and open their pages. The same sections as Settings › Add-on, with room to breathe.

import { useAutomation } from '../../engine/automation';
import { AddonSettings } from '../settings/AutomationSettings';
import '../settings/settings.css';
import '../settings/automation.css';

export function AddonsPage() {
  // Select the array itself: `?? []` here would be a new value every render (an endless update loop).
  const list = useAutomation((s) => s.state?.addons);
  const addons = list ?? [];
  const on = addons.filter((a) => a.enabled).length;
  return (
    <div className="column addon-tab-page">
      <div className="toolbar column-toolbar" data-tauri-drag-region>
        <div className="column-title" data-tauri-drag-region>
          <div className="column-title-main truncate">Add-on</div>
          <div className="column-title-sub truncate">{addons.length ? `${addons.length} add-on · ${on} đang bật` : 'Mở rộng Compola bằng các tiện ích JavaScript'}</div>
        </div>
      </div>
      <div className="addon-tab-body addons-page">
        <div className="st-page addons-page-inner">
          <AddonSettings />
        </div>
      </div>
    </div>
  );
}
