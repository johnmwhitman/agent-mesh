# MeshFleet Media Execution Suite Design

**Date:** 2026-07-29
**Design status:** Approved by John; written specification awaiting review
**Implementation status:** Not started

## Decision

Add a source-level media execution subsystem to the MeshFleet package. The
subsystem owns durable media jobs, provider attempts, readiness evidence,
explicit execution authority, validated local artifacts, and execution
receipts for the portfolio's image, video, speech, music, and pixel-art lanes.

The subsystem lives under `src/media-execution/` and remains isolated from
MeshFleet's text-agent `RuntimeAdapter`, fleet/agent lifecycle tables, and
generic `spawn_fleet` surface. It exposes one shared service to a local CLI and
thin MCP tools. ArtCraft and Sprite Factory consume that service through typed
client integrations rather than treating MeshFleet as a media provider.

The complete capability registry covers:

- MiniMax image, video, speech, and music;
- Gemini and Imagen image generation and editing;
- Google Cloud TTS and Lyria music;
- GPT/OpenAI image generation through the current Codex sidecar;
- PixelLab image, character, rotation, tileset, state, and animation jobs;
- Grok image and video;
- the current Sora video, FAL image, and ArtCraft backend media surfaces.

Registration is not execution proof. A capability may be visible while
remaining non-dispatchable. Grok starts as `configured_unverified` with reason
`UNVERIFIED_AUTH` when local consumer auth state exists, or `unavailable` with
reason `AUTH_ADMISSION_MISSING` when it does not. Dormant or
Storyteller-coupled ArtCraft surfaces start with similarly honest readiness.

## Why this belongs in MeshFleet

The portfolio already has several working media wrappers and consumer clients,
but no common source of truth for:

- what each lane can do;
- whether it is locally dispatchable now;
- which provider and model actually ran;
- whether a job can be resumed after process or app restart;
- which artifacts were admitted and committed;
- which quota or spend authority covered an attempt; or
- whether a retry, fallback, or cancellation had the effect the UI claims.

ArtCraft's provider abstraction cannot carry this truth. Its generation rows
represent one provider, model, and provider job ID, while media orchestration
may have multiple attempts, nullable provider IDs, review states, and mixed
quota units. MeshFleet's current `RuntimeAdapter` is also the wrong boundary:
it models text-agent prompts, OS processes, stdout/stderr, and observed runtime
banners, not asynchronous provider jobs and binary artifacts.

MeshFleet is the correct package because the new subsystem extends its durable
coordination and receipt discipline. Isolation inside the package prevents
media execution from distorting the existing agent runtime or advisory routing
contracts.

## Goals

1. Represent the portfolio's supported media operations through closed,
   versioned, modality-specific request types.
2. Preserve synchronous, asynchronous, resumable, review-gated, and
   non-cancellable provider behavior without flattening them into a fake model
   API.
3. Separate static registration, local configuration, runtime readiness, and
   observed execution evidence.
4. Require explicit provider-call authority before every first attempt, retry,
   or provider change.
5. Keep credentials in the existing wrapper, Keychain, gcloud, Codex, and
   consumer-auth mechanisms; never copy secret values into MeshFleet.
6. Commit only admitted artifacts under a MeshFleet-owned local root and return
   artifact handles rather than binary payloads.
7. Record requested, selected, and observed provider/model truth plus budget
   and artifact evidence.
8. Give ArtCraft a durable local-media workflow that feeds its active desktop
   generation feed and does not require Storyteller upload.
9. Let Sprite Factory consume generated and staged assets while preserving its
   deterministic completion, provenance, licensing, human review, and engine
   gates.
10. Keep all existing MeshFleet callers behaviorally compatible until they
    opt into the media subsystem.

## Non-goals

- Treating MeshFleet as an ArtCraft `GenerationProvider`.
- Sending media work through `spawn_fleet` or an OpenCode agent.
- Moving or duplicating provider credentials.
- Claiming that capability registration proves auth, quota, health, billing,
  account ownership, or availability.
- Automatic cross-provider fallback, fan-out, or paid retry by default.
- Treating unmeasured subscription capacity as free or unlimited.
- Returning base64 media through MCP messages or fleet receipts.
- Opening a new unauthenticated TCP or SSE listener for ArtCraft.
- Making Grok dispatchable before its authentication admission is proven.
- Making Sora, FAL, or ArtCraft backend output "local" while completion still
  depends on Storyteller.
- Adding Midjourney or dormant Sora-image execution merely because static model
  entries or legacy source files exist.
- Adding 3D, Gaussian splat, or WorldLabs execution in the first suite.
- Provider calls, publication, installation, daemon changes, or deployment as
  part of offline implementation verification.

## Architectural boundary

```text
ArtCraft ───────────────┐
                       │
Sprite Factory ─────────┼──> MediaExecutionService
                       │       ├── capability registry and readiness
MeshFleet CLI / MCP ────┘       ├── authority and quote confirmation
                               ├── durable execution/attempt store
                               ├── provider adapters
                               ├── artifact admission/store
                               └── execution receipts

Provider adapters:
  MiniMax | Gemini/Imagen | Google Audio | GPT/Codex | PixelLab
  Grok | Sora | FAL | ArtCraft backend
```

The source boundary is:

```text
src/media-execution/
  contract/
    operations.ts
    requests.ts
    results.ts
    errors.ts
  capabilities/
    registry.ts
    readiness.ts
  lifecycle/
    state-machine.ts
    coordinator.ts
    recovery.ts
  authority/
    grants.ts
    quotes.ts
    decisions.ts
  artifacts/
    admission.ts
    store.ts
    types.ts
  receipts/
    events.ts
    projection.ts
  adapters/
    types.ts
    process.ts
    minimax.ts
    gemini-image.ts
    google-audio.ts
    codex-image.ts
    pixellab.ts
    grok.ts
    sora.ts
    fal.ts
    artcraft-backend.ts
  service.ts
  store.ts
  worker.ts
src/bin/media.ts
test/media-execution/
```

The media subsystem may reuse pure semantics such as requested-versus-observed
identity, lease fencing, immutable attempts, deterministic idempotency, and
sanitized Fleetbudget observations. It must not import MeshFleet's
fleet-coupled `core.ts`, agent `RuntimeAdapter`, or agent lifecycle tables as
its execution authority.

The first CLI can land without editing the current MCP registry. MCP tools are
thin registrations over the same service after the contract and CLI are
proven. This sequencing reduces collision with active tool-count and
conformance work; it does not reduce the final suite.

## Versioned request contract

The request version is:

```ts
export const MEDIA_REQUEST_VERSION =
  "meshfleet.media-request.v1" as const;
```

Every planning intent uses a common envelope:

```ts
interface MediaPlanIntentBase {
  version: typeof MEDIA_REQUEST_VERSION;
  idempotency_key: string;
  submitted_by: string;
  route: MediaRoutePolicy;
  output: MediaOutputPolicy;
  client_context?: MediaClientContext;
}

interface MediaOutputPolicy {
  accepted_mime_types: string[];
  maximum_artifacts: number;
  review: "none" | "required" | "provider_default";
}

interface MediaClientContext {
  consumer_job_id?: string;
  project_ref?: string;
  completion_target?:
    | "artcraft-active-feed"
    | "sprite-factory-intake"
    | "meshfleet-only";
}
```

