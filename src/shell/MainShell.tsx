// Signed-in window in the Zalo PC layout (docs/zalo-pc-style.md): the blue 64px rail, the 344px list column, the chat,
// and the 344px info panel on the right (toggled from the chat header). Logic from Swift `MainShellView`.

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
import { ToastView } from '../ui/Toast';
import { useShellShortcuts } from './keyboard';
import { Rail } from './Rail';
import { commands } from '../engine/backend';
import { isContacts, isConversationList, labelIdOf, officialFilter, shell, useShell, type Destination } from './shellStore';
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

  // The selection opens the conversation in the official client.
  useEffect(() => {
    if (selection) openConversation(selection);
    else closeConversation();
  }, [selection]);

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
    shell.setSearch('');
    shell.select(navigationRequest);
    setEngine({ navigationRequest: null });
  }, [navigationRequest]);

  return (
    <div className={`shell ${inspectorShown ? 'has-inspector' : ''}`}>
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
      <FeatureHosts />
    </div>
  );
}

/** Rail + list + the chat's minimum + the info panel: below this the window is widened while the panel shows. */
const roomWithInspector = 64 + 344 + 520 + 344;
const inspectorWidening = 300;

/**
 * Swift `InspectorRoom`: the info panel takes its width from the window, never from the chat. Opening it on a window
 * too narrow widens the window (`ui_widen_window`); closing it gives back what was added.
 */
const useInspectorRoom = (shown: boolean) => {
  const widened = useRef(false);
  useEffect(() => {
    if (shown && !widened.current && window.innerWidth < roomWithInspector) {
      widened.current = true;
      void commands.widenWindow(inspectorWidening).catch(() => (widened.current = false));
    } else if (!shown && widened.current) {
      widened.current = false;
      void commands.widenWindow(-inspectorWidening).catch(() => {});
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
