// The official "Bình chọn" popup (Swift `PollDetailSheet`): question, settings, options with checkboxes, "Thêm lựa
// chọn", and "Chi tiết bình chọn" (who voted for what). Every write starts from a button press.

import { AlertTriangle, ChevronLeft, ChevronRight, ClockAlert, Lock, MoreHorizontal, Pin, PinOff, Plus, Share2, Users, X, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  addRow,
  applyDraft,
  defaultPollConfig,
  draftHasChanges,
  draftHasDuplicates,
  draftVotesNothing,
  formatPollDay,
  isDuplicateAdded,
  isPollExpired,
  isVotingLocked,
  offersPin,
  optionWeight,
  pinConfirmMessage,
  pollActionMessage,
  removeAdded,
  resultsHidden,
  setAddedText,
  setAddedVoted,
  toggleOption,
  unknownPinState,
  voteDraft,
  votersVisible,
  type PollConfig,
  type PollDetail,
  type PollPinConfirm,
  type PollVoteDraft,
  type PollVoters,
} from '../../engine/models/poll';
import { prefixUTF16 } from '../../engine/models/cardSheets';
import { lockPoll, pinPoll, pollCapabilities, pollVoters, refreshPollPin, retryPoll, sharePoll, unpinPoll, usePolls, votePoll, watchPoll } from '../../engine/poll';
import { Avatar } from '../../ui/Avatar';
import { openMenuBelow } from '../../ui/Menu';
import { Alert, Sheet } from '../../ui/Overlays';
import { Spinner } from '../../ui/Spinner';
import { ToastView } from '../../ui/Toast';
import { ChoiceMark, PollOptionRow, PollSettingsLine } from './PollParts';
import './dialog.css';
import './poll.css';

type Confirm = 'lock' | 'hide' | 'exit' | { pin: PollPinConfirm } | null;