`MediaPlanIntent` is a discriminated union whose variants extend the common base
with one exact `operation` literal and its matching input type. The validator
must not accept an independently typed `{ operation, input }` pair that could
combine, for example, `audio.tts` with `VideoGenerateInput`.

```ts
type MediaPlanIntent =
  | (MediaPlanIntentBase & {
      operation: "image.generate";
      input: ImageGenerateInput;
    })
  | (MediaPlanIntentBase & {
      operation: "image.edit";
      input: ImageEditInput;
    })
  | (MediaPlanIntentBase & {
      operation: "video.generate";
      input: VideoGenerateInput;
    })
  | (MediaPlanIntentBase & {
      operation: "video.image_to_video";
      input: ImageToVideoInput;
    })
  | (MediaPlanIntentBase & {
      operation: "audio.tts";
      input: TextToSpeechInput;
    })
  | (MediaPlanIntentBase & {
      operation: "audio.music";
      input: MusicInput;
    })
  | PixelMediaIntent;

interface MediaSubmission {
  version: typeof MEDIA_REQUEST_VERSION;
  plan_id: string;
  authority_ref: string;
}

type ResolvedMediaRequest = MediaPlanIntent & {
  plan_id: string;
  authority_grant_id: string;
};
```

`plan` accepts `MediaPlanIntent`; `submit` accepts only `MediaSubmission`.
The service constructs `ResolvedMediaRequest` from its immutable plan and
stored grant for adapter use. Callers never resubmit or mutate the operation
body at execution time.
Canonical semantic-request hashing excludes both gate references, `plan_id`
and `authority_ref`, while including every `MediaPlanIntent` field. The grant
binds that request hash and the independently hashed immutable plan. This keeps
the two phases unambiguous, preserves the exact operation/input pairing, and
prevents re-planning an identical intent from changing idempotency identity.

The caller supplies `idempotency_key`; MeshFleet assigns `execution_id`.
Idempotency is scoped to `(transport_principal, submitted_by,
idempotency_key)`. At submit, one SQLite transaction compares the plan's
semantic request hash, consumes the grant, reserves the idempotency tuple, and
inserts the execution plus first attempt under a unique constraint. A
concurrent loser returns the winning execution when the hash matches.
Submitting the same accepted request under the same tuple returns the same
execution. Reusing the tuple with a different hash fails with an idempotency
conflict and makes no provider call. Every `MediaPlanIntent` member, including
route, output policy, client context, and `submitted_by`, participates in the
canonical hash; JSON member order and insignificant encoding do not.

`submitted_by` is a bounded local consumer identifier such as `artcraft` or
`sprite-factory`. It is audit context, not authentication. Client
authentication and local principal binding remain host responsibilities.

### Operations

```ts
type MediaOperation =
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
```

The operation is the discriminant. Each operation has a closed input object;
there is no generic `params`, `attachments`, or provider-specific escape bag.

Representative shapes:

```ts
interface ImageGenerateInput {
  prompt: string;
  negative_prompt?: string;
  aspect_ratio?: string;
  width?: number;
  height?: number;
  count: number;
  references?: MediaArtifactHandle[];
}

interface ImageEditInput {
  prompt: string;
  source: MediaArtifactHandle;
  mask?: MediaArtifactHandle;
  references?: MediaArtifactHandle[];
  aspect_ratio?: string;
}

interface VideoGenerateInput {
  prompt: string;
  duration_seconds?: number;
  resolution?: string;
  prompt_optimization?: boolean;
}

interface ImageToVideoInput {
  prompt?: string;
  first_frame: MediaArtifactHandle;
  duration_seconds?: number;
  resolution?: string;
  prompt_optimization?: boolean;
}

interface TextToSpeechInput {
  text: string;
  voice: string;
  style?: string;
  language?: string;
  speed?: number;
  volume?: number;
  pitch?: number;
  format: "wav" | "mp3" | "ogg";
}

interface MusicInput {
  prompt: string;
  lyrics?: string;
  instrumental: boolean;
  auto_lyrics: boolean;
  negative_prompt?: string;
  seed?: number;
  duration_seconds?: number;
  format: "wav" | "mp3" | "ogg";
}

interface PixelInputBase {
  prompt: string;
  width_px: number;
  height_px: number;
  view?: "side" | "front" | "top_down" | "three_quarter";
  transparent: boolean;
  license_declaration: string;
}

interface PixelImageInput extends PixelInputBase {
  references?: MediaArtifactHandle[];
}

interface PixelCharacterInput extends PixelInputBase {
  existing_character?: MediaArtifactHandle;
}

interface PixelRotate8Input {
  source: MediaArtifactHandle;
  directions: 8;
  license_declaration: string;
}

interface PixelTilesetInput extends PixelInputBase {
  lower_description: string;
  upper_description: string;
}

interface PixelStateInput {
  source: MediaArtifactHandle;
  state_description: string;
  license_declaration: string;
}

interface PixelAnimationInput {
  source: MediaArtifactHandle;
  animation_template: string;
  requested_directions: 1 | 4 | 8;
  license_declaration: string;
}

type PixelMediaIntent =
  | (MediaPlanIntentBase & {
      operation: "pixel.image";
      input: PixelImageInput;
    })
  | (MediaPlanIntentBase & {
      operation: "pixel.character";
      input: PixelCharacterInput;
    })
  | (MediaPlanIntentBase & {
      operation: "pixel.rotate8";
      input: PixelRotate8Input;
    })
  | (MediaPlanIntentBase & {
      operation: "pixel.tileset";
      input: PixelTilesetInput;
    })
  | (MediaPlanIntentBase & {
      operation: "pixel.state";
      input: PixelStateInput;
    })
  | (MediaPlanIntentBase & {
      operation: "pixel.animation";
      input: PixelAnimationInput;
    });
```

Pixel inputs remain PixelLab-shaped rather than being forced into general image
fields. They include explicit pixel dimensions, view, transparency, lower and
upper tile descriptions, existing character references, requested directions,
animation template, license declaration, and review/staging policy as
appropriate to the operation.

Unknown members fail before an execution is created. Provider adapters may
support a subset of a typed operation's optional fields; capability
constraints declare that subset and validation rejects incompatible explicit
selections rather than silently dropping fields. For example, references must
not be accepted for an Imagen path that ignores them.

## Route policy

```ts
interface MediaRoutePolicy {
  preferred_provider?: string;
  pinned_provider?: string;
  forbidden_providers?: string[];
  requested_model?: string;
  allow_provider_change: boolean;
  maximum_attempts: number;
}
```

- `preferred_provider` is advisory.
- `pinned_provider` is mandatory and disables provider change.
- `requested_model` is a caller request, not observed identity.
- `allow_provider_change` is still subordinate to the authority grant.
- `maximum_attempts` includes the first attempt.

