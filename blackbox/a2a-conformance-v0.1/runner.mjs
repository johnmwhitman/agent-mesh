import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT_OPTION_INDEX = process.argv.indexOf("--package-root");
const PACKAGE_ROOT = PACKAGE_ROOT_OPTION_INDEX === -1
  ? resolve(PACKAGE_DIRECTORY, "../..")
  : process.argv[PACKAGE_ROOT_OPTION_INDEX + 1];
const SDK_ROOT_OPTION_INDEX = process.argv.indexOf("--sdk-root");
const SDK_ROOT = SDK_ROOT_OPTION_INDEX === -1
  ? PACKAGE_ROOT
  : process.argv[SDK_ROOT_OPTION_INDEX + 1];
const MANIFEST_PATH = join(PACKAGE_DIRECTORY, "manifest.json");
const PREAMBLE = "Meshfleet stdio catalog-boundary conformance v0.1";
const NONCLAIMS = [
  "This is not multi-client conformance or full A2A conformance.",
  "The runner configures no network and does not claim OS-level network blocking.",
  "Child mode prevents recovery, ratification sweeping, and SSE listening; the runner invokes no provider-capable tool.",
  "No messaging or ratification writes and no agent spawning occur because black-box setup cannot create actors without a provider launch."
];
const CAPTURE_BASELINE = process.argv.slice(2).includes("--capture-baseline");
let observedCatalogSha256 = null;
const FAMILY_NAMES = [
  "lifecycle",
  "messaging",
  "inbox",
  "receipts",
  "ratification",
  "capability-routing",
  "health"
];

function issue(error) {
  return error instanceof Error ? error.message : String(error);
}

function isInside(parent, candidate) {
  const value = relative(parent, candidate);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function canonicalize(value, arrayKind = "preserve") {
  if (Array.isArray(value)) {
    const entries = value.map((entry) => canonicalize(entry));
    return arrayKind === "tools"
      ? entries.sort((left, right) => {
        const leftName = String(left?.name ?? "");
        const rightName = String(right?.name ?? "");
        return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
      })
      : entries;
  }
  if (value !== null && typeof value === "object") {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = canonicalize(value[key], key === "tools" ? "tools" : "preserve");
    }
    return output;
  }
  return value;
}

function canonicalContract(tools) {
  return JSON.stringify(canonicalize({ tools }, "preserve"));
}

function digest(canonical) {
  return createHash("sha256").update(canonical).digest("hex");
}

function deepCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value !== null && typeof value === "object") {
    const output = {};
    for (const key of Object.keys(value).reverse()) output[key] = reverseObjectKeys(value[key]);
    return output;
  }
  return value;
}

function validateManifest(manifest) {
  const errors = [];
  if (manifest?.schema_version !== "0.1") errors.push("schema_version must be 0.1");
  if (manifest?.name !== PREAMBLE) errors.push("name must equal the fixed conformance name");
  if (manifest?.scope !== "bounded stdio catalog boundary only; not multi-client or full A2A conformance") {
    errors.push("scope must retain the bounded conformance claim");
  }
  if (manifest?.server_entrypoint !== "dist/index.js") {
    errors.push("server_entrypoint must be dist/index.js");
  }
  if (!CAPTURE_BASELINE && !/^[a-f0-9]{64}$/.test(manifest?.expected_catalog_sha256 ?? "")) {
    errors.push("expected_catalog_sha256 must be a pinned lowercase SHA-256 digest");
  }
  const unknownTool = manifest?.unknown_tool_expectation;
  if (!unknownTool || unknownTool.name !== "__meshfleet_catalog_boundary_unknown_tool__" || unknownTool.expected_exception_code !== -32603 || unknownTool.expected_message_substring !== "Unknown tool: __meshfleet_catalog_boundary_unknown_tool__") {
    errors.push("unknown_tool_expectation must pin the canary name, -32603, and the exact expected message substring");
  }
  const profiles = manifest?.synthetic_profiles;
  if (!Array.isArray(profiles) || profiles.length !== 2 || new Set(profiles).size !== 2 || !profiles.every((value) => /^synthetic-profile-\d{2}$/.test(value))) {
    errors.push("synthetic_profiles must contain two distinct opaque synthetic-profile labels");
  }
  const families = manifest?.families;
  if (!families || typeof families !== "object" || JSON.stringify(Object.keys(families).sort()) !== JSON.stringify([...FAMILY_NAMES].sort())) {
    errors.push("families must contain exactly the normative family names");
  } else {
    const names = new Set();
    for (const family of FAMILY_NAMES) {
      const tools = families[family]?.tools;
      if (!Array.isArray(tools) || tools.length === 0) {
        errors.push(`families.${family}.tools must be a non-empty array`);
        continue;
      }
      for (const tool of tools) {
        if (!tool || typeof tool.name !== "string" || tool.name.length === 0) {
          errors.push(`families.${family} contains an invalid tool name`);
          continue;
        }
        if (names.has(tool.name)) errors.push(`tool ${tool.name} appears in more than one family`);
        names.add(tool.name);
        if (!Array.isArray(tool.advertised_input_schema_members) || !tool.advertised_input_schema_members.every((member) => typeof member === "string" && member.length > 0)) {
          errors.push(`tool ${tool.name} has invalid advertised_input_schema_members`);
        }
      }
    }
  }
  const invariants = manifest?.stable_call_invariants;
  for (const toolName of ["ping", "get_health"]) {
    if (!invariants?.[toolName] || typeof invariants[toolName].expected !== "object" || !Array.isArray(invariants[toolName].ignored_volatile_fields_when_present)) {
      errors.push(`stable_call_invariants.${toolName} is incomplete`);
    }
  }
  return errors;
}

