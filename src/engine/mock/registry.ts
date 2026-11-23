// Extension point of the mock backend for feature waves: a feature registers its adapter methods / commands and
// what it posts at boot from its own file in `mock/features/` (loaded automatically), so `mockBackend.ts` stays small.

import type { EngineEvent } from '../backend';
import type { Json } from '../models/json';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MockFn = (...a: any[]) => unknown;

export interface MockContext {
  /** Posts a `{page:'main', …state}` snapshot on `compola://state`. */
  post: (state: Json) => void;
  emit: (event: EngineEvent, payload: unknown) => void;
  params: URLSearchParams;
}

export const mockAdapters: Record<string, Record<string, MockFn>> = {};
export const mockCommands: Record<string, (args: Record<string, unknown>) => unknown> = {};
const bootHooks: ((ctx: MockContext) => void)[] = [];

let ctx: MockContext | null = null;

/** Adds (or overrides) methods of `window[target]` in the mock. */
export const registerMockAdapter = (target: string, methods: Record<string, MockFn>) => {
  mockAdapters[target] = { ...mockAdapters[target], ...methods };
};

/** Adds (or overrides) a Tauri command in the mock. */
export const registerMockCommand = (name: string, fn: (args: Record<string, unknown>) => unknown) => {
  mockCommands[name] = fn;
};

/** Runs after the mock account signed in (conversations posted). */
export const onMockBoot = (fn: (ctx: MockContext) => void) => {
  bootHooks.push(fn);
};

export const mockContext = (): MockContext => {
  if (!ctx) throw new Error('mock backend not created');
  return ctx;
};

export const setMockContext = (c: MockContext) => {
  ctx = c;
};

export const runMockBootHooks = () => {
  for (const hook of bootHooks) hook(mockContext());
};

/** Multi-account mock: re-posts the signed-in state as another account (`user`, the conversations `ids` it has). */
type AccountBoot = (user: Json, ids: string[] | null) => void;
let accountBoot: AccountBoot | null = null;
export const setMockAccountBoot = (fn: AccountBoot) => {
  accountBoot = fn;
};
export const mockAccountBoot: AccountBoot = (user, ids) => accountBoot?.(user, ids);

/** Returned by a mock command that only handles some calls: the built-in mock answers this one. */
export const mockPass = Symbol('mockPass');
