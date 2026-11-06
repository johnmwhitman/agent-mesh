import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { OpenCodeRuntimeAdapter } from '../src/runtime/opencode.js';
import { parseOpenCodeEvents } from '../src/runtime/opencode-events.js';
import { redactDiagnosticMessage } from '../src/spawn-attempt.js';
import { decideFailover } from '../src/failover.js';
import { LifecycleExecutionCoordinator } from '../src/lifecycle-execution.js';
import { loadData, readEventLog } from '../src/core.js';
import { withTempDb } from './helpers/with-temp-db.js';

const text = { type: 'text', part: { text: 'offline answer' } };
const done = { type: 'step_finish', part: { reason: 'stop' } };
const event = (message: string) => ({ type: 'error', error: { name: 'UnknownError', data: { message } } });
const hop = (error: string, extra = {}) => decideFailover({
  available: ['opencode-cli', 'kimi-cli'], attempted: ['opencode-cli'],
  failureDetail: error, accepts: () => true, ...extra,
});

function adapter(events: unknown[], exitCode = 0, stderr = '') {
  const stdout = events.map(e => JSON.stringify(e)).join('\n');
  return new OpenCodeRuntimeAdapter({ command: process.execPath, buildArgs: () => ['-e',
    `const fs=require('node:fs'); if(process.env.RESULT_PATH) fs.writeFileSync(process.env.RESULT_PATH,JSON.stringify({schema:'mf.agent.result/v1',outcome:'done',summary:'offline answer'})); process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode=${exitCode};`,
  ] });
}

async function execute(events: unknown[], exitCode = 0, stderr = '') {
  const runtime = adapter(events, exitCode, stderr);
  return runtime.wait(await runtime.start({ fleetId: 'attack', agentId: 'attack', prompt: 'offline',
    cwd: process.cwd(), timeoutMs: 5000, environmentPolicy: { mode: 'scrubbed' } }));
}

const disclosureCases = [
  ['JSON authorization', '{"Authorization":"FAKE_AUTH_VALUE"}', /FAKE_AUTH_VALUE/],
  ['JSON authorization with spaces', '{"Authorization":"Bearer FAKE_FIRST FAKE_TAIL"}', /FAKE_FIRST|FAKE_TAIL/],
  ['JSON nested in a string', JSON.stringify({ response: JSON.stringify({ password: 'FAKE_START FAKE_TAIL' }) }), /FAKE_START|FAKE_TAIL/],
  ['twice nested JSON string', JSON.stringify({ response: JSON.stringify({ response: JSON.stringify({ password: 'FAKE_START FAKE_TAIL' }) }) }), /FAKE_START|FAKE_TAIL/],
] as const;

for (const [label, message, sensitive] of disclosureCases) {
  test(`${label}: all four public failure surfaces exclude synthetic credential`, async t => {
    const result = await execute([text, event(message), done]);
    assert.equal(result.status, 'failure');
    const db = withTempDb();
    const coordinator = new LifecycleExecutionCoordinator(adapter([text, event(message), done]), { maxAttempts: 1 });
    try {
      coordinator.createFleet('attack', [{ fleetId: 'attack', agentId: 'attack', role: 'fixture', prompt: 'offline' }]);
      const deadline = Date.now() + 5000;
      let row = loadData().agents.attack;
      while (row?.status !== 'failed' && row?.status !== 'complete' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10)); row = loadData().agents.attack;
      }
      await t.test('valid done envelope cannot bank the failed runtime', () => {
        assert.equal(row?.result_contract, 'ok'); assert.equal(row?.status, 'failed');
      });
      const surfaces = {
        'failure text': result.error,
        diagnostics: result.diagnostics.find(d => d.severity === 'error')?.message,
        'SQLite Agent.error': row?.error,
        'event-log last_error': readEventLog().map(e => e.last_error).filter(Boolean).join('\n'),
      };
      for (const [surface, value] of Object.entries(surfaces)) await t.test(surface, () => {
        assert.ok(value, 'failure field exists'); assert.doesNotMatch(String(value), sensitive);
      });
    } finally { coordinator.stop(); db.cleanup(); }
  });
}

