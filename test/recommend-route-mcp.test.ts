/**
 * The recommend_route contract over real MCP stdio.
 *
 * The recommendation surface is intentionally caller-supplied and read-only:
 * MeshFleet ranks sanitized candidate snapshots, while provider gateways retain
 * credentials, execution, failover, and exact metering.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const textOf = (response: unknown): string =>
  (response as { content: Array<{ text: string }> }).content[0]!.text;

const subscriptionLaneCorpus = JSON.parse(
  readFileSync(
    join(
      repoRoot,
      "test",
      "fixtures",
      "routing",
      "subscription-lanes",
      "v0.1",
      "corpus.json",
    ),
    "utf8",
  ),
) as {
  candidate_templates: Array<Record<string, unknown>>;
  cases: Array<{ id: string; task: Record<string, unknown> }>;
};

async function withServer(
  fn: (client: Client, dataDir: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-recommend-route-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(repoRoot, "src", "index.ts")],
    env: {
      ...(process.env as Record<string, string>),
      MESHFLEET_DB_FILE: join(dir, "ledger.db"),
      MESHFLEET_DATA_FILE: join(dir, "ledger.json"),
      MESHFLEET_EVENT_LOG_FILE: join(dir, "events.jsonl"),
      MESHFLEET_RATIFY_SWEEP_MS: "0",
    },
    stderr: "ignore",
  });
  const client = new Client(
    { name: "recommend-route-contract-test", version: "1.0.0" },
    { capabilities: {} },
  );
  try {
    await client.connect(transport);
    await fn(client, dir);
  } finally {
    await client.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

test("recommend_route advertises a caller-supplied advisory candidate contract", async () => {
  await withServer(async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "recommend_route");

    assert.ok(tool, "missing MCP tool: recommend_route");
    assert.match(tool.description ?? "", /advisory/i);
    assert.deepEqual(tool.inputSchema.required, ["task", "candidates"]);

    const properties = tool.inputSchema.properties as Record<string, any>;
    assert.ok(properties.task, "task traits must be caller supplied");
    assert.ok(properties.candidates, "candidate snapshots must be caller supplied");
    assert.equal(properties.candidates.minItems, 1);
    assert.equal(properties.candidates.maxItems, 256);
    assert.equal(properties.top_n.type, "integer");
    assert.equal(properties.top_n.maximum, 256);
    assert.equal(properties.preference.additionalProperties, false);
    assert.deepEqual(properties.preference.required, ["objective", "now_ms"]);
    assert.deepEqual(properties.preference.properties.objective.enum, [
      "prefer_near_reset",
      "exhaust_before_reset",
    ]);
    assert.equal(properties.preference.properties.now_ms.type, "integer");
    assert.equal(
      properties.preference.properties.now_ms.maximum,
      Number.MAX_SAFE_INTEGER,
    );

    const taskProperties = properties.task.properties as Record<string, any>;
    assert.deepEqual(
      {
        minItems: taskProperties.required_capabilities.minItems,
        maxItems: taskProperties.required_capabilities.maxItems,
        uniqueItems: taskProperties.required_capabilities.uniqueItems,
        pattern: taskProperties.required_capabilities.items.pattern,
      },
      {
        minItems: 1,
        maxItems: 64,
        uniqueItems: true,
        pattern: "^[a-z0-9][a-z0-9._:-]*$",
      },
    );
    assert.equal(taskProperties.min_context_tokens.type, "integer");

    const candidateProperties = properties.candidates.items.properties as Record<
      string,
      any
    >;
    assert.equal(candidateProperties.capabilities.minItems, 1);
    assert.equal(candidateProperties.capabilities.maxItems, 64);
    assert.equal(candidateProperties.capabilities.uniqueItems, true);
    assert.equal(candidateProperties.context_window.type, "integer");
    assert.equal(
      candidateProperties.observed_outcomes.properties.successes.maximum,
      1_000_000,
    );
    assert.equal(
      candidateProperties.observed_outcomes.properties.failures.maximum,
      1_000_000,
    );
    assert.ok(candidateProperties.budget.allOf, "budget measured-state rules must be in schema");
    assert.equal(
      candidateProperties.budget.properties.window.additionalProperties,
      false,
    );
    assert.deepEqual(
      candidateProperties.budget.properties.window.required,
      ["starts_at_ms", "ends_at_ms"],
    );
    assert.ok(
      candidateProperties.requested_identity.anyOf,
      "requested identity must name a runtime or model",
    );
    assert.ok(
      candidateProperties.observed_identity.anyOf,
      "observed identity must name a runtime or model",
    );
  });
});

test("recommend_route exposes opt-in reset urgency without writing or changing existing scores", async () => {
  await withServer(async (client, dataDir) => {
    const snapshot = (): Array<[string, string]> =>
      readdirSync(dataDir)
        .sort()
        .map((name) => [name, readFileSync(join(dataDir, name)).toString("base64")]);
    const before = snapshot();
    const nowMs = 1_800_000_000_000;
    const response = await client.callTool({
      name: "recommend_route",
      arguments: {
        task: {
          required_capabilities: ["code"],
          privacy: "network_ok",
          locality: "any",
        },
        candidates: [
          {
            candidate_id: "a-far",
            capabilities: ["code"],
            privacy: "network_ok",
            locality: "any",
            budget: {
              measured: true,
              used: 10,
              total: 100,
              window: {
                starts_at_ms: nowMs - 1,
                ends_at_ms: nowMs + 604_800_000,
              },
            },
          },
          {
            candidate_id: "z-near",
            capabilities: ["code"],
            privacy: "network_ok",
            locality: "any",
            budget: {
              measured: true,
              used: 10,
              total: 100,
              window: {
                starts_at_ms: nowMs - 1,
                ends_at_ms: nowMs,
              },
            },
          },
        ],
        preference: {
          objective: "prefer_near_reset",
          now_ms: nowMs,
        },
        top_n: 2,
      },
    });

    assert.equal((response as { isError?: boolean }).isError, undefined);
    const body = JSON.parse(textOf(response));
    assert.deepEqual(body.ranked.map(({ candidate_id }: { candidate_id: string }) => candidate_id), [
      "z-near",
      "a-far",
    ]);
    assert.deepEqual(
      body.ranked.map(
        ({ components }: { components: Record<string, number> }) => ({
          final_score: components.final_score,
          budget_adjustment: components.budget_adjustment,
        }),
      ),
      [
        { final_score: 1, budget_adjustment: 1 },
        { final_score: 1, budget_adjustment: 1 },
      ],
    );
    assert.deepEqual(body.effects, {
      persisted: false,
      executed: false,
      authorized: false,
      woke_agents: false,
      contacted_providers: false,
    });
    assert.deepEqual(snapshot(), before);
  });
});

test("recommend_route refuses raw-prompt and authority-shaped fields", async () => {
  await withServer(async (client) => {
    const base = {
      task: {
        required_capabilities: ["code"],
        privacy: "network_ok",
        locality: "any",
      },
      candidates: [
        {
          candidate_id: "candidate",
          capabilities: ["code"],
          privacy: "network_ok",
          locality: "any",
          budget: { measured: false },
        },
      ],
    };
    const cases: Array<{
      name: string;
      arguments: Record<string, unknown>;
      expected: RegExp;
    }> = [
      {
        name: "raw prompt",
        arguments: { ...base, prompt: "private task body" },
        expected: /prompt/,
      },
      {
        name: "execution request",
        arguments: { ...base, execute: true },
        expected: /execute/,
      },
      {
        name: "implicit wake",
        arguments: {
          ...base,
          candidates: [{ ...base.candidates[0], wake_agent: true }],
        },
        expected: /wake_agent/,
      },
      {
        name: "nested prompt smuggling",
        arguments: {
          ...base,
          candidates: [
            {
              ...base.candidates[0],
              budget: { measured: false, prompt: "private task body" },
            },
          ],
        },
        expected: /budget\.prompt/,
      },
      {
        name: "nested execution smuggling",
        arguments: {
          ...base,
          candidates: [
            {
              ...base.candidates[0],
              observed_outcomes: { successes: 1, failures: 0, execute: true },
            },
          ],
        },
        expected: /observed_outcomes\.execute/,
      },
      {
        name: "nested identity attestation smuggling",
        arguments: {
          ...base,
          candidates: [
            {
              ...base.candidates[0],
              observed_identity: {
                runtime: "opencode",
                source: "caller-claim",
                attested: true,
              },
            },
          ],
        },
        expected: /observed_identity\.attested/,
      },
    ];

    for (const key of [
      "provider",
      "subscription",
      "availability",
      "authenticated",
      "quota_reset_at",
      "endpoint",
      "credentials",
      "dispatch",
    ]) {
      cases.push({
        name: key,
        arguments: {
          ...base,
          candidates: [{ ...base.candidates[0], [key]: "forbidden" }],
        },
        expected: new RegExp(key),
      });
    }
    for (const parent of ["budget", "requested_identity"] as const) {
      for (const key of ["fresh", "availability", "authenticated"]) {
        cases.push({
          name: `${parent} ${key} smuggling`,
          arguments: {
            ...base,
            candidates: [
              {
                ...base.candidates[0],
                [parent]:
                  parent === "budget"
                    ? { measured: false, [key]: "forbidden" }
                    : { runtime: "caller-selected-runtime", [key]: "forbidden" },
              },
            ],
          },
          expected: new RegExp(`${parent}\\.${key}`),
        });
      }
    }

    for (const fixture of cases) {
      const response = await client.callTool({
        name: "recommend_route",
        arguments: fixture.arguments,
      });
      assert.equal(
        (response as { isError?: boolean }).isError,
        true,
        `${fixture.name} must fail closed`,
      );
      assert.match(textOf(response), fixture.expected);
    }
  });
});

test("recommend_route accepts sanitized subscription-lane snapshots without provider authority", async () => {
  await withServer(async (client, dataDir) => {
    const snapshot = (): Array<[string, string]> =>
      readdirSync(dataDir)
        .sort()
        .map((name) => [name, readFileSync(join(dataDir, name)).toString("base64")]);
    const filesBefore = snapshot();
    const fastPatch = subscriptionLaneCorpus.cases.find(
      ({ id }) => id === "fast-patch",
    );
    assert.ok(fastPatch, "subscription-lane corpus must provide the fast-patch fixture");

    const response = await client.callTool({
      name: "recommend_route",
      arguments: {
        task: fastPatch.task,
        candidates: subscriptionLaneCorpus.candidate_templates,
        top_n: subscriptionLaneCorpus.candidate_templates.length,
      },
    });
    assert.equal((response as { isError?: boolean }).isError, undefined);
    const body = JSON.parse(textOf(response)) as {
      effects: {
        persisted: boolean;
        executed: boolean;
        authorized: boolean;
        woke_agents: boolean;
        contacted_providers: boolean;
      };
      ranked: Array<{
        candidate_id: string;
        identity: Record<string, unknown>;
      }>;
    };

    assert.deepEqual(body.effects, {
      persisted: false,
      executed: false,
      authorized: false,
      woke_agents: false,
      contacted_providers: false,
    });
    assert.deepEqual(body.ranked.map(({ candidate_id }) => candidate_id), [
      "lane-b",
      "lane-a",
      "lane-c",
    ]);
    for (const { candidate_id, identity } of body.ranked) {
      assert.equal(identity.evidence_only, true, `${candidate_id} identity is evidence only`);
      assert.equal("availability" in identity, false, `${candidate_id} must not claim availability`);
      assert.equal("authenticated" in identity, false, `${candidate_id} must not claim authentication`);
    }
    assert.deepEqual(snapshot(), filesBefore);
  });
});

test("recommend_route projects invalid snapshots as readable tool errors", async () => {
  await withServer(async (client) => {
    const candidate = {
      candidate_id: "candidate",
      capabilities: ["code"],
      privacy: "network_ok",
      locality: "any",
      budget: { measured: false },
    };
    const base = {
      task: {
        required_capabilities: ["code"],
        privacy: "network_ok",
        locality: "any",
      },
      candidates: [candidate],
    };
    const cases: Array<{ arguments: Record<string, unknown>; expected: RegExp }> = [
      {
        arguments: { ...base, top_n: 0 },
        expected: /top_n/,
      },
      {
        arguments: {
          ...base,
          task: {
            ...base.task,
            optional_capabilities: ["code"],
          },
        },
        expected: /optional_capabilities.*required_capabilities/,
      },
      {
        arguments: {
          ...base,
          candidates: [{ ...candidate, budget: { measured: true, used: 1 } }],
        },
        expected: /budget\.total/,
      },
      {
        arguments: { ...base, candidates: [candidate, { ...candidate }] },
        expected: /duplicate candidate_id/,
      },
    ];

    for (const fixture of cases) {
      let response: unknown;
      try {
        response = await client.callTool({
          name: "recommend_route",
          arguments: fixture.arguments,
        });
      } catch {
        response = undefined;
      }
      assert.ok(response, "invalid input must return a tool error, not a transport fault");
      assert.equal((response as { isError?: boolean }).isError, true);
      assert.match(textOf(response), fixture.expected);
    }
  });
});

test("recommend_route filters every hard constraint before scoring", async () => {
  await withServer(async (client, dataDir) => {
    const snapshot = (): Array<[string, string]> =>
      readdirSync(dataDir)
        .sort()
        .map((name) => [name, readFileSync(join(dataDir, name)).toString("base64")]);
    const filesBefore = snapshot();
    let response: unknown;
    try {
      response = await client.callTool({
        name: "recommend_route",
        arguments: {
          task: {
            required_capabilities: ["code"],
            privacy: "local_only",
            locality: "same_host",
            coordination: "pair_discussion",
            policy_tags: ["no_train"],
            min_context_tokens: 8_000,
          },
          candidates: [
            {
              candidate_id: "remote-high-history",
              capabilities: ["code", "review"],
              privacy: "network_ok",
              locality: "same_host",
              coordination_modes: ["pair_discussion"],
              policy_tags: ["no_train"],
              context_window: 16_000,
              observed_outcomes: { successes: 100, failures: 0 },
              budget: { measured: true, used: 100, total: 100 },
            },
            {
              candidate_id: "multi-mismatch",
              capabilities: ["review"],
              privacy: "local_only",
              locality: "any",
              coordination_modes: ["solo"],
              policy_tags: [],
              context_window: 4_000,
              observed_outcomes: { successes: 100, failures: 0 },
              budget: { measured: true, used: 0, total: 100 },
            },
            {
              candidate_id: "local",
              capabilities: ["code"],
              privacy: "local_only",
              locality: "same_host",
              coordination_modes: ["pair_discussion"],
              policy_tags: ["no_train"],
              context_window: 16_000,
              budget: { measured: false },
            },
          ],
          top_n: 1,
        },
      });
    } catch {
      response = undefined;
    }

    assert.ok(response, "recommend_route must be callable, not only advertised");
    const body = JSON.parse(
      (response as { content: Array<{ text: string }> }).content[0]!.text,
    ) as {
      effects: {
        persisted: boolean;
        executed: boolean;
        authorized: boolean;
        woke_agents: boolean;
        contacted_providers: boolean;
      };
      ranked: Array<{ candidate_id: string }>;
      excluded: Array<{ candidate_id: string; reason_codes: string[] }>;
    };

    assert.deepEqual(body.effects, {
      persisted: false,
      executed: false,
      authorized: false,
      woke_agents: false,
      contacted_providers: false,
    });
    assert.deepEqual(
      body.ranked.map((candidate) => candidate.candidate_id),
      ["local"],
    );
    assert.deepEqual(body.excluded, [
      {
        candidate_id: "remote-high-history",
        reason_codes: ["PRIVACY_MISMATCH"],
      },
      {
        candidate_id: "multi-mismatch",
        reason_codes: [
          "LOCALITY_MISMATCH",
          "POLICY_MISMATCH",
          "CAPABILITY_MISSING",
          "COORDINATION_MISMATCH",
          "CONTEXT_INSUFFICIENT",
        ],
      },
    ]);
    assert.deepEqual(
      snapshot(),
      filesBefore,
      "advisory recommendation must not create or mutate ledger/event files",
    );
  });
});
