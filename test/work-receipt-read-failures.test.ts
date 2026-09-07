import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTempDb, type TempDb } from './helpers/with-temp-db.js';
import { withStorageTransaction, assertA2aDurableSchema } from '../src/db.js';
import { computeWorkReceiptPayloadSha256, recordWorkReceipt, getWorkReceipt, type WorkReceiptInput } from '../src/work-receipt.js';
import { verifyLedgerFile } from '../src/verify.js';
import { getHealth } from '../src/health.js';

function withReceipt(run: (db: TempDb) => void): void {
  const db = withTempDb();
  try {
    const input: WorkReceiptInput = {
      schema: 'hermes.kanban-result/v1', task_id: 't_readfailure', run_id: 1,
      assignee: 'test', terminal_outcome: 'failed', result_contract: 'invalid',
      quality_gate: 'failed', completed_at: 1700000000, evidence: [], payload_sha256: '',
    };
    input.payload_sha256 = computeWorkReceiptPayloadSha256(input);
    const recorded = recordWorkReceipt(input);
    assert.ok(!('error' in recorded), JSON.stringify(recorded));
    run(db);
  } finally { db.cleanup(); }
}

test('valid failed receipt is readable and verifies green', () => {
  withReceipt(db => {
    assert.equal(getWorkReceipt('hermes-kanban', 't_readfailure', 1).ok, true);
    assert.equal(verifyLedgerFile(db.dbFile).ok, true);
  });
});

test('raw JSON parse failure survives normalization even when digest matches empty evidence', () => {
  withReceipt(db => {
    withStorageTransaction(tx => tx.prepare('UPDATE work_receipts SET evidence_json = ?').run('NOT JSON'));
    const report = verifyLedgerFile(db.dbFile);
    assert.equal(report.ok, false);
    assert.ok(report.findings.some(f => f.check === 'work_receipt.invalid_persisted_schema'));
  });
});

test('file audit refuses the same missing required index as live layout validation', () => {
  withReceipt(db => {
    withStorageTransaction(tx => tx.exec('DROP INDEX idx_work_receipts_task'));
    assert.throws(() => verifyLedgerFile(db.dbFile), /invalid v5.*index/);
  });
});

test('corrupt selected receipt column is an error, not not_found', () => {
  withReceipt(() => {
    withStorageTransaction(tx => tx.exec('ALTER TABLE work_receipts DROP COLUMN assignee'));
    assert.throws(() => getWorkReceipt('hermes-kanban', 't_readfailure', 1));
  });
});

test('corrupt receipt JSON is an error, not an empty evidence receipt', () => {
  withReceipt(() => {
    withStorageTransaction(tx => tx.prepare('UPDATE work_receipts SET evidence_json = ?').run('NOT JSON'));
    assert.throws(() => getWorkReceipt('hermes-kanban', 't_readfailure', 1), /invalid persisted work receipt/);
  });
});

test('unreadable receipt count is unknown and makes health error', () => {
  withReceipt(() => {
    withStorageTransaction(tx => tx.exec('DROP TABLE work_receipts'));
    const health = getHealth();
    assert.equal(health.work_receipt_count, null);
    assert.equal(health.status, 'error');
  });
});

test('additive v5 storage preserves the v4 durable A2A layout contract', () => {
  withReceipt(() => withStorageTransaction(tx => assert.doesNotThrow(() => assertA2aDurableSchema(tx))));
});