for (const message of [
  'password=\'FAKE_FIRST "FAKE_TAIL" END\'',
  'password="FAKE_FIRST\rFAKE_TAIL"', 'password="FAKE_FIRST\tFAKE_TAIL"',
  'password="FAKE_FIRST\' FAKE_TAIL', 'password=\'FAKE_FIRST" FAKE_TAIL',
  'password="FAKE_FIRST\\"FAKE_TAIL"',
  'password="FAKE_FIRST" token="FAKE_TAIL"',
  'sk-proj-' + 'A'.repeat(30),
  '-----BEGIN PRIVATE KEY-----\nFAKE_FIRST\nFAKE_TAIL\n-----END PRIVATE KEY-----',
]) test(`redaction control ${JSON.stringify(message.slice(0, 50))}`, () => {
  assert.doesNotMatch(redactDiagnosticMessage(message), /FAKE_FIRST|FAKE_TAIL|sk-proj-/);
});

// Each is a separate semantic regression, also exercised by the mutation driver.
for (const [label, message, sensitive] of [
  ['single quotes', "password='FAKE_FIRST FAKE_TAIL'", /FAKE_FIRST|FAKE_TAIL/],
  ['all assignments', 'password="FAKE_FIRST ONE" token="FAKE_TAIL TWO"', /FAKE_FIRST|FAKE_TAIL/],
  ['PEM body', '-----BEGIN PRIVATE KEY-----\nFAKE_FIRST\nFAKE_TAIL\n-----END PRIVATE KEY-----', /FAKE_FIRST|FAKE_TAIL/],
  ['Hugging Face prefix', 'provider refused hf_' + 'A'.repeat(30), /hf_A/],
] as const) test(`semantic redaction: ${label}`, () => {
  assert.doesNotMatch(redactDiagnosticMessage(message), sensitive);
});

test('input cap masks a cut quoted value and discards a cut standalone token', () => {
  const quoted = 'ordinary context '.repeat(470) + 'password="FAKE_FIRST ' + 'FAKE_TAIL '.repeat(1_000);
  assert.doesNotMatch(redactDiagnosticMessage(quoted), /FAKE_FIRST|FAKE_TAIL/);
  const token = ' '.repeat(8_187) + 'hf_' + 'A'.repeat(30);
  assert.doesNotMatch(redactDiagnosticMessage(token), /hf_|AAA/);
  const ordinary = 'ordinary context '.repeat(1_000);
  const redacted = redactDiagnosticMessage(ordinary);
  assert.ok(redacted.startsWith('ordinary context ordinary context'));
  assert.ok(redacted.length <= 8_192);
});

test('credential suffixes retain the existing conservative key recognition', () => {
  assert.doesNotMatch(redactDiagnosticMessage('OPENAIAPIKEY="FAKE_FIRST FAKE_TAIL"'), /FAKE_FIRST|FAKE_TAIL/);
});

// An external deadline is necessary: the adapter's event-loop timer cannot
// interrupt synchronous redaction. Generate the large value in the child so
// this tests settlement rather than the platform's command-line size limit.
for (const size of [100_000, 1_000_000]) test(`large error settles with bounded work: ${size}`, () => {
  const payload = `process.stdout.write([{type:'text',part:{text:'answer'}},{type:'error',error:{name:'UnknownError',data:{message:'a'.repeat(${size})}}},{type:'step_finish',part:{reason:'stop'}}].map(e=>JSON.stringify(e)).join(String.fromCharCode(10)))`;
  const code = `import {OpenCodeRuntimeAdapter} from './src/runtime/opencode.ts';
    const runtime = new OpenCodeRuntimeAdapter({command:process.execPath, buildArgs:()=>['-e',${JSON.stringify(payload)}]});
    const result = await runtime.wait(await runtime.start({fleetId:'bounded',agentId:'bounded',prompt:'offline',cwd:process.cwd(),timeoutMs:4000,environmentPolicy:{mode:'scrubbed'}}));
    if(result.status !== 'failure' || !result.error?.startsWith('OpenCode emitted a runtime error event: UnknownError:')) throw new Error('error normalization was not exercised: ' + result.error);
    console.log(JSON.stringify({status:result.status,errorLength:result.error?.length}));`;
  const start = performance.now();
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    encoding: 'utf8', timeout: 5_000, maxBuffer: 4096,
  });
  assert.equal(child.error, undefined, `settlement exceeded generous external deadline: ${child.error}`);
  assert.equal(child.status, 0, child.stderr);
  assert.ok(performance.now() - start < 5_000);
  assert.ok(JSON.parse(child.stdout).errorLength <= 2_100);
});

