// The screens of one hidden-chat PIN flow and how they lead into each other (Swift `HiddenChatFlow`, pure): official
// modal HIDDEN_CHAT (SCREEN_POPUP_HIDDEN_CHAT) and the settings entry. The PIN is 4 digits; only kept in memory
// between "enter" and "confirm".

export type FlowKind =
  | { kind: 'hide'; id: string }
  /** `requiresPIN` false = opened with the PIN already (official UNHIDE_CONV, a plain confirmation). */
  | { kind: 'unhide'; id: string; requiresPIN: boolean }
  | { kind: 'open'; id: string }
  | { kind: 'setPIN' }
  | { kind: 'changePIN' }
  | { kind: 'resetPIN' };

export type Screen =
  | 'introduce'
  | 'createPIN'
  | 'confirmPIN'
  | 'enterPIN'
  | 'unhideConfirm'
  | 'oldPIN'
  | 'newPIN'
  | 'repeatPIN'
  | 'resetConfirm'
  | 'hideSuccess'
  | 'setPINSuccess'
  | 'changeSuccess';

export type Step =
  | { kind: 'none' }
  | { kind: 'hide'; pin: string }
  | { kind: 'hideWithNewPIN'; pin: string }
  | { kind: 'unhide'; pin: string | null }
  | { kind: 'verifyToOpen'; pin: string }
  | { kind: 'verifyOld'; pin: string }
  | { kind: 'setPIN'; pin: string; changed: boolean };

export interface Flow {
  kind: FlowKind;
  screen: Screen;
  error: string | null;
  /** First entry of a new PIN while the confirmation is pending (memory only). */
  pending: string | null;
}

export const wrongPIN = 'Mã PIN không đúng. Vui lòng thử lại.';
export const pinAlreadySet = 'Đã có mã PIN cho trò chuyện ẩn. Hãy dùng “Đổi mã PIN” nếu muốn đổi.';

export const startFlow = (kind: FlowKind, hasPIN: boolean): Flow => {
  const screen: Screen =
    kind.kind === 'hide'
      ? hasPIN
        ? 'enterPIN'
        : 'introduce'
      : kind.kind === 'unhide'
        ? kind.requiresPIN
          ? 'enterPIN'
          : 'unhideConfirm'
        : kind.kind === 'open'
          ? 'enterPIN'
          : kind.kind === 'setPIN'
            ? 'createPIN'
            : kind.kind === 'changePIN'
              ? 'oldPIN'
              : 'resetConfirm';
  return { kind, screen, error: null, pending: null };
};

export const conversationOf = (f: Flow): string | null => ('id' in f.kind ? f.kind.id : null);

/** Official `_getTitle`. */
export const flowTitle = (f: Flow): string => {
  switch (f.screen) {
    case 'introduce':
      return 'Ẩn trò chuyện';
    case 'createPIN':
      return 'Đặt mã PIN';
    case 'confirmPIN':
      return 'Xác nhận lại mã PIN';
    case 'enterPIN':
      return f.kind.kind === 'hide' ? 'Nhập mã PIN để ẩn trò chuyện' : f.kind.kind === 'open' ? 'Nhập mã PIN để mở trò chuyện' : 'Bỏ ẩn trò chuyện';
    case 'unhideConfirm':
      return 'Bỏ ẩn trò chuyện';
    case 'oldPIN':
    case 'newPIN':
    case 'repeatPIN':
      return 'Đổi mã PIN';
    case 'resetConfirm':
      return 'Đặt lại mã PIN';
    case 'hideSuccess':
      return 'Ẩn trò chuyện thành công';
    case 'setPINSuccess':
      return 'Cài đặt mã PIN thành công';
    case 'changeSuccess':
      return 'Đổi mã PIN thành công';
  }
};

export const takesPIN = (f: Flow) => ['createPIN', 'confirmPIN', 'enterPIN', 'oldPIN', 'newPIN', 'repeatPIN'].includes(f.screen);

/** A PIN was typed on the current screen: the next flow state and what to run. */
export const submitPIN = (f: Flow, pin: string): [Flow, Step] => {
  switch (f.screen) {
    case 'createPIN':
      return [{ ...f, pending: pin, error: null, screen: 'confirmPIN' }, { kind: 'none' }];
    case 'confirmPIN':
      if (pin !== f.pending) return [{ ...f, error: wrongPIN }, { kind: 'none' }];
      return [{ ...f, error: null }, f.kind.kind === 'setPIN' ? { kind: 'setPIN', pin, changed: false } : { kind: 'hideWithNewPIN', pin }];
    case 'enterPIN':
      if (f.kind.kind === 'hide') return [f, { kind: 'hide', pin }];
      if (f.kind.kind === 'unhide') return [f, { kind: 'unhide', pin }];
      if (f.kind.kind === 'open') return [f, { kind: 'verifyToOpen', pin }];
      return [f, { kind: 'none' }];
    case 'oldPIN':
      return [f, { kind: 'verifyOld', pin }];
    case 'newPIN':
      return [{ ...f, pending: pin, error: null, screen: 'repeatPIN' }, { kind: 'none' }];
    case 'repeatPIN':
      if (pin !== f.pending) return [{ ...f, error: wrongPIN }, { kind: 'none' }];
      return [{ ...f, error: null }, { kind: 'setPIN', pin, changed: true }];
    default:
      return [f, { kind: 'none' }];
  }
};

export const back = (f: Flow): Flow => ({
  ...f,
  pending: null,
  error: null,
  screen: f.screen === 'repeatPIN' ? 'newPIN' : f.screen === 'confirmPIN' ? 'createPIN' : f.screen,
});

/** The page refused to set a PIN because one exists (this view was stale): ask for it, never overwrite it. */
export const pinAlreadyExists = (f: Flow): Flow =>
  f.kind.kind === 'hide' ? { ...f, pending: null, error: null, screen: 'enterPIN' } : { ...f, pending: null, error: pinAlreadySet };

/** The work finished: the success screen of the kind, or null (nothing more to show, close). */
export const succeeded = (f: Flow): Flow | null => {
  const base = { ...f, pending: null, error: null };
  if (f.kind.kind === 'hide' && f.screen === 'confirmPIN') return { ...base, screen: 'hideSuccess' };
  if (f.kind.kind === 'setPIN') return { ...base, screen: 'setPINSuccess' };
  if (f.kind.kind === 'changePIN') return { ...base, screen: 'changeSuccess' };
  return null;
};
