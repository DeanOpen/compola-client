// Window content (Swift `RootView`): a splash while the client boots, the first-run setup (sign-in → phone sync →
// welcome) or the main window. `setupPending` separates a fresh QR sign-in, which owes the user the sync and welcome
// steps, from a restored session, which goes straight to the main window.
// Joined to a Compola Server: the connection gate replaces all of it until the first connection, and a banner shows
// while a dropped connection comes back (src/features/remote/RemoteGate.tsx).

import { useEffect, useRef } from 'react';
import { useAccounts } from './engine/accounts';
import { useRemote } from './engine/remote';
import { useEngine } from './engine/store';
import { AccountEscape } from './features/accounts/AccountEscape';
import { RemoteBanner, RemoteConnectScreen, useRemoteGateActive } from './features/remote/RemoteGate';
import { RuntimeSetupView } from './features/setup/RuntimeSetupView';
import { SetupFlow } from './features/setup/SetupFlow';
import { SplashView, appName } from './features/setup/SplashView';
import { getPref, setPref, usePref } from './features/setup/prefs';
import { MainShell } from './shell/MainShell';
import { shell } from './shell/shellStore';
import { MenuHost } from './ui/Menu';

export default function App() {
  const phase = useEngine((s) => s.phase);
  // A joined app skips the first-run steps (phone sync, welcome): they belong to the host's account.
  const joined = useRemote((s) => s.mode === 'joined');
  const setupPending = usePref('setupPending') && !joined;
  const remoteGate = useRemoteGateActive();
  // A restored session with a startup cache opens on the main window at once; the official client boots behind it.
  const cached = useEngine((s) => s.cached);

  useEffect(() => {
    if (phase.kind === 'login') {
      // Whenever the QR screen is shown a fresh sign-in is under way (also after logging out), and nothing of the
      // previous account's window may carry over.
      setPref('setupPending', true);
      shell.reset();
    } else if (phase.kind === 'ready') {
      // A restored session of someone who never saw the setup is not sent through it.
      if (!getPref('setupPending') && !getPref('didFinishSetup')) setPref('didFinishSetup', true);
    }
  }, [phase.kind]);

  // Switching to an account that is already signed in: the first-run steps are owed to a fresh QR sign-in (possibly of
  // the account just left, e.g. one switched to or signed out by mistake), never to it.
  const activeId = useAccounts((s) => s.activeId);
  const lastActive = useRef(activeId);
  useEffect(() => {
    const switched = lastActive.current !== null && activeId !== lastActive.current;
    lastActive.current = activeId;
    if (switched && useAccounts.getState().accounts.find((a) => a.id === activeId)?.phase === 'ready') setPref('setupPending', false);
  }, [activeId]);

  const finishSetup = (_startTour: boolean) => {
    // The coach-mark tour is a later wave; finishing goes straight to the main window.
    setPref('didFinishSetup', true);
    setPref('setupPending', false);
  };

  let content;
  let fullWindow = true; // a screen without the rail (and its account column)
  switch (phase.kind) {
    case 'starting':
      if (cached && !setupPending) {
        content = <MainShell />;
        fullWindow = false;
      } else content = <SplashView message={`Đang khởi động ${appName}…`} />;
      break;
    case 'preparing':
      content = <RuntimeSetupView setup={phase.setup} />;
      break;
    case 'login':
      content = <SetupFlow onFinish={finishSetup} />;
      break;
    case 'signingIn':
      if (setupPending) content = <SetupFlow onFinish={finishSetup} />;
      else if (cached) {
        content = <MainShell />;
        fullWindow = false;
      } else content = <SplashView message="Đang mở tài khoản Zalo…" />;
      break;
    case 'ready':
      content = setupPending ? <SetupFlow onFinish={finishSetup} /> : <MainShell />;
      fullWindow = setupPending;
      break;
  }

  if (remoteGate) content = <RemoteConnectScreen />;

  return (
    <>
      {content}
      {fullWindow && !remoteGate && <AccountEscape />}
      <RemoteBanner />
      <MenuHost />
    </>
  );
}
