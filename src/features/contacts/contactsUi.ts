// Window-level state of the Danh bạ screens (Swift `ShellModel.groupCompose` + the add-friend / profile dialogs of Zalo PC).

import { create } from 'zustand';

export interface GroupComposeRequest {
  id: number;
  members: string[];
}

export type FriendSort = 'az' | 'za';

interface ContactsUi {
  groupCompose: GroupComposeRequest | null;
  /** "Thêm bạn" dialog. */
  addFriendOpen: boolean;
  /** "Thông tin tài khoản" dialog of a friend. */
  profileId: string | null;
  /** "Hồ sơ của bạn" (the signed-in account). */
  myProfileOpen: boolean;
  friendSort: FriendSort;
  /** Label id the friend list is filtered by ("Phân loại"), null = Tất cả. */
  friendLabel: string | null;
}

export const useContactsUi = create<ContactsUi>()(() => ({
  groupCompose: null,
  addFriendOpen: false,
  profileId: null,
  myProfileOpen: false,
  friendSort: 'az',
  friendLabel: null,
}));

const set = useContactsUi.setState;
let seq = 0;

export const contactsUi = {
  /** Shows the "Tạo nhóm" sheet with the people already picked. */
  composeGroup: (members: string[] = []) => {
    if (useContactsUi.getState().groupCompose) return;
    seq += 1;
    set({ groupCompose: { id: seq, members } });
  },
  closeGroupCompose: () => set({ groupCompose: null }),
  openAddFriend: () => set({ addFriendOpen: true }),
  closeAddFriend: () => set({ addFriendOpen: false }),
  showProfile: (id: string) => set({ profileId: id }),
  closeProfile: () => set({ profileId: null }),
  showMyProfile: () => set({ myProfileOpen: true }),
  closeMyProfile: () => set({ myProfileOpen: false }),
  setFriendSort: (friendSort: FriendSort) => set({ friendSort }),
  setFriendLabel: (friendLabel: string | null) => set({ friendLabel }),
  reset: () => set({ groupCompose: null, addFriendOpen: false, profileId: null, myProfileOpen: false, friendLabel: null }),
};
