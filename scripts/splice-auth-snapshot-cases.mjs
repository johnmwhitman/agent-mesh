#!/usr/bin/env node
/**
 * splice-auth-snapshot-cases.mjs
 *
 * Tick-159 (mirror of tick-158 / 4aced61): regenerate the local-admission
 * corpus with the authorization-snapshot field/grammar gates appended.
 *
 * The in-repo pristine sentinel `corpus.json.pristine-44` is checked in as
 * the canonical 44-case root every generator hashes against. The `copyFileSync`
 * is a safety net for fresh clones that omit the fixture, so it MUST NOT
 * clobber the committed sentinel: it runs only when the backup is missing.
 *
 * The generator (`gen-auth-snapshot-cases.mjs`) refuses to re-splice if any
 * of the 18 auth-snapshot ids already exist in `mandatory_case_ids`, so a
 * re-run on a post-splice corpus is fail-safe; the untouched sentinel
 * remains the canonical 44-case root for downstream generators.
 */
import { readFileSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpusPath = join(root, "test", "fixtures", "a2a", "local-admission", "v0.1", "corpus.json");
const backupPath = join(root, "test", "fixtures", "a2a", "local-admission", "v0.1", "corpus.json.pristine-44");

if (!existsSync(corpusPath)) throw new Error(`corpus missing: ${corpusPath}`);
if (!existsSync(backupPath)) {
  copyFileSync(corpusPath, backupPath);
  console.log(`created pristine-44 backup (${readFileSync(backupPath, "utf8").length} bytes) -> ${backupPath}`);
} else {
  console.log(`pristine-44 backup present: ${backupPath} (${readFileSync(backupPath, "utf8").length} bytes); not overwriting`);
}

const generator = join(root, "scripts", "gen-auth-snapshot-cases.mjs");
await import(generator);
