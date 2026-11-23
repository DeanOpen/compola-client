// A zCloud browse screen (Swift CloudMediaView.swift): "Tin nhắn media", one conversation's items or "Cloud của tôi";
// filter by type, sort, grid / list, preview, "Lưu về máy…", multi-select and delete.

import { ArrowUpDown, Check, CheckCircle2, ChevronLeft, Circle, CloudAlert, Eye, Folder, Images, Inbox, LayoutGrid, List, Play, Save, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import {
  breakdownBytes,
  breakdownTotal,
  cloudDelete,
  cloudFetch,
  cloudFileUrl,
  cloudKindTitle,
  cloudList,
  useCloud,
  type CloudItem,
  type CloudItemKind,
} from '../../engine/cloud';
import { saveMediaAs } from '../../engine/save';
import { Alert } from '../../ui/Overlays';
import { ContentUnavailable } from '../../ui/ContentUnavailable';
import { openContextMenu, openMenuBelow, type MenuItem } from '../../ui/Menu';
import { Spinner } from '../../ui/Spinner';
import { CloudThumbView } from './CloudThumb';
import { HeaderIcon, Tabs } from './Segmented';
import {
  cloudSorts,
  cloudUi,
  conversationLabel,
  formatDate,
  formatDuration,
  formatSize,
  itemIcon,
  itemName,
  outputName,
  scopeConversationId,
  sortAscending,
  sortBySize,
  type CloudScope,
  type CloudSort,
} from './support';

// MARK: - Paged list (Swift CloudListModel)

interface ListState {
  items: CloudItem[];
  hasMore: boolean;
  isLoading: boolean;
  error: string | null;
  didLoad: boolean;
}

const pageSize = 60;

const useCloudList = (scope: CloudScope, kind: CloudItemKind | null, sort: CloudSort, isSelecting: boolean) => {
  const [state, setState] = useState<ListState>({ items: [], hasMore: false, isLoading: false, error: null, didLoad: false });
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const generation = useRef(0);
  const live = useRef(state);
  live.current = state;
  const pendingRefresh = useRef(false);
  const convId = scopeConversationId(scope);

  const query = useCallback(
    (offset: number, limit = pageSize) =>
      cloudList({ conversationId: convId, kind, sortBySize: sortBySize(sort), ascending: sortAscending(sort), offset, limit }),
    [convId, kind, sort],
  );

  const keepSelection = (items: CloudItem[]) =>
    setSelection((sel) => {
      const ids = new Set(items.map((i) => i.id));
      return new Set([...sel].filter((id) => ids.has(id)));
    });

  const reload = useCallback(async () => {
    const mine = ++generation.current;
    setState((s) => ({ ...s, isLoading: true, error: null }));
    const page = await query(0);
    if (mine !== generation.current) return;
    setState({ items: page.items, hasMore: page.hasMore, error: page.error, isLoading: false, didLoad: true });
    keepSelection(page.items);
  }, [query]);

  /** The server changed something: re-read what is already loaded without resetting paging or selection. */
  const refreshInPlace = useCallback(async () => {
    if (!live.current.didLoad) return reload();
    if (isSelecting) {
      pendingRefresh.current = true;
      return;
    }
    const mine = ++generation.current;
    const wanted = Math.max(live.current.items.length, pageSize);
    const fresh: CloudItem[] = [];
    let more = false;
    while (fresh.length < wanted) {
      const page = await query(fresh.length, Math.min(200, wanted - fresh.length));
      if (mine !== generation.current) return;
      if (page.error) return; // keep what is on screen
      const seen = new Set(fresh.map((i) => i.id));
      fresh.push(...page.items.filter((i) => !seen.has(i.id)));
      more = page.hasMore;
      if (!page.items.length || !page.hasMore) break;
    }
    setState((s) => ({ ...s, items: fresh, hasMore: more }));
    keepSelection(fresh);
  }, [query, reload, isSelecting]);

  const loadMore = useCallback(async () => {
    const s = live.current;
    if (!s.hasMore || s.isLoading) return;
    const mine = ++generation.current;
    setState((x) => ({ ...x, isLoading: true }));
    const page = await query(s.items.length);
    if (mine !== generation.current) return;
    setState((x) => {
      const seen = new Set(x.items.map((i) => i.id));
      return { ...x, items: [...x.items, ...page.items.filter((i) => !seen.has(i.id))], hasMore: page.hasMore, error: page.error ?? x.error, isLoading: false };
    });
  }, [query]);

  const remove = (keys: ReadonlySet<string>) => {
    setState((s) => ({ ...s, items: s.items.filter((i) => !keys.has(i.id)) }));
    setSelection((sel) => new Set([...sel].filter((id) => !keys.has(id))));
  };

  useEffect(() => {
    void reload();
  }, [reload]);

  // Leaving selection mode runs the refresh that was deferred while selecting.
  useEffect(() => {
    if (!isSelecting && pendingRefresh.current) {
      pendingRefresh.current = false;
      void refreshInPlace();
    }
  }, [isSelecting, refreshInPlace]);

  return { ...state, selection, setSelection, reload, refreshInPlace, loadMore, remove };
};

// MARK: - Screen

const kindOptions: { value: CloudItemKind | null; label: string }[] = [
  { value: null, label: 'Tất cả' },
  { value: 'photo', label: 'Ảnh' },
  { value: 'video', label: 'Video' },
  { value: 'file', label: 'File' },
  { value: 'voice', label: 'Tin nhắn thoại' },
];

export function CloudMediaView({ scope, onBack }: { scope: CloudScope; onBack?: () => void }) {
  const [kind, setKind] = useState<CloudItemKind | null>(null);
  const [sort, setSort] = useState<CloudSort>('newest');
  const [asGrid, setAsGrid] = useState(true);
  const [isSelecting, setSelecting] = useState(false);
  const [deleteTargets, setDeleteTargets] = useState<CloudItem[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const model = useCloudList(scope, kind, sort, isSelecting);
  const cloud = useCloud();

  const title = scope.kind === 'all' ? 'Tin nhắn media' : scope.kind === 'myCloud' ? 'Cloud của tôi' : scope.name || 'Trò chuyện';
  const subtitle = useMemo(() => {
    switch (scope.kind) {
      case 'all': {
        const bytes = kind ? breakdownBytes(cloud.media, kind) : breakdownTotal(cloud.media);
        return bytes > 0 ? formatSize(bytes) : '';
      }
      case 'myCloud': {
        const bytes = kind ? breakdownBytes(cloud.myCloudTypes, kind) : breakdownTotal(cloud.myCloudTypes);
        return bytes > 0 ? formatSize(bytes) : cloud.plan ? formatSize(cloud.plan.myCloud) : '';
      }
      case 'conversation': {
        const c = cloud.conversations.find((x) => x.id === scope.id);
        return c ? formatSize(c.total) : '';
      }
    }
  }, [scope, kind, cloud]);

  // The adapter bumps `changed` whenever cloud items were added / removed: re-read the open list.
  const firstChanged = useRef(cloud.changed);
  useEffect(() => {
    if (cloud.changed === firstChanged.current) return;
    const t = setTimeout(() => void model.refreshInPlace(), 1000);
    return () => clearTimeout(t);
  }, [cloud.changed]);

  const noticeSeq = useRef(0);
  const show = (text: string) => {
    const mine = ++noticeSeq.current;
    setNotice(text);
    setTimeout(() => {
      if (noticeSeq.current === mine) setNotice(null);
    }, 3500);
  };

  const toggle = (item: CloudItem) =>
    model.setSelection((sel) => {
      const next = new Set(sel);
      if (!next.delete(item.id)) next.add(item.id);
      return next;
    });

  const tap = (item: CloudItem) => (isSelecting ? toggle(item) : cloudUi.preview(item));

  const save = async (item: CloudItem) => {
    show('Đang tải về…');
    const r = await cloudFetch(item.id);
    if (r.state === 'expired') return show('Nội dung đã hết hạn trên zCloud.');
    if (r.state === 'failed') return show(r.message);
    const saved = await saveMediaAs(cloudFileUrl(r.file.path), outputName(item));
    if (saved) show('Đã lưu về máy.');
    else setNotice(null);
  };

  /** Mirrors the official sequence: optimistic removal + clear selection, then the delete itself. */
  const performDelete = async () => {
    if (deleting) return;
    const targets = deleteTargets;
    setDeleteTargets([]);
    setDeleting(true);
    const keys = new Set(targets.map((t) => t.id));
    model.remove(keys);
    if ([...model.selection].every((id) => keys.has(id))) setSelecting(false);
    const result = await cloudDelete(targets.map((t) => t.id));
    setDeleting(false);
    if (!result.failed.length && result.ok) {
      show('Đã xoá dữ liệu');
    } else {
      const done = result.deleted.length;
      show(done > 0 ? `Đã xoá ${done}/${targets.length} mục. ${result.error ?? 'Một số mục không xoá được.'}` : (result.error ?? 'Xoá không thành công'));
      void model.reload(); // bring back what was not deleted
    }
  };

  const menu = (e: MouseEvent, item: CloudItem) => {
    const items: MenuItem[] = [
      { label: 'Xem', icon: Eye, onSelect: () => cloudUi.preview(item) },
      { label: 'Lưu về máy…', icon: Save, onSelect: () => void save(item) },
      { kind: 'separator' },
      {
        label: model.selection.has(item.id) ? 'Bỏ chọn' : 'Chọn',
        icon: CheckCircle2,
        onSelect: () => {
          setSelecting(true);
          toggle(item);
        },
      },
      { kind: 'separator' },
      { label: 'Xoá dữ liệu…', icon: Trash2, destructive: true, disabled: deleting, onSelect: () => setDeleteTargets([item]) },
    ];
    openContextMenu(e, items);
  };

  // Paging: the sentinel after the last item asks for the next page when it scrolls into view.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && void model.loadMore(), { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [model.loadMore, asGrid, model.didLoad, model.items.length]);

  const chosen = model.items.filter((i) => model.selection.has(i.id));
  const deleteBytes = deleteTargets.reduce((n, i) => n + i.size, 0);

  let content;
  if (!model.didLoad) {
    content = (
      <div className="cloud-center">
        <Spinner size={18} />
        <span className="secondary">Đang tải dữ liệu zCloud…</span>
      </div>
    );
  } else if (!model.items.length) {
    content = model.error ? (
      <ContentUnavailable
        icon={CloudAlert}
        title="Không đọc được dữ liệu"
        description={model.error}
        actions={
          <button className="cz-btn" onClick={() => void model.reload()}>
            Thử lại
          </button>
        }
      />
    ) : (
      <ContentUnavailable
        icon={Inbox}
        title="Không có mục nào"
        description={kind === null ? 'Chưa có nội dung nào được lưu trong mục này.' : `Không có ${cloudKindTitle(kind).toLowerCase()} nào.`}
      />
    );
  } else if (asGrid) {
    content = (
      <div className="cloud-scroll">
        <div className="cloud-grid">
          {model.items.map((item) => (
            <button
              key={item.id}
              className={`cloud-cell ${model.selection.has(item.id) ? 'is-selected' : ''}`}
              onClick={() => tap(item)}
              onContextMenu={(e) => menu(e, item)}
              aria-label={`${itemName(item)}, ${formatSize(item.size)}`}
            >
              <GridTile item={item} selecting={isSelecting} selected={model.selection.has(item.id)} />
              <span className="cloud-cell-name truncate">{itemName(item)}</span>
              <span className="cloud-cell-meta truncate">
                {formatSize(item.size)} • {formatDate(item.date)}
              </span>
            </button>
          ))}
        </div>
        <div ref={sentinel} />
        {model.isLoading && model.didLoad && (
          <div className="cloud-footer-spinner">
            <Spinner size={14} />
          </div>
        )}
      </div>
    );
  } else {
    content = (
      <div className="cloud-scroll">
        <div className="cloud-list">
          {model.items.map((item) => (
            <ListRow
              key={item.id}
              item={item}
              selecting={isSelecting}
              selected={model.selection.has(item.id)}
              onClick={() => tap(item)}
              onContextMenu={(e) => menu(e, item)}
            />
          ))}
        </div>
        <div ref={sentinel} />
        {model.isLoading && model.didLoad && (
          <div className="cloud-footer-spinner">
            <Spinner size={14} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="column cloud-root cloud-detail">
      <div className="cloud-header" data-tauri-drag-region>
        {onBack ? (
          <button className="cz-icon-btn" onClick={onBack} title="Quay lại" aria-label="Quay lại">
            <ChevronLeft size={18} />
          </button>
        ) : (
          <HeaderIcon icon={scope.kind === 'myCloud' ? Folder : Images} />
        )}
        <div className="cloud-header-titles" data-tauri-drag-region>
          <div className="cloud-header-title truncate">{title}</div>
          {subtitle && <div className="cloud-header-sub truncate">{subtitle}</div>}
        </div>
        <div className="cz-icon-group" role="radiogroup" aria-label="Kiểu xem">
          <button className={`cz-icon-btn ${asGrid ? 'is-on' : ''}`} onClick={() => setAsGrid(true)} title="Lưới" aria-label="Lưới" aria-checked={asGrid} role="radio">
            <LayoutGrid size={15} />
          </button>
          <button className={`cz-icon-btn ${!asGrid ? 'is-on' : ''}`} onClick={() => setAsGrid(false)} title="Danh sách" aria-label="Danh sách" aria-checked={!asGrid} role="radio">
            <List size={16} />
          </button>
        </div>
        <div className="cz-icon-group">
          <button
            className="cz-icon-btn"
            title="Sắp xếp"
            aria-label="Sắp xếp"
            onClick={(e) =>
              openMenuBelow(
                e.currentTarget,
                cloudSorts.map((s) => ({ label: s.title, checked: s.id === sort, onSelect: () => setSort(s.id) })),
                'end',
              )
            }
          >
            <ArrowUpDown size={15} />
          </button>
        </div>
        <button
          className={`cz-btn ${isSelecting ? 'cz-btn-primary' : ''}`}
          disabled={!model.items.length}
          onClick={() => {
            if (isSelecting) model.setSelection(new Set());
            setSelecting(!isSelecting);
          }}
        >
          {isSelecting ? 'Xong' : 'Chọn'}
        </button>
      </div>
      <div className="cloud-filter">
        <Tabs options={kindOptions} value={kind} onChange={setKind} label="Loại nội dung" />
      </div>
      <div className="cloud-body">{content}</div>
      {isSelecting && (
        <div className="cloud-selection-bar slide-up">
          <span className="cloud-selection-text">
            {chosen.length ? `Đã chọn ${chosen.length} • ${formatSize(chosen.reduce((n, i) => n + i.size, 0))}` : 'Chọn các mục để xoá'}
          </span>
          <button className="cz-btn" onClick={() => model.setSelection(new Set(model.items.map((i) => i.id)))}>
            Chọn tất cả
          </button>
          <button className="cz-btn cz-btn-danger" disabled={!chosen.length || deleting} onClick={() => setDeleteTargets(chosen)}>
            Xoá…
          </button>
        </div>
      )}
      {notice && (
        <div className="cz-toast slide-up" style={{ bottom: isSelecting ? 76 : 24 }} role="status">
          {notice}
        </div>
      )}
      {deleteTargets.length > 0 && (
        <Alert
          title={deleteTargets.length === 1 ? 'Xoá dữ liệu này?' : `Xoá ${deleteTargets.length} mục?`}
          message={`${formatSize(deleteBytes)} dữ liệu sẽ được xoá và không thể khôi phục. Tin nhắn tương ứng cũng được xoá đồng bộ trên các thiết bị của bạn.`}
          buttons={[
            { label: 'Xoá dữ liệu', role: 'destructive', onClick: () => void performDelete() },
            { label: 'Huỷ', role: 'cancel', onClick: () => setDeleteTargets([]) },
          ]}
        />
      )}
    </div>
  );
}

// MARK: - Tiles & rows

function SelectMark({ selected }: { selected: boolean }) {
  return selected ? (
    <span className="cloud-check is-on">
      <Check size={12} strokeWidth={3} />
    </span>
  ) : (
    <span className="cloud-check">
      <Circle size={18} />
    </span>
  );
}

function GridTile({ item, selecting, selected }: { item: CloudItem; selecting: boolean; selected: boolean }) {
  const Icon = itemIcon(item);
  return (
    <span className="cloud-tile">
      {item.kind === 'photo' || item.kind === 'video' ? (
        <>
          <CloudThumbView item={item} />
          {item.kind === 'video' && (
            <>
              <span className="cloud-play">
                <Play size={18} fill="currentColor" />
              </span>
              {item.duration > 0 && <span className="cloud-badge nums">{formatDuration(item.duration)}</span>}
            </>
          )}
        </>
      ) : item.kind === 'voice' ? (
        <span className="cloud-tile-icon">
          <Icon size={30} strokeWidth={2.2} className="tint" />
          <span className="cloud-tile-caption">{item.duration > 0 ? formatDuration(item.duration) : 'Tin nhắn thoại'}</span>
        </span>
      ) : (
        <span className="cloud-tile-icon">
          <Icon size={34} strokeWidth={1.6} className="tint" />
          {item.ext && <span className="cloud-tile-ext">{item.ext.toUpperCase()}</span>}
        </span>
      )}
      {selecting && (
        <span className="cloud-tile-check">
          <SelectMark selected={selected} />
        </span>
      )}
    </span>
  );
}

function ListRow({
  item,
  selecting,
  selected,
  onClick,
  onContextMenu,
}: {
  item: CloudItem;
  selecting: boolean;
  selected: boolean;
  onClick: () => void;
  onContextMenu: (e: MouseEvent) => void;
}) {
  const Icon = itemIcon(item);
  const subtitle =
    (item.kind === 'video' || item.kind === 'voice') && item.duration > 0
      ? `${cloudKindTitle(item.kind)} • ${formatDuration(item.duration)}`
      : item.kind === 'file'
        ? item.ext
          ? item.ext.toUpperCase()
          : cloudKindTitle(item.kind)
        : cloudKindTitle(item.kind);
  return (
    <button className={`cloud-row ${selected ? 'is-selected' : ''}`} onClick={onClick} onContextMenu={onContextMenu}>
      {selecting && <SelectMark selected={selected} />}
      <span className="cloud-row-thumb">
        {item.kind === 'photo' || item.kind === 'video' ? (
          <CloudThumbView item={item} compact />
        ) : (
          <span className="cloud-tile-icon">
            <Icon size={20} className="tint" />
          </span>
        )}
      </span>
      <span className="cloud-row-text">
        <span className="cloud-row-name truncate">{itemName(item)}</span>
        <span className="cloud-row-sub truncate">{subtitle}</span>
      </span>
      <span className="cloud-row-conv truncate">{conversationLabel(item)}</span>
      <span className="cloud-row-size nums">{formatSize(item.size)}</span>
      <span className="cloud-row-date nums">{formatDate(item.date)}</span>
    </button>
  );
}
