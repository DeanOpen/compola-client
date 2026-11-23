// Signed-in window (Swift `MainShellView`): Mail / Messages-style columns. The sidebar picks a destination, the
// content column lists it and the detail column shows the chat; the inspector slides in on the right.

import { MessagesSquare } from 'lucide-react';
import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { closeConversation, openConversation } from '../engine/chat';
import { answerComposerConfirm } from '../engine/composer';
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
import { Alert } from '../ui/Overlays';
import { ToastView } from '../ui/Toast';
import { useShellShortcuts } from './keyboard';
import { Sidebar } from './Sidebar';
import { isContacts, isConversationList, labelIdOf, officialFilter, shell, useShell, type Destination } from './shellStore';
import './shell.css';

export function MainShell() {
  const { destination, selection, sidebarVisible, showInspector } = useShell(
    useShallow((s) => ({ destination: s.destination, selection: s.selection, sidebarVisible: s.sidebarVisible, showInspector: s.showInspector })),
  );
  const extrasLoaded = useEngine((s) => s.extras.loaded);
  const labelIds = useEngine(useShallow((s) => s.extras.labels.map((l) => l.id)));
  const navigationRequest = useEngine((s) => s.navigationRequest);
  const composerConfirm = useEngine((s) => s.composerConfirm);

  useShellShortcuts();

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

  // Other views (cards, mentions…) ask to show a conversation: back to the unfiltered inbox with it open.
  useEffect(() => {
    if (!navigationRequest) return;
    shell.setDestination('inbox');
    shell.setSearch('');
    shell.select(navigationRequest);
    setEngine({ navigationRequest: null });
  }, [navigationRequest]);

  return (
    <div className={`shell ${sidebarVisible ? '' : 'is-sidebar-hidden'} ${showInspector ? 'has-inspector' : ''}`}>
      <div className="shell-backdrop" aria-hidden />
      {sidebarVisible && <Sidebar />}
      <section className="shell-content">
        <ContentColumn destination={destination} />
      </section>
      <section className="shell-detail">
        <DetailColumn destination={destination} selection={selection} />
        <ToastView conversationId={null} bottom={24} />
      </section>
      {showInspector && isConversationList(destination) && (
        <aside className="shell-inspector slide-in-right">
          <ChatInspectorColumn conversationId={selection} />
        </aside>
      )}
      <QuickSwitcher />
      <MediaViewerHost />
      <FeatureHosts />
      {composerConfirm && (
        <Alert
          title={composerConfirm.title}
          message={composerConfirm.message}
          buttons={[
            { label: composerConfirm.ok, onClick: () => answerComposerConfirm(composerConfirm, true) },
            { label: composerConfirm.cancel, role: 'cancel', onClick: () => answerComposerConfirm(composerConfirm, false) },
          ]}
        />
      )}
    </div>
  );
}

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
