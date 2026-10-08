# Apply a tested model to tool sessions

A **tool session profile** applies a cheaper evaluated model to new function-calling conversations
on one gateway key. Each session keeps the same model across turns and gateway restarts. This
allows an application to use its tested choice without switching providers midway through a tool loop.

## Create a profile

1. Run a new [tool-loop comparison](tool-evaluations.md), including final-answer checks.
2. Both the baseline and candidate must pass every task, with known total costs. Complete manual reviews.
3. The candidate must cost less. In **Apply to real requests**, choose the production gateway key.
4. A comparison containing tool tasks creates a tool session profile. Text-only evidence creates
   a text profile. One key can have one profile; remove the old profile before replacing it.

Call-only checks cannot create a tool session profile. Reports from before session routing was
introduced need a new comparison: the new report stores hashes of evaluated tool definitions.
A mixed comparison can include ordinary text tasks and complete loops, with every task passing.
Tool session profiles route only matching tool sessions, not ordinary text requests.
Applications can also use a stable [model alias/provider pool](model-aliases.md) with the same
session header; a pool chooses the concrete baseline before an eligible profile is considered.

The admin API accepts `POST /admin/api/routing-profiles` with the normal profile fields plus
`"mode": "tools"` and `"fallbackOnError": false`. The default mode remains `"text"` for existing clients.
Profiles retain definition hashes and paired costs after the source report expires, without
retaining prompts, expected arguments, schemas or fixture results.

### Gradually enable a candidate

Tool profiles accept `rolloutPercent: 0–100` on creation and updates. The admin UI starts at
10% for a new tool profile; the API defaults to 100% for backwards compatibility. Choose the
share explicitly in **Apply to real requests** or adjust it on **Routing profiles**.
Spillway deterministically samples the key-scoped new session ID, then pins either baseline
or candidate in SQLite. Shares describe a distribution over many new sessions, not an exact
quota. Raising/lowering the share never changes either cohort's existing bindings.

Set 0% to stop new candidate assignments while allowing current sessions to continue. Disabling
or deleting the profile still blocks established profile sessions. Text profiles remain at
100% and do not offer per-session rollout. Use [CI replays](evaluation-ci.md) and the existing
regression reports to check changes before increasing a share; the gateway does not infer
answer quality from request success or automatically raise the share.

## Start and continue a session

Send **`x-spillway-session`** with a fresh random identifier from the first request. Reuse that
identifier, gateway key, requested baseline model and tool definitions on every turn. The ID must
contain 16–128 ASCII letters, digits, underscores or hyphens; a UUID works. Never reuse an ID for
another conversation. IDs are scoped to the gateway key and stored only as a hash.

Supported requests use `/v1/chat/completions`, text messages, 1–4 function definitions,
`parallel_tool_calls: false`, and automatic tool choice. Set `max_tokens` or `max_completion_tokens`
to 1–2048, using one field. Keep the functions available on the final-answer request too.
Parameters must be object schemas. Definitions must match the evaluated names, descriptions and
schemas; object property order and definition order do not matter. Expected fixture arguments
are not enforced on live inputs. Passing examples does not establish general agent quality.

The first request must start a fresh conversation with system/developer/user messages. An unknown
session cannot adopt existing assistant or tool history. Each later request includes the full
conversation: the actual assistant call followed by its `role: "tool"` result and matching
`tool_call_id`. The client runs its own functions and sends subsequent requests sequentially;
Spillway stores no history, runs no tools and does not orchestrate or serialize the client agent.
The history supports one function call per assistant turn and rejects duplicate call IDs or
unanswered/mismatched calls.

For example, after evaluating the `get_order` definition from [tool evaluations](tool-evaluations.md):

```js
import { randomUUID } from 'node:crypto';

const sessionId = randomUUID();
const tools = [{
  type: 'function',
  function: {
    name: 'get_order',
    description: "Read an order's current status.",
    parameters: {
      type: 'object',
      properties: { orderId: { type: 'string' } },
      required: ['orderId'],
      additionalProperties: false,
    },
  },
}];
const messages = [{ role: 'user', content: 'What is the status of order ORDER_A?' }];

async function turn() {
  const response = await fetch(`${process.env.SPILLWAY_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.SPILLWAY_KEY}`,
      'content-type': 'application/json',
      'x-spillway-session': sessionId,
    },
    body: JSON.stringify({
      model: 'YOUR_BASELINE_MODEL_NAME',
      messages, tools, stream: false, max_tokens: 256,
      tool_choice: 'auto', parallel_tool_calls: false,
    }),
  });
  if (!response.ok) throw new Error(await response.text());
  console.log('Session model:', response.headers.get('x-spillway-model'));
  return (await response.json()).choices[0].message;
}

const assistant = await turn();
const call = assistant.tool_calls?.[0];
if (!call || call.function.name !== 'get_order') throw new Error('Unexpected model decision');
// Validate arguments and authorize the action in your application before executing it.
messages.push(assistant, {
  role: 'tool', tool_call_id: call.id,
  content: JSON.stringify({ orderId: 'ORDER_A', status: 'paid' }),
});
console.log(await turn());
```

