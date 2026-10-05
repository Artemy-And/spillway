import { z } from 'zod';

const list = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),
  DATA_DIR: z.string().default('./data'),
  PUBLIC_URL: z.url().default('http://localhost:8080'),
  /** Encrypts provider API keys and signs cookies. Generated into DATA_DIR on first run if unset. */
  SPILLWAY_SECRET: z.string().min(32).optional(),

  /** Creates the first admin without the setup page; ignored once anyone exists. */
  ADMIN_EMAIL: z.email().default('admin@spillway.local'),
  ADMIN_PASSWORD: z.string().min(8).optional(),

  /** How long a cloud provider may take to start answering before the request fails over. */
  UPSTREAM_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(3600).default(120),

  OIDC_ISSUER: z.url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_LABEL: z.string().default('Continue with SSO'),
  /** Email domains allowed to sign in through SSO. Empty means only pre-added people. */
  OIDC_ALLOWED_DOMAINS: list,
  /** People who become admins on their first SSO sign-in. */
  ADMIN_EMAILS: list,

  /** Mail server for notifications: smtp://user:pass@host:587 (STARTTLS) or smtps://…:465 */
  SMTP_URL: z.url().optional(),
  /** Sender address; defaults to the SMTP user */
  SMTP_FROM: z.string().optional(),

  /** Seed providers on first start. */
  OLLAMA_URL: z.url().optional(),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  // docker compose passes unset variables as empty strings
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ''));
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    console.error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
    process.exit(1);
  }
  return result.data;
}
