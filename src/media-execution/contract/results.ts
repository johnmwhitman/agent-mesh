import { type MediaOperation } from "./operations.js";
export type { MediaOperation } from "./operations.js";

export interface MediaArtifactHandleBase {
  artifact_id: string;
  execution_id: string;
  attempt_id: string;
  byte_length: number;
  sha256: string;
}

export interface SingleMediaArtifactHandle extends MediaArtifactHandleBase {
  media_class: "image" | "video" | "audio";
  mime_type: string;
  width?: number;
  height?: number;
  duration_ms?: number;
  frame_count?: number;
}

export interface MediaBundleEntry {
  relative_name: string;
  mime_type: string;
  byte_length: number;
  sha256: string;
}

export interface MediaBundleHandle extends MediaArtifactHandleBase {
  media_class: "pixel_bundle";
  mime_type: "application/vnd.meshfleet.pixel-bundle.v1";
  entries: MediaBundleEntry[];
}

export type MediaArtifactHandle =
  | SingleMediaArtifactHandle
  | MediaBundleHandle;
