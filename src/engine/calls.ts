// Voice / video calls (Swift ZaloEngine+CallHook.swift + ZaloEngine+GroupCall.swift). The official renderer's call
// helper does the signalling (host-scripts/call-adapter.js: `window.__zaloCall`, posts `{page:'main', call:{…}}`);
// Rust (calls/) hosts the native call helper (ZaloCall) that draws the call window and handles mic / camera, and
// reports its lifecycle as `compola://call-event`.
//
// Entry points for the UI (chat header buttons, contact cards, profile sheets):
//   canCall(state)                                   calls are available
//   callAvailability(state, conversation, video)     header button state
//   startCall(uid, video)                            the chat header's own action (groups: video → participant picker)

import { create } from 'zustand';
import { backend, usesTauri } from './backend';
import { callAdapter, fireAdapter, log } from './call';
import { registerStateHandler } from './dispatch';
import { arr, bool, int, obj, optStr, str, type Json } from './models/json';
import type { ConversationSummary } from './models/conversations';
import { getEngine, onAccountReset, setEngine } from './store';
import { showToast } from './toast';

export interface IncomingCall {
  id: number;
  name: string;
  avatar: string | null;
  group: boolean;
  /** Group calls: who started it, when the control event says (shown under the group's name). */
  caller: string | null;
  /** Epoch ms. */
  date: number;
}

/** Short message shown over the window (call could not start, helper reported a problem). */
export interface CallNotice {
  id: number;
  title: string;
  message: string;
}

/** Header rule for a group: `disabled` = shown but off (remote config -2), `feature` = `enable_group_call_for_user`. */
export interface GroupGate {
  disabled: boolean;
  feature: boolean;
}

export interface GroupCallPickerMember {
  id: string;
  name: string;
  avatar: string | null;
}

/** What the renderer's GROUP_CALL modal would show (Swift `GroupCallPicker`). */
export interface GroupCallPicker {
  /** Request token (single use). */
  id: string;
  /** The helper asked to add people to a running call (instead of starting one). */
  adding: boolean;
  /** null: unknown (add-participant). */
  video: boolean | null;
  groupName: string;
  groupAvatar: string | null;
  /** Official limit: `maxUsers - 1` (10 when the server sends no `maxUsers`). */
  maxSelectable: number;
  /** Already in the call (add-participant): shown ticked and disabled, not counted. */
  existing: string[];
  /** Group-privacy notice of the modal header. */
  note: string | null;
  members: GroupCallPickerMember[];
}

export interface CallState {
  /** The renderer's call helper was found. */
  rendererReady: boolean;
  /** Official `isSupport()` (server config + OS) and the IPC transport. */
  supported: boolean;
  videoSupported: boolean;
  /** The renderer is in a call (`isCalling()`). */
  busy: boolean;
  /** The Zalo runtime has the native helper (Rust reports `helperUnavailable` when it does not). */
  helperInstalled: boolean;
  /** Why the native helper cannot run (missing, failed to start), null when fine. */
  helperProblem: string | null;
  nativeRunning: boolean;
  /** pid of the helper this app started (its window is the call window). */
  nativePID: number | null;
  nativeState: string | null;
  /** The open conversation and whether the official header would offer calls for it (`canMakeCallAgain`). */
  conversationId: string | null;
  conversationCanCall: boolean;
  /** The open group's call button by the official header rule (null: no button). Video only. */
  conversationGroup: GroupGate | null;
  /** The participant picker waiting for the user. */
  picker: GroupCallPicker | null;
  incoming: IncomingCall | null;
  notice: CallNotice | null;
}

const initial = (): CallState => ({
  rendererReady: false,
  supported: false,
  videoSupported: false,
  busy: false,
  helperInstalled: true,
  helperProblem: null,
  nativeRunning: false,
  nativePID: null,
  nativeState: null,
  conversationId: null,
  conversationCanCall: false,
  conversationGroup: null,
  picker: null,
  incoming: null,
  notice: null,
});

export const useCalls = create<CallState>()(initial);
const get = useCalls.getState;
const set = useCalls.setState;

// The helper's lifecycle is the app's, not the account's: only the account-bound parts are dropped.
onAccountReset(() =>
  set({ conversationId: null, conversationCanCall: false, conversationGroup: null, picker: null, incoming: null, notice: null, busy: false }),
);

let seq = 0;
const nextId = () => (seq += 1);

// MARK: - Availability

/** True when the app can place calls. */
export const canCall = (s: CallState = get()) => s.supported && s.helperInstalled && s.helperProblem === null;

/** The renderer is in a call, or the native helper says so. */
export const isInCall = (s: CallState = get()) => s.busy || (s.nativeState !== null && s.nativeState !== 'free');

