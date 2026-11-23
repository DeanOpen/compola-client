// Pickers of the zCloud screens in the Zalo PC look: text tabs with an underline (Zalo's "Tất cả | Chưa đọc"), a compact
// segmented control, and the icon of a screen's title bar.

import type { LucideIcon } from 'lucide-react';

interface PickerProps<T> {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}

/** Text tabs; the active one is primary with a 2px underline. */
export function Tabs<T>({ options, value, onChange, label }: PickerProps<T>) {
  return (
    <div className="cz-tabs" role="tablist" aria-label={label}>
      {options.map((o, i) => (
        <button key={i} role="tab" aria-selected={o.value === value} className={`cz-tab ${o.value === value ? 'is-on' : ''}`} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Compact segmented control (SwiftUI `.pickerStyle(.segmented)`). */
export function Segmented<T>({ options, value, onChange, label }: PickerProps<T>) {
  return (
    <div className="cz-seg" role="radiogroup" aria-label={label}>
      {options.map((o, i) => (
        <button key={i} role="radio" aria-checked={o.value === value} className={`cz-seg-item ${o.value === value ? 'is-on' : ''}`} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** The icon left of a main-area title (Zalo PC title bars). */
export function HeaderIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="cloud-header-icon" aria-hidden>
      <Icon size={20} />
    </span>
  );
}