Provider routing must be deterministic over an explicit capability/readiness
snapshot. It never derives privacy, auth, availability, or cost from provider
names or a RoutePlane model listing.

The default route policy is one attempt, no provider change. No automatic
fallback occurs merely because another adapter is registered.
Both planning selection and every attempt launch require current
`dispatchable: true`; a pinned provider cannot override that gate. An
`explicit_only` capability additionally requires `pinned_provider` to name it.
`plan`, `quote`, and `submit` fail with the non-dispatchable class before
provider contact for every false or expired readiness state, including Grok.

## Execution authority and quotes

Authority is a pre-execution gate. Receipts are post-action evidence. The two
must remain separate.

Execution uses a three-step local flow:

1. `plan` validates and canonicalizes the operation, selects a capability from
   a named readiness snapshot, computes `request_sha256` over the canonical
   `MediaPlanIntent`, creates a quote, and persists an immutable plan plus
   `plan_sha256`. Neither `plan_id` nor the opaque `authority_ref` is part of
   the semantic request hash. Planning does not contact a media provider.
2. `confirm` is accepted only through a trusted host boundary after a human
   action. It binds the plan hash, request hash, provider/model, unit, ceiling,
   attempt count, provider-change policy, approver principal, and expiry into a
   stored authority grant.
3. `submit` carries only the `plan_id` and opaque `authority_ref`. The service
   resolves both from its own store and refuses any mismatch before launch.

The MCP or renderer caller cannot mint authority by supplying an
`approved_by` string. The host that creates the confirmation must bind a local
authenticated principal or explicitly label the evidence `reported`; the
media receipt never upgrades that local claim into human-authentication proof.

```ts
type MediaBudgetUnit =
  | "usd"
  | "generation"
  | "subscription_unmeasured"
  | "unknown";

interface MediaAuthorityGrant {
  grant_id: string;
  plan_id: string;
  plan_sha256: string;
  request_sha256: string;
  allowed_providers: string[];
  allowed_models?: string[];
  unit: MediaBudgetUnit;
  maximum_amount: number | null;
  maximum_attempts: number;
  maximum_fanout: 1;
  provider_change: "forbidden" | "allowed_within_grant";
  approved_by: string;
  approved_for_principal: string;
  issued_at_ms: number;
  expires_at_ms: number;
  consumed_by_execution_id?: string;
}

interface MediaProbeAuthorityGrant {
  grant_id: string;
  capability_id: string;
  provider: string;
  model?: string;
  maximum_probe_count: 1;
  approved_by: string;
  approved_for_principal: string;
  issued_at_ms: number;
  expires_at_ms: number;
  consumed_at_ms?: number;
}

interface MediaAuthorityDecision {
  decision_id: string;
  plan_id?: string;
  capability_id?: string;
  execution_id?: string;
  attempt_id?: string;
  action:
    | "first_attempt"
    | "retry"
    | "provider_change"
    | "readiness_probe";
  outcome: "allowed" | "denied";
  grant_id: string;
  quote_id?: string;
  selected_provider: string;
  selected_model?: string;
  decided_at_ms: number;
  reason_codes: string[];
}

interface MediaQuote {
  quote_id: string;
  request_sha256: string;
  provider: string;
  model?: string;
  unit: MediaBudgetUnit;
  estimated_amount?: number;
  estimate_evidence: "measured" | "declared" | "unmeasured" | "unknown";
  issued_at_ms: number;
  expires_at_ms: number;
}
```

The authority gate verifies the request hash, provider/model membership,
plan hash, attempt ceiling, fanout ceiling, provider-change policy, expiry, and
quote compatibility before dispatch. It runs again before every retry or
provider change. `authority_ref` is an opaque identifier into the host-owned
store, not a bearer credential. The trusted transport supplies the local
submission principal independently of request JSON, and that principal must
match `approved_for_principal`. The store atomically consumes a grant when it
creates the first execution; the grant cannot create a second execution.
Knowing or guessing the reference is therefore insufficient. An idempotent
resubmission of the same accepted request returns the original execution
without consuming or requiring a second grant, but only to the same
transport-authenticated local principal.

`allowed_models` is never a wildcard. When the selected capability exposes a
concrete model, the grant must contain that exact model. It may be omitted only
when the capability exposes no selectable model and the plan carries no
requested or selected model; any later model selection then requires a new
grant.

Rules:

1. Missing, expired, mutated, or incompatible authority fails before launch.
2. `subscription_unmeasured` and `unknown` require explicit authorization; they
   are never treated as zero. Their grants use `maximum_amount: null`, meaning
   a numeric ceiling is inapplicable because the amount is indeterminate, not
   that attempts or provider changes are unlimited. `usd` and `generation`
   grants require a finite non-negative `maximum_amount`.
   For numeric grants, the sum of estimates on all allowed attempt decisions
   under the grant plus the candidate attempt must remain within that ceiling;
   a missing numeric estimate fails closed. A later provider settlement above
   estimate is recorded as an overrun and cannot retroactively change what was
   authorized.
3. Fleetbudget evidence may inform a quote or exclusion, but it is advisory
   evidence and cannot reserve quota or authorize execution.
4. PixelLab generation-pool units never become USD.
5. Estimated cost remains distinct from provider-settled cost.
6. No v1 automatic fanout is permitted; `maximum_fanout` is fixed at one.
7. A timed-out or cancelled provider attempt may still have consumed quota.
8. A provider change is a product change and is recorded explicitly, even when
   allowed.
9. A live readiness probe uses a separate one-use `MediaProbeAuthorityGrant`,
   creates a `readiness_probe` decision, and binds one capability, provider,
   optional exact model, principal, and expiry. An execution grant cannot
   authorize a probe, and a probe grant cannot authorize execution. Probe
   confirmation is available only through the same trusted interactive CLI or
   Tauri host channels as execution confirmation.

Attempt authorization is explicit:

| Action | Existing grant may be reused when | New human confirmation required when |
|---|---|---|
| First attempt | Never; submit consumes a fresh grant into the execution | Always |
| Same-provider retry | Grant is unexpired and provider, model, amount/unit, and attempt ceiling still match | Any bound is exceeded or the grant expired |
| Provider change | Grant says `allowed_within_grant` and the new provider/model and quote remain inside its bounds | Provider/model is absent, quote/unit changes outside bounds, or policy forbids change |

Every row still creates a new immutable `MediaAuthorityDecision` before
provider contact. Reusing a grant is not the same as reusing a decision. One
allowed attempt decision covers that attempt's required submit, poll, collect,
and provider-side cancel calls; it does not authorize a new attempt, probe, or
provider change outside the table.

## Durable lifecycle

The subsystem has one sovereign `execution_id` and one or more immutable
`attempt_id` values. Provider job IDs are nullable attempt annotations and are
not assumed unique outside their provider.

Execution states:

```ts
type MediaExecutionState =
  | "accepted"
  | "queued"
  | "submitting"
  | "running"
  | "awaiting_artifact"
  | "needs_review"
  | "cancel_requested"
  | "succeeded"
  | "failed"
  | "interrupted_unknown"
  | "cancelled_best_effort"
  | "expired";
```

Attempt states:

```ts
type MediaAttemptState =
  | "reserved"
  | "launching"
  | "submitted"
  | "polling"
  | "collecting"
  | "settled_success"
  | "settled_failure"
  | "settled_unknown"
  | "cancel_requested"
  | "cancelled_best_effort";
```

The lifecycle has a concrete, listener-free driver. `meshfleet-media submit`,
status/review commands, ArtCraft startup, and Sprite Factory startup ensure an
active `meshfleet-media worker --run-until-idle` process exists. Competing
starters acquire one SQLite worker-singleton lease; the winner runs and losers
exit without polling. The worker opens no network listener. It claims due
executions through renewable SQLite leases,
polls or collects using durable continuation references, fences every write by
lease generation, and exits after a bounded idle period. It may outlive the
invoking client. If the worker is killed, resumable jobs remain stalled but
truthful; the next trusted invocation reacquires them. No launchd install or
always-on daemon is required. A synchronous attempt that loses its process
without durable continuation becomes `interrupted_unknown`.
Production defaults are a 60-second lease, renewal every 20 seconds, and exit
after 30 idle seconds. Tests may inject shorter clocks; request and MCP inputs
cannot change these values.

Execution transitions are closed:

| From | Allowed next states |
|---|---|
| `accepted` | `queued`, `failed`, `expired`, `cancel_requested` |
| `queued` | `submitting`, `failed`, `expired`, `cancel_requested` |
| `submitting` | `queued` only after the attempt settles failure and retry is authorized; otherwise `running`, `awaiting_artifact`, `needs_review`, `failed`, `interrupted_unknown`, `cancel_requested` |
| `running` | `queued` only after the attempt settles failure and retry is authorized; otherwise `awaiting_artifact`, `needs_review`, `failed`, `interrupted_unknown`, `cancel_requested` |
| `awaiting_artifact` | `queued` only after the attempt settles failure and retry is authorized; otherwise `needs_review`, `succeeded`, `failed`, `interrupted_unknown`, `cancel_requested` |
| `needs_review` | `awaiting_artifact`, `succeeded`, `failed`, `expired`, `cancel_requested` |
| `cancel_requested` | `cancelled_best_effort`, `failed` |

`succeeded`, `failed`, `interrupted_unknown`, `cancelled_best_effort`, and
`expired` are terminal execution states. A terminal unknown result requires an
operator-visible new submission; it never silently resumes or retries.
Reject-all review becomes `failed`; abandoned review may become `expired`.
Review candidates are admitted into a quarantined candidate set first, and
selection atomically promotes the chosen set before success. When a retry is
authorized after a settled attempt failure, the service appends a
supersession event linking the immutable prior attempt to the new attempt
before launch. The execution may return to `queued` only after the current
attempt is durably `settled_failure` and fenced; no live, uncertain, or
best-effort-cancelled attempt may be re-queued.
Cancellation terminates the execution; retry after cancellation requires a
new execution.

Attempt transitions are also closed:

| From | Allowed next states |
|---|---|
| `reserved` | `launching`, `settled_failure`, `cancel_requested` |
| `launching` | `submitted`, `collecting`, `settled_failure`, `settled_unknown`, `cancel_requested` |
| `submitted` | `polling`, `collecting`, `settled_failure`, `settled_unknown`, `cancel_requested` |
| `polling` | `polling`, `collecting`, `settled_failure`, `settled_unknown`, `cancel_requested` |
| `collecting` | `settled_success`, `settled_failure`, `settled_unknown`, `cancel_requested` |
| `cancel_requested` | `cancelled_best_effort`, `settled_failure`, `settled_unknown` |

`settled_success`, `settled_failure`, `settled_unknown`, and
`cancelled_best_effort` are terminal attempt states.

Lifecycle laws:

- Persist the execution and reserved attempt before launching a wrapper.
- A synchronous wrapper still traverses the durable lifecycle; it merely moves
  from launch to settlement within one host process.
- Store provider continuation material as soon as the adapter observes it.
- An asynchronous attempt without durable continuation material after an
  uncertain launch becomes `interrupted_unknown`; it is not retried
  automatically.
- Restart recovery resumes provider polling only when the adapter has sufficient
  durable continuation material.
- A late artifact from a cancelled or superseded attempt is quarantined and
  cannot settle the execution.
- Success is terminal only after artifact admission and atomic commit.
- `needs_review` is non-terminal and durable. PixelLab candidate boards and
  similar selection workflows use it rather than claiming success.
- A retry creates a new attempt and a fresh persisted authority decision.
  That decision may reference the execution's existing still-valid grant only
  when the retry remains inside every pre-approved bound; otherwise a new
  confirmation and grant are required. Prior attempts remain immutable.
- Settlement is fenced and idempotent. Competing pollers or process callbacks
  cannot settle twice.
- Cancellation is best effort unless the provider supplies independently
  observed confirmation.
- Grant or quote expiry never retroactively cancels a launched attempt. The
  service rechecks current readiness and authority immediately before each
  attempt; an expired readiness snapshot, quote at confirmation time, or grant
  at attempt time fails closed before provider contact. Once a grant is
  issued, later quote expiry does not invalidate it; grant expiry governs.

The store uses separate SQLite tables for executions, attempts, ordered events,
authority decisions, artifacts, and review decisions. It does not write media
rows into the existing fleet, agent, message, or agent-attempt tables.

## Capability and readiness contract

Capabilities are keyed by operation plus adapter, not by a vendor-wide Boolean.

```ts
interface MediaCapability {
  capability_id: string;
  adapter_id: string;
  provider: string;
  operation: MediaOperation;
  models: string[];
  constraints: MediaCapabilityConstraints;
  lifecycle: "synchronous" | "asynchronous" | "review_gated" | "mixed";
  cancel_effect: "unsupported" | "best_effort" | "confirmed";
  selection_mode: "automatic_or_explicit" | "explicit_only";
  budget_units: MediaBudgetUnit[];
}

type MediaReadinessState =
  | "catalogued"
  | "wrapper_present"
  | "configured_unverified"
  | "probe_verified"
  | "degraded"
  | "auth_expired"
  | "policy_blocked"
  | "unavailable";

interface MediaReadinessEvidence {
  capability_id: string;
  state: MediaReadinessState;
  dispatchable: boolean;
  checked_at_ms: number;
  expires_at_ms?: number;
  evidence_kind:
    | "static_registration"
    | "local_executable"
    | "credential_reference"
    | "provider_probe"
    | "execution_receipt";
  reason_codes: string[];
}
```

Execution decisions require `plan_id` and `quote_id`; probe decisions require
`capability_id` and omit `quote_id`. Supplying both plan and capability or
neither is invalid.

