// Mock `window.__zaloPoll` (poll-adapter.js contract): the "Ăn trưa ở đâu hôm demo?" poll of the mock team group
// (message `pollId: 'p1'` in mockData), live votes, voters, pin board, lock / share / create.
// Dev aids: `&pollSheet=1` opens the vote sheet, `&pollVoters=1` its voter list, `&pollCreate=1` "Tạo bình chọn"
// (all on the open conversation, e.g. `&open=g-team`).

import type { Json } from '../../models/json';
import { groupMembers, ME, message } from '../mockData';
import { onMockBoot, registerMockAdapter, type MockContext } from '../registry';

interface MockPoll {
  detail: Json;
  /** option id → voter uids */
  votes: Record<string, string[]>;
  pinned: boolean;
}

const now = Date.now();
const people = groupMembers['g-team'];
const polls = new Map<string, MockPoll>();
const watched = new Set<string>();
let ctx: MockContext | null = null;
let optionSeq = 10;

polls.set('p1', {
  detail: {
    id: 'p1',
    groupId: 'g-team',
    question: 'Ăn trưa ở đâu hôm demo?',
    creator: 'u-tuan',
    creatorName: 'Đỗ Anh Tuấn',
    created: now - 50 * 60_000,
    expired: now + 2 * 86_400_000,
    closed: false,
    joined: false,
    multi: true,
    allowAdd: true,
    anonymous: false,
    hidePreview: false,
    canClose: true,
    options: [
      { id: 'o1', content: 'Phở Thìn Lò Đúc' },
      { id: 'o2', content: 'Cơm tấm Cali' },
      { id: 'o3', content: 'Bún chả Hương Liên' },
      { id: 'o4', content: 'Pizza 4P’s' },
    ],
  },
  votes: { o1: ['u-huy', 'u-mai', 'u-pm'], o2: ['u-tuan'], o3: ['u-qa', 'u-mai'], o4: [] },
  pinned: false,
});

// A card button's poll effect carries a numeric id (`demo:poll` in mock/features/cardSheets.ts).
polls.set('1', polls.get('p1')!);

const snapshot = (p: MockPoll): Json => {
  const options = (p.detail.options as Json[]).map((o) => {
    const uids = p.votes[String(o.id)] ?? [];
    return { id: o.id, content: o.content, votes: uids.length, voted: uids.includes(ME.userId) };
  });
  const voters = new Set(Object.values(p.votes).flat());
  return { ...p.detail, options, voters: voters.size, joined: voters.has(ME.userId) };
};

const publish = (id: string) => {
  const p = polls.get(id);
  if (p && ctx) ctx.post({ poll: { id, detail: snapshot(p) } });
};

const nameOf = (uid: string) => (uid === ME.userId ? ME.displayName : people.find((m) => m.id === uid)?.name ?? 'Người dùng Zalo');
const avatarOf = (uid: string) => people.find((m) => m.id === uid)?.avatar ?? '';

const postPollEvent = (convId: string, pollId: string, header: string, question: string) => {
  const m = message(convId, {
    from: ME.userId,
    kind: { type: 'poll', question, header, anonymous: false, pollId, conversationId: convId },
    text: `[Bình chọn] ${question}`,
    ago: 0,
  });
  ctx?.post({ chat: { convId, messages: [m], removed: [], hasMore: true, reset: false } });
};

const later = <T,>(ms: number, value: T) => new Promise<T>((r) => setTimeout(() => r(value), ms));

