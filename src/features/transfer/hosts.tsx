// Phone → PC sync over the main window (Swift `.overlay { TransferOverlay() }`).

import { startTransfer } from '../../engine/transfer';
import { TransferOverlay } from './TransferView';

export function TransferHosts() {
  return <TransferOverlay />;
}

/**
 * Opens the phone → PC sync (account menu "Đồng bộ tin nhắn từ điện thoại…"): starts a manual sync like the official
 * Settings card; the official state machine then drives the overlay (waiting for the phone → transferring → result).
 */
export const openTransfer = () => startTransfer();
