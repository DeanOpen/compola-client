// Native-looking menus: context menus (right click) and pull-down menus of buttons, rendered by one `<MenuHost/>`.

import { Check, ChevronRight, type LucideIcon } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { create } from 'zustand';
import { useEscape } from './escape';
import './ui.css';

export type MenuItem =
  | {
      kind?: 'item';
      label: string;
      icon?: LucideIcon;
      onSelect: () => void;
      disabled?: boolean;
      destructive?: boolean;
      checked?: boolean;
      shortcut?: string;
      /** Leading color dot (labels). */
      dot?: string;
      trailing?: ReactNode;
    }
  | { kind: 'separator' }
  | { kind: 'submenu'; label: string; icon?: LucideIcon; items: MenuItem[]; disabled?: boolean }
  | { kind: 'label'; label: string };

interface MenuState {
  open: { x: number; y: number; items: MenuItem[]; minWidth?: number } | null;
}

const useMenuStore = create<MenuState>(() => ({ open: null }));

export const closeMenu = () => useMenuStore.setState({ open: null });

/** Context menu at the pointer. Empty item lists open nothing (the browser menu is suppressed either way). */
export const openContextMenu = (e: ReactMouseEvent | MouseEvent, items: MenuItem[]) => {
  e.preventDefault();
  e.stopPropagation();
  const cleaned = tidy(items);
  if (!cleaned.length) return;
  useMenuStore.setState({ open: { x: e.clientX, y: e.clientY, items: cleaned } });
};

/** Pull-down menu under an element (button menus). */
export const openMenuBelow = (el: Element, items: MenuItem[], align: 'start' | 'end' = 'start') => {
  const r = el.getBoundingClientRect();
  const cleaned = tidy(items);
  if (!cleaned.length) return;
  useMenuStore.setState({ open: { x: align === 'start' ? r.left : r.right, y: r.bottom + 4, items: cleaned, minWidth: align === 'end' ? -1 : undefined } });
};

/** Drops leading / trailing / doubled separators. */
const tidy = (items: MenuItem[]): MenuItem[] => {
  const out: MenuItem[] = [];
  for (const item of items) {
    if (item.kind === 'separator' && (out.length === 0 || out[out.length - 1].kind === 'separator')) continue;
    out.push(item);
  }
  while (out.length && out[out.length - 1].kind === 'separator') out.pop();
  return out;
};

export function MenuHost() {
  const open = useMenuStore((s) => s.open);
  useEscape(!!open, closeMenu);
  useEffect(() => {
    if (!open) return;
    const close = () => closeMenu();
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="menu-layer" onMouseDown={closeMenu} onContextMenu={(e) => { e.preventDefault(); closeMenu(); }}>
      <MenuPanel items={open.items} x={open.x} y={open.y} alignEnd={open.minWidth === -1} />
    </div>
  );
}

function MenuPanel({ items, x, y, alignEnd = false, submenu = false }: { items: MenuItem[]; x: number; y: number; alignEnd?: boolean; submenu?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [openSub, setOpenSub] = useState<number | null>(null);
  const [active, setActive] = useState<number>(-1);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = alignEnd ? x - r.width : x;
    let top = y;
    if (left + r.width > window.innerWidth - 6) left = window.innerWidth - r.width - 6;
    if (top + r.height > window.innerHeight - 6) top = Math.max(6, window.innerHeight - r.height - 6);
    setPos({ left: Math.max(6, left), top });
  }, [x, y, alignEnd, submenu]);

  useEffect(() => {
    if (submenu) return;
    const onKey = (e: KeyboardEvent) => {
      const selectable = items.map((it, i) => ({ it, i })).filter(({ it }) => (it.kind === undefined || it.kind === 'item') && !it.disabled);
      if (!selectable.length) return;
      const at = selectable.findIndex(({ i }) => i === active);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive(selectable[(at + 1) % selectable.length].i);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive(selectable[(at - 1 + selectable.length) % selectable.length].i);
      } else if (e.key === 'Enter' && at >= 0) {
        e.preventDefault();
        const it = items[active];
        if (it.kind === undefined || it.kind === 'item') {
          closeMenu();
          it.onSelect();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [items, active, submenu]);

  return (
    <div ref={ref} className="menu glass-strong pop-in" style={pos} role="menu" onMouseDown={(e) => e.stopPropagation()}>
      {items.map((item, i) => {
        if (item.kind === 'separator') return <div key={i} className="menu-separator" />;
        if (item.kind === 'label') return <div key={i} className="menu-label">{item.label}</div>;
        if (item.kind === 'submenu') {
          const Icon = item.icon;
          return (
            <div key={i} className={`menu-item ${openSub === i ? 'is-active' : ''}`} aria-disabled={item.disabled} onMouseEnter={() => { setOpenSub(i); setActive(i); }}>
              <span className="menu-check" />
              {Icon && <Icon size={15} className="menu-icon" />}
              <span className="menu-text">{item.label}</span>
              <ChevronRight size={13} className="menu-chevron" />
              {openSub === i && !item.disabled && <SubmenuAnchor items={item.items} />}
            </div>
          );
        }
        const Icon = item.icon;
        return (
          <button
            key={i}
            role="menuitem"
            className={`menu-item ${item.destructive ? 'is-destructive' : ''} ${active === i ? 'is-active' : ''}`}
            disabled={item.disabled}
            onMouseEnter={() => { setOpenSub(null); setActive(i); }}
            onClick={() => {
              closeMenu();
              item.onSelect();
            }}
          >
            <span className="menu-check">{item.checked && <Check size={13} strokeWidth={2.5} />}</span>
            {item.dot && <span className="menu-dot" style={{ background: item.dot }} />}
            {Icon && <Icon size={15} className="menu-icon" />}
            <span className="menu-text">{item.label}</span>
            {item.trailing}
            {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
          </button>
        );
      })}
    </div>
  );
}

function SubmenuAnchor({ items }: { items: MenuItem[] }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    setRect(ref.current?.parentElement?.getBoundingClientRect() ?? null);
  }, []);
  return (
    <span ref={ref}>
      {rect && <MenuPanel items={items} x={rect.right - 2} y={rect.top - 5} submenu />}
    </span>
  );
}
