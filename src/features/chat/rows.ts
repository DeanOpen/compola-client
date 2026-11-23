// Swift `ChatRow` / `RowCache`: day separators and the grouping of consecutive messages into runs.

import { isStandalone, type ChatMessage } from '../../engine/models/chat';
import { dayKey } from './format';

export type ChatRow =
  | { kind: 'day'; id: string; date: number }
  | { kind: 'message'; id: string; message: ChatMessage; first: boolean; last: boolean; status: boolean; album?: ChatMessage[] };

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
  /** Photos of one send (same sender, within a minute, no caption / quote): one mosaic row (Zalo PC album). */
  const bare = (m: ChatMessage) => m.kind.type === 'photo' && !m.quote && (!m.text || m.text.startsWith('['));
  const sameSend = (i: number, j: number) => bare(msgs[i]) && bare(msgs[j]) && grouped(i, j) && Math.abs(msgs[j].date - msgs[i].date) < 60_000;
  const out: ChatRow[] = [];
  for (let i = 0; i < msgs.length; i += 1) {
    const m = msgs[i];
    if (i === 0 || days[i - 1] !== days[i]) out.push({ kind: 'day', id: dayPrefix + m.id, date: m.date });
    let end = i;
    while (end + 1 < msgs.length && sameSend(end, end + 1)) end += 1;
    const album = end > i ? msgs.slice(i, end + 1) : undefined;
    out.push({
      kind: 'message',
      id: m.id,
      message: m,
      first: i === 0 || !grouped(i - 1, i),
      last: end === msgs.length - 1 || !grouped(end, end + 1),
      status: album ? album.some((x) => x.id === lastMineId) : m.id === lastMineId,
      album,
    });
    i = end;
  }
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
