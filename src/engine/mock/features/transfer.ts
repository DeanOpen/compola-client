// Mock of transfer-adapter.js (`__zaloTransfer`): availability, the official offer and a sync that runs through the
// official phases. Scenarios: `&transfer=run` (start a sync after boot), `&transfer=offer|waiting|transferring|finished|
// failed` (a fixed state), `&transferBlocked=SYNC_RUNNING` (manual sync refused), `&setupSync=1` (sign in from the QR
// screen straight into the setup sync step; combine with `&phase=login`).

import type { Json } from '../../models/json';
import { mockContext, onMockBoot, registerMockAdapter } from '../registry';

let current: Json | null = null;
let hidden = false;
let timers: ReturnType<typeof setTimeout>[] = [];

const publish = (t: Json | null) => {
  current = t;
  if (t === null || !hidden || t.phase === 'finished' || t.phase === 'failed') {
    if (t && (t.phase === 'finished' || t.phase === 'failed')) hidden = false;
    mockContext().post({ transfer: t });
  }
};

const available = (canStart: boolean, reason: string | null = null) => mockContext().post({ transferAvailable: { canStart, reason } });

const base = (phase: string, extra: Json = {}): Json => ({
  phase,
  stage: null,
  stageIndex: null,
  stageCount: null,
  progress: null,
  stageProgress: null,
  syncedConversations: 0,
  receivedMessages: null,
  totalConversations: null,
  message: null,
  errorCode: null,
  errorName: null,
  canRetry: false,
  ...extra,
});

const fixed: Record<string, Json> = {
  offer: base('offer', { stage: 'modal' }),
  waiting: base('waitingForPhone', { stage: 'confirmMobile' }),
  transferring: base('transferring', { stage: 'otherMessages', stageIndex: 3, stageCount: 3, progress: 0.72, stageProgress: 0.16, receivedMessages: 18_432 }),
  finished: base('finished', { progress: 1, receivedMessages: 24_816 }),
  failed: base('failed', { errorCode: 1003, errorName: 'MOBILE_BUSY', canRetry: true }),
};

const clear = () => {
  timers.forEach(clearTimeout);
  timers = [];
};

const at = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));

/** waitingForPhone → transferring (3 stages) → finished, like the sync-v2 machine. */
const run = () => {
  clear();
  hidden = false;
  available(false, 'SYNC_RUNNING');
  publish(base('waitingForPhone', { stage: 'openMobile' }));
  at(1500, () => publish(base('waitingForPhone', { stage: 'confirmMobile' })));
  at(4000, () => publish(base('transferring', { stage: 'conversationList', stageIndex: 1, stageCount: 3 })));
  let t = 5500;
  for (let i = 1; i <= 5; i += 1) {
    const p = i / 5;
    at(t, () => publish(base('transferring', { stage: 'messages', stageIndex: 2, stageCount: 3, stageProgress: p, progress: 1 / 3 + p / 3 })));
    t += 600;
  }
  for (let i = 1; i <= 8; i += 1) {
    const p = i / 8;
    at(t, () =>
      publish(base('transferring', { stage: 'otherMessages', stageIndex: 3, stageCount: 3, stageProgress: p, progress: 2 / 3 + p / 3, receivedMessages: Math.round(2400 * i * i) })),
    );
    t += 700;
  }
  at(t, () => {
    publish(base('finished'));
    available(true);
  });
};

const cancel = () => {
  clear();
  publish(null);
  available(true);
};

registerMockAdapter('__zaloTransfer', {
  start: () => {
    if (current && current.phase !== 'finished' && current.phase !== 'failed') return;
    run();
  },
  respond: (accept: boolean, expected: string | null) => {
    const phase = current?.phase;
    if (!phase || (expected && expected !== phase)) return publish(current);
    if (phase === 'offer' || phase === 'failed') return accept ? run() : cancel();
    if (!accept && (phase === 'waitingForPhone' || phase === 'transferring')) return cancel();
  },
  dismiss: (expected: string | null) => {
    const phase = current?.phase;
    if (!phase || (expected && expected !== phase)) return;
    if (phase === 'offer') return cancel();
    if (phase === 'finished' || phase === 'failed') {
      current = null;
      return;
    }
    hidden = true; // the sync continues in the background
  },
  state: () => current,
});

onMockBoot(({ params }) => {
  const blocked = params.get('transferBlocked');
  available(!blocked, blocked);
  const scenario = params.get('transfer');
  if (scenario === 'run') setTimeout(run, 800);
  else if (scenario && fixed[scenario]) setTimeout(() => publish(fixed[scenario]), 600);
});

// Dev aid: sign in from the QR screen right away (setup → sync step).
if (new URLSearchParams(location.search).has('setupSync')) {
  setTimeout(() => (window as unknown as { __mockLogin?: (w: string) => void }).__mockLogin?.('ok'), 1500);
}
