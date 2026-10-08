import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type {
  ComparisonReport,
  ComparisonSummary,
  ReferenceRun,
  TaskSetInput,
} from '../comparison/types.ts';
import { ROUTING_OUTCOMES, type RoutingEvidence } from '../routing/types.ts';

const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());
const createdAt = () =>
  integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date());
const timestamp = (name: string) => integer(name, { mode: 'timestamp_ms' });

export const PROVIDER_KINDS = ['openai', 'anthropic', 'ollama'] as const;
export const KEY_KINDS = ['person', 'device', 'agent'] as const;
export const ROLES = ['admin', 'member'] as const;
/** `openai` is chat completions; `responses` is OpenAI's Responses API, which Codex speaks. */
export const CLIENT_FORMATS = ['openai', 'anthropic', 'ollama', 'responses'] as const;
export const RESULTS = [
  'ok',
  'rerouted',
  'blocked_pii',
  'blocked_budget',
  'blocked_model',
  'rate_limited',
  'error',
] as const;

export type ProviderKind = (typeof PROVIDER_KINDS)[number];
export type KeyKind = (typeof KEY_KINDS)[number];
export type Result = (typeof RESULTS)[number];
export type TraceTone = 'ok' | 'warn' | 'info' | 'block';
/**
 * One line of a request's "why". `text` is English for API clients and old rows;
 * `code` and `params` let the admin UI show it in the viewer's language.
 */
export type TraceStep = {
  tone: TraceTone;
  text: string;
  code?: string;
  params?: Record<string, string | number | boolean | Record<string, number> | null>;
};

export const teams = sqliteTable('teams', {
  id: id(),
  name: text('name').notNull().unique(),
  monthlyBudgetUsd: real('monthly_budget_usd'),
  /** null = every enabled model */
  allowedModelIds: text('allowed_model_ids', { mode: 'json' }).$type<string[]>(),
  createdAt: createdAt(),
});

export const users = sqliteTable('users', {
  id: id(),
  email: text('email').notNull().unique(),
  name: text('name'),
  role: text('role', { enum: ROLES }).notNull().default('member'),
  teamId: text('team_id').references(() => teams.id, { onDelete: 'set null' }),
  passwordHash: text('password_hash'),
  createdAt: createdAt(),
  lastLoginAt: timestamp('last_login_at'),
  disabledAt: timestamp('disabled_at'),
  /** When the person closed the welcome tour */
  welcomedAt: timestamp('welcomed_at'),
  /** When the person hid the getting-started checklist */
  checklistHiddenAt: timestamp('checklist_hidden_at'),
});

export const sessions = sqliteTable('sessions', {
  /** sha256 of the cookie value */
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: createdAt(),
});

/** One-time links that let someone set their password; only a hash of the token is kept. */
export const invites = sqliteTable('invites', {
  /** sha256 of the token in the link */
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: createdAt(),
});

export const providers = sqliteTable('providers', {
  id: id(),
  name: text('name').notNull(),
  kind: text('kind', { enum: PROVIDER_KINDS }).notNull(),
  baseUrl: text('base_url').notNull(),
  apiKeyEnc: text('api_key_enc'),
  isLocal: integer('is_local', { mode: 'boolean' }).notNull().default(false),
  createdAt: createdAt(),
});

export const models = sqliteTable('models', {
  id: id(),
  /** What clients send in the `model` field */
  name: text('name').notNull().unique(),
  label: text('label'),
  providerId: text('provider_id')
    .notNull()
    .references(() => providers.id, { onDelete: 'cascade' }),
  upstreamModel: text('upstream_model').notNull(),
  /** USD per 1M tokens. null = not set yet: the model is counted as free and flagged. */
  inputPrice: real('input_price'),
  outputPrice: real('output_price'),
  /** USD per 1M cached input tokens; null = a tenth of the input price */
  cacheReadPrice: real('cache_read_price'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: createdAt(),
});

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: id(),
    name: text('name').notNull(),
    kind: text('kind', { enum: KEY_KINDS }).notNull(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    teamId: text('team_id').references(() => teams.id, { onDelete: 'set null' }),
    prefix: text('prefix').notNull(),
    hash: text('hash').notNull().unique(),
    dailyLimitUsd: real('daily_limit_usd'),
    monthlyLimitUsd: real('monthly_limit_usd'),
    fallbackToLocal: integer('fallback_to_local', { mode: 'boolean' }).notNull().default(true),
    /** null = everything the team may use */
    allowedModelIds: text('allowed_model_ids', { mode: 'json' }).$type<string[]>(),
    createdAt: createdAt(),
    lastUsedAt: timestamp('last_used_at'),
    revokedAt: timestamp('revoked_at'),
  },
  (t) => [index('api_keys_user_idx').on(t.userId), index('api_keys_team_idx').on(t.teamId)],
);

