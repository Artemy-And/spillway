# Agent session reports

**Routing profiles → Agent sessions** shows the latest 50 retained session bindings, including
baseline/control sessions and sessions started through a model/provider alias. It combines
all logged turns under the key-scoped session hash. `x-spillway-session-ref` on a successful
gateway response contains that reference; no raw client ID or conversation is stored in the
binding, charge association or report. The admin API is
`GET /admin/api/routing-profiles/sessions`; members cannot use it.

Each row reports the requested selector and pinned model, logged calls, active cloud attempts,
input/output tokens, unknown-usage count, recorded spend, active/uncertain reserves, errors,
calls taking at least five seconds, and average/maximum whole-turn latency in milliseconds.
Whole-turn latency is not time to first token. Privacy, text-storage and retention settings
continue to control request logs; no prompt, argument or result enters this aggregate response.

Recorded spend and reserves come from the existing charge ledger, including an active streamed
request before its final log exists. The same attempt is not added again from the request log.
Verified charge reconciliation updates the session's total immediately. Unknown charges remain
explicit even when their remaining reserve happens to be zero. Known zero local API cost does
not establish known token usage. Older logs without a ledger row are counted once.

Token, error and latency aggregates cover **retained logged calls**. Before a stream ends its
partial token usage is not included. A lost log cannot be reconstructed from the binding;
ledger charges remain separate. Bindings are bounded to 24 hours and metadata is cleaned up
after seven additional days. The report is not a permanent session archive, provider invoice
or a quality score. Previous logs/charges from before session associations were introduced
cannot be backfilled reliably and are not assigned to sessions.

For a team's cost/quality workflow, compare its tasks, choose an eligible profile, start with
a small [new-session share](tool-session-routing.md), monitor this report and replay saved
[regression checks in CI](evaluation-ci.md) before increasing the share. Collect actual task
completion/user feedback separately from transport success and recorded API spend.
