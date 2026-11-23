import { dismissToast } from '../engine/toast';
import { useEngine } from '../engine/store';
import './ui.css';

/**
 * The notice of `showToast` when it belongs here: `conversationId` = the chat on screen, null = app-wide. A dark pill at
 * the bottom centre, with its optional action ("Hoàn tác") inline.
 */
export function ToastView({ conversationId, bottom = 90 }: { conversationId: string | null; bottom?: number }) {
  const toast = useEngine((s) => s.toast);
  if (!toast || toast.conversationId !== conversationId) return null;
  const action = toast.action;
  return (
    <div key={toast.seq} className={`toast glass-strong slide-up ${action ? 'has-action' : ''}`} style={{ bottom }} role="status">
      <span className="toast-text">{toast.text}</span>
      {action && (
        <button
          className="toast-action"
          onClick={() => {
            dismissToast();
            action.run();
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
