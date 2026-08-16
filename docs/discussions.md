# Discussions

A Discussion is a bounded, two-agent conversation built on the existing P2P message and receipt substrate. It uses a shared `correlation_id` and a versioned JSON envelope inside the standard opaque string payload to derive an ordered transcript from server-assigned turn ordinals.

The primary safety law is that message arrival never starts an agent. Receiving a message, an SSE event, or an inbox poll will never trigger a model run. Waking an agent is always an explicit, atomic, and budgeted action.

Every authorized turn is tracked through namespaced lifecycle receipts. These receipts record who-recorded-what, including who was authorized to run, when the run began, how it ended, and which reply it produced, ensuring the conversation remains strictly bounded.

## Quickstart

All payloads must be JSON-serialized strings. Ordinals (`turn`) and `attempt_id` values are strictly server-authored; never invent them.

**1. Initiate (`ask_peer`)**
```json
{
  "from_agent_id": "agent-a",
  "to_agent_id": "agent-b",
  "fleet_id": "fleet-alpha",
  "payload": "{\"body\":\"Refactor auth module?\"}",
  "max_turns": 4,
  "timeout_ms": 300000,
  "turn_timeout_ms": 60000,
  "wake_peer": false
}
```

**2. Wake Peer (`wake_agent`)**
```json
{
  "agent_id": "agent-b",
  "discussion_id": "<server-authored-id>",
  "expected_head_message_id": "<root-msg-id>"
}
```

**3. Reply (`reply_discussion`)**
```json
{
  "agent_id": "agent-b",
  "discussion_id": "<server-authored-id>",
  "attempt_id": "<server-authored-attempt>",
  "reply_to_message_id": "<root-msg-id>",
  "type": "result",
  "payload": "{\"body\":\"Yes, proceed.\"}",
  "close": true
}
```

**4. Read State (`get_discussion`)**
```json
{
  "discussion_id": "<server-authored-id>",
  "include_receipts": true
}
```

## Tool Reference

### `ask_peer`
| Parameter | Type | Range / Constraints |
| :--- | :--- | :--- |
| `from_agent_id` | string | Valid agent in fleet |
| `to_agent_id` | string | Valid agent in fleet, distinct from sender |
| `fleet_id` | string | Valid fleet |
| `payload` | string | Serialized JSON, ≤ 64KiB total envelope |
| `max_turns` | integer | 2 to 32 |
| `timeout_ms` | integer | 1,000 to 900,000 (1s to 15m) |
| `turn_timeout_ms` | integer | 1,000 to 300,000 (1s to 5m), ≤ `timeout_ms` |
| `wake_peer` | boolean | `true` or `false` |

### `wake_agent`
| Parameter | Type | Range / Constraints |
| :--- | :--- | :--- |
| `agent_id` | string | One-shot wake participant, recipient of head |
| `discussion_id` | string | Active discussion ID |
| `expected_head_message_id` | string | Current canonical head message ID |

*Errors:* `turn_already_active`, `stale_head`

### `reply_discussion`
| Parameter | Type | Range / Constraints |
| :--- | :--- | :--- |
| `agent_id` | string | Woken participant |
| `discussion_id` | string | Active discussion ID |
| `attempt_id` | string | Server-authored attempt ID |
| `reply_to_message_id` | string | Current canonical head message ID |
| `type` | string | `"question"` or `"result"` |
| `payload` | string | Serialized JSON, ≤ 64KiB total envelope |
| `close` | boolean | Optional. `true` terminates discussion. |

### `get_discussion`
| Parameter | Type | Range / Constraints |
| :--- | :--- | :--- |
| `discussion_id` | string | Discussion ID |
| `include_receipts`| boolean | Optional. Default `true`. |

## Reading Transcripts and Receipts

`get_discussion` returns the derived state. Key fields include:
*   `policy`: Immutable limits (`max_turns`, `conversation_deadline`, `turn_timeout_ms`).
*   `status`: Current terminal or active state.
*   `transcript`: Ordered array of turns containing the `message` and optional `receipts`.
*   `attempts`: Array of server-authored lifecycle states (`reserved`, `started`, `completed`, `failed`, `deadman`).
*   `integrity_findings`: Array of malformed, foreign, or forked messages.

### Terminal States (Fail-Closed Precedence)
Derived status evaluates in strict order. Terminal states never reopen.

| Precedence | Status | Condition |
| :--- | :--- | :--- |
| 1 | `invalid` | Malformed root, fork, duplicate ordinal, or contradictory receipts. |
| 2 | `closed` | A valid reply explicitly set `close: true`. |
| 3 | `deadman` | An authorized attempt exceeded its turn deadline. |
| 4 | `expired` | The immutable conversation deadline passed. |
| 5 | `exhausted` | The `max_turns` budget is fully consumed. |
| 6 | `active` | Exactly one unexpired attempt is reserved or started. |
| 7 | `open` | No active attempts, but budget and time remain. |

## Limits and Guarantees

*   **Two Agents Only:** Discussions are strictly peer-to-peer. Broadcast or group discussions are rejected.
*   **64KiB Envelope:** The *entire* serialized JSON envelope (including metadata, not just the `body`) must not exceed 65,536 UTF-8 bytes. Validation occurs before transaction entry.
*   **No Automatic Retries:** Failed spawns, child exits without a reply, and deadman kills consume their turn budget. The system never automatically retries a failed or killed turn.
*   **Stranded-Attempt Sweeper:** A periodic server loop (`sweepStranded`) runs every 30 seconds by default and terminalizes any `reserved`/`started` attempt past its recorded deadline as `deadman` — killing the child if this server process spawned it — so a crashed owner or dead child can never leave a turn live forever. Configure the interval with `MESHFLEET_DISCUSSION_SWEEP_MS` (0 disables the loop).
*   **Budgets Charged at Reservation:** Turn allocation and budget validation occur atomically at reservation. A failed or deadman attempt consumes its turn even if it produces no transcript message.
*   **Hourly Wake Quota:** Agents are subject to a strict hourly limit on wake reservations to prevent runaway compute loops.
*   **Global Kill-Switch:** Operators can halt all discussion processing globally via an administrative kill-switch.
*   **Exactly-Once Escalation Receipt:** Emitted on unresolved exhaustion to guarantee a single, ledgered handoff event.
*   **Local-Trust Receipts:** Lifecycle receipts record **who-recorded-seen**, not **who-read**. They record who was authorized to run, when the server recorded the run's start and end, and which reply was produced. The system trusts caller-supplied agent IDs and does not provide strong cryptographic caller authentication.
