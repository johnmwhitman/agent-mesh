#!/usr/bin/env node
/**
 * Hosted Ubuntu regression for Council-error (lives under editors/vscode/council-error-host/).
 * Requires positive Extension Host result. No tip apply — postimages already in this branch.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(HERE, '..');
const ROOT = process.env.AGENT_MESH_ROOT || path.resolve(EXTENSION_DIR, '..', '..');
const WORK = process.env.WORK_DIR || mkdtempSync(path.join(tmpdir(), 'council-error-host-'));
const PINNED_PARENT = 'ba64af08ca4cefa0009edffc8b82dd58c2680f40';
const HOST_DEPS = Object.freeze({
  '@vscode/test-electron': '2.4.1',
  mocha: '10.7.3',
});

function run(argv, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: opts.cwd || ROOT,
      env: { ...process.env, ...(opts.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

async function main() {
  mkdirSync(WORK, { recursive: true });
  chmodSync(path.join(HERE, 'synthetic-meshfleet-cli.js'), 0o755);
  chmodSync(path.join(HERE, 'runTest.mjs'), 0o755);

  // Pin checks for accepted app/test postimages
  const ext = path.join(EXTENSION_DIR, 'src', 'extension.ts');
  const tst = path.join(EXTENSION_DIR, 'src', 'refresh.test.ts');
  const extHash = sha256File(ext);
  const tstHash = sha256File(tst);
  if (extHash !== '0a492c29c42d4d7ed3f16a04e7bc3a50626f19d90ab3bd1b40b3d3acd544b369') {
    console.error('extension.ts postimage mismatch', extHash);
    process.exit(2);
  }
  if (tstHash !== 'e5e671f8f2b53bb9f1ae06114c695224a812b3f71e49afd0fac011757cc68410') {
    console.error('refresh.test.ts postimage mismatch', tstHash);
    process.exit(2);
  }

  const npmCi = await run(['npm', 'ci'], { cwd: EXTENSION_DIR });
  if (npmCi.code !== 0) {
    console.error('npm ci failed', npmCi.stderr);
    process.exit(npmCi.code);
  }
  const hostDeps = await run(
    [
      'npm', 'install', '--no-save', '--no-package-lock',
      `@vscode/test-electron@${HOST_DEPS['@vscode/test-electron']}`,
      `mocha@${HOST_DEPS.mocha}`,
    ],
    { cwd: EXTENSION_DIR },
  );
  if (hostDeps.code !== 0) {
    console.error('host deps install failed', hostDeps.stderr);
    process.exit(hostDeps.code);
  }
  if (
    !existsSync(path.join(EXTENSION_DIR, 'node_modules', '@vscode', 'test-electron', 'package.json')) ||
    !existsSync(path.join(EXTENSION_DIR, 'node_modules', 'mocha', 'package.json'))
  ) {
    console.error('HOST_DEPS_REQUIRED');
    process.exit(2);
  }

  // Unit regression on refresh.test postimage
  const tsc = path.join(EXTENSION_DIR, 'node_modules', 'typescript', 'bin', 'tsc');
  const outDir = path.join(WORK, 'compiled');
  mkdirSync(outDir, { recursive: true });
  const compile = await run([
    process.execPath, tsc,
    '--strict', '--esModuleInterop', '--skipLibCheck',
    '--target', 'ES2022', '--module', 'commonjs', '--moduleResolution', 'node',
    '--types', 'node',
    '--typeRoots', path.join(EXTENSION_DIR, 'node_modules', '@types'),
    '--outDir', outDir,
    path.join(EXTENSION_DIR, 'src', 'refresh.ts'),
    path.join(EXTENSION_DIR, 'src', 'refresh.test.ts'),
  ]);
  if (compile.code !== 0) {
    console.error('fixture-compile failed', compile.stderr || compile.stdout);
    process.exit(compile.code);
  }
  const unit = await run([
    process.execPath, '--test', '--test-reporter=tap',
    path.join(outDir, 'refresh.test.js'),
  ]);
  process.stdout.write(unit.stdout);
  if (unit.code !== 0) {
    console.error('unit regression failed', unit.stderr);
    process.exit(unit.code);
  }

  const host = await run([process.execPath, path.join(HERE, 'runTest.mjs')], {
    cwd: EXTENSION_DIR,
    env: {
      AGENT_MESH_ROOT: ROOT,
      WORK_DIR: WORK,
      MESHFLEET_EXTENSION_DIR: EXTENSION_DIR,
      DISPLAY: process.env.DISPLAY || ':99',
      COUNCIL_ERROR_PINNED_PARENT: PINNED_PARENT,
    },
  });
  process.stdout.write(host.stdout);
  if (host.stderr) process.stderr.write(host.stderr);
  if (host.code !== 0) {
    console.error('extension-host required positive result; got', host.code);
    process.exit(host.code || 1);
  }

  const report = {
    agent_mesh_root: ROOT,
    work_dir: WORK,
    pinned_parent: PINNED_PARENT,
    unit_exit: unit.code,
    extension_host_exit: host.code,
    postimages: { extension: extHash, refresh_test: tstHash },
    host_deps: HOST_DEPS,
    extension_host: 'HOSTED_EXTENSION_HOST_OK',
  };
  writeFileSync(path.join(WORK, 'REPORT.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  console.log('HOSTED_METHOD_OK');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
