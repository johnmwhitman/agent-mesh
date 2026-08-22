# Fleet Bus v2 — durable scalable A2A event backbone (2026-08-21)

**One sentence:** Fleet Bus v2 keeps the v1 append-only SQLite contract and adds a
host-aware, append-only event backbone (topics + durable subscriptions, ack/retry/
dead-letter, causal correlation, schema/versioning, signed export, replay) so the
same `bus_send`/`bus_read`/`bus_ack` tool surface can scale from one Mac to multiple
hosts **without** introducing a resident process before explicit approval — the
single-host SQLite path remains the v2 reference deployment.

**Scope of this document:** design only. The live bus at
`${FLEET_BUS_HOME}/fleet-bus.db` (v1) and the v1 plugin
(`${FLEET_BUS_PLUGINS}/fleet-bus/`) are NOT replaced, mutated, or migrated
by this design. The actual paths live in another repo (operator's
deployment) and are configured via environment when the v2 runtime
lands; v2 ships when John approves a multi-host rollout.

**Status:** v2 PROPOSED — design complete, no runtime deployed, no ledger
migration, no gateway changes. The doc is the contract for the next slice.

---

## 0. Relationship to v1

| | v1 (live today) | v2 (this document) |
|---|---|---|
| Store | one SQLite file | one SQLite file per host + optional JetStream/Postgres overlay |
| Topics | implicit via `to_agent` (`all` = broadcast) | explicit `topic` column + topic subscriptions |
| Subscriptions | `subscriptions` table reserved, unused | first-class; consumer commits a `last_seen_offset` per (agent, topic) |
| Delivery | best-effort, 2-min mirror cron | at-least-once + ack + retry + dead-letter |
| Correlation | `correlation_id` mirrored from meshfleet ledger only | first-class `correlation_id` + causal parent chain |
| Schema migration | manual | `schema_version` + ordered `migrations` table + dry-run tool |
| Auth / redaction | redact at write boundary (Hermes redactor + A2A shapes) | redact at write boundary + per-host writer key + signed event hashes |
| Retention | weekly prune, 30d / 90d for unacked peer mail | same baseline + per-topic TTL + immutable export for book archives |
| Multi-host | none | host-tagged events + per-host watermarks; no shared writer |
| Resident process | none (cron + plugins + ad-hoc sqlite3) | none by default; optional NATS JetStream / Postgres only on approval |
| Live deployment | one Mac, 1,106+ rows as of 2026-08-17 | none — v2 ships when John approves |

The v1 store file (`fleet-bus.db`) IS the v2 reference single-host deployment. No
data loss: every v1 row is a valid v2 row (v2 only adds nullable columns and a new
`topic` index).

---

## 1. Goals (this is what v2 must deliver)

1. **Append-only event model.** Every row is an immutable event; "upsert" is
   "append OR ignore on (source, source_id)". No UPDATE of `subject/body/evidence`.
2. **Stable, globally unique IDs.** `(source_kind, source, source_id)` is the
   idempotency key; the global event id is `host_id:source:source_id` for
   multi-host replay; local rowid stays the SQLite PK.
3. **Topics and durable subscriptions.** A consumer registers `(agent, topic)`;
   the bus remembers the consumer's `last_seen_offset` and replays missed events
   on connect, including across restarts.
4. **At-least-once delivery with ack, retry, and dead-letter.** A consumer NACKs
   (or does not ack within `ack_deadline_s`) → event is re-delivered up to
   `max_redeliveries`; then it lands in `dead_letter` for human/operator review.
5. **Causal correlation and reply threading.** `correlation_id` and a new
   `causation_id` carry the parent/child chain; `replies_to` is a derived view
   that orders the thread by `issued_at_ms`.
6. **Schema and version migration.** `meta.schema_version` + ordered `migrations`
   table; `busdb.migrate(db, from_v, to_v)` is pure (idempotent), dry-runnable,
   and reversible per step.
7. **Redaction + writer authentication.** Redact at the write boundary (v1 rule
   preserved) + a per-host writer key (HMAC of `host_id + source + ts + sha256(body)`)
   stored in `event_sig`; consumers verify on read and on export.
8. **Retention + immutable export.** Per-topic TTL; a separate `book_export.py`
   writes a content-hashed, append-only `book-YYYY-MM-DD.ndjson` segment that
   never references unacked mail until ack_ts is set.
9. **Observability and replay.** `bus_stats` returns per-topic lag, oldest
   unacked offset, dead-letter count, host histogram; `bus_replay(host, topic,
   since)` re-emits an event range to a new recipient (used for handoff after a
   consumer crash, not for re-writing history).
10. **Single-host SQLite compatibility.** The single-host SQLite path IS the v2
    reference deployment — same `busdb.py` CLI, same plugin, same Wikidata
    mirror, same retention — only the schema is widened.