Ordinary capability listing and readiness checks do not contact providers.
They may prove that a wrapper exists and that a named credential mechanism
appears configured without reading or returning its value. A provider probe is
separate, explicit, potentially billable, and requires provider-call authority.

Automatic routing requires `dispatchable: true` and a readiness state of
`probe_verified` or `degraded`. A `degraded` capability is eligible only when
its reason codes do not concern auth, policy, quota, privacy, or artifact
safety. `catalogued`, `wrapper_present`, `configured_unverified`,
`auth_expired`, `policy_blocked`, and `unavailable` are never dispatchable. A
local executable alone does not prove a provider session.
Automatic routing also excludes every `explicit_only` capability. Codex image
is `explicit_only`; its readiness cannot override that policy.

Dispatchable evidence must have `expires_at_ms`; expiry makes it
non-dispatchable until refreshed. Absence of expiry is allowed only for
non-dispatchable static or executable evidence. `configured_unverified` means
a credential reference appears present but no provider evidence exists.
`auth_expired` requires earlier provider or execution evidence whose auth has
since failed. `unavailable` means the required executable or credential
reference is absent. `degraded` is set only by an adapter using stable reason
codes; auth, policy, quota, privacy, and artifact-safety reasons force
`dispatchable: false`, while bounded performance or optional-feature loss may
remain dispatchable.

Grok is represented as `configured_unverified` with reason code
`UNVERIFIED_AUTH` when local consumer state exists, otherwise `unavailable`
with `AUTH_ADMISSION_MISSING`. `unverified_auth` is not a separate readiness
state.

## Initial provider truth

| Adapter | Operations | Initial truth |
|---|---|---|
| `minimax` | image generation, text/image-to-video, TTS, music | Existing wrapper; mixed sync/async; executable after machine-protocol and artifact hardening |
| `gemini-image` | image generation and editing | Existing wrapper; synchronous; references are unsupported on Imagen and must be rejected there |
| `google-audio` | TTS and Lyria music | Existing wrapper; synchronous; cost output is an estimate, not settlement |
| `codex-image` | image generation | Existing Codex-login sidecar; explicit selection only; unmeasured, slow, racy until hardened; never bulk or automatic |
| `pixellab` | all declared pixel operations | Existing wrapper; strongest async/provenance surface; review and resume semantics remain typed |
| `grok` | image and image-to-video | Consumer source exists in ArtCraft; auth admission is fail-closed; non-dispatchable `configured_unverified` or `unavailable` |
| `sora` | video generation | Consumer source and remote session probe exist; completion is Storyteller-coupled; no local execution claim |
| `fal` | image generation | BYOK enqueue exists; completion is Storyteller-coupled; no local execution claim |
| `artcraft-backend` | image and video generation | Durable remote backend path exists; Storyteller-auth and remote-artifact dependent |

Midjourney is not registered as dispatchable: the current modern ArtCraft
command returns not implemented despite static UI entries. Sora image is not a
current compiled path. WorldLabs is a separate dimensional/3D capability and
remains outside this design's first suite.

Sora, FAL, and ArtCraft-backend capabilities are describe/readiness-only while
their completion remains Storyteller-coupled. `plan`, `quote`, and `submit`
must return the non-dispatchable class before enqueueing or contacting those
providers. The ArtCraft MeshFleet-local workflow cannot start them. A later
activation may change this only after the adapter proves a locally admitted
artifact path and receives separately authorized provider evidence.

## Adapter contract

```ts
type ValidationResult =
  | { valid: true }
  | { valid: false; code: string; field_paths: string[] };

interface MediaAttemptContext {
  execution_id: string;
  attempt_id: string;
  request: ResolvedMediaRequest;
  capability: MediaCapability;
  authority_decision_id: string;
  staging_token: string;
}

interface MediaPollContext {
  execution_id: string;
  attempt_id: string;
  provider_job_id?: string;
  continuation_ref?: string;
}

interface MediaCollectContext extends MediaPollContext {}

interface MediaCancelContext extends MediaPollContext {
  reason_code: string;
}

type MediaSubmitResult =
  | { status: "submitted"; provider_job_id?: string; continuation_ref?: string }
  | { status: "completed"; artifacts: AdapterArtifactCandidate[] }
  | { status: "needs_review"; candidates: AdapterArtifactCandidate[] }
  | { status: "failed"; code: string; retryability: "no" | "same_provider" };

type MediaPollResult =
  | { status: "pending"; continuation_ref?: string }
  | { status: "ready_to_collect"; continuation_ref?: string }
  | { status: "needs_review"; candidates: AdapterArtifactCandidate[] }
  | { status: "failed"; code: string; retryability: "no" | "same_provider" };

type MediaCollectResult =
  | { status: "completed"; artifacts: AdapterArtifactCandidate[] }
  | { status: "needs_review"; candidates: AdapterArtifactCandidate[] }
  | { status: "failed"; code: string; retryability: "no" | "same_provider" };

type MediaCancelResult =
  | { effect: "unsupported" | "requested" | "confirmed" }
  | { effect: "failed"; code: string };

interface AdapterArtifactCandidate {
  relative_path: string;
  declared_media_class: "image" | "video" | "audio" | "pixel_bundle";
  declared_mime_type?: string;
}

interface MediaProviderAdapter {
  readonly adapter_id: string;

  describe(): MediaCapability[];
  checkLocalReadiness(): Promise<MediaReadinessEvidence[]>;
  validate(intent: MediaPlanIntent, capability: MediaCapability): ValidationResult;
  quote(intent: MediaPlanIntent, capability: MediaCapability): Promise<MediaQuote>;
  submit(context: MediaAttemptContext): Promise<MediaSubmitResult>;
  poll(context: MediaPollContext): Promise<MediaPollResult>;
  collect(context: MediaCollectContext): Promise<MediaCollectResult>;
  cancel(context: MediaCancelContext): Promise<MediaCancelResult>;
}
```

These are closed wire-neutral result shapes. Each adapter validates any
provider-specific continuation data against its own versioned schema before
the store returns an opaque `continuation_ref`; callers never submit
continuation payloads. Stable `code` and `reason_codes` values come from the
contract error catalog, not provider prose.
`staging_token` is a service-generated opaque relative identifier for the
attempt's bridge-owned output directory. The process layer resolves it under
the fixed staging root; adapters and callers cannot turn it into an absolute
or traversing path.

Adapters may return `unsupported` for `poll`, `collect`, or `cancel` when the
operation does not have that phase. The service, not the adapter, owns lifecycle
transition authority and persistence.

Adapters never accept:

- arbitrary executable paths;
- caller-supplied argv;
- caller-supplied environment variables;
- arbitrary current working directories;
- caller-selected credential files or secret values;
- arbitrary output roots; or
- shell command strings.

Each adapter uses a fixed executable allowlist and fixed argument construction,
with `shell: false`, a scrubbed explicit environment, a fixed working directory,
bounded stdout/stderr, and a private bounded stdin protocol. Prompts, text, and
lyrics do not appear on argv.

Process cancellation must target the process group or full child tree where
the platform supports it. A direct-child signal alone is insufficient.

