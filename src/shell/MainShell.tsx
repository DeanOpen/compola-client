// Signed-in window (Swift `MainShellView`): Mail / Messages-style columns. The sidebar picks a destination, the
// content column lists it and the detail column shows the chat; the inspector slides in on the right.

import { BookUser, HardDrive, MessagesSquare } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { closeConversation, openConversation } from '../engine/chat';
import { setConversationFilter } from '../engine/conversations';
import { getEngine, setEngine, useEngine } from '../engine/store';
import { ChatDetail } from '../features/chat/ChatDetail';
import { ChatInspectorColumn } from '../features/inspector/ChatInspector';
import { ConversationListColumn } from '../features/conversations/ConversationListColumn';
import { QuickSwitcher } from '../features/quickSwitcher/QuickSwitcher';
import { MediaViewerHost } from '../features/chat/MediaViewer';
import { ContentUnavailable } from '../ui/ContentUnavailable';
import { ComposerPrompts } from '../features/chat/ComposerPrompts';
import { ToastView } from '../ui/Toast';
import { useShellShortcuts } from './keyboard';
import { Sidebar } from './Sidebar';
import { isConversationList, labelIdOf, officialFilter, shell, useShell, type Destination } from './shellStore';
import './shell.css';

export function MainShell() {
  const { destination, selection, sidebarVisible, showInspector } = useShell(
    useShallow((s) => ({ destination: s.destination, selection: s.selection, sidebarVisible: s.sidebarVisible, showInspector: s.showInspector })),
  );
  const extrasLoaded = useEngine((s) => s.extras.loaded);
  const labelIds = useEngine(useShallow((s) => s.extras.labels.map((l) => l.id)));
  const navigationRequest = useEngine((s) => s.navigationRequest);
  const width = useWindowWidth();
  // The sidebar collapses to its icon rail on narrow windows, and when the inspector needs the room.
  const rail = !sidebarVisible || width < railBelow || (showInspector && width < railBelowWithInspector);
  const [listWidth, setListWidth] = useListWidth();

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
    <div className={`shell ${rail ? 'is-rail' : ''} ${showInspector ? 'has-inspector' : ''}`}>
      <div className="shell-backdrop" aria-hidden />
      <Sidebar rail={rail} />
      <section className="panel shell-content" style={{ width: listWidth }}>
        <ContentColumn destination={destination} />
      </section>
      <ResizeHandle width={listWidth} onChange={setListWidth} />
      <section className="panel shell-detail">
        <DetailColumn destination={destination} selection={selection} />
        <ToastView conversationId={null} bottom={24} />
      </section>
      {showInspector && isConversationList(destination) && (
        <aside className="panel shell-inspector slide-in-right">
          <ChatInspectorColumn conversationId={selection} />
        </aside>
      )}
      <QuickSwitcher />
      <MediaViewerHost />
      <ComposerPrompts />
    </div>
  );
}

/** Below these window widths the sidebar collapses to its 64px icon rail. */
const railBelow = 1080;
const railBelowWithInspector = 1340;

const useWindowWidth = () => {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
};

const listWidthKey = 'compola.listWidth';
const minList = 280;
const maxList = 420;

/** The conversation list's width (resizable, remembered). */
const useListWidth = (): [number, (w: number) => void] => {
  const [width, setWidth] = useState(() => {
    try {
      const v = Number(localStorage.getItem(listWidthKey));
      return v >= minList && v <= maxList ? v : 320;
    } catch {
      return 320;
    }
  });
  const set = (w: number) => {
    const clamped = Math.round(Math.min(maxList, Math.max(minList, w)));
    setWidth(clamped);
    try {
      localStorage.setItem(listWidthKey, String(clamped));
    } catch {
      /* private mode */
    }
  };
  return [width, set];
};

/** The 8px gap between the list and the chat doubles as the list's resize handle. */
function ResizeHandle({ width, onChange }: { width: number; onChange: (w: number) => void }) {
  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = width;
    const move = (ev: PointerEvent) => onChange(w0 + ev.clientX - x0);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('is-resizing');
    };
    document.body.classList.add('is-resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div
      className="resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Đổi độ rộng danh sách"
      aria-valuenow={width}
      onPointerDown={start}
      onDoubleClick={() => onChange(320)}
    />
  );
}

/** Middle column: the list for the sidebar destination. */
function ContentColumn({ destination }: { destination: Destination }) {
  if (isConversationList(destination)) return <ConversationListColumn />;
  const title = destination === 'zcloud' ? 'zCloud' : 'Danh bạ';
  return (
    <div className="column">
      <ColumnToolbar title={title} />
      <ContentUnavailable
        icon={destination === 'zcloud' ? HardDrive : BookUser}
        title={title}
        description="Mục này sẽ có trong bản cập nhật tới."
      />
    </div>
  );
}

/** Right column: the chat (contact cards and zCloud screens arrive with their features). */
function DetailColumn({ destination, selection }: { destination: Destination; selection: string | null }) {
  if (isConversationList(destination)) return <ChatDetail conversationId={selection} />;
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