function manifestContractErrors(manifest, tools) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const errors = [];
  for (const family of FAMILY_NAMES) {
    for (const required of manifest.families[family].tools) {
      const actual = byName.get(required.name);
      if (!actual) {
        errors.push(`${family}: missing tool ${required.name}`);
        continue;
      }
      const properties = actual.inputSchema?.properties;
      if (!properties || typeof properties !== "object") {
        errors.push(`${family}: ${required.name} has no object inputSchema.properties`);
        continue;
      }
      for (const member of required.advertised_input_schema_members) {
        if (!Object.prototype.hasOwnProperty.call(properties, member)) {
          errors.push(`${family}: ${required.name} missing input schema member ${member}`);
        }
      }
    }
  }
  return errors;
}

function contentValue(result) {
  if (result?.isError === true) throw new Error("tool call returned isError");
  const text = result?.content?.find((entry) => entry?.type === "text")?.text;
  if (typeof text !== "string") throw new Error("tool result did not contain text JSON");
  return JSON.parse(text);
}

function invariantErrors(name, value, invariant) {
  const errors = [];
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return [`${name} result must be an object`];
  }
  for (const [key, expected] of Object.entries(invariant.expected)) {
    if (value?.[key] !== expected) errors.push(`${name}.${key} expected ${JSON.stringify(expected)} got ${JSON.stringify(value?.[key])}`);
  }
  const allowed = new Set([
    ...Object.keys(invariant.expected),
    ...invariant.ignored_volatile_fields_when_present
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${name} returned unexpected field ${key}`);
  }
  return errors;
}

async function unknownToolOutcome(client, toolName) {
  try {
    const result = await client.callTool({ name: toolName, arguments: {} });
    return { kind: result?.isError === true ? "tool-result-error" : "accepted" };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? Number(error.code) : null;
    return { kind: "exception", code, message: issue(error) };
  }
}

async function loadSdk(sdkRoot) {
  const resolvedSdkRoot = await realpath(sdkRoot);
  const resolvedSdkNodeModules = await realpath(join(resolvedSdkRoot, "node_modules"));
  const sdkRequire = createRequire(join(resolvedSdkRoot, "package.json"));
  const [clientPath, transportPath] = await Promise.all([
    realpath(sdkRequire.resolve("@modelcontextprotocol/sdk/client/index.js")),
    realpath(sdkRequire.resolve("@modelcontextprotocol/sdk/client/stdio.js"))
  ]);
  if (!isInside(resolvedSdkNodeModules, clientPath) || !isInside(resolvedSdkNodeModules, transportPath)) {
    throw new Error("configured SDK root must resolve both MCP client modules inside sdk-root/node_modules");
  }
  const [clientModule, transportModule] = await Promise.all([
    import(pathToFileURL(clientPath).href),
    import(pathToFileURL(transportPath).href)
  ]);
  if (typeof clientModule.Client !== "function" || typeof transportModule.StdioClientTransport !== "function") {
    throw new Error("installed official MCP SDK lacks the required stdio client exports");
  }
  return { Client: clientModule.Client, StdioClientTransport: transportModule.StdioClientTransport };
}

async function runProfile(profile, manifest, sdk, serverPath) {
  const root = await mkdtemp(join(tmpdir(), "meshfleet-catalog-boundary-"));
  let client;
  try {
    const home = join(root, "home");
    const childTmp = join(root, "tmp");
    const xdgConfig = join(root, "xdg", "config");
    const xdgCache = join(root, "xdg", "cache");
    const xdgData = join(root, "xdg", "data");
    const appData = join(root, "appdata", "roaming");
    const localAppData = join(root, "appdata", "local");
    const userProfile = join(root, "userprofile");
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(childTmp, { recursive: true }),
      mkdir(xdgConfig, { recursive: true }),
      mkdir(xdgCache, { recursive: true }),
      mkdir(xdgData, { recursive: true }),
      mkdir(appData, { recursive: true }),
      mkdir(localAppData, { recursive: true }),
      mkdir(userProfile, { recursive: true })
    ]);
    const childEnvironment = {
      HOME: home,
      TMPDIR: childTmp,
      TMP: childTmp,
      TEMP: childTmp,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_CACHE_HOME: xdgCache,
      XDG_DATA_HOME: xdgData,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      USERPROFILE: userProfile,
      MESHFLEET_DB_FILE: join(root, "meshfleet.sqlite"),
      MESHFLEET_EVENT_LOG_FILE: join(root, "events.jsonl"),
      AGENT_MESH_CHILD: "1",
      MESHFLEET_RATIFY_SWEEP_MS: "0",
      NODE_ENV: "test",
      PATH: process.env.PATH ?? ""
    };
    if (process.platform === "win32" && process.env.SystemRoot) childEnvironment.SystemRoot = process.env.SystemRoot;
    const transport = new sdk.StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      cwd: root,
      env: childEnvironment,
      stderr: "ignore"
    });
    client = new sdk.Client({ name: profile, version: "0.1" }, { capabilities: {} });
    await client.connect(transport);
    const list = await client.listTools();
    if (!Array.isArray(list?.tools)) throw new Error("listTools did not return a tools array");
    const tools = list.tools;
    const contract = canonicalContract(tools);
    const contractErrors = manifestContractErrors(manifest, tools);
    const ping = contentValue(await client.callTool({ name: "ping", arguments: {} }));
    const health = contentValue(await client.callTool({ name: "get_health", arguments: {} }));
    return {
      profile,
      tools,
      contract,
      digest: digest(contract),
      contract_errors: contractErrors,
      invariant_errors: [
        ...invariantErrors("ping", ping, manifest.stable_call_invariants.ping),
        ...invariantErrors("get_health", health, manifest.stable_call_invariants.get_health)
      ],
      unknown_tool_outcome: await unknownToolOutcome(client, manifest.unknown_tool_expectation.name)
    };
  } finally {
    if (client) await client.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

function addCheck(checks, id, status, detail) {
  checks.push({ id, status, detail });
}

async function main() {
  const checks = [];
  let manifest;
  try {
    manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  } catch (error) {
    addCheck(checks, "manifest.parse", "fail", issue(error));
    return checks;
  }
  const manifestErrors = validateManifest(manifest);
  addCheck(checks, "manifest.validate", manifestErrors.length === 0 ? "pass" : "fail", manifestErrors.length === 0 ? "manifest is structurally valid" : manifestErrors);
  if (manifestErrors.length > 0) return checks;

  if (PACKAGE_ROOT_OPTION_INDEX !== -1 && (typeof PACKAGE_ROOT !== "string" || !isAbsolute(PACKAGE_ROOT))) {
    addCheck(checks, "package-root.argument", "fail", "--package-root requires an absolute package directory");
    return checks;
  }
  if (SDK_ROOT_OPTION_INDEX !== -1 && (typeof SDK_ROOT !== "string" || !isAbsolute(SDK_ROOT))) {
    addCheck(checks, "sdk-root.argument", "fail", "--sdk-root requires an absolute dependency root");
    return checks;
  }
  const serverPath = resolve(PACKAGE_ROOT, manifest.server_entrypoint);
  try {
    const [entrypoint, resolvedPackageRoot, resolvedServerPath] = await Promise.all([
      stat(serverPath),
      realpath(PACKAGE_ROOT),
      realpath(serverPath)
    ]);
    if (!entrypoint.isFile() || basename(serverPath) !== "index.js") throw new Error("server entrypoint is not a local dist/index.js file");
    if (!isInside(resolvedPackageRoot, resolvedServerPath) || resolvedServerPath !== join(resolvedPackageRoot, manifest.server_entrypoint)) {
      throw new Error("server entrypoint must resolve to package-root/dist/index.js");
    }
    addCheck(checks, "local-built-server", "pass", "required local dist/index.js is present");
    addCheck(checks, "server-entrypoint-package-boundary", "pass", "resolved server entrypoint is package-root/dist/index.js");
  } catch (error) {
    addCheck(checks, "local-built-server", "fail", `required local artifact unavailable: ${issue(error)}`);
    return checks;
  }

  let sdk;
  try {
    sdk = await loadSdk(SDK_ROOT);
    addCheck(checks, "local-official-sdk", "pass", "official MCP SDK resolved from the configured dependency root");
  } catch (error) {
    addCheck(checks, "local-official-sdk", "fail", `local SDK unavailable: ${issue(error)}`);
    return checks;
  }

  const profiles = [];
  for (const profile of manifest.synthetic_profiles) {
    try {
      profiles.push(await runProfile(profile, manifest, sdk, serverPath));
      addCheck(checks, `profile.${profile}`, "pass", "connected, listed catalog, and completed read-only checks");
    } catch (error) {
      addCheck(checks, `profile.${profile}`, "fail", issue(error));
      return checks;
    }
  }

  for (const result of profiles) {
    addCheck(checks, `contract.${result.profile}`, result.contract_errors.length === 0 ? "pass" : "fail", result.contract_errors.length === 0 ? "all normative tools and schema members present" : result.contract_errors);
    addCheck(checks, `invariants.${result.profile}`, result.invariant_errors.length === 0 ? "pass" : "fail", result.invariant_errors.length === 0 ? "stable ping and health invariants satisfied" : result.invariant_errors);
  }

  const [first, second] = profiles;
  observedCatalogSha256 = first.digest;
  const sameContract = first.contract === second.contract;
  const sameDigest = first.digest === second.digest;
  addCheck(checks, "profiles.structural-canonical-equality", sameContract ? "pass" : "fail", sameContract ? "canonical contracts match" : "canonical contracts differ");
  addCheck(checks, "profiles.sha256-equality", sameDigest ? "pass" : "fail", sameDigest ? "SHA-256 digests match" : "SHA-256 digests differ");
  if (CAPTURE_BASELINE) {
    addCheck(checks, "catalog-sha256-pin", "pass", "baseline capture mode does not enforce expected_catalog_sha256");
  } else {
    for (const result of profiles) {
      addCheck(checks, `catalog-sha256-pin.${result.profile}`, result.digest === manifest.expected_catalog_sha256 ? "pass" : "fail", result.digest === manifest.expected_catalog_sha256 ? "complete catalog digest matches manifest pin" : `expected ${manifest.expected_catalog_sha256}, got ${result.digest}`);
    }
  }
  const expectedUnknown = manifest.unknown_tool_expectation;
  const matchesUnknown = (outcome) => outcome.kind === "exception" && outcome.code === expectedUnknown.expected_exception_code && outcome.message.includes(expectedUnknown.expected_message_substring);
  const consistentUnknown = matchesUnknown(first.unknown_tool_outcome) && matchesUnknown(second.unknown_tool_outcome) && first.unknown_tool_outcome.code === second.unknown_tool_outcome.code && first.unknown_tool_outcome.message === second.unknown_tool_outcome.message;
  addCheck(checks, "unknown-tool-consistency", consistentUnknown ? "pass" : "fail", consistentUnknown ? `both profiles rejected the exact canary with code ${first.unknown_tool_outcome.code}` : "unknown-tool response did not match the pinned code and exact canary message");

  const baseline = first.contract;
  const reorderedKeys = canonicalContract(reverseObjectKeys(deepCopy(first.tools)));
  const reorderedTools = canonicalContract([...deepCopy(first.tools)].reverse());
  const normativeTools = FAMILY_NAMES.flatMap((family) => manifest.families[family].tools);
  const schemaMutated = deepCopy(first.tools);
  schemaMutated[0].inputSchema = { ...schemaMutated[0].inputSchema, __meshfleet_catalog_boundary_canary__: { type: "string" } };
  addCheck(checks, "canary.object-key-order-invariance", baseline === reorderedKeys ? "pass" : "fail", "canonical contract must ignore object key order");
  addCheck(checks, "canary.tool-order-invariance", baseline === reorderedTools ? "pass" : "fail", "canonical contract must sort tools by name");
  for (const required of normativeTools) {
    const removed = deepCopy(first.tools).filter((tool) => tool.name !== required.name);
    addCheck(checks, `canary.required-tool-removal.${required.name}`, manifestContractErrors(manifest, removed).length > 0 ? "pass" : "fail", "removing this normative tool must be detected");
    for (const member of required.advertised_input_schema_members) {
      const memberRemoved = deepCopy(first.tools);
      const tool = memberRemoved.find((entry) => entry.name === required.name);
      if (tool?.inputSchema?.properties) delete tool.inputSchema.properties[member];
      addCheck(checks, `canary.advertised-member-removal.${required.name}.${member}`, manifestContractErrors(manifest, memberRemoved).length > 0 ? "pass" : "fail", "removing this advertised member must be detected");
    }
  }
  addCheck(checks, "canary.schema-mutation-digest", digest(baseline) !== digest(canonicalContract(schemaMutated)) ? "pass" : "fail", "schema mutation must change the SHA-256 digest");
  return checks;
}

const checks = await main().catch((error) => [{ id: "runner.unhandled", status: "fail", detail: issue(error) }]);
const passed = checks.length > 0 && checks.every((check) => check.status === "pass");
process.stdout.write(`${JSON.stringify({
  preamble: PREAMBLE,
  nonclaims: NONCLAIMS,
  observed_catalog_sha256: observedCatalogSha256,
  passed,
  checks
})}\n`);
if (!passed) process.exitCode = 1;
