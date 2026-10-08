# Apply a tested model choice

Complete a text-only model comparison, including any manual reviews, then choose
**Apply to real requests**.
The first selected model is the baseline. A candidate must pass every task and have a lower total
recorded API cost than the baseline, which must also pass every task with known costs. Passing the
tested tasks does not establish general model quality. Choose tasks representative of the workload
you will send through this key.

[Tool evaluations](tool-evaluations.md) can check function calls and short loops with fixed results,
but a report containing any tool scenario cannot create a text routing profile. Passing a tool
fixture does not enable substitution of live tool traffic or certify a coding agent.

Select an active gateway key, name the profile, choose a candidate, and decide whether provider
failures should retry the baseline. The application continues to request the baseline's existing
model name. Only requests on that selected key for that model are eligible for substitution.
The production key may differ from the key used to evaluate models. There is one profile per key;
remove an existing profile before replacing it.

**Routing profiles** lets admins enable, disable and remove profiles and change baseline fallback.
Disabling or removing a profile restores ordinary gateway routing for new requests. No additional
shadow calls are made to measure the baseline on live traffic. The source comparison can expire or
be deleted: a profile retains its task count, comparison name, paired costs and model configuration
without retaining task texts or answers.

## Eligible requests and policy checks

Supported text requests can use OpenAI chat completions, Anthropic messages, stateless Responses
requests and Ollama chat/generate. Streaming text is supported. Eligibility uses a conservative
allowlist of request fields and text content blocks. Tools, images, embeddings, JSON response mode,
reasoning-specific controls, saved Responses context and Ollama context/options keep the requested
model, as do unrecognized fields. Existing budget and gateway rules continue to apply.

Both the baseline and candidate must be allowed by the key and its team. Budgets, schedule and
privacy checks apply to the model actually selected. Local API calls have zero recorded API cost;
hardware and operations are excluded. Exhausted budgets still use the gateway's existing local
fallback or blocking behavior; an unavailable or disallowed configured local fallback blocks.
Cloud calls now reserve estimated cost against the key and team budget before dispatch, including
cloud baseline fallback. See [budget reservations](budget-reservations.md) for estimates and
uncertain-charge reconciliation.

If the candidate becomes unavailable or forbidden, or either model's configuration changes, the
profile keeps the original model and explains why in the request trace. Changes to the provider,
endpoint URL, wire kind, upstream model, local status or prices require a new comparison. Older
comparison reports without complete configuration snapshots remain readable but cannot activate
a profile. Provider-side model changes behind an unchanged model name cannot be detected this way.

Baseline fallback is optional and retries provider failures such as timeouts, HTTP 5xx and 429
before an answer has started. It refreshes the caller and settings, rechecks baseline permissions,
budgets and privacy, and does not consume a second rate-limit slot. A revoked key cannot retry.
Once a stream starts, it cannot switch models. Existing local outage fallback rules remain in effect
when baseline fallback is unavailable or disabled. There is at most one alternate provider attempt.

## Recorded spend and estimates

The profile page summarizes the last 30 calendar days of retained request logs in the gateway's
time zone. Recorded API spend is calculated from provider-reported usage and configured prices;
it can differ from provider invoices. The page also counts successful candidate responses,
fallback attempts, skipped substitutions, errors and requests with unknown charges.

Estimated avoided baseline cost uses the successful candidate's reported token and cache usage
at baseline prices, minus recorded candidate cost. The baseline is not called to measure its answer
length, tokenization or bill. This is a counterfactual estimate. It can be negative when live usage
or cache pricing differs from the test tasks. Only successful, directly selected candidate responses
with known usage and prices qualify. Cache hits, provider fallback, interrupted streams, unknown
usage and Ollama context-cut warnings do not increase this estimate.

Failed cloud attempts can be charged even when the baseline or local fallback succeeds. Such
requests are flagged as having unknown charges. Recorded spend includes measured charges from
each cloud attempt, and the remaining estimate stays reserved until reconciliation. Logs and the
profile page do not present these unknown charges as confirmed zero.
Profile estimates are separate from the Overview's existing local-routing and cache savings.

Request traces explain profile selection, skipping and baseline fallback. The gateway also returns
`x-spillway-routing-profile` on successful matched requests and `x-spillway-model` with the actual
selected model. Request logs retain the requested, first attempted and served model, profile name,
outcome, cost-known flag and nullable baseline/savings estimates.

## Admin API

Session-authenticated administrators can use:

- `GET /admin/api/routing-profiles` — profiles and retained-traffic metrics.
- `POST /admin/api/routing-profiles` — create from a completed comparison using `name`, `keyId`,
  `comparisonId`, `baselineModelId`, `candidateModelId` and `fallbackOnError`.
- `PATCH /admin/api/routing-profiles/:id` — change `enabled` or `fallbackOnError`.
- `DELETE /admin/api/routing-profiles/:id` — remove the profile.

The read-only demo does not allow these mutations. The database migration runs on normal server
startup; the change does not publish a release or deploy the application.
