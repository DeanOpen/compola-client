// In-browser stand-in for the Rust engine + the official renderer's adapters. It answers the same commands
// (`engine_*`, `engine_call`) and emits the same events with fabricated snapshots, so every screen can be
// developed in a plain browser. Scenario: `?mock=1&phase=ready|login|preparing|failed|signingIn|starting`.

import type { Backend, EngineEvent } from '../backend';
import type { Json } from '../models/json';
import type { LoginState, Phase } from '../models/phase';
import {
  conversations,
  fakeQr,
  groupMembers,
  historyFor,
  labels,
  ME,
  message,
  olderPage,
  SELF_CONV,
  type MockConversation,
} from './mockData';

import { mockAdapters, mockCommands, mockPass, runMockBootHooks, setMockAccountBoot, setMockContext } from './registry';

// Feature mocks of the later waves register themselves (mock/registry.ts).
import.meta.glob('./features/*.ts', { eager: true });

type Handler = (payload: unknown) => void;

export const createMockBackend = (): Backend => {
  const listeners = new Map<EngineEvent, Set<Handler>>();
  const emit = (event: EngineEvent, payload: unknown) =>
    setTimeout(() => listeners.get(event)?.forEach((h) => h(structuredClone(payload))), 0);
  const post = (state: Json) => emit('compola://state', { page: 'main', ...state });

  const params = new URLSearchParams(location.search);
  setMockContext({ post, emit, params });
  const scenario = params.get('phase') ?? 'ready';

  let phase: Phase = { kind: 'starting' };
  let qrSeed = 1;
  const setPhase = (p: Phase) => {
    phase = p;
    emit('compola://phase', p);
  };
  const login = (step: LoginState['step'], extra: Partial<LoginState> = {}): Phase => ({
    kind: 'login',
    login: { step, qr: step.kind === 'generating' ? null : fakeQr(qrSeed), isSecondQr: false, ...extra },
    notice: params.has('kicked')
      ? 'Tài khoản của bạn vừa đăng nhập trên một Zalo PC khác, nên phiên này đã bị đăng xuất. Zalo chỉ cho phép một phiên máy tính cho mỗi tài khoản.'
      : null,
  });

  // ---- account state ----
  const convs = new Map<string, MockConversation>(conversations.map((c) => [c.id, { ...c }]));
  const previews = new Map<string, { text: string; ts: number; fromMe: boolean }>();
  const messages = new Map<string, Json[]>();
  const olderPages = new Map<string, number>();
  const pins = new Map<string, Json[]>();
  let openId: string | null = null;
  let filter = { type: 0, labelIds: [] as string[] };
  const labelMap = new Map<string, string>(conversations.filter((c) => c.label).map((c) => [c.id, c.label!]));
  const deleted = new Map<string, { convId: string; msg: Json; index: number }>();

  const history = (id: string) => {
    let list = messages.get(id);
    if (!list) {
      const c = convs.get(id);
      list = c ? historyFor(c) : [];
      messages.set(id, list);
    }
    return list;
  };

  for (const c of convs.values()) {
    const list = history(c.id);
    const last = list[list.length - 1];
    if (last) previews.set(c.id, { text: String(last.text || ''), ts: Number(last.date), fromMe: !!last.isMine });
  }
  pins.set('g-team', []);
  pins.set('g-family', []);

  const row = (c: MockConversation) => ({
    id: c.id,
    isGroup: c.isGroup,
    name: c.name,
    avatar: c.avatar,
    pinned: c.pinned,
    members: c.members,
    unread: c.unread,
    preview: previews.get(c.id) ?? null,
  });

  const publishConversations = (changed: MockConversation[], reset = false) =>
    post({ conversations: changed.map(row), removed: [], reset });

  const strangers = () => [...convs.values()].filter((c) => c.stranger).map((c) => c.id);
  const sortedIds = () =>
    [...convs.values()]
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (previews.get(b.id)?.ts ?? 0) - (previews.get(a.id)?.ts ?? 0))
      .map((c) => c.id);

  let noticeSeq = 0;
  const publishExtras = (action?: { seq: number; ok: boolean; text: string }) => {
    const strangerSet = new Set(strangers());
    let ids = sortedIds().filter((id) => !strangerSet.has(id));
    if (filter.type === 1) ids = ids.filter((id) => (convs.get(id)?.unread ?? 0) > 0);
    if (filter.labelIds.length) ids = ids.filter((id) => filter.labelIds.includes(labelMap.get(id) ?? ''));
    if (filter.type === 0 && !filter.labelIds.length) ids.splice(3, 0, 'stranger_box');
    const folder = sortedIds().filter((id) => strangerSet.has(id));
    post({
      conversationExtras: {
        selfConversationId: SELF_CONV,
        labels: labels.map((l) => ({ ...l, convIds: [...labelMap].filter(([, v]) => v === l.id).map(([k]) => k) })),
        archivedEnabled: false,
        filter,
        listIds: ids,
        ...(action ? { action } : {}),
        strangerIds: [...strangerSet],
        strangerFolderIds: folder,
        strangerBox: {
          chats: folder.length,
          unreadChats: folder.filter((id) => (convs.get(id)?.unread ?? 0) > 0).length,
          unreadMessages: folder.reduce((n, id) => n + (convs.get(id)?.unread ?? 0), 0),
          newestId: folder[0] ?? '',
        },
      },
    });
  };

  const publishChat = (id: string, reset: boolean, changed: Json[] = [], removed: string[] = []) => {
    const list = history(id);
    const hasMore = (olderPages.get(id) ?? 0) < 2;
    post({ chat: reset ? { convId: id, messages: list, removed: [], hasMore, reset: true } : { convId: id, messages: changed, removed, hasMore, reset: false } });
  };

  const touch = (id: string, m: Json) => {
    previews.set(id, { text: String(m.text || ''), ts: Number(m.date), fromMe: !!m.isMine });
    const c = convs.get(id);
    if (c) publishConversations([c]);
    publishExtras();
  };

  const updateMessage = (convId: string, msgId: string, change: (m: Json) => void) => {
    const m = history(convId).find((x) => x.id === msgId);
    if (!m) return null;
    change(m);
    publishChat(convId, false, [m]);
    return m;
  };

  // Multi-account mock (features/accounts.ts): the same mock data seen by another account — its profile and a subset
  // of the conversations.
  setMockAccountBoot((user, ids) => {
    setPhase({ kind: 'ready' });
    emit('compola://state', { page: 'main', user });
    const pick = ids ? [...convs.values()].filter((c) => ids.includes(c.id)) : [...convs.values()];
    publishConversations(pick, true);
    publishExtras();
    publishConvActions();
    runMockBootHooks();
  });

  const boot = () => {
    emit('compola://state', { page: 'main', user: ME });
    publishConversations([...convs.values()], true);
    publishExtras();
    publishConvActions();
    runMockBootHooks();
  };

  // A stranger keeps writing every so often; Lan types first.
  const liveTraffic = () => {
    setInterval(() => {
      const c = convs.get('u-lan')!;
      post({ typing: { convId: c.id, name: c.name } });
      setTimeout(() => {
        const m = message(c.id, { from: c.id, name: c.name, avatar: c.avatar, text: pick(['Ê có đó không?', 'Mai đi ăn trưa nhé 🍜', 'Bạn xem tin nhắn mình gửi chưa?', 'Haha 😂']), ago: 0 });
        history(c.id).push(m);
        if (openId !== c.id) c.unread += 1;
        if (openId === c.id) publishChat(c.id, false, [m]);
        touch(c.id, m);
      }, 2500);
    }, 45_000);
  };

  // ---- adapters ----
  const chat: Record<string, (...a: any[]) => unknown> = {
    open: (id: string) => {
      openId = id;
      setTimeout(() => publishChat(id, true), 250);
      return 'ok';
    },
    close: () => {
      openId = null;
    },
    loadMore: (id: string) => {
      const page = olderPages.get(id) ?? 0;
      const c = convs.get(id);
      if (!c || page >= 2) return;
      const list = history(id);
      const older = olderPage(c, Number(list[0]?.date ?? Date.now()), page);
      olderPages.set(id, page + 1);
      setTimeout(() => {
        list.unshift(...older);
        publishChat(id, false, older);
      }, 700);
    },
    sendText: async (id: string, text: string, quoteId: string | null, mentions: Json[], styles?: Json[]) => {
      const list = history(id);
      const quoted = quoteId ? list.find((m) => m.id === quoteId) : null;
      const m = message(id, {
        from: ME.userId,
        text,
        ago: 0,
        status: 'sending',
        mentions,
        quote: quoted ? { senderName: quoted.isMine ? ME.displayName : quoted.senderName, text: quoted.text } : null,
        ...(styles?.length ? { kind: { type: 'text', styles } } : {}),
      });
      if (text.includes('#fail')) return 'error';
      list.push(m);
      publishChat(id, false, [m]);
      touch(id, m);
      setTimeout(() => updateMessage(id, String(m.id), (x) => (x.status = 'sent')), 600);
      setTimeout(() => updateMessage(id, String(m.id), (x) => (x.status = 'seen')), 2600);
      return 'sent';
    },
    markRead: (id: string) => {
      const c = convs.get(id);
      if (c && c.unread) {
        c.unread = 0;
        publishConversations([c]);
        publishExtras();
      }
    },
    react: (convId: string, msgId: string, emoji: string) => {
      updateMessage(convId, msgId, (m) => {
        const reactions = (m.reactions as Json[]) ?? [];
        const existing = reactions.find((r) => r.emoji === emoji);
        if (existing) {
          if (!existing.includesMe) {
            existing.count = Number(existing.count) + 1;
            existing.includesMe = true;
            existing.people = Number(existing.people) + 1;
            existing.names = ['Bạn', ...(existing.names as string[])].slice(0, 3);
          }
        } else reactions.push({ type: emoji, key: emoji, emoji, image: '', count: 1, includesMe: true, names: ['Bạn'], people: 1 });
        m.reactions = reactions;
      });
    },
    mentionCandidates: (convId: string, query: string, excluding: string[]) => {
      const q = query.toLowerCase();
      const members = (groupMembers[convId] ?? []).filter((m) => !excluding.includes(m.id) && m.name.toLowerCase().includes(q));
      const all = q === '' || 'all'.startsWith(q) || 'tất cả'.startsWith(q) ? [{ id: '-1', name: 'All', avatar: '', isAll: true }] : [];
      return [...all, ...members.map((m) => ({ ...m, isAll: false }))];
    },
    reactors: (convId: string, msgId: string) => {
      const m = history(convId).find((x) => x.id === msgId);
      if (!m) return null;
      const reactions = (m.reactions as Json[]) ?? [];
      const users = new Map<string, Json>();
      for (const r of reactions)
        for (const name of r.names as string[]) {
          const u = users.get(name) ?? { uid: name, name: name === 'Bạn' ? ME.displayName : name, avatar: '', isMe: name === 'Bạn', total: 0, icons: [] };
          (u.total as number) += 1;
          (u.icons as Json[]).push({ ...r, count: 1 });
          users.set(name, u);
        }
      return { tabs: reactions.map((r) => ({ ...r, total: r.count })), users: [...users.values()] };
    },
    resolveMedia: () => ({ state: 'unavailable' }),
    performAction: (_c: string, _m: string, ref: string) =>
      ref === 'call:back' ? { status: 'unsupported', text: 'Cuộc gọi chưa hỗ trợ trên ứng dụng này' } : { status: 'effect', effect: { type: 'openURL', url: 'https://zalo.me' } },
  };

  const msgActions: Record<string, (...a: any[]) => unknown> = {
    watchPins: (id: string | null) => {
      if (!id) return;
      const list = pins.get(id);
      if (list) post({ pins: { convId: id, ready: true, canPin: true, items: list } });
    },
    isProtected: () => false,
    forward: async (_c: string, msgId: string, targets: string[]) => {
      for (const t of targets) {
        const src = [...messages.values()].flat().find((m) => m.id === msgId);
        if (!src) continue;
        const m = message(t, { from: ME.userId, text: String(src.text), kind: src.kind as Json, ago: 0 });
        history(t).push(m);
        touch(t, m);
      }
      return { status: 'done', text: 'Đã chia sẻ tin nhắn' };
    },
    recall: (convId: string, msgId: string) => {
      updateMessage(convId, msgId, (m) => {
        m.kind = { type: 'recalled' };
        m.text = '';
        m.menu = { delete: 'forMe' };
      });
      return { status: 'done' };
    },
    deleteForMe: (convId: string, msgId: string, confirmed: boolean) => {
      if (!confirmed) return { status: 'confirm', title: 'Xóa tin nhắn', message: 'Tin nhắn này sẽ bị xóa ở phía bạn. Bạn có chắc chắn muốn xóa?', ok: 'Xóa', cancel: 'Hủy' };
      const list = history(convId);
      const index = list.findIndex((m) => m.id === msgId);
      if (index < 0) return { status: 'error' };
      const [msg] = list.splice(index, 1);
      const undoId = 'undo-' + msgId;
      deleted.set(undoId, { convId, msg, index });
      publishChat(convId, false, [], [msgId]);
      return { status: 'done', undo: { id: undoId, count: 1, ms: 8000 } };
    },
    undoDelete: (undoId: string) => {
      const d = deleted.get(undoId);
      if (!d) return { status: 'error' };
      deleted.delete(undoId);
      history(d.convId).splice(d.index, 0, d.msg);
      publishChat(d.convId, false, [d.msg]);
      return { status: 'done' };
    },
    commitDelete: (undoId: string) => deleted.delete(undoId),
    dropDelete: (undoId: string) => deleted.delete(undoId),
    star: (convId: string, msgId: string, on: boolean) => {
      updateMessage(convId, msgId, (m) => {
        m.menu = { ...(m.menu as Json), starred: on, star: on ? 'unstar' : 'star' };
      });
      return { status: 'done', text: on ? 'Đã đánh dấu tin nhắn' : 'Đã bỏ đánh dấu tin nhắn' };
    },
    pin: (convId: string, msgId: string) => {
      const list = pins.get(convId) ?? [];
      const m = history(convId).find((x) => x.id === msgId);
      if (!m) return { status: 'error' };
      list.unshift({ ref: 'pin-' + msgId, kind: 'message', title: m.text || '[Tin nhắn]', sender: m.isMine ? 'Bạn' : m.senderName, thumb: '', msgId, cliMsgId: '' });
      pins.set(convId, list);
      updateMessage(convId, msgId, (x) => (x.menu = { ...(x.menu as Json), pinned: true }));
      msgActions.watchPins(convId);
      return { status: 'done' };
    },
    unpin: (convId: string, ref: string) => {
      const list = (pins.get(convId) ?? []).filter((p) => p.ref !== ref);
      pins.set(convId, list);
      const msgId = ref.replace(/^pin-/, '');
      updateMessage(convId, msgId, (x) => (x.menu = { ...(x.menu as Json), pinned: false }));
      msgActions.watchPins(convId);
      return { status: 'done' };
    },
  };

  const conversationsAdapter: Record<string, (...a: any[]) => unknown> = {
    setFilter: (type: number, labelIds: string[]) => {
      filter = { type, labelIds };
      publishExtras();
    },
    createLabel: (name: string, color: string, convIds: string[] = []) => {
      const id = 'l-' + Date.now();
      labels.push({ id, name, color });
      for (const c of convIds) labelMap.set(c, id);
      noticeSeq += 1;
      publishExtras({ seq: noticeSeq, ok: true, text: '' });
    },
    updateLabel: (id: string, name: string, color: string) => {
      const l = labels.find((x) => x.id === id);
      if (l) Object.assign(l, { name, color });
      noticeSeq += 1;
      publishExtras({ seq: noticeSeq, ok: true, text: '' });
    },
    deleteLabel: (id: string) => {
      const i = labels.findIndex((x) => x.id === id);
      if (i >= 0) labels.splice(i, 1);
      for (const [k, v] of [...labelMap]) if (v === id) labelMap.delete(k);
      noticeSeq += 1;
      publishExtras({ seq: noticeSeq, ok: true, text: '' });
    },
    reorderLabels: (ids: string[]) => {
      labels.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
      noticeSeq += 1;
      publishExtras({ seq: noticeSeq, ok: true, text: '' });
    },
    setConvLabel: (convId: string, labelId: string | null) => {
      if (labelId) labelMap.set(convId, labelId);
      else labelMap.delete(convId);
      publishExtras();
    },
  };

  const compose: Record<string, (...a: any[]) => unknown> = {
    answer: () => ({ status: 'done' }),
  };

  // ---- conversation actions (pin / Khác / read / hide with PIN / delete), the adapter's flag bits ----
  const archived = new Set<string>();
  const hidden = new Set<string>();
  const unreadMarks = new Set<string>();
  let hiddenPin: string | null = null;
  const pinLimit = 5;
  const publishConvActions = () => {
    const flags: Record<string, number> = {};
    for (const c of convs.values()) {
      let b = 0;
      if (c.pinned) b |= 1;
      if (archived.has(c.id)) b |= 2;
      if (hidden.has(c.id)) b |= 4 | 8;
      if (c.stranger) b |= 8;
      if (c.id === SELF_CONV) b |= 16 | 32 | 64;
      if (unreadMarks.has(c.id)) b |= 512;
      if (b) flags[c.id] = b;
    }
    post({ convActions: { flags, left: {}, hidden: { enabled: true, hasPin: hiddenPin !== null, ids: [...hidden] }, markUnread: true } });
  };
  const refreshRow = (c: MockConversation) => {
    publishConversations([c]);
    publishExtras();
    publishConvActions();
  };
  const ok = (text: string, extra: Json = {}) => ({ ok: true, text, ...extra });
  const convActions: Record<string, (...a: any[]) => unknown> = {
    republish: () => publishConvActions(),
    pin: (id: string) => {
      const c = convs.get(id);
      if (!c) return { ok: false, text: 'Đã có lỗi xảy ra, vui lòng thử lại' };
      if ([...convs.values()].filter((x) => x.pinned).length >= pinLimit) return { ok: false, text: '', full: true };
      c.pinned = true;
      refreshRow(c);
      return ok('Ghim hội thoại thành công');
    },
    unpin: (id: string) => {
      const c = convs.get(id);
      if (c) {
        c.pinned = false;
        refreshRow(c);
      }
      return ok('Bỏ ghim hội thoại thành công');
    },
    pinBoard: () => {
      const items = [...convs.values()].filter((x) => x.pinned).map((x) => x.id);
      return { tab: 0, limit: pinLimit, total: items.length, need: Math.max(1, items.length - pinLimit + 1), items };
    },
    pinReplacing: (unpinIds: string[], id: string) => {
      for (const u of unpinIds) {
        const c = convs.get(u);
        if (c) c.pinned = false;
      }
      const c = convs.get(id);
      if (c) c.pinned = true;
      publishConversations([...convs.values()]);
      publishExtras();
      publishConvActions();
      return ok('Ghim hội thoại thành công');
    },
    archive: (id: string) => {
      archived.add(id);
      const c = convs.get(id);
      if (c) c.pinned = false;
      if (c) refreshRow(c);
      return ok('Đã chuyển sang mục Khác', { neutral: true });
    },
    unarchive: (id: string) => {
      archived.delete(id);
      publishConvActions();
      return ok('Đã chuyển sang Tin nhắn', { neutral: true });
    },
    deleteConversation: (id: string) => {
      convs.delete(id);
      post({ conversations: [], removed: [id], reset: false });
      publishExtras();
      publishConvActions();
      return ok('');
    },
    markRead: (id: string) => {
      unreadMarks.delete(id);
      const c = convs.get(id);
      if (c) {
        c.unread = 0;
        refreshRow(c);
      }
      return ok('');
    },
    markUnread: (id: string) => {
      unreadMarks.add(id);
      publishConvActions();
      return ok('');
    },
    checkPin: (pin: string) => ({ ok: hiddenPin !== null && pin === hiddenPin, text: '' }),
    hide: (id: string, pin: string) => {
      if (pin !== hiddenPin) return { ok: false, text: 'Mã PIN không đúng. Vui lòng thử lại.', badPin: true };
      hidden.add(id);
      publishConvActions();
      return ok(`Trò chuyện "${convs.get(id)?.name ?? ''}" đã được ẩn thành công`);
    },
    hideWithNewPin: (id: string, pin: string) => {
      if (hiddenPin !== null) return { ok: false, text: '', pinExists: true };
      hiddenPin = pin;
      hidden.add(id);
      publishConvActions();
      return ok(`Trò chuyện "${convs.get(id)?.name ?? ''}" đã được ẩn thành công`);
    },
    unhide: (id: string, pin: string | null) => {
      if (pin !== null && pin !== hiddenPin) return { ok: false, text: 'Mã PIN không đúng. Vui lòng thử lại.', badPin: true };
      hidden.delete(id);
      publishConvActions();
      return ok('Bỏ ẩn trò chuyện thành công');
    },
    setPin: (pin: string, changed: boolean) => {
      if (!changed && hiddenPin !== null) return { ok: false, text: '', pinExists: true };
      hiddenPin = pin;
      publishConvActions();
      return ok(changed ? 'Đổi mã PIN thành công' : '');
    },
    resetPin: () => {
      for (const id of hidden) {
        convs.delete(id);
        post({ conversations: [], removed: [id], reset: false });
      }
      hidden.clear();
      hiddenPin = null;
      publishExtras();
      publishConvActions();
      return ok('Đã xóa thành công mã PIN và các trò chuyện ẩn');
    },
    hiddenSearch: (query: string) => (hiddenPin !== null && query === hiddenPin ? { ids: [...hidden] } : null),
  };

  const adapters: Record<string, Record<string, (...a: any[]) => unknown>> = {
    __zaloConvActions: convActions,
    __zaloChat: chat,
    __zaloMsgActions: msgActions,
    __zaloConversations: conversationsAdapter,
    __zaloCompose: compose,
  };

  const start = () => {
    const go = () => {
      switch (scenario) {
        case 'starting':
          return;
        case 'preparing':
        case 'failed': {
          let received = 0;
          const total = 340 * 1024 * 1024;
          setPhase({ kind: 'preparing', setup: { step: 'looking' } });
          const tick = setInterval(() => {
            received += 9 * 1024 * 1024;
            if (scenario === 'failed' && received > total / 3) {
              clearInterval(tick);
              setPhase({ kind: 'preparing', setup: { step: 'downloading', received, total, failure: 'Không tải được Zalo PC: mất kết nối mạng.' } });
              return;
            }
            if (received >= total) {
              clearInterval(tick);
              setPhase({ kind: 'preparing', setup: { step: 'verifying' } });
              setTimeout(() => setPhase({ kind: 'preparing', setup: { step: 'installing' } }), 1200);
              setTimeout(() => setPhase(login({ kind: 'waitingScan' })), 2400);
              return;
            }
            setPhase({ kind: 'preparing', setup: { step: 'downloading', received, total } });
          }, 120);
          return;
        }
        case 'login':
          setPhase(login({ kind: 'generating' }));
          setTimeout(() => {
            setPhase(login({ kind: 'waitingScan' }));
            // Dev aid: `&login=confirm|expired|failed|qr2` shows that login state.
            const state = params.get('login');
            if (state) (window as unknown as Record<string, (s: string) => void>).__mockLogin(state);
          }, 700);
          return;
        case 'signingIn':
          setPhase({ kind: 'signingIn' });
          return;
        default:
          setPhase({ kind: 'signingIn' });
          setTimeout(() => {
            boot();
            setPhase({ kind: 'ready' });
            emit('compola://page', 'main');
            liveTraffic();
            // Dev aid: `&open=<conversation id>` opens a chat, `&inspector=1` its inspector, `&switcher=1` the ⌘K palette.
            void import('../../shell/shellStore').then(({ shell }) => {
              const open = params.get('open');
              if (open) setTimeout(() => shell.select(open), 50);
              if (params.has('inspector')) setTimeout(() => shell.toggleInspector(), 100);
              if (params.has('switcher')) setTimeout(() => shell.toggleQuickSwitcher(), 100);
            });
          }, 500);
      }
    };
    setTimeout(go, 300);
  };
  start();

  // Dev aid in mock login: window.__mockLogin('confirm' | 'expired' | 'failed' | 'qr2' | 'ok')
  (window as unknown as Record<string, unknown>).__mockLogin = (what: string) => {
    if (what === 'confirm') setPhase(login({ kind: 'waitingConfirm', name: ME.displayName, avatar: null }));
    else if (what === 'expired') setPhase(login({ kind: 'expired' }));
    else if (what === 'failed') setPhase(login({ kind: 'failed', message: 'Không thể kết nối tới máy chủ Zalo.' }));
    else if (what === 'qr2') setPhase(login({ kind: 'waitingScan' }, { isSecondQr: true }));
    else if (what === 'ok') {
      setPhase({ kind: 'signingIn' });
      setTimeout(() => {
        boot();
        setPhase({ kind: 'ready' });
      }, 900);
    }
  };

  return {
    isMock: true,
    async invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
      const extra = mockCommands[command];
      if (extra) {
        const r = await extra(args);
        if (r !== mockPass) return r as T;
      }
      switch (command) {
        case 'engine_phase':
          return phase as T;
        case 'engine_info':
          return { runtimeVersion: 'mock', storage: 'idb', recentLog: [] } as T;
        case 'engine_refresh_qr':
          qrSeed += 1;
          setPhase(login({ kind: 'generating' }));
          setTimeout(() => setPhase(login({ kind: 'waitingScan' })), 600);
          return undefined as T;
        case 'engine_logout':
          setPhase(login({ kind: 'generating' }));
          setTimeout(() => setPhase(login({ kind: 'waitingScan' })), 600);
          return undefined as T;
        case 'engine_retry_runtime':
        case 'ui_set_open_conversation':
        case 'ui_set_shows_preview':
        case 'ui_widen_window':
          return undefined as T;
        case 'media_save':
          return args.destPath as T;
        case 'screen_capture_start':
          // The tool's "Chia sẻ" when started without Compola's window, "Gửi" otherwise.
          setTimeout(
            () =>
              emit('compola://screen-capture', args.withCompola
                ? { kind: 'send', path: '/tmp/compola-shot.png', conversationId: args.conversationId }
                : { kind: 'share', path: '/tmp/compola-shot.png', conversationId: args.conversationId }),
            600,
          );
          return undefined as T;
        case 'engine_call': {
          const fn = mockAdapters[String(args.target)]?.[String(args.method)] ?? adapters[String(args.target)]?.[String(args.method)];
          if (!fn) throw new Error(`no ${String(args.target)}.${String(args.method)}`);
          return (await fn(...((args.args as unknown[]) ?? []))) as T;
        }
        case 'engine_call_with_files': {
          const first = (args.args as unknown[])[0];
          const targets = Array.isArray(first) ? first.map(String) : [String(first)];
          if (args.method === 'sendShot' || args.method === 'shareShot') {
            for (const t of targets) {
              const shot = message(t, { from: ME.userId, text: '[Hình ảnh]', kind: { type: 'photo', url: 'https://picsum.photos/id/0/1200/750', width: 1200, height: 750 }, ago: 0 });
              history(t).push(shot);
              if (openId === t) publishChat(t, false, [shot]);
              touch(t, shot);
            }
            return { status: 'done' } as T;
          }
          const id = targets[0];
          const m =
            args.pick === 'media'
              ? message(id, { from: ME.userId, text: '[Hình ảnh]', kind: { type: 'photo', url: 'https://picsum.photos/id/29/900/600', width: 900, height: 600 }, ago: 0 })
              : message(id, { from: ME.userId, text: '[File] Bao-cao.xlsx', kind: { type: 'file', name: 'Bao-cao.xlsx', size: 48_211, url: 'https://example.com/b.xlsx' }, ago: 0 });
          history(id).push(m);
          publishChat(id, false, [m]);
          touch(id, m);
          return { status: 'done' } as T;
        }
        default:
          throw new Error(`mock: unknown command ${command}`);
      }
    },
    async listen(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
      return () => listeners.get(event)?.delete(handler);
    },
  };
};

const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];
