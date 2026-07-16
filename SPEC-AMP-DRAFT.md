# DRAFT: Agent Mesh Protocol (AMP) v0.1

> **Status**: DRAFT — nothing here is implemented or frozen; this documents the wire format a
> future cross-runtime implementation must speak. Semantics are extracted from the shipped
> agent-mesh behavior (AGENT-MESH-SPEC.md, SPEC-P2P.md, SPEC-COUNCILS.md); where this draft and
> shipped code disagree, the code wins.
> **Version**: 0.1.0-draft · **Date**: 2026-07-16 · **Project**: Meshfleet / agent-mesh

---

## 1. Introduction

The **Agent Mesh Protocol (AMP)** is a transport-agnostic wire format designed for cross-runtime agent coordination. While initial iterations of the Agent Mesh engine relied on Model Context Protocol (MCP) tool calls over standard input/output, AMP decouples coordination logic from the underlying transport. It allows agents to communicate, hand off work, request help, and ratify proposals across different runtimes, processes, and network boundaries.

This specification defines the envelope format, identity/addressing schemes, receipt delivery semantics, and conformance requirements for AMP v0.1.

---

## 2. Design Principles

- **Transport-Agnostic**: Messages must be serializable to UTF-8 JSON. They can be transmitted over HTTP POST, Unix pipes (stdin/stdout), WebSockets, SSE, or message brokers (e.g., RabbitMQ, gRPC) without modification.
- **Self-Describing**: Every transmission envelope contains sufficient version and type metadata to be routed and processed without out-of-band context.
- **Audit-First**: Communication status is derived from a persistent trail of discrete, idempotent receipt events rather than mutable status fields.

---

## 3. Identity and Addressing

### 3.1 Fleet Scoping
All AMP communication occurs within the context of a **Fleet**. 
- A Fleet is identified by a globally unique string `fleet_id` (typically a UUIDv4).
- Agents, messages, and receipts must carry a matching `fleet_id`. Cross-fleet message routing is forbidden in v0.1.

### 3.2 Agent Identity
- Each agent in a fleet is identified by an `agent_id` string that is unique within that `fleet_id`.
- The format of `agent_id` is arbitrary but must be a valid UTF-8 string without whitespace.

### 3.3 Addressing Modes
AMP supports two addressing modes via the `to_agent_id` field:
1. **Directed (Point-to-Point)**: `to_agent_id` is set to a specific agent's unique ID.
2. **Broadcast**: `to_agent_id` is set to the wildcard string `*`. A broadcast message is addressed to all active agents within the fleet (excluding the sender).

---

## 4. Envelope Format

Every AMP transmission is a JSON object. All top-level fields defined below are mandatory.

### 4.1 Base Envelope
```json
{
  "amp_version": "0.1",
  "type": "message" | "receipt",
  "id": "string",
  "fleet_id": "string",
  "timestamp": 1721112345678
}
```

- `amp_version`: The string `"0.1"`.
- `type`: Discriminated union indicating if the payload is a `message` or a `receipt`.
- `id`: A unique identifier (UUIDv4 recommended) for this specific envelope instance.
- `fleet_id`: The identifier of the fleet context.
- `timestamp`: Epoch milliseconds when the envelope was created.

---

## 5. Message Envelope

When `type` is `"message"`, the envelope must include the following additional fields:

```json
{
  "amp_version": "0.1",
  "type": "message",
  "id": "msg-98765-uuid",
  "fleet_id": "fleet-12345-uuid",
  "timestamp": 1721112345678,
  "from_agent_id": "explore-agent-01",
  "to_agent_id": "oracle-agent-02",
  "correlation_id": "msg-88888-uuid",
  "message_type": "handoff" | "question" | "result" | "alert" | "request_help",
  "payload": "string (opaque, <= 64 KiB)"
}
```

- `from_agent_id`: The ID of the sending agent.
- `to_agent_id`: The ID of the recipient agent, or `*` for broadcast.
- `correlation_id` (optional): Reference to a prior message ID to track conversation threads.
- `message_type`: One of the five canonical message types (`handoff`, `question`, `result`,
  `alert`, `request_help`). The type routes attention; it does not constrain the payload.
- `payload`: An **opaque UTF-8 string**, maximum **65536 bytes (64 KiB)**. This matches the
  shipped ledger exactly — the payload is NOT structured JSON at the protocol level. Senders
  MAY serialize JSON into it by convention; receivers MUST NOT assume they can parse it.
  Large context transfers should reference files/URIs rather than inline content.

---

## 6. Receipt Envelope (Witnessed Messaging)

When `type` is `"receipt"`, the envelope documents an action taken by an agent regarding a message.

