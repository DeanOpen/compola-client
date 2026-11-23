// Native versions of the dialogs that card buttons open in the official client (Swift CardSheets.swift): alias
// ("Đặt tên gợi nhớ", EDIT_ALIAS), group invite (GROUP_PREVIEW) and a sticker category. Opening a sheet only reads;
// every write (alias, join, sticker) runs from the sheet's own confirm / click.

import { KeyRound, Smile, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  contactProfile,
  groupInvitePreview,
  isCardSheetPresented,
  joinGroup,
  openConversationFromCard,
  saveAlias,
  sendCategorySticker,
  stickerCategory,
} from '../../engine/cardSheets';
import { prefixUTF16, sanitizeAlias, type AliasDraft, type GroupInvitePreview, type StickerCategory, type StickerCategoryItem } from '../../engine/models/cardSheets';
import { getEngine } from '../../engine/store';
import { showToast } from '../../engine/toast';
import { Avatar } from '../../ui/Avatar';
import { Sheet } from '../../ui/Overlays';
import { RemoteImage } from '../../ui/RemoteImage';
import { Spinner } from '../../ui/Spinner';
import { ToastView } from '../../ui/Toast';
import '../poll/dialog.css';
import './cardSheets.css';

const utf16Length = (s: string) => s.length;

/** Zalo PC dialog title bar: the title and ×. */
function DialogHeader({ title, onClose, disabled = false }: { title: string; onClose: () => void; disabled?: boolean }) {
  return (
    <div className="zp-dialog-header">
      <div className="zp-dialog-title">{title}</div>
      <button className="zp-icon-btn" disabled={disabled} onClick={onClose} aria-label="Đóng" title="Đóng">
        <X size={18} />
      </button>
    </div>
  );
}

// MARK: - Alias

export function AliasSheet({ draft, conversationId, onClose }: { draft: AliasDraft; conversationId: string; onClose: () => void }) {
  const [text, setText] = useState(() => prefixUTF16(draft.suggest, draft.max));
  const [avatar, setAvatar] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  const input = useRef<HTMLInputElement>(null);

  const displayName = draft.name || 'người này';
  const isEmpty = text.trim().length === 0;
  /** Empty field: confirming removes an existing alias (labelled so); with no alias there is nothing to confirm. */
  const removes = isEmpty && draft.hasAlias === true;
  const nothingToSave = isEmpty && draft.hasAlias === false;

  useEffect(() => {
    live.current = true;
    input.current?.focus();
    input.current?.select();
    void contactProfile(draft.uid).then((p) => live.current && setAvatar(p?.avatar ?? null));
    return () => {
      live.current = false;
    };
  }, [draft.uid]);

  /** Official `accept`: the trimmed text goes to `setAliasName(uid, name)`; an empty name removes the alias. */
  const save = async () => {
    if (saving || nothingToSave) return;
    setSaving(true);
    setError(null);
    const result = await saveAlias(draft.uid, text);
    if (!live.current) return;
    setSaving(false);
    if (result.ok) {
      showToast(result.text, conversationId);
      onClose();
    } else setError(result.text || 'Có lỗi xảy ra, vui lòng thử lại sau');
  };

  return (
    <Sheet onClose={() => !saving && onClose()} width={400}>
      <div className="zp-dialog card-sheet">
        <DialogHeader title="Đặt tên gợi nhớ" onClose={onClose} disabled={saving} />
        <div className="card-sheet-body">
          <Avatar url={avatar} name={draft.name} size={72} />
          <div className="card-sheet-text">
            <div>
              Hãy đặt cho <b>{displayName}</b> một cái tên dễ nhớ.
            </div>
            <div className="card-sheet-muted">Lưu ý: Tên gợi nhớ sẽ chỉ hiển thị riêng với bạn.</div>
          </div>
          <div className="card-sheet-field">
            <input
              ref={input}
              className="zp-input"
              placeholder={draft.placeholder}
              value={text}
              disabled={saving}
              onChange={(e) => setText(prefixUTF16(sanitizeAlias(e.target.value), draft.max))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void save();
                }
              }}
            />
            <div className="card-sheet-count nums">
              {utf16Length(text)}/{draft.max}
            </div>
          </div>
          {error && <div className="card-sheet-error">{error}</div>}
        </div>
        <div className="zp-dialog-footer">
          <div className="zp-dialog-buttons">
            <button className="zp-btn zp-btn-secondary" disabled={saving} onClick={onClose}>
              Hủy
            </button>
            <button className="zp-btn zp-btn-primary" disabled={saving || nothingToSave} onClick={() => void save()}>
              {saving ? <Spinner size={13} /> : removes ? 'Xoá tên gợi nhớ' : 'Xác nhận'}
            </button>
          </div>
        </div>
        <ToastView conversationId={conversationId} bottom={64} />
      </div>
    </Sheet>
  );
}

