// Mock of the message index (`automation_search*`, Rust src-tauri/src/automation/search.rs): an accent-insensitive
// keyword search over what the mock has shown — every conversation's latest message and the loaded chat histories —
// so the list column's "Tin nhắn" results and "Tìm kiếm tin nhắn" work in the browser. No semantic search here.

import type { MirrorMessage } from '../../automation';
import type { SearchHit } from '../../search';
import { getEngine } from '../../store';
import { registerMockCommand } from '../registry';

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();

const indexed = (): MirrorMessage[] => {
  const s = getEngine();
  const out = new Map<string, MirrorMessage>();
  for (const c of s.conversations) {
    const loaded = s.messages[c.id] ?? [];
    for (const m of loaded) {
      if (!m.text.trim()) continue;
      out.set(m.id, { id: m.id, conversationId: c.id, conversationName: c.name, isGroup: c.isGroup, senderName: m.senderName, fromMe: m.isMine, text: m.text, date: m.date, source: 'chat' });
    }
    const p = c.preview;
    if (p?.text && p.date && !loaded.some((m) => Math.abs(m.date - p.date!) < 3000)) {
      const id = `preview:${c.id}:${p.date}`;
      out.set(id, { id, conversationId: c.id, conversationName: c.name, isGroup: c.isGroup, senderName: '', fromMe: p.fromMe, text: p.text, date: p.date, source: 'preview' });
    }
  }
  return [...out.values()];
};

registerMockCommand('automation_search', (args) => {
  const words = fold(String(args.query ?? '')).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const conversationId = (args.conversationId as string | null) ?? null;
  const limit = Number(args.limit ?? 30);
  if (!words.length) throw new Error('nhập nội dung cần tìm');
  const pool = indexed().filter((m) => !conversationId || m.conversationId === conversationId);
  const match = (all: boolean) =>
    pool.filter((m) => {
      const t = fold(m.text);
      return all ? words.every((w) => t.includes(w)) : words.some((w) => t.includes(w));
    });
  const found = match(true).length ? match(true) : match(false);
  const hits: SearchHit[] = found
    .sort((a, b) => b.date - a.date)
    .slice(0, limit)
    .map((m, i) => ({ ...m, score: 1 / (61 + i), matched: 'keyword' }));
  return { mode: 'keyword', hits, semanticError: null };
});
