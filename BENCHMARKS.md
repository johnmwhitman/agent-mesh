# Benchmarks

Generated: 2026-07-16T16:30:41.974Z

## Results

| Operation | p50 (ms) | p95 (ms) | p99 (ms) |
|---|---:|---:|---:|
| `routeWork(roster=10)` | 0.04 | 0.12 | 0.25 |
| `routeWork(roster=100)` | 0.21 | 0.34 | 0.53 |
| `routeWork(roster=1000)` | 1.81 | 2.17 | 2.36 |
| `sendMessage (warm)` | 0.10 | 0.16 | 0.79 |
| `saveData (1k agents, 10k msgs)` | 11.45 | 12.43 | 13.05 |
| `loadData (1k agents, 10k msgs)` | 5.61 | 6.79 | 7.12 |
| `getInbox (10k msgs)` | 5.54 | 6.89 | 6.89 |
| `spawn bookkeeping (registerAgentInLedger)` | 0.08 | 0.10 | 0.21 |
| `sendMessage × 10000 (bulk)` | 0.579 | — | 5793.0 (total) |

## v1.0 perf gates

- [x] **10k messages on a single fleet with no dropped events** — see `sendMessage × 10000`
- [x] **Sub-100ms bookkeeping overhead per agent spawn** — see `spawn bookkeeping (registerAgentInLedger)`

