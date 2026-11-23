// Hosts what message actions open, for the conversation on screen only (Swift `MessageActionPresenter`): the
// "Chia sẻ" picker, the official confirms and the "N tin nhắn đã xóa · Khôi phục" snackbar.

import { Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { answerMessageConfirm, dismissDeleteUndo, undoDelete } from '../../engine/messageActions';
import { useEngine, type DeleteUndo } from '../../engine/store';
import { Alert } from '../../ui/Overlays';
import { ForwardSheet } from './ForwardSheet';

export function MessageActionPresenter({ conversationId }: { conversationId: string }) {
  const forward = useEngine((s) => (s.forwardRequest?.conversationId === conversationId ? s.forwardRequest : null));
  const confirm = useEngine((s) => (s.messageConfirm?.conversationId === conversationId ? s.messageConfirm : null));
  const undo = useEngine((s) => (s.deleteUndo?.conversationId === conversationId ? s.deleteUndo : null));
  return (
    <>
      {forward && <ForwardSheet request={forward} />}
      {confirm && (
        <Alert
          title={confirm.title}
          message={confirm.message}
          buttons={[
            { label: confirm.ok, role: confirm.destructive ? 'destructive' : 'default', onClick: () => answerMessageConfirm(confirm, true) },
            { label: confirm.cancel, role: 'cancel', onClick: () => answerMessageConfirm(confirm, false) },
          ]}
        />
      )}
      {undo && <DeleteUndoBar undo={undo} />}
    </>
  );
}

function DeleteUndoBar({ undo }: { undo: DeleteUndo }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.ceil((undo.deadline - now) / 1000));
  return (
    <div className="undo-bar glass slide-up">
      <Trash2 size={13} className="secondary" />
      <span>{undo.count} tin nhắn đã xóa</span>
      <button className="btn btn-glass btn-small" onClick={() => void undoDelete()}>
        Khôi phục ({left})
      </button>
      <button className="icon-button" style={{ width: 22, height: 22 }} title="Xóa ngay" aria-label="Đóng" onClick={dismissDeleteUndo}>
        <X size={13} />
      </button>
    </div>
  );
}
