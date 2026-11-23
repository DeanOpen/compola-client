import { useEngine } from '../engine/store';
import './ui.css';

/** The notice of `showToast` when it belongs here: `conversationId` = the chat on screen, null = app-wide. */
export function ToastView({ conversationId, bottom = 90 }: { conversationId: string | null; bottom?: number }) {
  const toast = useEngine((s) => s.toast);
  if (!toast || toast.conversationId !== conversationId) return null;
  return (
    <div key={toast.seq} className="toast glass-strong slide-up" style={{ bottom }} role="status">
      {toast.text}
    </div>
  );
}
