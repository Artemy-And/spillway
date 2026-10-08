# Run saved evaluations in CI

CI replays a saved task set through the existing gateway comparison runner. It uses the same
privacy checks, key/team limits, per-run spending limit, tool fixtures and immutable reference
as the admin UI. It never executes fixture tools and never changes references or production
profiles. Each invocation is an explicit bounded provider-spending run.

1. Save tasks with automatic answer checks. Complete a linked run and choose it as the reference.
2. Include every model you intend to check in that reference. Record the saved revision.
3. Prepare a JSON configuration and supply your gateway origin and signed admin session cookie
   through your CI secret environment. Admin SSO can supply the same session cookie; gateway
   API keys do not authorize the admin comparison API.

```json
{
  "taskSetId": "YOUR_SAVED_TASK_SET_ID",
  "revision": 1,
  "keyId": "YOUR_EVALUATION_GATEWAY_KEY_ID",
  "modelIds": ["BASELINE_MODEL_ID", "CANDIDATE_MODEL_ID"],
  "maxSpendUsd": 0.5
}
```

With Node 24 or later and the repository checked out:

```sh
SPILLWAY_URL=https://YOUR_GATEWAY \
SPILLWAY_ADMIN_COOKIE="$CI_SPILLWAY_ADMIN_COOKIE" \
node scripts/evaluate.mjs evaluation.json
```

The script checks the saved revision/reference and estimate before starting. Automatic checks
are required; manual final answers cannot produce an unattended verdict. Output contains the
report ID, recorded spend, unknown-charge flag and regression summary, without task transcripts.
Exit 0 means all selected models passed all matching tasks, costs are known and there are no
regressions/inconclusive cells. Exit 1 means an unsuccessful evaluation; exit 2 means invalid
configuration, access, quote, timeout or network/API failure. A failed gate should prevent your
deployment/rollout step in the CI system. The script does not attach itself to a production
workflow or schedule spending without configuration.

The deadline is three minutes. On polling failure it requests cancellation of the created run;
an already-sent provider attempt may still incur charges under normal uncertain-charge rules.
A lost start response cannot establish whether a run was created; inspect the comparison list
before manually retrying. An estimate coordinates admission rather than capping a provider's
invoice. Changing saved tasks requires updating the pinned revision and reference explicitly.

Use the completed comparison to [create an evaluated profile](routing-profiles.md), start a
small share of new tool sessions, and rerun this gate before increasing the share or changing
the model/configuration. An operator can set the share to 0% after an unsuccessful result;
existing sessions keep their model. Real production quality still needs task/user feedback.
