// Placeholder: the live poll card (Swift PollViews.swift), filled in by the poll port.

import type { ChatMessage, PollInfo } from '../../engine/models/chat';
import { PollCard } from '../chat/cards/Cards';

export function LivePollCard({ poll }: { poll: PollInfo; message: ChatMessage }) {
  return <PollCard poll={poll} />;
}
