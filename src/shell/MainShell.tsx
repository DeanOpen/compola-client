// Signed-in window in the Zalo PC layout (docs/zalo-pc-style.md): the blue 64px rail, the 344px list column, the chat,
// and the 344px info panel on the right (toggled from the chat header). Logic from Swift `MainShellView`.

import { AddAccountHost } from '../features/accounts/AddAccountSheet';
import { MessagesSquare } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { closeConversation, openConversation } from '../engine/chat';
import { setConversationFilter } from '../engine/conversations';
import { getEngine, setEngine, useEngine } from '../engine/store';
import { ChatDetail } from '../features/chat/ChatDetail';
import { ChatInspectorColumn } from '../features/inspector/ChatInspector';
import { ConversationListColumn } from '../features/conversations/ConversationListColumn';
import { QuickSwitcher } from '../features/quickSwitcher/QuickSwitcher';
import { MediaViewerHost } from '../features/media/MediaViewer';
import { FeatureHosts } from '../features/FeatureHosts';
import { ContactsContentColumn, ContactsDetailColumn } from '../features/contacts/ContactsColumns';
import { CloudContentColumn, CloudDetailColumn } from '../features/cloud/CloudColumns';
import { ContentUnavailable } from '../ui/ContentUnavailable';
import { ComposerPrompts } from '../features/chat/ComposerPrompts';
import { ConversationPrompts } from '../features/conversationActions/ConversationPrompts';
import {
  dropUnlock,
  isConversationLocked,
  relockAfterInactivity,
  relockHidden,
  setConversationPrompt,
  unlockFromPINSearch,
  useConversationUI,
} from '../engine/conversationActions';
import { ToastView } from '../ui/Toast';
import { useShellShortcuts } from './keyboard';
import { Rail } from './Rail';
import { commands } from '../engine/backend';
import { isInCall, useCalls } from '../engine/calls';
import { addonTabOf, isAddonTab, isContacts, isConversationList, labelIdOf, officialFilter, shell, useShell, type Destination } from './shellStore';
import { AddonModalHost, AddonTabPage } from '../features/addons/AddonSurfaces';
import './shell.css';

export function MainShell() {
  const { destination, selection, showInspector } = useShell(
    useShallow((s) => ({ destination: s.destination, selection: s.selection, showInspector: s.showInspector })),
  );
  const extrasLoaded = useEngine((s) => s.extras.loaded);
  const labelIds = useEngine(useShallow((s) => s.extras.labels.map((l) => l.id)));
  const navigationRequest = useEngine((s) => s.navigationRequest);
  const inspectorShown = showInspector && isConversationList(destination);

  useShellShortcuts();
  useInspectorRoom(inspectorShown);

  useHiddenChatLock(selection);

  // Mailboxes and labels are lists computed by the official ConvListController: tell it which filter to use.
  useEffect(() => {
    const extras = getEngine().extras;
    if (!extras.loaded) return;
    const filter = officialFilter(destination, extras);
    if (!filter) return;
    if (extras.typeFilter !== filter.tab || extras.labelFilterIds.join() !== filter.labelIds.join()) {
      setConversationFilter(filter.tab, filter.labelIds);
    }
  }, [destination, extrasLoaded]);

  // A label deleted here or on another device takes its list with it.
  useEffect(() => {
    const id = labelIdOf(destination);
    if (id && extrasLoaded && !labelIds.includes(id)) shell.setDestination('inbox');
  }, [labelIds, destination, extrasLoaded]);

  // Other views (cards, mentions, notifications…) ask to show a conversation: back to the unfiltered inbox with it open.
  useEffect(() => {
    if (!navigationRequest) return;
    shell.setDestination('inbox');
    shell.clearSearch();
    shell.select(navigationRequest);
    setEngine({ navigationRequest: null });
  }, [navigationRequest]);

  return (
    <div className={`shell ${inspectorShown ? 'has-inspector' : ''} ${isAddonTab(destination) ? 'has-addon-tab' : ''}`}>
      <Rail />
      <section className="shell-content">
        <ContentColumn destination={destination} />
      </section>
      <section className="shell-detail">
        <DetailColumn destination={destination} selection={selection} />
        <ToastView conversationId={null} bottom={24} />
      </section>
      {inspectorShown && (
        <aside className="shell-inspector">
          <ChatInspectorColumn conversationId={selection} />
        </aside>
      )}
      <QuickSwitcher />
      <MediaViewerHost />
      <ComposerPrompts />
      <ConversationPrompts onUnlocked={(id) => useShell.getState().selection === id && openConversation(id)} />
      <FeatureHosts />
      <AddAccountHost />
      <AddonModalHost />
    </div>
  );
}

