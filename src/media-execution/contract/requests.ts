import { createHash } from "node:crypto";
import {
  MEDIA_REQUEST_VERSION,
  type MediaOperation,
  type MediaOutputPolicy,
  type MediaClientContext,
  type MediaRoutePolicy,
  type PixelInputBase,
  type PixelRotate8Input,
  type PixelStateInput,
  type PixelAnimationInput,
} from "./operations.js";

export { MEDIA_REQUEST_VERSION } from "./operations.js";
export { MediaError } from "./errors.js";

import type { MediaArtifactHandle } from "./results.js";
import { MediaError } from "./errors.js";

export type ResolvedMediaRequest = MediaPlanIntent & {
  plan_id: string;
  authority_grant_id: string;
};

export interface ImageGenerateInput {
  prompt: string;
  negative_prompt?: string;
  aspect_ratio?: string;
  width?: number;
  height?: number;
  count: number;
  references?: MediaArtifactHandle[];
}

export interface ImageEditInput {
  prompt: string;
  source: MediaArtifactHandle;
  mask?: MediaArtifactHandle;
  references?: MediaArtifactHandle[];
  aspect_ratio?: string;
}

export interface VideoGenerateInput {
  prompt: string;
  duration_seconds?: number;
  resolution?: string;
  prompt_optimization?: boolean;
}

export interface ImageToVideoInput {
  prompt?: string;
  first_frame: MediaArtifactHandle;
  duration_seconds?: number;
  resolution?: string;
  prompt_optimization?: boolean;
}

export interface TextToSpeechInput {
  text: string;
  voice: string;
  style?: string;
  language?: string;
  speed?: number;
  volume?: number;
  pitch?: number;
  format: "wav" | "mp3" | "ogg";
}

export interface MusicInput {
  prompt: string;
  lyrics?: string;
  instrumental: boolean;
  auto_lyrics: boolean;
  negative_prompt?: string;
  seed?: number;
  duration_seconds?: number;
  format: "wav" | "mp3" | "ogg";
}

export interface PixelImageInput extends PixelInputBase {
  references?: MediaArtifactHandle[];
}

export interface PixelCharacterInput extends PixelInputBase {
  existing_character?: MediaArtifactHandle;
}

export interface PixelTilesetInput extends PixelInputBase {
  lower_description: string;
  upper_description: string;
}

export type MediaPlanIntent =
  | (MediaPlanIntentBase & { operation: "image.generate"; input: ImageGenerateInput })
  | (MediaPlanIntentBase & { operation: "image.edit"; input: ImageEditInput })
  | (MediaPlanIntentBase & { operation: "video.generate"; input: VideoGenerateInput })
  | (MediaPlanIntentBase & { operation: "video.image_to_video"; input: ImageToVideoInput })
  | (MediaPlanIntentBase & { operation: "audio.tts"; input: TextToSpeechInput })
  | (MediaPlanIntentBase & { operation: "audio.music"; input: MusicInput })
  | (MediaPlanIntentBase & { operation: "pixel.image"; input: PixelImageInput })
  | (MediaPlanIntentBase & { operation: "pixel.character"; input: PixelCharacterInput })
  | (MediaPlanIntentBase & { operation: "pixel.rotate8"; input: PixelRotate8Input })
  | (MediaPlanIntentBase & { operation: "pixel.tileset"; input: PixelTilesetInput })
  | (MediaPlanIntentBase & { operation: "pixel.state"; input: PixelStateInput })
  | (MediaPlanIntentBase & { operation: "pixel.animation"; input: PixelAnimationInput });

export interface MediaPlanIntentBase {
  version: typeof MEDIA_REQUEST_VERSION;
  idempotency_key: string;
  submitted_by: string;
  route: MediaRoutePolicy;
  output: MediaOutputPolicy;
  client_context?: MediaClientContext;
}

export interface MediaSubmission {
  version: typeof MEDIA_REQUEST_VERSION;
  plan_id: string;
  authority_ref: string;
}

