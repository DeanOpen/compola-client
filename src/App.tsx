// Window content (Swift `RootView`): a splash while the client boots, the first-run setup (sign-in → phone sync →
// welcome) or the main window. `setupPending` separates a fresh QR sign-in, which owes the user the sync and welcome
// steps, from a restored session, which goes straight to the main window.

import { useEffect } from 'react';
import { useEngine } from './engine/store';
import { RuntimeSetupView } from './features/setup/RuntimeSetupView';
import { SetupFlow } from './features/setup/SetupFlow';
import { SplashView, appName } from './features/setup/SplashView';
import { getPref, setPref, usePref } from './features/setup/prefs';
import { MainShell } from './shell/MainShell';
import { shell } from './shell/shellStore';
import { MenuHost } from './ui/Menu';

export default function App() {
  const phase = useEngine((s) => s.phase);
  const setupPending = usePref('setupPending');

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

  const finishSetup = (_startTour: boolean) => {
    // The coach-mark tour is a later wave; finishing goes straight to the main window.
    setPref('didFinishSetup', true);
    setPref('setupPending', false);
  };

  let content;
  switch (phase.kind) {
    case 'starting':
      content = <SplashView message={`Đang khởi động ${appName}…`} />;
      break;
    case 'preparing':
      content = <RuntimeSetupView setup={phase.setup} />;
      break;
    case 'login':
      content = <SetupFlow onFinish={finishSetup} />;
      break;
    case 'signingIn':
      content = setupPending ? <SetupFlow onFinish={finishSetup} /> : <SplashView message="Đang đăng nhập và đồng bộ dữ liệu…" />;
      break;
    case 'ready':
      content = setupPending ? <SetupFlow onFinish={finishSetup} /> : <MainShell />;
      break;
  }

  return (
    <>
      {content}
      <MenuHost />
    </>
  );
}
