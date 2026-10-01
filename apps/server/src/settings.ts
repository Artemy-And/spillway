import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from './db/client.ts';
import { settings } from './db/schema.ts';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const rulesSchema = z.object({
  budgetThreshold: z
    .object({ enabled: z.boolean(), percent: z.number().int().min(1).max(100) })
    .default({ enabled: true, percent: 80 }),
  piiGuard: z.object({ enabled: z.boolean() }).default({ enabled: true }),
  agentRateLimit: z
    .object({ enabled: z.boolean(), rpm: z.number().int().min(1).max(100_000) })
    .default({ enabled: true, rpm: 60 }),
  offHours: z
    .object({ enabled: z.boolean(), from: time, to: time })
    .default({ enabled: false, from: '08:00', to: '20:00' }),
});

export const settingsSchema = z.object({
  storePrompts: z.boolean().default(true),
  retentionDays: z.number().int().min(1).max(3650).default(30),
  /** Where requests go when a budget or rule sends them to a local model */
  localModelId: z.string().nullable().default(null),
  /** Answer with the local model when a cloud provider fails, times out or is rate limited */
  rerouteOnFailure: z.boolean().default(true),
  rules: rulesSchema.default(rulesSchema.parse({})),
});

export type Settings = z.infer<typeof settingsSchema>;
export type RuleId = keyof Settings['rules'];

export const RULE_IDS: RuleId[] = ['budgetThreshold', 'piiGuard', 'agentRateLimit', 'offHours'];

const KEY = 'app';

export class SettingsStore {
  #db: Db;
  #cache: Settings | null = null;

  constructor(db: Db) {
    this.#db = db;
  }

  async get(): Promise<Settings> {
    if (this.#cache) return this.#cache;
    const row = await this.#db.query.settings.findFirst({ where: eq(settings.key, KEY) });
    this.#cache = settingsSchema.parse(row?.value ?? {});
    return this.#cache;
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    const next = settingsSchema.parse({ ...(await this.get()), ...patch });
    await this.#db
      .insert(settings)
      .values({ key: KEY, value: next })
      .onConflictDoUpdate({ target: settings.key, set: { value: next } });
    this.#cache = next;
    return next;
  }
}
