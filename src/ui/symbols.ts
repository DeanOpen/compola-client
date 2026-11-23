// SF Symbol names the host scripts send (notice / placeholder kinds) → lucide icons.

import {
  AlertTriangle,
  CheckSquare,
  Info,
  Lock,
  LockKeyhole,
  RefreshCw,
  RefreshCwOff,
  Timer,
  UserPlus,
  type LucideIcon,
} from 'lucide-react';

const map: Record<string, LucideIcon> = {
  'info.circle': Info,
  checklist: CheckSquare,
  timer: Timer,
  'arrow.triangle.2.circlepath': RefreshCw,
  'exclamationmark.arrow.triangle.2.circlepath': RefreshCwOff,
  lock: Lock,
  'lock.trianglebadge.exclamationmark': LockKeyhole,
  'exclamationmark.triangle': AlertTriangle,
  'person.badge.plus': UserPlus,
};

export const symbolIcon = (name: string): LucideIcon => map[name] ?? Info;
