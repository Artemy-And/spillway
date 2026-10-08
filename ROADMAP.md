# Spillway roadmap

Last updated: **2026-10-08** (Europe/Moscow).

The next product milestone is to help a small team choose a cheaper model on its own tasks,
apply that choice to real requests, and understand the resulting costs. Passing a comparison
establishes success on the tested tasks; it does not guarantee general model quality.

## Stage 1 — Compare models on your tasks

**Completed: 2026-10-08.**

- [x] Compare 2–4 models on 1–20 identical text tasks.
- [x] Check exact answers, text inclusion and JSON; manually review free-text answers.
- [x] Report recorded costs, tokens, latency, failures and common passing tasks against a baseline.
- [x] Estimate costs, apply a comparison budget, cancel runs and flag unknown charges.
- [x] Honor gateway key limits, model allowlists and privacy rules; distinguish substituted models.
- [x] Retain masked reports according to text-storage settings and retention; import/export tasks
  and export reports.
- [x] Add the admin page and messages in all six supported languages.
- [x] Validate the implementation: 140 server tests passed, both type checks, lint and web build passed.

Implementation details and limitations: [model comparison](docs/model-comparison.md).

## Stage 2 — Apply a tested choice to real traffic

**Completed: 2026-10-08. Started: 2026-10-08.**

- [x] Create a routing profile from a completed comparison with passing baseline and cheaper candidate tasks.
- [x] Apply a profile to an explicitly selected gateway key; map baseline text requests to the candidate.
- [x] Keep key/team permissions, budgets and privacy checks in effect for the served model.
- [x] Keep images, tools, embeddings and unsupported stateful requests on their original model.
- [x] Offer an explicit fallback to the baseline when the selected provider fails.
- [x] Enable, disable and remove profiles in the admin UI, with an explanation in request logs.
- [x] Show recorded API spend and an explicitly labelled estimate of avoided baseline costs.
- [x] Pin model and provider configuration to the comparison; require a new run after relevant changes.
- [x] Retain profile evidence after source report expiry, without storing task texts in the profile.
- [x] Add 21 tests for routing, key isolation, policy enforcement, fallback, streaming, cache,
  configuration changes, concurrent activation and accounting. All 161 server tests passed;
  both type checks, lint and web build passed.

Implementation details and limits: [routing profiles](docs/routing-profiles.md).
The comparison-to-profile workflow is implemented; validation with real teams remains planned.

## Stage 3 — Account for concurrent calls and uncertain charges

**Completed: 2026-10-08. Started: 2026-10-08.**

- [x] Reserve estimated cloud costs atomically in SQLite against key daily/monthly limits and the team budget.
- [x] Set an explicit output cap for limited cloud requests when the client omitted one.
- [x] Settle final usage and retain uncertain amounts after failed calls, missing usage and interrupted streams.
- [x] Account for embeddings and separate cloud fallback attempts; avoid double-counting legacy logs.
- [x] Recover interrupted reservations on startup without assuming provider attempts were free.
- [x] Show recorded spend, active/uncertain reserves and available allowances in the UI.
- [x] Let admins reconcile verified provider charges; restrict member visibility to owned keys.
- [x] Add 17 tests including a 40-request burst, shared team budgets, independent SQLite connections,
  recovery after reopening the database, streaming, fallback, cache and reconciliation.
- [x] Validate the implementation: all 178 server tests, both type checks, lint and web build passed.

Implementation details and limits: [budget reservations](docs/budget-reservations.md).
Estimates coordinate admission; they do not guarantee a provider invoice cap.

## Stage 4 — Reuse tasks and detect regressions

**Completed: 2026-10-08. Started: 2026-10-08.**

- [x] Save and reload versioned text/JSON task sets, system instructions and output caps.
- [x] Validate content fingerprints and revisions before quoting or starting linked comparisons.
- [x] Reject concurrent stale edits; clear the reference when evaluation inputs change.
- [x] Explicitly choose a completed, fully reviewed run as the reference for future evaluations.
- [x] Freeze reference results in each new report so later reviews, replacement or deletion cannot rewrite it.
- [x] Show previously passing tasks that now fail, improvements, execution errors and inconclusive answers.
- [x] Compare costs and latency only on matching evaluated tasks; disclose model/provider configuration changes.
- [x] Require text storage for templates, reject detected personal data/secrets, enforce retention,
  and delete saved templates immediately when text storage is disabled.
