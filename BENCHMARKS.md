# Benchmarks

Generated: 2026-07-02T22:37:08.128Z

## Results

| Operation | p50 (ms) | p95 (ms) | p99 (ms) |
|---|---:|---:|---:|
| `routeWork(roster=10)` | 0.01 | 0.03 | 0.09 |
| `routeWork(roster=100)` | 0.06 | 0.13 | 0.22 |
| `routeWork(roster=1000)` | 0.73 | 0.90 | 1.19 |
| `sendMessage (warm)` | 0.15 | 0.31 | 0.41 |
| `saveData (1k agents, 10k msgs)` | 6.74 | 8.10 | 8.56 |
| `loadData (1k agents, 10k msgs)` | 6.77 | 8.07 | 8.46 |
| `getInbox (10k msgs)` | 6.65 | 7.52 | 7.52 |
| `spawn bookkeeping (registerAgentInLedger)` | 6.41 | 8.06 | 9.01 |
| `sendMessage × 10000 (bulk)` | 3.884 | — | 38835.9 (total) |

## v1.0 perf gates

- [x] **10k messages on a single fleet with no dropped events** — see `sendMessage × 10000`
- [x] **Sub-100ms bookkeeping overhead per agent spawn** — see `spawn bookkeeping (registerAgentInLedger)`

