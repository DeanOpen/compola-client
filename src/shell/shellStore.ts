// Window-level UI state (Swift `ShellModel` + `SidebarDestination`): what the user is looking at. Conversation data
// stays in the engine store.

import { create } from 'zustand';
import { defaultTab, TypeFilter, type ConversationExtras } from '../engine/models/conversations';

/**
 * What the sidebar picked; decides the content column and the detail column.
 * `label:<id>` is a "Phân loại" label filtering the inbox (the sidebar keeps highlighting "Tin nhắn").
 */
export type Destination =
  | 'inbox'
  | 'other'
  | 'unread'
  | 'strangers'
  | 'hidden'
  | 'myCloud'
  | 'zcloud'
  | 'friends'
  | 'groups'
  | 'requests'
  | 'addFriend'
  | 'groupInvites'
  | `label:${string}`
  /** An add-on's `tab` view: `addon:<addonId>:<viewId>`. */
  | `addon:${string}`;

export const isAddonTab = (d: Destination): d is `addon:${string}` => d.startsWith('addon:');
/** `[addonId, viewId]` of an add-on tab. */
export const addonTabOf = (d: Destination): [string, string] | null => {
  if (!isAddonTab(d)) return null;
  const [, addonId, ...rest] = d.split(':');
  return addonId && rest.length ? [addonId, rest.join(':')] : null;
};

export const isLabel = (d: Destination): d is `label:${string}` => d.startsWith('label:');
export const labelIdOf = (d: Destination): string | null => (isLabel(d) ? d.slice(6) : null);

/** Destinations whose content column is a conversation list and whose detail is a chat. */
export const isConversationList = (d: Destination) =>
  d === 'inbox' || d === 'other' || d === 'unread' || d === 'strangers' || d === 'hidden' || d === 'myCloud' || isLabel(d);

export const isContacts = (d: Destination) =>
  d === 'friends' || d === 'groups' || d === 'requests' || d === 'addFriend' || d === 'groupInvites';

/** The sidebar row this destination belongs to: a label filter is a view of the inbox. */
export const sidebarRow = (d: Destination): Destination => (isLabel(d) ? 'inbox' : d);

/** The official ConvListController filter this destination shows, null when it is not a controller list. */
export const officialFilter = (d: Destination, extras: ConversationExtras): { tab: TypeFilter; labelIds: string[] } | null => {
  const tab = defaultTab(extras);
  if (d === 'inbox' || d === 'myCloud') return { tab, labelIds: [] };
  if (d === 'other') return { tab: TypeFilter.other, labelIds: [] };
  if (d === 'unread') return { tab: TypeFilter.unread, labelIds: [] };
  const label = labelIdOf(d);
  if (label) return { tab, labelIds: [label] };
  return null;
};

export interface ShellState {
  destination: Destination;
  /** The conversation shown in the detail column. */
  selection: string | null;
  sidebarVisible: boolean;
  /** Conversation info inspector (⌥⌘I). */
  showInspector: boolean;
  /** ⌘K palette. */
  showQuickSwitcher: boolean;
  /** Search text of the conversation list column. */
  search: string;
  /** Conversation the search is limited to ("Tìm kiếm tin nhắn" in the chat header), null to search everything. */
  searchScope: string | null;
  /** Hidden chats listed after the PIN was entered; null while locked (hidden chats: later wave). */
  unlockedHiddenIds: string[] | null;
  /** Ticks: a view observing one performs the action when it changes. */
  searchFocusTick: number;
  replyTick: number;
}

export const useShell = create<ShellState>()(() => ({
  destination: 'inbox',
  selection: null,
  sidebarVisible: true,
  showInspector: false,
  showQuickSwitcher: false,
  search: '',
  searchScope: null,
  unlockedHiddenIds: null,
  searchFocusTick: 0,
  replyTick: 0,
}));

const set = useShell.setState;
const get = useShell.getState;

export const shell = {
  setDestination: (destination: Destination) => {
    set({ destination });
    // Leaving the conversation lists hides the inspector (the chat itself stays open in the official client).
    if (!isConversationList(destination)) set({ showInspector: false });
  },
  select: (selection: string | null) => set({ selection }),
  setSearch: (search: string) => set({ search }),
  /** Leaves the search: its text and its conversation scope. */
  clearSearch: () => set({ search: '', searchScope: null }),
  /** Searches the messages of one conversation from the list column's search field. */
  searchInConversation: (id: string) => set((s) => ({ searchScope: id, search: s.searchScope === id ? s.search : '', searchFocusTick: s.searchFocusTick + 1 })),
  clearSearchScope: () => set({ searchScope: null }),
  focusSearch: () => set((s) => ({ searchFocusTick: s.searchFocusTick + 1 })),
  replyToLatest: () => set((s) => ({ replyTick: s.replyTick + 1 })),
  toggleQuickSwitcher: () => set((s) => ({ showQuickSwitcher: !s.showQuickSwitcher })),
  closeQuickSwitcher: () => set({ showQuickSwitcher: false }),
  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
  toggleInspector: () => {
    const s = get();
    if (s.showInspector) return set({ showInspector: false });
    if (isConversationList(s.destination) && s.selection) set({ showInspector: true });
  },
  hideInspector: () => set({ showInspector: false }),

  /** Shows a conversation: keeps the current list when it is a conversation list, otherwise goes to the inbox. */
  open: (id: string) => {
    const s = get();
    if (!isConversationList(s.destination) || s.destination === 'hidden') shell.setDestination('inbox');
    set({ search: '', searchScope: null, selection: id });
  },

  /** Back to a fresh window: nothing of the previous account's window may carry over. */
  reset: () =>
    set({
      destination: 'inbox',
      selection: null,
      showInspector: false,
      showQuickSwitcher: false,
      search: '',
      searchScope: null,
      unlockedHiddenIds: null,
    }),
};
