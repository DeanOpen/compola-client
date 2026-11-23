// Group polls (MSG_POLL 26): models of ZaloEngine+Poll.swift. poll-adapter.js posts {poll:{id, detail}} /
// {poll:{id, error}} and answers the reads / writes below with plain JSON.

import { arr, bool, int, num, obj, optStr, str, type Json } from './json';

export interface PollOption {
  id: string;
  content: string;
  votes: number;
  voted: boolean;
}

export interface PollDetail {
  id: string;
  /** Conversation id ("g…") the poll lives in. */
  groupId: string;
  question: string;
  creator: string;
  creatorName: string;
  /** Epoch ms. */
  created: number | null;
  expires: number | null;
  closed: boolean;
  /** I have voted (official `joined`). */
  joined: boolean;
  multi: boolean;
  allowAdd: boolean;
  anonymous: boolean;
  hidePreview: boolean;
  /** Distinct people who voted. */
  voterCount: number;
  /** Owner / deputy / creator (official `isEnableClose`). */
  canClose: boolean;
  options: PollOption[];
}

const plausibleMs = (v: unknown): number | null => {
  const ms = num(v);
  return ms > 0 && ms < 4_102_444_800_000 ? ms : null;
};

export const parsePollDetail = (v: unknown): PollDetail | null => {
  const json = obj(v);
  const id = json ? str(json.id) : '';
  if (!json || !id) return null;
  return {
    id,
    groupId: str(json.groupId),
    question: str(json.question),
    creator: str(json.creator),
    creatorName: str(json.creatorName),
    created: plausibleMs(json.created),
    expires: plausibleMs(json.expired),
    closed: bool(json.closed),
    joined: bool(json.joined),
    multi: bool(json.multi),
    allowAdd: bool(json.allowAdd),
    anonymous: bool(json.anonymous),
    hidePreview: bool(json.hidePreview),
    voterCount: int(json.voters),
    canClose: bool(json.canClose),
    options: arr(json.options)
      .map(obj)
      .filter((r): r is Json => !!r && !!str(r.id))
      .map((r) => ({ id: str(r.id), content: str(r.content), votes: Math.max(0, int(r.votes)), voted: bool(r.voted) })),
  };
};

export const totalVotes = (p: PollDetail) => p.options.reduce((n, o) => n + o.votes, 0);
export const isPollExpired = (p: PollDetail, now = Date.now()) => p.expires !== null && p.expires < now;
/** Votes cannot change any more: closed, expired, or (results hidden until voting) already voted. */
export const isVotingLocked = (p: PollDetail, now = Date.now()) => p.closed || isPollExpired(p, now) || (p.hidePreview && p.joined);
/** "Ẩn kết quả khi chưa bình chọn": the numbers are only meaningful after I voted. */
export const resultsHidden = (p: PollDetail) => p.hidePreview && !p.joined;
/** Official `isEnableViewDetail`: voter list is offered when not anonymous and results are visible. */
export const votersVisible = (p: PollDetail) => !p.anonymous && !resultsHidden(p) && totalVotes(p) > 0;
export const optionWeight = (p: PollDetail, o: PollOption) => {
  const total = totalVotes(p);
  return total > 0 ? o.votes / total : 0;
};

// MARK: - Vote draft

export interface AddedOption {
  key: number;
  text: string;
  voted: boolean;
}

/**
 * What the vote popup edits: which existing options are ticked and the options being added. Mirrors the official
 * reducer (single choice: ticking one unticks the others, added options included). Immutable: every edit returns a copy.
 */
export interface PollVoteDraft {
  selected: string[];
  original: string[];
  multi: boolean;
  added: AddedOption[];
}

let addedKey = 0;

export const voteDraft = (p: PollDetail): PollVoteDraft => {
  const voted = p.options.filter((o) => o.voted).map((o) => o.id);
  return { selected: voted, original: voted, multi: p.multi, added: [] };
};

export const toggleOption = (d: PollVoteDraft, id: string): PollVoteDraft => {
  if (d.selected.includes(id)) return { ...d, selected: d.selected.filter((x) => x !== id) };
  if (!d.multi) return { ...d, selected: [id], added: d.added.map((a) => ({ ...a, voted: false })) };
  return { ...d, selected: [...d.selected, id] };
};

export const setAddedVoted = (d: PollVoteDraft, key: number, voted: boolean): PollVoteDraft => {
  if (!d.added.some((a) => a.key === key)) return d;
  const single = voted && !d.multi;
  return {
    ...d,
    selected: single ? [] : d.selected,
    added: d.added.map((a) => (a.key === key ? { ...a, voted } : single ? { ...a, voted: false } : a)),
  };
};