export type CallAvailability = { kind: 'available' } | { kind: 'disabled'; reason: string } | { kind: 'hidden' };

/** Header button state for a conversation (Swift `callAvailability(for:video:)`). */
export const callAvailability = (
  s: CallState,
  conversation: Pick<ConversationSummary, 'id' | 'isGroup'>,
  video: boolean,
  selfConversationId: string | null = getEngine().selfConversationId,
): CallAvailability => {
  if (conversation.id === selfConversationId) return { kind: 'hidden' };
  if (conversation.isGroup) {
    // The official header has a video button only for groups, shown by the member thresholds of the remote "call"
    // config; the renderer answers for the open conversation.
    const gate = s.conversationGroup;
    if (!video || s.conversationId !== conversation.id || !gate) return { kind: 'hidden' };
    if (gate.disabled) return { kind: 'disabled', reason: 'Cuộc gọi nhóm hiện chưa khả dụng' };
    if (!gate.feature && s.supported) return { kind: 'disabled', reason: 'Tài khoản này chưa bật gọi nhóm' };
  } else if (s.conversationId === conversation.id && !s.conversationCanCall && s.supported) {
    // The official header offers calls to friends only; the renderer answers for the open conversation.
    return { kind: 'hidden' };
  }
  if (!s.helperInstalled) return { kind: 'disabled', reason: 'Thiếu trình gọi của Zalo — hãy mở lại Compola' };
  if (s.helperProblem) return { kind: 'disabled', reason: s.helperProblem };
  if (!s.rendererReady) return { kind: 'disabled', reason: 'Đang khởi động cuộc gọi…' };
  if (!s.supported) return { kind: 'disabled', reason: 'Tài khoản này chưa bật gọi điện trên Zalo PC' };
  if (video && !s.videoSupported) return { kind: 'disabled', reason: 'Tài khoản này chưa bật gọi video' };
  if (s.busy) return { kind: 'disabled', reason: 'Bạn đang trong một cuộc gọi khác' };
  return { kind: 'available' };
};

export const showCallNotice = (title: string, message: string) => set({ notice: { id: nextId(), title, message } });
export const dismissCallNotice = () => set({ notice: null });
export const dismissIncomingCall = () => set({ incoming: null });

/**
 * Starts a 1-1 voice / video call to `uid` (groups: video only → participant picker). The renderer checks eligibility
 * first and only then asks for the conversation to be opened (`open` below). Never places a call by itself.
 */
export const startCall = (uid: string, video: boolean) => {
  if (!uid) return;
  if (uid.startsWith('g') && !video) {
    showCallNotice('Chỉ gọi video cho nhóm', 'Zalo chỉ hỗ trợ gọi video trong nhóm. Hãy chọn nút gọi video.');
    return;
  }
  const s = get();
  if (!canCall(s)) {
    showCallNotice('Chưa thể gọi', s.helperProblem ?? 'Cuộc gọi chưa sẵn sàng. Hãy thử lại sau ít giây.');
    return;
  }
  if (s.busy) {
    showCallNotice('Đang trong cuộc gọi', 'Hãy kết thúc cuộc gọi hiện tại trước khi gọi tiếp.');
    return;
  }
  fireAdapter('__zaloCall', 'start', uid, video, nextId());
};

/** Asks the renderer to post its status again (e.g. after the open conversation changed). */
export const refreshCallStatus = () => fireAdapter('__zaloCall', 'refresh');

/**
 * Brings the native call window to the front (ringing / in-call). Needs the Rust command `call_show_window`
 * (activates our own helper by its pid); without it nothing happens.
 */
export const showCallWindow = async () => {
  try {
    await (await backend()).invoke('call_show_window');
  } catch (e) {
    // "Không có cuộc gọi nào đang diễn ra." / "Cửa sổ cuộc gọi đã đóng."
    showToast(String(e));
    void syncCallsStatus();
  }
};

/** The helper's state now (Rust `calls_status`): events emitted before the UI subscribed are otherwise lost. */
export const syncCallsStatus = async () => {
  try {
    const st = obj(await (await backend()).invoke('calls_status'));
    if (!st) return;
    set({
      helperInstalled: bool(st.helperInstalled, true),
      nativeRunning: bool(st.running),
      nativePID: typeof st.pid === 'number' ? st.pid : null,
      helperProblem: optStr(st.problem),
      // `nativeState` there is the helper's readiness ("ready" / "starting"), not a call state: `isInCall` must not
      // read it as one. The call state only comes from `callState` events.
    });
  } catch (e) {
    log(`calls_status: ${String(e)}`);
  }
};

