// Overlays of the contacts feature: the "Thêm bạn" dialog, a friend's "Thông tin tài khoản" and the "Tạo nhóm" sheet
// (⇧⌘N, Swift `ShellModel.groupCompose` + Commands "Tạo nhóm…").

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { usesMock } from '../../engine/backend';
import { onAccountReset, useEngine } from '../../engine/store';
import { escapeStackDepth } from '../../ui/escape';
import { AddFriendDialog } from './AddFriendDialog';
import { MyProfileDialog, PersonProfileDialog } from './ProfileCard';
import { CreateGroupSheet } from './CreateGroupSheet';
import { StrangerRequestBar } from './StrangerRequestBar';
import { contactsUi, useContactsUi, type ProfileHint } from './contactsUi';

onAccountReset(contactsUi.reset);

/** Shows the "Tạo nhóm" sheet; `preselected`: friends already picked (e.g. the 1:1 inspector's "Tạo nhóm"). */
export const openCreateGroup = (preselected: string[] = []) => contactsUi.composeGroup(preselected);

/** Shows the "Thêm bạn" dialog (list column / rail "Thêm bạn" buttons). */
export const openAddFriend = () => contactsUi.openAddFriend();

/** Shows a person's "Thông tin tài khoản" (friend or not); my own id opens "Hồ sơ của bạn". `hint`: the name / avatar the
 * caller already shows (message sender, group member), so the dialog has something to show while the profile loads. */
export const openContactProfile = (id: string, hint: ProfileHint | null = null) => {
  if (!id) return;
  if (id === useEngine.getState().profile?.userId) contactsUi.showMyProfile();
  else contactsUi.showProfile(id, hint);
};

/** Shows "Hồ sơ của bạn": the signed-in account's card (rail account menu). */
export const openMyProfile = () => contactsUi.showMyProfile();

export function ContactsHosts() {
  const compose = useContactsUi((s) => s.groupCompose);
  const addFriend = useContactsUi((s) => s.addFriendOpen);
  const profileId = useContactsUi((s) => s.profileId);
  const profileHint = useContactsUi((s) => s.profileHint);
  const myProfile = useContactsUi((s) => s.myProfileOpen);

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
      {profileId && <PersonProfileDialog key={profileId} id={profileId} hint={profileHint} onClose={contactsUi.closeProfile} />}
      {myProfile && <MyProfileDialog onClose={contactsUi.closeMyProfile} />}
      {compose && <CreateGroupSheet key={compose.id} request={compose} onClose={contactsUi.closeGroupCompose} />}
      {strangerDemo && <StrangerBarDemo />}
    </>
  );
}

// Mock-only preview of the stranger request bar (`?mock=1&demo=stranger`): placed above the open chat's composer until the
// chat view renders it itself.
const strangerDemo = usesMock && typeof location !== 'undefined' && new URLSearchParams(location.search).get('demo') === 'stranger';

function StrangerBarDemo() {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const t = setInterval(() => {
      const bottom = document.querySelector('.chat-bottom');
      if (!bottom || bottom.querySelector('.ct-stranger-slot')) return;
      const el = document.createElement('div');
      el.className = 'ct-stranger-slot';
      bottom.insertBefore(el, bottom.firstChild);
      setSlot(el);
    }, 200);
    return () => clearInterval(t);
  }, []);
  return slot ? createPortal(<StrangerRequestBar conversationId="u-stranger2" name="Nguyễn Văn Khoa" />, slot) : null;
}
