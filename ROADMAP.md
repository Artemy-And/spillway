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

## Later stages — Planned

- [ ] Improve budget accounting for concurrent requests and unknown or partial provider charges.
- [ ] Expand capability checks and evaluation to supported tool-using workflows.
- [ ] Add reusable task sets and repeated evaluations to detect model regressions.
- [ ] Explore model aliases, provider pools and session affinity, taking inspiration from
  [GoModel](https://github.com/ENTERPILOT/GoModel).
- [ ] Validate the complete workflow with 3–5 small teams and refine priorities from actual usage.

These later items are priorities to investigate, without committed completion dates.
