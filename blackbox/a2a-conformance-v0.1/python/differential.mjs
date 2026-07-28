#!/usr/bin/env node

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const MAX_RECEIPT_BYTES = 4 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const EXPECTED_PROFILES = [
  "synthetic-wire-profile-01-rocket-🚀",
  "synthetic-wire-profile-02",
].sort();
const EXPECTED_NODE_CHECKS = [
  "fixtures-and-mutations",
  ...EXPECTED_PROFILES.map((name) => `wire:${name}`),
].sort();
const EXPECTED_PYTHON_CHECKS = [
  "actual_server_process",
  "bounded_failure_teardown",
  "byte_fragmented_non_bmp_utf8",
  "coalesced_multi_message_write",
  "complete_stdout_validation",
  "dependency_free_python_client",
  "minimal_child_environment",
  "redirected_named_meshfleet_state",
  "runtime_command_bound_to_pinned_entrypoint",
  "shared_language_neutral_fixture",
].sort();
const EXPECTED_ARTIFACTS = {
  contract_sha256:
    "4bf91354d2ad4ddc989b1f534e04007ecc9686ac4103890301c0b8bd265e6e46",
  server_entrypoint_sha256:
    "0feafb7e91be814f549b49af6b089be138784cf03ef6ff8815da8fb2bd02ce78",
  shared_fixture_sha256:
    "b88f4c390528714a704e09fdc3fa17add4d03925191bf2924299a8e8dc1d222c",
};

function assertObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
}

function assertProfileName(value, label) {
  if (typeof value !== "string"
      || value.length === 0
      || value !== value.trim()
      || value !== value.normalize("NFC")
      || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be a nonempty, trimmed NFC string`);
  }
}

function assertNoDuplicateJsonMembers(text, label) {
  let index = 0;
  const fail = (message) => {
    throw new Error(`${label} contains invalid JSON: ${message}`);
  };
  const skipWhitespace = () => {
    while (index < text.length && /[\u0009\u000a\u000d\u0020]/u.test(text[index])) {
      index += 1;
    }
  };
  const parseString = () => {
    if (text[index] !== "\"") fail("expected string");
    const start = index;
    index += 1;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code < 0x20) fail("control character in string");
      if (text[index] === "\\") {
        index += 2;
        continue;
      }
      if (text[index] === "\"") {
        index += 1;
        try {
          return JSON.parse(text.slice(start, index));
        } catch (error) {
          fail(error.message);
        }
      }
      index += 1;
    }
    fail("unterminated string");
  };
  const parseValue = (depth) => {
    if (depth > 128) fail("nesting exceeds 128");
    skipWhitespace();
    if (text[index] === "{") {
      index += 1;
      skipWhitespace();
      const keys = new Set();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      while (index < text.length) {
        const key = parseString();
        if (keys.has(key)) fail(`duplicate JSON member ${JSON.stringify(key)}`);
        keys.add(key);
        skipWhitespace();
        if (text[index] !== ":") fail("expected colon");
        index += 1;
        parseValue(depth + 1);
        skipWhitespace();
        if (text[index] === "}") {
          index += 1;
          return;
        }
        if (text[index] !== ",") fail("expected comma");
        index += 1;
        skipWhitespace();
      }
      fail("unterminated object");
    }
    if (text[index] === "[") {
      index += 1;
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      while (index < text.length) {
        parseValue(depth + 1);
        skipWhitespace();
        if (text[index] === "]") {
          index += 1;
          return;
        }
        if (text[index] !== ",") fail("expected comma");
        index += 1;
        skipWhitespace();
      }
      fail("unterminated array");
    }
    if (text[index] === "\"") {
      parseString();
      return;
    }
    const start = index;
    while (index < text.length
        && !/[\u0009\u000a\u000d\u0020,\]}]/u.test(text[index])) {
      index += 1;
    }
    if (start === index) fail("expected value");
  };

  parseValue(0);
  skipWhitespace();
  if (index !== text.length) fail("trailing content");
}

function readBoundedReceipt(inputPath, label) {
  const receiptPath = resolve(inputPath);
  const initial = lstatSync(receiptPath);
  if (initial.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link`);
  }
  if (!initial.isFile()) {
    throw new Error(`${label} must be a regular file`);
  }

  const noFollow = constants.O_NOFOLLOW ?? 0;
  const fd = openSync(receiptPath, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) {
      throw new Error(`${label} must remain a regular file when opened`);
    }
    if (opened.size > MAX_RECEIPT_BYTES) {
      throw new Error(`${label} exceeds the ${MAX_RECEIPT_BYTES}-byte cap`);
    }

    const bounded = Buffer.allocUnsafe(MAX_RECEIPT_BYTES + 1);
    let length = 0;
    while (length < bounded.length) {
      const count = readSync(fd, bounded, length, bounded.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_RECEIPT_BYTES) {
      throw new Error(`${label} exceeds the ${MAX_RECEIPT_BYTES}-byte cap`);
    }

    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true })
        .decode(bounded.subarray(0, length));
    } catch {
      throw new Error(`${label} is not valid UTF-8`);
    }
    if (!text.endsWith("\n") || text.includes("\r")) {
      throw new Error(`${label} must be one LF-terminated JSON line`);
    }
    const body = text.slice(0, -1);
    if (body.length === 0 || body.includes("\n")) {
      throw new Error(`${label} must contain exactly one JSON line`);
    }
    assertNoDuplicateJsonMembers(body, label);

    let receipt;
    try {
      receipt = JSON.parse(body);
    } catch (error) {
      throw new Error(`${label} contains invalid JSON: ${error.message}`);
    }
    assertObject(receipt, label);
    return receipt;
  } finally {
    closeSync(fd);
  }
}

