# Instructions for coding agents

Read this before changing anything in this repository. It applies to Codex, Claude Code and any
other agent. [CONTRIBUTING.md](CONTRIBUTING.md) and the README's
[Development](README.md#development) section still apply.

## What Spillway is

A self-hosted AI gateway for companies of 10–50 people without a DevOps team. Its job:

- one key per person, device or agent, with daily and monthly dollar limits;
- team budgets and the four routing rules: local model at N% of the budget, personal data kept
  away from cloud models, agent rate limits, off-hours traffic kept local;
- failover to the local model when a provider fails;
- three API formats in (OpenAI, Anthropic, Ollama), any provider out, so Claude Code, Codex,
  Open WebUI, n8n and Cursor work without changes on their side;
- a masked request log that explains every decision, alerts, single sign-on.

The README's [What it does](README.md#what-it-does) and [Not in this version](README.md#not-in-this-version)
sections are the scope. Routing rules are a fixed set, not a rule builder.

## Ask before you build

Stop and describe the idea in your reply, without writing it, if a change would:

- add a feature, page, navigation item, setting, environment variable or API endpoint;
- add a database migration or a dependency;
- change how requests are routed, priced, limited or refused;
- touch the README's first screen, `docs/`, the license files or the release workflow.

Bug fixes, tests and small improvements to existing behaviour do not need this. A feature that
only a client written against Spillway can use (custom headers, a special request shape) is out of
scope: the users run Claude Code, Codex and Open WebUI, not their own agents.

## Do not break what clients already rely on

- **Never edit an existing test to make your change pass.** A failing test means you changed
  behaviour. Stop and explain it instead. The `codexRequest` fixture in
  `apps/server/src/gateway/gateway.test.ts` is shaped after real Codex traffic; keep its tools,
  including `web_search`.
- Do not add, remove or change fields in a client's request beyond what translating between
  formats needs. No injected `max_tokens`.
- A request whose cost cannot be estimated in advance (images, PDFs, hosted tools) must still go
  through. Budgets may stop a request only on money actually spent.
- Test gateway changes with the request shapes real clients send: Codex (Responses API with many
  tools, `parallel_tool_calls`, `store: false`), Claude Code (Messages with images, thinking and
  server tools), Open WebUI and n8n (chat completions with extra fields).

## The request path is hot

`apps/server/src/gateway/handler.ts` and `policy.ts` run on every request, and `node:sqlite` is
synchronous: while a query runs, the whole gateway waits. Do not add queries over `request_logs`
per request. When you touch this path, measure it on a database with a month of logs (about
200,000 rows) and give the numbers in the commit message.

## Interface and text

- The admin UI is for an office manager or a team lead, not an engineer. Plain words, no protocol
  terms (no header names or API field names in the UI).
- Strings go into the existing per-language files in `apps/web/src/i18n/` (`en.ts` is the source)
  in all six languages. Do not create another translation structure.
- Do not create a `ROADMAP.md` or change the plan of the project. The roadmap is kept outside the
  repository by the maintainer.

## Commits

- Small commits, one change each, on `develop`. Never push to `main`, tag or publish a release.
- Plain English messages in the imperative, saying what changed for users and why.
- No AI attribution: no `Co-Authored-By` trailers, no "Generated with" lines.
- Before each commit: `pnpm lint`, `pnpm typecheck`, `pnpm test`.