export const callFailureMessage = (result: string, group = false): string | null => {
  if (group && result === 'unavailable') {
    return 'Zalo không cho phép gọi nhóm này (nhóm có quá nhiều thành viên hoặc tài khoản chưa bật gọi nhóm).';
  }
  switch (result) {
    case 'started':
      return null;
    case 'busy':
      return 'Bạn đang trong một cuộc gọi khác.';
    case 'offline':
      return 'Không có kết nối mạng.';
    case 'unavailable':
      return 'Zalo không cho phép gọi cho cuộc trò chuyện này (chỉ gọi được cho bạn bè).';
    case 'unsupported':
      return 'Tài khoản này chưa bật gọi điện trên Zalo PC.';
    case 'not-open':
    case 'not-ready':
      return 'Cuộc trò chuyện chưa sẵn sàng. Hãy thử lại sau ít giây.';
    case 'invalid':
      return 'Danh sách người tham gia không hợp lệ. Hãy chọn lại.';
    default:
      return 'Đã có lỗi khi bắt đầu cuộc gọi.';
  }
};

// MARK: - Native helper events (`compola://call-event`, Rust calls::CallEvent)

export const handleCallEvent = (payload: unknown) => {
  const e = obj(payload);
  if (!e) return;
  const s = get();
  switch (str(e.kind)) {
    case 'helperUnavailable': {
      const reason = str(e.reason) || 'Không khởi động được trình gọi của Zalo';
      // "missing" (Zalo.app has no helper) vs. a helper that could not start: Rust gives one reason string.
      const missing = /không tìm thấy|missing|not found/i.test(reason);
      return set({ helperProblem: reason, nativeRunning: false, nativePID: null, helperInstalled: !missing });
    }
    case 'helperStarted':
      return set({ helperProblem: null, nativeRunning: true, nativePID: typeof e.pid === 'number' ? e.pid : null, helperInstalled: true });
    case 'ready':
      return set({ helperProblem: null, nativeRunning: true });
    case 'exited':
      return set({ nativeRunning: false, nativePID: null, nativeState: null, incoming: null });
    case 'callState': {
      const state = str(e.state);
      return set({ nativeState: state || null, incoming: state === 'free' ? null : s.incoming });
    }
    case 'popup': {
      const header = str(e.header);
      const content = str(e.content);
      if (header || content) set({ notice: { id: nextId(), title: header || 'Cuộc gọi Zalo', message: content } });
      return;
    }
  }
};

// MARK: - Renderer state (`{page:'main', call:{kind, …}}`)

export const parseGroupCallPicker = (json: Json): GroupCallPicker | null => {
  const token = str(json.token);
  if (!token) return null;
  const group = obj(json.group) ?? {};
  const members = arr(json.members)
    .map(obj)
    .filter((r): r is Json => !!r && !!str(r.id))
    .map((r) => ({ id: str(r.id), name: str(r.name).trim() || 'Người dùng Zalo', avatar: optStr(r.avatar) }));
  return {
    id: token,
    adding: bool(json.add),
    video: typeof json.video === 'boolean' ? json.video : null,
    groupName: str(group.name).trim() || 'Nhóm',
    groupAvatar: optStr(group.avatar),
    maxSelectable: Math.max(0, int(json.max, 10)),
    existing: arr(json.existing).filter((x): x is string => typeof x === 'string'),
    note: optStr(json.note),
    members,
  };
};

const handleCallState = (state: Json) => {
  const json = obj(state.call);
  if (!json) return;
  switch (str(json.kind)) {
    case 'status': {
      const conv = obj(json.conv);
      const id = conv ? str(conv.id) : '';
      const group = conv ? obj(conv.group) : null;
      set({
        rendererReady: bool(json.ready),
        supported: bool(json.supported),
        videoSupported: bool(json.video),
        busy: bool(json.busy),
        conversationId: id || null,
        conversationCanCall: id ? bool(conv!.can) : false,
        conversationGroup: id && group ? { disabled: bool(group.disabled), feature: bool(group.feature) } : null,
      });
      return;
    }
    case 'open': {
      // The call is allowed: show the conversation (the chat box action needs it open).
      const id = str(json.uid);
      if (id && getEngine().openConversationId !== id) setEngine({ navigationRequest: id });
      return;
    }
    case 'result': {
      const message = callFailureMessage(str(json.result), bool(json.group));
      if (str(json.result) && message) showCallNotice('Chưa gọi được', message);
      return;
    }
    case 'incoming': {
      if (bool(json.busy)) return; // the official client auto-declines while in a call; nothing rings
      const s = get();
      if (!s.helperInstalled || s.helperProblem) return; // only when the helper can actually ring
      const name = optStr(json.name);
      const caller = optStr(json.caller);
      const group = bool(json.group);
      const incoming: IncomingCall = {
        id: nextId(),
        name: name ?? caller ?? (group ? 'Cuộc gọi nhóm' : 'Một người bạn'),
        avatar: optStr(json.avatar),
        group,
        caller: group && name ? caller : null,
        date: Date.now(),
      };
      set({ incoming });
      void announceIncomingCall(incoming);
      setTimeout(() => {
        if (get().incoming?.id === incoming.id) set({ incoming: null });
      }, 45_000);
      return;
    }
    case 'picker': {
      const picker = parseGroupCallPicker(json);
      if (picker) {
        set({ picker });
        window.focus();
      }
      return;
    }
    case 'pickerClosed':
      if (get().picker?.id === str(json.token)) set({ picker: null });
      return;
  }
};

