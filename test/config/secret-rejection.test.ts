/**
 * Secret rejection tests.
 *
 * These tests prove that the canonical spec never contains inline credentials,
 * tokens, or secret-like env keys, and that renderers do not emit them.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { MESH_FLEET_STDIO } from "../../src/config/mcp-stdio-connection.js";
import {
  renderGenericMcpJson,
  renderOpenCodeJsonc,
  renderClaudeCodeMcpJson,
  renderCodexMcpJson,
} from "../../src/config/renderers/index.js";

const SECRET_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /token/i,
  /password/i,
  /private[_-]?key/i,
  /auth/i,
];

function containsSecretLike(value: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(value));
}

test("canonical spec envAllowlist contains no secret-like keys", () => {
  for (const key of MESH_FLEET_STDIO.envAllowlist) {
    assert.ok(
      !containsSecretLike(key),
      `envAllowlist must not contain secret-like key: ${key}`
    );
  }
});

test("canonical spec command/argv contains no secret-like values", () => {
  for (const part of MESH_FLEET_STDIO.command) {
    assert.ok(
      !containsSecretLike(part),
      `command must not contain secret-like value: ${part}`
    );
  }
});

test("all renderers produce output free of secret-like strings", () => {
  const renderers = [
    renderGenericMcpJson,
    renderOpenCodeJsonc,
    renderClaudeCodeMcpJson,
    renderCodexMcpJson,
  ];
  for (const render of renderers) {
    const result = render();
    const json = JSON.stringify(result);
    assert.ok(
      !containsSecretLike(json),
      `${result.target} output must not contain secret-like strings`
    );
  }
});

test("renderer result envelope never includes inline credentials", () => {
  const results = [
    renderGenericMcpJson(),
    renderOpenCodeJsonc(),
    renderClaudeCodeMcpJson(),
    renderCodexMcpJson(),
  ];
  for (const r of results) {
    const s = JSON.stringify(r);
    assert.ok(!/Bearer\s/i.test(s), `${r.target} must not contain Bearer tokens`);
    assert.ok(!/"[A-Za-z0-9+/]{20,}={0,2}"/.test(s), `${r.target} must not contain base64-looking secret values`);
  }
});