export function requireExactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) {
    throw new MediaError("invalid_request", `${path}.${unexpected}`);
  }
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new MediaError("invalid_request", path);
  }
  return value;
}

function requireSha256(value: unknown, path: string): string {
  const s = requireString(value, path);
  if (!/^[0-9a-f]{64}$/.test(s)) {
    throw new MediaError("invalid_request", path);
  }
  return s;
}

function requireNonnegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new MediaError("invalid_request", path);
  }
  return value;
}

function requirePositiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new MediaError("invalid_request", path);
  }
  return value;
}

function requireSafeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new MediaError("invalid_request", path);
  }
  return value;
}

function requirePositiveNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new MediaError("invalid_request", path);
  }
  return value;
}

function requireNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MediaError("invalid_request", path);
  }
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new MediaError("invalid_request", path);
  }
  return value;
}

function requireArray<T>(value: unknown, path: string, itemValidator: (v: unknown, p: string) => T): T[] {
  if (!Array.isArray(value)) {
    throw new MediaError("invalid_request", path);
  }
  return value.map((item, i) => itemValidator(item, `${path}[${i}]`));
}

function parseMediaArtifactHandle(v: unknown, path: string): MediaArtifactHandle {
  if (typeof v !== "object" || v === null) throw new MediaError("invalid_request", path);
  const obj = v as Record<string, unknown>;
  const mediaClass = obj.media_class;
  if (mediaClass === "pixel_bundle") {
    requireExactKeys(obj, ["artifact_id", "execution_id", "attempt_id", "byte_length", "sha256", "media_class", "mime_type", "entries"], path);
    if (obj.mime_type !== "application/vnd.meshfleet.pixel-bundle.v1") {
      throw new MediaError("invalid_request", `${path}.mime_type`);
    }
    const entries = requireArray(obj.entries, `${path}.entries`, (e, ep) => {
      if (typeof e !== "object" || e === null) throw new MediaError("invalid_request", ep);
      const eo = e as Record<string, unknown>;
      requireExactKeys(eo, ["relative_name", "mime_type", "byte_length", "sha256"], ep);
      return {
        relative_name: requireString(eo.relative_name, `${ep}.relative_name`),
        mime_type: requireString(eo.mime_type, `${ep}.mime_type`),
        byte_length: requireNonnegativeInteger(eo.byte_length, `${ep}.byte_length`),
        sha256: requireSha256(eo.sha256, `${ep}.sha256`),
      };
    });
    if (entries.length === 0) throw new MediaError("invalid_request", `${path}.entries`);
    return {
      artifact_id: requireString(obj.artifact_id, `${path}.artifact_id`),
      execution_id: requireString(obj.execution_id, `${path}.execution_id`),
      attempt_id: requireString(obj.attempt_id, `${path}.attempt_id`),
      byte_length: requireNonnegativeInteger(obj.byte_length, `${path}.byte_length`),
      sha256: requireSha256(obj.sha256, `${path}.sha256`),
      media_class: "pixel_bundle",
      mime_type: "application/vnd.meshfleet.pixel-bundle.v1",
      entries,
    };
  }
  requireExactKeys(obj, ["artifact_id", "execution_id", "attempt_id", "byte_length", "sha256", "media_class", "mime_type", "width", "height", "duration_ms", "frame_count"], path);
  const mc = obj.media_class;
  if (mc !== "image" && mc !== "video" && mc !== "audio") throw new MediaError("invalid_request", `${path}.media_class`);
  const mt = requireString(obj.mime_type, `${path}.mime_type`);
  return {
    artifact_id: requireString(obj.artifact_id, `${path}.artifact_id`),
    execution_id: requireString(obj.execution_id, `${path}.execution_id`),
    attempt_id: requireString(obj.attempt_id, `${path}.attempt_id`),
    byte_length: requireNonnegativeInteger(obj.byte_length, `${path}.byte_length`),
    sha256: requireSha256(obj.sha256, `${path}.sha256`),
    media_class: mc,
    mime_type: mt,
    width: obj.width !== undefined ? requirePositiveInteger(obj.width, `${path}.width`) : undefined,
    height: obj.height !== undefined ? requirePositiveInteger(obj.height, `${path}.height`) : undefined,
    duration_ms: obj.duration_ms !== undefined ? requireNonnegativeInteger(obj.duration_ms, `${path}.duration_ms`) : undefined,
    frame_count: obj.frame_count !== undefined ? requireNonnegativeInteger(obj.frame_count, `${path}.frame_count`) : undefined,
  };
}