export function PollDetailSheet({
  pollId,
  conversationId,
  question,
  startOnVoters = false,
  onClose,
}: {
  pollId: string;
  conversationId: string;
  question: string;
  startOnVoters?: boolean;
  onClose: () => void;
}) {
  const detail = usePolls((s) => s.details[pollId]);
  const failed = usePolls((s) => s.failed.has(pollId));
  const pinState = usePolls((s) => s.pins[pollId]) ?? unknownPinState;
  const [draft, setDraft] = useState<PollVoteDraft | null>(null);
  const [config, setConfig] = useState<PollConfig>(defaultPollConfig);
  const [showVoters, setShowVoters] = useState(startOnVoters);
  const [voters, setVoters] = useState<PollVoters | null>(null);
  const [votersFailed, setVotersFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const live = useRef(true);
  const votersRef = useRef<PollVoters | null>(null);

  useEffect(() => {
    live.current = true;
    watchPoll(pollId, conversationId);
    void pollCapabilities(conversationId).then((c) => live.current && setConfig(c.config));
    void refreshPollPin(pollId, conversationId);
    return () => {
      live.current = false;
    };
  }, [pollId, conversationId]);

  // Live updates replace an untouched draft; edits in progress are kept.
  useEffect(() => {
    if (detail && (!draft || !draftHasChanges(draft))) setDraft(voteDraft(detail));
    // The faces next to each option come from the voter list (read-only), when the poll lets me see it.
    if (detail && (showVoters || votersVisible(detail))) void loadVoters();
  }, [detail]);

  useEffect(() => {
    if (showVoters) void loadVoters();
  }, [showVoters]);

  const loadVoters = async () => {
    setVotersFailed(false);
    const next = await pollVoters(pollId);
    if (!live.current) return;
    if (next) {
      votersRef.current = next;
      setVoters(next);
    } else if (!votersRef.current) setVotersFailed(true);
  };

  const editingLocked = detail ? isVotingLocked(detail) : true;
  const canConfirm = !!detail && !!draft && draftHasChanges(draft) && !draftHasDuplicates(draft, detail);

  const requestClose = () => {
    if (!showVoters && draft && draftHasChanges(draft)) setConfirm('exit');
    else onClose();
  };

  const run = async (work: () => Promise<boolean>) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const close = await work();
    if (!live.current) return;
    setBusy(false);
    if (close) onClose();
  };

  const submit = () =>
    run(async () => {
      if (!detail || !draft) return false;
      const result = await votePoll(pollId, conversationId, draft, detail);
      if (!result.ok) setMessage(pollActionMessage(result, 'vote'));
      return result.ok;
    });

  const requestSubmit = () => {
    if (!detail || !draft) return;
    if (isPollExpired(detail)) return setMessage(`Bình chọn ${detail.question} đã hết hạn`);
    if (draftHasDuplicates(draft, detail)) return setMessage('Phương án được thêm đã tồn tại');
    if (detail.hidePreview && !draftVotesNothing(draft)) setConfirm('hide');
    else void submit();
  };

  const lock = () =>
    run(async () => {
      const result = await lockPoll(pollId, conversationId);
      if (!result.ok) setMessage(pollActionMessage(result, 'lock'));
      return result.ok;
    });

  const share = () =>
    run(async () => {
      const result = await sharePoll(pollId, conversationId);
      if (!result.ok) setMessage(pollActionMessage(result, 'share'));
      return result.ok;
    });

  /** "Ghim lên đầu trò chuyện". A full board asks first; the confirmation replaces the oldest pin. */
  const pin = (ref: string | null = null) =>
    run(async () => {
      const outcome = await pinPoll(pollId, conversationId, ref);
      if (outcome.kind === 'needsConfirmation') setConfirm({ pin: outcome.confirm });
      else if (outcome.kind === 'failed') setMessage(pollActionMessage(outcome.result, 'pin'));
      return false;
    });

  const unpin = () =>
    run(async () => {
      const result = await unpinPoll(pollId, conversationId);
      if (!result.ok) setMessage(pollActionMessage(result, 'unpin'));
      return false;
    });

  const openMenu = (el: HTMLElement) => {
    if (!detail) return;
    openMenuBelow(
      el,
      [
        // Official menu order: pin / unpin (only with `isEnablePin`), then share, then lock.
        ...(offersPin(pinState)
          ? [
              pinState.pinned
                ? { label: 'Bỏ ghim bình chọn', icon: PinOff, onSelect: () => void unpin() }
                : { label: 'Ghim lên đầu trò chuyện', icon: Pin, onSelect: () => void pin() },
            ]
          : []),
        { label: 'Gửi vào nhóm', icon: Share2, onSelect: () => void share() },
        ...(detail.canClose && !detail.closed
          ? [{ kind: 'separator' as const }, { label: 'Khóa bình chọn', icon: Lock, destructive: true, onSelect: () => setConfirm('lock') }]
          : []),
      ],
      'end',
    );
  };

  return (
    <Sheet onClose={requestClose} width={440} height={560}>
      <div className="zp-dialog poll-sheet">
        <div className="zp-dialog-header">
          {showVoters && (
            <button className="zp-icon-btn" onClick={() => setShowVoters(false)} aria-label="Quay lại" title="Quay lại">
              <ChevronLeft size={16} />
            </button>
          )}
          <div className="zp-dialog-title">{showVoters ? 'Chi tiết bình chọn' : 'Bình chọn'}</div>
          {detail && !showVoters && (
            <button
              className="zp-icon-btn"
              disabled={busy}
              onClick={(e) => openMenu(e.currentTarget)}
              aria-label="Tùy chọn bình chọn"
              title="Tùy chọn bình chọn"
            >
              <MoreHorizontal size={16} />
            </button>
          )}
          <button className="zp-icon-btn" onClick={requestClose} aria-label="Đóng" title="Đóng">
            <X size={15} />
          </button>
        </div>
        <div className="zp-dialog-body">
          {detail ? (
            showVoters ? (
              <VotersPage voters={voters} failed={votersFailed} retry={() => void loadVoters()} />
            ) : (
              <VotePage
                detail={detail}
                question={question}
                draft={draft ?? voteDraft(detail)}
                setDraft={setDraft}
                config={config}
                pinned={pinState.pinned}
                voters={voters}
                busy={busy}
                showVoters={() => setShowVoters(true)}
              />
            )
          ) : (
            <div className="poll-sheet-state">
              {failed ? (
                <>
                  <span className="secondary">Có lỗi xảy ra khi lấy thông tin bình chọn</span>
                  <button className="zp-btn zp-btn-secondary" onClick={() => retryPoll(pollId, conversationId)}>
                    Thử lại
                  </button>
                </>
              ) : (
                <Spinner />
              )}
            </div>
          )}
        </div>
        <div className="zp-dialog-footer">
          {message && (
            <div className="poll-error">
              <AlertTriangle size={13} /> {message}
            </div>
          )}
          <div className="zp-dialog-buttons">
            {showVoters || !detail || editingLocked ? (
              <button className="zp-btn zp-btn-secondary" onClick={onClose}>
                Đóng
              </button>
            ) : (
              <>
                <button className="zp-btn zp-btn-secondary" onClick={requestClose}>
                  Hủy
                </button>
                <button className="zp-btn zp-btn-primary" disabled={!canConfirm || busy} onClick={requestSubmit}>
                  {busy ? <Spinner size={13} /> : 'Xác nhận'}
                </button>
              </>
            )}
          </div>
        </div>
        <ToastView conversationId={conversationId} bottom={64} />
      </div>
      {confirm === 'lock' && (
        <Alert
          title="Khóa bình chọn?"
          message="Sau khi khóa, bạn & các thành viên khác sẽ không thể tiếp tục tham gia bình chọn"
          buttons={[
            { label: 'Khóa bình chọn', role: 'destructive', onClick: () => (setConfirm(null), void lock()) },
            { label: 'Không', role: 'cancel', onClick: () => setConfirm(null) },
          ]}
        />
      )}
      {confirm === 'hide' && (
        <Alert
          title="Ẩn kết quả khi chưa bình chọn"
          message="Bạn không thể thay đổi lựa chọn"
          buttons={[
            { label: 'Xác nhận', onClick: () => (setConfirm(null), void submit()) },
            { label: 'Hủy', role: 'cancel', onClick: () => setConfirm(null) },
          ]}
        />
      )}
      {confirm === 'exit' && (
        <Alert
          title="Bạn chưa lưu bình chọn của mình. Thoát bình chọn?"
          buttons={[
            { label: 'Thoát', role: 'destructive', onClick: () => (setConfirm(null), onClose()) },
            { label: 'Hủy', role: 'cancel', onClick: () => setConfirm(null) },
          ]}
        />
      )}
      {confirm && typeof confirm === 'object' && (
        <Alert
          title="Cập nhật danh sách ghim"
          message={pinConfirmMessage(confirm.pin)}
          buttons={[
            { label: 'Cập nhật', onClick: () => (setConfirm(null), void pin(confirm.pin.ref)) },
            { label: 'Hủy', role: 'cancel', onClick: () => setConfirm(null) },
          ]}
        />
      )}
    </Sheet>
  );
}

