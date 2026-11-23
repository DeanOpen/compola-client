// Participant picker for group calls (Swift `GroupCallPickerSheet`): the renderer's GROUP_CALL modal ("Tạo cuộc gọi" /
// "Thêm người vào cuộc gọi") as a Zalo PC dialog. Members, limit and rules come from the renderer; no "select all",
// like the official modal. Confirming runs the official `onConfirm`; any other way out answers `onCancel`.
// Patterns (docs/design-refs/wave4/calls): removable chips of the picked people under the search field (X, Whop),
// "you can add N more" (Discord), a call-kind summary next to the group.

import { Check, Lock, Phone, Search, SearchX, UsersRound, Video, X, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  cancelGroupPicker,
  confirmGroupPicker,
  pickerLimitMessage,
  pickerMembers,
  togglePickerMember,
  type GroupCallPicker,
  type GroupCallPickerMember,
} from '../../engine/calls';
import { Avatar } from '../../ui/Avatar';
import { ContentUnavailable } from '../../ui/ContentUnavailable';
import { ZaloDialog } from './ZaloDialog';
import './calls.css';

export function GroupCallPickerSheet({ picker }: { picker: GroupCallPicker }) {
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState<string[]>([]);
  const [limitNotice, setLimitNotice] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    input.current?.focus();
    return () => clearTimeout(timer.current);
  }, []);

  const rows = pickerMembers(picker, query);
  const picked = selection.map((id) => picker.members.find((m) => m.id === id)).filter((m): m is GroupCallPickerMember => !!m);
  const left = Math.max(0, picker.maxSelectable - selection.length);
  const cancel = () => cancelGroupPicker(picker);
  const confirm = () => {
    if (selection.length) void confirmGroupPicker(picker, selection);
  };
  const toggle = (member: GroupCallPickerMember) => {
    const result = togglePickerMember(picker, member.id, selection);
    setSelection(result.selection);
    if (result.overLimit) {
      setLimitNotice(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setLimitNotice(false), 2500);
    } else {
      setQuery('');
      input.current?.focus();
    }
  };

  const KindIcon = picker.video === false ? Phone : Video;
  const callLabel = picker.adding ? 'Thêm' : picker.video === false ? 'Gọi thoại' : 'Gọi video';

  return (
    <ZaloDialog
      title={picker.adding ? 'Thêm người vào cuộc gọi' : 'Tạo cuộc gọi nhóm'}
      onClose={cancel}
      width={440}
      height={620}
      footer={
        <>
          <span className="cx-dialog-footer-note nums" aria-live="polite">
            {limitNotice ? (
              <span className="call-picker-limit">{pickerLimitMessage(picker)}</span>
            ) : (
              <>
                <b className="call-picker-count">
                  Đã chọn {selection.length}/{picker.maxSelectable}
                </b>
                {selection.length > 0 && left > 0 && <span> · còn {left} chỗ</span>}
              </>
            )}
          </span>
          <button className="cx-btn" onClick={cancel}>
            Hủy
          </button>
          <button className="cx-btn cx-btn-primary" onClick={confirm} disabled={selection.length === 0}>
            {!picker.adding && <KindIcon size={14} />}
            {callLabel}
          </button>
        </>
      }
    >
      <div
        className="call-picker"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            confirm();
          } else if (e.key === 'Backspace' && !query && selection.length && e.target === input.current) {
            // Token-field habit: Backspace in an empty search removes the last chip.
            setSelection(selection.slice(0, -1));
          }
        }}
      >
        <div className="call-picker-group">
          <Avatar url={picker.groupAvatar} name={picker.groupName} size={36} />
          <span className="call-picker-group-text">
            <span className="call-picker-group-name truncate">{picker.groupName}</span>
            <span className="call-picker-group-sub">
              {picker.adding
                ? 'Mời thêm thành viên vào cuộc gọi đang diễn ra'
                : `Chọn tối đa ${picker.maxSelectable} người để bắt đầu`}
            </span>
          </span>
          {picker.video !== null && (
            <span className="call-picker-kind">
              <KindIcon size={13} /> {picker.video ? 'Gọi video' : 'Gọi thoại'}
            </span>
          )}
        </div>

        <label className="call-picker-search">
          <Search size={15} />
          <input
            ref={input}
            value={query}
            placeholder="Tìm kiếm thành viên"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Tìm kiếm thành viên"
          />
          {query && (
            <button className="call-picker-clear" onClick={() => setQuery('')} aria-label="Xoá">
              <XCircle size={15} />
            </button>
          )}
        </label>

        {picked.length > 0 && (
          <div className="call-picker-chips" aria-label="Đã chọn">
            {picked.map((m) => (
              <span key={m.id} className="call-chip">
                <Avatar url={m.avatar} name={m.name} size={22} />
                <span className="call-chip-name truncate">{m.name}</span>
                <button className="call-chip-remove" onClick={() => toggle(m)} aria-label={`Bỏ chọn ${m.name}`} title="Bỏ chọn">
                  <X size={12} strokeWidth={2.5} />
                </button>
              </span>
            ))}
          </div>
        )}

        {picker.note && (
          <div className="call-picker-note">
            <Lock size={12} /> {picker.note}
          </div>
        )}

        {rows.length === 0 ? (
          <div className="call-picker-empty">
            <ContentUnavailable
              icon={picker.members.length === 0 ? UsersRound : SearchX}
              title={picker.members.length === 0 ? 'Không có thành viên để gọi' : 'Không tìm thấy'}
              description={picker.members.length === 0 ? undefined : `Không có thành viên nào tên “${query}”.`}
            />
          </div>
        ) : (
          <>
            <div className="call-picker-section">
              {query ? 'Kết quả tìm kiếm' : 'Thành viên nhóm'} <span className="nums">({rows.length})</span>
            </div>
            <div className="call-picker-list" role="listbox" aria-multiselectable>
              {rows.map((member) => {
                const joined = picker.existing.includes(member.id);
                const checked = joined || selection.includes(member.id);
                const full = !checked && left === 0;
                return (
                  <button
                    key={member.id}
                    className={`call-picker-row ${joined ? 'is-joined' : ''} ${checked && !joined ? 'is-checked' : ''} ${full ? 'is-full' : ''}`}
                    disabled={joined}
                    role="option"
                    aria-selected={checked}
                    aria-label={member.name}
                    onClick={() => toggle(member)}
                  >
                    <span className={`call-picker-check ${checked ? 'is-on' : ''}`} aria-hidden>
                      {checked && <Check size={12} strokeWidth={3} />}
                    </span>
                    <Avatar url={member.avatar} name={member.name} size={40} />
                    <span className="call-picker-name">
                      <span className="truncate">{member.name}</span>
                      {joined && <span className="call-picker-sub">Đã tham gia</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    </ZaloDialog>
  );
}