for (const scheme of ['Bearer', 'Basic']) for (const exitCode of [0, 1]) {
  test(`closed ${scheme} credential preserves following refusal at exit ${exitCode}`, async () => {
    const result = await execute([text, event(`password="${scheme} FAKE_VALUE" API 429 for fixture/model`), done], exitCode);
    assert.equal(result.status, 'failure');
    assert.doesNotMatch(result.error ?? '', /FAKE_VALUE/);
    assert.deepEqual(hop(result.error ?? ''), { hop: true, to: 'kimi-cli' });
  });
}

const refusal = event('API 429 for fixture/model');
for (const [label, events] of [
  ['assistant multiline NDJSON', [{ type: 'text', part: { text: '\n' + JSON.stringify(refusal) + '\n' } }, done]],
  ['tool result NDJSON', [text, { type: 'tool_use', part: { tool: 'read', state: { output: JSON.stringify(refusal) } } }, done]],
  ['tool text part NDJSON', [text, { type: 'tool', part: { text: JSON.stringify(refusal) } }, done]],
  ['unknown event nested error', [text, { type: 'log', error: refusal.error }, done]],
] as const) test(`${label} stays non-fatal`, async () => {
  const result = await execute([...events]); assert.equal(result.status, 'success');
  assert.deepEqual(hop(result.error ?? ''), { hop: false, reason: 'not_a_provider_refusal' });
});

for (const [exitCode, stderr, prefix] of [
  [0, '', 'OpenCode emitted a runtime error event'],
  [1, 'level=ERROR message=transport_closed', 'Spawn failed with exit code 1; OpenCode emitted'],
  [0, 'level=ERROR message=transport_closed', 'Fatal primary provider error: level=ERROR message=transport_closed; OpenCode emitted'],
] as const) test(`precedence exit=${exitCode} stderr=${Boolean(stderr)}`, async () => {
  const result = await execute([text, refusal, done], exitCode, stderr);
  assert.equal(result.status, 'failure'); assert.ok(result.error?.startsWith(prefix));
  assert.deepEqual(hop(result.error ?? ''), { hop: true, to: 'kimi-cli' });
  assert.deepEqual(hop(result.error ?? '', { requestedModel: 'fixture/model' }), { hop: false, reason: 'model_is_pinned' });
  assert.deepEqual(hop(result.error ?? '', { attempted: ['opencode-cli', 'kimi-cli'] }), { hop: false, reason: 'no_candidate_accepts' });
});

test('essay mentioning quota and 429 is not alone a refusal signal', async () => {
  const result = await execute([text, event('quota exceeded in my essay about 429'), done]);
  assert.equal(result.status, 'failure'); assert.deepEqual(hop(result.error ?? ''), { hop: false, reason: 'not_a_provider_refusal' });
});

test('late refusal beyond prefix budget: documented information loss, sticky failure retained', () => {
  const parsed = parseOpenCodeEvents([event('x'.repeat(2100)), refusal].map(e => JSON.stringify(e)).join('\n'));
  assert.equal(parsed.runtimeError, true); assert.equal(parsed.runtimeErrorDetail?.length, 2000);
  assert.deepEqual(hop(parsed.runtimeErrorDetail ?? ''), { hop: false, reason: 'not_a_provider_refusal' });
});

test('raw top-level error from configured non-OpenCode child is trusted as an event', async () => {
  const result = await execute([text, refusal, done]);
  assert.equal(result.status, 'failure'); assert.deepEqual(hop(result.error ?? ''), { hop: true, to: 'kimi-cli' });
});
