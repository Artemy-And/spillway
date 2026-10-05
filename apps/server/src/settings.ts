import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from './db/client.ts';
import { settings } from './db/schema.ts';
import { calendar, isTimeZone, SERVER_ZONE } from './lib/time.ts';

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

/** Where alerts go and which ones. Webhook URLs are secrets: they are kept sealed by the vault. */
export const notificationsSchema = z.object({
  slackUrl: z.string().nullable().default(null),
  teamsUrl: z.string().nullable().default(null),
  emails: z.array(z.email()).max(20).default([]),
  /** A team reaches its threshold or budget, a key its limit */
  budget: z.boolean().default(true),
  /** A cloud provider starts failing, and answers again */
  outages: z.boolean().default(true),
  /** Monday morning: last week's spend, savings and top spenders */
  weekly: z.boolean().default(true),
});

export type Notifications = z.infer<typeof notificationsSchema>;

const webhook = z
  .url({ protocol: /^https?$/ })
  .or(z.literal(''))
  .nullable();

/** What the Settings page sends: plain webhook URLs, '' or null to remove one. */
export const notificationsPatch = z
  .object({
    slackUrl: webhook,
    teamsUrl: webhook,
    emails: z.array(z.email()).max(20),
    budget: z.boolean(),
    outages: z.boolean(),
    weekly: z.boolean(),
  })
  .partial();

const fields = {
  /** Budgets reset and working hours run on this zone's clock; null = the server's zone */
  timeZone: z.string().refine(isTimeZone, 'Unknown time zone').nullable(),
  storePrompts: z.boolean(),
  retentionDays: z.number().int().min(1).max(3650),
  /** Where requests go when a budget or rule sends them to a local model */
  localModelId: z.string().nullable(),
  /** Answer with the local model when a cloud provider fails, times out or is rate limited */
  rerouteOnFailure: z.boolean(),
  /** Repeated identical requests get the stored answer for free; off until an admin opts in */
  cache: z.object({ enabled: z.boolean(), ttlHours: z.number().int().min(1).max(720) }),
};

export const settingsSchema = z.object({
  timeZone: fields.timeZone.default(null),
  storePrompts: fields.storePrompts.default(true),
  retentionDays: fields.retentionDays.default(30),
  localModelId: fields.localModelId.default(null),
  rerouteOnFailure: fields.rerouteOnFailure.default(true),
  cache: fields.cache.default({ enabled: false, ttlHours: 24 }),
  rules: rulesSchema.default(rulesSchema.parse({})),
  notifications: notificationsSchema.default(notificationsSchema.parse({})),
});

/**
 * What the Settings page may change. No defaults here: a field left out keeps its value
 * (with defaults, saving one switch would quietly reset the others).
 */
export const settingsPatch = z.object(fields).partial();

export type Settings = z.infer<typeof settingsSchema>;
export type RuleId = keyof Settings['rules'];

/** The calendar budgets and working hours follow. */
export const calendarOf = (settings: Settings) => calendar(settings.timeZone ?? SERVER_ZONE);

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
