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
// Keep isolated SQLite files and event logs for inspection; no filesystem cleanup.
function retainedDb() {
  const previous = resolveDbFile();
  const dir = mkdtempSync(join(tmpdir(), 'am-spawn-r6-'));
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
  ['x-auth-token', 'x-auth-token: Bearer FAKESEC_T'],
  ['access_token', 'access_token=Bearer FAKESEC_T'],
  ['client_secret', 'client_secret = Bearer FAKESEC_T'],
  ['api_key Basic', 'api_key: Basic FAKEUSER:FAKESEC_P'],
  ['proxyAuthorization', 'proxyAuthorization: Bearer FAKESEC_T'],
  ['XAuthorization', 'XAuthorization: Bearer FAKESEC_T'],
  ['Proxy-Authorization', 'Proxy-Authorization: Bearer FAKESEC_T'],
  ['Authorization quoted Bearer', 'Authorization: Bearer "FAKESEC_T"'],
  ['bare quoted Bearer', "Bearer 'FAKESEC_T'"],
  ['assignment quoted Basic', "authorization=basic 'FAKESEC_T'"],
  ['credential backslash', 'Bearer FAKESEC_A\\FAKESEC_B'],
  ['credential brace', 'Bearer FAKESEC_A}FAKESEC_B'],
  ['credential bracket', 'Bearer FAKESEC_A]FAKESEC_B'],
  ['escaped quoted Bearer', 'Bearer \\\"FAKESEC_T\\\"'],
] as const;
const sensitive = /FAKE[A-Z0-9_]+/g;
for (const [label, message] of cases) {
  test(`round6 ${label}: four failure sinks and success Agent.diagnostics`, async t => {
    const runtime = adapter(message);
    const result = await runtime.wait(await runtime.start({ fleetId: 'r6', agentId: 'r6',
      prompt: 'offline', cwd: process.cwd(), timeoutMs: 5000, environmentPolicy: { mode: 'scrubbed' } }));
    assert.equal(result.status, 'failure');
    const close = retainedDb();
    const coordinator = new LifecycleExecutionCoordinator(adapter(message), { maxAttempts: 1 });
    try {
      coordinator.createFleet('r6', [{ fleetId: 'r6', agentId: 'r6', role: 'fixture', prompt: 'offline' }]);
      const deadline = Date.now() + 5000;
      let row = loadData().agents.r6;
      while (row?.status !== 'failed' && row?.status !== 'complete' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10)); row = loadData().agents.r6;
      }
      assert.equal(row?.status, 'failed');
      assert.equal(row?.result_contract, 'ok', 'done envelope cannot override runtime error');
      registerAgentInLedger({ id: 'success', fleet_id: 'r6', role: 'fixture', prompt: 'offline', status: 'running' });
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
        assert.doesNotMatch(value, /FAKE[A-Z0-9_]+/);
      });
    } finally { coordinator.stop(); close(); }
  });
}