function VotePage({
  detail,
  question,
  draft,
  setDraft,
  config,
  pinned,
  voters,
  busy,
  showVoters,
}: {
  detail: PollDetail;
  question: string;
  draft: PollVoteDraft;
  setDraft: (d: PollVoteDraft) => void;
  config: PollConfig;
  pinned: boolean;
  voters: PollVoters | null;
  busy: boolean;
  showVoters: () => void;
}) {
  const preview = applyDraft(draft, detail);
  const locked = isVotingLocked(detail);
  const addVisible = detail.allowAdd && !locked && detail.options.length + draft.added.length < config.maxOptions;
  const byline = [detail.creatorName ? `Tạo bởi ${detail.creatorName}` : null, detail.created ? formatPollDay(detail.created) : null].filter(Boolean);
  const canSeeVoters = votersVisible(detail);
  const lastAdded = useRef<HTMLInputElement | null>(null);
  const [focusKey, setFocusKey] = useState<number | null>(null);

  useEffect(() => {
    if (focusKey !== null) lastAdded.current?.focus();
  }, [focusKey]);

  const add = () => {
    const next = addRow(draft);
    setDraft(next);
    setFocusKey(next.added[next.added.length - 1].key);
  };

  return (
    <div className="poll-vote-page">
      <div className="poll-sheet-head">
        <div className="poll-sheet-question selectable">{detail.question || question}</div>
        {byline.length > 0 && <div className="poll-byline">{byline.join(' · ')}</div>}
        <PollSettingsLine poll={detail} showsSingleChoice chips />
      </div>
      <div className="poll-summary">
        <span className="poll-summary-icon">
          <Users size={15} />
        </span>
        <span className="poll-summary-text">
          {detail.voterCount > 0 ? `${detail.voterCount} người đã bình chọn` : 'Chưa có ai bình chọn'}
          {pinned && (
            <span className="poll-summary-pin">
              <Pin size={11} /> Đã ghim
            </span>
          )}
        </span>
        {detail.voterCount > 0 && canSeeVoters && (
          <button className="poll-summary-link" onClick={showVoters}>
            Xem chi tiết <ChevronRight size={13} strokeWidth={2.25} />
          </button>
        )}
      </div>
      {resultsHidden(detail) && !locked && <div className="poll-hint">Người tham gia chỉ có thể thấy kết quả sau khi bình chọn.</div>}
      <div className="poll-options poll-options-sheet">
        {detail.options.map((option) => {
          const shown = preview.options.find((o) => o.id === option.id) ?? option;
          return (
            <PollOptionRow
              key={option.id}
              option={shown}
              weight={optionWeight(preview, shown)}
              showsPercent={!resultsHidden(detail)}
              voters={voters?.groups.find((g) => g.id === option.id)?.users}
              onShowVoters={canSeeVoters ? showVoters : undefined}
              control={{
                multi: detail.multi,
                isOn: draft.selected.includes(option.id),
                enabled: !locked && !busy,
                toggle: () => setDraft(toggleOption(draft, option.id)),
              }}
            />
          );
        })}
        {draft.added.map((row, index) => {
          const empty = row.text.trim().length === 0;
          const isLast = index === draft.added.length - 1;
          return (
            <div key={row.key} className="poll-added">
              <div className="poll-added-row">
                <button
                  className="poll-choice"
                  disabled={empty}
                  onClick={() => setDraft(setAddedVoted(draft, row.key, !row.voted))}
                  aria-label="Chọn lựa chọn mới"
                >
                  <ChoiceMark multi={detail.multi} isOn={row.voted} />
                </button>
                <input
                  ref={isLast ? lastAdded : undefined}
                  className="zp-input poll-input"
                  placeholder={`Lựa chọn ${detail.options.length + index + 1}`}
                  value={row.text}
                  onChange={(e) => setDraft(setAddedText(draft, row.key, prefixUTF16(e.target.value, config.maxOption)))}
                  onKeyDown={(e) => {
                    // Official: Enter in the last option adds the next row.
                    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                    e.preventDefault();
                    if (isLast && !empty && detail.options.length + draft.added.length < config.maxOptions && !draftHasDuplicates(draft, detail)) add();
                  }}
                />
                <button className="zp-icon-btn poll-remove" onClick={() => setDraft(removeAdded(draft, row.key))} aria-label="Xóa lựa chọn" title="Xóa lựa chọn">
                  <XCircle size={15} />
                </button>
              </div>
              {isDuplicateAdded(draft, row.key, detail) && <div className="poll-field-error">Phương án được thêm đã tồn tại</div>}
            </div>
          );
        })}
      </div>
      {addVisible && (
        <button className="poll-add-row" disabled={draftHasDuplicates(draft, detail)} onClick={add}>
          <Plus size={15} /> Thêm lựa chọn
        </button>
      )}
      {detail.closed ? (
        <div className="poll-status">
          <Lock size={12} /> Bình chọn đã đóng
        </div>
      ) : isPollExpired(detail) ? (
        <div className="poll-status">
          <ClockAlert size={12} /> Đã hết hạn
        </div>
      ) : detail.hidePreview && detail.joined ? (
        <div className="poll-status">
          <Lock size={12} /> Không thể thay đổi bình chọn
        </div>
      ) : null}
    </div>
  );
}