function compareReceipts(nodeReceipt, pythonReceipt) {
  if (nodeReceipt.preamble !== "Meshfleet raw stdio wire conformance v0.1"
      || pythonReceipt.schema_version !== "0.1"
      || pythonReceipt.witness !== "meshfleet-python-raw-stdio-parity") {
    throw new Error("witness receipt identity or schema differs");
  }
  if (nodeReceipt.passed !== true || pythonReceipt.result !== "PASS") {
    throw new Error("one witness did not pass independently");
  }
  if (!SHA256_PATTERN.test(nodeReceipt.expected_catalog_sha256 ?? "")
      || !SHA256_PATTERN.test(pythonReceipt.catalog_sha256 ?? "")) {
    throw new Error("witness catalog digests must be lowercase SHA-256 values");
  }
  if (nodeReceipt.expected_catalog_sha256 !== pythonReceipt.catalog_sha256) {
    throw new Error("Node and Python catalog digests differ");
  }
  if (!Array.isArray(nodeReceipt.checks)
      || !Array.isArray(pythonReceipt.profiles)) {
    throw new Error("witness receipt collections are missing");
  }
  if (!SHA256_PATTERN.test(
    pythonReceipt.normalized_transcript_sha256 ?? "",
  )) {
    throw new Error(
      "Python aggregate transcript digest must be lowercase SHA-256",
    );
  }
  for (const [field, expected] of Object.entries(EXPECTED_ARTIFACTS)) {
    if (pythonReceipt[field] !== expected) {
      throw new Error(`Python ${field} differs from the v0.1 pin`);
    }
  }
  assertObject(pythonReceipt.checks, "Python checks");
  const pythonCheckNames = Object.keys(pythonReceipt.checks).sort();
  if (JSON.stringify(pythonCheckNames) !== JSON.stringify(EXPECTED_PYTHON_CHECKS)
      || pythonCheckNames.some((name) => pythonReceipt.checks[name] !== true)) {
    throw new Error("Python witness check coverage differs from v0.1");
  }

  const nodeCheckIds = nodeReceipt.checks.map((entry) => {
    assertObject(entry, "Node check");
    if (typeof entry.id !== "string" || typeof entry.status !== "string") {
      throw new Error("Node check fields are invalid");
    }
    return entry.id;
  });
  if (new Set(nodeCheckIds).size !== nodeCheckIds.length) {
    throw new Error("Node check identities must be unique");
  }
  if (JSON.stringify([...nodeCheckIds].sort())
      !== JSON.stringify(EXPECTED_NODE_CHECKS)) {
    throw new Error("Node witness check coverage differs from v0.1");
  }
  const nodeWireChecks = nodeReceipt.checks.filter(
    (entry) => entry.id.startsWith("wire:"),
  );
  if (nodeWireChecks.some((entry) => entry.status !== "pass")) {
    throw new Error("every Node wire check must pass");
  }
  const nodeProfiles = nodeWireChecks.map((entry) => {
    const name = entry.id.slice("wire:".length);
    assertProfileName(name, "Node profile");
    return name;
  }).sort();
  const pythonProfiles = pythonReceipt.profiles.map((entry) => {
    assertObject(entry, "Python profile");
    assertProfileName(entry.name, "Python profile");
    if (!SHA256_PATTERN.test(entry.normalized_transcript_sha256 ?? "")) {
      throw new Error("Python profile fields are invalid");
    }
    return entry.name;
  }).sort();
  if (nodeProfiles.length === 0 || pythonProfiles.length === 0) {
    throw new Error("witness profile collections must not be empty");
  }
  if (new Set(nodeProfiles).size !== nodeProfiles.length
      || new Set(pythonProfiles).size !== pythonProfiles.length) {
    throw new Error("witness profile identities must be unique");
  }
  if (JSON.stringify(nodeProfiles) !== JSON.stringify(pythonProfiles)) {
    throw new Error("Node and Python profile identities differ");
  }
  if (JSON.stringify(nodeProfiles) !== JSON.stringify(EXPECTED_PROFILES)) {
    throw new Error("witness profiles differ from the pinned v0.1 profiles");
  }

  const mutationChecks = nodeReceipt.checks.filter(
    (entry) => entry.id === "fixtures-and-mutations",
  );
  if (mutationChecks.length !== 1
      || mutationChecks[0].status !== "pass"
      || typeof mutationChecks[0].detail !== "string"
      || mutationChecks[0].detail.length === 0) {
    throw new Error("Node shared-fixture mutation check did not pass");
  }
  const mutationCheck = mutationChecks[0];
  const normalizedDigests = pythonReceipt.profiles.map(
    (entry) => entry.normalized_transcript_sha256,
  );
  if (new Set(normalizedDigests).size !== 1) {
    throw new Error("Python profile-normalized transcripts differ");
  }
  if (pythonReceipt.normalized_transcript_sha256 !== normalizedDigests[0]) {
    throw new Error("Python aggregate normalized transcript digest differs");
  }

  return {
    schema_version: "0.1",
    witness: "meshfleet-node-python-stdio-differential",
    catalog_sha256: pythonReceipt.catalog_sha256,
    profiles: pythonProfiles,
    node_mutations: mutationCheck.detail,
    python_normalized_transcript_sha256:
      pythonReceipt.normalized_transcript_sha256,
    python_artifacts: EXPECTED_ARTIFACTS,
    receipt_provenance: "UNAUTHENTICATED_LOCAL_FILES",
    result: "PASS",
  };
}

