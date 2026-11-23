// Which poll sheet is on screen (Swift: the `.sheet(item:)` of PollMessageView / CardActionCenter / the composer).
// Rendered once by the card hosts (features/cardSheets/hosts.tsx).

import { create } from 'zustand';
import { useEngine } from '../../engine/store';

export interface PollSheetRequest {
  seq: number;
  pollId: string;
  conversationId: string;
  question: string;
  startOnVoters: boolean;
}

interface PollSheetState {
  detail: PollSheetRequest | null;
  /** "Tạo bình chọn" for this conversation. */
  create: { seq: number; conversationId: string } | null;
}

export const usePollSheets = create<PollSheetState>()(() => ({ detail: null, create: null }));

let seq = 0;

export const openPollSheet = (pollId: string, conversationId: string, question = '', startOnVoters = false) => {
  seq += 1;
  usePollSheets.setState({ detail: { seq, pollId, conversationId, question, startOnVoters } });
};

export const closePollSheet = () => usePollSheets.setState({ detail: null });

/** "Tạo bình chọn" (composer "+" menu / inspector of a group). */
export const openCreatePoll = (conversationId: string) => {
  seq += 1;
  usePollSheets.setState({ create: { seq, conversationId } });
};

export const closeCreatePoll = () => usePollSheets.setState({ create: null });

// A poll sheet belongs to the conversation it was opened from.
useEngine.subscribe((s, prev) => {
  if (s.openConversationId === prev.openConversationId) return;
  const { detail, create: c } = usePollSheets.getState();
  if ((detail && detail.conversationId !== s.openConversationId) || (c && c.conversationId !== s.openConversationId)) {
    usePollSheets.setState({
      detail: detail && detail.conversationId === s.openConversationId ? detail : null,
      create: c && c.conversationId === s.openConversationId ? c : null,
    });
  }
});
