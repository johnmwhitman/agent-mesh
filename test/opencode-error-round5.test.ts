import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenCodeRuntimeAdapter } from '../src/runtime/opencode.js';
import { LifecycleExecutionCoordinator } from '../src/lifecycle-execution.js';
import { loadData, readEventLog, setEventLogPath, DEFAULT_EVENT_LOG,
  registerAgentInLedger, markAgentFinished } from '../src/core.js';
import { setDbPath, closeDb, resolveDbFile } from '../src/db.js';
import { redactDiagnosticMessage, projectSuccessDiagnostics } from '../src/spawn-attempt.js';

// Keep isolated SQLite files and event logs for inspection; no filesystem cleanup.
function retainedDb() {
  const previous = resolveDbFile();
  const dir = mkdtempSync(join(tmpdir(), 'am-spawn-r5-'));
  setDbPath(join(dir, 'ledger.db'));
  setEventLogPath(join(dir, 'events.log'));
  return () => { closeDb(); setDbPath(previous); setEventLogPath(DEFAULT_EVENT_LOG); };
}

function adapter(message: string) {
  const events = [
    { type: 'text', part: { text: 'offline answer' } },
    { type: 'error', error: { name: 'UnknownError', data: { message } } },
    { type: 'step_finish', part: { reason: 'stop' } },
  ];
  return new OpenCodeRuntimeAdapter({ command: process.execPath, buildArgs: () => ['-e',
    `if(process.env.RESULT_PATH) require('node:fs').writeFileSync(process.env.RESULT_PATH,JSON.stringify({schema:'mf.agent.result/v1',outcome:'done',summary:'offline answer'})); process.stdout.write(${JSON.stringify(events.map(e => JSON.stringify(e)).join('\n'))});`,
  ] });
}

const cases = [
  ['Bearer before api_key', 'Authorization: Bearer FAKE_A api_key="FAKE_B FAKE_C"'],
  ['Basic before secret', 'Basic FAKE_A then secret="FAKE_B FAKE_C"'],
  ['Bearer before header', 'Bearer FAKE_A x-api-key: FAKE_B'],
  ['Basic colon credential', 'Basic FAKEUSER:FAKEPASS_SECRET'],
  ['Bearer colon credential', 'Bearer FAKEKEYID:FAKEPASS_SECRET'],
  ['Authorization newline', 'Authorization: Bearer\nFAKEPASS_SECRET'],
  ['Basic newline', 'Basic\r\nFAKEPASS_SECRET'],
] as const;
const sensitive = /FAKE_[ABC]|FAKEUSER|FAKEKEYID|FAKEPASS_SECRET/;

for (const [label, message] of cases) {
  test(`round5 ${label}: four failure sinks and success Agent.diagnostics`, async t => {
    const runtime = adapter(message);
    const result = await runtime.wait(await runtime.start({ fleetId: 'r5', agentId: 'r5',
      prompt: 'offline', cwd: process.cwd(), timeoutMs: 5000, environmentPolicy: { mode: 'scrubbed' } }));
    assert.equal(result.status, 'failure');
    const close = retainedDb();
    const coordinator = new LifecycleExecutionCoordinator(adapter(message), { maxAttempts: 1 });
    try {
      coordinator.createFleet('r5', [{ fleetId: 'r5', agentId: 'r5', role: 'fixture', prompt: 'offline' }]);
      const deadline = Date.now() + 5000;
      let row = loadData().agents.r5;
      while (row?.status !== 'failed' && row?.status !== 'complete' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10)); row = loadData().agents.r5;
      }
      assert.equal(row?.status, 'failed');
      assert.equal(row?.result_contract, 'ok', 'done envelope cannot override runtime error');
      registerAgentInLedger({ id: 'success', fleet_id: 'r5', role: 'fixture', prompt: 'offline', status: 'running' });
      markAgentFinished('success', 'complete', 'answer', undefined, undefined, undefined,
        projectSuccessDiagnostics([{ severity: 'warning', message }]));
      const success = loadData().agents.success;
      assert.equal(success.status, 'complete');
      assert.equal(success.error, undefined);
      const surfaces = {
        'failure text': result.error,
        'error diagnostic': result.diagnostics.find(d => d.severity === 'error')?.message,
        'SQLite Agent.error': row?.error,
        'event-log last_error': readEventLog().map(e => e.last_error).filter(Boolean).join('\n'),
        'success Agent.diagnostics': success.diagnostics?.map(d => d.message).join('\n'),
      };
      for (const [surface, value] of Object.entries(surfaces)) await t.test(surface, () => {
        assert.ok(value, `${surface} exists`);
        assert.match(value, /\[redacted\]/);
        assert.doesNotMatch(value, sensitive);
      });
    } finally { coordinator.stop(); close(); }
  });
}

// Distinguish a colon INSIDE the first credential token from a subsequent
// key[:=] assignment. Arbitrary keys also delimit a bare authorization value.
for (const [message, expected] of [
  ['Bearer FAKE_A note: readable', 'Bearer [redacted] note: readable'],
  ['Basic FAKEUSER:FAKEPASS_SECRET note=readable', 'Basic [redacted] note=readable'],
  ['Authorization: Bearer FAKE_A api_key="FAKE_B FAKE_C"', 'Authorization: Bearer [redacted] api_key="[redacted]"'],
  ['Basic FAKE_A then secret="FAKE_B FAKE_C"', 'Basic [redacted] secret="[redacted]"'],
  ['Bearer FAKE_A x-api-key: FAKE_B', 'Bearer [redacted] x-api-key: [redacted]'],
] as const) test(`round5 boundary: ${message}`, () => {
  assert.equal(redactDiagnosticMessage(message), expected);
});

test('round5 ordinary long explanation stays readable', () => {
  const message = 'ordinary transport explanation ' + 'readable context '.repeat(180);
  assert.equal(redactDiagnosticMessage(message), message.trim());
});
