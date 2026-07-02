# Benchmarks

Generated: 2026-07-02T23:03:09.041Z

## Results

| Operation | p50 (ms) | p95 (ms) | p99 (ms) |
|---|---:|---:|---:|
| `routeWork(roster=10)` | 0.01 | 0.03 | 0.09 |
| `routeWork(roster=100)` | 0.06 | 0.12 | 0.17 |
| `routeWork(roster=1000)` | 0.70 | 0.91 | 1.14 |
| `sendMessage (warm)` | 0.16 | 0.31 | 0.38 |
| `saveData (1k agents, 10k msgs)` | 5.59 | 6.63 | 8.26 |
| `loadData (1k agents, 10k msgs)` | 5.63 | 6.62 | 7.24 |
| `getInbox (10k msgs)` | 6.24 | 6.97 | 6.97 |
| `spawn bookkeeping (registerAgentInLedger)` | 5.67 | 7.00 | 8.80 |
| `sendMessage × 10000 (bulk)` | 3.598 | — | 35981.0 (total) |

## v1.0 perf gates

- [x] **10k messages on a single fleet with no dropped events** — see `sendMessage × 10000`
- [x] **Sub-100ms bookkeeping overhead per agent spawn** — see `spawn bookkeeping (registerAgentInLedger)`

