import { readFileSync } from 'node:fs';
import type { Oidc } from './auth/oidc.ts';
import type { Db } from './db/client.ts';
import type { Env } from './env.ts';
import type { Vault } from './lib/crypto.ts';
import type { SettingsStore } from './settings.ts';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
  repository: { url: string };
};

/** From apps/server/package.json, which a release tag must match. */
export const VERSION = pkg.version;

/**
 * Where people using this gateway can get its source, as the AGPL asks of anything offered
 * over a network. A modified build should point package.json "repository" at its own code.
 */
export const SOURCE_URL = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');

export interface AppContext {
  db: Db;
  env: Env;
  vault: Vault;
  secret: string;
  settings: SettingsStore;
  oidc: Oidc | null;
  rateLimiter: RateLimiter;
  /**
   * Asked for when the first admin is created in the browser, so that has to be someone who can
   * read the server's logs, not whoever reaches a fresh install first. Printed at every start.
   */
  setupCode: string;
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
