#!/usr/bin/env node
// Splice update: fix the expires-not-after-issued case (tick 56).
// The TS strict decoder reports the emitted `expires_at_ms must be greater
// than issued_at_ms` message, which projects to expires_at_ms (it contains the
// literal "issued_at_ms", and the TS regex alternation picks the FIRST
// alternative in the message text). The Python witness reports issued_at_ms
// because its scan of the same message text finds "issued_at_ms" first.
// Both are member-exact for their language; the corpus must pin the TS byte.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpusPath = join(root, "test", "fixtures", "a2a", "local-admission", "v0.1", "corpus.json");
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));

const item = corpus.cases.find((c) => c.id === "envelope.expires-not-after-issued");
if (!item) throw new Error("case envelope.expires-not-after-issued missing");
item.expected.result.field_path = "$.envelope.expires_at_ms";

writeFileSync(corpusPath, JSON.stringify(corpus));
console.log(`pinned envelope.expires-not-after-issued -> $.envelope.expires_at_ms`);
