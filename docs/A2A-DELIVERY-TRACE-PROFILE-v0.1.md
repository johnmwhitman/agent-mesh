# MeshFleet A2A offline delivery-trace profile v0.1

**Status:** fixture-verified pure conformance profile. No live transport, public tool,
listener, network peer, database write, authenticated principal, wake authority, provider
call, execution, or interoperability claim.

## Purpose

Slice 4D-alpha defines one pure operation:

```ts
evaluateDeliveryTrace(input: unknown): DeliveryTraceResult
```

It checks whether a modeled sequence of delivery observations preserves one canonical
`meshfleet.a2a` envelope binding and keeps delivery facts distinct. The transport label on
each event is evidence supplied by a fixture. It is not a claim that the corresponding
transport exists or participated.

Four labels are admitted:

- `stdio`
- `mailbox`
- `http_sse`
- `websocket`

The evaluator discards the label from normalized output. Equivalent semantic traces under
all four labels therefore produce byte-equivalent JSON values. This proves normalization
only. In particular, MeshFleet has no WebSocket delivery implementation and its existing
SSE surface is an optional local inbox projection, not general A2A HTTP transport.

## Canonical binding

`envelope_json` is decoded by the existing strict A2A v0.1 codec. The evaluator derives:

- `message_id`
- canonical envelope digest
- sender reference
- ordered concrete recipient references

Every modeled event repeats the message id and digest. A mismatch fails closed. Transport
metadata cannot change identity, recipients, payload, or digest.

Legacy direct and wildcard-broadcast calls enter this profile only after the existing
`mapLegacyMessage` operation has resolved them to a canonical envelope. The profile does
not add another legacy mapping or recipient-resolution rule.

## Distinct observations

The closed event vocabulary is:

| Kind | Meaning in this profile | Explicit non-meaning |
|---|---|---|
| `message_offered` | a modeled attempt presented the bound message | durable acceptance, arrival, wake, or execution |
| `message_arrived` | the bound message is modeled at one addressed recipient | recipient observation, acknowledgment, or wake |
| `recipient_observed` | an addressed recipient is explicitly modeled as observing it | acknowledgment or task completion |
| `receipt_recorded` | a non-`ack` receipt action is modeled | acknowledgment, identity, or authorization |
| `acknowledgment` | an addressed recipient explicitly acknowledges after arrival | task success, execution, or attestation |
| `retryable_failure` | this modeled attempt can continue with later events | terminal rejection |
| `terminal_rejection` | the modeled trace is closed against later events | proof of a live transport rejection |

`receipt_recorded` refuses action `ack`; callers must use the distinct
`acknowledgment` kind. Acknowledgment requires a prior modeled arrival for that recipient
but does not require a separate observation event. Repeated arrivals remain visible in the
timeline and are never collapsed into deduplication authority. By contrast, an identical
receipt fact for the same recipient and action, or a repeated acknowledgment by one
recipient, fails rather than inflating summary counts. Distinct receipt actions for the
same recipient remain distinct modeled facts.

The summary derives `all_recipients_acknowledged` only when every concrete canonical
recipient has an acknowledgment. This is not task completion. Once it becomes true, the
successful trace is closed against every later event. A terminal rejection may follow a
partial multi-recipient acknowledgment, but never complete acknowledgment.

## Ordering and precedence

Events contain a safe non-negative `sequence` and must be strictly increasing. One trace
models exactly one offer: the first event is `message_offered`, and no later event may
repeat it. A `retryable_failure` means the same modeled attempt may still produce later
arrival or rejection observations; it does not open a second attempt or reset recipient
state. A terminal rejection permits no later event. A caller models another attempt with a
new trace. Complete acknowledgment also permits no later event. The evaluator returns the
first deterministic error:

| Row | Code | Condition |
|---|---|---|
| D00 | `INVALID_INPUT` | root is not a plain object |
| D01 | `UNKNOWN_FIELD` | unknown root member |
| D02 | `INVALID_INPUT` | missing or non-string envelope JSON |
| D03 | `INVALID_ENVELOPE` | strict A2A v0.1 decode fails |
| D04 | `INVALID_INPUT` | events are absent, empty, or exceed 256 |
| D05 | `INVALID_EVENT` | event is not a plain object |
| D06 | `UNKNOWN_FIELD` | unknown event member, including wake/execute/transport framing |
| D07 | `INVALID_EVENT` | invalid sequence, transport label, or event kind |
| D08 | `ORDER_VIOLATION` | sequence does not increase or follows terminal rejection |
| D09 | `BINDING_MISMATCH` | event message id or digest differs from the envelope |
| D10 | `INVALID_EVENT` | required/forbidden or malformed agent reference |
| D11 | `NON_RECIPIENT` | agent is not a canonical recipient |
| D12 | `INVALID_EVENT` | invalid receipt action or action on a non-receipt |
| D13 | `ORDER_VIOLATION` | first event is not an offer |
| D14 | `ORDER_VIOLATION` | recipient event occurs before that recipient's arrival |
| D15 | `ORDER_VIOLATION` | a later event repeats the one allowed offer |
| D16 | `ORDER_VIOLATION` | duplicate acknowledgment or duplicate recipient/action receipt |
| D17 | `ORDER_VIOLATION` | event follows complete acknowledgment |

Unknown fields fail rather than being stripped. This prevents HTTP status codes,
WebSocket frame ids, JSON-RPC ids, `wake_authority`, `execute`, or similar
transport/control-plane material from becoming accidental delivery semantics.

## Frozen non-claims

Every conformant result carries these exact false claims:

```json
{
  "live_transport": false,
  "interoperability": false,
  "durable_acceptance": false,
  "authenticated_principal": false,
  "wake_authority": false,
  "execution": false,
  "persisted": false
}
```

Message arrival never grants or implies wake authority. Capabilities, provider/model names,
transport labels, receipts, and the local ledger remain evidence rather than authentication
or authorization.

## Evidence

- Pure implementation: `src/a2a/delivery-trace.ts`
- Executable tests: `test/a2a-delivery-trace.test.ts`
- Language-neutral fixtures:
  `test/fixtures/a2a/delivery-trace/v0.1/corpus.json`

The corpus covers four-label semantic equivalence, separate receipt and acknowledgment,
arrival without wake, retryable versus terminal failure, single-attempt ordering,
multi-recipient partial and complete acknowledgment, exact normalized summaries and
bindings, absence of transport fields from normalized output, non-recipient rejection,
duplicate receipt/ack rejection, successful-trace closure, and attempted wake-authority
smuggling. The module import guard allows only the canonical A2A codec and type imports,
excluding transport, MCP, database, runtime, provider, and execution dependencies.

## Non-goals

- HTTP, SSE, WebSocket, mailbox, or stdio framing protocols
- a `DeliveryPort`, outbox, retry engine, or deduplication store
- live peers, sockets, reconnection, backpressure, or authentication
- Slice 4C-1 principal binding or Slice 4B acceptance
- public `send_a2a` or delivery MCP tools
- runtime/provider selection or execution
- exactly-once delivery or execution
- multi-host coordination
