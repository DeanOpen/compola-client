// Participant picker for group calls (Swift `GroupCallPickerSheet`): the renderer's GROUP_CALL modal ("Tạo cuộc gọi" /
// "Thêm người vào cuộc gọi") as a Zalo PC dialog. Members, limit and rules come from the renderer; no "select all",
// like the official modal. Confirming runs the official `onConfirm`; any other way out answers `onCancel`.

import { Check, Lock, Phone, Search, SearchX, UsersRound, Video, XCircle } from 'lucide-react';
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
    } else setQuery('');
  };

  return (
    <ZaloDialog
      title={picker.adding ? 'Thêm người vào cuộc gọi' : 'Tạo cuộc gọi'}
      onClose={cancel}
      width={420}
      height={600}
      footer={
        <>
          <span className="cx-dialog-footer-note nums">
            {limitNotice ? <span className="call-picker-limit">{pickerLimitMessage(picker)}</span> : `Đã chọn ${selection.length}/${picker.maxSelectable}`}
          </span>
          <button className="cx-btn" onClick={cancel}>
            Hủy
          </button>
          <button className="cx-btn cx-btn-primary" onClick={confirm} disabled={selection.length === 0}>
            {picker.adding ? 'Thêm' : 'Gọi'}
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
          }
        }}
      >
        <div className="call-picker-group">
          <Avatar url={picker.groupAvatar} name={picker.groupName} size={32} />
          <span className="call-picker-group-name truncate">{picker.groupName}</span>
          {picker.video !== null &&
            (picker.video ? (
              <span className="call-picker-kind">
                <Video size={13} /> Gọi video
              </span>
            ) : (
              <span className="call-picker-kind">
                <Phone size={12} /> Gọi thoại
              </span>
            ))}
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
            />
          </div>
        ) : (
          <div className="call-picker-list" role="listbox" aria-multiselectable>
            {rows.map((member) => {
              const joined = picker.existing.includes(member.id);
              const checked = joined || selection.includes(member.id);
              return (
                <button
                  key={member.id}
                  className={`call-picker-row ${joined ? 'is-joined' : ''} ${checked && !joined ? 'is-checked' : ''}`}
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
        )}
      </div>
    </ZaloDialog>
  );
}
