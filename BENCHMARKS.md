# Benchmarks

Generated: 2026-07-16T16:34:44.371Z

## Results

| Operation | p50 (ms) | p95 (ms) | p99 (ms) |
|---|---:|---:|---:|
| `routeWork(roster=10)` | 0.04 | 0.08 | 0.20 |
| `routeWork(roster=100)` | 0.20 | 0.27 | 0.40 |
| `routeWork(roster=1000)` | 1.61 | 1.83 | 2.17 |
| `sendMessage (warm)` | 0.10 | 0.12 | 0.71 |
| `saveData (1k agents, 10k msgs)` | 9.79 | 10.19 | 10.30 |
| `loadData (1k agents, 10k msgs)` | 4.46 | 5.32 | 5.39 |
| `getInbox (10k msgs)` | 4.49 | 5.15 | 5.15 |
| `spawn bookkeeping (registerAgentInLedger)` | 0.08 | 0.10 | 0.22 |
| `sendMessage × 10000 (bulk)` | 0.533 | — | 5328.1 (total) |
| `send_messages × 10 batches of 1000` | 0.005 | — | 52.6 (total) |

## v1.0 perf gates

- [x] **10k messages on a single fleet with no dropped events** — see `sendMessage × 10000`
- [x] **Sub-100ms bookkeeping overhead per agent spawn** — see `spawn bookkeeping (registerAgentInLedger)`