## Wrapper machine protocol

Existing wrappers are human-oriented and inconsistent. Each executable adapter
must either gain or be fronted by a versioned machine protocol before it is
marked dispatchable.

Request:

```json
{
  "version": "meshfleet.media-adapter-request.v1",
  "attempt_id": "opaque-local-id",
  "operation": "video.generate",
  "input": {},
  "provider_model": "exact-model-id",
  "output_directory": "bridge-owned-relative-id"
}
```

The request is written as one bounded JSON document on private stdin. The
adapter controls the actual absolute output directory and rejects traversal.

Events are newline-delimited JSON:

```json
{"version":"meshfleet.media-adapter-event.v1","type":"accepted","provider_job_id":"opaque"}
{"version":"meshfleet.media-adapter-event.v1","type":"progress","phase":"polling"}
{"version":"meshfleet.media-adapter-event.v1","type":"artifact","relative_path":"output-1.png"}
{"version":"meshfleet.media-adapter-event.v1","type":"usage","unit":"generation","amount":1}
{"version":"meshfleet.media-adapter-event.v1","type":"terminal","status":"succeeded"}
```

The event schema is closed, bounded, and secret-free. Human provider prose is
not copied into receipts. Diagnostics use stable codes and redacted bounded
messages. The service validates a closed event sequence:

1. exactly one `accepted` event comes first;
2. zero or more `progress`, `usage`, and `artifact` events may follow;
3. artifact count is bounded and each relative path is unique;
4. exactly one `terminal` event ends the stream;
5. no event is accepted after `terminal`; and
6. process exit without terminal is a typed protocol failure, never success.

An `artifact` or `terminal` event cannot forge an earlier accepted provider ID.
Usage may be repeated before terminal and is accumulated by its declared unit;
mixed units fail unless the capability explicitly declares them.

Provider-specific hardening:

- MiniMax video emits the task ID immediately and supports later resume by ID.
- MiniMax image/audio/music use stable output records and no success exit over
  undecodable raw error bytes.
- PixelLab records background job IDs before polling and preserves
  provider-specific continuation and provenance rather than relying on a
  generic image-only job resume.
- Gemini/Imagen and Google audio write to staging, validate output, and commit
  atomically; requested formats may not silently change.
- Codex image uses invocation-owned discovery so concurrent runs cannot select
  one another's newest image.
- Grok remains non-dispatchable until authoritative cookie admission and an
  explicitly authorized live first flight are proven.

## Artifact admission and storage

The control plane returns handles, never inline media:

```ts
interface MediaArtifactHandleBase {
  artifact_id: string;
  execution_id: string;
  attempt_id: string;
  byte_length: number;
  sha256: string;
}

interface SingleMediaArtifactHandle extends MediaArtifactHandleBase {
  media_class: "image" | "video" | "audio";
  mime_type: string;
  width?: number;
  height?: number;
  duration_ms?: number;
  frame_count?: number;
}

interface MediaBundleEntry {
  relative_name: string;
  mime_type: string;
  byte_length: number;
  sha256: string;
}

interface MediaBundleHandle extends MediaArtifactHandleBase {
  media_class: "pixel_bundle";
  mime_type: "application/vnd.meshfleet.pixel-bundle.v1";
  entries: MediaBundleEntry[];
}

type MediaArtifactHandle =
  | SingleMediaArtifactHandle
  | MediaBundleHandle;
```

Admission requires:

1. bridge-owned staging and destination roots;
2. canonical containment after resolution;
3. regular file, no symlink, directory, FIFO, socket, or device;
4. generated destination names and no caller-controlled absolute paths;
5. bounded file count and total bytes per attempt;
6. magic-byte and MIME agreement;
7. bounded image decode, dimensions, duration, frame count, and audio/video
   probing appropriate to media class;
8. SHA-256 and immutable provenance binding to the attempt;
9. atomic no-clobber commit; and
10. rejection of files arriving after cancellation or supersession.

Handles expose no filesystem path. Trusted consumer integrations call a
host-only materialization method with `artifact_id` and a registered consumer
ID. The service performs a content-addressed copy into that consumer's
host-configured root; MCP and request JSON cannot supply a destination.
Multi-file pixel bundles and review candidate sets validate completely and
commit in one transaction, or the whole set remains quarantined.

Remote URLs are retrieval inputs, not artifacts. Downloads use provider-specific
host policy, HTTPS, redirect policy, byte/time bounds, and staged admission.
Signed URL expiry is recorded only as retrieval evidence and never becomes the
durable result.

## Receipts and non-claims

Each ordered execution event records:

- execution and attempt IDs;
- request hash;
- requested provider/model;
- selected provider/model;
- provider-observed model or `unverified`;
- adapter ID and version;
- provider job ID when available;
- authority grant, quote, and decision references;
- attempt timing and terminal state;
- artifact IDs and hashes;
- estimated and settled usage evidence;
- cancellation effect; and
- provider-change chain.

Receipt evidence levels reuse MeshFleet's existing vocabulary:
`none`, `reported`, `observed`, and `attested`. A wrapper's self-report is not
automatically `observed`; a local artifact hash proves admitted bytes, not
provider authorship or billing.

The suite does not claim:

- that the requested model executed when the provider did not report it;
- that a provider accepted cancellation merely because a local process died;
- that estimated cost equals settlement;
- that a missing provider job ID means no provider work happened;
- that an artifact is licensed for publication;
- that a MeshFleet receipt authenticates a human approver; or
- that registration/readiness proves account ownership.

## CLI and MCP surfaces

The CLI executable is `meshfleet-media`:

```text
meshfleet-media capabilities --json
meshfleet-media readiness --json
meshfleet-media plan < request-intent.json
meshfleet-media confirm --plan-id <id>
meshfleet-media submit < submission.json
meshfleet-media status --execution-id <id>
meshfleet-media cancel --execution-id <id> --reason-code <code>
meshfleet-media artifacts --execution-id <id>
meshfleet-media review --execution-id <id> --select <candidate-id>
meshfleet-media worker --run-until-idle
```

Automation modes emit one closed JSON document per invocation. Submit reads
only stdin. No prompt, text, lyrics, mask, reference bytes, credential, or
arbitrary path is accepted on argv.

`confirm` is not exposed as a generic renderer or unauthenticated MCP action.
The standalone CLI may offer it only as an interactive trusted-host command
that refuses non-interactive stdin and records the local approver evidence
level. ArtCraft instead asks its Tauri backend to confirm immediately after a
specific human UI action; the backend binds the returned plan hash and does not
accept an arbitrary authority object from JavaScript.

The v1 confirmation channels are limited to interactive CLI and the specific
ArtCraft Tauri command. Sprite Factory automation and MCP-only clients submit a
plan confirmed through the interactive CLI for their authenticated local
principal; the trusted host resolves the bound grant without disclosing its
reference. A future signed host API requires a new design review; there is no
development backdoor or caller-supplied `approved_by`.

Exit classes:

- `0`: request processed and a valid response emitted;
- `2`: closed CLI/request validation failure;
- `3`: capability not registered;
- `4`: capability registered but non-dispatchable;
- `5`: authority or quote refusal;
- `6`: execution/provider failure represented durably;
- `7`: internal or storage failure.

MCP tools use the same service:

- `list_media_capabilities_v1`
- `check_media_readiness_v1`
- `plan_media_job_v1`
- `submit_media_job_v1`
- `get_media_job_v1`
- `cancel_media_job_v1`
- `list_media_artifacts_v1`
- `review_media_job_v1`

MCP does not embed binary data or credential fields. Tool schemas are closed and
versioned. `plan_media_job_v1` creates a non-executing plan and quote.
`submit_media_job_v1` accepts only a previously persisted `plan_id`; it cannot
confirm or mint a grant. After the human confirms that plan through the
interactive CLI, the server resolves exactly one unconsumed grant bound to the
MCP transport principal from the host store. Zero or multiple matches fail
closed. The opaque `authority_ref` is therefore never copied through an agent
prompt, environment variable, file handoff, or MCP argument. ArtCraft's Tauri
host continues to use the IDs-only `MediaSubmission` contract internally.
Registration requires updating the exact tool-count, compatibility, README,
built catalog, and black-box conformance pins from observed output, not
guessing source hashes.

## ArtCraft integration

ArtCraft gains a dedicated local-media client under a new provider-neutral
service namespace. MeshFleet is not added to the shared `GenerationProvider`
enum.

The Tauri backend:

1. probes the local bridge version and capabilities;
2. plans a typed intent through private stdin and returns the quote to the UI;
3. after the specific human confirmation action, mints the bound grant and
   submits the IDs-only `MediaSubmission`;
4. stores the MeshFleet execution ID separately from provider job IDs;
5. polls or resumes by execution ID;
6. projects `queued`, `running`, `needs_review`, `succeeded`, `failed`,
   `interrupted_unknown`, and cancellation states;
7. content-copies only admitted bridge artifacts into ArtCraft-owned storage
   through the registered-consumer materialization method;
8. updates the appropriate task record; and
9. emits the existing typed image or video completion event consumed by
   `useDesktopGenerationFeed`.

State projection is explicit:

| MeshFleet state | ArtCraft projection |
|---|---|
| `accepted`, `queued`, `submitting` | queued |
| `running`, `awaiting_artifact` | processing |
| `needs_review` | review required; no completion event |
| `succeeded` | complete only after ArtCraft-owned atomic artifact commit |
| `failed`, `expired` | terminal failure with stable reason |
| `interrupted_unknown` | terminal unknown; never auto-regenerate |
| `cancel_requested` | cancelling |
| `cancelled_best_effort` | cancelled with unconfirmed-provider warning |

Grok private-local image admission and atomic persistence are extracted into
provider-neutral helpers. Grok-specific task lookup, provider assumptions,
cookie auth, and in-memory queue behavior are not copied.
The workflow is additive at the consumer-facing API and UI boundary; this
internal helper extraction is an intentional refactor covered by existing Grok
regression tests and does not remove the Grok surface.

ArtCraft startup reconciles incomplete MeshFleet executions. It never
regenerates on an uncertain restart. A running synchronous job whose host
process disappeared becomes `interrupted_unknown` unless durable provider
continuation proves it can resume.

The UI presents a "Local Media via MeshFleet" workflow with capability-level
readiness and remediation. It does not show an actionable Grok browser-login
loop while the cookie allowlist is empty. It displays requested versus actual
provider/model and whether budget evidence is measured, unmeasured, or unknown.

Local completion does not require a Storyteller batch token, upload, customer
session, or gallery expansion request. Existing Storyteller paths remain
unchanged for callers that choose them.

## Sprite Factory integration

Sprite Factory keeps authority over deterministic completion and review. The
integration is an opt-in acquisition/generation seam:

```text
MeshFleet admitted artifact or staged pixel bundle
  -> Sprite Factory intake
  -> deterministic post-processing and family completion
  -> provenance and license gates
  -> exact-byte human review
  -> engine validation
```

The trusted Sprite Factory client receives a closed intake manifest, not a raw
path:

```ts
interface SpriteFactoryMediaIntakeV1 {
  version: "sprite-factory.meshfleet-intake.v1";
  artifacts: Array<{
    artifact_id: string;
    sha256: string;
  }>;
  execution_id: string;
  attempt_id: string;
  requested_provider?: string;
  selected_provider: string;
  observed_provider_model?: string;
  prompt_sha256: string;
  generation_count?: number;
  license_declaration: string;
  review_state: "unreviewed" | "candidate_selected";
}
```

Sprite Factory resolves the IDs through its registered consumer root and
verifies every copied hash. Missing, empty, or incompatible license and
provenance fields fail intake before deterministic post-processing; MeshFleet
artifact admission does not imply Sprite Factory license approval.

PixelLab candidate boards become durable `needs_review` executions. Selecting a
candidate does not regenerate it. PixelLab fetch manifests, hashes, prompt,
provider facts, generation count, license declaration, and endpoint-specific
provenance remain intact and are bound to MeshFleet artifact IDs.

Sprite Factory may request MiniMax or other general image inputs, but it does
not delegate semantic approval, licensing approval, or engine integration to
MeshFleet. Existing direct generation remains available until parity and
recovery evidence justify changing the default.

No provider adapter may condition on non-commercial reference pixels where the
portfolio's license rules prohibit it.

## Security and privacy invariants

- No generic `spawn_fleet`, arbitrary command, shell, cwd, argv, environment,
  model-provider token, or output-root surface is reachable from ArtCraft or
  Sprite Factory.
- Credentials never appear in request JSON, argv, environment snapshots,
  SQLite rows, receipts, fleet messages, logs, diagnostics, or artifacts.
- Child environments are allowlisted rather than inherited wholesale.
- Prompts and other creative inputs use bounded stdin, never argv.
- Stdout and stderr are bounded independently; overflow is a typed failure.
- ArtCraft mode opens no TCP or SSE listener.
- The bridge rejects option-shaped identities, path separators in adapter IDs,
  traversal, absolute paths, symlinks, replacement races, device files, decode
  bombs, excess artifacts, MIME mismatch, and late results.
- Cancellation kills the full local process tree where possible, fences late
  settlement, and releases local reservations exactly once.
- macOS and Linux process-group behavior have platform fixtures. On a platform
  without a verified full-tree primitive, the capability declares cancellation
  `unsupported`; local child exit is not reported as provider cancellation.
- Provider calls and live readiness probes are separately authorized because
  they may spend quota or expose prompt content externally.
- A sentinel-secret test suite proves that secret-shaped values do not appear
  in any serialized surface or child invocation record.

## Compatibility

- Existing 36 MCP tools and their schemas remain unchanged until the additive
  media registration slice.
- Existing agent runtime, agent lifecycle, Discussion, A2A, routing, verifier,
  Fleetbudget, RoutePlane catalog, and speculative-planner semantics remain
  unchanged.
