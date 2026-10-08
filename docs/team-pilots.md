# Validate Spillway with 3–5 teams

Status: **prepared 2026-10-08; real team trials have not run.**

For each team, record its owner, application, baseline model/provider, candidate models,
10–20 representative synthetic/redacted tasks, and approved evaluation/production budgets.
Include tool decisions, failure cases and final answers. Agree on the team's minimum passing
criteria and whether human review is needed before starting paid provider runs.

Follow the same product path for every pilot:

1. Save and version the team's tasks. Compare baseline and candidate, including complete tool
   loops; record success, known API costs, latency and the amount of human review required.
2. Choose a reviewed reference. Confirm the cheaper candidate passes the agreed tasks.
3. Create the team's gateway key/profile, initially on 5–10% of **new** sessions. Integrate the
   session header and preserve complete call/result history. Use the documented native contract.
4. Observe failures, unknown charges and completion latency. Collect task completion and user
   feedback separately from API success; a 200 does not establish useful work.
5. Replay saved tasks after model/configuration changes and before increasing the share. Keep
   unknown/inconclusive runs from approving an increase. Set 0% to stop new candidate assignments.
6. Review measured API spend against the baseline estimate, setup effort, quality failures and
   whether the team would continue using/paying for the product.

Track per-team results in this template; leave values empty until measured:

| Team | Application/tasks | Baseline/candidate | Passing criteria | Approved budget | Pilot share | Recorded spend | Quality failures | Setup time | Would pay/continue? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | | | | | | | | | |
| 2 | | | | | | | | | |
| 3 | | | | | | | | | |
| 4 (optional) | | | | | | | | | |
| 5 (optional) | | | | | | | | | |

The user must provide participating teams, tasks and budgets before live validation can happen.
No invitations, paid calls or customer claims are part of this prepared plan. Prioritize the
next features from actual pilot results rather than inferred willingness to pay.
