import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { recommendRoute } from "../src/recommend-route.js";
import {
  compileTaskCapabilityProfile,
  TASK_CAPABILITY_PROFILE_VERSION,
} from "../src/task-capability-profile.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  exports: Record<string, string>;
};
const corpus = JSON.parse(readFileSync(
  join(repoRoot, "test/fixtures/routing/task-capability-profiles/v0.1/corpus.json"),
  "utf8",
)) as {
  version: string;
  vectors: Array<{
    id: string;
    operation: string;
    lifecycle: string;
    artifact: string;
    required_traits: string[];
    expected_required_capabilities: string[];
  }>;
};

const privateArtifactPolicy = {
  source_material: "caller_attested_rights",
  review_scope: "private_review_only",
  human_release_required: true,
} as const;

function profileInput(overrides: Record<string, unknown> = {}) {
  return {
    version: TASK_CAPABILITY_PROFILE_VERSION,
    task: {
      task_id: "task-1",
      operation: "image.generate",
      lifecycle: "async_job",
      artifact: "image",
      required_traits: ["background_omission"],
      optional_traits: ["square_output"],
      privacy: "network_ok",
      locality: "any",
      artifact_policy: privateArtifactPolicy,
    },
    surfaces: [{
      candidate_id: "candidate-image",
      profiles: [{
        operation: "image.generate",
        lifecycle: "async_job",
        artifact: "image",
        traits: ["square_output", "background_omission"],
      }],
      privacy: "network_ok",
      locality: "any",
      budget: { measured: false },
      labels: { brand: "PixelLab", provider: "media service", model: "sprite endpoint" },
    }],
    ...overrides,
  };
}

test("the closed corpus covers text, image, video, speech, music, and two pixel-art operations", () => {
  assert.equal(corpus.version, "meshfleet.task-capability-profile.corpus.v0.1");
  assert.deepEqual(corpus.vectors.map(({ operation }) => operation), [
    "text.generate",
    "image.generate",
    "video.generate",
    "speech.synthesize",
    "music.generate",
    "pixel_art.rotate_character",
    "pixel_art.generate_tileset",
  ]);

  for (const vector of corpus.vectors) {
    const input = profileInput({
      task: {
        task_id: vector.id,
        operation: vector.operation,
        lifecycle: vector.lifecycle,
        artifact: vector.artifact,
        required_traits: vector.required_traits,
        privacy: "network_ok",
        locality: "any",
        artifact_policy: privateArtifactPolicy,
      },
      surfaces: [{
        candidate_id: `lane-${vector.id}`,
        profiles: [{
          operation: vector.operation,
          lifecycle: vector.lifecycle,
          artifact: vector.artifact,
          traits: [...vector.required_traits].reverse(),
        }],
        privacy: "network_ok",
        locality: "any",
        budget: { measured: false },
      }],
    });
    const result = compileTaskCapabilityProfile(input as never);
    assert.ok(result.route_input, vector.id);
    assert.deepEqual(
      result.route_input.task.required_capabilities,
      vector.expected_required_capabilities,
      vector.id,
    );
    assert.deepEqual(
      result.route_input.candidates.map(({ candidate_id }) => candidate_id),
      [`lane-${vector.id}`],
      vector.id,
    );
    assert.deepEqual(
      recommendRoute(result.route_input).ranked.map(({ candidate_id }) => candidate_id),
      [`lane-${vector.id}`],
      `${vector.id} downstream route input`,
    );
  }
});

test("a valid compilation is a pure advisory projection with every effect false", () => {
  const result = compileTaskCapabilityProfile(profileInput() as never);

  assert.equal(result.compiler_version, TASK_CAPABILITY_PROFILE_VERSION);
  assert.equal(result.advisory, true);
  assert.equal(result.projection, true);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.gate_order, [
    "private_artifact_policy",
    "capability_profile",
    "downstream_route_budget",
  ]);
  assert.deepEqual(result.effects, {
    persisted: false,
    executed: false,
    authorized: false,
    woke_agents: false,
    contacted_providers: false,
    fetched: false,
    polled: false,
    read_credentials: false,
    inferred_provider: false,
    allocated: false,
    reserved: false,
    scheduled: false,
    spent_budget: false,
    sent: false,
    published: false,
    used_external_identity: false,
  });
  assert.deepEqual(result.excluded, []);
  assert.deepEqual(result.identity_labels, [{
    candidate_id: "candidate-image",
    brand: "PixelLab",
    provider: "media service",
    model: "sprite endpoint",
    evidence_only: true,
  }]);
});

