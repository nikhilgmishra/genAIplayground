/**
 * In-memory bearer token holder.
 *
 * The console token is NEVER written to localStorage, sessionStorage, IndexedDB
 * or cookies (lint-enforced in eslint.config.js). Reloading the page signs the
 * operator out; workforce SSO re-authenticates them. The token is dropped as
 * soon as its expiry passes.
 */
export interface TokenStore {
  get(): string | null;
  set(token: string, expiresAt: string): void;
  clear(): void;
  expiresAt(): string | null;
}

export function createMemoryTokenStore(now: () => number = () => Date.now()): TokenStore {
  let token: string | null = null;
  let expiry: number | null = null;
  let expiryIso: string | null = null;
  const clear = (): void => {
    token = null;
    expiry = null;
    expiryIso = null;
  };
  return {
    get() {
      if (token !== null && (expiry === null || now() >= expiry)) clear();
      return token;
    },
    set(next, expiresAt) {
      const parsed = Date.parse(expiresAt);
      if (!next || !Number.isFinite(parsed)) {
        clear();
        return;
      }
      token = next;
      expiry = parsed;
      expiryIso = expiresAt;
    },
    clear,
    expiresAt() {
      return token === null ? null : expiryIso;
    },
  };
}
