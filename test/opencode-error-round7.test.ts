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
import { baseRedactDiagnosticMessage } from './helpers/base-1293-redaction.js';

// Retain the real SQLite/event-log fixtures for receiver inspection.
function retainedDb() {
  const previous = resolveDbFile();
  const dir = mkdtempSync(join(tmpdir(), 'am-spawn-r7-'));
  setDbPath(join(dir, 'ledger.db'));
  setEventLogPath(join(dir, 'events.log'));
  return () => { closeDb(); setDbPath(previous); setEventLogPath(DEFAULT_EVENT_LOG); };
}

function adapter(message: string) {
  const events = [
    { type: 'text', part: { text: 'offline answer' } },
    // No optional name prefix: keep this witness at the same cut in all sinks.
    { type: 'error', error: { data: { message } } },
    { type: 'step_finish', part: { reason: 'stop' } },
  ];
  return new OpenCodeRuntimeAdapter({ command: process.execPath, buildArgs: () => ['-e',
    `if(process.env.RESULT_PATH) require('node:fs').writeFileSync(process.env.RESULT_PATH,JSON.stringify({schema:'mf.agent.result/v1',outcome:'done',summary:'offline answer'})); process.stdout.write(${JSON.stringify(events.map(e => JSON.stringify(e)).join('\n'))});`,
  ] });
}

for (const [label, separator] of [
  ['VT', '\v'], ['FF', '\f'], ['ANSI with space', '\x1b[ B'], ['control 01', '\x01'],
] as const) {
  // The visible prefix is shorter than the standalone credential matcher.
  // Controls must disappear before choosing where the lexical token is cut.
  const message = 'Auxiliary provider warning: upstream body'
    + ' '.repeat(8192 - 41 - 20) + 'sk-FAKEVTPREFIX01' + separator + 'B'.repeat(30);

  test(`round7 ${label}: base differential at the input cut`, () => {
    const base = baseRedactDiagnosticMessage(message);
    const candidate = redactDiagnosticMessage(message);
    assert.doesNotMatch(base, /sk-|FAKEVTPREFIX01/);
    assert.match(candidate, /upstream body/);
    assert.doesNotMatch(candidate, /sk-|FAKEVTPREFIX01/);
  });

  test(`round7 ${label}: cut credential excluded from all five sinks`, async t => {
    const runtime = adapter(message);
    const result = await runtime.wait(await runtime.start({ fleetId: 'r7', agentId: 'r7',
      prompt: 'offline', cwd: process.cwd(), timeoutMs: 5000, environmentPolicy: { mode: 'scrubbed' } }));
    assert.equal(result.status, 'failure');
    const close = retainedDb();
    const coordinator = new LifecycleExecutionCoordinator(adapter(message), { maxAttempts: 1 });
    try {
      coordinator.createFleet('r7', [{ fleetId: 'r7', agentId: 'r7', role: 'fixture', prompt: 'offline' }]);
      const deadline = Date.now() + 5000;
      let row = loadData().agents.r7;
      while (row?.status !== 'failed' && row?.status !== 'complete' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10)); row = loadData().agents.r7;
      }
      assert.equal(row?.status, 'failed');
      assert.equal(row?.result_contract, 'ok', 'done envelope cannot override runtime error');
      registerAgentInLedger({ id: 'success', fleet_id: 'r7', role: 'fixture', prompt: 'offline', status: 'running' });
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
        assert.match(value, /upstream body/);
        assert.doesNotMatch(value, /sk-|FAKEVTPREFIX01/);
        assert.ok(value.length <= 2100, 'public diagnostic remains bounded');
      });
    } finally { coordinator.stop(); close(); }
  });
}

test('round7 M2: nested escaped quote keeps the credential tail hidden', () => {
  const message = JSON.stringify({ response: JSON.stringify({ password: 'FAKE_HEAD "FAKE_TAIL" END' }) });
  const redacted = redactDiagnosticMessage(message);
  assert.doesNotMatch(redacted, /FAKE_HEAD|FAKE_TAIL|END/);
});

test('round7 M5: authorization ends at a closing object boundary', () => {
  assert.equal(redactDiagnosticMessage('{"Proxy-Authorization": FAKE_HEAD} visible context'),
    '{"Proxy-Authorization": [redacted]} visible context');
});

test('round7 M10: unquoted assignment ends at object and array boundaries', () => {
  for (const boundary of ['}', ']']) {
    assert.equal(redactDiagnosticMessage(`password=FAKE_HEAD${boundary}readable`),
      `password=[redacted]${boundary}readable`);
  }
});

test('round7 M14: a cut JWT loses its whole lexical token', () => {
  const prefix = 'eyJhbGciOiFAKEJWTHEADER.payload.';
  const message = 'context ' + ' '.repeat(8192 - 8 - prefix.length) + prefix + 'FAKETAIL'.repeat(8);
  assert.doesNotMatch(baseRedactDiagnosticMessage(message), /eyJ|FAKE/);
  assert.equal(redactDiagnosticMessage(message), 'context');
});