test("operation artifact and async-job requirements are typed and closed", () => {
  const cases: Array<[string, unknown, RegExp]> = [
    [
      "video artifact mismatch",
      profileInput({ task: {
        task_id: "video",
        operation: "video.generate",
        lifecycle: "async_job",
        artifact: "image",
        required_traits: [],
        privacy: "network_ok",
        locality: "any",
        artifact_policy: privateArtifactPolicy,
      } }),
      /task\.artifact/,
    ],
    [
      "video must be a job",
      profileInput({ task: {
        task_id: "video",
        operation: "video.generate",
        lifecycle: "inline",
        artifact: "video",
        required_traits: [],
        privacy: "network_ok",
        locality: "any",
        artifact_policy: privateArtifactPolicy,
      } }),
      /task\.lifecycle/,
    ],
    [
      "pixel art must be a job",
      profileInput({ task: {
        task_id: "pixel",
        operation: "pixel_art.rotate_character",
        lifecycle: "inline",
        artifact: "sprite_sheet",
        required_traits: ["pixel_art"],
        privacy: "network_ok",
        locality: "any",
        artifact_policy: privateArtifactPolicy,
      } }),
      /task\.lifecycle/,
    ],
    [
      "artifact policy is mandatory",
      profileInput({ task: {
        task_id: "image",
        operation: "image.generate",
        lifecycle: "async_job",
        artifact: "image",
        required_traits: [],
        privacy: "network_ok",
        locality: "any",
      } }),
      /task\.artifact_policy/,
    ],
    [
      "surface profile artifact law",
      profileInput({ surfaces: [{
        ...profileInput().surfaces[0],
        profiles: [{
          operation: "image.generate",
          lifecycle: "async_job",
          artifact: "text",
          traits: [],
        }],
      }] }),
      /surfaces\[0\]\.profiles\[0\]\.artifact/,
    ],
    [
      "surface profile async law",
      profileInput({ surfaces: [{
        ...profileInput().surfaces[0],
        profiles: [{
          operation: "video.generate",
          lifecycle: "inline",
          artifact: "video",
          traits: [],
        }],
      }] }),
      /surfaces\[0\]\.profiles\[0\]\.lifecycle/,
    ],
  ];
  for (const [name, input, expected] of cases) {
    assert.throws(() => compileTaskCapabilityProfile(input as never), expected, name);
  }
});

test("capability exclusions are exact, sorted, and precede downstream budget evaluation", () => {
  const input = profileInput({
    surfaces: [
      {
        candidate_id: "z-exhausted-compatible",
        profiles: [{
          operation: "image.generate",
          lifecycle: "async_job",
          artifact: "image",
          traits: ["background_omission"],
        }],
        privacy: "network_ok",
        locality: "any",
        budget: { measured: true, used: 10, total: 10 },
      },
      {
        candidate_id: "a-operation-mismatch",
        profiles: [{
          operation: "text.generate",
          lifecycle: "inline",
          artifact: "text",
          traits: ["unrelated"],
        }],
        privacy: "network_ok",
        locality: "any",
        budget: { measured: true, used: 10, total: 10 },
      },
      {
        candidate_id: "b-lifecycle-mismatch",
        profiles: [{
          operation: "image.generate",
          lifecycle: "inline",
          artifact: "image",
          traits: ["background_omission"],
        }],
        privacy: "network_ok",
        locality: "any",
        budget: { measured: true, used: 10, total: 10 },
      },
      {
        candidate_id: "c-trait-mismatch",
        profiles: [{
          operation: "image.generate",
          lifecycle: "async_job",
          artifact: "image",
          traits: ["square_output"],
        }],
        privacy: "network_ok",
        locality: "any",
        budget: { measured: true, used: 10, total: 10 },
      },
    ],
  });
  const compiled = compileTaskCapabilityProfile(input as never);

  assert.deepEqual(compiled.excluded, [
    {
      candidate_id: "a-operation-mismatch",
      reason_codes: ["OPERATION_UNSUPPORTED"],
    },
    {
      candidate_id: "b-lifecycle-mismatch",
      reason_codes: ["LIFECYCLE_UNSUPPORTED"],
    },
    {
      candidate_id: "c-trait-mismatch",
      reason_codes: ["REQUIRED_TRAIT_MISSING"],
      missing_required_traits: ["background_omission"],
    },
  ]);
  assert.ok(compiled.route_input);
  assert.deepEqual(
    compiled.route_input.candidates.map(({ candidate_id }) => candidate_id),
    ["z-exhausted-compatible"],
  );
  assert.deepEqual(recommendRoute(compiled.route_input).excluded, [{
    candidate_id: "z-exhausted-compatible",
    reason_codes: ["BUDGET_EXHAUSTED"],
  }]);
});

