#!/usr/bin/env node
/**
 * splice-request-boundary-cases.mjs
 *
 * Tick-160 (mirror of tick-158 / 4aced61 + tick-159 / b45c2f8):
 * single-shot splicer for the request-boundary corpus addition (4C-1
 * BOM-path slice: 7 cases).
 *
 * Backs up the live corpus to
 * `test/fixtures/a2a/local-admission/v0.1/corpus.json.pristine-73`
 * (already checked in as the canonical 70-case root for this slice)
 * and then delegates the splice to
 * `gen-request-boundary-cases.mjs` via dynamic import.
 *
 * Tick-159/4aced61 contract (mirror of b45c2f8 for auth-snapshot): the
 * `copyFileSync` is a safety net for fresh clones that omit the
 * fixture, so it MUST NOT clobber the committed pristine sentinel:
 * it runs only when the backup is missing. Subsequent runs on a
 * post-splice corpus log "backup present; not overwriting" instead
 * of overwriting the sentinel. The generator's `mandatory_case_ids`
 * collision + length/id-drift checks refuse partial re-splice on
 * the 77-case post-splice state.
 *
 * No shell, no IPC, no /tmp sentinel.
 */
import { readFileSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpusPath = join(root, "test", "fixtures", "a2a", "local-admission", "v0.1", "corpus.json");
const backupPath = join(root, "test", "fixtures", "a2a", "local-admission", "v0.1", "corpus.json.pristine-73");

if (!existsSync(corpusPath)) throw new Error(`corpus missing: ${corpusPath}`);
if (!existsSync(backupPath)) {
  copyFileSync(corpusPath, backupPath);
  console.log(`created pristine-73 backup (${readFileSync(backupPath, "utf8").length} bytes) -> ${backupPath}`);
} else {
  console.log(`pristine-73 backup present: ${backupPath} (${readFileSync(backupPath, "utf8").length} bytes); not overwriting`);
}

const generator = join(root, "scripts", "gen-request-boundary-cases.mjs");
await import(generator);