/** One row per cloud attempt; no prompts, answers or credentials. Unknown holds need reconciliation. */
export const budgetReservations = sqliteTable(
  'budget_reservations',
  {
    id: id(),
    requestId: text('request_id').notNull(),
    keyId: text('key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    teamId: text('team_id').references(() => teams.id, { onDelete: 'set null' }),
    modelName: text('model_name').notNull(),
    providerName: text('provider_name').notNull(),
    state: text('state', { enum: ['active', 'unknown', 'settled', 'released'] }).notNull(),
    estimatedUsd: real('estimated_usd').notNull(),
    heldUsd: real('held_usd').notNull(),
    chargedUsd: real('charged_usd').notNull().default(0),
    reason: text('reason'),
    createdAt: createdAt(),
    settledAt: timestamp('settled_at'),
  },
  (t) => [
    index('budget_key_idx').on(t.keyId, t.createdAt),
    index('budget_team_idx').on(t.teamId, t.createdAt),
    index('budget_request_idx').on(t.requestId),
    index('budget_state_idx').on(t.state),
  ],
);

export const requestLogs = sqliteTable(
  'request_logs',
  {
    id: text('id').primaryKey(),
    createdAt: createdAt(),
    keyId: text('key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    teamId: text('team_id').references(() => teams.id, { onDelete: 'set null' }),
    format: text('format', { enum: CLIENT_FORMATS }).notNull(),
    requestedModel: text('requested_model').notNull(),
    requestedModelId: text('requested_model_id'),
    attemptedModelId: text('attempted_model_id'),
    servedModelId: text('served_model_id'),
    servedModel: text('served_model'),
    servedLocal: integer('served_local', { mode: 'boolean' }).notNull().default(false),
    providerName: text('provider_name'),
    status: integer('status').notNull(),
    result: text('result', { enum: RESULTS }).notNull(),
    ruleId: text('rule_id'),
    trace: text('trace', { mode: 'json' }).$type<TraceStep[]>().notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costUsd: real('cost_usd').notNull().default(0),
    costKnown: integer('cost_known', { mode: 'boolean' }),
    savedUsd: real('saved_usd').notNull().default(0),
    routingProfileId: text('routing_profile_id'),
    routingProfileName: text('routing_profile_name'),
    routingOutcome: text('routing_outcome', { enum: ROUTING_OUTCOMES }),
    routingCostKnown: integer('routing_cost_known', { mode: 'boolean' }),
    baselineCostUsd: real('baseline_cost_usd'),
    routingSavingsUsd: real('routing_savings_usd'),
    latencyMs: integer('latency_ms').notNull().default(0),
    stream: integer('stream', { mode: 'boolean' }).notNull().default(false),
    pii: text('pii', { mode: 'json' }).$type<Record<string, number>>(),
    promptPreview: text('prompt_preview'),
    responsePreview: text('response_preview'),
    error: text('error'),
  },
  (t) => [
    index('request_logs_created_idx').on(t.createdAt),
    index('request_logs_key_idx').on(t.keyId, t.createdAt),
    index('request_logs_team_idx').on(t.teamId, t.createdAt),
    index('request_logs_routing_idx').on(t.routingProfileId, t.createdAt),
  ],
);

/**
 * Answers to repeated identical requests, per key. Kept unmasked so they can be returned as they
 * were, which is why caching is off by default and skips prompts with personal data.
 */
export const responseCache = sqliteTable(
  'response_cache',
  {
    /** sha256 of the key, model, client format and request */
    id: text('id').primaryKey(),
    keyId: text('key_id')
      .notNull()
      .references(() => apiKeys.id, { onDelete: 'cascade' }),
    modelId: text('model_id')
      .notNull()
      .references(() => models.id, { onDelete: 'cascade' }),
    /** The response exactly as the client got it */
    body: text('body').notNull(),
    /** What the first answer cost, which a cache hit saves */
    costUsd: real('cost_usd').notNull().default(0),
    hits: integer('hits').notNull().default(0),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at').notNull(),
  },
  (t) => [index('response_cache_expires_idx').on(t.expiresAt)],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
});

export type Team = typeof teams.$inferSelect;
export type User = typeof users.$inferSelect;
export type Provider = typeof providers.$inferSelect;
export type Model = typeof models.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type RequestLog = typeof requestLogs.$inferSelect;

/** Comparison reports contain masked outputs when text storage is enabled; never task prompts. */
export const comparisons = sqliteTable('comparisons', {
  id: id(),
  createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  expiresAt: timestamp('expires_at').notNull(),
  report: text('report', { mode: 'json' }).$type<ComparisonReport>().notNull(),
  summary: text('summary', { mode: 'json' }).$type<ComparisonSummary>().notNull(),
});

/** Explicitly saved synthetic templates; reports only retain a content fingerprint and results. */
export const taskSets = sqliteTable('task_sets', {
  id: id(),
  revision: integer('revision').notNull().default(1),
  content: text('content', { mode: 'json' }).$type<TaskSetInput>().notNull(),
  fingerprint: text('fingerprint').notNull(),
  reference: text('reference', { mode: 'json' }).$type<ReferenceRun | null>(),
  createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at')
    .notNull()
    .$defaultFn(() => new Date()),
  expiresAt: timestamp('expires_at').notNull(),
});

/** One explicit text-routing choice per key, backed by a completed comparison. */
export const routingProfiles = sqliteTable('routing_profiles', {
  id: id(),
  name: text('name').notNull(),
  keyId: text('key_id')
    .notNull()
    .unique()
    .references(() => apiKeys.id, { onDelete: 'cascade' }),
  comparisonId: text('comparison_id').notNull(),
  baselineModelId: text('baseline_model_id')
    .notNull()
    .references(() => models.id, { onDelete: 'cascade' }),
  candidateModelId: text('candidate_model_id')
    .notNull()
    .references(() => models.id, { onDelete: 'cascade' }),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  fallbackOnError: integer('fallback_on_error', { mode: 'boolean' }).notNull().default(true),
  evidence: text('evidence', { mode: 'json' }).$type<RoutingEvidence>().notNull(),
  createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at')
    .notNull()
    .$defaultFn(() => new Date()),
});

export type RoutingProfile = typeof routingProfiles.$inferSelect;
