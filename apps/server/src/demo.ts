// Fills an empty gateway with demo teams, keys and two weeks of made-up traffic,
// for trying the admin UI or showing it off. Run: pnpm demo (refuses a gateway that has keys).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { openDb } from './db/client.ts';
import {
  apiKeys,
  type KeyKind,
  models,
  providers,
  type Result,
  requestLogs,
  settings,
  type TraceStep,
  teams,
  users,
} from './db/schema.ts';
import { loadEnv } from './env.ts';
import { newGatewayKey, shortId } from './lib/crypto.ts';
import { settingsSchema } from './settings.ts';

const env = loadEnv();
mkdirSync(env.DATA_DIR, { recursive: true });
const { db } = await openDb(join(env.DATA_DIR, 'spillway.db'));

const existing = await db.select({ count: sql<number>`count(*)` }).from(apiKeys).get();
if (existing?.count) {
  console.error('This gateway already has keys; the demo only fills an empty one.');
  process.exit(1);
}

let seed = 42;
const random = () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
};
const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!;

const [ollama] = await db
  .insert(providers)
  .values({
    name: 'Ollama · gpu-01',
    kind: 'ollama',
    baseUrl: env.OLLAMA_URL ?? 'http://ollama:11434',
    isLocal: true,
  })
  .returning();
