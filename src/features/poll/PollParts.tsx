// Shared pieces of the poll card and sheets (Swift PollViews.swift: `PollSettingsLine`, `PollOptionRow`, `PollChrome`).

import { CheckCircle2, CheckSquare, Circle, CircleDot, Clock, EyeOff, ListChecks, Square, UserRoundX, type LucideIcon } from 'lucide-react';
import { formatPercent, formatPollDeadline, isPollExpired, type PollDetail, type PollOption } from '../../engine/models/poll';
import './dialog.css';
import './poll.css';

/** Setting chips under the question: deadline, one / many answers, hidden voters, hidden results (official `WYKB`). */
export function PollSettingsLine({ poll, showsSingleChoice = false }: { poll: PollDetail; showsSingleChoice?: boolean }) {
  const items: { icon: LucideIcon; text: string; alert?: boolean }[] = [];
  if (poll.expires !== null) items.push({ icon: Clock, text: 'Kết thúc lúc ' + formatPollDeadline(poll.expires), alert: isPollExpired(poll) });
  if (poll.multi) items.push({ icon: ListChecks, text: 'Chọn nhiều phương án' });
  else if (showsSingleChoice) items.push({ icon: CheckCircle2, text: 'Chỉ chọn một phương án' });
  if (poll.anonymous) items.push({ icon: UserRoundX, text: 'Ẩn người bình chọn' });
  if (poll.hidePreview) items.push({ icon: EyeOff, text: 'Ẩn kết quả khi chưa bình chọn' });
  if (!items.length) return null;
  return (
    <div className="poll-settings">
      {items.map(({ icon: Icon, text, alert }) => (
        <div key={text} className={`poll-setting ${alert ? 'is-alert' : ''}`}>
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
}: {
  option: PollOption;
  weight: number;
  showsCount?: boolean;
  control?: OptionControl;
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
}: {
  label: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  help?: string;
}) {
  return (
    <label className={`poll-switch-row ${disabled ? 'is-disabled' : ''}`} title={help}>
      <span className="poll-switch-label">{label}</span>
      <input type="checkbox" className="app-switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}
