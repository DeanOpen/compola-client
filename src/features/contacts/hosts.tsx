// Overlays of the contacts feature: the "Thêm bạn" dialog, a friend's "Thông tin tài khoản" and the "Tạo nhóm" sheet
// (⇧⌘N, Swift `ShellModel.groupCompose` + Commands "Tạo nhóm…").

import { useEffect } from 'react';
import { onAccountReset } from '../../engine/store';
import { escapeStackDepth } from '../../ui/escape';
import { AddFriendDialog } from './AddFriendDialog';
import { FriendProfileDialog } from './ContactsView';
import { CreateGroupSheet } from './CreateGroupSheet';
import { contactsUi, useContactsUi } from './contactsUi';

onAccountReset(contactsUi.reset);

/** Shows the "Tạo nhóm" sheet; `preselected`: friends already picked (e.g. the 1:1 inspector's "Tạo nhóm"). */
export const openCreateGroup = (preselected: string[] = []) => contactsUi.composeGroup(preselected);

/** Shows the "Thêm bạn" dialog (list column / rail "Thêm bạn" buttons). */
export const openAddFriend = () => contactsUi.openAddFriend();

/** Shows a friend's "Thông tin tài khoản" dialog. */
export const openContactProfile = (id: string) => contactsUi.showProfile(id);

export function ContactsHosts() {
  const compose = useContactsUi((s) => s.groupCompose);
  const addFriend = useContactsUi((s) => s.addFriendOpen);
  const profileId = useContactsUi((s) => s.profileId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'n' || !e.metaKey || !e.shiftKey || e.altKey || e.ctrlKey || e.isComposing) return;
      if (escapeStackDepth() > 0) return;
      e.preventDefault();
      contactsUi.composeGroup();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      {addFriend && <AddFriendDialog onClose={contactsUi.closeAddFriend} />}
      {profileId && <FriendProfileDialog key={profileId} id={profileId} onClose={contactsUi.closeProfile} />}
      {compose && <CreateGroupSheet key={compose.id} request={compose} onClose={contactsUi.closeGroupCompose} />}
    </>
  );
}
