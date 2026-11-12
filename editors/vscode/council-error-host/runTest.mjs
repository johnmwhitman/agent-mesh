#!/usr/bin/env node
/** Extension-host entry; lives under editors/vscode/council-error-host/. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, copyFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(HERE, '..');
const ROOT = process.env.AGENT_MESH_ROOT || path.resolve(EXTENSION_DIR, '..', '..');
const WORK = process.env.WORK_DIR;
const PINNED_PARENT = 'ba64af08ca4cefa0009edffc8b82dd58c2680f40';

if (!WORK) {
  console.error('WORK_DIR required');
  process.exit(2);
}

const testElectronRoot = path.join(EXTENSION_DIR, 'node_modules', '@vscode', 'test-electron');
const mochaRoot = path.join(EXTENSION_DIR, 'node_modules', 'mocha');
if (!existsSync(path.join(testElectronRoot, 'package.json'))) {
  console.error(`pinned @vscode/test-electron missing at ${testElectronRoot}`);
  process.exit(2);
}
if (!existsSync(path.join(mochaRoot, 'package.json'))) {
  console.error(`pinned mocha missing at ${mochaRoot}`);
  process.exit(2);
}

const cli = path.join(WORK, 'synthetic-meshfleet-cli.js');
copyFileSync(path.join(HERE, 'synthetic-meshfleet-cli.js'), cli);
chmodSync(cli, 0o755);

const markerDir = path.join(WORK, 'markers');
rmSync(markerDir, { recursive: true, force: true });
mkdirSync(markerDir, { recursive: true });

const control = path.join(WORK, 'synthetic-control.json');
writeFileSync(control, JSON.stringify({ mode: 'B-success', hold: false }, null, 2));

const userData = path.join(WORK, 'user-data');
const extensionsDir = path.join(WORK, 'extensions');
const workspace = path.join(WORK, 'workspace');
mkdirSync(path.join(userData, 'User'), { recursive: true });
mkdirSync(extensionsDir, { recursive: true });
mkdirSync(path.join(workspace, '.vscode'), { recursive: true });

const settings = {
  'meshfleet.cliCommand': `node ${cli}`,
  'meshfleet.refreshIntervalSeconds': 0,
};
writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify(settings, null, 2));
writeFileSync(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify(settings, null, 2));
writeFileSync(
  path.join(workspace, 'package.json'),
  JSON.stringify({ name: 'council-error-host-workspace', private: true }, null, 2),
);

const tsc = path.join(EXTENSION_DIR, 'node_modules', 'typescript', 'bin', 'tsc');
if (!existsSync(tsc)) {
  console.error('typescript missing; run npm ci in editors/vscode first');
  process.exit(2);
}
const compile = spawnSync(process.execPath, [tsc, '-p', path.join(EXTENSION_DIR, 'tsconfig.json')], {
  cwd: EXTENSION_DIR,
  encoding: 'utf8',
});
if (compile.status !== 0) {
  process.stderr.write(compile.stdout || '');
  process.stderr.write(compile.stderr || '');
  process.exit(compile.status ?? 1);
}

process.env.MESH_SYNTHETIC_CONTROL = control;
process.env.MESH_SYNTHETIC_MARKER_DIR = markerDir;
process.env.MESHFLEET_HOST_WORK = WORK;
process.env.MESHFLEET_HOST_CLI = cli;
process.env.MESHFLEET_EXTENSION_DIR = EXTENSION_DIR;
process.env.AGENT_MESH_ROOT = ROOT;

let runTests;
try {
  ({ runTests } = await import(pathToFileURL(path.join(testElectronRoot, 'out', 'index.js')).href));
} catch {
  ({ runTests } = await import(pathToFileURL(path.join(testElectronRoot, 'index.js')).href));
}

const result = await runTests({
  extensionDevelopmentPath: EXTENSION_DIR,
  extensionTestsPath: path.join(HERE, 'suite', 'index.js'),
  launchArgs: [
    workspace,
    `--user-data-dir=${userData}`,
    `--extensions-dir=${extensionsDir}`,
    '--disable-workspace-trust',
  ],
  extensionTestsEnv: {
    MESH_SYNTHETIC_CONTROL: control,
    MESH_SYNTHETIC_MARKER_DIR: markerDir,
    MESHFLEET_HOST_WORK: WORK,
    MESHFLEET_HOST_CLI: cli,
    MESHFLEET_EXTENSION_DIR: EXTENSION_DIR,
    AGENT_MESH_ROOT: ROOT,
    COUNCIL_ERROR_PINNED_PARENT: PINNED_PARENT,
  },
});

process.exit(typeof result === 'number' ? result : 0);
