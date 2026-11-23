// "Quản lý thẻ phân loại" (Swift `LabelManagerView` + `LabelEditor`): the official label manager's list — add, rename /
// recolour, delete, reorder — through `window.__zaloConversations` (the official `_label` manager, synced to the server).
// Results come back as the extras' `notice` (seq, ok, text).

import { ArrowDown, ArrowUp, Check, Pencil, Plus, Tag, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { createConversationLabel, deleteConversationLabel, reorderConversationLabels, updateConversationLabel } from '../../engine/conversations';
import { cssColor, type ConversationLabel } from '../../engine/models/conversations';
import { useEngine } from '../../engine/store';
import { ContentUnavailable } from '../../ui/ContentUnavailable';
import { Alert, Sheet, SheetHeader } from '../../ui/Overlays';

const useLabelManager = create<{ open: boolean }>(() => ({ open: false }));
export const openLabelManager = () => useLabelManager.setState({ open: true });
const close = () => useLabelManager.setState({ open: false });

type Edit = { kind: 'new' } | { kind: 'existing'; label: ConversationLabel };

export function LabelManagerHost() {
  const open = useLabelManager((s) => s.open);
  return open ? <LabelManager /> : null;
}

function LabelManager() {
  const extras = useEngine((s) => s.extras);
  const [editing, setEditing] = useState<Edit | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ConversationLabel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const baseSeq = useRef(extras.notice?.seq ?? 0);

  // Deletes / reorders report here; create and rename report through their editor.
  useEffect(() => {
    const n = extras.notice;
    if (editing || !n || n.seq <= baseSeq.current) return;
    baseSeq.current = n.seq;
    setError(n.ok ? null : n.text);
  }, [extras.notice, editing]);

  const move = (index: number, by: number) => {
    const ids = extras.labels.map((l) => l.id);
    const [id] = ids.splice(index, 1);
    ids.splice(index + by, 0, id);
    reorderConversationLabels(ids);
  };

  return (
    <Sheet onClose={close} width={460} height={460}>
      <SheetHeader title={`Quản lý thẻ phân loại · ${extras.labels.length}/${extras.limits.maxLabels}`} onClose={close} />
      <div className="lm-toolbar">
        <button className="btn btn-prominent btn-small" disabled={extras.labels.length >= extras.limits.maxLabels} onClick={() => setEditing({ kind: 'new' })}>
          <Plus size={14} /> Thêm phân loại
        </button>
      </div>
      {extras.labels.length === 0 ? (
        <ContentUnavailable icon={Tag} title="Chưa có phân loại" description="Tạo thẻ phân loại để ghi nhớ & nhận biết hội thoại dễ dàng hơn" />
      ) : (
        <div className="lm-list">
          {extras.labels.map((label, i) => (
            <div key={label.id} className="lm-row">
              <span className="lm-dot" style={{ background: cssColor(label.colorHex) ?? 'var(--accent)' }} />
              <span className="lm-text">
                <span className="truncate">{label.name}</span>
                <span className="lm-count">{label.convIds.length} hội thoại</span>
              </span>
              <button className="icon-button lm-icon" disabled={i === 0} onClick={() => move(i, -1)} title="Lên" aria-label="Lên">
                <ArrowUp size={14} />
              </button>
              <button className="icon-button lm-icon" disabled={i === extras.labels.length - 1} onClick={() => move(i, 1)} title="Xuống" aria-label="Xuống">
                <ArrowDown size={14} />
              </button>
              <button className="icon-button lm-icon" onClick={() => setEditing({ kind: 'existing', label })} title="Sửa phân loại" aria-label="Sửa phân loại">
                <Pencil size={14} />
              </button>
              <button className="icon-button lm-icon is-danger" onClick={() => setPendingDelete(label)} title="Xóa phân loại" aria-label="Xóa phân loại">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      {error && <div className="lm-error">{error}</div>}
      {editing && <LabelEditor edit={editing} onClose={() => setEditing(null)} />}
      {pendingDelete && (
        <Alert
          title="Xóa thẻ phân loại?"
          message={`Phân loại "${pendingDelete.name}" sẽ bị xóa khỏi mọi hội thoại.`}
          buttons={[
            {
              label: 'Xóa phân loại',
              role: 'destructive',
              onClick: () => {
                deleteConversationLabel(pendingDelete.id);
                setPendingDelete(null);
              },
            },
            { label: 'Không', role: 'cancel', onClick: () => setPendingDelete(null) },
          ]}
        />
      )}
    </Sheet>
  );
}

function LabelEditor({ edit, onClose }: { edit: Edit; onClose: () => void }) {
  const extras = useEngine((s) => s.extras);
  const existing = edit.kind === 'existing' ? edit.label : null;
  const [name, setName] = useState(existing?.name ?? '');
  const [color, setColor] = useState(existing?.colorHex ?? extras.limits.palette[0] ?? '#0068FF');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const baseSeq = useRef(extras.notice?.seq ?? 0);
  const trimmed = name.trim();

  useEffect(() => {
    const n = extras.notice;
    if (!submitting || !n || n.seq <= baseSeq.current) return;
    if (n.ok) onClose();
    else {
      setError(n.text);
      setSubmitting(false);
    }
  }, [extras.notice, submitting, onClose]);

  const submit = () => {
    if (!trimmed || submitting) return;
    setSubmitting(true);
    baseSeq.current = extras.notice?.seq ?? 0;
    if (existing) updateConversationLabel(existing.id, trimmed, color);
    else createConversationLabel(trimmed, color);
  };

  return (
    <Sheet onClose={onClose} width={380}>
      <SheetHeader title={existing ? 'Sửa thẻ phân loại' : 'Thêm mới thẻ phân loại'} onClose={onClose} />
      <div className="lm-editor">
        <label className="lm-field">
          <span className="secondary">Tên thẻ phân loại</span>
          <input
            className="text-field"
            autoFocus
            value={name}
            placeholder="Nhập tên thẻ phân loại"
            onChange={(e) => {
              setName(e.target.value.slice(0, extras.limits.maxNameLength));
              setError(null);
            }}
            onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && submit()}
          />
          <span className="lm-count">
            {name.length}/{extras.limits.maxNameLength}
          </span>
        </label>
        <div className="lm-field">
          <span className="secondary">Màu</span>
          <div className="lm-palette">
            {extras.limits.palette.map((hex) => (
              <button key={hex} className="lm-swatch" style={{ background: cssColor(hex) ?? '#888' }} onClick={() => setColor(hex)} aria-label={hex} aria-pressed={hex.toLowerCase() === color.toLowerCase()}>
                {hex.toLowerCase() === color.toLowerCase() && <Check size={12} strokeWidth={3} color="#fff" />}
              </button>
            ))}
          </div>
        </div>
        {error && <div className="lm-error">{error}</div>}
      </div>
      <div className="sheet-footer">
        <span />
        <button className="btn btn-glass" onClick={onClose}>
          Hủy
        </button>
        <button className="btn btn-prominent" disabled={!trimmed || submitting} onClick={submit}>
          {existing ? 'Lưu' : 'Thêm'}
        </button>
      </div>
    </Sheet>
  );
}
