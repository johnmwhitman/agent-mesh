# Councils — quorum ratification (v0.10)

Multi-agent systems make decisions no single agent should make alone: adopting a
convention, promoting a tool to "always use it," approving an irreversible action.
Councils let a fleet **ratify a proposal by vote** — and, because votes are receipts
(see SPEC-P2P.md), the outcome carries a full audit trail: who approved, who
declined, who never answered, and when it resolved.

## Lineage

The mechanics are generalized from a governance framework ("HOOL") that ran a
10-agent fleet in production: peers ratified constitutional amendments by a **6/9
quorum**, certain canon-level changes additionally required a named **T5 sign-off**
(the human), proposals carried a **24h SLA**, and a peer who stayed silent past
the SLA counted as assent ("silent = PASS"). Those four ideas map to the four
knobs below.

## Model

A **ratification** is a proposal broadcast to a set of eligible voters, plus a
tally over their vote receipts.

- **Proposal** — a broadcast message (`send_message` to `"*"`). Its `message_id`
  is the ratification id.
- **Vote** — an `r-ack` (approve) or `r-decline` (reject) receipt on the proposal.
  Voting is just `writeReceipt`; nothing new is stored per vote.
- **Quorum** — number of approvals required to ratify.
- **Required signoffs** — agents whose approval is mandatory *regardless of
  quorum* (the "T5" generalization). A required signoff who declines rejects the
  proposal outright.
- **Deadline + silence policy** — optional SLA. Once it passes, non-voters are
  counted per `silence_policy`: `abstain` (default) or `approve` ("silent = PASS").
  Silence never satisfies a required signoff — those must be explicit.

## Resolution

Evaluated live by `tally_ratification`; the first terminal state reached is
persisted and never flips afterward:

- **rejected** — a required signoff declined, or quorum became arithmetically
  unreachable (too many declines).
- **ratified** — approvals ≥ quorum *and* every required signoff approved.
- **expired** — deadline passed, neither ratified nor rejected (only when
  `silence_policy: abstain`).
- **open** — otherwise.

## MCP tools

```typescript
open_ratification(
  proposer: string,
  fleet_id: string,
  subject: string,
  quorum: number,
  payload?: string,
  voters?: string[],            // default: every other agent in the fleet
  required_signoffs?: string[], // must be a subset of voters
  deadline?: number,            // epoch ms
  silence_policy?: "abstain" | "approve"
) → { message_id, tally }

cast_vote(
  agent_id: string,
  message_id: string,
  approve: boolean,
  note?: string
) → { ok, status, tally }

tally_ratification(
  message_id: string
) → { status, tally }   // also persists a terminal status
```

`tally` reports `{ status, quorum, approvals[], declines[], pending[],
required_signoffs[], signoffs_met, reachable }`.

## Example — adopt a convention by 6/9, human signs off

```typescript
const id = open_ratification({
  proposer: "orchestrator",
  fleet_id: "f1",
  subject: "Adopt: all agents ack within 5 minutes",
  quorum: 6,
  required_signoffs: ["human"],   // the T5 lane
  deadline: Date.now() + 24*3600*1000,
  silence_policy: "approve",       // silent = PASS after 24h
});
// peers: cast_vote(peer, id, true)
// human: cast_vote("human", id, true)   // mandatory
// after the deadline, tally_ratification(id) → "ratified"
```

## Deadline sweeping (v0.11)

The server sweeps every open ratification on an interval
(`AGENT_MESH_RATIFY_SWEEP_MS`, default 60s, `0` disables), persisting any that
reached a terminal state and appending a `ratification_resolved` event. So
deadlines and "silent = PASS" fire on their own; `sweep_ratifications` forces a
sweep on demand, and `tally_ratification` still evaluates a single proposal.

## Not in scope yet

- ~~No tiered councils (HOOL's Council 1/2/3)~~ / ~~No vote weighting — one agent, one vote.~~
  SUPERSEDED: `open_ratification` accepts an optional `weights` map of per-voter positive
  integers (unlisted voters weigh 1), and the tally sums weights rather than counting heads.
  The weight sum is capped to block overflow games. Omit `weights` for one-agent-one-vote.
