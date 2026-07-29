# Task capability profiles

`meshfleet/task-capability-profile` is a package-only, pure compiler that turns a typed task requirement and caller-supplied capability surfaces into an input for the existing `recommend_route` evaluator.

It does not discover providers, execute work, contact RoutePlane, read credentials, inspect files, reserve capacity, spend quota, or authorize an artifact. Every returned effect claim is explicitly `false`.

## Why this boundary exists

The existing route evaluator accepts generic capability tokens. That is sufficient after a caller has established what an image, video, speech, music, or pixel-art task actually requires, but it does not itself define media operation, lifecycle, or artifact compatibility.

The compiler adds that missing typed boundary:

1. Validate the exact private-review artifact policy.
2. Select one relational surface profile that advertises the required operation, lifecycle, artifact, and traits.
3. Project only compatible surfaces into `route_input`.
4. Leave privacy, locality, coordination, policy, context, observed outcome, and budget evaluation to `recommend_route`.

The result reports this order as `private_artifact_policy`, `capability_profile`, then `downstream_route_budget`. A caller must not interpret compilation as execution approval.

## Version and operation vocabulary

The closed version is `meshfleet.task-capability-profile.v0.1`.

| Operation | Required artifact | Lifecycle |
|---|---|---|
| `text.generate` | `text` | `inline` or `async_job` |
| `image.generate` | `image` | `inline` or `async_job` |
| `video.generate` | `video` | `async_job` |
| `speech.synthesize` | `audio` | `inline` or `async_job` |
| `music.generate` | `audio` | `inline` or `async_job` |
| `pixel_art.rotate_character` | `sprite_sheet` | `async_job` |
| `pixel_art.generate_tileset` | `tileset` | `async_job` |

Required and optional traits are lowercase opaque tokens no longer than 58 characters, leaving room for the `trait:` prefix inside the downstream evaluator's 64-character capability bound. Examples include `background_omission`, `ssml`, `instrumental`, `pixel_art`, `eight_direction_rotation`, and `tile_transitions`.

## Private artifact policy

Every task must carry:

```json
{
  "source_material": "caller_attested_rights",
  "review_scope": "private_review_only",
  "human_release_required": true
}
```

`source_material` may instead be `text_only`. This is caller-supplied policy evidence, not a rights verification or release authorization. The compiler rejects other review scopes and any attempt to set `human_release_required` to false.

The ingress is closed. Prompt, content, credential, path, auth, binary, likeness, voice, and publication fields have no place in this module and are rejected rather than copied.

## Example

```ts
import {
  compileTaskCapabilityProfile,
  TASK_CAPABILITY_PROFILE_VERSION,
} from "meshfleet/task-capability-profile";
import { recommendRoute } from "./recommend-route.js";

const compiled = compileTaskCapabilityProfile({
  version: TASK_CAPABILITY_PROFILE_VERSION,
  task: {
    task_id: "sprite-rotation-1",
    operation: "pixel_art.rotate_character",
    lifecycle: "async_job",
    artifact: "sprite_sheet",
    required_traits: ["eight_direction_rotation", "pixel_art"],
    privacy: "network_ok",
    locality: "any",
    artifact_policy: {
      source_material: "caller_attested_rights",
      review_scope: "private_review_only",
      human_release_required: true,
    },
  },
  surfaces: [{
    candidate_id: "pixel-lane",
    profiles: [{
      operation: "pixel_art.rotate_character",
      lifecycle: "async_job",
      artifact: "sprite_sheet",
      traits: ["pixel_art", "eight_direction_rotation"],
    }],
    privacy: "network_ok",
    locality: "any",
    budget: { measured: false },
    labels: { brand: "PixelLab" },
  }],
});

const recommendation = compiled.route_input === null
  ? undefined
  : recommendRoute(compiled.route_input);
```

The projected candidate contains only provider-neutral capability tokens:

```json
[
  "artifact:sprite_sheet",
  "lifecycle:async_job",
  "operation:pixel_art.rotate_character",
  "trait:eight_direction_rotation",
  "trait:pixel_art"
]
```

`PixelLab` remains in `identity_labels` with `evidence_only: true`. Brand, provider, and model labels never enter `route_input`, exclusions, fit, rank, or score. This module therefore does not create a fake LLM model or provider-catalog entry for PixelLab.

## Determinism and limits

- Inputs must be bounded plain JSON data: no accessors, symbols, sparse or decorated arrays, prototype-backed records, cycles, non-finite numbers, or strings above 512 characters.
- Validation and compilation use one descriptor-captured own-property snapshot, so inherited or prototype-polluted fields cannot supply schema data or invoke inherited getters.
- The root accepts one task and 1–128 surfaces.
- Each surface accepts 1–16 relational support profiles. Every profile binds one operation, one lifecycle, its lawful artifact, and only the traits available for that exact combination.
- Profiles prevent Cartesian overclaims: an image job lifecycle cannot make a text-inline profile asynchronous, and speech traits cannot satisfy an image profile.
- When several exact profiles satisfy every required trait, the compiler selects the single profile with the most requested optional traits, then uses its deterministic profile signature as the final tie-break. It never unions profiles.
- Operation, profile, and trait arrays are bounded and duplicate-free.
- Surface and set-like array permutations produce byte-identical results.
- The compiler does not mutate caller-owned arrays or objects.
- Exclusions are sorted by `candidate_id` and report the first relational gate that failed: operation, lifecycle, then required trait.
- When every surface is excluded, the result is `status: "no_compatible_surfaces"` with `route_input: null`; it never claims an invalid zero-candidate object is ready for `recommend_route`.
- Every non-null `route_input` is checked against the shared `recommend_route` task and candidate validators before the compiler returns `status: "ready"`.

The fixture corpus is at `test/fixtures/routing/task-capability-profiles/v0.1/corpus.json`.

## Integration deliberately left out

This package slice does not add an MCP tool, edit `src/index.ts`, change provider clients, or update the shared current-state documents. A later integration change must separately:

1. Add the new subpath to shared package-surface documentation.
2. Decide whether an MCP projection is warranted and, if so, add its closed schema, handler, registry count, compatibility pins, and black-box coverage.
3. Wire an authorized caller to supply typed media surfaces before invoking `recommend_route`.
4. Reconcile `README.md`, `ROADMAP.md`, `HANDOFF.md`, and any current advisory only after the overlapping weekly composer lands.

None of those steps is implied or authorized by this compiler.