function VotersPage({ voters, failed, retry }: { voters: PollVoters | null; failed: boolean; retry: () => void }) {
  if (!voters) {
    return failed ? (
      <div className="poll-sheet-state">
        <span className="secondary">Không tải được danh sách người bình chọn</span>
        <button className="zp-btn zp-btn-secondary" onClick={retry}>
          Thử lại
        </button>
      </div>
    ) : (
      <div className="poll-sheet-state">
        <Spinner />
      </div>
    );
  }
  return (
    <div className="poll-voters">
      {(voters.restricted || voters.groups.length === 0) && (
        <div className="poll-sheet-state">
          <Users size={28} className="tertiary" />
          <span className="secondary">{voters.restricted ? 'Danh sách người bình chọn không được hiển thị.' : 'Chưa có ai bình chọn.'}</span>
        </div>
      )}
      {voters.groups.map((group) => (
        <section key={group.id} className="poll-voter-group">
          <div className="poll-voter-heading">
            <span className="poll-voter-option">{group.content}</span>
            <span className="poll-vote-pill nums">{group.votes} phiếu</span>
          </div>
          {group.users.map((user) => (
            <div key={user.uid} className="poll-voter">
              <Avatar url={user.avatar} name={user.name} size={32} />
              <span className="poll-voter-name truncate">{user.name}</span>
              {user.isMe && <span className="poll-voter-me">Bạn</span>}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
