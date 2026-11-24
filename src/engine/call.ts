// Calls into the host-script adapters running in the official renderer (`window[target][method](...args)`), via the
// Rust `engine_call` command. Replaces every `host.evaluate("window.__zaloX.method(...)")` of the Swift engine.

import { backend, forAccount, usesTauri } from './backend';

/** Adapter objects the renderer exposes (host-scripts/*-adapter.js). */
export type AdapterTarget =
  | '__zaloChat'
  | '__zaloCompose'
  | '__zaloMsgActions'
  | '__zaloConvActions'
  | '__zaloConversations'
  | '__zaloContacts'
  | '__zaloPoll'
  | '__zaloSticker'
  | '__zaloCloud'
  | '__zaloTransfer'
  | '__zaloCall'
  | '__zaloMediaStore'
  | '__zaloNotification'
  | '__zaloGroupCreate';

/** UI-side diagnostics: the dev console, and in the app the local log file too (`ui_log` → engine.log). */
export const log = (line: string) => {
  if (import.meta.env.DEV) console.debug('[engine]', line);
  // Never through log() again on failure (no loop); the web client and the mock have no local file.
  if (usesTauri) void backend().then((b) => b.invoke('ui_log', { line })).catch(() => {});
};

/**
 * Awaits the adapter's answer. Throws when the engine is not running or the adapter / method is missing
 * (engine.rs: `no __zaloX.method`), or when the JS threw.
 */
export const callAdapter = async <T = unknown>(target: AdapterTarget, method: string, ...args: unknown[]): Promise<T> => {
  const b = await backend();
  return b.invoke<T>('engine_call', forAccount({ target, method, args: args.map((a) => (a === undefined ? null : a)) }));
};

/** Like `callAdapter` but never throws: `fallback` when anything fails. */
export const tryAdapter = async <T>(fallback: T, target: AdapterTarget, method: string, ...args: unknown[]): Promise<T> => {
  try {
    const r = await callAdapter<T>(target, method, ...args);
    return r ?? fallback;
  } catch (e) {
    log(`${target}.${method} failed: ${String(e)}`);
    return fallback;
  }
};

/** Fire-and-forget (Swift `callChat`). */
export const fireAdapter = (target: AdapterTarget, method: string, ...args: unknown[]): void => {
  callAdapter(target, method, ...args).catch((e) => log(`${target}.${method} → ${String(e)}`));
};

/** Resolves to `null` when `promise` has not settled after `seconds` (Swift `raceTimeout`). */
export const raceTimeout = <T>(seconds: number, promise: Promise<T>): Promise<{ value: T } | null> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), seconds * 1000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ value });
      },
      () => {
        clearTimeout(timer);
        resolve({ value: undefined as T });
      },
    );
  });

/**
 * A composer action that needs files (the adapter clicks its hidden `<input type=file>`; Swift answered the open panel
 * with the picked URLs). Needs the Rust command `engine_call_with_files` (not in the contract yet): `files` are absolute
 * paths to provide, or null to let Rust show the native open panel (`pick` filters it). Throws when it does not exist.
 */
export const callAdapterWithFiles = async <T = unknown>(
  target: AdapterTarget,
  method: string,
  args: unknown[],
  files: string[] | null,
  pick: 'media' | 'files' = 'files',
  /** Another account than the one on screen (a screen capture finished after a switch). */
  account?: string | null,
): Promise<T> => {
  const b = await backend();
  return b.invoke<T>('engine_call_with_files', forAccount({ target, method, args, files, pick }, account));
};
