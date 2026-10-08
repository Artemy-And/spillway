# Evaluate function calls and short tool loops

In **Compare models**, a task can check a function call or a short tool loop alongside ordinary
text and JSON tasks. This helps a team compare whether models choose the expected function,
produce the right arguments and use its result correctly, with the cost of the whole sequence.
Save the scenarios in a [task set](repeated-evaluations.md) to repeat them and detect regressions.

Tool results are fixed strings supplied by the administrator. Spillway sends model requests and
replays these fixtures; it does not execute the named function, a shell command, an HTTP request
or an MCP tool. Use synthetic scenarios that represent the decisions your application needs.

## Scenario modes

- **Function call (`call`):** define 1–4 functions and exactly one expected call. The model must
  choose that function and return the expected JSON arguments. This takes one model request;
  the ordinary text check and expected final answer do not apply.
- **Tool loop (`loop`):** define 1–4 functions and 1–3 ordered expected calls. After each matching
  call, Spillway appends its fixed result to the conversation. One final request must answer
  without another function call and pass the task's exact, contains, JSON or manual check.
  A completed loop therefore takes 2–4 model requests.

Manual review applies only to the final answer after all expected calls pass. It cannot override
a failed function or argument check, and a truncated stored transcript cannot be reviewed.

Requests use `tool_choice: "auto"` and `parallel_tool_calls: false`. The runner checks exactly one
call at each expected step rather than forcing the expected function. Missing, unexpected or
multiple calls fail the check. A wrong order or reused call identifier also fails. Function
arguments must be JSON objects and match the expected object structurally: object key order is
ignored, array order and values must match, and extra properties are rejected.

Each function's `parameters` is a JSON string with an object schema (`"type": "object"`);
`arguments` is a JSON object encoded as a string. Spillway checks their basic shape and bounded
size, but does not implement full JSON Schema validation or enable provider strict mode. An exact
argument match is evidence for the supplied example, not proof that all outputs satisfy a schema.
The request settings follow the controls described in the official
[OpenAI function calling guide](https://developers.openai.com/api/docs/guides/function-calling).

## Model continuity and protocol limits

All turns request the same selected model and retain the conversation history, including the
actual call identifier and arguments. Before each turn the runner checks the current key,
administrator, model and provider configuration. A changed or unavailable configuration stops
that cell. The normal gateway can still substitute a model under its policy or fallback rules;
the runner marks that cell skipped and does not continue its loop with the substitute.

Evaluation uses non-streaming OpenAI Chat Completions function calls through the gateway's
existing provider translations. It does not independently test native Responses or Anthropic
client protocols, streamed argument assembly, provider-hosted tools, parallel calls, images,
saved provider conversation state or an unrestricted coding agent. Models that do not support
the tested function-call contract can fail or return a provider error. One successful run
establishes success on these fixtures, without guaranteeing general agent quality.

A report containing tool scenarios cannot create a live text routing profile. New comparisons
with complete tool loops can create a separate [tool session profile](tool-session-routing.md).
Call-only checks cannot activate routing. Session routing requires matching evaluated definitions
and explicit session IDs; it keeps the chosen model throughout the conversation.

## Costs, limits and reports

The estimate includes every possible turn and growing history; early failures may use fewer
requests. Each turn rechecks its actual estimate against the remaining comparison budget and
passes through the gateway's key/team permissions, privacy policy, rate limits and
[budget reservations](budget-reservations.md). Fixture results enter the next prompt and receive
the same privacy checks as other input. The output token cap applies to each turn. Response
caching and live routing profiles are bypassed for evaluation requests.

Reports show each step's verdict, reason, gateway request ID, recorded cost, tokens and latency,
plus totals for the scenario. Missing usage leaves token counts unknown; uncertain provider
charges leave cost unknown. Known
charges still contribute to the run's recorded spend, but an uncertain turn makes the cell's
total cost unknown and stops further cloud calls in the run. Local API cost excludes hardware
and electricity. Estimates and configured token prices do not guarantee a provider invoice cap.

Generated text and returned calls can appear in the stored output transcript, masked by the
existing personal-data detector and limited to 8,000 characters. Checks use the original response.
Outputs require **Settings → Store prompt texts** at both run start and storage time, and follow
report retention. Comparison reports do not retain raw prompts, function schemas, expected
arguments or fixture results as scenario inputs.

Saved task sets retain those inputs to allow replay, require text storage and reject detected
personal data/secrets. The content fingerprint includes the mode, ordered definitions, raw
schema/argument strings and fixed results. Editing or even reformatting those strings changes
the evaluation definition and clears its reference. Reference comparisons use the existing
immutable snapshot and matched quality/cost/latency rules.

## JSON API example

The session-authenticated admin endpoints `POST /admin/api/comparisons/quote` and
`POST /admin/api/comparisons` accept the following body. Replace the key/model IDs with existing
enabled choices. Quoting does not contact providers; starting creates real model requests.
The same `cases` array can be imported in the UI or saved using the task-set APIs.

```json
{
  "name": "Order lookup loop",
  "keyId": "YOUR_KEY_ID",
  "modelIds": ["BASELINE_MODEL_ID", "CANDIDATE_MODEL_ID"],
  "system": "Use get_order when an order status is requested. After its result, reply only with JSON containing orderId and status.",
  "maxSpendUsd": 1,
  "maxOutputTokens": 256,
  "cases": [
    {
      "name": "Read a paid order",
      "prompt": "What is the status of order ORDER_A?",
      "check": "json",
      "expected": "{\"orderId\":\"ORDER_A\",\"status\":\"paid\"}",
      "tools": {
        "mode": "loop",
        "definitions": [
          {
            "name": "get_order",
            "description": "Read an order's current status.",
            "parameters": "{\"type\":\"object\",\"properties\":{\"orderId\":{\"type\":\"string\"}},\"required\":[\"orderId\"],\"additionalProperties\":false}"
          }
        ],
        "steps": [
          {
            "name": "get_order",
            "arguments": "{\"orderId\":\"ORDER_A\"}",
            "result": "{\"orderId\":\"ORDER_A\",\"status\":\"paid\"}"
          }
        ]
      }
    }
  ]
}
```

For a call-only check, change `mode` to `"call"`; keep one step and use `check: "manual"` and
`expected: ""` for the unused final-answer fields. Its fixed result is not sent in another request.
Remove `tools` entirely to restore the existing text/JSON task behavior. Older saved sets and
reports remain readable without tool fields.
