import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  parseMediaPlanIntent,
  parseMediaSubmission,
  canonicalMediaIntentSha256,
  MediaError,
  MEDIA_REQUEST_VERSION,
  type MediaPlanIntent,
  type MediaSubmission,
} from "../src/media-execution/contract/requests.js";
import {
  type MediaOperation,
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
    input: { prompt: "edit", source: { artifact_id: "a1", execution_id: "e1", attempt_id: "t1", byte_length: 100, sha256: "deadbeef" } },
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
    input: { first_frame: { artifact_id: "a1", execution_id: "e1", attempt_id: "t1", byte_length: 100, sha256: "deadbeef" } },
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
    input: { source: { artifact_id: "a1", execution_id: "e1", attempt_id: "t1", byte_length: 100, sha256: "deadbeef" }, directions: 8 as const, license_declaration: "CC0" },
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
    input: { source: { artifact_id: "a1", execution_id: "e1", attempt_id: "t1", byte_length: 100, sha256: "deadbeef" }, state_description: "running", license_declaration: "CC0" },
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
    input: { source: { artifact_id: "a1", execution_id: "e1", attempt_id: "t1", byte_length: 100, sha256: "deadbeef" }, animation_template: "walk", requested_directions: 4 as const, license_declaration: "CC0" },
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