// Every R3-R6 witness, including controls where base itself leaks. Compare
// individual synthetic tokens: a token hidden by base must stay hidden here.
const witnesses = [
  ...cases.map(([, message]) => message),
  'password="FAKE_FIRST_LINE\nFAKE_SENSITIVE_TAIL"',
  'password="FAKE_FIRST_LINE\nFAKE_SENSITIVE_TAIL',
  'password="FAKE_FIRST_LINE\\"FAKE_SENSITIVE_TAIL"',
  'password="FAKE_FIRST_LINE\\nFAKE_SENSITIVE_TAIL"',
  '{"Authorization":"FAKE_AUTH_VALUE"}',
  '{"Authorization":"Bearer FAKE_FIRST FAKE_TAIL"}',
  JSON.stringify({response: JSON.stringify({password:'FAKE_START FAKE_TAIL'})}),
  JSON.stringify({response: JSON.stringify({response: JSON.stringify({password:'FAKE_START FAKE_TAIL'})})}),
  "password='FAKE_FIRST \"FAKE_TAIL\" END'",
  'password="FAKE_FIRST\rFAKE_TAIL"', 'password="FAKE_FIRST\tFAKE_TAIL"',
  'password="FAKE_FIRST\' FAKE_TAIL', "password='FAKE_FIRST\" FAKE_TAIL",
  'password="FAKE_FIRST\\"FAKE_TAIL"',
  'password="FAKE_FIRST" token="FAKE_TAIL"',
  "password='FAKE_FIRST FAKE_TAIL'",
  'password="FAKE_FIRST ONE" token="FAKE_TAIL TWO"',
  'OPENAIAPIKEY="FAKE_FIRST FAKE_TAIL"',
  'secret=abcTOKEN=\'FAKE_TAIL\'',
  "odd--OPENAIAPIKEY='FAKE_FIRST FAKE_TAIL'",
  '-----BEGIN PRIVATE KEY-----\nFAKE_FIRST\nFAKE_TAIL\n-----END PRIVATE KEY-----',
  'password="Bearer FAKE_VALUE" API 429', 'password="Basic FAKE_VALUE" API 429',
  'Authorization: Bearer FAKE_A api_key="FAKE_B FAKE_C"',
  'Basic FAKE_A then secret="FAKE_B FAKE_C"',
  'Bearer FAKE_A x-api-key: FAKE_B',
  'Basic FAKEUSER:FAKEPASS_SECRET', 'Bearer FAKEKEYID:FAKEPASS_SECRET',
  'Authorization: Bearer\nFAKEPASS_SECRET', 'Basic\r\nFAKEPASS_SECRET',
  'Bearer FAKE_A note: readable',
  'Basic FAKEUSER:FAKEPASS_SECRET note=readable',
  '😀 ordinary context x-auth-token: Bearer FAKE_UNICODE',
  '😀 password="FAKE_FIRST\\"FAKE_TAIL"',
  // Inherited follow-ups are included to measure monotonicity, not promise
  // universal credential coverage.
  'Authorization: Digest response="FAKE_DIGEST"',
  'Bearer\vFAKE_VT', 'Basic\fFAKE_FF',
  'token=FAKE_FIRST FAKE_SECOND', 'Bearer FAKE_FIRST\nFAKE_SECOND',
];
for (const [index, message] of witnesses.entries()) test(`round6 differential witness ${index}`, () => {
  const base = baseRedactDiagnosticMessage(message);
  const candidate = redactDiagnosticMessage(message);
  for (const token of new Set(message.match(sensitive) ?? [])) {
    if (!base.includes(token)) assert.ok(!candidate.includes(token), `base hid ${token}: ${candidate}`);
  }
});

// Pin the semantics behind the requested mutants, including inputs without a
// secret so a redundant legacy mask cannot hide a changed scanner boundary.
test('round6 Ma: backslash preserves the following escaped header', () => {
  assert.equal(redactDiagnosticMessage('Proxy-Authorization: FAKE_A\\r\\nX-Request-Id: fixture-request'),
    'Proxy-Authorization: [redacted]\\r\\nX-Request-Id: fixture-request');
});
test('round6 Mb: a word beginning with Bearer is not an authorization scheme', () => {
  assert.equal(redactDiagnosticMessage('Bearer-readable explanation'), 'Bearer-readable explanation');
  assert.equal(redactDiagnosticMessage('Bearer: readable explanation'), 'Bearer: readable explanation');
  assert.equal(redactDiagnosticMessage('Bearer=enabled note=readable'), 'Bearer=enabled note=readable');
  assert.equal(redactDiagnosticMessage('Basic=enabled note=readable'), 'Basic=enabled note=readable');
});
test('round6 Mi: Proxy-Authorization masks a multiword unquoted value', () => {
  assert.equal(redactDiagnosticMessage('Proxy-Authorization: FAKE_FIRST FAKE_TAIL note: readable'),
    'Proxy-Authorization: [redacted] note: readable');
});

test('round6 original boundaries distinguish closed and unterminated scheme assignments', () => {
  assert.match(redactDiagnosticMessage('password="Bearer FAKE_VALUE" API 429'), /API 429/);
  assert.doesNotMatch(redactDiagnosticMessage('password="Bearer FAKE_VALUE API 429'), /FAKE|API 429/);
  assert.match(redactDiagnosticMessage('password="Basic FAKE_VALUE" API 429'), /API 429/);
  assert.doesNotMatch(redactDiagnosticMessage('password="Basic FAKE_VALUE API 429'), /FAKE|API 429/);
});
