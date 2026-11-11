import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  canonicalEnvelopeDigest,
  decodeEnvelope,
  encodeEnvelope,
  validateEnvelope,
} from "../src/a2a/codec.js";
import { validateStaticHarnessMapping } from "../src/a2a/static-harness-mapping.js";
import {
  A2A_KIND,
  A2A_PROTOCOL,
  A2A_VERSION,
  type A2AEnvelopeV01,
} from "../src/a2a/types.js";

const root = process.cwd();
const sidecarPath = join(
  root,
  "test",
  "fixtures",
  "a2a",
  "local-admission",
  "v0.1",
  "static-harness-mappings.json",
);

type SidecarFixture = {
  positive: Array<{ id: string; mapping: unknown }>;
  negative: Array<{ id: string; mapping: unknown }>;
};

const fixture = JSON.parse(readFileSync(sidecarPath, "utf8")) as SidecarFixture;

/**
 * Maps a validated static-harness mapping sidecar into a canonical A2A envelope shape.
 * As established by the A2A v0.1 spec and local admission contracts:
 * - The static-harness mapping preserves opaque static metadata under extensions without promoting them to protocol authority.
 * - Envelope protocol, version, kind, message_id, sender, recipients, type, issued_at_ms, and payload adhere to A2AEnvelopeV01.
 */
function toA2AEnvelope(
  mappingInput: unknown,
  overrides: Partial<A2AEnvelopeV01> = {},
): A2AEnvelopeV01 {
  const validated = validateStaticHarnessMapping(mappingInput);
  const envelope: A2AEnvelopeV01 = {
    protocol: A2A_PROTOCOL,
    version: A2A_VERSION,
    kind: A2A_KIND,
    message_id: `msg-static-harness-${validated.target}`,
    sender: { namespace: "mesh-local", agent_id: `harness-${validated.target}` },
    recipients: [{ namespace: "mesh-local", agent_id: "coordinator" }],
    type: "handoff",
    issued_at_ms: 1_000,
    payload: {
      media_type: "application/json",
      body: JSON.stringify({
        target: validated.target,
        status: validated.status,
      }),
    },
    extensions: {
      static_harness_mapping: validated,
    },
    ...overrides,
  };
  return envelope;
}

test("every positive static-harness case maps to a valid A2A envelope shape", () => {
  assert.equal(fixture.positive.length, 7);

  const targetsCovered = new Set<string>();

  for (const item of fixture.positive) {
    const validatedMapping = validateStaticHarnessMapping(item.mapping);
    targetsCovered.add(validatedMapping.target);

    const rawEnvelope = toA2AEnvelope(item.mapping);

    // Validate envelope structure and constraints via A2A codec
    const envelope = validateEnvelope(rawEnvelope);
    assert.equal(envelope.protocol, A2A_PROTOCOL);
    assert.equal(envelope.version, A2A_VERSION);
    assert.equal(envelope.kind, A2A_KIND);
    assert.equal(envelope.message_id, `msg-static-harness-${validatedMapping.target}`);
    assert.deepEqual(envelope.sender, {
      namespace: "mesh-local",
      agent_id: `harness-${validatedMapping.target}`,
    });
    assert.deepEqual(envelope.recipients, [
      { namespace: "mesh-local", agent_id: "coordinator" },
    ]);
    assert.equal(envelope.type, "handoff");
    assert.equal(envelope.issued_at_ms, 1_000);
    assert.equal(envelope.payload.media_type, "application/json");

    // Extensions retain the exact static harness sidecar mapping
    assert.deepEqual(envelope.extensions, {
      static_harness_mapping: validatedMapping,
    });

    // Check JSON round-trip and canonical encoding
    const encoded = encodeEnvelope(envelope);
    const decoded = decodeEnvelope(encoded);
    assert.deepEqual(decoded, envelope);

    // Ensure canonical envelope digest computes deterministically
    const digest = canonicalEnvelopeDigest(envelope);
    assert.match(digest, /^meshfleet\.a2a\.fingerprint\.v1:sha256:[0-9a-f]{64}$/);
    assert.equal(digest, canonicalEnvelopeDigest(decoded));
  }

  // Ensure all 7 defined target harnesses are covered
  assert.deepEqual(
    Array.from(targetsCovered).sort(),
    [
      "antigravity-gemini",
      "claude-code",
      "codex",
      "codex-cli",
      "grok",
      "opencode",
      "unknown-harness",
    ].sort(),
  );
});

test("mapping retains sidecar claims as opaque data and never leaks into protocol authority", () => {
  for (const item of fixture.positive) {
    const envelope = validateEnvelope(toA2AEnvelope(item.mapping));
    const raw = envelope as unknown as Record<string, unknown>;

    // Target, status, losses must NOT exist at the top-level envelope authority
    assert.equal(raw.target, undefined);
    assert.equal(raw.status, undefined);
    assert.equal(raw.losses, undefined);
    assert.equal(raw.authentication_evidence, undefined);
    assert.equal(raw.principal_binding_input, undefined);

    const ext = envelope.extensions?.static_harness_mapping as Record<string, unknown>;
    assert.ok(ext);
    assert.equal(ext.sidecar_version, "meshfleet.a2a.static-harness-mapping.v0.1");
    assert.equal(ext.authentication_evidence, null);
    assert.equal(ext.principal_binding_input, null);
  }
});

test("invalid and negative static-harness cases fail before generating an A2A envelope", () => {
  assert.equal(fixture.negative.length, 14);

  for (const item of fixture.negative) {
    assert.throws(
      () => toA2AEnvelope(item.mapping),
      /invalid static harness mapping/,
      item.id,
    );
  }
});

test("envelopes carrying static-harness extensions enforce envelope bounds and validations", () => {
  const validPositive = fixture.positive[0]!;

  // 1. Sender cannot be recipient
  assert.throws(
    () =>
      validateEnvelope(
        toA2AEnvelope(validPositive.mapping, {
          recipients: [{ namespace: "mesh-local", agent_id: "harness-codex" }],
        }),
      ),
    /sender must not be a recipient/,
  );

  // 2. Wildcard recipient rejected
  assert.throws(
    () =>
      validateEnvelope(
        toA2AEnvelope(validPositive.mapping, {
          recipients: [{ namespace: "mesh-local", agent_id: "*" }],
        }),
      ),
    /must not contain a wildcard/,
  );

  // 3. Duplicate recipients rejected
  assert.throws(
    () =>
      validateEnvelope(
        toA2AEnvelope(validPositive.mapping, {
          recipients: [
            { namespace: "mesh-local", agent_id: "coordinator" },
            { namespace: "mesh-local", agent_id: "coordinator" },
          ],
        }),
      ),
    /recipients must be unique/,
  );

  // 4. Expiry must exceed issued_at_ms
  assert.throws(
    () =>
      validateEnvelope(
        toA2AEnvelope(validPositive.mapping, {
          expires_at_ms: 500,
        }),
      ),
    /expires_at_ms must be greater than issued_at_ms/,
  );
});