11. **Optional durable multi-host backend.** A pluggable `Backend` interface
    abstracts SQLite (default), NATS JetStream, and Postgres + logical
    replication. The interface is the contract; the implementations are not
    shipped in this slice.

---

## 2. Non-goals (explicitly out of scope for v2)

- **A resident process.** No `fleet-bus-daemon`, no systemd unit, no launchd
  plist beyond the existing `fleet-bus-mirror-2m` cron. SQLite + plugins +
  cron + ad-hoc CLI is the entire runtime.
- **A remote public bus.** Multi-host in this doc means a small number of
  operator-controlled Macs over a tailnet or WireGuard; not a public service.
- **Cross-host authentication of agent identity.** The A2A threat model already
  names this as future work (`docs/A2A-THREAT-MODEL.md` "Spoofed agents and
  receipts"). v2 authenticates the *writer host* (machine identity), not the
  agent that authored the message — that distinction is captured in §7.
- **Schema-less JSON blobs.** `payload` is a typed object (`media_type` +
  body) per `docs/A2A-PROTOCOL-v0.1.md`; the bus does not invent a parallel
  codec.
- **At-most-once or exactly-once semantics.** v2 is at-least-once with
  consumer-side dedupe via `(source, source_id)` and `dedupe_key`.
- **MeshFleet-ledger replacement.** v2 still bridges from `agent-mesh.db`
  `messages` via the existing `bus_mirror.py` cron — read-only, per the v1
  design §1 reason 2.
- **A migration of the live `fleet-bus.db` on this Mac.** v2 ships the
  contract and an opt-in `busdb migrate`; applying it to the live store is a
  John-approved action with a recovery plan (§11).
- **Public canonical-envelope ingress.** Out of scope; this is a bus, not a
  remote A2A API.

---

## 3. Append-only event model

### 3.1 Stores and ordering

Two ordering domains, neither global:

| Domain | Authority | Order | Backing |
|---|---|---|---|
| Per-host | the host that wrote the row | `ts` ascending, then `id` ascending | SQLite `messages.id` (AUTOINCREMENT, single writer per host) |
| Per-topic | derived view | `ts` ascending, then `id` ascending | SQLite index + per-host merge |

Global order across hosts is **not guaranteed** and v2 explicitly does not try
to provide one. v2 consumers either pick a host (the bus is a federation) or
treat events as a set ordered by their own `(host_id, ts)` tuple. This is the
same trade-off NATS and Kafka document for multi-region; we do not pretend
otherwise.

### 3.2 Idempotency

- `UNIQUE(source, source_id)` is preserved from v1.
- `source_id` is the writer's chosen opaque token; for `source_kind=meshfleet`
  it is the ledger `id`, for `a2a_audit` it is `_sid(...)` (sha1 truncated to 24
  hex), for `hermes-cli` it is `from_agent:time.time_ns()` (v1).
- **Cross-host dedupe is realised by the writer encoding host_id into
  source_id** (e.g. `host-A:src-1` vs `host-B:src-1`). The v1 table-level
  `UNIQUE(source, source_id)` is the constraint that prevents duplicates; a
  writer that wants cross-host dedupe MUST emit host-tagged source_ids. This
  is a deliberate, narrow choice: SQLite cannot drop a table-level UNIQUE
  via ALTER, so the v1 constraint stays; v2 adds no parallel unique index
  (it would be redundant). `host_id` is stored on the row as audit metadata.
- Cross-host replay uses `(host_id, source, source_id_with_host_prefix)` as
  the dedupe tuple; importing a replay segment must use `INSERT OR IGNORE`.

### 3.3 What never changes after append

- `ts`, `source_kind`, `source`, `source_id`, `from_agent`, `to_agent`,
  `topic`, `subject`, `body`, `evidence_json`, `correlation_id`,
  `causation_id`, `host_id`, `event_sig`, `payload_media_type`, `payload_body`.
- `ack_ts` is the only mutable column (v1 already had this).
- `subscriptions.last_seen_offset` advances on ack; events are never re-marked.

This is what makes v2 a true *event log* and not a mutable queue.

---

## 4. Topics and subscriptions

### 4.1 Topic grammar

A topic is `kind[:subkind...]` — the same dot-style grammar already used by v1
`kind` (`audit:inbound`, `conv:user`, `event:claimed`, `mesh:handoff`):

```
a2a.audit.inbound
a2a.audit.outbound
a2a.conv.user
a2a.conv.assistant
kanban.event.claimed
kanban.event.completed
kanban.event.blocked
kanban.comment
cron.execution
receipt.session
meshfleet.message.handoff
meshfleet.message.result
meshfleet.message.alert
hermes.session.turn
hermes.session.end
claude.note
hermes-cli.note
bus.dlq.*                 # dead-letter topic namespace
```

### 4.2 Subscription model

```sql
CREATE TABLE subscriptions (
  agent              TEXT    NOT NULL,
  topic              TEXT    NOT NULL,    -- may include trailing * for prefix match
  mode               TEXT    NOT NULL DEFAULT 'at_least_once',  -- at_least_once | at_most_once
  last_seen_offset   INTEGER NOT NULL DEFAULT 0,        -- local rowid watermark per (agent, topic)
  ack_deadline_s     INTEGER NOT NULL DEFAULT 600,
  max_redeliveries   INTEGER NOT NULL DEFAULT 5,
  created_ts         REAL    NOT NULL,
  PRIMARY KEY (agent, topic)
);
CREATE INDEX idx_subs_topic ON subscriptions(topic);
```

- `topic='*'` is allowed for a "show me everything" subscription; `topic='a2a.*'`
  matches the dotted prefix.
- `last_seen_offset` is the local SQLite rowid of the most recent event delivered
  to that consumer for that topic; the consumer advances it on `bus_ack`.
- On consumer start, `bus_read(topic=X, since_rowid=last_seen_offset)` returns
  everything strictly greater than the watermark — same durable-replay semantics
  as a Kafka consumer group, just with SQLite.

### 4.3 v1 compatibility

`to_agent='all'` and `to_agent=<profile>` continue to work: they map to two
implicit subscriptions (`*` and `<profile>`) the plugin opens on first read.
This is the migration story for the existing v1 rows.

---

## 5. Delivery / ack / retry / dead-letter

### 5.1 State machine

```
              append
   producer ─────────► messages ───────► consumer (deliver)
                          │                    │
                          │                    │  ack  (within ack_deadline_s)
                          │                    ▼
                          │              ack_ts set,
                          │              subs.last_seen_offset = id
                          │
                          │  NACK or deadline elapsed
                          ▼
                     delivery_attempts++  (per consumer, not per event)
                          │
                          │  attempts >= max_redeliveries
                          ▼
                      dead_letter
```

### 5.2 New tables

```sql
CREATE TABLE delivery_attempts (
  agent           TEXT    NOT NULL,
  msg_id          INTEGER NOT NULL REFERENCES messages(id),
  attempt_no      INTEGER NOT NULL,
  attempted_at    REAL    NOT NULL,
  outcome         TEXT    NOT NULL,    -- delivered | nack | timeout | error
  next_retry_at   REAL,
  PRIMARY KEY (agent, msg_id, attempt_no)
);
CREATE INDEX idx_deliv_next ON delivery_attempts(agent, next_retry_at);

CREATE TABLE dead_letter (
  msg_id          INTEGER PRIMARY KEY REFERENCES messages(id),
  agent           TEXT    NOT NULL,
  moved_at        REAL    NOT NULL,
  reason          TEXT    NOT NULL    -- 'max_redeliveries' | 'poison' | 'policy'
);
CREATE INDEX idx_dlq_agent ON dead_letter(agent, moved_at);
```

### 5.3 Retry semantics

- `ack_deadline_s`: a delivered event is considered unacked if `ack_ts IS NULL`
  after this many seconds from `attempted_at`.
- Redelivery uses exponential backoff: `min(ack_deadline_s, 2 ** attempt_no)`,
  capped at 1 hour. Stored in `next_retry_at` so the redeliverer (cron or in-process
  sweeper) doesn't have to compute it.
- Poison messages (a redelivery that throws in the consumer's handler) are
  retried; a redelivery that the consumer marks `outcome='poison'` lands in
  `dead_letter` immediately with `reason='poison'`.

### 5.4 Why a sweep is OK without a resident process

- The cron `bus_mirror.py` runs every 2 min on the conductor host. Adding a
  5-second `bus_reaper.py` cron (no-agent, reads `delivery_attempts WHERE
  next_retry_at<=now`) redelivers expired attempts at most every 5 seconds.
  Acceptable for the operator-paced cadence the bus is built for; an
  under-the-second reaper is not in scope.
- A consumer that wants its redeliveries faster can register an in-process
  timer (Hermes `bus` tool already opens a per-profile `bus_tick` loop).

---

## 6. Causal correlation and reply threading

### 6.1 New columns

```sql
ALTER TABLE messages ADD COLUMN correlation_id TEXT;   -- existing mirror; promote to first-class
ALTER TABLE messages ADD COLUMN causation_id   TEXT;    -- the immediate parent event id
ALTER TABLE messages ADD COLUMN reply_chain    TEXT;    -- JSON array of event ids in causal order
CREATE INDEX idx_messages_correlation ON messages(correlation_id, ts);
CREATE INDEX idx_messages_causation   ON messages(causation_id);
```

### 6.2 Conventions

- `correlation_id` is the WORK identifier (a kanban task id, a fleet id, a
  kanban `run_id`, an A2A discussion id). It is set by the first event in a
  workflow and copied unchanged by every descendant.
- `causation_id` is the IMMEDIATE PARENT event id; it forms a linked list per
  `correlation_id`.
- `reply_chain` is a closed-set envelope field per `docs/A2A-PROTOCOL-v0.1.md`:
  it is the ordered array `[root_cause_id, ..., self]` computed once on
  append from the parent's `reply_chain` plus `self`. Stored denormalised so
  consumers do not have to walk the chain.

### 6.3 Mirror mapping

`bus_mirror.py` already extracts `correlation_id` from `meshfleet` rows
(line 265 of the v1 source). v2 adds:

- For `kanban.task_events` rows: `correlation_id = task_id`,
  `causation_id = parent_event_id` (kanban `task_events.payload.parent_event_id`,
  when present; null otherwise).
- For `a2a_audit.jsonl` rows: `correlation_id = task_id`,
  `causation_id = null` (A2A is the root of its thread).
- For `a2a_conversations/*.jsonl` rows: `correlation_id = ctx`,
  `causation_id = previous_line_event_id`.

### 6.4 Reply view

```sql
-- one query: full reply thread for a given correlation_id, oldest first
SELECT * FROM messages
 WHERE correlation_id = ?
 ORDER BY ts ASC, id ASC;
```

A dedicated `bus_thread(correlation_id)` returns the thread plus the
denormalised `reply_chain` for the tail event.

---

## 7. Redaction and authentication

### 7.1 Redaction at the write boundary (preserved)

The v1 `busdb.redact` runs on `subject`, `body`, and `evidence_json` BEFORE
INSERT. v2 keeps this rule verbatim. The Hermes redactor (`agent.redact.
redact_sensitive_text(force=True)`) plus the A2A shape patterns (AKIA, JWT,
bearer, sk-/ghp-/xox…, `api_key|token|secret|password=…`) are the canonical
contract; v2 just moves them into a per-host policy table so they can be tuned
without redeploying the plugin.

### 7.2 Per-host writer key (NEW)

- Each writer host holds a 32-byte random key at `~/.hermes/fleet-bus.hostkey`,
  mode 0600, never on disk in plaintext form recoverable from a backup.
- Every appended event has `host_id` (uuid v4 generated once on first use,
  stored alongside the key) and `event_sig`:
  ```
  event_sig = hmac_sha256(hostkey, host_id || '\x1f' || source || '\x1f'
                                       || source_id || '\x1f'
                                       || ts || '\x1f'
                                       || sha256(subject || '\x1f' || body || '\x1f' || evidence_json))
  ```
- Consumers verify on read; mismatched sigs go to `dead_letter` with
  `reason='policy'` and emit a one-line `bus.warning` row.
- v1 rows (no `event_sig`) are treated as legacy: `host_id='legacy:v1'`,
  `event_sig=null`. A `bus_verify_legacy` tool re-signs them in place (no body
  change, just stamps `event_sig`) ONLY after a John-approved key ceremony.

### 7.3 What the writer key does NOT do

- It does not authenticate the AGENT. A Hermes lane that calls `bus_send`
  appears on the bus as `from_agent=<profile>`, signed by the *host*. v2
  inherits the v1 trust boundary: agents are trusted within the host. The A2A
  threat model already names per-agent authentication as future work; v2 is
  the right substrate for it but not the implementation.
- It does not authenticate consumers. A reader is trusted to read what it
  can reach on disk (v1 rule).

---

## 8. Schema and version migration

```sql
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE migrations (
  seq           INTEGER PRIMARY KEY,    -- monotonically increasing
  name          TEXT    NOT NULL,
  applied_at    REAL    NOT NULL,
  forward_sql   TEXT    NOT NULL,      -- idempotent (CREATE IF NOT EXISTS / ALTER … DEFAULT NULL)
  rollback_sql  TEXT,                   -- nullable when not reversible
  dry_run_ok    INTEGER NOT NULL DEFAULT 1
);
```

### 8.1 Migration runner

```python
def migrate(db: sqlite3.Connection, *, target: Optional[int] = None, dry_run: bool = False) -> List[MigrationRecord]:
    """Idempotent. Returns the list of migrations that would be (or were) applied.

    Order: ascending seq. Skips migrations whose (seq, name) row already exists.
    Each step runs inside BEGIN IMMEDIATE; rollback_sql is recorded but never
    auto-invoked — operators run it explicitly.
    """
```

### 8.2 Versioned reads

```python
def read_messages_v2(con, *, topic=None, since_rowid=None, limit=20, **v1_kwargs):
    """v2 read; if any v1-only kwarg is passed, route through the v1 read path
    and return rows in v2 shape (mapping ack_ts→ack_ts, source→source, ...)."""
```

This is the compatibility wedge: callers upgrading from v1 to v2 read code keep
working as long as they pass v1 kwargs.

### 8.3 v1 → v2 schema delta (this slice)

```sql
-- migrations/0001_v2_widen.sql  (idempotent)
ALTER TABLE messages ADD COLUMN topic             TEXT;
ALTER TABLE messages ADD COLUMN correlation_id    TEXT;
ALTER TABLE messages ADD COLUMN causation_id      TEXT;
ALTER TABLE messages ADD COLUMN reply_chain       TEXT;
ALTER TABLE messages ADD COLUMN host_id           TEXT;
ALTER TABLE messages ADD COLUMN event_sig         TEXT;
ALTER TABLE messages ADD COLUMN payload_media_type TEXT;
ALTER TABLE messages ADD COLUMN payload_body      TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_topic ON messages(topic, ts);
CREATE INDEX IF NOT EXISTS idx_messages_correlation ON messages(correlation_id, ts);
CREATE INDEX IF NOT EXISTS idx_messages_causation   ON messages(causation_id);
-- v2 indexes above. v1's UNIQUE(source, source_id) stays the dedupe rule.
-- Cross-host dedupe is achieved by the writer encoding host_id into source_id
-- (e.g. <host_id>:<original_source_id>); the table-level UNIQUE then blocks
-- duplicates. See §3.2.
INSERT OR IGNORE INTO meta(k, v) VALUES ('schema_version', '2');
```

Every ALTER adds a NULLABLE column or a CREATE-IF-NOT-EXISTS index, so the
migration is safe to run against the live store and against a fresh v1 DB.

---

## 9. Retention and immutable export

### 9.1 Per-topic TTL

```sql
CREATE TABLE retention_policy (
  topic_pattern  TEXT PRIMARY KEY,    -- e.g. 'meshfleet.message.*' or '*'
  keep_days      INTEGER NOT NULL,
  hard_keep      INTEGER NOT NULL DEFAULT 0  -- 1 = never prune (for book/archive topics)
);
INSERT OR IGNORE INTO retention_policy(topic_pattern, keep_days) VALUES
  ('a2a.*', 30),
  ('kanban.*', 90),
  ('receipt.*', 30),
  ('cron.*', 30),
  ('meshfleet.message.*', 365),
  ('hermes.session.end', 365),
  ('claude.*', 90),
  ('hermes-cli.*', 90),
  ('bus.dlq.*', 365);
```

`busdb.maybe_prune()` (v1) is renamed to `busdb.prune_by_policy()` (v2): it
walks `retention_policy`, deletes rows where `ts < now - keep_days*86400 AND
hard_keep = 0`, and skips rows in `dead_letter` (DLQ retention is 365d, never
less). Unacked peer mail (`ack_ts IS NULL AND source_kind IN ('hermes-cli',
'claude')`) survives to the policy `keep_days` OR 90 days, whichever is
greater.

### 9.2 Immutable book export

A separate process, `book_export.py` (cron, no-agent, nightly at 03:15 local):

1. SELECT rows where `ts >= yesterday_start AND ts < today_start AND topic LIKE
   'book.%' OR topic LIKE 'meshfleet.message.*'` (configurable).
2. For each row, verify `event_sig` matches `sha256(subject || body || evidence)`
   using the host key. Mismatches → log to `book_export.errors.jsonl` and skip.
3. Write one append-only `book-YYYY-MM-DD.ndjson` segment per host per day,
   each line being `json.dumps({row_dict, event_sig, host_id})`.
4. Compute the segment's content hash (`sha256` of the file's bytes) and store
   it in `book_segments(host, day, path, sha256, rows, written_at)`.
5. The bus NEVER deletes a row whose event id appears in a `book_segments` row
   — the book segment is the durable archive; the bus is the live view.

This is the immutable export. v2 never overwrites or rotates a segment; the
`book_segments` table is the index for "where is event X archived?".

### 9.3 Book archive topics

`topic LIKE 'book.%'` is a marker: producers can address an event to the book
archive by setting `topic='book.<category>'`. `meshfleet.message.*` is in the
default archive policy because the legacy meshfleet ledger is the audit
backbone. Other topics opt in by being added to the export config.

---

## 10. Observability

### 10.1 `bus_stats` (v2 shape, superset of v1)

```json
{
  "schema_version": "2",
  "total": 1106,
  "by_source_kind": {"a2a": 355, "kanban": 519, "receipt": 227,
                     "hermes-session": 4, "hermes-cli": 1, "cron": 0,
                     "meshfleet": 0},
  "by_topic_top20": {"a2a.audit.inbound": 240, ...},
  "oldest_unacked": {"agent": "conductor", "topic": "kanban.event.blocked",
                     "msg_id": 1023, "age_s": 412},
  "dead_letter": 7,
  "per_topic_lag": {"kanban.event.claimed": 12, "a2a.audit.outbound": 0, ...},
  "host_histogram": {"this-host": 1106},
  "last_prune": "2026-08-17T00:30:00Z"
}
```

### 10.2 `bus_replay(host=None, topic, since_rowid, until_rowid=None, to_agent)`

Re-emits a contiguous event range to a NEW `to_agent` (default: same as original
recipient). Used for:

- Consumer crash recovery (`bus_replay(topic='a2a.audit.*', since_rowid=last_seen_offset-1, to_agent='meshfleet')`).
- Operator-driven incident review (`bus_replay(host=host_id, topic='bus.dlq.*', since=...)`).

Replay NEVER mutates the source rows; it appends NEW events with
`correlation_id` set to the source's `correlation_id`, `causation_id` set to
the source `id`, and `kind='replay'`. The downstream consumer can dedupe via
its own `dedupe_key` (carried verbatim).

### 10.3 Dashboards

- `bus_lag_dashboard.py` (cron, no-agent, every 15 min) writes one JSON file
  per tick summarising per-topic lag and oldest-unacked. MeshFleet's existing
  `cron/output/<job_id>/` log is the persistence.
- `bus_dlq_dashboard.py` (cron, no-agent, every 15 min) summarises the dead
  letter table.

Both are read-only and never touch the bus.

---

## 11. Migration path (this is the plan, not the act)

### 11.1 Stage A — contracts and offline prototype (this design slice)

This slice. No live store mutation, no gateway change, no credential change.
Deliverables:

1. `docs/FLEET-BUS-V2-DESIGN.md` (this doc).
2. `test/fleet-bus-v2-contract.test.ts` (TypeScript contract tests against an
   in-memory SQLite, exercising the v2 schema delta and idempotency). File
   added; does not import the live `busdb.py` (that's a runtime file in a
   different repo); tests the SQLite schema only. Picked up by the existing
   `node scripts/run-tests.mjs` runner (root `test/` is a registered
   `TEST_ROOT`).
3. `scripts/fleet-bus-v2-migrate.mjs` (Node, stdlib SQLite). Runs the migration
   runner against a copy of the live store under `/tmp/`, verifies the
   `meta.schema_version` bump, the new columns, and idempotency.

### 11.2 Stage B — opt-in apply on this Mac (NOT in this slice)

Out of scope until John approves. Plan:

1. Snapshot `fleet-bus.db` and `fleet-bus.db-wal` to
   `${FLEET_BUS_HOME}/archives/fleet-bus-v1-pre-migrate-YYYYMMDD-HHMM/`.
2. Run `busdb.migrate(dry_run=True)` against the snapshot; verify row counts
   pre/post match (ALTER ADD COLUMN cannot lose rows; we test that).
3. Run `busdb.migrate(dry_run=False)` against the live store during a 5-minute
   window where the mirror cron is paused (single-flight lock held).
4. Re-start the mirror cron; verify first fire appends 0 rows (everything is
   already there) and `bus_stats` schema_version=2.
5. Re-issue all 11 profile `fleet-bus` plugin configs (or let the plugin
   self-discover the v2 columns — it should because v1 reads are still valid).

### 11.3 Stage C — multi-host backend (NOT in this slice)

Out of scope until John approves. Plan:

1. Pick a backend: NATS JetStream (operator preference — already familiar to
   the MeshFleet operator, embedded-friendly) or Postgres + logical
   replication (heavier, more familiar to sysadmins). Decision deferred.
2. Implement the `Backend` interface (a Python ABC with
   `append/append_many/read/ack/begin_topic/replay`); both SQLite and the
   chosen backend satisfy it.
3. Cross-host replay uses `INSERT OR IGNORE` on `(host_id, source, source_id)`
   into the local SQLite, with the event_sig verified first. Same trust
   boundary as v1's `bus_mirror.py`.

---

## 12. Threat model

Inherits `docs/A2A-THREAT-MODEL.md` Zone 0–5. v2 changes:

| Threat | v1 | v2 control |
|---|---|---|
| Tampered `subject`/`body` after append | only `ack_ts` mutable | same; plus `event_sig` detects tamper on read |
| Cross-host replay of stale events | none | `(host_id, source, source_id)` dedupe; replay requires writer key |
| Credential leakage | redact at write boundary (Hermes + A2A shapes) | same redact; per-host policy table for tuning |
| Poison message loops a consumer | cron mirror kept moving | DLQ + `max_redeliveries` cap + per-topic TTL |
| Operator impersonation via shared host | local user trust | writer-key HMAC; legacy v1 rows flagged for re-sign |
| DLQ bloat | retention is global 30/90 days | per-topic retention + DLQ is 365d, visible in `bus_stats` |
| Bus traffic triggers agent runs | "peer request, not authority" guidance (pre_llm_call hook) | same guidance, plus `kind='replay'` is explicitly marked non-actionable in the plugin |
| Cross-zone capability poisoning | out of bus scope (meshfleet responsibility) | bus adds no new capability path |
| Book archive tampering | n/a | segments are content-hashed; `book_segments` row is the index; bus never deletes archived rows |

**Threats v2 does NOT mitigate:**

- A compromised operator account on a host can still author events as any
  `from_agent` for that host. v2 mitigates cross-host impersonation, not
  same-host agent impersonation — that is the A2A per-agent auth work, future.
- A compromised host can refuse to write to its DLQ or refuse to redeliver.
  This is a host compromise; the bus design treats it as out-of-scope (a
  compromised root owns its logs anyway).
- DoS via spam appends. Per-host writer rate limiting is a v1 follow-up
  (currently relies on operator trust + cron back-pressure); v2 inherits this
  posture.

---

## 13. Failure matrix

| Failure | Symptom | v2 response | Recovery |
|---|---|---|---|
| Mirror cron dead | `bus_stats.by_source_kind` stops advancing for the host | in-process plugin still writes locally; `bus_stats.host_histogram` shows the missing host on read | restart the cron; missing events re-derive from the source-of-truth file (line-tail) — idempotent |
| Consumer crash mid-batch | some events acked, some not | redelivery from `last_seen_offset+1` on restart | consumer is idempotent on `(source, source_id)`; no manual intervention |
| Network partition between hosts (Stage C) | events buffered on each side | per-host ordering preserved; consumers see their local lag growing | reconnection → DLQ-stale check sweeps events older than `ack_deadline_s * max_redeliveries` to DLQ |
| Host key lost | cannot sign new events on that host | `event_sig=null` rows treated as legacy; consumer marks them `policy` | re-key ceremony: regenerate key, re-sign all legacy rows (`bus_verify_legacy`), John-approved |
| Book segment lost | row referenced by `book_segments` not on disk | `book_segments.sha256` mismatch on verify | restore from off-host backup; segments are content-addressed |
| SQLite WAL corruption | unreadable store | `PRAGMA wal_checkpoint(TRUNCATE)`; rebuild from sources via mirror cron | if that fails, snapshot to archives/, rebuild from `a2a_audit.jsonl` etc. (mirror is idempotent) |
| Schema migration mid-flight | partial ALTER | `migrations` table row carries `seq`, `name`; runner skips applied steps on restart | re-run `busdb.migrate(dry_run=False)` — idempotent |
| DLQ bloat | `dead_letter` rows older than 365d | per-topic TTL does NOT prune DLQ rows (hard_keep=1 by policy) | manual prune with `busdb prune_dlq --older-than-days 400`, John-approved |
| Cross-host replay includes a tampered event | `event_sig` mismatch | consumer rejects; row goes to consumer's local DLQ with `reason='policy'` | investigate host key compromise |

---

## 14. Benchmark plan

Offline only — no live mutations. The benchmarks target `scripts/fleet-bus-v2-bench.mjs`
(stage A deliverable).

| Workload | Target | Method |
|---|---|---|
| Append throughput, single-host SQLite, batch=500 | ≥ 5,000 rows/s on M-series Mac | `append_many` loop over a generated fixture, warm cache |
| Read latency, topic='a2a.audit.*', since=now-1h, limit=100 | p95 ≤ 5 ms | run 1,000 reads, measure per-call |
| Subscription lag, 1 consumer, 1 producer, 1 topic | < 200 ms end-to-end | producer writes a row, consumer's next sweep sees it within `sweep_interval` |
| Migration of a v1 store with 10k rows | < 2 s wall, 0 row loss | copy live store to `/tmp/`, run `migrate`, compare row counts |
| Export of a 10k-row day to `book-YYYY-MM-DD.ndjson` | < 1 s wall, sha256 verified | fixture with 10k rows |
| Replay of 1k events to a new `to_agent` | < 500 ms wall | producer writes 1k, then `bus_replay` re-emits them |
| DLQ insert at saturation (5 redeliveries / event / 100 events) | < 100 ms per DLQ insert | consumer marks 100 events poison; measure DLQ inserts |

Each benchmark writes its result to
`${EVIDENCE_DIR}/fleet-bus-v2-bench/bench-YYYYMMDD-HHMM.json`
(default: `${XDG_DATA_HOME:-$HOME/.local/share}/evidence/`).
The evidence dir is gitignored, mirroring the v1 evidence convention.

---

## 15. Single-host SQLite compatibility

The single-host SQLite deployment is the **reference implementation** for v2.
A v2 consumer reading from the same SQLite file:

- Issues `bus_read(topic='a2a.audit.*', since_rowid=42)` → SQLite-only path.
- Verifies `event_sig` using the local host key.
- Acknowledges with `bus_ack(id)` → updates `ack_ts` and
  `subscriptions.last_seen_offset` in the same `BEGIN IMMEDIATE` block.

This is the SAME tool surface (`bus_send`, `bus_read`, `bus_ack`) with one
added parameter on `bus_read` (`topic` and `since_rowid`). Every v1 caller
keeps working because v2 reads accept v1 kwargs.

---

## 16. Backend interface (for the future durable multi-host backend)

```python
# pseudocode; Python ABC, stdlib typing only
class Backend(Protocol):
    def append(self, event: Event) -> Optional[int]: ...
    def append_many(self, events: Iterable[Event]) -> int: ...
    def read(self, *, topic: Optional[str], since_rowid: Optional[int],
             to_agent: Optional[str], limit: int = 20) -> List[Event]: ...
    def ack(self, msg_id: int, agent: str) -> bool: ...
    def subscribe(self, agent: str, topic: str, *,
                  ack_deadline_s: int = 600,
                  max_redeliveries: int = 5) -> None: ...
    def replay(self, *, host: Optional[str], topic: str,
               since_rowid: int, until_rowid: Optional[int],
               to_agent: str) -> int: ...
    def stats(self) -> Dict[str, Any]: ...
    def prune(self, policy: RetentionPolicy) -> int: ...
    def export_book(self, day: date) -> BookSegment: ...
```

Implementations (none shipped in this slice):

- `SqliteBackend` — wraps `busdb.py`; default.
- `JetStreamBackend` — NATS JetStream, KV-per-topic with `MaxAckPending`,
  `AckWait=ack_deadline_s`, `MaxDeliver=max_redeliveries`. No new code in
  this slice.
- `PostgresBackend` — `messages` table partitioned by `host_id` and `ts`
  (monthly), `outbox` pattern for `delivery_attempts`, `LISTEN/NOTIFY` for
  redelivery timers.

The backend interface is the contract; implementations are not in this
slice because the brief is explicit: "**without introducing a resident process
before approval**".

---

## 17. Verification plan (this slice)

1. `npm run typecheck && npm run build && node scripts/run-tests.mjs` — must
   stay 1791/1791 (no regressions; baseline on the worktree before this slice
   was 1778/1778; the 13 fleet-bus-v2-contract cases are the delta).
   Verified on the worktree at
   `.worktrees/agent-mesh-fleet-bus-v2-design-20260821` (Node 24.18.1,
   `MESHFLEET_EVENT_LOG_FILE=$(mktemp -t meshfleet-verify-events)`,
   ledger env unset).
2. `node scripts/run-tests.mjs` also runs the new
   `test/fleet-bus-v2-contract.test.ts` (isolated, in-memory SQLite) — covers
   schema delta, idempotency, dedupe triple, topic read path, ack/offset
   advance.
3. `node scripts/fleet-bus-v2-migrate.mjs` (new tool) — copies the live
   store to `/tmp/`, runs the migration, asserts row counts and
   `meta.schema_version=2`, prints a one-line receipt.
4. `node scripts/fleet-bus-v2-bench.mjs` — runs the §14 benchmarks, writes
   the evidence JSON.
5. `grep -n 'fleet-bus\|bus_send\|bus_read\|bus_ack' docs/FLEET-BUS-V2-DESIGN.md`
   — sanity check that the design references the v1 surface by name.

---

## 18. What this slice ships

| Path | Type | Notes |
|---|---|---|
| `docs/FLEET-BUS-V2-DESIGN.md` | NEW | this document |
| `test/fleet-bus-v2-contract.test.ts` | NEW | offline contract test, in-memory SQLite (auto-discovered by `scripts/run-tests.mjs`) |
| `scripts/fleet-bus-v2-migrate.mjs` | NEW | offline migration runner against a copy of the live store |
| `scripts/fleet-bus-v2-bench.mjs` | NEW | offline benchmark suite |

The live `${FLEET_BUS_HOME}/fleet-bus.db`, the live plugin
`${FLEET_BUS_PLUGINS}/fleet-bus/`, the v1 design doc at
`${FLEET_BUS_DOCS}/FLEET-BUS-DESIGN.md`, the A2A hub, the gateways, and
all existing Markdown/SQLite receipts are NOT touched by this slice.

## 19. What this slice does NOT ship

- The SQLite migration applied to the live store. That is Stage B (§11.2).
- A multi-host backend implementation. That is Stage C (§11.3).
- A resident process, a gateway change, a credential change, a broadcast,
  any external messaging, or any deploy. The brief is explicit; the design
  honours it.
- A per-agent authentication scheme. That is the A2A threat model's
  future work; v2 is the right substrate but not the implementation.

---

## 20. Open questions (escalate to John)

1. Multi-host backend choice (NATS JetStream vs Postgres). Deferred until
   Stage C — both have operator experience in the MeshFleet lane.
2. Default DLQ TTL (currently 365d; some teams will want 180d or 730d).
   Tunable via `retention_policy`; default should match the v1 posture
   (90d for unacked peer mail).
3. Per-agent authentication. Out of scope for v2; flag for the A2A program.
4. Whether the legacy v1 rows should be re-signed in-place or only verified
   on read (§7.2). Default in this design: re-sign on read (`event_sig` stays
   null in the row; verified via a side table). John-approved re-key ceremony
   re-signs in place.

---

**End of design.** v1 is live and unchanged; v2 is the contract for the next
slice; the live store, the plugin, the mirror cron, the A2A hub, the gateways,
and every Markdown/SQLite receipt survive this slice intact.