function parseMediaRoutePolicy(v: unknown): MediaRoutePolicy {
  if (typeof v !== "object" || v === null) throw new MediaError("invalid_request", "route");
  const obj = v as Record<string, unknown>;
  requireExactKeys(obj, ["preferred_provider", "pinned_provider", "forbidden_providers", "requested_model", "allow_provider_change", "maximum_attempts"], "route");
  return {
    preferred_provider: obj.preferred_provider !== undefined ? requireString(obj.preferred_provider, "route.preferred_provider") : undefined,
    pinned_provider: obj.pinned_provider !== undefined ? requireString(obj.pinned_provider, "route.pinned_provider") : undefined,
    forbidden_providers: obj.forbidden_providers !== undefined ? requireArray(obj.forbidden_providers, "route.forbidden_providers", (x, p) => requireString(x, p)) : undefined,
    requested_model: obj.requested_model !== undefined ? requireString(obj.requested_model, "route.requested_model") : undefined,
    allow_provider_change: requireBoolean(obj.allow_provider_change, "route.allow_provider_change"),
    maximum_attempts: requirePositiveInteger(obj.maximum_attempts, "route.maximum_attempts"),
  };
}

function parseMediaOutputPolicy(v: unknown): MediaOutputPolicy {
  if (typeof v !== "object" || v === null) throw new MediaError("invalid_request", "output");
  const obj = v as Record<string, unknown>;
  requireExactKeys(obj, ["accepted_mime_types", "maximum_artifacts", "review"], "output");
  const review = obj.review;
  if (review !== "none" && review !== "required" && review !== "provider_default") {
    throw new MediaError("invalid_request", "output.review");
  }
  return {
    accepted_mime_types: requireArray(obj.accepted_mime_types, "output.accepted_mime_types", (x, p) => requireString(x, p)),
    maximum_artifacts: requirePositiveInteger(obj.maximum_artifacts, "output.maximum_artifacts"),
    review,
  };
}

function parseMediaClientContext(v: unknown): MediaClientContext {
  if (typeof v !== "object" || v === null) throw new MediaError("invalid_request", "client_context");
  const obj = v as Record<string, unknown>;
  requireExactKeys(obj, ["consumer_job_id", "project_ref", "completion_target"], "client_context");
  const target = obj.completion_target;
  if (target !== undefined && target !== "artcraft-active-feed" && target !== "sprite-factory-intake" && target !== "meshfleet-only") {
    throw new MediaError("invalid_request", "client_context.completion_target");
  }
  return {
    consumer_job_id: obj.consumer_job_id !== undefined ? requireString(obj.consumer_job_id, "client_context.consumer_job_id") : undefined,
    project_ref: obj.project_ref !== undefined ? requireString(obj.project_ref, "client_context.project_ref") : undefined,
    completion_target: target,
  };
}