test("private rights and human-release policy fail before candidate budget inspection", () => {
  const unsafeTask = {
    task_id: "task-1",
    operation: "image.generate",
    lifecycle: "async_job",
    artifact: "image",
    required_traits: [],
    privacy: "network_ok",
    locality: "any",
    artifact_policy: {
      source_material: "caller_attested_rights",
      review_scope: "public_release",
      human_release_required: false,
    },
  };
  const malformedBudget = {
    candidate_id: "candidate-image",
    profiles: [{
      operation: "image.generate",
      lifecycle: "async_job",
      artifact: "image",
      traits: [],
    }],
    privacy: "network_ok",
    locality: "any",
    budget: { measured: true, used: "secret", total: 0 },
  };

  assert.throws(
    () => compileTaskCapabilityProfile(profileInput({
      task: unsafeTask,
      surfaces: [malformedBudget],
    }) as never),
    /task\.artifact_policy\.review_scope/,
  );
});

test("brand, provider, and model labels are evidence-only and semantically inert", () => {
  const first = compileTaskCapabilityProfile(profileInput() as never);
  const second = compileTaskCapabilityProfile(profileInput({
    surfaces: [{
      ...profileInput().surfaces[0],
      labels: { brand: "Anything", provider: "Anything Else", model: "Different" },
    }],
  }) as never);

  assert.deepEqual(second.route_input, first.route_input);
  assert.deepEqual(second.excluded, first.excluded);
  assert.deepEqual(second.task_profile, first.task_profile);
  assert.notDeepEqual(second.identity_labels, first.identity_labels);
});

test("PixelLab is projected only as provider-neutral capabilities, never as a fake LLM or provider entry", () => {
  const result = compileTaskCapabilityProfile(profileInput() as never);
  assert.ok(result.route_input);
  const routeJson = JSON.stringify(result.route_input);

  assert.doesNotMatch(routeJson, /PixelLab|provider|model|requested_identity|observed_identity/i);
  assert.deepEqual(result.route_input.candidates[0]!.capabilities, [
    "artifact:image",
    "lifecycle:async_job",
    "operation:image.generate",
    "trait:background_omission",
    "trait:square_output",
  ]);
  assert.equal(result.identity_labels[0]!.brand, "PixelLab");
});