- [x] Add the workflow and messages in all six supported languages; retain explicit spending approval per run.
- [x] Add 17 tests for replay, immutable references, manual review, version conflicts, privacy,
  retention, unknown charges, configuration changes and demo restrictions.
- [x] Validate the implementation: all 195 server tests, both type checks, lint and web build passed.

Implementation details and limits: [repeated evaluations](docs/repeated-evaluations.md).
Runs are started manually; this stage does not introduce scheduled provider spending or automatic profile changes.

## Stage 5 — Evaluate function calls and short tool loops

**Completed: 2026-10-08. Started: 2026-10-08.**

- [x] Check the model's choice of function and exact structured JSON arguments without forcing the expected function.
- [x] Replay 1–3 ordered tool calls with fixed results, then check the final text/JSON answer.
- [x] Execute model requests only; never execute fixture functions, shell commands, HTTP or MCP tools.
- [x] Report each turn's status, reason, request ID, recorded cost, tokens and latency, with scenario totals.
- [x] Estimate the bounded sequence, recheck its remaining budget each turn, and stop further cloud calls after uncertain charges.
- [x] Recheck key/admin access and model/provider configuration each turn; stop a loop after model substitution.
- [x] Preserve gateway privacy and key/team limits; scan tool definitions, arguments and results, including escaped JSON data.
- [x] Correct Anthropic native usage and cache-cost accounting; distinguish unknown token usage from known zero local API cost.
- [x] Save and replay tool scenarios with content fingerprints and immutable reference/regression reports.
- [x] Mask stored model transcripts, respect text storage/retention, and restrict manual review to valid final answers.
- [x] Add scenario editing, examples, import/export and per-turn reports in all six supported languages.
- [x] Keep live text routing profiles restricted to text-only comparison evidence.
- [x] Add 40 tests for tool validation, bounded loops, accounting, privacy, budgets, cancellation,
  access/configuration changes, manual review and saved scenarios. All 235 server tests, both type checks,
  lint and web build passed.

Implementation details and limits: [tool evaluations](docs/tool-evaluations.md).
These fixed scenarios establish evidence on the tested decisions; live tool-session routing remains planned.

## Stage 6 — Keep live tool sessions on an evaluated model

**Completed: 2026-10-08. Started: 2026-10-08.**

- [x] Create a separate tool session profile from a new complete loop comparison, with both models passing and known paired costs.
- [x] Store hashes of evaluated function definitions; require a matching tool contract on live requests.
- [x] Require an explicit session ID from the first non-streaming Chat request and preserve actual call IDs/history supplied by the client.
- [x] Pin the first model choice atomically in SQLite, scoped to the gateway key, across turns and restarts.
- [x] Keep existing original-model bindings after profile activation; reject adoption of prior tool/assistant history by an unknown session.
- [x] Block continuation after expiry, definition/configuration drift, revoked permissions or profile removal/disablement.
- [x] Recheck privacy and key/team budget admission per turn; block exhausted limits and prevent provider/local fallback from switching a session's model.
- [x] Keep pinned models through soft threshold/schedule rules and bypass the response cache for session calls.
- [x] Bound affinity to 24 hours and 1,000 unexpired bindings per key; retain hashes/configuration only and clean up expired metadata.
- [x] Add profile creation, session counts, connection guidance and request traces in all six supported languages.
- [x] Verify the supported Chat contract through OpenAI, Anthropic and Ollama provider translations.
- [x] Add 16 tests including live loop routing, key isolation, concurrent first turns, SQLite reopening,
  expiry, capacity, configuration drift, privacy, hard/soft budgets, provider failure and translation.
- [x] Validate the implementation: all 251 server tests, both type checks, lint and web build passed.

Implementation and client setup: [tool session routing](docs/tool-session-routing.md).
Clients supply full history and execute their own tools. This stage supports non-streaming Chat
function calls; native stateful protocols and streamed tool sessions remain planned.

## Later stages — Planned

- [ ] Extend tool-session continuity to streaming and native Responses/Anthropic client protocols.
- [ ] Explore model aliases, provider pools and session affinity, taking inspiration from
  [GoModel](https://github.com/ENTERPILOT/GoModel).
- [ ] Validate the complete workflow with 3–5 small teams and refine priorities from actual usage.

These later items are priorities to investigate, without committed completion dates.
