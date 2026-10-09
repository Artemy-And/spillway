# Native context in agent sessions

Spillway can continue provider-stored Responses state and preserve Anthropic Messages thinking
on a durable tool-session binding. Send `x-spillway-session` from the first request, reuse the
gateway key, model selector and function definitions, and execute tools in your client.
The first choice may come from an evaluated tool profile or a model alias; it stays fixed.
Choose a target speaking the same native API. Context is never translated to another provider.

## Responses response-ID chains

Start `/v1/responses` with `store: true`, flat function tools with `strict: false`,
`parallel_tool_calls: false`, automatic tool choice and explicit `max_output_tokens: 1–32768`.
Optional `reasoning` accepts `effort` and `summary`; use values supported by your upstream model.
For each continuation, set `previous_response_id` to the **latest completed response ID** from
this key and session and supply only new text messages or its outstanding function result:

```js
const tools = [{
  type: 'function', name: 'get_order', strict: false,
  parameters: {
    type: 'object', properties: { orderId: { type: 'string' } },
    required: ['orderId'], additionalProperties: false,
  },
}];
const common = {
  model: 'YOUR_NATIVE_RESPONSES_MODEL', tools,
  store: true, parallel_tool_calls: false, max_output_tokens: 2048,
};
// POST first with the same authorization and x-spillway-session headers on every turn.
const first = { ...common, input: 'Find the status of order ORDER_A' };
// After receiving response.id and a function_call item, execute the function in your client.
const next = {
  ...common, previous_response_id: response.id,
  input: [{ type: 'function_call_output', call_id: call.call_id, output: toolResult }],
};
```

Repeat the same instructions and reasoning/sampling settings. A continuation may omit `store`
to use the provider's stored default; `store: false` cannot continue a stored session.
An outstanding call needs exactly one matching string result before a further user turn.
An old, imported or another key's response ID receives 409 before provider spending.
Parallel branches, replaying an old head, attaching existing provider conversations and
resuming untracked response IDs are unsupported. Start a new session for another conversation.

OpenAI charges previous input tokens again in response-ID chains. Spillway adds a conservative
history token bound to the new turn's reservation: accumulated request bytes, formatting
allowances and all prior output caps, increased if reported input usage is larger. This includes
the output allowance for hidden reasoning; a short continuation is not estimated as an empty
conversation. Unknown charges retain their normal ledger holds and consume remaining budget.
This remains an estimate, subject to configured prices and provider billing.
See [OpenAI conversation state](https://developers.openai.com/api/docs/guides/conversation-state).

## Anthropic thinking and signatures

Start `/v1/messages` with `thinking: { type: "enabled", budget_tokens: 1024 }` or
`thinking: { type: "adaptive" }`, where the chosen model supports it. Optional `display` is
`"summarized"` or `"omitted"`. Use explicit `max_tokens: 1–32768`; enabled thinking requires
an integer budget of at least 1024 and strictly below `max_tokens`.
Keep the existing automatic choice with `disable_parallel_tool_use: true` and 1–4 function tools.

Append the **complete returned `content` array** as an assistant message, then the matching
user `tool_result`. Replay all earlier messages unchanged. Preserve `thinking`, every signature
and `redacted_thinking.data` exactly, including thinking blocks with empty text. Repeat the
same thinking, system, tool and sampling settings. Changing, omitting or importing blocks
fails the session's history fingerprint check; Spillway does not claim to verify signatures
cryptographically. The provider performs that verification.

For streaming, assemble `thinking_delta` and `signature_delta` into their corresponding block,
and `input_json_delta` into the tool's JSON input before the next turn. Spillway forwards the
provider's SSE bytes unchanged and checks the assembled continuation before committing it.
Prior thinking may be billed as input even when its displayed text is empty or summarized.
The next turn's reservation therefore adds all prior output caps to the visible full-history
request estimate, conservatively accounting for hidden reasoning without decoding signatures.
See [Anthropic thinking](https://platform.claude.com/docs/en/build-with-claude/thinking).

## Continuity and limits

- Completed JSON and streaming heads survive gateway restarts. Finish reading the stream before
  sending the next turn. The model/provider, native API mode and encrypted credential fingerprint
  are bound from the first turn; changes or disabled profiles block continuation.
- One native turn may be in progress per session. A concurrent or stale turn receives 409;
  any reservation made before losing the atomic claim is released without a provider call.
- Privacy, permissions and key/team budgets are checked per turn. Visible thinking is scanned;
  opaque signatures/ciphertext are passed through unchanged. Stored Responses history retains
  detected sensitive-data categories so enabling privacy protection also checks earlier context.
- Policy/budget refusals preserve the head. Provider failures, incomplete output, broken streams
  and cancellation do not advance it and retain uncertain charges. Start a fresh conversation
  and ID afterwards. A process interrupted while a native turn was active also fails closed.
- Native bindings keep the existing 24-hour expiry, 1000 active sessions per key and seven-day
  expired-metadata retention. The native state row is deleted with its binding/key.
  A conservative history bound above one million tokens blocks another turn. The state observer
  limits completed JSON or observed stream-event data to 2 MB per turn.
- The SQLite continuity table stores hashes of context/configuration, numeric bounds, sensitive-data categories and
  turn status. It stores no raw response IDs, history, thinking, signatures or encrypted blocks.
  This metadata works with log text storage disabled. `store: true` separately opts into upstream
  Responses storage, governed by the provider; Spillway expiry does not delete provider responses.

Full-history `store: false` sessions retain their existing behavior. Conversations API objects,
encrypted reasoning supplied in Responses input, hosted tools, strict function schemas,
parallel calls, images and migration between models remain unsupported in pinned sessions.
Existing tool comparisons exercise the tested Chat-style loops; they do not independently
establish quality with every native reasoning configuration. Verify those settings on your own
tasks before expanding a rollout. Integration checks use local synthetic providers and incur
no real model charges.
