# Spillway

A self-hosted AI gateway for companies without a DevOps team. Give every person, device and agent its
own key, set daily and monthly limits, send over-budget traffic to a local model instead of blocking
it, and keep a log of every request with personal data masked. Single sign-on is included and free.

```
 Claude Code ─┐                       ┌─ Anthropic
 Open WebUI  ─┼─▶  Spillway  ─────────┼─ OpenAI-compatible APIs
 n8n, SDKs   ─┘   keys · budgets      └─ Ollama on your own GPU
                  rules · masked log
```

## What it does

- **Three API formats in, any provider out.** Clients speak OpenAI (`/v1/chat/completions`),
  Anthropic (`/v1/messages`) or Ollama (`/api/chat`, `/api/generate`). Spillway translates between
  them, including streaming and tool calls, so Claude Code can run on a local Qwen when the budget
  runs out.
- **A key per person, device or agent** with daily and monthly dollar limits, and model allowlists
  per team and per key.
- **The cloud goes down, work does not.** When a provider fails, times out or rate limits, the
  local model answers instead, and the provider shows up under Needs attention.
- **Team budgets and four routing rules**: switch to the local model at N% of the team budget, keep
  card numbers, IBANs, US Social Security and UK National Insurance numbers, passport numbers and
  API keys away from cloud models, rate limit agents, and keep off-hours traffic local. Numbers that
  need context, like passports, only count next to the word itself, so timestamps and IDs in code
  never block a request.
- **Every decision explained.** Each log entry shows the steps the gateway took ("Marketing is at
  104% of its budget → sent to Qwen Coder · local"), tokens, cost, and money saved.
- **Privacy by default.** Prompts are stored masked, text is dropped after a retention period (the
  numbers stay), storage can be switched off, and provider keys are encrypted at rest.
- **SSO without an enterprise plan**: Google Workspace, Microsoft Entra ID or any OpenID Connect
  provider.
- **In six languages**: English, Russian, German, French, Spanish and Chinese, picked from the
  browser and switchable on the sign-in and Account pages.

## Quick start

```sh
mkdir spillway && cd spillway
curl -fsSLO https://raw.githubusercontent.com/Artemy-And/spillway/main/docker-compose.yml
docker compose up -d
open http://localhost:8080
```

This pulls the signed image `ghcr.io/artemy-and/spillway` for amd64 or arm64; nothing is built
on your machine. `latest` follows releases. To pin one, put `SPILLWAY_TAG=0.1.0` in `.env` next
to the compose file (`.env.example` lists every setting). Put Spillway behind your usual reverse
proxy for HTTPS and set `PUBLIC_URL` to the address people open.

The first visitor creates the admin account in the browser (with SSO configured, the first person
to sign in from an allowed domain becomes the admin instead). A short tour and a getting-started
checklist on the Overview page then walk through connecting a provider, adding models, picking a
local model, creating a key and sending the first request. For unattended installs, set
`ADMIN_EMAIL` and `ADMIN_PASSWORD` instead; they are used only when nobody exists yet.

Colleagues join through **Settings → People**: add their email and send them the one-time link
Spillway shows (valid for 7 days). The same link button resets a forgotten password. Spillway
does not send email, so any messenger will do. With SSO configured they can also just sign in.

Locked out of the only admin account? `docker compose exec spillway node apps/server/src/reset-password.ts you@company.com`
prints a new password.

Ollama already installed on the same computer is reachable from the container at
`http://host.docker.internal:11434`, which is the default for new Ollama providers. To run it in
Docker next to Spillway instead:

```sh
echo "OLLAMA_URL=http://ollama:11434" >> .env
docker compose --profile ollama up -d
docker compose exec ollama ollama pull qwen2.5-coder:7b
```

Then, in the UI: add providers and models (with prices per million tokens), pick the local model for
rerouting in **Settings**, create teams in **Budgets & rules**, and hand out keys in **Keys**.

### Verify the image

Release images are built and signed by this repository's GitHub Actions workflow through Sigstore,
with no long-lived signing key, and carry an SBOM and build provenance. To check one before you run
it:

```sh
cosign verify ghcr.io/artemy-and/spillway:0.1.0 \
  --certificate-identity https://github.com/Artemy-And/spillway/.github/workflows/release.yml@refs/tags/v0.1.0 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

### Build it yourself

```sh
git clone https://github.com/Artemy-And/spillway && cd spillway
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

## Connecting clients

| Client | Setting |
| --- | --- |
| OpenAI SDKs, n8n, curl | base URL `https://<gateway>/v1`, API key `sw-…` |
| Claude Code | `ANTHROPIC_BASE_URL=https://<gateway>`, `ANTHROPIC_AUTH_TOKEN=sw-…`, `ANTHROPIC_MODEL=<model name>` |
| Open WebUI | OpenAI connection `https://<gateway>/v1` or Ollama connection `https://<gateway>`, key `sw-…` |
| Chatbox | custom provider, OpenAI API Compatible, host `https://<gateway>/v1`, key `sw-…` |

The `model` a client sends is the **name** you gave the model in Spillway; it maps to any upstream
model on any provider.

## Development

Requires Node.js 24+ and pnpm (via `corepack enable`).

```sh
pnpm install
cp .env.example .env    # optional; without ADMIN_PASSWORD the UI asks for the first account
pnpm dev                # API on :8080, UI with hot reload on :5173
pnpm test               # gateway, failover, auth, translation and PII tests
pnpm reset-password you@company.com
pnpm typecheck && pnpm lint
```

| Path | What lives there |
| --- | --- |
| `apps/server` | Hono API and gateway. Node runs the TypeScript directly, no build step. SQLite through Node's built-in `node:sqlite` and Drizzle |
| `apps/server/src/gateway` | Auth by key, policy (`policy.ts`), format translation, streaming, usage metering |
| `apps/server/drizzle` | SQL migrations; change `src/db/schema.ts`, then `pnpm db:generate` |
| `apps/web` | React 19, TanStack Router and Query, Tailwind CSS 4. Calls the API through the typed Hono RPC client |
| `apps/web/src/i18n` | Translations. `en.ts` is the source; every other language must match its shape or the build fails |
| `.github/workflows` | `ci.yml` checks every branch and pull request; `release.yml` publishes signed images from `main` and version tags |

### Releasing

Set the version in `apps/server/package.json`, merge to `main`, then tag it:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

The release workflow runs the checks, publishes `0.1.0`, `0.1` and `latest` for amd64 and arm64,
signs them and opens a GitHub release with the compose file attached. It refuses a tag that does
not match the version in `package.json`. Every push to `main` also publishes an `edge` image.

## Not in this version

Response caching, MCP gateway, a hosted cloud version, clustering, and providers beyond the three
wire formats (most models are reachable through one of them). Budgets count spend from the log, so
parallel requests can overshoot a limit by the cost of the requests already in flight.
