# Reusable tasks and repeated evaluations

In **Compare models → Saved task sets**, an administrator can save the current 1–20 tasks,
their success checks and expected answers, system instructions and output token cap. Tool tasks
also retain function definitions, expected call sequences and fixed results. The current
comparison name becomes the set's name. Loading a set restores those fields. The gateway key,
2–4 models and comparison budget remain a per-run choice.

Saving, loading and choosing a reference never contact providers. Every comparison still requires
an explicit cost estimate and **Run comparison** action, uses the gateway's policies and budget
reservations, and bypasses response caching and live routing profiles. This stage adds no scheduler,
automatic paid runs, notifications or automatic changes to routing profiles.

## Revisions and matching inputs

Saving a new revision updates the current template with optimistic concurrency: a stale writer
gets HTTP 409 instead of overwriting another admin's changes. The previous template text is not
archived. Prior reports retain their revision identifier and a SHA-256 content fingerprint.
**Load the current task set revision** loads the current template, which may differ from the
revision used by an older report.

The fingerprint covers system instructions, ordered task names/prompts/checks/expected answers
and the output cap. For tool scenarios it also covers their mode, ordered definitions, raw JSON
schema/argument strings and fixed results; reformatting those strings changes the fingerprint.
Renaming the set itself does not change the evaluation definition. Different
keys, budgets and model selections are allowed; costs and quality are matched by the same logical
model IDs and task indices. Detected model/provider/price changes are flagged in the result.

Changing evaluation inputs clears the set's reference. Renaming only preserves it. Linked quote
and start requests must match the saved fingerprint and current revision. An edited form can run
as an unsaved comparison, but it has no saved-set evidence or reference comparison until saved.
Reload the selected set to recover from a stale-version error.

## Reference results and regressions

After a completed comparison on a saved set, finish every automatic check and manual review,
then click **Use this run as reference**. Every reference cell must be passed or failed; runs with
unreviewed, skipped, errored or unfinished cells cannot serve as references. The reference must
use the same set and fingerprint. A report with some failed checks can be a reference for observing
improvements; choosing it does not certify the model for routing.

Each subsequent linked run takes a frozen copy of reference model metadata and numeric verdicts,
costs and latency at its start. Reference snapshots contain no output, prompt or expected-answer
texts. Replacing the set's reference, changing old manual verdicts, or deleting its source report
does not rewrite the evidence in already started reports. Deleting/expiring a set prevents replay,
while its reports remain readable for their own retention period.

The result distinguishes:

- **Regressions:** a matching task previously passed and now failed the same check.
- **Improvements:** a matching task previously failed and now passed.
- **Inconclusive:** missing model/reference cells, unfinished runs, skipped calls, errors or pending reviews.
- **Execution errors:** unsuccessful execution, shown separately from quality regressions.

Manual verdicts for the current run can change its comparison results; the frozen reference
does not change. Newly selected models have no historical comparison and are explicitly labelled.
The model's name and provider configuration may change between runs; the comparison matches its
logical ID and warns about changed configuration.

Cost totals use only matching evaluated tasks with known costs in both runs. Latency means use
matching evaluated tasks with recorded latency in both runs. Each metric shows its matching
task count. Unknown costs are excluded, not treated as zero. Local API costs still exclude hardware
and electricity. Prices, server load and provider variation can affect the measurements.

One run is an observation on the chosen tasks, not statistical proof or a general quality claim.
Spillway shows changes for review and does not disable or replace active routing profiles.
[Function-call and tool-loop tasks](tool-evaluations.md) use the same reference workflow, with
cost and latency measured across their whole sequence. Their reports cannot create live text profiles.

## Storage and access

Task-set APIs are session-authenticated and admin-only. The read-only demo refuses mutations.
List responses contain metadata and counts; template text is fetched only when loading a set.
The list shows the 100 most recently updated sets.

Templates require **Settings → Store prompt texts** because replay needs their actual task and
expected-answer texts. Saving rejects patterns identified by Spillway's existing personal-data
and secret detector instead of silently masking tasks and altering their checks. Use synthetic
placeholders such as `CUSTOMER_A` and `EMAIL_A`; valid-looking emails and document numbers can
still trigger the detector even when invented. Detection does not cover every possible secret or
personal detail; saved task sets are intended for synthetic test data.

Templates expire after the configured retention period from their last save or reference update.
Shortening retention applies to existing sets. Reads and replay reject expired templates;
periodic cleanup removes them. Turning off text storage deletes all saved templates immediately
through the Settings API, and write-time storage checks prevent an in-flight save from restoring
texts after disabling it. Numeric report/reference evidence remains under report retention.

Session-authenticated API:

- `GET /admin/api/task-sets` — recent set metadata.
- `POST /admin/api/task-sets` — save `{ name, system, maxOutputTokens, cases }`.
- `GET /admin/api/task-sets/:id` — load the current template.
- `PUT /admin/api/task-sets/:id` — save template fields plus the expected `revision`.
- `DELETE /admin/api/task-sets/:id` — remove with `{ revision }`.
- `POST /admin/api/task-sets/:id/reference` — select `{ revision, reportId }`; `reportId: null` clears it.
- `POST /admin/api/comparisons/quote` and `POST /admin/api/comparisons` accept optional
  `taskSet: { id, revision }` with the matching task inputs.
- `GET /admin/api/comparisons/:id/regressions` — matched changes, or `null` when the run has no reference.

The `task_sets` SQLite migration is applied at server startup. Existing comparisons remain readable
and work without a task-set link. No release or version tag is created for this milestone.