test("relational profiles do not bleed lifecycle or traits across operations", () => {
  const lifecycleBleed = compileTaskCapabilityProfile(profileInput({
    task: {
      task_id: "text-async",
      operation: "text.generate",
      lifecycle: "async_job",
      artifact: "text",
      required_traits: ["structured_output"],
      privacy: "network_ok",
      locality: "any",
      artifact_policy: privateArtifactPolicy,
    },
    surfaces: [{
      candidate_id: "mixed-lane",
      profiles: [
        {
          operation: "text.generate",
          lifecycle: "inline",
          artifact: "text",
          traits: ["structured_output"],
        },
        {
          operation: "image.generate",
          lifecycle: "async_job",
          artifact: "image",
          traits: ["background_omission"],
        },
      ],
      privacy: "network_ok",
      locality: "any",
      budget: { measured: false },
    }],
  }) as never);
  assert.equal(lifecycleBleed.status, "no_compatible_surfaces");
  assert.equal(lifecycleBleed.route_input, null);
  assert.deepEqual(lifecycleBleed.excluded, [{
    candidate_id: "mixed-lane",
    reason_codes: ["LIFECYCLE_UNSUPPORTED"],
  }]);

  const traitBleed = compileTaskCapabilityProfile(profileInput({
    task: {
      ...profileInput().task,
      required_traits: ["speech_controls"],
      optional_traits: [],
    },
    surfaces: [{
      candidate_id: "mixed-lane",
      profiles: [
        {
          operation: "image.generate",
          lifecycle: "async_job",
          artifact: "image",
          traits: ["background_omission"],
        },
        {
          operation: "speech.synthesize",
          lifecycle: "async_job",
          artifact: "audio",
          traits: ["speech_controls"],
        },
      ],
      privacy: "network_ok",
      locality: "any",
      budget: { measured: false },
    }],
  }) as never);
  assert.equal(traitBleed.status, "no_compatible_surfaces");
  assert.equal(traitBleed.route_input, null);
  assert.deepEqual(traitBleed.excluded, [{
    candidate_id: "mixed-lane",
    reason_codes: ["REQUIRED_TRAIT_MISSING"],
    missing_required_traits: ["speech_controls"],
  }]);
});

test("one exact profile is selected by required fit then optional-trait coverage without unioning", () => {
  const result = compileTaskCapabilityProfile(profileInput({
    surfaces: [{
      candidate_id: "multi-profile",
      profiles: [
        {
          operation: "image.generate",
          lifecycle: "async_job",
          artifact: "image",
          traits: ["background_omission"],
        },
        {
          operation: "image.generate",
          lifecycle: "async_job",
          artifact: "image",
          traits: ["square_output", "background_omission"],
        },
        {
          operation: "speech.synthesize",
          lifecycle: "async_job",
          artifact: "audio",
          traits: ["speech_controls"],
        },
      ],
      privacy: "network_ok",
      locality: "any",
      budget: { measured: false },
    }],
  }) as never);

  assert.ok(result.route_input);
  assert.deepEqual(result.route_input.candidates[0]!.capabilities, [
    "artifact:image",
    "lifecycle:async_job",
    "operation:image.generate",
    "trait:background_omission",
    "trait:square_output",
  ]);
  assert.doesNotMatch(JSON.stringify(result.route_input), /speech_controls/);
});

test("equal required and optional fit uses the profile signature as a stable final tie-break", () => {
  const result = compileTaskCapabilityProfile(profileInput({
    surfaces: [{
      candidate_id: "signature-tie",
      profiles: [
        {
          operation: "image.generate",
          lifecycle: "async_job",
          artifact: "image",
          traits: ["background_omission", "square_output", "zeta_extra"],
        },
        {
          operation: "image.generate",
          lifecycle: "async_job",
          artifact: "image",
          traits: ["alpha_extra", "square_output", "background_omission"],
        },
      ],
      privacy: "network_ok",
      locality: "any",
      budget: { measured: false },
    }],
  }) as never);

  assert.ok(result.route_input);
  assert.deepEqual(result.route_input.candidates[0]!.capabilities, [
    "artifact:image",
    "lifecycle:async_job",
    "operation:image.generate",
    "trait:alpha_extra",
    "trait:background_omission",
    "trait:square_output",
  ]);
  assert.doesNotMatch(JSON.stringify(result.route_input), /zeta_extra/);
});

test("trait tokens fit the downstream 64-character capability bound after prefixing", () => {
  const acceptedTrait = "a".repeat(58);
  const accepted = compileTaskCapabilityProfile(profileInput({
    task: {
      ...profileInput().task,
      required_traits: [acceptedTrait],
      optional_traits: [],
    },
    surfaces: [{
      ...profileInput().surfaces[0],
      profiles: [{
        operation: "image.generate",
        lifecycle: "async_job",
        artifact: "image",
        traits: [acceptedTrait],
      }],
    }],
  }) as never);
  assert.ok(accepted.route_input);
  assert.equal(accepted.route_input.task.required_capabilities[3]!.length, 64);
  assert.doesNotThrow(() => recommendRoute(accepted.route_input!));

  const rejectedTrait = "b".repeat(59);
  assert.throws(
    () => compileTaskCapabilityProfile(profileInput({
      task: {
        ...profileInput().task,
        required_traits: [rejectedTrait],
        optional_traits: [],
      },
    }) as never),
    /task\.required_traits\[0\].*58/,
  );
});

