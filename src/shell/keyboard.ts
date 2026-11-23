// Window shortcuts of the signed-in shell (Swift `CompolaCommands` + view shortcuts):
// ⌘K quick switcher · ⌥⌘I inspector · ⌥⌘F / ⌘F search · ⌃⌘S sidebar · ⌘R reply to the newest message ·
// ⌥⌘1/2/3/4 mailboxes, ⌥⌘5 Danh bạ, ⌥⌘6 zCloud.

import { useEffect } from 'react';
import { getEngine } from '../engine/store';
import { escapeStackDepth } from '../ui/escape';
import { shell, useShell, type Destination } from './shellStore';

const destinations: Record<string, Destination> = {
  Digit1: 'inbox',
  Digit2: 'other',
  Digit3: 'unread',
  Digit4: 'strangers',
  Digit5: 'friends',
  Digit6: 'zcloud',
};

export const useShellShortcuts = () => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const cmd = e.metaKey || (e.ctrlKey && !navigator.platform.startsWith('Mac'));
      if (!cmd) return;
      const code = e.code;
      // ⌘K works from anywhere, also over a sheet it is not (the switcher toggles itself).
      if (code === 'KeyK' && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        if (escapeStackDepth() === 0 || useShell.getState().showQuickSwitcher) shell.toggleQuickSwitcher();
        return;
      }
      if (escapeStackDepth() > 0) return;
      if (e.altKey && code === 'KeyI') {
        e.preventDefault();
        shell.toggleInspector();
      } else if (code === 'KeyF' && !e.shiftKey) {
        e.preventDefault();
        shell.focusSearch();
      } else if (e.ctrlKey && code === 'KeyS') {
        e.preventDefault();
        shell.toggleSidebar();
      } else if (code === 'KeyR' && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        shell.replyToLatest();
      } else if (e.altKey && destinations[code]) {
        e.preventDefault();
        const d = destinations[code];
        if (d === 'other' && !getEngine().extras.archivedEnabled) return;
        if (useShell.getState().search) shell.setSearch('');
        shell.setDestination(d);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
};