registerMockAdapter('__zaloPoll', {
  watch: (id: string) => {
    watched.add(id);
    setTimeout(() => (polls.has(id) ? publish(id) : ctx?.post({ poll: { id, error: 'unavailable' } })), 400);
  },
  refresh: (id: string) => publish(id),
  reset: () => watched.clear(),
  voters: async (id: string) => {
    const p = polls.get(id);
    if (!p) return null;
    if (p.detail.anonymous) return { restricted: true, groups: [] };
    return later(350, {
      restricted: false,
      groups: (p.detail.options as Json[])
        .map((o) => {
          const uids = p.votes[String(o.id)] ?? [];
          return {
            optionId: o.id,
            content: o.content,
            votes: uids.length,
            users: uids.map((uid) => ({ uid, name: nameOf(uid), avatar: avatarOf(uid), isMe: uid === ME.userId })),
          };
        })
        .filter((g) => g.votes > 0),
    });
  },
  capabilities: (convId: string) => ({
    ready: convId.startsWith('g'),
    canCreate: convId.startsWith('g'),
    canPin: true,
    config: { minOptions: 2, maxOptions: 30, maxQuestion: 200, maxOption: 120, enableAnonymous: true, enableHidePreview: true, displayOptions: 3 },
  }),
  vote: async (_convId: string, id: string, newOptions: Json[], votedIds: string[]) => {
    const p = polls.get(id);
    if (!p) return { ok: false, error: 'unavailable' };
    if (p.detail.closed) return { ok: false, error: 'closed' };
    for (const o of p.detail.options as Json[]) {
      const oid = String(o.id);
      const keep = (p.votes[oid] ?? []).filter((u) => u !== ME.userId);
      p.votes[oid] = votedIds.includes(oid) ? [...keep, ME.userId] : keep;
    }
    for (const added of newOptions) {
      optionSeq += 1;
      const oid = `o${optionSeq}`;
      (p.detail.options as Json[]).push({ id: oid, content: added.content });
      p.votes[oid] = added.voted ? [ME.userId] : [];
    }
    await later(500, null);
    publish(id);
    return { ok: true };
  },
  lock: async (_convId: string, id: string) => {
    const p = polls.get(id);
    if (!p) return { ok: false, error: 'unavailable' };
    p.detail.closed = true;
    await later(400, null);
    publish(id);
    return { ok: true };
  },
  share: async (convId: string, id: string) => {
    const p = polls.get(id);
    if (!p) return { ok: false, error: 'unavailable' };
    await later(400, null);
    postPollEvent(convId, id, 'Bạn đã chia sẻ bình chọn', String(p.detail.question));
    return { ok: true };
  },
  create: async (convId: string, spec: Json) => {
    await later(600, null);
    optionSeq += 1;
    const id = `p${100 + optionSeq}`;
    const options = (spec.options as string[]).map((content, i) => ({ id: `${id}-o${i}`, content }));
    polls.set(id, {
      detail: {
        id,
        groupId: convId,
        question: spec.question,
        creator: ME.userId,
        creatorName: ME.displayName,
        created: Date.now(),
        expired: spec.expired,
        closed: false,
        multi: spec.multi,
        allowAdd: spec.allowAdd,
        anonymous: spec.anonymous,
        hidePreview: spec.hidePreview,
        canClose: true,
        options,
      },
      votes: Object.fromEntries(options.map((o) => [o.id, []])),
      pinned: !!spec.pin,
    });
    postPollEvent(convId, id, 'Bạn đã tạo bình chọn', String(spec.question));
    return { ok: true };
  },
  pinState: (_convId: string, id: string) => ({ ready: true, canPin: true, pinned: polls.get(id)?.pinned ?? false, limit: 3 }),
  pin: async (_convId: string, id: string, confirmRef: string | null) => {
    const p = polls.get(id);
    if (!p) return { ok: false, error: 'unavailable' };
    // The mock board is full: the first call asks to replace the oldest pin.
    if (!confirmRef) return { ok: false, error: 'confirm', limit: 3, ref: 'topic-1', replace: { kind: 'message', title: 'Lịch demo thứ Sáu' } };
    await later(400, null);
    p.pinned = true;
    return { ok: true };
  },
  unpin: async (_convId: string, id: string) => {
    const p = polls.get(id);
    if (!p) return { ok: false, error: 'unavailable' };
    await later(300, null);
    p.pinned = false;
    return { ok: true };
  },
});

onMockBoot((c) => {
  ctx = c;
  // Someone else votes a bit later: the open card and sheet update live.
  setTimeout(() => {
    const p = polls.get('p1');
    if (!p || !watched.has('p1')) return;
    p.votes.o2 = [...p.votes.o2, 'u-bao'];
    publish('p1');
  }, 20_000);
  const wantsSheet = c.params.has('pollSheet') || c.params.has('pollVoters');
  const wantsCreate = c.params.has('pollCreate');
  if (!wantsSheet && !wantsCreate) return;
  setTimeout(() => {
    void Promise.all([import('../../store'), import('../../../features/poll/pollSheets')]).then(([store, sheets]) => {
      const convId = store.getEngine().openConversationId ?? 'g-team';
      if (wantsCreate) sheets.openCreatePoll(convId);
      else sheets.openPollSheet('p1', convId, 'Ăn trưa ở đâu hôm demo?', c.params.has('pollVoters'));
    });
  }, 1400);
});