function expectFailure(checks, id, action, pattern) {
  try {
    action();
  } catch (error) {
    if (!pattern.test(error.message)) throw error;
    checks.push({ id, status: "pass" });
    return;
  }
  throw new Error(`${id} unexpectedly passed`);
}

function runSelfTest() {
  const directory = mkdtempSync(join(tmpdir(), "meshfleet-receipt-compare-"));
  const digestA = "a".repeat(64);
  const digestB = "b".repeat(64);
  const nodeReceipt = {
    preamble: "Meshfleet raw stdio wire conformance v0.1",
    passed: true,
    expected_catalog_sha256: digestA,
    checks: [
      { id: `wire:${EXPECTED_PROFILES[0]}`, status: "pass" },
      { id: `wire:${EXPECTED_PROFILES[1]}`, status: "pass" },
      { id: "fixtures-and-mutations", status: "pass", detail: "9/9" },
    ],
  };
  const pythonReceipt = {
    schema_version: "0.1",
    witness: "meshfleet-python-raw-stdio-parity",
    result: "PASS",
    catalog_sha256: digestA,
    profiles: EXPECTED_PROFILES.map((name) => ({
      name,
      normalized_transcript_sha256: digestB,
    })),
    normalized_transcript_sha256: digestB,
    checks: Object.fromEntries(
      EXPECTED_PYTHON_CHECKS.map((name) => [name, true]),
    ),
    ...EXPECTED_ARTIFACTS,
  };
  const checks = [];
  const writeReceipt = (name, value) => {
    const path = join(directory, name);
    writeFileSync(path, `${JSON.stringify(value)}\n`);
    return path;
  };

  try {
    const nodePath = writeReceipt("node.json", nodeReceipt);
    const pythonPath = writeReceipt("python.json", pythonReceipt);
    compareReceipts(
      readBoundedReceipt(nodePath, "Node receipt"),
      readBoundedReceipt(pythonPath, "Python receipt"),
    );
    checks.push({ id: "valid-receipts", status: "pass" });

    const extraPath = join(directory, "extra.json");
    writeFileSync(extraPath, "{}\n{}\n");
    expectFailure(
      checks,
      "extra-line",
      () => readBoundedReceipt(extraPath, "test receipt"),
      /exactly one/u,
    );
    const crlfPath = join(directory, "crlf.json");
    writeFileSync(crlfPath, "{}\r\n");
    expectFailure(
      checks,
      "crlf",
      () => readBoundedReceipt(crlfPath, "test receipt"),
      /LF-terminated/u,
    );
    const noLfPath = join(directory, "no-lf.json");
    writeFileSync(noLfPath, "{}");
    expectFailure(
      checks,
      "missing-lf",
      () => readBoundedReceipt(noLfPath, "test receipt"),
      /LF-terminated/u,
    );
    const utf8Path = join(directory, "utf8.json");
    writeFileSync(utf8Path, Buffer.from([0xff, 0x0a]));
    expectFailure(
      checks,
      "malformed-utf8",
      () => readBoundedReceipt(utf8Path, "test receipt"),
      /valid UTF-8/u,
    );
    const oversizedPath = join(directory, "oversized.json");
    writeFileSync(oversizedPath, Buffer.alloc(MAX_RECEIPT_BYTES + 1, 0x20));
    expectFailure(
      checks,
      "oversized",
      () => readBoundedReceipt(oversizedPath, "test receipt"),
      /exceeds/u,
    );
    const arrayPath = join(directory, "array.json");
    writeFileSync(arrayPath, "[]\n");
    expectFailure(
      checks,
      "non-object-root",
      () => readBoundedReceipt(arrayPath, "test receipt"),
      /JSON object/u,
    );
    const duplicateMemberPath = join(directory, "duplicate-member.json");
    writeFileSync(
      duplicateMemberPath,
      "{\"passed\":false,\"passed\":true}\n",
    );
    expectFailure(
      checks,
      "duplicate-json-member",
      () => readBoundedReceipt(duplicateMemberPath, "test receipt"),
      /duplicate JSON member/u,
    );
    expectFailure(
      checks,
      "non-regular-file",
      () => readBoundedReceipt(directory, "test receipt"),
      /regular file/u,
    );
    const mismatched = {
      ...pythonReceipt,
      catalog_sha256: "c".repeat(64),
    };
    expectFailure(
      checks,
      "catalog-mismatch",
      () => compareReceipts(nodeReceipt, mismatched),
      /digests differ/u,
    );
    expectFailure(
      checks,
      "failed-pass-marker",
      () => compareReceipts({ ...nodeReceipt, passed: false }, pythonReceipt),
      /did not pass/u,
    );
    expectFailure(
      checks,
      "wrong-witness-identity",
      () => compareReceipts(
        nodeReceipt,
        { ...pythonReceipt, witness: "forged" },
      ),
      /identity or schema differs/u,
    );
    expectFailure(
      checks,
      "artifact-pin-mismatch",
      () => compareReceipts(nodeReceipt, {
        ...pythonReceipt,
        shared_fixture_sha256: "c".repeat(64),
      }),
      /shared_fixture_sha256 differs/u,
    );
    expectFailure(
      checks,
      "incomplete-python-checks",
      () => compareReceipts(nodeReceipt, {
        ...pythonReceipt,
        checks: {
          ...pythonReceipt.checks,
          complete_stdout_validation: false,
        },
      }),
      /check coverage differs/u,
    );
    expectFailure(
      checks,
      "uppercase-digest",
      () => compareReceipts(
        { ...nodeReceipt, expected_catalog_sha256: digestA.toUpperCase() },
        pythonReceipt,
      ),
      /lowercase SHA-256/u,
    );
    expectFailure(
      checks,
      "failed-wire-check",
      () => compareReceipts({
        ...nodeReceipt,
        checks: nodeReceipt.checks.map((entry) => (
          entry.id === `wire:${EXPECTED_PROFILES[0]}`
            ? { ...entry, status: "fail" }
            : entry
        )),
      }, pythonReceipt),
      /wire check must pass/u,
    );
    expectFailure(
      checks,
      "empty-profiles",
      () => compareReceipts(
        nodeReceipt,
        { ...pythonReceipt, profiles: [] },
      ),
      /must not be empty/u,
    );
    expectFailure(
      checks,
      "duplicate-profiles",
      () => compareReceipts(nodeReceipt, {
        ...pythonReceipt,
        profiles: [
          pythonReceipt.profiles[0],
          pythonReceipt.profiles[0],
        ],
      }),
      /must be unique/u,
    );
    expectFailure(
      checks,
      "profile-set-mismatch",
      () => compareReceipts(nodeReceipt, {
        ...pythonReceipt,
        profiles: pythonReceipt.profiles.map((entry, index) => (
          index === 0 ? { ...entry, name: "different" } : entry
        )),
      }),
      /identities differ|pinned v0\.1 profiles/u,
    );
    expectFailure(
      checks,
      "missing-mutation-check",
      () => compareReceipts({
        ...nodeReceipt,
        checks: nodeReceipt.checks.filter(
          (entry) => entry.id !== "fixtures-and-mutations",
        ),
      }, pythonReceipt),
      /check coverage differs|mutation check did not pass/u,
    );
    expectFailure(
      checks,
      "per-profile-digest-mismatch",
      () => compareReceipts(nodeReceipt, {
        ...pythonReceipt,
        profiles: pythonReceipt.profiles.map((entry, index) => (
          index === 0
            ? { ...entry, normalized_transcript_sha256: "c".repeat(64) }
            : entry
        )),
      }),
      /normalized transcripts differ/u,
    );
    expectFailure(
      checks,
      "aggregate-digest-mismatch",
      () => compareReceipts(nodeReceipt, {
        ...pythonReceipt,
        normalized_transcript_sha256: "c".repeat(64),
      }),
      /aggregate normalized transcript digest differs/u,
    );
    if (process.platform !== "win32") {
      const symlinkPath = join(directory, "receipt-link.json");
      symlinkSync(basename(nodePath), symlinkPath);
      expectFailure(
        checks,
        "symlink",
        () => readBoundedReceipt(symlinkPath, "test receipt"),
        /symbolic link/u,
      );
    }

    process.stdout.write(`${JSON.stringify({
      schema_version: "0.1",
      witness: "meshfleet-receipt-comparator-self-test",
      checks,
      result: "PASS",
    })}\n`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv.length === 3 && process.argv[2] === "--self-test") {
  runSelfTest();
} else {
  if (process.argv.length !== 4) {
    throw new Error(
      "usage: differential.mjs <node-receipt.json> <python-receipt.json>",
    );
  }
  const nodeReceipt = readBoundedReceipt(process.argv[2], "Node receipt");
  const pythonReceipt = readBoundedReceipt(process.argv[3], "Python receipt");
  process.stdout.write(
    `${JSON.stringify(compareReceipts(nodeReceipt, pythonReceipt))}\n`,
  );
}
