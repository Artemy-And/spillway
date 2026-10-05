// The public read-only demo (DEMO=true): a made-up 10-person company with two weeks of traffic.
// The traffic is generated again every hour so "today" and "minutes ago" stay true. Visitors see
// the admin UI without signing in; every change, and the gateway itself, is switched off.
import { eq, inArray, sql } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import type { AppContext } from './context.ts';
import {
  type ApiKey,
  apiKeys,
  type Model,
  models,
  type Provider,
  providers,
  type Result,
  requestLogs,
  type Team,
  type TraceStep,
  teams,
  users,
} from './db/schema.ts';
import { ruleNumber, step } from './gateway/policy.ts';
import { newGatewayKey, shortId } from './lib/crypto.ts';
import { describePii } from './lib/pii.ts';
import { type Calendar, calendar, usd } from './lib/time.ts';

export const DEMO_EMAIL = 'maya@acme.test';
export const READ_ONLY =
  'This is a read-only demo with made-up data. Install Spillway to try changes.';

const ZONE = 'America/New_York';
const MINUTE = 60_000;

/** Reads pass; changes, model listings (they call out) and gateway calls are refused. */
export const demoGuard = createMiddleware(async (c, next) => {
  const path = c.req.path;
  if (path === '/auth/logout') return c.json({ ok: true });
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
  const gateway = path.startsWith('/v1/') || path.startsWith('/api/');
  const outbound = /^\/admin\/api\/providers\/[^/]+\/available$/.test(path);
  if (gateway || outbound || (write && /^\/(admin|auth)\//.test(path))) {
    return c.json({ error: READ_ONLY }, 403);
  }
  await next();
});

// ── The company ──────────────────────────────────────────────────────────────

async function company(ctx: AppContext): Promise<void> {
  const { db } = ctx;
  if (await db.query.users.findFirst({ where: eq(users.email, DEMO_EMAIL) })) return;

  const now = new Date();
  const [engineering, marketing, support, sales] = await db
    .insert(teams)
    .values([
      { name: 'Engineering', monthlyBudgetUsd: 600 },
      { name: 'Marketing', monthlyBudgetUsd: 60 },
      { name: 'Support', monthlyBudgetUsd: 120 },
      { name: 'Sales', monthlyBudgetUsd: 80 },
    ])
    .returning();
  const people = await db
    .insert(users)
    .values([
      {
        email: DEMO_EMAIL,
        name: 'Maya Lindqvist',
        role: 'admin',
        lastLoginAt: now,
        welcomedAt: now,
        checklistHiddenAt: now,
      },
      { email: 'anna@acme.test', name: 'Anna Kowalski', teamId: engineering!.id, lastLoginAt: now },
      { email: 'ben@acme.test', name: 'Ben Carter', teamId: engineering!.id, lastLoginAt: now },
      { email: 'priya@acme.test', name: 'Priya Shah', teamId: marketing!.id, lastLoginAt: now },
      { email: 'tom@acme.test', name: 'Tom Becker', teamId: support!.id, lastLoginAt: now },
      { email: 'lena@acme.test', name: 'Lena Fischer', teamId: sales!.id, lastLoginAt: now },
    ])
    .returning();
  const person = (email: string) => people.find((user) => user.email === email)!.id;

  const [anthropic, openai, gpu] = await db
    .insert(providers)
    .values([
      {
        name: 'Anthropic',
        kind: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKeyEnc: ctx.vault.encrypt('sk-ant-demo'),
      },
      {
        name: 'OpenAI',
        kind: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKeyEnc: ctx.vault.encrypt('sk-demo'),
      },
      {
        name: 'Office GPU (Ollama)',
        kind: 'ollama',
        baseUrl: 'http://gpu.acme.internal:11434',
        isLocal: true,
      },
    ])
    .returning();
  const added = await db
    .insert(models)
    .values([
      {
        name: 'claude-sonnet',
        label: 'Claude Sonnet',
        providerId: anthropic!.id,
        upstreamModel: 'claude-sonnet-4-5',
        inputPrice: 3,
        outputPrice: 15,
      },
      {
        name: 'claude-haiku',
        label: 'Claude Haiku',
        providerId: anthropic!.id,
        upstreamModel: 'claude-haiku-4-5',
        inputPrice: 1,
        outputPrice: 5,
      },
      {
        name: 'gpt-mini',
        label: 'GPT-5 mini',
        providerId: openai!.id,
        upstreamModel: 'gpt-5-mini',
        inputPrice: 0.25,
        outputPrice: 2,
        cacheReadPrice: 0.025,
      },
      {
        name: 'qwen-coder',
        label: 'Qwen Coder',
        providerId: gpu!.id,
        upstreamModel: 'qwen2.5-coder:14b',
      },
      {
        name: 'nomic-embed-text',
        label: 'Nomic Embed',
        providerId: gpu!.id,
        upstreamModel: 'nomic-embed-text:v1.5',
      },
    ])
    .returning();

  const key = (values: Omit<typeof apiKeys.$inferInsert, 'prefix' | 'hash'>) => {
    const { prefix, hash } = newGatewayKey();
    return { ...values, prefix, hash };
  };
  await db.insert(apiKeys).values([
    key({
      name: 'anna-macbook',
      kind: 'person',
      teamId: engineering!.id,
      userId: person('anna@acme.test'),
      dailyLimitUsd: 25,
    }),
    key({
      name: 'ben-laptop',
      kind: 'person',
      teamId: engineering!.id,
      userId: person('ben@acme.test'),
      dailyLimitUsd: 25,
    }),
    key({ name: 'pr-review-bot', kind: 'agent', teamId: engineering!.id, monthlyLimitUsd: 40 }),
    key({ name: 'marketing-bot', kind: 'agent', teamId: marketing!.id }),
    key({
      name: 'priya-chatbox',
      kind: 'person',
      teamId: marketing!.id,
      userId: person('priya@acme.test'),
      dailyLimitUsd: 5,
    }),
    key({
      name: 'support-openwebui',
      kind: 'device',
      teamId: support!.id,
      userId: person('tom@acme.test'),
    }),
    key({
      name: 'lena-laptop',
      kind: 'person',
      teamId: sales!.id,
      userId: person('lena@acme.test'),
      dailyLimitUsd: 5,
    }),
  ]);

  await ctx.settings.update({
    timeZone: ZONE,
    localModelId: added.find((model) => model.name === 'qwen-coder')!.id,
    rerouteOnFailure: true,
    cache: { enabled: true, ttlHours: 24 },
    rules: {
      budgetThreshold: { enabled: true, percent: 90 },
      piiGuard: { enabled: true },
      agentRateLimit: { enabled: true, rpm: 120 },
      offHours: { enabled: false, from: '08:00', to: '20:00' },
    },
  });
}

// ── Traffic ──────────────────────────────────────────────────────────────────

type Format = 'openai' | 'anthropic' | 'ollama';
type Kind = 'chat' | 'embeddings' | 'blockedPii';

interface Scenario {
  key: string;
  model: string;
  format: Format;
  stream: boolean;
  perDay: [number, number];
  input: [number, number];
  output: [number, number];
  /** [prompt, answer] as the log shows them, personal data already masked */
  texts: [string, string][];
  pii?: Record<string, number>;
  kind?: Kind;
  /** Share of requests answered from the response cache */
  cached?: number;
}

const CODE: [string, string][] = [
  [
    'Refactor parseInvoice() in billing/parser.ts so the currency handling lives in its own function.',
    'I moved the currency logic into a new parseCurrency() helper and updated both call sites. The tests in parser.test.ts still pass; I added one for invoices without a currency code.',
  ],
  [
    'Why does the CI job fail on the migration test? The log says "relation orders_archive does not exist".',
    'Migration 0007 renames orders_archive, but the test database is created from the schema before 0006 ran. Running migrations in order in the test setup fixes it.',
  ],
  [
    'Add cursor pagination to GET /orders and a test for the last page.',
    'The handler now takes cursor and limit, returns next_cursor, and the new test walks three pages until next_cursor is null.',
  ],
];

const SCENARIOS: Scenario[] = [
  {
    key: 'anna-macbook',
    model: 'claude-sonnet',
    format: 'anthropic',
    stream: true,
    perDay: [40, 70],
    input: [15_000, 60_000],
    output: [300, 1500],
    texts: CODE,
  },
  {
    key: 'ben-laptop',
    model: 'claude-sonnet',
    format: 'anthropic',
    stream: true,
    perDay: [25, 50],
    input: [12_000, 50_000],
    output: [300, 1400],
    texts: CODE,
  },
  {
    key: 'pr-review-bot',
    model: 'claude-haiku',
    format: 'anthropic',
    stream: false,
    perDay: [10, 22],
    input: [8000, 30_000],
    output: [300, 800],
    cached: 0.15,
    texts: [
      [
        'Review this pull request diff and list risky changes.',
        '1. The retry loop in sync.ts has no upper bound. 2. The new index on orders(created_at) locks the table during the migration. 3. Tests do not cover an empty cart.',
      ],
    ],
  },
  {
    key: 'priya-chatbox',
    model: 'gpt-mini',
    format: 'openai',
    stream: true,
    perDay: [8, 18],
    input: [800, 4000],
    output: [300, 900],
    texts: [
      [
        "Summarize this quarter's campaign results in five bullet points.",
        '• Webinar sign-ups up 38% • Cost per lead down to $41 • LinkedIn beat Google Ads for the first time • Two case studies published • Newsletter list passed 12,000',
      ],
      [
        'Rewrite this headline three ways, under 60 characters each: "AI spend under control".',
        '1. Know where every AI dollar goes 2. AI budgets that hold 3. One gateway, every model, no surprise bills',
      ],
    ],
  },
  {
    key: 'support-openwebui',
    model: 'qwen-coder',
    format: 'ollama',
    stream: true,
    perDay: [28, 50],
    input: [600, 3000],
    output: [200, 700],
    texts: [
      [
        'Reply to a customer who asks where their order is.',
        'Hi Sam, thanks for reaching out! Your order #48213 left our warehouse on Tuesday and should arrive by Friday. Here is the tracking link…',
      ],
    ],
  },
  {
    key: 'support-openwebui',
    model: 'qwen-coder',
    format: 'ollama',
    stream: true,
    perDay: [2, 6],
    input: [600, 2500],
    output: [200, 600],
    pii: { card: 1 },
    texts: [
      [
        'Customer wrote: my card [card hidden] was charged twice, please refund one payment.',
        'I am sorry about the double charge. I have flagged the duplicate payment for a refund; it will be back on your card within 5 business days.',
      ],
    ],
  },
  {
    key: 'support-openwebui',
    model: 'gpt-mini',
    format: 'openai',
    stream: false,
    perDay: [0, 2],
    input: [0, 0],
    output: [0, 0],
    kind: 'blockedPii',
    pii: { card: 1 },
    texts: [
      ['Customer wrote: my card [card hidden] was charged twice, please refund one payment.', ''],
    ],
  },
  {
    key: 'support-openwebui',
    model: 'gpt-mini',
    format: 'openai',
    stream: false,
    perDay: [6, 14],
    input: [800, 3000],
    output: [200, 700],
    texts: [
      [
        'Translate this reply to German, keep it friendly.',
        'Hallo Frau Weber, vielen Dank für Ihre Nachricht! Ihre Bestellung ist unterwegs und kommt voraussichtlich am Freitag an.',
      ],
    ],
  },
  {
    key: 'support-openwebui',
    model: 'nomic-embed-text',
    format: 'ollama',
    stream: false,
    perDay: [10, 25],
    input: [200, 2000],
    output: [0, 0],
    kind: 'embeddings',
    texts: [
      [
        'Returns: unopened items can be returned within 30 days for a full refund. Opened items…',
        '',
      ],
    ],
  },
  {
    key: 'lena-laptop',
    model: 'gpt-mini',
    format: 'openai',
    stream: true,
    perDay: [5, 14],
    input: [800, 3500],
    output: [300, 900],
    texts: [
      [
        'Summarize this quarter in five bullet points for the sales call.',
        '• 14 new customers • Churn down to 2.1% • Average deal up 18% • Northwind in final review • Two renewals moved to Q1',
      ],
    ],
  },
  {
    key: 'lena-laptop',
    model: 'claude-sonnet',
    format: 'openai',
    stream: true,
    perDay: [2, 6],
    input: [3000, 8000],
    output: [800, 2000],
    texts: [
      [
        'Draft a proposal email for the Northwind deal from these call notes.',
        'Subject: Proposal for Northwind. Hi Daniel, thank you for the time on Tuesday. Based on what you shared about the three warehouses…',
      ],
    ],
  },
];

/** The content agent in n8n: steady last month, looping into the Marketing budget this one. */
const MARKETING: Omit<Scenario, 'perDay'> = {
  key: 'marketing-bot',
  model: 'claude-sonnet',
  format: 'openai',
  stream: false,
  input: [4000, 9000],
  output: [1500, 4000],
  texts: [
    [
      'Write a 600-word blog post about cutting AI costs for small teams.',
      "Most small teams don't overspend on AI because of one big bill. They overspend because of a hundred small ones nobody sees…",
    ],
  ],
};

/** The same agent stuck in a loop: every turn resends a longer context. */
const LOOPING: Omit<Scenario, 'perDay'> = {
  ...MARKETING,
  input: [20_000, 60_000],
  output: [1500, 4000],
};
/** Roughly what one looping request costs on Claude Sonnet, to pace the loop. */
const LOOP_COST = 0.16;

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const int = ([min, max]: [number, number]) => Math.round(rand(min, max));
const pick = <T>(list: T[]) => list[Math.floor(Math.random() * list.length)]!;

interface Event {
  at: number;
  scenario: Omit<Scenario, 'perDay'>;
  /** A provider outage: the local model answers instead */
  outage?: boolean;
}

interface World {
  cal: Calendar;
  keys: Map<string, ApiKey>;
  teams: Map<string, Team>;
  models: Map<string, { model: Model; provider: Provider }>;
  local: { model: Model; provider: Provider };
  threshold: number;
}

const label = (target: { model: Model; provider: Provider }) =>
  `${target.model.label ?? target.model.name}${target.provider.isLocal ? ' · local' : ''}`;
const plain = (target: { model: Model }) => target.model.label ?? target.model.name;

function sentTo(target: { model: Model; provider: Provider }): TraceStep {
  return step('info', `Sent to ${label(target)} (${target.provider.name})`, 'sentTo', {
    model: plain(target),
    provider: target.provider.name,
    local: target.provider.isLocal,
  });
}

export async function seedDemo(ctx: AppContext, now = new Date()): Promise<number> {
  await company(ctx);
  const { db } = ctx;
  const settings = await ctx.settings.get();
  const cal = calendar(settings.timeZone ?? ZONE);
  const all = await db
    .select({ model: models, provider: providers })
    .from(models)
    .innerJoin(providers, eq(models.providerId, providers.id))
    .all();
  const world: World = {
    cal,
    keys: new Map((await db.select().from(apiKeys).all()).map((key) => [key.name, key])),
    teams: new Map((await db.select().from(teams).all()).map((team) => [team.id, team])),
    models: new Map(all.map((row) => [row.model.name, row])),
    local: all.find((row) => row.model.name === 'qwen-coder')!,
    threshold: settings.rules.budgetThreshold.percent,
  };

  // Working days get the full plan, weekends about a sixth; work happens 8:00–19:00.
  const end = now.getTime() - 2 * MINUTE;
  const monthStart = cal.startOfMonth(now).getTime();
  const events: Event[] = [];
  for (let back = 13; back >= 0; back--) {
    const day = cal.daysAgo(back, now);
    const w = cal.wall(day);
    const weekday = new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
    const share = weekday === 0 || weekday === 6 ? 0.17 : 1;
    const at = () => day.getTime() + rand(8 * 60, 19 * 60) * MINUTE;
    const plan = [
      ...SCENARIOS,
      {
        ...MARKETING,
        perDay: (day.getTime() < monthStart ? [6, 14] : [2, 5]) as [number, number],
      },
    ];
    for (const scenario of plan) {
      for (let i = Math.round(int(scenario.perDay) * share); i > 0; i--) {
        const time = at();
        if (time < end) events.push({ at: time, scenario });
      }
    }
  }

  // Three days ago OpenAI went down for twenty minutes; the office GPU answered meanwhile.
  const outageStart = cal.daysAgo(3, now).getTime() + (14 * 60 + 5) * MINUTE;
  for (const event of events) {
    if (event.scenario.model === 'gpt-mini' && event.scenario.kind !== 'blockedPii') {
      event.outage = event.at >= outageStart && event.at < outageStart + 20 * MINUTE;
    }
  }
  const supportCloud = SCENARIOS.find(
    (s) => s.key === 'support-openwebui' && s.model === 'gpt-mini' && !s.kind,
  )!;
  for (let i = 0; i < 6; i++) {
    events.push({ at: outageStart + rand(0, 20) * MINUTE, scenario: supportCloud, outage: true });
  }

  // Since yesterday the content agent has been looping with an ever longer context. About two
  // and a half hours ago a last round of parallel requests took Marketing past its budget, and
  // since then rule 1 has sent the agent to the local model every few minutes.
  const cross = Math.max(monthStart + 45 * MINUTE, now.getTime() - 150 * MINUTE);
  const loop =
    cross <= now.getTime() - 10 * MINUTE
      ? { start: Math.max(monthStart + 30 * MINUTE, cross - 20 * 60 * MINUTE), cross }
      : null;
  if (loop) {
    for (const event of events) {
      if (event.scenario.key === 'marketing-bot' && event.at >= loop.start) event.at = -1;
    }
    for (let at = cross + rand(1, 3) * MINUTE; at < end; at += rand(2, 4.5) * MINUTE) {
      events.push({ at, scenario: MARKETING });
    }
  }

  const rows = simulate(
    world,
    events.filter((event) => event.at > 0).sort((a, b) => a.at - b.at),
    loop,
  );

  // New history goes in before the old one goes out, so a visitor never sees an empty gateway.
  const old = (await db.select({ id: requestLogs.id }).from(requestLogs).all()).map((r) => r.id);
  for (let i = 0; i < rows.length; i += 400) {
    await db.insert(requestLogs).values(rows.slice(i, i + 400));
  }
  for (let i = 0; i < old.length; i += 1000) {
    await db.delete(requestLogs).where(inArray(requestLogs.id, old.slice(i, i + 1000)));
  }
  await db.run(sql`update api_keys set last_used_at = (
    select max(created_at) from request_logs where request_logs.key_id = api_keys.id)`);
  return rows.length;
}

/** Walks the events in time order and decides each the way the gateway would have. */
function simulate(world: World, events: Event[], loop: { start: number; cross: number } | null) {
  const { cal } = world;
  const keyDay = new Map<string, number>();
  const teamMonth = new Map<string, number>();
  const rows: (typeof requestLogs.$inferInsert)[] = [];
  let looped = false;

  const add = (map: Map<string, number>, id: string, value: number) =>
    map.set(id, (map.get(id) ?? 0) + value);

  const record = (event: Event, frozenPercent: number | null) => {
    const { scenario } = event;
    const key = world.keys.get(scenario.key)!;
    const team = key.teamId ? world.teams.get(key.teamId)! : null;
    const requested = world.models.get(scenario.model)!;
    const at = new Date(event.at);
    const day = `${key.id}:${cal.dayKey(at)}`;
    const month = cal.dayKey(at).slice(0, 7);
    const teamKey = team ? `${team.id}:${month}` : '';
    const [prompt, answer] = pick(scenario.texts);
    let input = int(scenario.input);
    let output = int(scenario.output);
    const price = (m: Model) =>
      ((input * (m.inputPrice ?? 0) + output * (m.outputPrice ?? 0)) / 1e6) as number;

    const trace: TraceStep[] = [];
    if (scenario.kind === 'embeddings') {
      trace.push(step('info', 'Embeddings for 1 text(s)', 'embeddings', { count: 1 }));
    }
    trace.push(
      step('ok', `Key valid, model allowed${team ? ` for ${team.name}` : ''}`, 'keyValid', {
        team: team?.name ?? null,
      }),
    );

    let target = requested;
    let result: Result = 'ok';
    let status = 200;
    let ruleId: string | null = null;
    let saved = 0;

    if (requested.provider.isLocal) {
      trace.push(step('info', 'Local model: no API cost, budgets do not apply', 'localNoBudget'));
    } else {
      const spentToday = keyDay.get(day) ?? 0;
      const percent =
        frozenPercent ??
        (team?.monthlyBudgetUsd
          ? Math.round(((teamMonth.get(teamKey) ?? 0) / team.monthlyBudgetUsd) * 100)
          : 0);
      if (team?.monthlyBudgetUsd && percent >= world.threshold) {
        const rule = ruleNumber('budgetThreshold');
        trace.push(
          step(
            'warn',
            `${team.name} is at ${percent}% of its ${usd(team.monthlyBudgetUsd)} budget`,
            'teamBudget',
            { team: team.name, percent, budget: team.monthlyBudgetUsd },
          ),
          step('info', `Rule ${rule} matched → sent to ${label(world.local)}`, 'sentToLocal', {
            rule,
            model: plain(world.local),
          }),
        );
        target = world.local;
        result = 'rerouted';
        ruleId = 'budgetThreshold';
        saved = price(requested.model);
      } else {
        const parts = [
          key.dailyLimitUsd != null
            ? `key ${usd(spentToday)} of ${usd(key.dailyLimitUsd)} today`
            : null,
          team?.monthlyBudgetUsd
            ? `${team.name} at ${percent}% of ${usd(team.monthlyBudgetUsd)}`
            : null,
        ].filter(Boolean);
        trace.push(
          parts.length
            ? step('ok', `Within budget: ${parts.join(' · ')}`, 'withinBudget', {
                keySpent: key.dailyLimitUsd != null ? spentToday : null,
                keyLimit: key.dailyLimitUsd,
                team: team?.monthlyBudgetUsd ? team.name : null,
                teamPercent: team?.monthlyBudgetUsd ? percent : null,
                teamBudget: team?.monthlyBudgetUsd || null,
              })
            : step('ok', 'No budget set', 'noBudget'),
        );
      }
    }

    const local = target.provider.isLocal;
    if (scenario.pii && scenario.kind === 'blockedPii') {
      const rule = ruleNumber('piiGuard');
      trace.push(
        step(
          'block',
          `Rule ${rule}: prompt contains ${describePii(scenario.pii)}; cloud models are blocked for it`,
          'piiBlocked',
          { rule, pii: scenario.pii },
        ),
      );
      result = 'blocked_pii';
      status = 403;
      ruleId = 'piiGuard';
      input = 0;
      output = 0;
    } else if (scenario.pii) {
      trace.push(
        step(
          'info',
          `Found ${describePii(scenario.pii)}; masked in the log${local ? ', model is local' : ''}`,
          'piiMasked',
          { pii: scenario.pii, local },
        ),
      );
    } else {
      trace.push(step('ok', 'No sensitive data found in prompt', 'noPii'));
    }

    if (status === 200 && result === 'ok') trace.push(sentTo(target));
    let cost = status === 200 ? price(target.model) : 0;

    if (event.outage && status === 200 && !local) {
      const message = `${target.provider.name} returned 503: The server is temporarily overloaded`;
      trace.push(
        step('warn', message, 'providerFailed', { provider: target.provider.name, message }),
        step(
          'info',
          `${target.provider.name} is unavailable → sent to ${label(world.local)}`,
          'failover',
          { provider: target.provider.name, model: plain(world.local) },
        ),
      );
      target = world.local;
      result = 'rerouted';
      ruleId = 'outage';
      cost = 0;
    } else if (scenario.cached && result === 'ok' && Math.random() < scenario.cached) {
      trace.pop();
      trace.push(
        step('info', `Answered from the cache: ${usd(cost)} not spent`, 'cacheHit', {
          saved: cost,
        }),
      );
      ruleId = 'cache';
      saved = cost;
      cost = 0;
      input = 0;
      output = 0;
    }

    add(keyDay, day, cost);
    if (team) add(teamMonth, teamKey, cost);

    const blocked = status !== 200;
    rows.push({
      id: shortId('req'),
      createdAt: at,
      keyId: key.id,
      teamId: key.teamId,
      format: scenario.format,
      requestedModel: requested.model.name,
      requestedModelId: requested.model.id,
      servedModelId: blocked ? null : target.model.id,
      servedModel: blocked ? null : label(target),
      servedLocal: !blocked && target.provider.isLocal,
      providerName: blocked ? null : target.provider.name,
      status,
      result,
      ruleId,
      trace,
      inputTokens: input,
      outputTokens: output,
      costUsd: cost,
      savedUsd: saved,
      latencyMs: blocked
        ? int([3, 25])
        : ruleId === 'cache'
          ? int([2, 9])
          : scenario.kind === 'embeddings'
            ? int([40, 300])
            : target.provider.isLocal
              ? int([900, 4200])
              : int([1400, 9800]),
      stream: scenario.stream,
      pii: scenario.pii ?? null,
      promptPreview: prompt,
      responsePreview: blocked || !answer ? null : answer,
    });
    return cost;
  };

  /**
   * The loop runs within budget up to about 85%; then requests go out in parallel, each decided
   * at the same percentage before the others were logged, until the team stands at 104%.
   */
  const runLoop = (start: number, cross: number) => {
    const marketing = world.keys.get('marketing-bot')!;
    const team = world.teams.get(marketing.teamId!)!;
    const budget = team.monthlyBudgetUsd!;
    const teamKey = `${team.id}:${cal.dayKey(new Date(cross)).slice(0, 7)}`;
    const spent = () => teamMonth.get(teamKey) ?? 0;
    const parallel = cross - 10 * MINUTE;
    const gap = (parallel - start) / Math.max(1, (budget * 0.85 - spent()) / LOOP_COST);
    for (let at = start, n = 0; spent() < budget * 0.85 && n < 5000; n++) {
      record({ at, scenario: LOOPING }, null);
      at = Math.min(at + gap * rand(0.5, 1.5), parallel);
    }
    const frozen = Math.round((spent() / budget) * 100);
    for (let n = 0; frozen < world.threshold && spent() < budget * 1.04 && n < 2000; n++) {
      record({ at: parallel + rand(0, 10) * MINUTE, scenario: LOOPING }, frozen);
    }
  };

  for (const event of events) {
    if (loop && !looped && event.at >= loop.start) {
      looped = true;
      runLoop(loop.start, loop.cross);
    }
    record(event, null);
  }
  return rows.sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime());
}