test("an all-excluded compilation reports no compatible surfaces instead of an invalid route input", () => {
  const result = compileTaskCapabilityProfile(profileInput({
    surfaces: [{
      candidate_id: "text-only",
      profiles: [{
        operation: "text.generate",
        lifecycle: "inline",
        artifact: "text",
        traits: ["structured_output"],
      }],
      privacy: "network_ok",
      locality: "any",
      budget: { measured: false },
    }],
  }) as never);

  assert.equal(result.status, "no_compatible_surfaces");
  assert.equal(result.route_input, null);
  assert.deepEqual(result.excluded, [{
    candidate_id: "text-only",
    reason_codes: ["OPERATION_UNSUPPORTED"],
  }]);
});

test("prompt, content, credential, path, auth, binary, likeness, voice, and publication fields are rejected", () => {
  const forbidden = [
    "prompt",
    "content",
    "credential",
    "credentials",
    "path",
    "auth",
    "binary",
    "likeness",
    "voice",
    "publication",
  ];
  for (const field of forbidden) {
    assert.throws(
      () => compileTaskCapabilityProfile(profileInput({
        task: { ...profileInput().task, [field]: "must-not-cross" },
      }) as never),
      new RegExp(`task\\.${field}`),
      `task.${field}`,
    );
    assert.throws(
      () => compileTaskCapabilityProfile(profileInput({
        surfaces: [{ ...profileInput().surfaces[0], [field]: "must-not-cross" }],
      }) as never),
      new RegExp(`surfaces\\[0\\]\\.${field}`),
      `surfaces[0].${field}`,
    );
  }
});

test("closed bounded JSON ingress rejects exotic, accessor, decorated, sparse, and over-bound shapes", () => {
  const accessor = profileInput();
  Object.defineProperty(accessor.task, "prompt", {
    enumerable: true,
    get: () => {
      throw new Error("must not invoke");
    },
  });
  const symbol = profileInput();
  Object.defineProperty(symbol.task, Symbol("secret"), { enumerable: true, value: "no" });
  const decorated = profileInput();
  Object.defineProperty(decorated.surfaces, "extra", { enumerable: true, value: "no" });
  const sparse = profileInput();
  sparse.surfaces = new Array(2) as typeof sparse.surfaces;
  sparse.surfaces[1] = profileInput().surfaces[0]!;
  const nonPlain = profileInput();
  nonPlain.task = Object.assign(Object.create({ inherited: true }), nonPlain.task);
  const cyclic = profileInput();
  (cyclic.task as Record<string, unknown>).cycle = cyclic.task;
  const overBound = profileInput({ surfaces: Array.from(
    { length: 129 },
    (_, index) => ({ ...profileInput().surfaces[0], candidate_id: `candidate-${index}` }),
  ) });

  for (const [name, input] of [
    ["accessor", accessor],
    ["symbol", symbol],
    ["decorated array", decorated],
    ["sparse array", sparse],
    ["non-plain object", nonPlain],
    ["cyclic object", cyclic],
    ["over-bound surfaces", overBound],
  ] as const) {
    assert.throws(
      () => compileTaskCapabilityProfile(input as never),
      /bounded plain JSON|surfaces/,
      name,
    );
  }
});

test("acyclic shared arrays and budget evidence are snapshotted independently", () => {
  const sharedTraits = ["background_omission"];
  const sharedBudget = { measured: false };
  const input = profileInput({
    task: {
      ...profileInput().task,
      required_traits: sharedTraits,
    },
    surfaces: [
      {
        candidate_id: "candidate-a",
        profiles: [{
          operation: "image.generate",
          lifecycle: "async_job",
          artifact: "image",
          traits: sharedTraits,
        }],
        privacy: "network_ok",
        locality: "any",
        budget: sharedBudget,
      },
      {
        candidate_id: "candidate-b",
        profiles: [{
          operation: "image.generate",
          lifecycle: "async_job",
          artifact: "image",
          traits: sharedTraits,
        }],
        privacy: "network_ok",
        locality: "any",
        budget: sharedBudget,
      },
    ],
  });

  const result = compileTaskCapabilityProfile(input as never);
  assert.ok(result.route_input);
  assert.deepEqual(
    result.route_input.candidates.map(({ candidate_id }) => candidate_id),
    ["candidate-a", "candidate-b"],
  );
});

