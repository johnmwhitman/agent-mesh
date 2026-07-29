import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  parseMediaPlanIntent,
  parseMediaSubmission,
  canonicalMediaIntentSha256,
  MediaError,
  MEDIA_REQUEST_VERSION,
  type MediaPlanIntent,
  type ResolvedMediaRequest,
  type MediaSubmission,
} from "../src/media-execution/contract/requests.js";
import {
  type MediaOutputPolicy,
  type MediaClientContext,
  type MediaRoutePolicy,
  type PixelInputBase,
  type PixelRotate8Input,
  type PixelStateInput,
  type PixelAnimationInput,
} from "../src/media-execution/contract/operations.js";
import { type MediaArtifactHandle } from "../src/media-execution/contract/results.js";

// Valid fixtures for each of the 12 operations
function validImageGenerateIntent() {
  return {
    version: MEDIA_REQUEST_VERSION,
    idempotency_key: "idem-1",
    submitted_by: "artcraft",
    route: { allow_provider_change: false, maximum_attempts: 1 },
    output: { accepted_mime_types: ["image/png"], maximum_artifacts: 1, review: "none" as const },
    operation: "image.generate" as const,
    input: { prompt: "test", count: 1 },
  };
}

function validImageEditIntent() {
  return {
    version: MEDIA_REQUEST_VERSION,
    idempotency_key: "idem-2",
    submitted_by: "artcraft",
    route: { allow_provider_change: false, maximum_attempts: 1 },
    output: { accepted_mime_types: ["image/png"], maximum_artifacts: 1, review: "none" as const },
    operation: "image.edit" as const,
    input: { prompt: "edit", source: { artifact_id: "a1", execution_id: "e1", attempt_id: "t1", byte_length: 100, sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", media_class: "image" as const, mime_type: "image/png" } },
  };
}

function validVideoGenerateIntent() {
  return {
    version: MEDIA_REQUEST_VERSION,
    idempotency_key: "idem-3",
    submitted_by: "artcraft",
    route: { allow_provider_change: false, maximum_attempts: 1 },
    output: { accepted_mime_types: ["video/mp4"], maximum_artifacts: 1, review: "none" as const },
    operation: "video.generate" as const,
    input: { prompt: "video" },
  };
}

function validImageToVideoIntent() {
  return {
    version: MEDIA_REQUEST_VERSION,
    idempotency_key: "idem-4",
    submitted_by: "artcraft",
    route: { allow_provider_change: false, maximum_attempts: 1 },
    output: { accepted_mime_types: ["video/mp4"], maximum_artifacts: 1, review: "none" as const },
    operation: "video.image_to_video" as const,
    input: { first_frame: { artifact_id: "a1", execution_id: "e1", attempt_id: "t1", byte_length: 100, sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", media_class: "image" as const, mime_type: "image/png" } },
  };
}

function validTtsIntent() {
  return {
    version: MEDIA_REQUEST_VERSION,
    idempotency_key: "idem-5",
    submitted_by: "artcraft",
    route: { allow_provider_change: false, maximum_attempts: 1 },
    output: { accepted_mime_types: ["audio/wav"], maximum_artifacts: 1, review: "none" as const },
    operation: "audio.tts" as const,
    input: { text: "hello", voice: "default", format: "wav" as const },
  };
}

function validMusicIntent() {
  return {
    version: MEDIA_REQUEST_VERSION,
    idempotency_key: "idem-6",
    submitted_by: "artcraft",
    route: { allow_provider_change: false, maximum_attempts: 1 },
    output: { accepted_mime_types: ["audio/mp3"], maximum_artifacts: 1, review: "none" as const },
    operation: "audio.music" as const,
    input: { prompt: "music", instrumental: true, auto_lyrics: false, format: "mp3" as const },
  };
}

function validPixelImageIntent() {
  return {
    version: MEDIA_REQUEST_VERSION,
    idempotency_key: "idem-7",
    submitted_by: "sprite-factory",
    route: { allow_provider_change: false, maximum_attempts: 1 },
    output: { accepted_mime_types: ["application/vnd.meshfleet.pixel-bundle.v1"], maximum_artifacts: 1, review: "none" as const },
    operation: "pixel.image" as const,
    input: { prompt: "pixel", width_px: 32, height_px: 32, transparent: false, license_declaration: "CC0" },
  };
}

function validPixelCharacterIntent() {
  return {
    version: MEDIA_REQUEST_VERSION,
    idempotency_key: "idem-8",
    submitted_by: "sprite-factory",
    route: { allow_provider_change: false, maximum_attempts: 1 },
    output: { accepted_mime_types: ["application/vnd.meshfleet.pixel-bundle.v1"], maximum_artifacts: 1, review: "none" as const },
    operation: "pixel.character" as const,
    input: { prompt: "char", width_px: 32, height_px: 32, transparent: false, license_declaration: "CC0" },
  };
}

function validPixelRotate8Intent() {
  return {
    version: MEDIA_REQUEST_VERSION,
    idempotency_key: "idem-9",
    submitted_by: "sprite-factory",
    route: { allow_provider_change: false, maximum_attempts: 1 },
    output: { accepted_mime_types: ["application/vnd.meshfleet.pixel-bundle.v1"], maximum_artifacts: 1, review: "none" as const },
    operation: "pixel.rotate8" as const,
    input: { source: { artifact_id: "a1", execution_id: "e1", attempt_id: "t1", byte_length: 100, sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", media_class: "image" as const, mime_type: "image/png" }, directions: 8 as const, license_declaration: "CC0" },
  };
}

function validPixelTilesetIntent() {
  return {
    version: MEDIA_REQUEST_VERSION,
    idempotency_key: "idem-10",
    submitted_by: "sprite-factory",
    route: { allow_provider_change: false, maximum_attempts: 1 },
    output: { accepted_mime_types: ["application/vnd.meshfleet.pixel-bundle.v1"], maximum_artifacts: 1, review: "none" as const },
    operation: "pixel.tileset" as const,
    input: { prompt: "tiles", width_px: 32, height_px: 32, transparent: false, lower_description: "grass", upper_description: "sky", license_declaration: "CC0" },
  };
}

function validPixelStateIntent() {
  return {
    version: MEDIA_REQUEST_VERSION,
    idempotency_key: "idem-11",
    submitted_by: "sprite-factory",
    route: { allow_provider_change: false, maximum_attempts: 1 },
    output: { accepted_mime_types: ["application/vnd.meshfleet.pixel-bundle.v1"], maximum_artifacts: 1, review: "none" as const },
    operation: "pixel.state" as const,
    input: { source: { artifact_id: "a1", execution_id: "e1", attempt_id: "t1", byte_length: 100, sha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", media_class: "image" as const, mime_type: "image/png" }, state_description: "running", license_declaration: "CC0" },
  };
}

function validPixelAnimationIntent() {
  return {
    version: MEDIA_REQUEST_VERSION,
    idempotency_key: "idem-12",
    submitted_by: "sprite-factory",
    route: { allow_provider_change: false, maximum_attempts: 1 },
    output: { accepted_mime_types: ["application/vnd.meshfleet.pixel-bundle.v1"], maximum_artifacts: 1, review: "none" as const },
    operation: "pixel.animation" as const,
    input: { source: { artifact_id: "a1", execution_id: "e1", attempt_id: "t1", byte_length: 100, sha256: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", media_class: "image" as const, mime_type: "image/png" }, animation_template: "walk", requested_directions: 4 as const, license_declaration: "CC0" },
  };
}

const allValidIntents = [
  validImageGenerateIntent(),
  validImageEditIntent(),
  validVideoGenerateIntent(),
  validImageToVideoIntent(),
  validTtsIntent(),
  validMusicIntent(),
  validPixelImageIntent(),
  validPixelCharacterIntent(),
  validPixelRotate8Intent(),
  validPixelTilesetIntent(),
  validPixelStateIntent(),
  validPixelAnimationIntent(),
];

describe("media contract - closed validation and canonical identity", () => {
  test("accepts all twelve operations", () => {
    for (const intent of allValidIntents) {
      const parsed = parseMediaPlanIntent(intent);
      assert.equal(parsed.version, MEDIA_REQUEST_VERSION);
      assert.equal(parsed.operation, intent.operation);
    }
  });

  test("rejects unknown top-level member", () => {
    const bad = { ...validImageGenerateIntent(), unknown_key: true } as any;
    assert.throws(() => parseMediaPlanIntent(bad), MediaError);
  });

  test("rejects unknown member in route policy", () => {
    const bad = { ...validImageGenerateIntent(), route: { ...validImageGenerateIntent().route, foo: 1 } } as any;
    assert.throws(() => parseMediaPlanIntent(bad), MediaError);
  });

  test("rejects unknown member in output policy", () => {
    const bad = { ...validImageGenerateIntent(), output: { ...validImageGenerateIntent().output, bar: "x" } } as any;
    assert.throws(() => parseMediaPlanIntent(bad), MediaError);
  });

  test("rejects unknown member in client_context", () => {
    const base = validImageGenerateIntent();
    const bad = { ...base, client_context: { consumer_job_id: "j1", unknown: true } } as any;
    assert.throws(() => parseMediaPlanIntent(bad), MediaError);
  });

  test("rejects mismatched operation/input pair (image.generate with pixel input)", () => {
    const bad = { ...validImageGenerateIntent(), input: validPixelImageIntent().input } as any;
    assert.throws(() => parseMediaPlanIntent(bad), MediaError);
  });

  test("rejects missing completion_target when present but invalid", () => {
    const base = validImageGenerateIntent();
    const bad = { ...base, client_context: { completion_target: "invalid-target" } } as any;
    assert.throws(() => parseMediaPlanIntent(bad), MediaError);
  });

  test("rejects every pixel operation without non-empty license_declaration", () => {
    const pixelOps = [
      validPixelImageIntent(),
      validPixelCharacterIntent(),
      validPixelRotate8Intent(),
      validPixelTilesetIntent(),
      validPixelStateIntent(),
      validPixelAnimationIntent(),
    ];
    for (const op of pixelOps) {
      const bad = { ...op, input: { ...op.input, license_declaration: "" } } as any;
      assert.throws(() => parseMediaPlanIntent(bad), MediaError);
    }
  });

  test("rejects pixel operation missing license_declaration entirely", () => {
    const base = validPixelImageIntent();
    const { license_declaration, ...rest } = base.input as any;
    const bad = { ...base, input: rest } as any;
    assert.throws(() => parseMediaPlanIntent(bad), MediaError);
  });

  test("canonical media intent identity ignores JSON member order", () => {
    const left = parseMediaPlanIntent(validImageIntentWithClientContext());
    const right = parseMediaPlanIntent({
      input: left.input,
      operation: left.operation,
      output: left.output,
      route: left.route,
      client_context: left.client_context,
      submitted_by: left.submitted_by,
      idempotency_key: left.idempotency_key,
      version: left.version,
    });
    assert.equal(canonicalMediaIntentSha256(left), canonicalMediaIntentSha256(right));
  });

  test("parseMediaSubmission accepts valid submission", () => {
    const sub: MediaSubmission = {
      version: MEDIA_REQUEST_VERSION,
      plan_id: "plan-1",
      authority_ref: "auth-1",
    };
    const parsed = parseMediaSubmission(sub);
    assert.equal(parsed.plan_id, "plan-1");
  });

  test("parseMediaSubmission rejects unknown member", () => {
    const bad = { version: MEDIA_REQUEST_VERSION, plan_id: "p1", authority_ref: "a1", extra: true } as any;
    assert.throws(() => parseMediaSubmission(bad), MediaError);
  });
});

function validImageIntentWithClientContext() {
  return {
    version: MEDIA_REQUEST_VERSION,
    idempotency_key: "idem-ctx",
    submitted_by: "artcraft",
    route: { allow_provider_change: false, maximum_attempts: 1 },
    output: { accepted_mime_types: ["image/png"], maximum_artifacts: 1, review: "none" as const },
    client_context: { consumer_job_id: "job-1", completion_target: "artcraft-active-feed" as const },
    operation: "image.generate" as const,
    input: { prompt: "ctx", count: 1 },
  };
}

/*
 * REPAIR TESTS (Task 1 HOLD findings) - written to FAIL on aaf4c2a
 * These encode the 6 actionable review findings.
 */

describe("media contract repair HOLD - 1. ResolvedMediaRequest exact shape", () => {
  test("exports ResolvedMediaRequest = MediaPlanIntent & { plan_id: string; authority_grant_id: string }", () => {
    const resolved: ResolvedMediaRequest = {
      ...parseMediaPlanIntent(validImageGenerateIntent()),
      plan_id: "plan-1",
      authority_grant_id: "grant-1",
    };
    assert.equal(resolved.plan_id, "plan-1");
    assert.equal(resolved.authority_grant_id, "grant-1");
  });
});

describe("media contract repair HOLD - 2. closed MediaArtifactHandle parser (replace as-cast)", () => {
  test("rejects incomplete SingleMediaArtifactHandle missing required fields", () => {
    const intent = validImageEditIntent();
    const { media_class: _mediaClass, ...incomplete } = intent.input.source;
    assert.throws(
      () => parseMediaPlanIntent({ ...intent, input: { ...intent.input, source: incomplete } }),
      MediaError,
    );
  });

  test("accepts valid full SingleMediaArtifactHandle with all optional fields via parseMediaPlanIntent", () => {
    const intent = { ...validImageEditIntent() };
    intent.input = { ...intent.input, source: { artifact_id: "a1", execution_id: "e1", attempt_id: "t1", byte_length: 1024, sha256: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", media_class: "image" as const, mime_type: "image/png", width: 512, height: 512 } };
    const parsed = parseMediaPlanIntent(intent);
    assert.equal(parsed.operation, "image.edit");
    if (parsed.operation !== "image.edit") {
      assert.fail("expected image.edit");
    }
    if (parsed.input.source.media_class === "pixel_bundle") {
      assert.fail("expected a single image artifact");
    }
    assert.equal(parsed.input.source.width, 512);
    assert.equal(parsed.input.source.height, 512);
  });

  test("accepts valid closed MediaBundleHandle with closed MediaBundleEntry[] via parseMediaPlanIntent", () => {
    const intent = { ...validPixelImageIntent() };
    intent.input = { ...intent.input, references: [{ artifact_id: "b1", execution_id: "e1", attempt_id: "t1", byte_length: 2048, sha256: "cafecafe11223344556677889900aabbccddeeff001122334455667788990011", media_class: "pixel_bundle" as const, mime_type: "application/vnd.meshfleet.pixel-bundle.v1" as const, entries: [{ relative_name: "t.png", mime_type: "image/png", byte_length: 512, sha256: "11223344556677889900aabbccddeeff00112233445566778899001122334455" }] }] };
    const parsed = parseMediaPlanIntent(intent);
    assert.equal(parsed.operation, "pixel.image");
    if (parsed.operation !== "pixel.image") {
      assert.fail("expected pixel.image");
    }
    assert.equal(parsed.input.references?.[0]?.media_class, "pixel_bundle");
    if (parsed.input.references?.[0]?.media_class !== "pixel_bundle") {
      assert.fail("expected a pixel bundle reference");
    }
    assert.equal(parsed.input.references[0].entries[0]?.relative_name, "t.png");
  });

  test("rejects unknown handle and bundle-entry members through parseMediaPlanIntent", () => {
    const imageIntent = validImageEditIntent();
    assert.throws(
      () => parseMediaPlanIntent({
        ...imageIntent,
        input: {
          ...imageIntent.input,
          source: { ...imageIntent.input.source, unexpected: true },
        },
      }),
      MediaError,
    );

    const bundleIntent = validPixelImageIntent();
    const bundle = {
      artifact_id: "b1",
      execution_id: "e1",
      attempt_id: "t1",
      byte_length: 2048,
      sha256: "cafecafe11223344556677889900aabbccddeeff001122334455667788990011",
      media_class: "pixel_bundle" as const,
      mime_type: "application/vnd.meshfleet.pixel-bundle.v1" as const,
      entries: [{
        relative_name: "t.png",
        mime_type: "image/png",
        byte_length: 512,
        sha256: "11223344556677889900aabbccddeeff00112233445566778899001122334455",
        unexpected: true,
      }],
    };
    assert.throws(
      () => parseMediaPlanIntent({
        ...bundleIntent,
        input: { ...bundleIntent.input, references: [bundle] },
      }),
      MediaError,
    );
  });

  test("rejects a wrong pixel-bundle MIME and empty entries", () => {
    const intent = validPixelImageIntent();
    const bundle = {
      artifact_id: "b1",
      execution_id: "e1",
      attempt_id: "t1",
      byte_length: 2048,
      sha256: "cafecafe11223344556677889900aabbccddeeff001122334455667788990011",
      media_class: "pixel_bundle" as const,
      mime_type: "application/vnd.meshfleet.pixel-bundle.v1",
      entries: [{
        relative_name: "t.png",
        mime_type: "image/png",
        byte_length: 512,
        sha256: "11223344556677889900aabbccddeeff00112233445566778899001122334455",
      }],
    };
    assert.throws(
      () => parseMediaPlanIntent({
        ...intent,
        input: {
          ...intent.input,
          references: [{ ...bundle, mime_type: "application/zip" }],
        },
      }),
      MediaError,
    );
    assert.throws(
      () => parseMediaPlanIntent({
        ...intent,
        input: { ...intent.input, references: [{ ...bundle, entries: [] }] },
      }),
      MediaError,
    );
  });
});

describe("media contract repair HOLD - 3. canonicalMediaIntentSha256 direct typed (no any)", () => {
  test("recursively canonicalizes semantic intent and excludes resolved gate IDs", () => {
    const intent = parseMediaPlanIntent(validImageIntentWithClientContext());
    const h = canonicalMediaIntentSha256(intent);
    assert.equal(h.length, 64);
    assert.match(h, /^[0-9a-f]{64}$/);

    const first: ResolvedMediaRequest = {
      ...intent,
      plan_id: "plan-1",
      authority_grant_id: "grant-1",
    };
    const second: ResolvedMediaRequest = {
      ...intent,
      plan_id: "plan-2",
      authority_grant_id: "grant-2",
    };
    assert.equal(canonicalMediaIntentSha256(first), h);
    assert.equal(canonicalMediaIntentSha256(second), h);
  });
});

describe("media contract repair HOLD - 4. table-driven unknown-member tests inside EVERY operation input + full handles", () => {
  const factories = [
    validImageGenerateIntent, validImageEditIntent, validVideoGenerateIntent,
    validImageToVideoIntent, validTtsIntent, validMusicIntent,
    validPixelImageIntent, validPixelCharacterIntent, validPixelRotate8Intent,
    validPixelTilesetIntent, validPixelStateIntent, validPixelAnimationIntent,
  ];
  for (const f of factories) {
    test(`rejects unknown member inside ${f().operation} input (full handle shapes required in fixtures)`, () => {
      const base = f();
      const bad = { ...base, input: { ...base.input, __unknown__: 1 } };
      assert.throws(() => parseMediaPlanIntent(bad), MediaError);
    });
  }
});

describe("media contract repair HOLD - 5. integrity-shaped primitives + negative tests", () => {
  test("sha256 must be lowercase 64-hex (rejects uppercase)", () => {
    const h = { artifact_id: "a1", execution_id: "e1", attempt_id: "t1", byte_length: 100, sha256: "DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF" };
    const bad = { ...validImageEditIntent(), input: { ...validImageEditIntent().input, source: h } };
    assert.throws(() => parseMediaPlanIntent(bad), MediaError);
  });
  test("rejects negative/zero for counts, attempts, dimensions, byte_length, durations, frames", () => {
    assert.throws(() => parseMediaPlanIntent({ ...validImageGenerateIntent(), input: { ...validImageGenerateIntent().input, count: -1 } }), MediaError);
    assert.throws(() => parseMediaPlanIntent({ ...validImageGenerateIntent(), input: { ...validImageGenerateIntent().input, count: 1.5 } }), MediaError);
    assert.throws(() => parseMediaPlanIntent({ ...validImageGenerateIntent(), input: { ...validImageGenerateIntent().input, width: 0 } }), MediaError);
    assert.throws(() => parseMediaPlanIntent({ ...validImageGenerateIntent(), route: { ...validImageGenerateIntent().route, maximum_attempts: 0 } }), MediaError);
    assert.throws(() => parseMediaPlanIntent({ ...validPixelImageIntent(), input: { ...validPixelImageIntent().input, width_px: -5 } }), MediaError);
    assert.throws(() => parseMediaPlanIntent({ ...validPixelImageIntent(), input: { ...validPixelImageIntent().input, height_px: 0 } }), MediaError);
    const imageIntent = validImageEditIntent();
    assert.throws(() => parseMediaPlanIntent({
      ...imageIntent,
      input: {
        ...imageIntent.input,
        source: { ...imageIntent.input.source, byte_length: -1 },
      },
    }), MediaError);
    assert.throws(() => parseMediaPlanIntent({
      ...imageIntent,
      input: {
        ...imageIntent.input,
        source: {
          ...imageIntent.input.source,
          duration_ms: -1,
          frame_count: 1.5,
        },
      },
    }), MediaError);
    assert.throws(() => parseMediaPlanIntent({
      ...validVideoGenerateIntent(),
      input: { ...validVideoGenerateIntent().input, duration_seconds: 0 },
    }), MediaError);
    assert.throws(() => parseMediaPlanIntent({
      ...validMusicIntent(),
      input: {
        ...validMusicIntent().input,
        seed: 1.5,
        duration_seconds: -1,
      },
    }), MediaError);
    assert.throws(() => parseMediaPlanIntent({
      ...validTtsIntent(),
      input: { ...validTtsIntent().input, speed: 0 },
    }), MediaError);
  });
  test("rejects empty strings where content required (prompt, license, text)", () => {
    assert.throws(() => parseMediaPlanIntent({ ...validPixelImageIntent(), input: { ...validPixelImageIntent().input, license_declaration: "" } }), MediaError);
    assert.throws(() => parseMediaPlanIntent({ ...validTtsIntent(), input: { ...validTtsIntent().input, text: "" } }), MediaError);
  });
});
