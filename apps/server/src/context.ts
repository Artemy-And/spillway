import type { Oidc } from './auth/oidc.ts';
import type { Db } from './db/client.ts';
import type { Env } from './env.ts';
import type { Vault } from './lib/crypto.ts';
import type { SettingsStore } from './settings.ts';

export const VERSION = '0.1.0';

export interface AppContext {
  db: Db;
  env: Env;
  vault: Vault;
  secret: string;
  settings: SettingsStore;
  oidc: Oidc | null;
  rateLimiter: RateLimiter;
  /** Built admin UI to serve, if any */
  publicDir: string | null;
}

/** Sliding one-minute window per key, in memory. */
export class RateLimiter {
  #hits = new Map<string, number[]>();

  hit(id: string, perMinute: number, now = Date.now()): boolean {
    const recent = (this.#hits.get(id) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= perMinute) {
      this.#hits.set(id, recent);
      return false;
    }
    recent.push(now);
    this.#hits.set(id, recent);
    return true;
  }
}