export const addRow = (d: PollVoteDraft): PollVoteDraft => ({ ...d, added: [...d.added, { key: (addedKey += 1), text: '', voted: false }] });
export const removeAdded = (d: PollVoteDraft, key: number): PollVoteDraft => ({ ...d, added: d.added.filter((a) => a.key !== key) });
export const setAddedText = (d: PollVoteDraft, key: number, text: string): PollVoteDraft => ({
  ...d,
  added: d.added.map((a) => (a.key === key ? { ...a, text } : a)),
});

const filled = (d: PollVoteDraft) => d.added.map((a) => ({ ...a, text: a.text.trim() })).filter((a) => a.text.length > 0);
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Anything to send: a changed tick or a new option (official confirm button state). */
export const draftHasChanges = (d: PollVoteDraft) => !sameSet(d.selected, d.original) || filled(d).length > 0;
/** Nothing is ticked (existing or added): the official "hide results" confirmation is skipped for this. */
export const draftVotesNothing = (d: PollVoteDraft) => d.selected.length === 0 && !filled(d).some((a) => a.voted);

export const draftHasDuplicates = (d: PollVoteDraft, p: PollDetail) => {
  const all = [...p.options.map((o) => o.content.trim()), ...filled(d).map((a) => a.text)];
  return new Set(all).size !== all.length;
};

export const isDuplicateAdded = (d: PollVoteDraft, key: number, p: PollDetail) => {
  const rows = filled(d);
  const row = rows.find((a) => a.key === key);
  if (!row) return false;
  return [...p.options.map((o) => o.content.trim()), ...rows.filter((a) => a.key !== key).map((a) => a.text)].includes(row.text);
};

/** Arguments of `__zaloPoll.vote` (option ids in the poll's own order). */
export const voteRequest = (d: PollVoteDraft, p: PollDetail) => ({
  newOptions: filled(d).map((a) => ({ voted: a.voted, content: a.text })),
  votedIds: p.options.map((o) => o.id).filter((id) => d.selected.includes(id)),
});

/** The poll as it would look after this vote (live preview of the bars, like the official popup). */
export const applyDraft = (d: PollVoteDraft, p: PollDetail): PollDetail => ({
  ...p,
  options: p.options.map((o) => {
    const now = d.selected.includes(o.id);
    return now === o.voted ? o : { ...o, voted: now, votes: Math.max(0, o.votes + (now ? 1 : -1)) };
  }),
});

// MARK: - Voters

export interface PollVoterUser {
  uid: string;
  name: string;
  avatar: string | null;
  isMe: boolean;
}

export interface PollVoterGroup {
  id: string;
  content: string;
  votes: number;
  users: PollVoterUser[];
}

export interface PollVoters {
  /** Anonymous poll / results hidden until I vote: the official client shows no voter list. */
  restricted: boolean;
  groups: PollVoterGroup[];
}

export const parsePollVoters = (v: unknown): PollVoters | null => {
  const root = obj(v);
  if (!root) return null;
  return {
    restricted: bool(root.restricted),
    groups: arr(root.groups)
      .map(obj)
      .filter((r): r is Json => !!r && typeof r.optionId === 'string')
      .map((r) => ({
        id: str(r.optionId),
        content: str(r.content),
        votes: int(r.votes),
        users: arr(r.users)
          .map(obj)
          .filter((u): u is Json => !!u && !!str(u.uid))
          .map((u) => ({ uid: str(u.uid), name: str(u.name), avatar: optStr(u.avatar), isMe: bool(u.isMe) })),
      })),
  };
};

// MARK: - Capabilities / config

/** Official `groupPoll` limits (config) used by the create popup. */
export interface PollConfig {
  minOptions: number;
  maxOptions: number;
  maxQuestion: number;
  maxOption: number;
  enableAnonymous: boolean;
  enableHidePreview: boolean;
  /** Options shown on the chat card before "* Còn N lựa chọn khác". */
  displayOptions: number;
}

export const defaultPollConfig: PollConfig = {
  minOptions: 2,
  maxOptions: 30,
  maxQuestion: 200,
  maxOption: 120,
  enableAnonymous: true,
  enableHidePreview: true,
  displayOptions: 3,
};

const parsePollConfig = (v: unknown): PollConfig => {
  const json = obj(v);
  if (!json) return defaultPollConfig;
  const count = (key: keyof PollConfig, fallback: number) => {
    const value = int(json[key]);
    return value > 0 ? value : fallback;
  };
  const d = defaultPollConfig;
  const minOptions = count('minOptions', d.minOptions);
  return {
    minOptions,
    maxOptions: Math.max(minOptions, count('maxOptions', d.maxOptions)),
    maxQuestion: count('maxQuestion', d.maxQuestion),
    maxOption: count('maxOption', d.maxOption),
    displayOptions: count('displayOptions', d.displayOptions),
    enableAnonymous: json.enableAnonymous === undefined ? true : bool(json.enableAnonymous),
    enableHidePreview: json.enableHidePreview === undefined ? true : bool(json.enableHidePreview),
  };
};

