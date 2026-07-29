export const MEDIA_REQUEST_VERSION = "meshfleet.media-request.v1" as const;

export type MediaOperation =
  | "image.generate"
  | "image.edit"
  | "video.generate"
  | "video.image_to_video"
  | "audio.tts"
  | "audio.music"
  | "pixel.image"
  | "pixel.character"
  | "pixel.rotate8"
  | "pixel.tileset"
  | "pixel.state"
  | "pixel.animation";

export interface MediaOutputPolicy {
  accepted_mime_types: string[];
  maximum_artifacts: number;
  review: "none" | "required" | "provider_default";
}

export interface MediaClientContext {
  consumer_job_id?: string;
  project_ref?: string;
  completion_target?: "artcraft-active-feed" | "sprite-factory-intake" | "meshfleet-only";
}

export interface MediaRoutePolicy {
  preferred_provider?: string;
  pinned_provider?: string;
  forbidden_providers?: string[];
  requested_model?: string;
  allow_provider_change: boolean;
  maximum_attempts: number;
}

export interface PixelInputBase {
  prompt: string;
  width_px: number;
  height_px: number;
  view?: "side" | "front" | "top_down" | "three_quarter";
  transparent: boolean;
  license_declaration: string;
}

export interface PixelRotate8Input {
  source: import("./results.js").MediaArtifactHandle;
  directions: 8;
  license_declaration: string;
}

export interface PixelStateInput {
  source: import("./results.js").MediaArtifactHandle;
  state_description: string;
  license_declaration: string;
}

export interface PixelAnimationInput {
  source: import("./results.js").MediaArtifactHandle;
  animation_template: string;
  requested_directions: 1 | 4 | 8;
  license_declaration: string;
}
