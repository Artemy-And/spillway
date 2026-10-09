# Budget reservations

Before a paid cloud attempt, Spillway inserts an estimated cost into a SQLite budget ledger.
The insert and capacity check are one SQL statement: simultaneous requests cannot both occupy
the same available allowance. It checks the key's daily and monthly limits and its team's monthly
budget together, using recorded charges plus active and uncertain reserves. Separate keys on the
same team share the allowance. Current key permissions and revocation are checked during admission.

If the estimate does not fit, a chat request uses the configured local model only when it is local
and permitted for the key and team and the key allows fallback. Otherwise the call is blocked
before contacting the provider. Embeddings retain their own model and are blocked rather than
substituted. Existing schedule, privacy, rate-limit and budget-threshold rules still apply.
Local API calls and cache hits do not create paid reservations. Cache lookup respects the existing
gateway policy and includes any automatically applied output cap in its request identity.

## Estimates and output limits

The estimate uses serialized request bytes plus an allowance for formatting, conservative input
pricing including cache writes, configured output pricing, the output token cap and number of
choices. It is a planning estimate, not a guarantee of provider billing. Cloud calls with a key or
team budget need known prices and bounded input.

For limited cloud calls without a client output cap, Spillway adds 4,096 output tokens, or 32,000
for Responses requests. Native OpenAI chat receives `max_completion_tokens`; compatible chat APIs
and Anthropic use `max_tokens`; Responses uses `max_output_tokens`; Ollama clients use
`options.num_predict`. Existing client caps are preserved. Set an explicit positive cap when
your task needs a different answer length. Unbudgeted calls retain their original request fields;
their provisional estimate uses a default output allowance and can be exceeded.

Remote images, audio, documents, provider-managed context and hosted tools with unconfigured fees
do not have a bounded text estimate. Budgeted cloud calls using those features switch to an allowed
local model or are blocked. Client-executed text tools and their schemas can be estimated; provider
translation still determines which tools are sent. This milestone does not introduce multimodal
pricing or provider-tool price tables.

[Pinned native Responses sessions](native-session-context.md) are an exception for tracked
`previous_response_id`: their conservative accumulated history bound is added to each new
request estimate. Unknown/untracked provider context still has no bounded estimate.
Native Messages thinking sessions also reserve prior output caps in addition to visible request
bytes, because signatures can carry hidden thinking that is billed again as input.

An actual reported charge can exceed the reserve if the estimate or configured prices are wrong,
or a provider does not respect its cap. Spillway records the charge and prevents further calls
that no longer fit. The feature closes concurrent admission races; it cannot guarantee an invoice
cap independent of the provider.

## Completion, failures and restart

Successful final usage replaces the reserve with the calculated charge. Interrupted streams,
failed cloud attempts, absent usage or unknown prices leave an **uncertain** ledger entry. Measured
partial token charges are recorded and deducted from the remaining hold. An attempt that may have
been accepted by the provider is not assumed free. A client cancellation detected before dispatch
releases the reserve because no provider request was made.

Baseline fallback gets a separate reservation, in addition to any uncertain first attempt.
The log records charges from all attempts rather than just the final answer. Missing embeddings
usage is distinguished from a genuine zero-token response. Unknown charges remain flagged even
if a local fallback answers successfully. Profile savings remain unavailable for failed or
fallback requests.

On normal server startup, active reservations from the interrupted process become uncertain and
retain their amounts. They are not automatically released by a timer. Deploy Spillway as a single
gateway process per database; the startup recovery assumes that the previous process has stopped.
Admission itself is atomic across SQLite connections. No prompts, answers, provider credentials
or endpoint URLs are stored in the budget ledger.

## Admin UI and reconciliation

**Keys** and **Budgets & rules** show recorded spend, active reserves, uncertain reserves and the
available allowance. Usage bars and limit status include reserves. Team and key allowances remain
separate; a key's available amount does not replace its team's limit. Logs mark incomplete charges
with `+ ?` and explain reservations and reconciliation.

**Budgets & rules → Budget reservations** lists up to 200 recent active/uncertain attempts. Members
see only their own keys' attempts. An admin can reconcile an uncertain attempt after checking the
provider's bill: enter the **total charge for that one attempt**, confirm verification, and save.
Zero is valid when the provider confirmed there was no charge. Active calls cannot be reconciled.
Reconciliation releases the remaining hold, updates the recorded request cost and adds a trace
entry. Other uncertain attempts on the same request remain unresolved until separately verified.
The read-only demo blocks reconciliation.

Daily and monthly windows use the gateway's configured time zone. Each attempt belongs to the
period in which it was admitted, including when settlement or reconciliation happens later.
Prior-period uncertainties remain visible but do not consume a newly reset period's allowance.
Ledger charges are counted once; request logs created before this migration still count toward
budgets. Numeric ledger entries persist independently of prompt-text retention and log availability.

Session-authenticated API:

- `GET /admin/api/budget-holds` — active/uncertain attempts, narrowed to owned keys for members.
- `PATCH /admin/api/budget-holds/:id` — admin reconciliation with `{ "chargedUsd": 0.0012 }`.
- `GET /admin/api/keys` — daily/monthly spend, active/uncertain reserves and available amounts.
- `GET /admin/api/teams` — corresponding monthly team amounts.

The SQLite migration is applied at server startup. No release, version tag or deployment is
required for development of this feature.
