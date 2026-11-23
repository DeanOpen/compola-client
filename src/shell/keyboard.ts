// Window shortcuts of the signed-in shell (Swift `CompolaCommands` + view shortcuts):
// ⌘K quick switcher · ⌥⌘I inspector · ⌥⌘F / ⌘F search · ⇧⌘F search in the open conversation · ⌃⌘S sidebar · ⌘R reply to the newest message · ⌘, Settings ·
// ⌥⌘1/2/3/4 mailboxes, ⌥⌘5 Danh bạ, ⌥⌘6 zCloud · ⌃1–5 Zalo accounts · ⇧⌘N add an account.

import { useEffect } from 'react';
import { getEngine } from '../engine/store';
import { beginAddAccount, switchToIndex, useAccounts } from '../engine/accounts';
import { escapeStackDepth } from '../ui/escape';
import { openSettings } from '../features/settings/hosts';
import { isConversationList, shell, useShell, type Destination } from './shellStore';

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
      // ⌃1–5: the n-th Zalo account of the rail (multi-account).
      if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && /^Digit[1-5]$/.test(e.code) && escapeStackDepth() === 0) {
        if (useAccounts.getState().accounts.length > 1) {
          e.preventDefault();
          switchToIndex(Number(e.code.slice(5)) - 1);
        }
        return;
      }
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
      // ⌘⇧N: add a Zalo account.
      if (code === 'KeyN' && e.shiftKey && !e.altKey && useAccounts.getState().accounts.length > 0) {
        e.preventDefault();
        void beginAddAccount();
        return;
      }
      if (code === 'Comma' && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        openSettings();
        return;
      }
      if (e.altKey && code === 'KeyI') {
        e.preventDefault();
        shell.toggleInspector();
      } else if (code === 'KeyF' && !e.shiftKey) {
        e.preventDefault();
        shell.focusSearch();
      } else if (code === 'KeyF' && e.shiftKey && !e.altKey) {
        // Search the open conversation's messages.
        const { selection, destination } = useShell.getState();
        if (!selection || !isConversationList(destination)) return;
        e.preventDefault();
        shell.searchInConversation(selection);
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
        if (useShell.getState().search || useShell.getState().searchScope) shell.clearSearch();
        shell.setDestination(d);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
};
