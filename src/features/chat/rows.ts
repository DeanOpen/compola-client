// Swift `ChatRow` / `RowCache`: day separators and the grouping of consecutive messages into runs.

import { isStandalone, type ChatMessage } from '../../engine/models/chat';
import { dayKey } from './format';

export type ChatRow =
  | { kind: 'day'; id: string; date: number }
  | { kind: 'message'; id: string; message: ChatMessage; first: boolean; last: boolean; status: boolean };

export const dayPrefix = 'day-';

export const buildRows = (msgs: ChatMessage[]): ChatRow[] => {
  const days = msgs.map((m) => dayKey(m.date));
  // Notices / e-cards are not bubbles: they never carry the status line and do not take part in grouping.
  let lastMineId: string | null = null;
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (msgs[i].isMine && !isStandalone(msgs[i].kind)) {
      lastMineId = msgs[i].id;
      break;
    }
  }
  const grouped = (i: number, j: number) => {
    const a = msgs[i];
    const b = msgs[j];
    if (isStandalone(a.kind) || isStandalone(b.kind)) return false;
    return a.senderId === b.senderId && a.isMine === b.isMine && Math.abs(b.date - a.date) < 300_000 && days[i] === days[j];
  };
  const out: ChatRow[] = [];
  msgs.forEach((m, i) => {
    if (i === 0 || days[i - 1] !== days[i]) out.push({ kind: 'day', id: dayPrefix + m.id, date: m.date });
    out.push({
      kind: 'message',
      id: m.id,
      message: m,
      first: i === 0 || !grouped(i - 1, i),
      last: i === msgs.length - 1 || !grouped(i, i + 1),
      status: m.id === lastMineId,
    });
  });
  return out;
};

export type MessageChatRow = Extract<ChatRow, { kind: 'message' }>;

/** The rows as day sections: the separator and that day's messages. */
export const groupByDay = (rows: ChatRow[]): { id: string; date: number; rows: MessageChatRow[] }[] => {
  const out: { id: string; date: number; rows: MessageChatRow[] }[] = [];
  for (const row of rows) {
    if (row.kind === 'day') out.push({ id: row.id, date: row.date, rows: [] });
    else out[out.length - 1]?.rows.push(row);
  }
  return out;
};
