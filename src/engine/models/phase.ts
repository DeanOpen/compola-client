// Engine lifecycle as emitted by Rust on `compola://phase` (src-tauri/src/engine.rs `Phase`).
// Swift: `ZaloEngine.Phase` / `RuntimeSetup` / `LoginState`.

export type RuntimeStep = 'looking' | 'downloading' | 'verifying' | 'installing';

export interface RuntimeSetup {
  step: RuntimeStep;
  received?: number | null;
  total?: number | null;
  /** Why the last attempt failed; the window offers to try again. */
  failure?: string | null;
}

export type LoginStep =
  | { kind: 'generating' }
  | { kind: 'waitingScan' }
  /** Phone scanned; waiting for "Đăng nhập" on the phone. */
  | { kind: 'waitingConfirm'; name: string; avatar?: string | null }
  | { kind: 'expired' }
  | { kind: 'failed'; message: string };

export interface LoginState {
  step: LoginStep;
  /** `data:image/png;base64,…` or `data:image/svg+xml;utf8,…` */
  qr: string | null;
  /** The server asked for a second scan (multi-layer QR for device linking). */
  isSecondQr: boolean;
}

export type Phase =
  | { kind: 'starting' }
  | { kind: 'preparing'; setup: RuntimeSetup }
  | { kind: 'login'; login: LoginState; notice?: string | null }
  | { kind: 'signingIn' }
  | { kind: 'ready' };

export interface Profile {
  userId: string;
  displayName: string;
  avatar: string | null;
  phone: string | null;
}
