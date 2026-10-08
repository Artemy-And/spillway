# Model aliases and provider pools

An alias gives the application one stable model name. Configure it under **Models → Model
aliases and pools**, selecting 1–16 enabled concrete model targets and their providers.
Aliases use the existing evaluated tool-session contract and require `x-spillway-session`
from the first request. Use Chat, Responses or Messages as described in
[tool session routing](tool-session-routing.md). Embeddings and requests without that header
do not resolve aliases in this stage.

The weighted strategy deterministically samples a new session according to positive integer
weights. Ratios apply across many new sessions, not as an exact quota. Lowest token price
selects the allowed enabled target with the lowest input-plus-output list price; local models
have zero API cost. Missing cloud prices are skipped. This ranking does not predict total
conversation cost or compare model quality.

Spillway stores the chosen concrete model/provider in SQLite and preserves it for the binding's
24-hour lifetime. Pool edits, disabling or deleting an alias affect new sessions; existing
bindings retain their original selector and model. A changed concrete model configuration,
permission, hard limit or provider error still blocks continuation, without failover. Reusing
the ID with another selector is a continuity conflict. Concurrent first turns share one binding.

Pools do not establish evaluation evidence. A selected concrete baseline may have an eligible
evaluated routing profile on the key; that profile can choose its tested candidate when the new
session starts. Every selected concrete model must be allowed by the key and team. Evaluate
all models on the application's actual tasks before including them in a production pool.

The admin API uses `PUT /admin/api/model-aliases` to create or replace a definition:

```json
{
  "name": "agent",
  "enabled": true,
  "strategy": "weighted",
  "targets": [
    { "modelId": "YOUR_MODEL_ID_A", "weight": 9 },
    { "modelId": "YOUR_MODEL_ID_B", "weight": 1 }
  ]
}
```

Use `strategy: "lowest-cost"` for price selection; weights have no effect in that mode.
`GET /admin/api/model-aliases` lists definitions and `DELETE /admin/api/model-aliases/:name`
removes one. `/v1/models` lists enabled aliases only when the calling key has an eligible target.
Alias names cannot collide with concrete models. Targets cannot be aliases or duplicates.

The design takes inspiration from GoModel's [virtual models](https://gomodel.enterpilot.io/docs/features/virtual-models).
This initial Spillway pool does not probe provider health, retry other targets, support alias
chains or promise compatibility between arbitrary native reasoning contexts.
