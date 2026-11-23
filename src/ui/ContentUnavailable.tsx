import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import './ui.css';

/** SwiftUI `ContentUnavailableView`: a large symbol, a title, a description and optional actions, centered. */
export function ContentUnavailable({
  icon: Icon,
  title,
  description,
  actions,
}: {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="unavailable fade-in">
      <Icon size={40} strokeWidth={1.5} className="unavailable-icon" />
      <div className="unavailable-title">{title}</div>
      {description && <div className="unavailable-desc">{description}</div>}
      {actions && <div className="unavailable-actions">{actions}</div>}
    </div>
  );
}