export interface PollCapabilities {
  ready: boolean;
  canCreate: boolean;
  canPin: boolean;
  config: PollConfig;
}

export const parsePollCapabilities = (v: unknown): PollCapabilities => {
  const o = obj(v);
  if (!o) return { ready: false, canCreate: false, canPin: false, config: defaultPollConfig };
  return { ready: bool(o.ready), canCreate: bool(o.canCreate), canPin: bool(o.canPin), config: parsePollConfig(o.config) };
};

// MARK: - Create draft

/** The "Tạo bình chọn" form (official create popup defaults: multiple choice and "add option" on). */
export interface PollCreateDraft {
  question: string;
  options: string[];
  hasDeadline: boolean;
  /** Epoch ms. */
  deadline: number;
  pin: boolean;
  multi: boolean;
  allowAdd: boolean;
  hidePreview: boolean;
  anonymous: boolean;
}

export const createDraft = (config: PollConfig = defaultPollConfig): PollCreateDraft => ({
  question: '',
  options: Array.from({ length: config.minOptions }, () => ''),
  hasDeadline: false,
  deadline: Date.now() + 86_400_000,
  pin: false,
  multi: true,
  allowAdd: true,
  hidePreview: false,
  anonymous: false,
});

export const filledOptions = (d: PollCreateDraft) => d.options.map((o) => o.trim()).filter((o) => o.length > 0);

export const isDuplicateOption = (d: PollCreateDraft, index: number) => {
  const text = d.options[index]?.trim();
  if (!text) return false;
  return d.options.some((o, i) => i !== index && o.trim() === text);
};

export type PollCreateIssue = { kind: 'emptyQuestion' } | { kind: 'tooFewOptions'; min: number } | { kind: 'duplicate' } | { kind: 'pastDeadline' };

/** First reason the poll cannot be created yet; null = ready. */
export const createIssue = (d: PollCreateDraft, config: PollConfig, now = Date.now()): PollCreateIssue | null => {
  if (!d.question.trim()) return { kind: 'emptyQuestion' };
  const opts = filledOptions(d);
  if (new Set(opts).size !== opts.length) return { kind: 'duplicate' };
  if (opts.length < config.minOptions) return { kind: 'tooFewOptions', min: config.minOptions };
  if (d.hasDeadline && d.deadline <= now) return { kind: 'pastDeadline' };
  return null;
};

export const createIssueText = (issue: PollCreateIssue | null): string | null => {
  switch (issue?.kind) {
    case 'emptyQuestion':
      return 'Vui lòng đặt câu hỏi cho bình chọn.';
    case 'tooFewOptions':
      return `Bạn không thể tạo bình chọn ít hơn ${issue.min} bình chọn`;
    case 'duplicate':
      return 'Bạn đã tạo trùng phương án.';
    case 'pastDeadline':
      return 'Vui lòng chọn thời gian tương lai';
    default:
      return null;
  }
};

/** "Add option" is meaningless while results are hidden (official create popup disables and sends false). */
export const effectiveAllowAdd = (d: PollCreateDraft) => d.allowAdd && !d.hidePreview;

/** Argument of `__zaloPoll.create`. */
export const createSpec = (d: PollCreateDraft, config: PollConfig, canPin: boolean) => ({
  question: d.question.trim().slice(0, config.maxQuestion),
  options: filledOptions(d).map((o) => o.slice(0, config.maxOption)),
  expired: d.hasDeadline ? Math.trunc(d.deadline) : 0,
  pin: d.pin && canPin,
  multi: d.multi,
  allowAdd: effectiveAllowAdd(d),
  hidePreview: d.hidePreview && config.enableHidePreview,
  anonymous: d.anonymous && config.enableAnonymous,
});

// MARK: - Action results

export type PollAction = 'vote' | 'lock' | 'share' | 'create' | 'pin' | 'unpin';

export interface PollActionResult {
  ok: boolean;
  error: string | null;
  /** The poll was created, but "ghim" was left out (the board is full or could not be checked). */
  pinSkipped: boolean;
}

export const parsePollActionResult = (v: unknown): PollActionResult => {
  const json = obj(v);
  if (!json) return { ok: false, error: 'unavailable', pinSkipped: false };
  return { ok: bool(json.ok), error: optStr(json.error), pinSkipped: bool(json.pinSkipped) };
};

