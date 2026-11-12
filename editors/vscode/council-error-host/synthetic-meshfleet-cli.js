#!/usr/bin/env node
/**
 * Deterministic synthetic meshfleet CLI for Council-error Extension Host.
 * Modes via MESH_SYNTHETIC_CONTROL JSON:
 *   { mode: "B-success"|"C-fail"|"A-success", hold?: bool, marker_dir?: string }
 * Held A: write a-entered, wait for a-release, emit A ledger, write a-completed.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const HOLD_WALL_MS = 60_000;
const POLL_MS = 25;

function readControl() {
  const p = process.env.MESH_SYNTHETIC_CONTROL;
  if (!p) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

const control = readControl();
const mode = control.mode || process.env.MESH_SYNTHETIC_MODE || 'B-success';
const markerDir = control.marker_dir || process.env.MESH_SYNTHETIC_MARKER_DIR || '';
const hold = Boolean(control.hold);

function markerPath(name) {
  if (!markerDir) throw new Error('marker_dir required for held A');
  return path.join(markerDir, name);
}

function writeMarker(name, payload) {
  fs.mkdirSync(markerDir, { recursive: true });
  fs.writeFileSync(markerPath(name), JSON.stringify(payload || { ts: Date.now() }) + '\n');
}

function waitForMarker(name) {
  const target = markerPath(name);
  const start = Date.now();
  while (!fs.existsSync(target)) {
    if (Date.now() - start > HOLD_WALL_MS) {
      process.stderr.write(`missing-marker:${name}\n`);
      process.exit(2);
    }
    const end = Date.now() + POLL_MS;
    while (Date.now() < end) {
      /* bounded poll */
    }
  }
}

function ledger(tag) {
  const fleetId = `${tag}-fleet`;
  const agentId = `${tag}-agent`;
  const messageId = `${tag}-council`;
  return {
    schema_version: 2,
    fleets: {
      [fleetId]: { id: fleetId, status: 'running', created_at: tag === 'A' ? 500 : 1000 },
    },
    agents: {
      [agentId]: {
        id: agentId,
        fleet_id: fleetId,
        role: 'lead',
        prompt: 'p',
        status: 'idle',
      },
    },
    messages: {},
    inboxes: {},
    capabilities: {},
    receipts: {
      [`${messageId}:${agentId}:r-ack`]: {
        message_id: messageId,
        agent_id: agentId,
        action: 'r-ack',
        timestamp: 1500,
      },
    },
    ratifications: {
      [messageId]: {
        message_id: messageId,
        proposer: agentId,
        fleet_id: fleetId,
        subject: `${tag}-council`,
        quorum: 1,
        voters: [agentId],
        required_signoffs: [],
        opened_at: 1200,
        silence_policy: 'abstain',
        status: 'open',
      },
    },
    templates: {},
  };
}

function emitOk(model) {
  process.stdout.write(JSON.stringify(model) + '\n');
  process.exit(0);
}

function emitFail(message) {
  process.stderr.write(message + '\n');
  process.exit(1);
}

function verifyOk(tag) {
  process.stdout.write(
    JSON.stringify({
      schema: 'meshfleet.inspect/v1',
      kind: 'verify',
      data: {
        ok: true,
        errors: 0,
        warnings: 0,
        counts: { fleets: 1, agents: 1, messages: 0, receipts: 1, councils: 1 },
        summary: `${tag}-verify ok`,
        findings: [],
      },
    }) + '\n',
  );
  process.exit(0);
}

if (mode === 'C-fail') {
  emitFail('CLI export failed');
}

if (mode === 'A-success' && hold) {
  writeMarker('a-entered', { mode: 'A-success' });
  waitForMarker('a-release');
  if (args.includes('--verify')) {
    writeMarker('a-completed', { kind: 'verify' });
    verifyOk('A');
  }
  writeMarker('a-completed', { kind: 'export' });
  emitOk(ledger('A'));
}

const tag = mode === 'A-success' ? 'A' : 'B';
if (args.includes('--verify')) {
  verifyOk(tag);
}
emitOk(ledger(tag));
