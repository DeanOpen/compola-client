// The Settings dialog (⌘, / account menu "Cài đặt…"), rendered once by the main shell.

import { create } from 'zustand';
import { SettingsDialog, type SettingsTab } from './SettingsView';
import './appearance';

const useSettingsHost = create<{ tab: SettingsTab | null }>()(() => ({ tab: null }));

/** Opens Settings (account menu "Cài đặt…", ⌘,), optionally on one section. */
export const openSettings = (tab: SettingsTab = 'general') => useSettingsHost.setState({ tab });
export const closeSettings = () => useSettingsHost.setState({ tab: null });

export function SettingsHosts() {
  const tab = useSettingsHost((s) => s.tab);
  if (!tab) return null;
  return <SettingsDialog tab={tab} onTab={(t) => useSettingsHost.setState({ tab: t })} onClose={closeSettings} />;
}