/**
 * Opens the selection in the official client — unless it is a hidden chat still locked (Swift `MainShellView.openSelection`):
 * then it stays closed and the PIN is asked (official OPEN_CONV screen). Also: a deleted / hidden conversation leaves the
 * detail pane, and the PIN bypass ends after a minute away from the app.
 */
const useHiddenChatLock = (selection: string | null) => {
  const hiddenKnown = useEngine((s) => s.conversationActions.hiddenKnown);
  const hiddenIds = useEngine((s) => s.conversationActions.hiddenIds);
  const unlockedId = useConversationUI((s) => s.unlockedId);
  const removal = useConversationUI((s) => s.removal);
  const inCall = useCalls((s) => isInCall(s));

  useEffect(() => {
    // The bypass belongs to the one conversation opened with the PIN.
    if (useConversationUI.getState().unlockedId !== selection) dropUnlock();
    if (!selection) return closeConversation();
    // Until the hidden-chat state is known any conversation could be hidden: nothing is opened.
    if (!getEngine().conversationActions.hiddenKnown) return closeConversation();
    if (isConversationLocked(selection)) {
      if (unlockFromPINSearch(selection)) return openConversation(selection);
      closeConversation();
      setConversationPrompt({ kind: 'unlock', id: selection });
      return;
    }
    openConversation(selection);
  }, [selection, hiddenKnown]);

  // Hidden-chat state changed (also from another device): a locked conversation must not stay open — never under a call.
  useEffect(() => {
    if (selection && hiddenKnown && isConversationLocked(selection) && !inCall && getEngine().openConversationId === selection) closeConversation();
  }, [hiddenIds, unlockedId, inCall]);

  useEffect(() => {
    if (removal && selection && removal.ids.has(selection)) shell.select(null);
  }, [removal]);

  // The PIN bypass ends after a real absence (60 s inactive, checked on return); a short focus loss keeps it.
  useEffect(() => {
    let leftAt: number | null = null;
    const onBlur = () => (leftAt = Date.now());
    const onFocus = () => {
      if (leftAt !== null && Date.now() - leftAt >= relockAfterInactivity) {
        relockHidden();
        useShell.setState({ unlockedHiddenIds: null });
      }
      leftAt = null;
    };
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
    };
  }, []);
};

/** Rail + list + the chat's minimum + the info panel: below this the window is widened while the panel shows. */
const roomWithInspector = 76 + 344 + 520 + 344;

/**
 * Swift `InspectorRoom`: the info panel takes its width from the window, never from the chat. Opening it on a window
 * too narrow widens the window by what is missing (`ui_widen_window`, which also keeps the window on screen); closing
 * it gives back exactly what was added (the host reports it: a small screen may allow less).
 */
const useInspectorRoom = (shown: boolean) => {
  const added = useRef(0);
  const pending = useRef(false);
  useEffect(() => {
    if (shown && added.current === 0 && !pending.current && window.innerWidth < roomWithInspector) {
      pending.current = true;
      void commands
        .widenWindow(roomWithInspector - window.innerWidth)
        .then((applied) => (added.current = typeof applied === 'number' && applied > 0 ? applied : 0))
        .catch(() => {})
        .finally(() => (pending.current = false));
    } else if (!shown && added.current > 0) {
      const back = added.current;
      added.current = 0;
      void commands.widenWindow(-back).catch(() => {});
    }
  }, [shown]);
};

/** Middle column: the list for the sidebar destination. */
function ContentColumn({ destination }: { destination: Destination }) {
  if (isConversationList(destination)) return <ConversationListColumn />;
  if (isContacts(destination)) return <ContactsContentColumn destination={destination} />;
  if (destination === 'zcloud') return <CloudContentColumn />;
  return <ConversationListColumn />;
}

/** Right column: the chat (contact cards and zCloud screens arrive with their features). */
function DetailColumn({ destination, selection }: { destination: Destination; selection: string | null }) {
  if (isConversationList(destination)) return <ChatDetail conversationId={selection} />;
  if (isContacts(destination)) return <ContactsDetailColumn destination={destination} />;
  if (destination === 'zcloud') return <CloudDetailColumn />;
  const tab = addonTabOf(destination);
  if (tab) return <AddonTabPage addonId={tab[0]} viewId={tab[1]} />;
  return (
    <div className="column">
      <div className="toolbar" data-tauri-drag-region />
      <ContentUnavailable icon={MessagesSquare} title="Chưa có nội dung" />
    </div>
  );
}

/** Title of a content column (Mail's mailbox title in the unified toolbar). */
export function ColumnToolbar({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="toolbar column-toolbar" data-tauri-drag-region>
      <div className="column-title" data-tauri-drag-region>
        <div className="column-title-main truncate">{title}</div>
        {subtitle ? <div className="column-title-sub truncate">{subtitle}</div> : null}
      </div>
    </div>
  );
}