```json
{
  "amp_version": "0.1",
  "type": "receipt",
  "id": "rcpt-54321-uuid",
  "fleet_id": "fleet-12345-uuid",
  "timestamp": 1721112346999,
  "message_id": "msg-98765-uuid",
  "agent_id": "oracle-agent-02",
  "action": "ack" | "seen" | "r-ack" | "r-decline" | "retracted" | "string",
  "note": "string"
}
```

- `message_id`: The ID of the message this receipt references.
- `agent_id`: The ID of the agent generating the receipt.
- `action`: The action being documented.
- `note` (optional): Free-form string containing annotations or rationale.

### 6.1 Receipt Semantics

AMP enforces two distinct classes of receipts:

| Class | Primary Action | Behavior |
|---|---|---|
| **Consuming** | `ack` | Removes the referenced message from the agent's active inbox. |
| **Non-Consuming** | `seen`, `r-ack`, `r-decline`, `retracted` | Annotates the message trail. The message remains in the inbox. |

#### 6.1.1 Idempotency Key
To prevent duplicate state transitions under network retries, implementations must enforce a unique composite constraint key:
```
idempotency_key = message_id + ":" + agent_id + ":" + action
```
Subsequent receipts matching an existing key must be ignored or treated as idempotent success.

#### 6.1.2 Broadcast Resolution
When a message is broadcast (`to_agent_id: "*"`), it is resolved to the agents REGISTERED in the fleet at the time of sending (excluding the sender), and that captured recipient list is frozen with the message. The message is considered fully acknowledged only when a consuming `ack` receipt has been recorded from **every** resolved recipient agent.

---

## 7. Council Ratification (Votes)

Councils leverage standard receipt mechanics to achieve multi-agent consensus.

### 7.1 Proposal Broadcast
A proposal is initialized by broadcasting a message (`to_agent_id: "*"`) with the `question` type. The `message_id` of this broadcast acts as the **Ratification ID**.

### 7.2 Casting Votes
Agents vote by emitting non-consuming receipts pointing to the Ratification ID:
- **Approve**: A receipt with `action: "r-ack"`.
- **Reject**: A receipt with `action: "r-decline"`.

### 7.3 Tallying
A proposal's state is computed by tallying the votes for the Ratification ID. The outcome transitions to a terminal state based on:
1. **Quorum**: Minimum number of `r-ack` receipts required.
2. **Required Sign-offs**: Specific `agent_id`s whose `r-ack` is mandatory.
3. **Silence Policy**: Treatment of non-voters after a deadline:
   - `abstain`: Non-votes are ignored.
   - `approve`: Non-votes count as `r-ack` (silent = PASS).
4. **Weights** (tiered councils): optional per-voter positive-integer weights; unlisted voters
   weigh 1 and quorum is a weight threshold. Weight never satisfies a required sign-off.

The ratification CONFIG (quorum, voters, sign-offs, deadline, silence policy, weights) is
coordination-layer state established at open time; only the proposal message and the vote
receipts travel on the wire. How config is shared between runtimes is out of scope for v0.1.

---

## 8. Minimal Conformance Checklist

To be certified as AMP v0.1 compliant, an implementation must pass the following test assertions:

- [ ] **Schema Validation**: Correctly parses and validates all base, message, and receipt envelope structures. Rejects envelopes missing required fields or containing mismatched `amp_version` levels.
- [ ] **Uniqueness Enforcement**: Enforces the `message_id:agent_id:action` idempotency key for receipts, rejecting duplicates.
- [ ] **Inbox Segregation**: Correctly filters incoming messages so that an agent only sees messages directed to its specific `agent_id` or broadcasted to `*` (matching the active `fleet_id`).
- [ ] **Consumption Isolation**: Verifies that a consuming `ack` receipt removes the target message from the agent's inbox, whereas a non-consuming receipt (e.g., `seen`, `r-ack`) leaves it in the inbox.
- [ ] **Broadcast Accounting**: Tracks receipt status per agent for broadcast messages, ensuring they are only marked complete when all targets emit `ack` receipts.

---

## 9. Non-Goals for v0.1

The following capabilities are explicitly excluded from v0.1 of this specification:

- **Security & Encryption**: No transport-level encryption, TLS, payload signing (HMAC, JWT, etc.), or asymmetric encryption is specified. In v0.1, the network layer is assumed to be trusted.
- **Transport & Routing Specs**: AMP does not mandate network routes, port numbers, keep-alive heartbeats, or socket configurations.
- **Discovery & Broker Setup**: Mechanisms for agents to find each other, register with brokers, or map IP addresses are out of scope. Runtimes must configure routing topologies out-of-band.
- **Priority Queuing**: No message priority or out-of-band urgent channels are defined.
