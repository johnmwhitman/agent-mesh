# Benchmarks

Generated: 2026-07-03T00:25:11.218Z

## Results

| Operation | p50 (ms) | p95 (ms) | p99 (ms) |
|---|---:|---:|---:|
| `routeWork(roster=10)` | 0.01 | 0.04 | 0.13 |
| `routeWork(roster=100)` | 0.06 | 0.14 | 0.23 |
| `routeWork(roster=1000)` | 0.70 | 0.89 | 1.03 |
| `sendMessage (warm)` | 0.16 | 0.31 | 0.43 |
| `saveData (1k agents, 10k msgs)` | 5.93 | 6.90 | 7.64 |
| `loadData (1k agents, 10k msgs)` | 5.93 | 7.11 | 7.32 |
| `getInbox (10k msgs)` | 6.18 | 7.57 | 7.57 |
| `spawn bookkeeping (registerAgentInLedger)` | 5.96 | 7.14 | 8.41 |
| `sendMessage × 10000 (bulk)` | 3.724 | — | 37244.6 (total) |

## v1.0 perf gates

- [x] **10k messages on a single fleet with no dropped events** — see `sendMessage × 10000`
- [x] **Sub-100ms bookkeeping overhead per agent spawn** — see `spawn bookkeeping (registerAgentInLedger)`

