# Compare models on your tasks

An administrator can open **Compare models**, choose an existing gateway key, select 2–4 enabled
models, and enter 1–20 representative text tasks. The first selected model is the baseline.
Cloud models need both input and output prices. Choose a comparison budget and output token limit,
estimate the cost, then explicitly start the run. Estimating does not contact providers.

Every task runs once per model, sequentially, through the normal gateway. The selected key's team,
model allowlists, limits, privacy rules and rate limit still apply. The response cache is bypassed.
These are real provider requests and appear in the request log. Only one comparison runs at a time.
Cancellation aborts the active request and skips the remainder; an already accepted provider request
may still be billed. Runs interrupted by a server restart are marked interrupted and are not resumed.

Checks available:

- **Manual review:** read each stored answer and pass or fail it using the same criteria.
- **Contains text:** case-sensitive text inclusion.
- **Exact answer:** case-sensitive equality after trimming surrounding whitespace.
- **JSON:** the entire response must parse as JSON, without Markdown fences. An optional expected
  object is checked as a subset; arrays and scalar values must match exactly.

A response cut off by the output limit, missing text, or an Ollama context warning fails.
A response served by a substituted model is marked skipped and names the actual model.
Passing these checks establishes success on the chosen tasks, not general model quality.

The report shows recorded API costs, tokens, elapsed time, errors, and per-task answers. Cost
differences against the baseline use only common passing tasks with known costs. A local model has
zero API cost in this comparison; hardware, power and operations are excluded. Recorded cloud costs
use the configured model prices and reported usage, so they can differ from provider invoices.

Before each call the runner checks a conservative byte-based estimate against the remaining
comparison budget. It stops further cloud calls when that estimate does not fit, or previous charges
are unknown. Missing usage is shown as unknown, never zero. Estimates and provider token limits do
not guarantee a hard billing cap. Ordinary live traffic on the same key is outside this run's budget.
Unknown charges after a failed cloud request or failover are also flagged.

Reports do not retain raw task prompts or expected answers. Outputs follow **Settings → Store
prompt texts**, are masked before storage, and are limited to 8,000 characters. Checks use the full
answer before masking. With text storage disabled, automatic results and costs remain available;
manual review requires a complete stored output. Reports expire after the configured retention
period. Tasks can be imported/exported as a JSON array, and reports downloaded as JSON.

Example task file:

```json
[
  {
    "name": "Extract an order",
    "prompt": "Extract order ID and status from: Order A-17 was paid. Reply only with JSON containing orderId and status; use paid for status.",
    "check": "json",
    "expected": "{\"orderId\":\"A-17\",\"status\":\"paid\"}"
  },
  {
    "name": "Support reply",
    "prompt": "Write a brief, polite reply explaining how to reset a forgotten password.",
    "check": "manual",
    "expected": ""
  }
]
```

This stage does not automatically change routing rules and does not evaluate tool-using coding
agents. Use the findings to decide which model to try next for the tested workload.
