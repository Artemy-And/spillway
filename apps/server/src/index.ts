import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { Oidc } from './auth/oidc.ts';
import { bootstrap, cleanup } from './bootstrap.ts';
import { recoverReservations } from './budget/ledger.ts';
import { type AppContext, RateLimiter, VERSION } from './context.ts';
import { openDb } from './db/client.ts';
import { seedDemo } from './demo.ts';
import { loadEnv } from './env.ts';
import { loadSecret, newSetupCode, Vault } from './lib/crypto.ts';
import { watch } from './notify.ts';
import { SettingsStore } from './settings.ts';

const env = loadEnv();
mkdirSync(env.DATA_DIR, { recursive: true });

const secret = loadSecret(env.SPILLWAY_SECRET, env.DATA_DIR);
const { db, close } = await openDb(join(env.DATA_DIR, 'spillway.db'));

const ctx: AppContext = {
  db,
  env,
  secret,
  vault: new Vault(secret),
  settings: new SettingsStore(db),
  oidc: Oidc.fromEnv(env),
  rateLimiter: new RateLimiter(),
  setupCode: newSetupCode(),
  publicDir: process.env.PUBLIC_DIR ?? resolve(import.meta.dirname, '../public'),
};

// The demo has its own company and refreshes its traffic every hour.
let demoTimer: NodeJS.Timeout | undefined;
if (env.DEMO) {
  await seedDemo(ctx);
  demoTimer = setInterval(() => seedDemo(ctx).catch(console.error), 3_600_000);
}
await bootstrap(ctx);
await recoverReservations(db);
await cleanup(ctx);
const cleanupTimer = setInterval(() => cleanup(ctx).catch(console.error), 3_600_000);
const notifyTimer = setInterval(() => watch(ctx).catch(console.error), 60_000);

const server = serve(
  { fetch: createApp(ctx).fetch, port: env.PORT, hostname: env.HOST },
  (info) => {
    console.log(
      `Spillway ${VERSION} listening on http://${info.address}:${info.port} (${env.PUBLIC_URL})`,
    );
  },
);

function shutdown() {
  clearInterval(cleanupTimer);
  clearInterval(notifyTimer);
  clearInterval(demoTimer);
  server.close(() => {
    close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