const [anthropic] = await db
  .insert(providers)
  .values({ name: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com' })
  .returning();
const [openai] = await db
  .insert(providers)
  .values({ name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1' })
  .returning();

const catalog = await db
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
      name: 'gpt-mini',
      label: 'GPT mini',
      providerId: openai!.id,
      upstreamModel: 'gpt-5-mini',
      inputPrice: 0.25,
      outputPrice: 2,
    },
    {
      name: 'qwen-coder',
      label: 'Qwen Coder',
      providerId: ollama!.id,
      upstreamModel: 'qwen2.5-coder:14b',
    },
  ])
  .returning();
const [sonnet, mini, qwen] = catalog as [
  (typeof catalog)[number],
  (typeof catalog)[number],
  (typeof catalog)[number],
];

await db
  .insert(settings)
  .values({ key: 'app', value: settingsSchema.parse({ localModelId: qwen.id }) })
  .onConflictDoUpdate({
    target: settings.key,
    set: { value: settingsSchema.parse({ localModelId: qwen.id }) },
  });

const teamRows = await db
  .insert(teams)
  .values([
    { name: 'Engineering', monthlyBudgetUsd: 1200 },
    { name: 'Marketing', monthlyBudgetUsd: 1.5, allowedModelIds: [sonnet.id, mini.id, qwen.id] },
    { name: 'Support', monthlyBudgetUsd: 400, allowedModelIds: [mini.id, qwen.id] },
  ])
  .returning();
const team = (name: string) => teamRows.find((t) => t.name === name)!;

const people = await db
  .insert(users)
  .values([
    { email: 'anna@demo.spillway', name: 'Anna Kovacs', teamId: team('Engineering').id },
    { email: 'leo@demo.spillway', name: 'Leo Martin', teamId: team('Engineering').id },
    { email: 'mia@demo.spillway', name: 'Mia Chen', teamId: team('Marketing').id },
  ])
  .returning();
const person = (name: string) => people.find((p) => p.name?.startsWith(name))!;

const keySpecs: {
  name: string;
  kind: KeyKind;
  user?: string;
  team: string;
  daily?: number;
  weight: number;
  model: typeof sonnet;
}[] = [
  {
    name: 'anna-macbook',
    kind: 'device',
    user: 'Anna',
    team: 'Engineering',
    daily: 10,
    weight: 5,
    model: sonnet,
  },
  {
    name: 'anna-cli',
    kind: 'person',
    user: 'Anna',
    team: 'Engineering',
    daily: 5,
    weight: 2,
    model: sonnet,
  },
  {
    name: 'leo-desktop',
    kind: 'device',
    user: 'Leo',
    team: 'Engineering',
    daily: 10,
    weight: 4,
    model: sonnet,
  },
  { name: 'ci-runner', kind: 'agent', team: 'Engineering', weight: 3, model: qwen },
  { name: 'design-agent', kind: 'agent', team: 'Marketing', daily: 10, weight: 4, model: sonnet },
  {
    name: 'mia-browser',
    kind: 'person',
    user: 'Mia',
    team: 'Marketing',
    daily: 5,
    weight: 2,
    model: mini,
  },
  { name: 'support-bot', kind: 'agent', team: 'Support', daily: 15, weight: 6, model: mini },
];
const keys = [];
for (const spec of keySpecs) {
  const { prefix, hash } = newGatewayKey();
  const [row] = await db
    .insert(apiKeys)
    .values({
      name: spec.name,
      kind: spec.kind,
      userId: spec.user ? person(spec.user).id : null,
      teamId: team(spec.team).id,
      dailyLimitUsd: spec.daily ?? null,
      prefix,
      hash,
      lastUsedAt: new Date(Date.now() - random() * 3_600_000),
    })
    .returning();
  keys.push({ ...spec, row: row! });
}
const { prefix, hash } = newGatewayKey();
await db.insert(apiKeys).values({
  name: 'old-laptop',
  kind: 'device',
  userId: person('Leo').id,
  teamId: team('Engineering').id,
  prefix,
  hash,
  createdAt: new Date(Date.now() - 60 * 86_400_000),
  lastUsedAt: new Date(Date.now() - 34 * 86_400_000),
});

const prompts = [
  'Refactor the billing service to use the new invoice API',
  'Write three subject lines for the October newsletter. Reply-to: marketing@example.com',
  'Summarise this support ticket and suggest a reply',
  'Explain why this test is flaky and propose a fix',
  'Draft a product update post about SSO',
];
const label = (model: typeof sonnet) => `${model.label}${model.id === qwen.id ? ' · local' : ''}`;
const providerOf = (model: typeof sonnet) =>
  model.id === qwen.id ? ollama! : model.id === sonnet.id ? anthropic! : openai!;

const rows: (typeof requestLogs.$inferInsert)[] = [];
const now = Date.now();
for (let day = 13; day >= 0; day--) {
  const date = new Date(now - day * 86_400_000);
  const weekend = date.getDay() === 0 || date.getDay() === 6;
  const count = Math.round((weekend ? 18 : 55) * (0.8 + random() * 0.4));
  for (let i = 0; i < count; i++) {
    const total = keys.reduce((sum, k) => sum + k.weight, 0);
    let roll = random() * total;
    const key =
      keys.find((k) => {
        roll -= k.weight;
        return roll < 0;
      }) ?? keys[0]!;
    const createdAt = new Date(date.getTime() - random() * (day === 0 ? 8 : 24) * 3_600_000);
    const input = Math.round(800 + random() * 12_000);
    const output = Math.round(150 + random() * 2000);
    let result: Result = 'ok';
    let served = key.model;
    const trace: TraceStep[] = [{ tone: 'ok', text: `Key valid, model allowed for ${key.team}` }];
    let ruleId: string | null = null;
    const r = random();
    if (key.team === 'Marketing' && day < 4 && key.model.id !== qwen.id) {
      result = 'rerouted';
      served = qwen;
      ruleId = 'budgetThreshold';
      trace.push({ tone: 'warn', text: 'Marketing is at 104% of its $1.50 budget' });
      trace.push({ tone: 'info', text: 'Rule 1 matched → sent to Qwen Coder · local' });
    } else if (r < 0.012) {
      result = 'blocked_pii';
      ruleId = 'piiGuard';
      trace.push({
        tone: 'block',
        text: 'Rule 2: prompt contains card numbers ×1; cloud models are blocked for it',
      });
    } else if (r < 0.02 && key.kind === 'agent') {
      result = 'rate_limited';
      ruleId = 'agentRateLimit';
      trace.push({
        tone: 'block',
        text: 'Rule 3: agent keys may send at most 60 requests per minute',
      });
    } else if (r < 0.35 && key.model.id !== qwen.id) {
      served = qwen;
      trace.push({ tone: 'info', text: 'Local model: no API cost, budgets do not apply' });
    }
    const blocked = result === 'blocked_pii' || result === 'rate_limited';
    if (!blocked && result === 'ok') {
      trace.push({ tone: 'ok', text: 'No sensitive data found in prompt' });
      trace.push({ tone: 'info', text: `Sent to ${label(served)} (${providerOf(served).name})` });
    }
    const cost = blocked ? 0 : (input * served.inputPrice + output * served.outputPrice) / 1e6;
    const wouldCost = (input * key.model.inputPrice + output * key.model.outputPrice) / 1e6;
    rows.push({
      id: shortId('req'),
      createdAt,
      keyId: key.row.id,
      teamId: key.row.teamId,
      format: pick(['openai', 'anthropic', 'anthropic', 'ollama'] as const),
      requestedModel: (result === 'rerouted' ? key.model : served).name,
      requestedModelId: (result === 'rerouted' ? key.model : served).id,
      servedModelId: blocked ? null : served.id,
      servedModel: blocked ? null : label(served),
      servedLocal: !blocked && served.id === qwen.id,
      providerName: blocked ? null : providerOf(served).name,
      status: blocked ? (result === 'blocked_pii' ? 403 : 429) : 200,
      result,
      ruleId,
      trace,
      inputTokens: input,
      outputTokens: blocked ? 0 : output,
      costUsd: cost,
      savedUsd: result === 'rerouted' ? wouldCost : 0,
      latencyMs: blocked ? 3 : Math.round(600 + random() * 4000),
      stream: random() > 0.3,
      pii: result === 'blocked_pii' ? { card: 1 } : null,
      promptPreview:
        result === 'blocked_pii'
          ? 'Charge the order to [card hidden] and send the receipt to [email hidden]'
          : pick(prompts).replace('marketing@example.com', '[email hidden]'),
      responsePreview: blocked ? null : 'Here is a first draft…',
    });
  }
}
for (let i = 0; i < rows.length; i += 200)
  await db.insert(requestLogs).values(rows.slice(i, i + 200));

console.log(
  `Demo data ready: ${teamRows.length} teams, ${keys.length + 1} keys, ${rows.length} requests.`,
);
console.log('The demo keys are not shown anywhere; create a real key in the UI to send requests.');