The result above is demo data; replace it with the application's own authorized function result.
The assistant/tool message relationship follows the official
[OpenAI function calling guide](https://developers.openai.com/api/docs/guides/function-calling).

### Stream a turn

Set `stream: true` on any turn, keeping the same session header, tools and full history.
`stream_options: { include_usage: true }` is accepted; Spillway requests usage from the provider
even if the client omitted it or set it to false. The response uses ordinary Chat SSE chunks:
tool call IDs and names arrive with initial deltas, and JSON arguments can span multiple deltas.
Accumulate them by tool index and execute a function only after the complete call is received
and validated by your application. Append that assembled assistant message and its tool result
before starting the next turn. Text and streaming turns can alternate within one session.

Spillway requires a provider completion marker as well as the finish reason. A truncated stream,
provider error event or client cancellation retains uncertain charges, even when partial usage
was reported. Missing usage also keeps cloud charges uncertain. Errors after streaming begins
use the client's error event/transport; an HTTP 200 by itself does not mean the turn completed.
Canceling the response body aborts the upstream request. These conditions never switch the
session's model. See [official streaming guidance](https://developers.openai.com/api/docs/guides/streaming-responses).

### Native Responses and Anthropic Messages clients

The same session header also works on `/v1/responses` and `/v1/messages`, with either whole
responses or streaming. Continue to send full history and the evaluated function definitions.
The pinned model/provider and budget rules are identical to Chat.

For Responses, use flat `type: "function"` tools with `strict: false`, `parallel_tool_calls: false`,
automatic tool choice and `max_output_tokens: 1–2048`. Spillway sets `store: false`. Preserve the
actual `function_call.call_id`, `name` and `arguments` in `input`, followed by its
`function_call_output` with matching `call_id` and a string `output`. Text message content may
be a string or input/output text blocks; returned message/function IDs and statuses are accepted.

For Messages, use tools with `name`, `description` and `input_schema`, `max_tokens: 1–2048`,
and `tool_choice: { type: "auto", disable_parallel_tool_use: true }`. Preserve actual `tool_use`
IDs/input objects in assistant content and matching `tool_result` blocks in the next user
message. Text-only system/message blocks are supported, including string/array tool results.
Keep tool results before any ordinary user text in that message.

Unknown sessions cannot adopt native assistant/tool history either. Parallel calls, strict
schemas, images, hosted tools, thinking/signature blocks, encrypted reasoning, item references,
`previous_response_id` and stored conversations are rejected before a provider call. This
bounded full-history contract does not claim support for every SDK/agent configuration.
Native provider formats pass supported history through; translated providers preserve call IDs
and disable parallel tools. Clients must recognize the native completion/error events.

## Continuity, limits and failure behavior

SQLite atomically pins the first model choice. Concurrent first requests cannot choose different
models for the same ID. The binding lasts **24 hours from creation**, across gateway restarts.
Responses include `x-spillway-model`, `x-spillway-session-status: pinned` and the session's
`x-spillway-session-expires-at`. A session started without an eligible active profile pins the
original model; enabling a profile later cannot upgrade that existing conversation. Tool traffic
without this header continues to use the original gateway behavior and is not substituted by a profile.

Every turn rechecks key/team permissions, model configuration, the profile, privacy and budget
admission. Hard limits block the request. Budget-threshold and off-hours rules keep the pinned
model; response caching and every provider/local fallback are disabled for these sessions.
Provider failures stop that request and retain normal accounting for uncertain charges.
The client can retry on the same unchanged model, subject to its remaining budget.

Changing the requested model or tool definitions, disabling/removing the applied profile, or
changing a model/provider configuration blocks continuation rather than choosing another model.
Expired sessions return HTTP 410; unsupported requests return 400; continuity conflicts return
409; permission and budget failures use 403/429. Start a fresh conversation and ID when a session
must change models. The gateway cannot detect provider-side model updates behind an unchanged name.

There are at most 1,000 unexpired bindings per key. New IDs receive HTTP 429 at capacity; existing
bindings are not evicted. Expired metadata is removed after seven additional days. Text-storage
settings still control log previews; bindings contain no conversation or raw session identifiers.
The admin profile page shows unexpired session counts, recorded spend and the existing labelled
cost estimates. Request traces explain the pinned model and rejected continuation.

This stage supports the evaluated Chat function-call contract through existing OpenAI, Anthropic
and Ollama provider translations, including native full-history Responses/Messages clients,
streamed tool arguments and text. Parallel functions, provider-hosted tools, strict-mode fields,
images, saved provider conversation
state and automatic migration between models remain outside this contract.
