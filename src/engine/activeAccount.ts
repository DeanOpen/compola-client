// The Zalo account on screen, for code that cannot depend on the accounts store (media URLs, the web client's
// transport): set by accounts.ts whenever the active account changes. null on a single-account host.

let active: string | null = null;

export const activeAccountId = () => active;

export const setActiveAccountId = (id: string | null) => {
  active = id;
};
