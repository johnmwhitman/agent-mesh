#!/usr/bin/env node
/**
 * splice-auth-snapshot-cases.mjs
 *
 * Tick-54 precedent (tick-51/52): regenerate the local-admission corpus with
 * the authorization-snapshot field/grammar gates appended, backing up the
 * pristine corpus first. Re-running restores from the backup (idempotent).
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpusPath = join(root, "test", "fixtures", "a2a", "local-admission", "v0.1", "corpus.json");
const backupPath = join(root, "test", "fixtures", "a2a", "local-admission", "v0.1", "corpus.json.pristine-44");

if (!existsSync(corpusPath)) throw new Error(`corpus missing: ${corpusPath}`);
copyFileSync(corpusPath, backupPath);
console.log(`backed up pristine corpus (${readFileSync(corpusPath, "utf8").length} bytes) -> ${backupPath}`);

const generator = join(root, "scripts", "gen-auth-snapshot-cases.mjs");
await import(generator);
