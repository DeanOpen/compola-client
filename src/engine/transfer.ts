// Phone → PC message transfer (Swift `ZaloEngine+Transfer.swift`), bridged to `transfer-adapter.js`
// (`window.__zaloTransfer`). The adapter reports the official sync state machine; the engine only mirrors it.

import { fireAdapter } from './call';
import { registerStateHandler } from './dispatch';
import { bool, obj, optStr, type Json } from './models/json';
import { getEngine, setEngine } from './store';

export type TransferPhase = 'offer' | 'waitingForPhone' | 'transferring' | 'finished' | 'failed';

export interface MessageTransferState {
  phase: TransferPhase;
  /** Failed phase: the Vietnamese reason. */
  failure: string | null;
  /** 0…1 when known. */
  progress: number | null;
  syncedConversations: number;
  totalConversations: number | null;
  message: string | null;
  stage: string | null;
  stageIndex: number | null;
  stageCount: number | null;
  stageProgress: number | null;
  receivedMessages: number | null;
  errorCode: number | null;
  errorName: string | null;
  canRetry: boolean;
}

const optNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const clamp01 = (v: number | null) => (v == null ? null : Math.min(1, Math.max(0, v)));

/** Why "Đồng bộ ngay" is off, for the official `canSync` result name. */
export const transferBlockedText = (reason: string): string => {
  switch (reason) {
    case 'INVALID_STATE':
    case 'SYNC_RUNNING':
      return 'Zalo đang tự đồng bộ với điện thoại. Bạn có thể đồng bộ lại khi xong.';
    case 'WORKER_NOT_READY':
      return 'Zalo đang chuẩn bị dữ liệu, hãy chờ giây lát.';
    case 'DB_MIGRATING':
      return 'Zalo đang sắp xếp lại dữ liệu trên máy, hãy chờ giây lát.';
    case 'MOBILE_NOT_SUPPORT':
      return 'Zalo trên điện thoại chưa hỗ trợ đồng bộ này. Hãy cập nhật Zalo trên điện thoại.';
    case 'DISABLED':
    case 'SYNC_SRC_DISABLED':
      return 'Tài khoản này chưa được Zalo bật đồng bộ tin nhắn từ điện thoại.';
    case 'NO_PERMISSION':
      return 'Thiết bị này chưa được phép đồng bộ tin nhắn.';
    default:
      return 'Chưa thể đồng bộ lúc này, hãy thử lại sau.';
  }
};

/** Vietnamese wording for the official sync error codes; unknown codes fall back to the code. */
export const transferErrorText = (code: number | null, name: string | null): string => {
  switch (name ?? '') {
    case 'NO_NETWORK':
    case 'ERR_CONNECTION_TIMED_OUT':
    case 'REQUEST_SOCKET_CLOSED':
      return 'Không có kết nối mạng. Hãy kiểm tra mạng rồi thử lại.';
    case 'MOBILE_LOW_STORAGE':
      return 'Bộ nhớ điện thoại không đủ để đồng bộ.';
    case 'PC_LOW_STORAGE':
      return 'Bộ nhớ trên máy tính không đủ để đồng bộ.';
    case 'MOBILE_BUSY':
    case 'MOBILE_BUSY_SYNCING':
    case 'MOBILE_BUSY_MANUAL_BACKUP':
      return 'Điện thoại đang bận. Hãy thử lại sau ít phút.';
    case 'MOBILE_LOGGED_OUT':
      return 'Zalo trên điện thoại đã đăng xuất.';
    case 'USER_REJECT_BACKUP':
    case 'MOBILE_USER_CANCELS_SYNC':
      return 'Yêu cầu đồng bộ đã bị từ chối trên điện thoại.';
    case 'USER_DONT_CONFIRM':
    case 'SYNC_REQUEST_TIMEOUT_NO_NEED_CONFIRM':
    case 'MOBILE_DONT_AUTO_CONFIRM':
    case 'REQUEST_TIMEOUT':
      return 'Điện thoại chưa xác nhận yêu cầu đồng bộ.';
    case 'MOBILE_IDLE_TIMEOUT':
    case 'WAKE_UP_TIMEOUT':
      return 'Zalo trên điện thoại đã ngừng phản hồi. Hãy mở Zalo trên điện thoại rồi thử lại.';
    case 'BATCH_TIMEOUT':
    case 'DOWNLOAD_TIMEOUT':
      return 'Quá trình đồng bộ bị gián đoạn do quá thời gian chờ.';
    case 'CLIENT_NOT_SUPPORT':
      return 'Phiên bản Zalo trên điện thoại chưa hỗ trợ đồng bộ này.';
    default:
      return code != null ? `Đồng bộ không thành công (mã lỗi ${code}).` : 'Đồng bộ không thành công.';
  }
};