function parsePixelInputBase(v: unknown, path: string, extraAllowed: readonly string[] = []): PixelInputBase {
  if (typeof v !== "object" || v === null) throw new MediaError("invalid_request", path);
  const obj = v as Record<string, unknown>;
  const baseKeys = ["prompt", "width_px", "height_px", "view", "transparent", "license_declaration"];
  requireExactKeys(obj, [...baseKeys, ...extraAllowed], path);
  const lic = requireString(obj.license_declaration, `${path}.license_declaration`);
  if (lic.length === 0) throw new MediaError("invalid_request", `${path}.license_declaration`);
  const view = obj.view;
  if (view !== undefined && view !== "side" && view !== "front" && view !== "top_down" && view !== "three_quarter") {
    throw new MediaError("invalid_request", `${path}.view`);
  }
  return {
    prompt: requireString(obj.prompt, `${path}.prompt`),
      width_px: requirePositiveInteger(obj.width_px, `${path}.width_px`),
      height_px: requirePositiveInteger(obj.height_px, `${path}.height_px`),
    view,
    transparent: requireBoolean(obj.transparent, `${path}.transparent`),
    license_declaration: lic,
  };
}

export function parseMediaPlanIntent(raw: unknown): MediaPlanIntent {
  if (typeof raw !== "object" || raw === null) throw new MediaError("invalid_request", "root");
  const obj = raw as Record<string, unknown>;
  requireExactKeys(obj, ["version", "idempotency_key", "submitted_by", "route", "output", "client_context", "operation", "input"], "root");
  if (obj.version !== MEDIA_REQUEST_VERSION) throw new MediaError("invalid_request", "version");
  const base: MediaPlanIntentBase = {
    version: MEDIA_REQUEST_VERSION,
    idempotency_key: requireString(obj.idempotency_key, "idempotency_key"),
    submitted_by: requireString(obj.submitted_by, "submitted_by"),
    route: parseMediaRoutePolicy(obj.route),
    output: parseMediaOutputPolicy(obj.output),
    client_context: obj.client_context !== undefined ? parseMediaClientContext(obj.client_context) : undefined,
  };
  const op = requireString(obj.operation, "operation") as MediaOperation;
  const input = obj.input;
  switch (op) {
    case "image.generate": {
      if (typeof input !== "object" || input === null) throw new MediaError("invalid_request", "input");
      const i = input as Record<string, unknown>;
      requireExactKeys(i, ["prompt", "negative_prompt", "aspect_ratio", "width", "height", "count", "references"], "input");
      return { ...base, operation: op, input: { prompt: requireString(i.prompt, "input.prompt"), negative_prompt: i.negative_prompt !== undefined ? requireString(i.negative_prompt, "input.negative_prompt") : undefined, aspect_ratio: i.aspect_ratio !== undefined ? requireString(i.aspect_ratio, "input.aspect_ratio") : undefined, width: i.width !== undefined ? requirePositiveInteger(i.width, "input.width") : undefined, height: i.height !== undefined ? requirePositiveInteger(i.height, "input.height") : undefined, count: requirePositiveInteger(i.count, "input.count"), references: i.references !== undefined ? requireArray(i.references, "input.references", (x, p) => parseMediaArtifactHandle(x, p)) : undefined } };
    }
    case "image.edit": {
      if (typeof input !== "object" || input === null) throw new MediaError("invalid_request", "input");
      const i = input as Record<string, unknown>;
      requireExactKeys(i, ["prompt", "source", "mask", "references", "aspect_ratio"], "input");
      return { ...base, operation: op, input: { prompt: requireString(i.prompt, "input.prompt"), source: parseMediaArtifactHandle(i.source, "input.source"), mask: i.mask !== undefined ? parseMediaArtifactHandle(i.mask, "input.mask") : undefined, references: i.references !== undefined ? requireArray(i.references, "input.references", (x, p) => parseMediaArtifactHandle(x, p)) : undefined, aspect_ratio: i.aspect_ratio !== undefined ? requireString(i.aspect_ratio, "input.aspect_ratio") : undefined } };
    }
    case "video.generate": {
      if (typeof input !== "object" || input === null) throw new MediaError("invalid_request", "input");
      const i = input as Record<string, unknown>;
      requireExactKeys(i, ["prompt", "duration_seconds", "resolution", "prompt_optimization"], "input");
      return { ...base, operation: op, input: { prompt: requireString(i.prompt, "input.prompt"), duration_seconds: i.duration_seconds !== undefined ? requirePositiveNumber(i.duration_seconds, "input.duration_seconds") : undefined, resolution: i.resolution !== undefined ? requireString(i.resolution, "input.resolution") : undefined, prompt_optimization: i.prompt_optimization !== undefined ? requireBoolean(i.prompt_optimization, "input.prompt_optimization") : undefined } };
    }
    case "video.image_to_video": {
      if (typeof input !== "object" || input === null) throw new MediaError("invalid_request", "input");
      const i = input as Record<string, unknown>;
      requireExactKeys(i, ["prompt", "first_frame", "duration_seconds", "resolution", "prompt_optimization"], "input");
      return { ...base, operation: op, input: { prompt: i.prompt !== undefined ? requireString(i.prompt, "input.prompt") : undefined, first_frame: parseMediaArtifactHandle(i.first_frame, "input.first_frame"), duration_seconds: i.duration_seconds !== undefined ? requirePositiveNumber(i.duration_seconds, "input.duration_seconds") : undefined, resolution: i.resolution !== undefined ? requireString(i.resolution, "input.resolution") : undefined, prompt_optimization: i.prompt_optimization !== undefined ? requireBoolean(i.prompt_optimization, "input.prompt_optimization") : undefined } };
    }
    case "audio.tts": {
      if (typeof input !== "object" || input === null) throw new MediaError("invalid_request", "input");
      const i = input as Record<string, unknown>;
      requireExactKeys(i, ["text", "voice", "style", "language", "speed", "volume", "pitch", "format"], "input");
      const fmt = requireString(i.format, "input.format");
      if (fmt !== "wav" && fmt !== "mp3" && fmt !== "ogg") throw new MediaError("invalid_request", "input.format");
      return { ...base, operation: op, input: { text: requireString(i.text, "input.text"), voice: requireString(i.voice, "input.voice"), style: i.style !== undefined ? requireString(i.style, "input.style") : undefined, language: i.language !== undefined ? requireString(i.language, "input.language") : undefined, speed: i.speed !== undefined ? requirePositiveNumber(i.speed, "input.speed") : undefined, volume: i.volume !== undefined ? requireNumber(i.volume, "input.volume") : undefined, pitch: i.pitch !== undefined ? requireNumber(i.pitch, "input.pitch") : undefined, format: fmt } };
    }
    case "audio.music": {
      if (typeof input !== "object" || input === null) throw new MediaError("invalid_request", "input");
      const i = input as Record<string, unknown>;
      requireExactKeys(i, ["prompt", "lyrics", "instrumental", "auto_lyrics", "negative_prompt", "seed", "duration_seconds", "format"], "input");
      const fmt = requireString(i.format, "input.format");
      if (fmt !== "wav" && fmt !== "mp3" && fmt !== "ogg") throw new MediaError("invalid_request", "input.format");
      return { ...base, operation: op, input: { prompt: requireString(i.prompt, "input.prompt"), lyrics: i.lyrics !== undefined ? requireString(i.lyrics, "input.lyrics") : undefined, instrumental: requireBoolean(i.instrumental, "input.instrumental"), auto_lyrics: requireBoolean(i.auto_lyrics, "input.auto_lyrics"), negative_prompt: i.negative_prompt !== undefined ? requireString(i.negative_prompt, "input.negative_prompt") : undefined, seed: i.seed !== undefined ? requireSafeInteger(i.seed, "input.seed") : undefined, duration_seconds: i.duration_seconds !== undefined ? requirePositiveNumber(i.duration_seconds, "input.duration_seconds") : undefined, format: fmt } };
    }
    case "pixel.image": {
      const baseInput = parsePixelInputBase(input, "input", ["references"]);
      const i = input as Record<string, unknown>;
      return { ...base, operation: op, input: { ...baseInput, references: i.references !== undefined ? requireArray(i.references, "input.references", (x, p) => parseMediaArtifactHandle(x, p)) : undefined } };
    }
    case "pixel.character": {
      const baseInput = parsePixelInputBase(input, "input", ["existing_character"]);
      const i = input as Record<string, unknown>;
      return { ...base, operation: op, input: { ...baseInput, existing_character: i.existing_character !== undefined ? parseMediaArtifactHandle(i.existing_character, "input.existing_character") : undefined } };
    }
    case "pixel.rotate8": {
      if (typeof input !== "object" || input === null) throw new MediaError("invalid_request", "input");
      const i = input as Record<string, unknown>;
      requireExactKeys(i, ["source", "directions", "license_declaration"], "input");
      const lic = requireString(i.license_declaration, "input.license_declaration");
      if (lic.length === 0) throw new MediaError("invalid_request", "input.license_declaration");
      if (i.directions !== 8) throw new MediaError("invalid_request", "input.directions");
      return { ...base, operation: op, input: { source: parseMediaArtifactHandle(i.source, "input.source"), directions: 8, license_declaration: lic } };
    }
    case "pixel.tileset": {
      const baseInput = parsePixelInputBase(input, "input", ["lower_description", "upper_description"]);
      const i = input as Record<string, unknown>;
      return { ...base, operation: op, input: { ...baseInput, lower_description: requireString(i.lower_description, "input.lower_description"), upper_description: requireString(i.upper_description, "input.upper_description") } };
    }
    case "pixel.state": {
      if (typeof input !== "object" || input === null) throw new MediaError("invalid_request", "input");
      const i = input as Record<string, unknown>;
      requireExactKeys(i, ["source", "state_description", "license_declaration"], "input");
      const lic = requireString(i.license_declaration, "input.license_declaration");
      if (lic.length === 0) throw new MediaError("invalid_request", "input.license_declaration");
      return { ...base, operation: op, input: { source: parseMediaArtifactHandle(i.source, "input.source"), state_description: requireString(i.state_description, "input.state_description"), license_declaration: lic } };
    }
    case "pixel.animation": {
      if (typeof input !== "object" || input === null) throw new MediaError("invalid_request", "input");
      const i = input as Record<string, unknown>;
      requireExactKeys(i, ["source", "animation_template", "requested_directions", "license_declaration"], "input");
      const lic = requireString(i.license_declaration, "input.license_declaration");
      if (lic.length === 0) throw new MediaError("invalid_request", "input.license_declaration");
      const dirs = i.requested_directions;
      if (dirs !== 1 && dirs !== 4 && dirs !== 8) throw new MediaError("invalid_request", "input.requested_directions");
      return { ...base, operation: op, input: { source: parseMediaArtifactHandle(i.source, "input.source"), animation_template: requireString(i.animation_template, "input.animation_template"), requested_directions: dirs, license_declaration: lic } };
    }
    default:
      throw new MediaError("invalid_request", "operation");
  }
}

export function parseMediaSubmission(raw: unknown): MediaSubmission {
  if (typeof raw !== "object" || raw === null) throw new MediaError("invalid_request", "root");
  const obj = raw as Record<string, unknown>;
  requireExactKeys(obj, ["version", "plan_id", "authority_ref"], "root");
  if (obj.version !== MEDIA_REQUEST_VERSION) throw new MediaError("invalid_request", "version");
  return {
    version: MEDIA_REQUEST_VERSION,
    plan_id: requireString(obj.plan_id, "plan_id"),
    authority_ref: requireString(obj.authority_ref, "authority_ref"),
  };
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = canonicalize(obj[k]);
  return out;
}

export function canonicalMediaIntentSha256(intent: MediaPlanIntent): string;
export function canonicalMediaIntentSha256(intent: ResolvedMediaRequest): string;
export function canonicalMediaIntentSha256(
  intent: MediaPlanIntent & { plan_id?: string; authority_grant_id?: string },
): string {
  const {
    plan_id: _planId,
    authority_grant_id: _authorityGrantId,
    ...semanticIntent
  } = intent;
  const canon = canonicalize(semanticIntent);
  const json = JSON.stringify(canon);
  return createHash("sha256").update(json, "utf8").digest("hex");
}
