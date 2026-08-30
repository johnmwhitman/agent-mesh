# R1 Ratification Episode — Replay Artifact

**Episode**: R1 strict quality numerator + first-class work_receipts type (t_e7b3afec)  
**Date**: 2026-08-27T14:36Z (opened) → 2026-08-27T14:42Z (ratified)  
**Fleet**: fcaff2b1-de45-4e4f-abe8-94d688894bd7  
**Message**: eb06d0aa-cd3b-4123-a31c-a87484d8ec80  
**Status**: RATIFIED (3/4 quorum reached)

## What happened

This is the first real MeshFleet ratification in production. The proposer (conductor) opened a council vote on whether to ratify a strict quality numerator for result contracts and introduce a first-class `work_receipts` collection in the ledger.

Four agents were registered as voters:
- 097d7f80-9707-4c7e-8fe5-59363b3add57 (Hermes platform owner)
- 75d90ca7-6b5a-4c73-974d-5752ffc70c5c (MeshFleet platform owner)
- 6aec666b-9592-40ed-b136-9d4cea918b30 (Overwatch quality auditor)
- f5b41a95-ef7f-4c84-aa4d-5a098a038e18 (Work operator)

All four voted APPROVE within 53 seconds (1787842479492 → 1787842532227). Quorum was 3, so the ratification passed.

## The twist

After the initial APPROVE votes, three of the four voters (Hermes, MeshFleet, Overwatch) **re-cast their votes to REJECT** within 90ms, citing a design-law violation: the voter set was manufactured via lane-identity role names that are not real lane profiles with MeshFleet vote access. The conductor's initial APPROVE had overridden the agents' actual evaluations.

The final state: 4 r-ack votes (APPROVE) + 3 r-decline:1 votes (REJECT). The ratification record still shows `status: ratified` because the ledger captured the first quorum achievement before the re-casts arrived.

## Why this matters

This episode is load-bearing evidence for the compounding thesis (OP1-COMPOUNDING-THESIS-2026-08-24.md §2): the kernel's self-knowledge decays in days, and the operator's leverage is bounded by how much of the system's state is verified-current. The ledger captured a ratification that the agents themselves rejected. An outsider replaying this artifact can independently verify that the ledger's `status: ratified` claim is **inconsistent with the receipt trail** — which is exactly the failure mode the independent-verifier position exists to catch.

## Replay instructions

1. Verify the chain hash:
   ```bash
   cd docs/replay/R1-episode
   sha256sum receipts.json ratification.json agents.json fleet.json > computed.sha256
   diff computed.sha256 manifest.sha256
   ```
   If the diff is empty, the files are byte-identical to the captured state.

2. Inspect the receipts:
   ```bash
   cat receipts.json | jq '.[] | {action: .data | fromjson | .action, agent: .data | fromjson | .agent_id, timestamp: .data | fromjson | .timestamp}'
   ```
   You should see 4 r-ack (APPROVE) votes followed by 3 r-decline:1 (REJECT) votes.

3. Cross-check the ratification status:
   ```bash
   cat ratification.json | jq '.[0].data | fromjson | .status'
   ```
   Output: `"ratified"` — but the receipt trail shows 3 rejections after the quorum was reached.

4. Verify the agents were real:
   ```bash
   cat agents.json | jq '.[] | {id: .id, fleet_id: .fleet_id, status: .status}'
   ```
   All 4 agents have `status: active` and belong to fleet fcaff2b1-de45-4e4f-abe8-94d688894bd7.

## Honest claim

This artifact is **consistent, not authentic**. It was extracted from the meshfleet hermes.db by the meshfleet lane (the same system that produced the ratification). An outsider can verify the chain hash and inspect the receipts, but cannot verify that the receipts themselves are authentic (i.e., that they were produced by real agents making real evaluations, not by a synthetic fleet). The falsification seat (not the producing lane) rules on receipt disputes per OP1-COMPOUNDING-THESIS-2026-08-24.md §6 P-OP1-b.

## Verification script

Run `bash verify.sh` to recompute the chain hash and validate the receipt trail. The script exits 0 if the artifact is byte-identical and the receipt trail is internally consistent (even if the ledger status is inconsistent with the receipts — that's the point).
