/**
 * The route-candidate snapshot compiler contract over real MCP stdio.
 *
 * This is deliberately an offline projection surface. The byte snapshots are
 * taken only after connection, so normal database startup cannot masquerade as
 * a compiler write.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ROUTE_CANDIDATE_COMPILER_VERSION } from "../src/compile-route-candidates.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const textOf = (response: unknown): string =>
  (response as { content: Array<{ text: string }> }).content[0]!.text;

const corpus = JSON.parse(
  readFileSync(
    join(repoRoot, "test", "fixtures", "routing", "route-candidate-snapshots", "v0.1", "corpus.json"),
    "utf8",
  ),
) as {
  manifest: Record<string, unknown>;
  cases: Array<{
    id: string;
    input: Record<string, unknown>;
    expected_candidates: unknown[];
    expected_diagnostics: unknown[];
  }>;
};

function snapshot(dataDir: string): Array<[string, string]> {
  return readdirSync(dataDir)
    .sort()
    .map((name) => [name, readFileSync(join(dataDir, name)).toString("base64")]);
}

async function withServer(
  fn: (client: Client, dataDir: string, afterConnect: Array<[string, string]>) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-compile-route-candidates-"));
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
    { name: "compile-route-candidates-contract-test", version: "1.0.0" },
    { capabilities: {} },
  );
  try {
    await client.connect(transport);
    await fn(client, dir, snapshot(dir));
  } finally {
    await client.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

function portableInput(caseId = "measured-evidence-copies-exactly"): Record<string, unknown> {
  const fixture = corpus.cases.find(({ id }) => id === caseId);
  assert.ok(fixture, `missing portable corpus fixture: ${caseId}`);
  return { manifest: structuredClone(corpus.manifest), ...structuredClone(fixture.input) };
}

function assertNoWrite(dataDir: string, before: Array<[string, string]>, label: string): void {
  assert.deepEqual(snapshot(dataDir), before, `${label} must not create or mutate data files`);
}

test("compile_route_candidates advertises a closed snapshot compiler schema", async () => {
  await withServer(async (client, dataDir, afterConnect) => {
    const before = snapshot(dataDir);
    assert.deepEqual(before, afterConnect, "discovery starts from the post-connection snapshot");
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "compile_route_candidates");
    assert.ok(tool, "missing MCP tool: compile_route_candidates");
    assert.match(tool.description ?? "", /offline projection/i);
    assert.match(tool.description ?? "", /does not persist, rank, execute, authorize, wake, or contact providers/i);

    const input = tool.inputSchema as Record<string, any>;
    assert.equal(input.additionalProperties, false);
    assert.deepEqual(input.required, ["manifest"]);
    const manifest = input.properties.manifest;
    const candidate = manifest.properties.candidates.items;
    const observation = input.properties.observations.items;
    assert.deepEqual(manifest.required, ["version", "candidates"]);
    assert.deepEqual(candidate.required, ["candidate_id", "capabilities", "privacy", "locality"]);
    assert.deepEqual(observation.required, ["candidate_id", "status", "confidence"]);
    assert.deepEqual(manifest.properties.version.enum, [ROUTE_CANDIDATE_COMPILER_VERSION]);

    const objects = [
      input,
      manifest,
      candidate,
      observation,
      observation.properties.budget,
      observation.properties.budget.properties.window,
      observation.properties.observed_outcomes,
      candidate.properties.requested_identity,
      observation.properties.observed_identity,
    ];
    for (const object of objects) {
      assert.equal(object.additionalProperties, false, "every ingress object must be closed");
    }

    assert.equal(manifest.properties.candidates.minItems, 1);
    assert.equal(manifest.properties.candidates.maxItems, 256);
    assert.equal(input.properties.observations.minItems, 0);
    assert.equal(input.properties.observations.maxItems, 256);
    assert.equal(candidate.properties.capabilities.minItems, 1);
    assert.equal(candidate.properties.capabilities.maxItems, 64);
    assert.equal(candidate.properties.policy_tags.minItems, 0);
    assert.equal(candidate.properties.policy_tags.maxItems, 64);
    assert.equal(candidate.properties.coordination_modes.minItems, 1);
    assert.equal(candidate.properties.coordination_modes.maxItems, 2);
    assert.equal(candidate.properties.candidate_id.maxLength, 128);
    assert.equal(candidate.properties.requested_identity.properties.runtime.maxLength, 256);
    assert.equal(observation.properties.observed_identity.properties.model.maxLength, 256);
    assert.equal(observation.properties.observed_identity.properties.source.maxLength, 256);
    assert.equal(observation.properties.observed_outcomes.properties.successes.maximum, 1_000_000);
    assert.equal(observation.properties.observed_outcomes.properties.failures.maximum, 1_000_000);
    assert.deepEqual(
      observation.properties.budget.properties.window.required,
      ["starts_at_ms", "ends_at_ms"],
    );
    assertNoWrite(dataDir, before, "tool discovery");
  });
});

test("compile_route_candidates projects the portable corpus without writing", async () => {
  await withServer(async (client, dataDir) => {
    for (const fixture of corpus.cases) {
      const before = snapshot(dataDir);
      const response = await client.callTool({
        name: "compile_route_candidates",
        arguments: portableInput(fixture.id),
      });
      assert.equal((response as { isError?: boolean }).isError, undefined, fixture.id);
      const body = JSON.parse(textOf(response));
      assert.deepEqual(body, {
        compiler_version: ROUTE_CANDIDATE_COMPILER_VERSION,
        projection: true,
        effects: {
          persisted: false,
          executed: false,
          authorized: false,
          woke_agents: false,
          contacted_providers: false,
        },
        candidates: fixture.expected_candidates,
        diagnostics: fixture.expected_diagnostics,
      }, fixture.id);
      assertNoWrite(dataDir, before, fixture.id);

      if (fixture.id === "measured-evidence-copies-exactly") {
        const beforeRecommendation = snapshot(dataDir);
        const recommendation = await client.callTool({
          name: "recommend_route",
          arguments: {
            task: {
              required_capabilities: ["code"],
              privacy: "network_ok",
              locality: "any",
            },
            candidates: body.candidates,
            top_n: body.candidates.length,
          },
        });
        assert.equal(
          (recommendation as { isError?: boolean }).isError,
          undefined,
          "the compiler projection is unchanged recommend_route input",
        );
        assertNoWrite(dataDir, beforeRecommendation, "recommend_route over compiler projection");
      }
    }
  });
});

test("compile_route_candidates runtime validation rejects malicious fields without writing or closing stdio", async () => {
  await withServer(async (client, dataDir) => {
    const fieldNames = [
      "provider",
      "subscription",
      "authenticated",
      "endpoint",
      "credentials",
      "dispatch",
      "availability",
      "quota_reset_at",
      "prompt",
      "message",
      "execute",
      "wake_agent",
    ];
    const locations: Array<{
      name: string;
      withField: (field: string) => Record<string, unknown>;
    }> = [
      {
        name: "input",
        withField: (field) => ({ ...portableInput(), [field]: "forbidden" }),
      },
      {
        name: "manifest",
        withField: (field) => {
          const input = portableInput();
          return { ...input, manifest: { ...(input.manifest as Record<string, unknown>), [field]: "forbidden" } };
        },
      },
      {
        name: "candidate",
        withField: (field) => {
          const input = portableInput();
          const manifest = input.manifest as { candidates: Array<Record<string, unknown>> };
          return { ...input, manifest: { ...manifest, candidates: [{ ...manifest.candidates[0], [field]: "forbidden" }, ...manifest.candidates.slice(1)] } };
        },
      },
      {
        name: "observation",
        withField: (field) => {
          const input = portableInput();
          const observations = input.observations as Array<Record<string, unknown>>;
          return { ...input, observations: [{ ...observations[0], [field]: "forbidden" }, ...observations.slice(1)] };
        },
      },
      {
        name: "budget",
        withField: (field) => {
          const input = portableInput();
          const observations = input.observations as Array<Record<string, unknown>>;
          return { ...input, observations: [{ ...observations[0], budget: { ...(observations[0]!.budget as Record<string, unknown>), [field]: "forbidden" } }, ...observations.slice(1)] };
        },
      },
      {
        name: "observed_outcomes",
        withField: (field) => {
          const input = portableInput();
          const observations = input.observations as Array<Record<string, unknown>>;
          return { ...input, observations: [{ ...observations[0], observed_outcomes: { ...(observations[0]!.observed_outcomes as Record<string, unknown>), [field]: "forbidden" } }, ...observations.slice(1)] };
        },
      },
      {
        name: "requested_identity",
        withField: (field) => {
          const input = portableInput();
          const manifest = input.manifest as { candidates: Array<Record<string, unknown>> };
          const candidate = manifest.candidates[0]!;
          return { ...input, manifest: { ...manifest, candidates: [{ ...candidate, requested_identity: { ...(candidate.requested_identity as Record<string, unknown>), [field]: "forbidden" } }, ...manifest.candidates.slice(1)] } };
        },
      },
      {
        name: "observed_identity",
        withField: (field) => {
          const input = portableInput();
          const observations = input.observations as Array<Record<string, unknown>>;
          return { ...input, observations: [{ ...observations[0], observed_identity: { ...(observations[0]!.observed_identity as Record<string, unknown>), [field]: "forbidden" } }, ...observations.slice(1)] };
        },
      },
    ];

    for (const location of locations) {
      for (const field of fieldNames) {
        const before = snapshot(dataDir);
        const response = await client.callTool({
          name: "compile_route_candidates",
          arguments: location.withField(field),
        });
        assert.equal((response as { isError?: boolean }).isError, true, `${location.name}.${field}`);
        assert.match(textOf(response), new RegExp(field), `${location.name}.${field}`);
        assertNoWrite(dataDir, before, `${location.name}.${field}`);
      }
    }

    const before = snapshot(dataDir);
    const stillCallable = await client.callTool({
      name: "compile_route_candidates",
      arguments: portableInput(),
    });
    assert.equal((stillCallable as { isError?: boolean }).isError, undefined);
    assertNoWrite(dataDir, before, "post-rejection portable projection");
  });
});