export const waitingDetail = (t: MessageTransferState): string => {
  switch (t.stage) {
    case 'confirmMobile':
      return 'Yêu cầu đồng bộ đã được gửi. Hãy chấp nhận yêu cầu trong thông báo của Zalo trên điện thoại.';
    case 'waitForBackup':
      return 'Điện thoại đang chuẩn bị dữ liệu tin nhắn. Hãy giữ Zalo mở trên điện thoại.';
    default:
      return 'Mở ứng dụng Zalo trên điện thoại, sau đó chọn xác nhận đồng bộ tin nhắn sang máy tính.';
  }
};

export const stageTitle = (t: MessageTransferState): string => {
  switch (t.stage) {
    case 'conversationList':
      return 'Đang tải danh sách hội thoại';
    case 'messages':
      return 'Đang đồng bộ tin nhắn gần đây';
    case 'otherMessages':
      return 'Đang đồng bộ các tin nhắn cũ hơn';
    case 'downloading':
      return 'Đang tải dữ liệu từ điện thoại';
    case 'decrypting':
      return 'Đang giải mã dữ liệu';
    case 'restoring':
      return 'Đang khôi phục tin nhắn';
    default:
      return 'Đang đồng bộ';
  }
};

/** "Đã nhận X tin nhắn / X cuộc trò chuyện" with only the numbers the client reported. */
export const transferCountText = (t: MessageTransferState): string | null => {
  if (t.receivedMessages && t.receivedMessages > 0) return `Đã nhận ${t.receivedMessages.toLocaleString('vi-VN')} tin nhắn`;
  if (t.totalConversations && t.totalConversations > 0) return `Đã nhận ${t.syncedConversations}/${t.totalConversations} cuộc trò chuyện`;
  if (t.syncedConversations > 0) return `Đã nhận ${t.syncedConversations} cuộc trò chuyện`;
  return null;
};

const PHASES: TransferPhase[] = ['offer', 'waitingForPhone', 'transferring', 'finished', 'failed'];

export const handleTransfer = (state: Json) => {
  const json = obj(state.transfer);
  const phase = json?.phase as TransferPhase | undefined;
  if (!json || !phase || !PHASES.includes(phase)) {
    setEngine({ transfer: null });
    return;
  }
  const errorCode = optNum(json.errorCode);
  const errorName = optStr(json.errorName);
  setEngine({
    transfer: {
      phase,
      failure: phase === 'failed' ? transferErrorText(errorCode, errorName) : null,
      progress: clamp01(optNum(json.progress)),
      syncedConversations: optNum(json.syncedConversations) ?? 0,
      totalConversations: optNum(json.totalConversations),
      message: optStr(json.message),
      stage: optStr(json.stage),
      stageIndex: optNum(json.stageIndex),
      stageCount: optNum(json.stageCount),
      stageProgress: clamp01(optNum(json.stageProgress)),
      receivedMessages: optNum(json.receivedMessages),
      errorCode,
      errorName,
      canRetry: bool(json.canRetry),
    },
  });
};

export const handleTransferAvailability = (state: Json) => {
  const json = obj(state.transferAvailable) ?? {};
  setEngine({ canStartTransfer: bool(json.canStart), transferStartBlockedReason: optStr(json.reason) });
};

registerStateHandler('transfer', handleTransfer);
registerStateHandler('transferAvailable', handleTransferAvailability);

/** Offer: accept = "Đồng bộ ngay", decline = "Để sau". Failed: accept = retry. Waiting/transferring: decline cancels. */
export const respondToTransfer = (accept: boolean) =>
  fireAdapter('__zaloTransfer', 'respond', accept, getEngine().transfer?.phase ?? null);

export const dismissTransfer = () => {
  fireAdapter('__zaloTransfer', 'dismiss', getEngine().transfer?.phase ?? null);
  setEngine({ transfer: null });
};

/** Manual start, the official Settings card's call (sync-v2 `sync(SETTING)`). */
export const startTransfer = () => fireAdapter('__zaloTransfer', 'start');
