#!/usr/bin/env node
/**
 * splice-binding-rules-count-cases.mjs
 *
 * Tick-158 refactor mirroring `splice-auth-snapshot-cases.mjs` (tick-54):
 * single-shot splicer for the binding rule-count corpus addition. Backs up
 * the live corpus to `test/fixtures/a2a/local-admission/v0.1/
 * corpus.json.pristine-49` (already checked in as a tick-158 fixture; this
 * `copyFileSync` is a safety net if a fresh clone omits the fixture) and
 * then delegates the splice to `gen-binding-rules-count-cases.mjs` via
 * dynamic import.
 *
 * No shell, no IPC, no /tmp sentinel. Subsequent runs of the generator
 * refuse to re-splice because the writer requires the corpus to still be
 * in the 49-case pristine shape.
 */
import { readFileSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpusPath = join(root, "test", "fixtures", "a2a", "local-admission", "v0.1", "corpus.json");
const backupPath = join(root, "test", "fixtures", "a2a", "local-admission", "v0.1", "corpus.json.pristine-49");

if (!existsSync(corpusPath)) throw new Error(`corpus missing: ${corpusPath}`);
if (!existsSync(backupPath)) copyFileSync(corpusPath, backupPath);
console.log(`pristine-49 backup present: ${backupPath} (${readFileSync(backupPath, "utf8").length} bytes)`);

const generator = join(root, "scripts", "gen-binding-rules-count-cases.mjs");
await import(generator);
