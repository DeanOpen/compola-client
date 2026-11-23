// Presents what card buttons open (Swift `CardActionPresenter`): alias / group invite / sticker category / poll sheets,
// the side-bar tab routing (`SectionRouter`), and the poll sheets opened from poll cards or "Tạo bình chọn".

import { useEffect } from 'react';
import { dismissCardSheet, useCardSheets } from '../../engine/cardSheets';
import { shell } from '../../shell/shellStore';
import { PollCreateSheet } from '../poll/PollCreateSheet';
import { PollDetailSheet } from '../poll/PollDetailSheet';
import { closeCreatePoll, closePollSheet, usePollSheets } from '../poll/pollSheets';
import { AliasSheet, GroupInviteSheet, StickerCategorySheet } from './CardSheets';

export { openCreatePoll } from '../poll/pollSheets';

export function CardHosts() {
  const presented = useCardSheets((s) => s.sheet);
  const tabRequest = useCardSheets((s) => s.tabRequest);
  const pollSheet = usePollSheets((s) => s.detail);
  const pollCreate = usePollSheets((s) => s.create);

  // Side-bar actions (`action.open.tab.chat`, `.tab.contact`, `.grouplist`).
  useEffect(() => {
    if (!tabRequest) return;
    shell.setDestination(tabRequest.target === 'chats' ? 'inbox' : tabRequest.target === 'groups' ? 'groups' : 'friends');
    useCardSheets.setState({ tabRequest: null });
  }, [tabRequest]);

  const close = () => dismissCardSheet(presented?.seq);
  let card = null;
  if (presented) {
    const { sheet, conversationId, seq } = presented;
    switch (sheet.type) {
      case 'alias':
        card = <AliasSheet key={seq} draft={sheet.draft} conversationId={conversationId} onClose={close} />;
        break;
      case 'groupInvite':
        card = <GroupInviteSheet key={seq} url={sheet.url} conversationId={conversationId} seq={seq} onClose={close} />;
        break;
      case 'stickers':
        card = <StickerCategorySheet key={seq} cateId={sheet.cateId} conversationId={conversationId} onClose={close} />;
        break;
      case 'poll':
        card = <PollDetailSheet key={seq} pollId={sheet.pollId} conversationId={conversationId} question="" onClose={close} />;
        break;
    }
  }

  return (
    <>
      {card}
      {pollSheet && (
        <PollDetailSheet
          key={`poll-${pollSheet.seq}`}
          pollId={pollSheet.pollId}
          conversationId={pollSheet.conversationId}
          question={pollSheet.question}
          startOnVoters={pollSheet.startOnVoters}
          onClose={closePollSheet}
        />
      )}
      {pollCreate && <PollCreateSheet key={`create-${pollCreate.seq}`} conversationId={pollCreate.conversationId} onClose={closeCreatePoll} />}
    </>
  );
}
