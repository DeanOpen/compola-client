// The official "Tạo bình chọn" popup (Swift `PollCreateSheet`): question, options, advanced settings. Nothing is sent
// until the "Tạo bình chọn" button.

import { AlertTriangle, ChevronDown, ChevronRight, Info, Plus, X, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { prefixUTF16 } from '../../engine/models/cardSheets';
import {
  createDraft,
  createIssue,
  createIssueText,
  defaultPollConfig,
  effectiveAllowAdd,
  filledOptions,
  isDuplicateOption,
  pollActionMessage,
  type PollCapabilities,
  type PollCreateDraft,
} from '../../engine/models/poll';
import { createPoll, pollCapabilities } from '../../engine/poll';
import { showToast } from '../../engine/toast';
import { Alert, Sheet } from '../../ui/Overlays';
import { Spinner } from '../../ui/Spinner';
import { ToastView } from '../../ui/Toast';
import { SwitchRow } from './PollParts';
import './dialog.css';
import './poll.css';

const two = (n: number) => String(n).padStart(2, '0');
/** Epoch ms ↔ `<input type="datetime-local">` value (local time). */
const toLocalInput = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
};

export function PollCreateSheet({ conversationId, onClose }: { conversationId: string; onClose: () => void }) {
  const [caps, setCaps] = useState<PollCapabilities>({ ready: false, canCreate: false, canPin: false, config: defaultPollConfig });
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState<PollCreateDraft>(() => createDraft());
  const [showSettings, setShowSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const live = useRef(true);
  const optionRefs = useRef<(HTMLInputElement | null)[]>([]);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);

  const config = caps.config;
  const issue = createIssue(draft, config);
  const isDirty = draft.question.trim().length > 0 || filledOptions(draft).length > 0;

  useEffect(() => {
    live.current = true;
    void pollCapabilities(conversationId).then((c) => {
      if (!live.current) return;
      setCaps(c);
      setLoaded(true);
      setDraft((d) => (d.options.length < c.config.minOptions ? { ...d, options: [...d.options, ...Array(c.config.minOptions - d.options.length).fill('')] } : d));
    });
    return () => {
      live.current = false;
    };
  }, [conversationId]);

  useEffect(() => {
    if (focusIndex !== null) optionRefs.current[focusIndex]?.focus();
  }, [focusIndex]);

  const update = (patch: Partial<PollCreateDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const setOption = (i: number, text: string) => setDraft((d) => ({ ...d, options: d.options.map((o, j) => (j === i ? prefixUTF16(text, config.maxOption) : o)) }));
  const addOption = () => {
    setDraft((d) => ({ ...d, options: [...d.options, ''] }));
    setFocusIndex(draft.options.length);
  };

  const requestClose = () => (isDirty ? setConfirmDiscard(true) : onClose());

  /** WRITE: runs only from the "Tạo bình chọn" button. */
  const create = async () => {
    if (issue || !caps.canCreate || busy) return;
    setBusy(true);
    setMessage(null);
    const result = await createPoll(conversationId, draft, config, caps.canPin);
    if (!live.current) return;
    setBusy(false);
    if (result.ok) {
      if (result.pinSkipped) {
        showToast('Đã tạo bình chọn nhưng chưa ghim được (bảng ghim đã đầy hoặc chưa kiểm tra được). Bạn có thể ghim từ menu bình chọn.', conversationId);
      }
      onClose();
    } else setMessage(pollActionMessage(result, 'create'));
  };

  const hint = createIssueText(issue);
  const anyDuplicate = draft.options.some((_, i) => isDuplicateOption(draft, i));

  return (
    <Sheet onClose={requestClose} width={460} height={580}>
      <div className="zp-dialog poll-sheet">
        <div className="zp-dialog-header">
          <div className="zp-dialog-title">Tạo bình chọn</div>
          <button className="zp-icon-btn" onClick={requestClose} aria-label="Đóng" title="Đóng">
            <X size={15} />
          </button>
        </div>
        <div className="zp-dialog-body">
          <div className="poll-form">
            {loaded && !caps.ready ? (
              <Notice text="Chưa đọc được thông tin nhóm hoặc dịch vụ bình chọn của Zalo." />
            ) : loaded && !caps.canCreate ? (
              <Notice text="Chỉ trưởng/phó nhóm được phép tạo bình chọn" />
            ) : null}
            <div className="poll-field">
              <div className="poll-field-label">Chủ đề bình chọn</div>
              <textarea
                className="zp-input poll-textarea"
                rows={2}
                placeholder="Nội dung bình chọn?"
                value={draft.question}
                autoFocus
                onChange={(e) => update({ question: prefixUTF16(e.target.value, config.maxQuestion) })}
              />
            </div>
            <div className="poll-field">
              <div className="poll-field-label">Các lựa chọn</div>
              {draft.options.map((text, index) => (
                <div key={index} className="poll-added">
                  <div className="poll-added-row">
                    <input
                      ref={(el) => {
                        optionRefs.current[index] = el;
                      }}
                      className="zp-input poll-input"
                      placeholder={`Lựa chọn ${index + 1}`}
                      value={text}
                      onChange={(e) => setOption(index, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                        e.preventDefault();
                        if (index === draft.options.length - 1 && text.trim() && draft.options.length < config.maxOptions && !isDuplicateOption(draft, index)) addOption();
                        else optionRefs.current[index + 1]?.focus();
                      }}
                    />
                    {draft.options.length > config.minOptions && (
                      <button
                        className="zp-icon-btn poll-remove"
                        onClick={() => setDraft((d) => ({ ...d, options: d.options.filter((_, j) => j !== index) }))}
                        aria-label="Xóa lựa chọn"
                        title="Xóa lựa chọn"
                      >
                        <XCircle size={15} />
                      </button>
                    )}
                  </div>
                  {isDuplicateOption(draft, index) && <div className="poll-field-error">Bạn đã tạo trùng phương án.</div>}
                </div>
              ))}
              <button className="zp-btn zp-btn-secondary zp-btn-small poll-add" disabled={draft.options.length >= config.maxOptions || anyDuplicate} onClick={addOption}>
                <Plus size={14} /> Thêm lựa chọn
              </button>
            </div>
            <button className="poll-disclosure" onClick={() => setShowSettings((s) => !s)} aria-expanded={showSettings}>
              {showSettings ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Thiết lập nâng cao
            </button>
            {showSettings && (
              <div className="poll-settings-group">
                <SwitchRow label="Thời hạn bình chọn" checked={draft.hasDeadline} onChange={(on) => update({ hasDeadline: on })} />
                {draft.hasDeadline ? (
                  <label className="poll-switch-row">
                    <span className="poll-switch-label">Kết thúc lúc</span>
                    <input
                      type="datetime-local"
                      className="zp-input poll-date"
                      value={toLocalInput(draft.deadline)}
                      min={toLocalInput(Date.now())}
                      onChange={(e) => {
                        const ms = new Date(e.target.value).getTime();
                        if (Number.isFinite(ms)) update({ deadline: ms });
                      }}
                    />
                  </label>
                ) : (
                  <div className="poll-hint">Không thời hạn</div>
                )}
                <div className="poll-divider" />
                <SwitchRow label="Ghim lên đầu trò chuyện" checked={draft.pin} disabled={!caps.canPin} onChange={(on) => update({ pin: on })} />
                <SwitchRow
                  label="Chọn nhiều phương án"
                  checked={draft.multi}
                  onChange={(on) => update({ multi: on })}
                  help="Người tham gia có thể bình chọn nhiều phương án khác nhau"
                />
                <SwitchRow
                  label="Có thể thêm phương án"
                  checked={effectiveAllowAdd(draft)}
                  disabled={draft.hidePreview}
                  onChange={(on) => update({ allowAdd: on })}
                  help="Người tham gia có thể thêm phương án mới"
                />
                {(config.enableHidePreview || config.enableAnonymous) && (
                  <>
                    <div className="poll-divider" />
                    <div className="poll-field-label">Bình chọn ẩn danh</div>
                    {config.enableHidePreview && (
                      <SwitchRow
                        label="Ẩn kết quả khi chưa bình chọn"
                        checked={draft.hidePreview}
                        onChange={(on) => update({ hidePreview: on })}
                        help="Người tham gia chỉ có thể thấy kết quả sau khi bình chọn."
                      />
                    )}
                    {config.enableAnonymous && (
                      <SwitchRow
                        label="Ẩn người bình chọn"
                        checked={draft.anonymous}
                        onChange={(on) => update({ anonymous: on })}
                        help="Người tham gia không thể thấy người khác bình chọn."
                      />
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="zp-dialog-footer">
          {message ? (
            <div className="poll-error">
              <AlertTriangle size={13} /> {message}
            </div>
          ) : hint ? (
            <div className="poll-hint">{hint}</div>
          ) : null}
          <div className="zp-dialog-buttons">
            <button className="zp-btn zp-btn-secondary" onClick={requestClose}>
              Hủy
            </button>
            <button className="zp-btn zp-btn-primary" disabled={!!issue || !caps.canCreate || busy} onClick={() => void create()}>
              {busy ? <Spinner size={13} /> : 'Tạo bình chọn'}
            </button>
          </div>
        </div>
        <ToastView conversationId={conversationId} bottom={64} />
      </div>
      {confirmDiscard && (
        <Alert
          title="Bạn muốn hủy tạo bình chọn?"
          buttons={[
            { label: 'Hủy tạo bình chọn', role: 'destructive', onClick: () => (setConfirmDiscard(false), onClose()) },
            { label: 'Không', role: 'cancel', onClick: () => setConfirmDiscard(false) },
          ]}
        />
      )}
    </Sheet>
  );
}

function Notice({ text }: { text: string }) {
  return (
    <div className="poll-notice">
      <Info size={14} /> {text}
    </div>
  );
}
