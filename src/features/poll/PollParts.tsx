// Shared pieces of the poll card and sheets (Swift PollViews.swift: `PollSettingsLine`, `PollOptionRow`, `PollChrome`).

import { CheckCircle2, CheckSquare, Circle, CircleDot, Clock, EyeOff, ListChecks, Square, UserRoundX, type LucideIcon } from 'lucide-react';
import { formatPercent, formatPollDeadline, isPollExpired, type PollDetail, type PollOption, type PollVoterUser } from '../../engine/models/poll';
import { Avatar } from '../../ui/Avatar';
import './dialog.css';
import './poll.css';

/** Setting chips under the question: deadline, one / many answers, hidden voters, hidden results (official `WYKB`). */
export function PollSettingsLine({
  poll,
  showsSingleChoice = false,
  chips = false,
}: {
  poll: PollDetail;
  showsSingleChoice?: boolean;
  /** Pill chips in a wrapping row (sheet header) instead of the card's stacked lines. */
  chips?: boolean;
}) {
  const items: { icon: LucideIcon; text: string; alert?: boolean }[] = [];
  if (poll.expires !== null) items.push({ icon: Clock, text: 'Kết thúc lúc ' + formatPollDeadline(poll.expires), alert: isPollExpired(poll) });
  if (poll.multi) items.push({ icon: ListChecks, text: 'Chọn nhiều phương án' });
  else if (showsSingleChoice) items.push({ icon: CheckCircle2, text: 'Chỉ chọn một phương án' });
  if (poll.anonymous) items.push({ icon: UserRoundX, text: 'Ẩn người bình chọn' });
  if (poll.hidePreview) items.push({ icon: EyeOff, text: 'Ẩn kết quả khi chưa bình chọn' });
  if (!items.length) return null;
  return (
    <div className={chips ? 'poll-chips' : 'poll-settings'}>
      {items.map(({ icon: Icon, text, alert }) => (
        <div key={text} className={`${chips ? 'poll-chip' : 'poll-setting'} ${alert ? 'is-alert' : ''}`}>
          <Icon size={11} />
          <span>{text}</span>
        </div>
      ))}
    </div>
  );
}

export interface OptionControl {
  multi: boolean;
  isOn: boolean;
  enabled: boolean;
  toggle: () => void;
}

/** The checkbox / radio of an option being edited. */
export function ChoiceMark({ multi, isOn }: { multi: boolean; isOn: boolean }) {
  const Icon = multi ? (isOn ? CheckSquare : Square) : isOn ? CircleDot : Circle;
  return <Icon size={17} className={isOn ? 'tint' : 'secondary'} />;
}

/** One option: progress bar behind the text, vote count on the right, tick when I voted. */
export function PollOptionRow({
  option,
  weight,
  showsCount = true,
  control,
  voters,
  showsPercent = false,
  onShowVoters,
}: {
  option: PollOption;
  weight: number;
  showsCount?: boolean;
  control?: OptionControl;
  /** Who voted for it (sheet): up to three faces stacked before the count. */
  voters?: PollVoterUser[];
  showsPercent?: boolean;
  /** The faces open the voter list. */
  onShowVoters?: () => void;
}) {
  const label = control ? undefined : `${option.content}, ${option.votes} phiếu, ${formatPercent(weight)}${option.voted ? ', đã chọn' : ''}`;
  return (
    <div className="poll-option" aria-label={label}>
      {control && (
        <button
          className="poll-choice"
          disabled={!control.enabled}
          onClick={control.toggle}
          aria-label={option.content}
          aria-pressed={control.isOn}
        >
          <ChoiceMark multi={control.multi} isOn={control.isOn} />
        </button>
      )}
      <div
        className="poll-option-body"
        onClick={control?.enabled ? control.toggle : undefined}
        style={{ cursor: control?.enabled ? 'pointer' : undefined }}
      >
        <div className={`poll-option-bar ${weight >= 1 ? 'is-full' : ''}`} style={{ width: `${Math.max(0, Math.min(1, weight)) * 100}%` }} />
        <span className="poll-option-text">{option.content}</span>
        {option.voted && !control && <CheckCircle2 size={12} className="tint poll-option-tick" />}
        {voters && voters.length > 0 && (
          <span
            className={`poll-faces ${onShowVoters ? 'is-link' : ''}`}
            onClick={
              onShowVoters
                ? (e) => {
                    e.stopPropagation();
                    onShowVoters();
                  }
                : undefined
            }
            title={voters.map((v) => v.name).join(', ')}
          >
            {voters.slice(0, 3).map((v) => (
              <Avatar key={v.uid} url={v.avatar} name={v.name} size={20} className="poll-face" />
            ))}
          </span>
        )}
        {showsPercent && option.votes > 0 && <span className="poll-option-percent nums">{formatPercent(weight)}</span>}
        {showsCount && <span className="poll-option-count nums">{option.votes}</span>}
      </div>
    </div>
  );
}

/** A switch row (SwiftUI `Toggle` with `.switch` style). */
export function SwitchRow({
  label,
  checked,
  onChange,
  disabled = false,
  help,
  icon: Icon,
}: {
  icon?: LucideIcon;
  label: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  help?: string;
}) {
  return (
    <label className={`poll-switch-row ${disabled ? 'is-disabled' : ''}`}>
      {Icon && (
        <span className="poll-switch-icon">
          <Icon size={15} />
        </span>
      )}
      <span className="poll-switch-text">
        <span className="poll-switch-label">{label}</span>
        {help && <span className="poll-switch-help">{help}</span>}
      </span>
      <input type="checkbox" className="app-switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}
