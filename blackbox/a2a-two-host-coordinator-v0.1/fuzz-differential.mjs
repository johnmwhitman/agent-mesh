import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  PROFILE,
  ProfileError,
  evaluateTwoHostScenarioBytes,
  projectResult,
  canonicalJson,
  sha256
} from "./evaluator.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const HOSTS = ["host-a", "host-b"];
const SAFE_MAX = 1e12;

let state = 0x74805c00;
function next() {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state;
}
function pick(values) {
  return values[next() % values.length];
}
function encode(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${encode(value[key])}`).join(",")}}`;
}

function initialDigest() {
  return sha256({
    authority: null,
    events: [],
    hosts: [
      { host_id: "host-a", reachable: true, token: null },
      { host_id: "host-b", reachable: true, token: null }
    ]
  });
}

function evaluateJs(raw) {
  try {
    const value = evaluateTwoHostScenarioBytes(Buffer.from(raw));
    return { ok: true, value, projection: projectResult(value) };
  } catch (error) {
    if (error instanceof ProfileError) return { ok: false, code: error.code, path: error.path };
    throw error;
  }
}

function python(raw) {
  const result = spawnSync(
    "python3",
    [
      "-c",
      [
        "import base64,json,sys",
        "sys.path.insert(0,sys.argv[1])",
        "from evaluator import evaluate_two_host_scenario_bytes,ProfileError,project_result",
        "raw=base64.b64decode(sys.argv[2])",
        "try:",
        " r=evaluate_two_host_scenario_bytes(raw)",
        " print(json.dumps({'ok':True,'value':r,'projection':project_result(r)},separators=(',',':')))",
        "except ProfileError as e:",
        " print(json.dumps({'ok':False,'code':e.code,'path':e.path},separators=(',',':')))"
      ].join("\n"),
      join(root, "python"),
      Buffer.from(raw).toString("base64")
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "python failed");
  return JSON.parse(result.stdout);
}

function assertOutput(raw, wanted, label) {
  const javascript = evaluateJs(raw);
  const other = python(raw);
  if (encode(javascript) !== encode(wanted) || encode(other) !== encode(wanted) || encode(javascript) !== encode(other)) {
    throw new Error(`${label}: js=${encode(javascript)} py=${encode(other)} wanted=${encode(wanted)}`);
  }
}

function assertRuntimeInvariants(result, label) {
  for (let index = 0; index < result.events.length; index += 1) {
    const event = result.events[index];
    if (event.seq !== index + 1 || event.event_id !== `event-${index + 1}`) {
      throw new Error(`${label}: non-dense event sequence`);
    }
  }
  let previousDigest = initialDigest();
  for (const command of result.command_results) {
    if (command.error !== null && command.state_sha256 !== previousDigest) {
      throw new Error(`${label}: rejection ${command.error} mutated state`);
    }
    previousDigest = command.state_sha256;
  }
  if (result.authority !== null) {
    const epochs = result.authority.attempts.map((attempt) => attempt.owner_epoch);
    for (let index = 1; index < epochs.length; index += 1) {
      if (epochs[index] <= epochs[index - 1]) throw new Error(`${label}: attempt epochs are not strictly increasing`);
    }
  }
}

function scenarioRaw(scenario) {
  return Buffer.from(JSON.stringify({
    profile: PROFILE,
    scenario_id: scenario.scenario_id,
    work_id: scenario.work_id,
    commands: scenario.commands
  }));
}

function generateCommands(scenarioIndex) {
  const commands = [];
  let at = 0;
  const maxAttempts = 1 + (next() % 4);
  const retryBase = next() % 3;
  const includeCreate = next() % 12 !== 0;
  if (includeCreate) {
    commands.push({
      op: "create_work",
      at,
      max_attempts: maxAttempts,
      retry_base_ms: retryBase
    });
  }

  const commandCount = 1 + (next() % 24);
  for (let index = 0; index < commandCount && commands.length < 48; index += 1) {
    at += 1 + (next() % 4);
    if (next() % 17 === 0) at += 1 + (next() % 20);
    const host = pick(HOSTS);
    const kind = next() % 100;
    if (kind < 12) {
      commands.push({ op: "partition", at, host });
    } else if (kind < 22) {
      commands.push({ op: "heal", at, host });
    } else if (kind < 42) {
      commands.push({ op: "acquire_lease", at, host, lease_ms: 1 + (next() % 12) });
    } else if (kind < 54) {
      commands.push({ op: "renew_lease", at, host, lease_ms: 1 + (next() % 12) });
    } else if (kind < 68) {
      commands.push({ op: "settle", at, host, outcome: pick(["success", "failure", "failure"]) });
    } else if (kind < 78) {
      commands.push({ op: "recover_expired", at, host });
    } else if (kind < 88) {
      commands.push({ op: "cancel", at, host });
    } else if (kind < 94) {
      commands.push({ op: "replay_check", at });
    } else if (kind < 97) {
      commands.push({
        op: "create_work",
        at,
        max_attempts: 1 + (next() % 4),
        retry_base_ms: next() % 3
      });
    } else if (kind === 97) {
      const leaseMs = 1 + (next() % 5);
      const overflowAt = SAFE_MAX - (next() % leaseMs);
      if (overflowAt >= at) {
        at = overflowAt;
        commands.push({ op: "acquire_lease", at, host, lease_ms: leaseMs });
      } else {
        commands.push({ op: "acquire_lease", at, host, lease_ms: leaseMs });
      }
    } else if (kind === 98) {
      const overflowAt = SAFE_MAX - (next() % 3);
      if (overflowAt >= at) at = overflowAt;
      commands.push({ op: "renew_lease", at, host, lease_ms: 1 + (next() % 4) });
    } else {
      commands.push({ op: "acquire_lease", at, host: "host-a", lease_ms: 1 + (next() % 8) });
      commands.push({ op: "acquire_lease", at, host: "host-b", lease_ms: 1 + (next() % 8) });
    }
  }

  if (commands.length === 0) {
    commands.push({ op: "replay_check", at: 0 });
  }
  if (next() % 3 === 0) {
    const lastAt = commands[commands.length - 1].at;
    commands.push({ op: "replay_check", at: lastAt });
  }

  if (scenarioIndex % 11 === 0 && includeCreate) {
    const base = commands[commands.length - 1].at + 1;
    if (base <= SAFE_MAX - 15) {
      commands.push(
        { op: "heal", at: base, host: "host-a" },
        { op: "heal", at: base, host: "host-b" },
        { op: "acquire_lease", at: base + 1, host: "host-a", lease_ms: 5 },
        { op: "partition", at: base + 2, host: "host-a" },
        { op: "recover_expired", at: base + 10, host: "host-b" },
        { op: "heal", at: base + 11, host: "host-a" },
        { op: "settle", at: base + 12, host: "host-a", outcome: "success" },
        { op: "acquire_lease", at: base + 13, host: "host-b", lease_ms: 4 },
        { op: "settle", at: base + 14, host: "host-b", outcome: pick(["success", "failure"]) },
        { op: "replay_check", at: base + 15 }
      );
    }
  }

  if (commands.length > 128) return commands.slice(0, 128);
  return commands;
}

function generateScenario(scenarioIndex) {
  return {
    scenario_id: `f${scenarioIndex}`,
    work_id: scenarioIndex % 5 === 0 ? "work-1" : `w${scenarioIndex % 17}`,
    commands: generateCommands(scenarioIndex)
  };
}

const generated = 256;
for (let scenario = 0; scenario < generated; scenario += 1) {
  const input = generateScenario(scenario);
  const raw = scenarioRaw(input);
  const wanted = evaluateJs(raw);
  if (!wanted.ok) throw new Error(`generated-${scenario}: unexpected validation failure ${wanted.code} path=${wanted.path}`);
  assertRuntimeInvariants(wanted.value, `generated-${scenario}`);
  assertOutput(raw, wanted, `generated-${scenario}`);
  if (encode(wanted.projection) !== encode(projectResult(wanted.value))) {
    throw new Error(`generated-${scenario}: projection drift`);
  }
}

const fixed = [
  {
    scenario_id: "fix-basic",
    work_id: "work-1",
    commands: [
      { op: "create_work", at: 0, max_attempts: 3, retry_base_ms: 0 },
      { op: "acquire_lease", at: 1, host: "host-a", lease_ms: 10 },
      { op: "renew_lease", at: 5, host: "host-a", lease_ms: 10 },
      { op: "settle", at: 14, host: "host-a", outcome: "success" },
      { op: "replay_check", at: 15 }
    ]
  },
  {
    scenario_id: "fix-partition",
    work_id: "work-1",
    commands: [
      { op: "create_work", at: 0, max_attempts: 2, retry_base_ms: 0 },
      { op: "partition", at: 1, host: "host-a" },
      { op: "acquire_lease", at: 2, host: "host-a", lease_ms: 5 },
      { op: "acquire_lease", at: 2, host: "host-b", lease_ms: 5 },
      { op: "heal", at: 3, host: "host-a" },
      { op: "settle", at: 4, host: "host-a", outcome: "success" },
      { op: "settle", at: 4, host: "host-b", outcome: "success" },
      { op: "replay_check", at: 5 }
    ]
  },
  {
    scenario_id: "fix-stale-heal",
    work_id: "work-1",
    commands: [
      { op: "create_work", at: 0, max_attempts: 3, retry_base_ms: 0 },
      { op: "acquire_lease", at: 1, host: "host-a", lease_ms: 5 },
      { op: "partition", at: 2, host: "host-a" },
      { op: "recover_expired", at: 10, host: "host-b" },
      { op: "heal", at: 11, host: "host-a" },
      { op: "settle", at: 12, host: "host-a", outcome: "success" },
      { op: "acquire_lease", at: 13, host: "host-b", lease_ms: 5 },
      { op: "settle", at: 14, host: "host-b", outcome: "success" },
      { op: "replay_check", at: 15 }
    ]
  },
  {
    scenario_id: "fix-total-partition",
    work_id: "work-1",
    commands: [
      { op: "create_work", at: 0, max_attempts: 2, retry_base_ms: 0 },
      { op: "partition", at: 1, host: "host-a" },
      { op: "partition", at: 1, host: "host-b" },
      { op: "acquire_lease", at: 2, host: "host-a", lease_ms: 5 },
      { op: "acquire_lease", at: 2, host: "host-b", lease_ms: 5 },
      { op: "cancel", at: 3, host: "host-a" },
      { op: "heal", at: 4, host: "host-a" },
      { op: "heal", at: 4, host: "host-b" },
      { op: "acquire_lease", at: 5, host: "host-a", lease_ms: 5 },
      { op: "replay_check", at: 6 }
    ]
  },
  {
    scenario_id: "fix-retry-epochs",
    work_id: "work-1",
    commands: [
      { op: "create_work", at: 0, max_attempts: 4, retry_base_ms: 1 },
      { op: "acquire_lease", at: 1, host: "host-a", lease_ms: 3 },
      { op: "settle", at: 2, host: "host-a", outcome: "failure" },
      { op: "acquire_lease", at: 5, host: "host-b", lease_ms: 3 },
      { op: "settle", at: 6, host: "host-b", outcome: "failure" },
      { op: "acquire_lease", at: 10, host: "host-a", lease_ms: 3 },
      { op: "settle", at: 11, host: "host-a", outcome: "success" },
      { op: "replay_check", at: 12 }
    ]
  },
  {
    scenario_id: "fix-lease-overflow",
    work_id: "work-1",
    commands: [
      { op: "create_work", at: 0, max_attempts: 1, retry_base_ms: 0 },
      { op: "acquire_lease", at: SAFE_MAX - 1, host: "host-a", lease_ms: 2 }
    ]
  },
  {
    scenario_id: "fix-equal-time",
    work_id: "work-1",
    commands: [
      { op: "create_work", at: 0, max_attempts: 2, retry_base_ms: 0 },
      { op: "acquire_lease", at: 1, host: "host-a", lease_ms: 10 },
      { op: "acquire_lease", at: 1, host: "host-b", lease_ms: 10 },
      { op: "renew_lease", at: 1, host: "host-b", lease_ms: 10 },
      { op: "renew_lease", at: 1, host: "host-a", lease_ms: 10 }
    ]
  },
  {
    scenario_id: "fix-cancel-partition",
    work_id: "work-1",
    commands: [
      { op: "create_work", at: 0, max_attempts: 2, retry_base_ms: 0 },
      { op: "acquire_lease", at: 1, host: "host-a", lease_ms: 20 },
      { op: "partition", at: 2, host: "host-b" },
      { op: "cancel", at: 3, host: "host-b" },
      { op: "cancel", at: 3, host: "host-a" },
      { op: "heal", at: 4, host: "host-b" },
      { op: "cancel", at: 5, host: "host-b" }
    ]
  }
];

for (let index = 0; index < fixed.length; index += 1) {
  const raw = scenarioRaw(fixed[index]);
  const wanted = evaluateJs(raw);
  if (!wanted.ok) throw new Error(`fixed-${index}: unexpected validation failure ${wanted.code}`);
  assertRuntimeInvariants(wanted.value, `fixed-${index}`);
  assertOutput(raw, wanted, `fixed-${index}`);
}

const invalid = [
  [
    JSON.stringify({
      profile: PROFILE,
      scenario_id: "v01",
      work_id: "work",
      commands: [
        { op: "create_work", at: 2, max_attempts: 1, retry_base_ms: 0 },
        { op: "replay_check", at: 1 }
      ]
    }),
    "NON_MONOTONIC_TIME"
  ],
  [
    JSON.stringify({
      profile: PROFILE,
      scenario_id: "v02",
      work_id: "work",
      commands: [{ op: "cancel", at: 0, host: "host-c" }]
    }),
    "UNKNOWN_HOST"
  ],
  [
    JSON.stringify({
      profile: PROFILE,
      scenario_id: "v03",
      work_id: "work",
      commands: [{ op: "replay_check", at: 0, extra: true }]
    }),
    "UNKNOWN_FIELD"
  ],
  [
    JSON.stringify({
      profile: "wrong",
      scenario_id: "v04",
      work_id: "work",
      commands: [{ op: "replay_check", at: 0 }]
    }),
    "INVALID_SCENARIO"
  ],
  [
    JSON.stringify({
      profile: PROFILE,
      scenario_id: "v05",
      work_id: "work"
    }),
    "MISSING_FIELD"
  ],
  [
    JSON.stringify({
      profile: PROFILE,
      scenario_id: "v06",
      work_id: "work",
      commands: [{ op: "explode", at: 0 }]
    }),
    "UNKNOWN_OP"
  ],
  [
    JSON.stringify({
      profile: PROFILE,
      scenario_id: "v07",
      work_id: "work",
      commands: []
    }),
    "INVALID_FIELD"
  ],
  [
    JSON.stringify({
      profile: PROFILE,
      scenario_id: "v08",
      work_id: "work",
      commands: [{ op: "create_work", at: 0, max_attempts: 0, retry_base_ms: 0 }]
    }),
    "INVALID_FIELD"
  ],
  [
    JSON.stringify({
      profile: PROFILE,
      scenario_id: "v09",
      work_id: "work",
      commands: [{ op: "create_work", at: 0, max_attempts: 33, retry_base_ms: 0 }]
    }),
    "INVALID_FIELD"
  ],
  [
    JSON.stringify({
      profile: PROFILE,
      scenario_id: "v10",
      work_id: "work",
      commands: [{ op: "settle", at: 0, host: "host-a", outcome: "maybe" }]
    }),
    "INVALID_FIELD"
  ],
  [
    JSON.stringify({
      profile: PROFILE,
      scenario_id: "V Bad",
      work_id: "work",
      commands: [{ op: "replay_check", at: 0 }]
    }),
    "INVALID_FIELD"
  ],
  [
    JSON.stringify({
      profile: PROFILE,
      scenario_id: "v11",
      work_id: "work",
      commands: Array.from({ length: 129 }, (_, index) => ({ op: "replay_check", at: index }))
    }),
    "INVALID_FIELD"
  ],
  [
    JSON.stringify({
      profile: PROFILE,
      scenario_id: "v12",
      work_id: "work",
      commands: [{ op: "acquire_lease", at: 0, host: "host-a", lease_ms: 0 }]
    }),
    "INVALID_FIELD"
  ],
  [
    `${"[".repeat(64)}0${"]".repeat(64)}`,
    "DEPTH_LIMIT"
  ],
  ["{", "MALFORMED_JSON"],
  [`{"profile":"${PROFILE}","profile":"x"}`, "DUPLICATE_MEMBER"],
  ['{"at":-0}', "NON_CANONICAL_INTEGER"],
  ['{"at":1.0}', "NON_CANONICAL_INTEGER"],
  ['{"at":1e0}', "NON_CANONICAL_INTEGER"],
  ['{"at":9007199254740992}', "UNSAFE_INTEGER"],
  ["{}x", "MALFORMED_JSON"],
  ['{"x":"\\ud800"}', "MALFORMED_JSON"]
];

for (const [raw, errorCode] of invalid) {
  const js = evaluateJs(Buffer.from(raw));
  if (js.ok || js.code !== errorCode) throw new Error(`invalid-${errorCode}: got ${encode(js)}`);
  assertOutput(Buffer.from(raw), js, `invalid-${errorCode}`);
}

const parserControls = [
  [Buffer.from([0xff]), "INVALID_UTF8"],
  [Buffer.from([0xc3, 0x28]), "INVALID_UTF8"],
  [Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), "MALFORMED_JSON"],
  [Buffer.from(""), "MALFORMED_JSON"],
  [Buffer.from(`${"[".repeat(65)}0${"]".repeat(65)}`), "DEPTH_LIMIT"]
];
for (const [raw, errorCode] of parserControls) {
  const js = evaluateJs(raw);
  if (js.ok || js.code !== errorCode) throw new Error(`parser-${errorCode}: got ${encode(js)}`);
  assertOutput(raw, js, `parser-${errorCode}`);
}

const maxCommands = {
  scenario_id: "max-commands",
  work_id: "work-1",
  commands: Array.from({ length: 128 }, (_, index) => ({ op: "replay_check", at: index }))
};
{
  const raw = scenarioRaw(maxCommands);
  const wanted = evaluateJs(raw);
  if (!wanted.ok) throw new Error(`max-commands: ${wanted.code}`);
  assertOutput(raw, wanted, "max-commands");
}

process.stdout.write(`${canonicalJson({
  suite: "fuzz-differential",
  profile: PROFILE,
  seed: "0x74805c00",
  generated_scenarios: generated,
  fixed_scenarios: fixed.length,
  invalid_mutations: invalid.length,
  parser_controls: parserControls.length,
  passed: true
})}\n`);