/** Official toast / modal texts (lang_vi.json). */
export const pollActionMessage = (r: PollActionResult, action: PollAction): string => {
  switch (r.error) {
    case 'closed':
      return 'Có lỗi xảy ra do bình chọn đã bị khoá';
    case 'expired':
      return 'Bình chọn đã hết hạn';
    case 'network':
      return 'Không có mạng, vui lòng kiểm tra lại kết nối và thử lại';
    case 'duplicate':
      return 'Phương án được thêm đã tồn tại';
    case 'forbidden':
      if (action === 'create') return 'Bạn không đủ quyền tạo bình chọn';
      if (action === 'pin' || action === 'unpin') return 'Bạn không có quyền thực hiện thao tác này.';
      return 'Bạn không có quyền khóa bình chọn này';
    case 'limit':
      return 'Bảng ghim đã đầy. Hãy bỏ bớt ghim trong Zalo rồi thử lại.';
    case 'partial':
      return 'Đã bỏ ghim cũ nhưng chưa ghim được bình chọn. Vui lòng thử ghim lại.';
    case 'unknown':
      return 'Chưa xác nhận được kết quả. Vui lòng kiểm tra lại bình chọn sau.';
  }
  switch (action) {
    case 'vote':
      return 'Có lỗi xảy ra trong quá trình bình chọn.';
    case 'lock':
      return 'Có lỗi xảy ra trong quá trình khóa bình chọn. Vui lòng thử lại.';
    case 'share':
      return 'Có lỗi xảy ra trong quá trình chia sẻ bình chọn. Vui lòng thử lại.';
    case 'create':
      return 'Có lỗi xảy ra trong quá trình tạo bình chọn. Vui lòng kiểm tra lại.';
    case 'pin':
      return 'Ghim bình chọn không thành công. Vui lòng thử lại.';
    case 'unpin':
      return 'Bỏ ghim không thành công. Vui lòng thử lại.';
  }
};

// MARK: - Pin board

/** Whether the group's board lets me pin, and whether this poll is pinned. Not `ready` = unknown / not offered. */
export interface PollPinState {
  ready: boolean;
  /** Official `isEnablePin`. */
  canPin: boolean;
  pinned: boolean;
  /** Pinned topics the board holds at most (`pinLimit`). */
  limit: number;
}

export const unknownPinState: PollPinState = { ready: false, canPin: false, pinned: false, limit: 0 };

export const parsePollPinState = (v: unknown): PollPinState => {
  const o = obj(v);
  if (!o) return unknownPinState;
  return { ready: bool(o.ready), canPin: bool(o.canPin), pinned: bool(o.pinned), limit: Math.max(0, int(o.limit)) };
};

export const offersPin = (s: PollPinState) => s.ready && s.canPin;

/** The board is full: the official "Cập nhật danh sách ghim" dialog. Confirming replaces the oldest pin. */
export interface PollPinConfirm {
  ref: string;
  limit: number;
  kind: string;
  title: string;
}

export const parsePollPinConfirm = (v: unknown): PollPinConfirm | null => {
  const o = obj(v);
  const ref = o ? str(o.ref) : '';
  if (!o || !ref) return null;
  const replace = obj(o.replace) ?? {};
  return { ref, limit: Math.max(0, int(o.limit)), kind: str(replace.kind), title: str(replace.title) };
};

/** STR_ONLY_PIN_MAX_CONTENT + STR_DIRECTION_PIN_LIMIT, then the pin that goes. */
export const pinConfirmMessage = (c: PollPinConfirm): string => {
  const label = c.kind === 'poll' ? 'Bình chọn' : c.kind === 'reminder' ? 'Nhắc hẹn' : c.kind === 'message' ? 'Tin nhắn' : 'Ghi chú';
  const head = c.limit > 0 ? `Đã đạt giới hạn ${c.limit} ghim. ` : '';
  return head + 'Ghim cũ dưới đây sẽ được bỏ để cập nhật nội dung mới.\n' + (c.title ? `${label}: ${c.title}` : label);
};

export type PollPinOutcome = { kind: 'done' } | { kind: 'needsConfirmation'; confirm: PollPinConfirm } | { kind: 'failed'; result: PollActionResult };

// MARK: - Formatting

const two = (n: number) => String(n).padStart(2, '0');

/** "HH:mm dd/MM/yyyy" */
export const formatPollDeadline = (ms: number) => {
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())} ${two(d.getDate())}/${two(d.getMonth() + 1)}/${d.getFullYear()}`;
};

/** "dd/MM" */
export const formatPollDay = (ms: number) => {
  const d = new Date(ms);
  return `${two(d.getDate())}/${two(d.getMonth() + 1)}`;
};

export const formatPercent = (weight: number) => `${Math.round(weight * 100)}%`;
