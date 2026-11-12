'use strict';

const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const Module = require('node:module');

function resolveMocha() {
  const extDir = process.env.MESHFLEET_EXTENSION_DIR;
  assert.ok(extDir, 'MESHFLEET_EXTENSION_DIR required');
  const candidate = path.join(extDir, 'node_modules', 'mocha');
  assert.ok(fs.existsSync(path.join(candidate, 'package.json')), `pinned mocha missing at ${candidate}`);
  return require(candidate);
}

const Mocha = resolveMocha();
const markerDir = process.env.MESH_SYNTHETIC_MARKER_DIR;
assert.ok(markerDir, 'MESH_SYNTHETIC_MARKER_DIR required');
fs.mkdirSync(markerDir, { recursive: true });

const MARKER_WALL_MS = 60_000;
const POLL_MS = 25;

function writeMode(spec) {
  const control = process.env.MESH_SYNTHETIC_CONTROL;
  assert.ok(control, 'MESH_SYNTHETIC_CONTROL required');
  const body = { ...spec };
  if (body.hold && !body.marker_dir) body.marker_dir = markerDir;
  fs.writeFileSync(control, JSON.stringify(body, null, 2));
}

function markerPath(name) {
  return path.join(markerDir, name);
}

async function waitForMarker(name) {
  const target = markerPath(name);
  const start = Date.now();
  while (!fs.existsSync(target)) {
    if (Date.now() - start > MARKER_WALL_MS) {
      throw new Error(`missing-marker:${name}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

function releaseA() {
  fs.mkdirSync(markerDir, { recursive: true });
  fs.writeFileSync(markerPath('a-release'), JSON.stringify({ ts: Date.now() }) + '\n');
}

exports.run = function run() {
  const mocha = new Mocha({ ui: 'tdd', timeout: 180_000, color: true });
  mocha.addFile(path.join(__dirname, 'extension.test.js'));
  return new Promise((resolve, reject) => {
    mocha.run((failures) => {
      if (failures) reject(new Error(`${failures} tests failed`));
      else resolve();
    });
  });
};

globalThis.__councilErrorHost = { writeMode, waitForMarker, releaseA, markerDir };