test("prototype pollution cannot supply schema fields or invoke an inherited getter", () => {
  let inheritedReads = 0;
  const inheritedTask = profileInput().task;
  const inheritedSurfaces = profileInput().surfaces;
  Object.defineProperties(Object.prototype, {
    version: {
      configurable: true,
      get: () => {
        inheritedReads += 1;
        return TASK_CAPABILITY_PROFILE_VERSION;
      },
    },
    task: { configurable: true, value: inheritedTask },
    surfaces: { configurable: true, value: inheritedSurfaces },
  });
  try {
    assert.throws(
      () => compileTaskCapabilityProfile({} as never),
      /version/,
    );
    assert.equal(inheritedReads, 0);
  } finally {
    delete (Object.prototype as Record<string, unknown>).version;
    delete (Object.prototype as Record<string, unknown>).task;
    delete (Object.prototype as Record<string, unknown>).surfaces;
  }
});

test("array and object-key permutations are byte-stable and caller inputs remain unmodified", () => {
  const surfaceA = {
    candidate_id: "candidate-a",
    profiles: [
      {
        operation: "image.generate",
        lifecycle: "async_job",
        artifact: "image",
        traits: ["square_output", "background_omission"],
      },
      {
        operation: "text.generate",
        lifecycle: "inline",
        artifact: "text",
        traits: ["structured_output"],
      },
    ],
    privacy: "network_ok",
    locality: "any",
    budget: { measured: false },
  };
  const surfaceZ = {
    candidate_id: "candidate-z",
    profiles: [{
      operation: "image.generate",
      lifecycle: "async_job",
      artifact: "image",
      traits: ["background_omission"],
    }],
    privacy: "network_ok",
    locality: "any",
    budget: { measured: false },
  };
  const firstInput = profileInput({
    task: {
      task_id: "task-1",
      operation: "image.generate",
      lifecycle: "async_job",
      artifact: "image",
      required_traits: ["background_omission"],
      optional_traits: ["square_output"],
      privacy: "network_ok",
      locality: "any",
      artifact_policy: privateArtifactPolicy,
    },
    surfaces: [surfaceZ, surfaceA],
  });
  const secondInput = {
    surfaces: [
      {
        locality: "any",
        privacy: "network_ok",
        profiles: [...surfaceA.profiles].reverse().map((profile) => ({
          traits: [...profile.traits].reverse(),
          artifact: profile.artifact,
          lifecycle: profile.lifecycle,
          operation: profile.operation,
        })),
        candidate_id: "candidate-a",
        budget: { measured: false },
      },
      surfaceZ,
    ],
    task: {
      artifact_policy: {
        human_release_required: true,
        review_scope: "private_review_only",
        source_material: "caller_attested_rights",
      },
      locality: "any",
      privacy: "network_ok",
      optional_traits: ["square_output"],
      required_traits: ["background_omission"],
      artifact: "image",
      lifecycle: "async_job",
      operation: "image.generate",
      task_id: "task-1",
    },
    version: TASK_CAPABILITY_PROFILE_VERSION,
  };
  const before = structuredClone(firstInput);

  const first = compileTaskCapabilityProfile(firstInput as never);
  const second = compileTaskCapabilityProfile(secondInput as never);

  assert.equal(JSON.stringify(second), JSON.stringify(first));
  assert.deepEqual(firstInput, before);
});

test("the package exposes only the library subpath and production source has no effectful imports", () => {
  assert.equal(
    packageJson.exports["./task-capability-profile"],
    "./dist/task-capability-profile.js",
  );
  const source = readFileSync(join(repoRoot, "src/task-capability-profile.ts"), "utf8");
  assert.doesNotMatch(
    source,
    /node:(?:fs|child_process|net|http|https)|better-sqlite3|fetch\s*\(|process\.|\b(?:spawn|exec|writeFile|readFile)\s*\(/,
  );
});