/**
 * The native helper shows the ringing window; when the app is in the background a macOS notification tells where to
 * look (the official renderer shows nothing for incoming calls itself). Native notifier (tauri-plugin-notification),
 * only when the user already allowed notifications: an incoming call never triggers the permission prompt.
 */
const announceIncomingCall = async (incoming: IncomingCall) => {
  if (document.hasFocus() || !usesTauri) return;
  try {
    const { isPermissionGranted, sendNotification } = await import('@tauri-apps/plugin-notification');
    if (!(await isPermissionGranted())) return;
    sendNotification({ title: 'Cuộc gọi đến', body: `${incoming.name} đang gọi cho bạn` });
  } catch (e) {
    log(`call notification: ${String(e)}`);
  }
};

// MARK: - Group call picker (GROUP_CALL modal answers)

/** Members whose name contains `query` (case / diacritic insensitive; `đ` folds to `d`). */
export const foldName = (text: string) =>
  text
    .trim()
    .replace(/[đĐ]/g, 'd')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();

export const pickerMembers = (picker: GroupCallPicker, query: string) => {
  const needle = foldName(query);
  return needle ? picker.members.filter((m) => foldName(m.name).includes(needle)) : picker.members;
};

export const pickerLimitMessage = (picker: GroupCallPicker) => `Bạn chỉ có thể mời ${picker.maxSelectable} người khác`;

/** The modal's `onItemClick`: a new item beyond the limit is refused, removing always works. */
export const togglePickerMember = (picker: GroupCallPicker, memberId: string, selection: string[]): { selection: string[]; overLimit: boolean } => {
  if (picker.existing.includes(memberId) || !picker.members.some((m) => m.id === memberId)) return { selection, overLimit: false };
  if (selection.includes(memberId)) return { selection: selection.filter((x) => x !== memberId), overLimit: false };
  if (selection.length >= picker.maxSelectable) return { selection, overLimit: true };
  return { selection: [...selection, memberId], overLimit: false };
};

const pickerCall = async (method: string, ...args: unknown[]): Promise<unknown> => {
  try {
    return await callAdapter('__zaloCall', method, ...args);
  } catch (e) {
    log(`call ${method} → ${String(e)}`);
    return 'missing';
  }
};

/** The user confirmed: runs the modal's `onConfirm` in the renderer (starts the call / answers the helper). */
export const confirmGroupPicker = async (picker: GroupCallPicker, selected: string[]) => {
  if (get().picker?.id !== picker.id) return;
  set({ picker: null });
  const ids = selected.filter((id) => picker.members.some((m) => m.id === id) && !picker.existing.includes(id));
  if (!ids.length || ids.length > picker.maxSelectable) {
    void pickerCall('pickerCancel', picker.id);
    return;
  }
  const result = await pickerCall('pickerConfirm', picker.id, ids);
  if (typeof result !== 'string' || ['started', 'sent', 'cancelled', 'missing'].includes(result)) return;
  if (result === 'stale') {
    showCallNotice('Chưa gọi được', 'Yêu cầu đã hết hạn (cuộc gọi đã kết thúc hoặc có yêu cầu mới). Hãy thử lại.');
  } else {
    const message = callFailureMessage(result, true);
    if (message) showCallNotice('Chưa gọi được', message);
  }
};

/** Cancel / dismiss: `onCancel` — an add-participant request is answered with nobody. */
export const cancelGroupPicker = (picker: GroupCallPicker) => {
  if (get().picker?.id !== picker.id) return;
  set({ picker: null });
  void pickerCall('pickerCancel', picker.id);
};

// MARK: - Wiring

registerStateHandler('call', handleCallState);

void backend().then((b) => b.listen('compola://call-event', handleCallEvent));
