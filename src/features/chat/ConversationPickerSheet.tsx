// The native stand-in for the official SHARE_MSG_COMPOSE picker: search, tick up to `maxTargets` conversations, act.
// Used by "Chia sẻ" of a message (Swift `ForwardSheet`) and of a screenshot (Swift `ScreenshotShareSheet`).

import { CheckCircle2, Circle } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { displayName, selfConversationTitle, type ConversationSummary } from '../../engine/models/conversations';
import { useEngine, visibleConversations } from '../../engine/store';
import { Avatar } from '../../ui/Avatar';
import { Sheet, SheetHeader } from '../../ui/Overlays';
import { Spinner } from '../../ui/Spinner';
import { fold } from '../conversations/support';

export function ConversationPickerSheet({
  title,
  preview,
  maxTargets,
  hint,
  onClose,
  onSubmit,
}: {
  title: string;
  preview: ReactNode;
  maxTargets: number;
  hint: (selected: number) => string;
  onClose: () => void;
  /** Resolves to an error text to show, or null when done (the caller closes the sheet). */
  onSubmit: (ids: string[]) => Promise<string | null>;
}) {
  const conversations = useEngine((s) => s.conversations);
  const selfId = useEngine((s) => s.selfConversationId);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const label = (c: ConversationSummary) => (c.id === selfId ? selfConversationTitle : displayName(c));
  const rows = useMemo(() => {
    const all = [...visibleConversations(useEngine.getState())].sort((a, b) => (b.preview?.date ?? 0) - (a.preview?.date ?? 0));
    const needle = fold(search.trim());
    return needle ? all.filter((c) => fold(label(c)).includes(needle)) : all;
  }, [conversations, search, selfId]);

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length < maxTargets ? [...s, id] : s));

  const submit = async () => {
    if (!selected.length || busy) return;
    setBusy(true);
    setFailure(null);
    const error = await onSubmit(selected);
    setBusy(false);
    if (error) setFailure(error);
  };

  return (
    <Sheet onClose={onClose} width={440} height={580}>
      <SheetHeader title={title} onClose={onClose} />
      <div className="forward-top">
        <div className="forward-preview">{preview}</div>
        <input className="text-field" autoFocus placeholder="Tìm kiếm hội thoại cần chia sẻ" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div className="forward-list" role="listbox" aria-multiselectable>
        {rows.map((c) => {
          const on = selected.includes(c.id);
          return (
            <button key={c.id} role="option" aria-selected={on} className="forward-row" onClick={() => toggle(c.id)} disabled={!on && selected.length >= maxTargets}>
              {on ? <CheckCircle2 size={17} className="tint" /> : <Circle size={17} className="tertiary" />}
              <Avatar url={c.avatar} name={label(c)} size={30} />
              <span className="truncate">{label(c)}</span>
            </button>
          );
        })}
      </div>
      <div className="sheet-footer">
        <span className={failure ? 'sheet-footer-error' : 'secondary'}>{failure ?? hint(selected.length)}</span>
        <button className="btn btn-glass" onClick={onClose}>
          Hủy
        </button>
        <button className="btn btn-prominent" disabled={!selected.length || busy} onClick={() => void submit()}>
          {busy ? <Spinner size={13} /> : 'Chia sẻ'}
        </button>
      </div>
    </Sheet>
  );
}