// MARK: - Group invite

export function GroupInviteSheet({ url, conversationId, seq, onClose }: { url: string; conversationId: string; seq: number; onClose: () => void }) {
  const [preview, setPreview] = useState<GroupInvitePreview | null>(null);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  const community = preview?.community ?? false;

  useEffect(() => {
    live.current = true;
    void groupInvitePreview(url).then((result) => {
      // The sheet may have been closed / reset while this was loading: then nothing may navigate.
      if (!live.current || !isCardSheetPresented(seq)) return;
      // Official: already a member → no dialog, the conversation opens.
      if (result.state === 'member') {
        openConversationFromCard(result.groupId);
        onClose();
        return;
      }
      setPreview(result);
    });
    return () => {
      live.current = false;
    };
  }, [url, seq]);

  /** Official `_join`: only from this button. */
  const join = async () => {
    if (joining) return;
    setJoining(true);
    setError(null);
    const result = await joinGroup(url);
    const still = isCardSheetPresented(seq);
    if (live.current) setJoining(false);
    switch (result.state) {
      case 'joined':
      case 'already':
        // Joined for real; only take the user to the group while this sheet is still what they are looking at.
        if (still) openConversationFromCard(result.groupId);
        onClose();
        return;
      case 'pending':
        showToast(result.text, conversationId);
        onClose();
        return;
      default:
        if (live.current) setError(result.text);
    }
  };

  return (
    <Sheet onClose={() => !joining && onClose()} width={400}>
      <div className="zp-dialog card-sheet">
        <DialogHeader title={community ? 'Thông tin cộng đồng' : 'Thông tin nhóm'} onClose={onClose} disabled={joining} />
        <div className="card-sheet-body">
          {!preview || preview.state === 'member' ? (
            <div className="card-sheet-loading">
              <Spinner />
            </div>
          ) : preview.state === 'error' ? (
            <div className="card-sheet-loading card-sheet-muted">{preview.text}</div>
          ) : (
            <>
              <Avatar url={preview.avatar} name={preview.name} size={72} />
              <div className="card-sheet-text">
                <div className="card-sheet-title clamp-2">{preview.name}</div>
                <div className="card-sheet-muted">
                  {preview.totalMember} thành viên{preview.creatorName ? ` • Tạo bởi ${preview.creatorName}` : ''}
                </div>
              </div>
              {preview.desc ? (
                <div className="card-sheet-text selectable clamp-4">{preview.desc}</div>
              ) : (
                <div className="card-sheet-text card-sheet-muted">
                  {community
                    ? 'Bạn đang ở phòng chờ. Hãy tham gia chat để cùng trò chuyện với mọi người trong cộng đồng.'
                    : 'Bạn đang ở phòng chờ. Hãy tham gia chat để cùng trò chuyện với mọi người trong nhóm.'}
                </div>
              )}
              {preview.members.length > 0 && (
                <div className="card-sheet-members">
                  {preview.members.map((m) => (
                    <div key={m.id} className="card-sheet-member">
                      <Avatar url={m.avatar} name={m.name} size={32} />
                      <span className="truncate">{m.name || 'Người dùng Zalo'}</span>
                      {m.admin && (
                        <span title="Trưởng/phó nhóm" className="card-sheet-muted" style={{ display: 'inline-flex' }}>
                          <KeyRound size={12} />
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
          {error && <div className="card-sheet-error">{error}</div>}
        </div>
        <div className="zp-dialog-footer">
          <div className="zp-dialog-buttons">
            <button className="zp-btn zp-btn-secondary" disabled={joining} onClick={onClose}>
              Đóng
            </button>
            {preview?.state === 'preview' && (
              <button className="zp-btn zp-btn-primary" disabled={joining} onClick={() => void join()}>
                {joining ? <Spinner size={13} /> : 'Tham gia'}
              </button>
            )}
          </div>
        </div>
        <ToastView conversationId={conversationId} bottom={64} />
      </div>
    </Sheet>
  );
}

// MARK: - Sticker category

/** A sticker category (`action.open.sticker`): a click sends that sticker to the conversation the card is in. */
export function StickerCategorySheet({ cateId, conversationId, onClose }: { cateId: number; conversationId: string; onClose: () => void }) {
  const [category, setCategory] = useState<StickerCategory | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    // The sticker service may not be resolved yet right after launch: a few tries, then give up quietly.
    void (async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const loaded = await stickerCategory(cateId);
        if (!live.current) return;
        if (loaded) {
          setCategory(loaded);
          setLoading(false);
          return;
        }
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1500));
      }
      if (live.current) setLoading(false);
    })();
    return () => {
      live.current = false;
    };
  }, [cateId]);

  const send = async (sticker: StickerCategoryItem, cat: StickerCategory) => {
    if (sending || getEngine().openConversationId !== conversationId) return;
    setSending(sticker.ref);
    setError(null);
    const outcome = await sendCategorySticker(conversationId, cat.id, sticker.stickerId);
    if (!live.current) return;
    setSending(null);
    if (outcome.kind === 'done') onClose();
    else if ('text' in outcome && (outcome.kind === 'locked' || outcome.kind === 'failed' || outcome.kind === 'unsupported' || outcome.kind === 'pending')) setError(outcome.text);
  };

  return (
    <Sheet onClose={onClose} width={420} height={480}>
      <div className="zp-dialog card-sheet-stickers">
        <div className="zp-dialog-header">
          {category?.icon && <RemoteImage url={category.icon} fit="contain" className="sticker-sheet-icon" compact placeholder={<span />} />}
          <div className="zp-dialog-title">{category?.name || 'Bộ sticker'}</div>
          <button className="zp-icon-btn" onClick={onClose} aria-label="Đóng" title="Đóng">
            <X size={18} />
          </button>
        </div>
        <div className="zp-dialog-body">
          {category ? (
            <div className="sticker-grid">
              {category.stickers.map((s) => (
                <button
                  key={s.ref}
                  className="sticker-cell"
                  disabled={sending !== null}
                  title="Gửi sticker này"
                  onClick={() => void send(s, category)}
                  style={{ opacity: sending === s.ref ? 0.4 : 1 }}
                >
                  <RemoteImage url={s.url} fit="contain" className="sticker-cell-image" compact placeholder={<Smile size={20} className="tertiary" />} />
                </button>
              ))}
            </div>
          ) : loading ? (
            <div className="card-sheet-loading">
              <Spinner />
            </div>
          ) : (
            <div className="card-sheet-loading card-sheet-muted">Không tải được bộ sticker này. Hãy thử lại sau.</div>
          )}
        </div>
        {error && <div className="card-sheet-error" style={{ padding: 10 }}>{error}</div>}
        <ToastView conversationId={conversationId} bottom={16} />
      </div>
    </Sheet>
  );
}
