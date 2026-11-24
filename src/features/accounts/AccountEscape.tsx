// Back to another account from a full-window screen (QR sign-in, splash, first-run setup). Those screens hide the rail,
// so after switching to a signed-out account — or signing the one on screen out — by mistake, this is the way back.
// Shown only while other accounts exist; a click switches like the rail does.

import { ArrowLeft } from 'lucide-react';
import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { accountTitle, startAccounts, switchAccount, useAccounts } from '../../engine/accounts';
import { Avatar } from '../../ui/Avatar';
import './accounts.css';

export function AccountEscape() {
  // The rail loads the account list; these screens may come first (Compola restarted on a signed-out account).
  useEffect(() => void startAccounts(), []);
  const activeId = useAccounts((s) => s.activeId);
  const others = useAccounts(useShallow((s) => s.accounts.filter((a) => a.id !== activeId && a.phase !== 'disabled')));
  if (!activeId || others.length === 0) return null;
  // Signed-in accounts first: those are the ones worth going back to.
  const sorted = [...others].sort((a, b) => Number(b.phase === 'ready') - Number(a.phase === 'ready'));
  // Names only for a single account: the pill must stay clear of the centred logo on a narrow window.
  const named = sorted.length === 1;
  return (
    <nav className="account-escape fade-in" aria-label="Tài khoản Zalo khác">
      <span className="account-escape-label">
        <ArrowLeft size={13} />
        Quay lại
      </span>
      {sorted.map((a) => (
        <button
          key={a.id}
          className={`account-escape-item ${named ? 'is-named' : ''} ${a.phase === 'ready' ? '' : 'is-out'}`}
          title={`Chuyển sang ${accountTitle(a)}`}
          aria-label={`Chuyển sang ${accountTitle(a)}`}
          onClick={() => switchAccount(a.id)}
        >
          <Avatar url={a.avatar} name={accountTitle(a)} size={24} />
          {named && <span className="account-escape-name">{accountTitle(a)}</span>}
          {a.badge > 0 && <span className="account-escape-badge nums">{a.badge > 99 ? '99+' : a.badge}</span>}
        </button>
      ))}
    </nav>
  );
}