- Existing ArtCraft Storyteller, FAL, Sora, and Grok code remains available.
  The local-media workflow is additive.
- Existing Sprite Factory CLI and direct provider paths remain available during
  opt-in adoption.
- Old MeshFleet ledgers without media tables open normally. Media storage uses
  a separate database at the host-configured
  `MESHFLEET_MEDIA_DB_FILE` path, defaulting to
  `~/.config/meshfleet/media-execution.db`. Admitted artifacts use the
  host-configured `MESHFLEET_MEDIA_ARTIFACT_ROOT`, defaulting to
  `~/.config/meshfleet/media-artifacts`. Neither path is accepted through MCP
  or request JSON. Media state cannot cause legacy recovery to adopt
  executions as agents.
- Package exports, bins, tool count, compatibility records, and built `dist/`
  are updated only in their named implementation slices.

## Implementation decomposition

The final suite is delivered through bounded waves, all under this design:

1. **Contract and fake plane:** closed types, state machine, separate store,
   idempotency, authority, artifact handles, fake adapters, and the complete
   `meshfleet-media` executable plus lease-fenced run-until-idle worker against
   the fake plane. The fake plane must simulate MiniMax-style task-ID
   detach/restart, PixelLab-style review candidates and best-effort
   cancellation, and interruption without continuation becoming
   `interrupted_unknown`.
2. **Safe process and artifact boundary:** bounded stdin/NDJSON runner,
   process-tree cancellation, staging/admission/store, secret and path tests.
3. **Machine wrapper protocols:** harden MiniMax and PixelLab first, followed by
   Gemini/Imagen, Google audio, and Codex image.
4. **Provider adapters:** implement and verify every locally dispatchable
   capability; register non-dispatchable Grok/Sora/FAL/ArtCraft capabilities
   honestly.
5. **MCP surface:** thin service registrations plus exact compatibility,
   catalog, build, package, and black-box evidence.
6. **ArtCraft client:** local bridge, durable restart recovery, active-feed
   completion, provider-neutral artifact helpers, and truthful setup UI.
7. **Sprite Factory client:** opt-in generation/staged intake with exact
   provenance, review, and engine-gate preservation.
8. **Provider activation:** separately authorized probes for Grok, Sora, FAL,
   and other configured-but-unverified lanes. Activation changes readiness
   evidence; it does not require changing the core contract.

Each wave receives focused tests and a full-suite gate. A later implementation
plan may divide waves among isolated worktrees, but no wave may substitute a
smaller final product for this complete design.

## Verification requirements

### Contract and lifecycle

- Closed request schemas accept every declared operation and reject unknown or
  provider-only fields deterministically.
- Same idempotency key plus same canonical request returns one execution; a
  changed request fails before launch.
- Sync, async, review-gated, timeout, restart, cancellation, late-result,
  retry, and provider-change histories preserve immutable attempts.
- Uncertain launches never auto-retry.
- Settlement and cancellation races commit one terminal result.

### Authority and truth

- Missing, expired, mutated, over-attempt, over-fanout, provider/model-mismatch,
  unit-mismatch, and over-ceiling grants fail before provider contact.
- Missing, expired, reused, wrong-principal, capability-mismatched, and
  execution-grant-substituted readiness probes fail before provider contact.
- Retry and provider change require new authority decisions.
- Unmeasured and unknown never become zero.
- Requested, selected, reported, and observed provider/model fields stay
  distinct in every result and receipt.

### Adapters and processes

- Common adapter-contract fixtures cover registration, local readiness,
  request validation, submit, poll, collect, cancel, resume, malformed output,
  timeout, and secret redaction.
- Fake executables prove prompts remain off argv, environments are scrubbed,
  output is bounded, process trees terminate, and late output is fenced.
- No unit, contract, package, or black-box test contacts a real provider.

### Artifacts

- Traversal, absolute paths, symlinks, swap races, directories, FIFOs, devices,
  excess size/count, MIME/magic mismatch, oversized decode, malformed media,
  duplicate commit, and post-cancel files are rejected.
- Valid image, video, audio, and pixel-bundle fixtures receive stable hashes,
  metadata, provenance, and no-clobber commits.
- MCP and receipts carry handles only.

### Provider truth

- MiniMax video task IDs survive detach/restart and collect exactly one
  admitted artifact.
- PixelLab preserves operation-specific resume and `needs_review` semantics.
- Gemini/Imagen rejects unsupported reference combinations rather than dropping
  them.
- Google audio cannot silently return WAV under a requested non-WAV handle.
- Codex concurrent fixture invocations cannot select one another's output.
- Grok remains non-dispatchable while auth admission is empty.
- Sora/FAL/ArtCraft remain marked remote/Storyteller-coupled until a local
  artifact path is proven.

### Clients and compatibility

- ArtCraft rehydrates incomplete executions, projects all states, feeds typed
  local completion, and never requires a synthetic remote batch token.
- ArtCraft local mode opens no listener and does not invoke the disabled Grok
  login loop.
- Sprite Factory preserves hashes, license/provenance fields, review state, and
  deterministic/engine gates.
- Existing omitted-media behavior and all pre-existing MeshFleet public
  contracts remain green.

### Release-quality local gate

Before any integration decision:

1. `npm run build`
2. `npm test`
3. `npm run typecheck`
4. `npm pack --dry-run`
5. exact media CLI/MCP black-box fixtures
6. secret scan and `git diff --check`
7. focused ArtCraft Rust/frontend tests and exact private macOS build
8. focused Sprite Factory tests and authoritative completion/provenance gates
9. independent Grok and MiniMax review of the exact diff
10. generate and validate
    `docs/handoffs/MESHFLEET-MEDIA-EXECUTION-CURRENT.md` from observed commands,
    receipts, and remaining authority gates

Passing these gates proves local implementation consistency only. It does not
authorize merge, push, npm publication, install, daemon restart, provider
execution, spend, Storyteller upload, deploy, or external publication.

## Acceptance

The design is implemented when current source and local evidence prove all of
the following:

1. MeshFleet contains the isolated media execution contract, durable lifecycle,
   authority gate, artifact store, receipts, adapters, CLI, and MCP tools.
2. The capability registry covers the full named image, video, speech, music,
   and pixel-art suite with honest readiness and provider/model evidence.
3. Every currently dispatchable local wrapper uses a bounded machine contract
   and returns validated local artifacts without credential leakage.
4. Asynchronous MiniMax and PixelLab jobs resume durably; synchronous providers
   use the same truthful lifecycle; cancellation never overclaims.
5. ArtCraft can submit and recover local MeshFleet jobs, display actual routing
   truth, and feed admitted image/video results without Storyteller.
6. Sprite Factory can consume MeshFleet artifacts while retaining provenance,
   licensing, review, deterministic completion, and engine validation.
7. Grok and other unproven consumer paths remain visible but non-dispatchable
   until separately authorized evidence supports activation.
8. The complete local verification matrix is green and a factual local-only
   handoff identifies every remaining provider-call, merge, publication,
   install, and deployment gate.
