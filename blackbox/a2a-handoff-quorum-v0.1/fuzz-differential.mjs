import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ConformanceError,
  canonical,
  digest,
  evaluateScenario,
  parseStrictJson,
} from "./evaluator.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const pythonPath = path.join(root, "python");
const seedValue = 0x4f5a1234;

const parserPython = [
  "import base64,sys",
  "sys.path.insert(0,sys.argv[1])",
  "from evaluator import parse_strict_json,ConformanceError",
  "try:",
  " parse_strict_json(base64.b64decode(sys.argv[2])); print('OK')",
  "except ConformanceError as e: print(e.code)",
  "except Exception as e: print('ESCAPED:'+type(e).__name__)",
].join("\n");

const scenarioPython = [
  "import base64,json,sys",
  "sys.path.insert(0,sys.argv[1])",
  "from evaluator import evaluate_scenario,canonical",
  "value=json.loads(base64.b64decode(sys.argv[2]).decode('utf-8'))",
  "print(canonical(evaluate_scenario(value)))",
].join("\n");

function python(script, bytes) {
  const result = spawnSync(
    "python3",
    ["-c", script, pythonPath, Buffer.from(bytes).toString("base64")],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`Python adapter failed (${result.status}): ${result.stderr}`);
  }
  return result.stdout.trim();
}

function parserOutcome(bytes) {
  try {
    parseStrictJson(bytes);
    return "OK";
  } catch (error) {
    return error instanceof ConformanceError ? error.code : `ESCAPED:${error.constructor.name}`;
  }
}

const parserInputs = [
  "", " ", "null", "0", "-0", "00", "01", "-01", "1.", "1.0", "1e0", "1e",
  "1E+2", "+1", "--1", "1-2", "1+2", "9007199254740992", "[1,]", "[,1]",
  "{\"a\":}", "{\"a\":1,}", "{\"a\":1,\"a\":2}", "{\"a\":1,\"\\u0061\":2}",
  "\"\\x41\"", "\"\\uD800\"", "\"\\uD83D\\uDE00\"", "true false",
].map((value) => Buffer.from(value));
parserInputs.push(Buffer.from([0xc3, 0x28]));
parserInputs.push(Buffer.from("[".repeat(66) + "0" + "]".repeat(66)));

let seed = seedValue;
function random() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed;
}
function pick(values) {
  return values[random() % values.length];
}

function scenario(index) {
  const voterCount = 1 + (random() % 6);
  const voters = Array.from({ length: voterCount }, (_, voter) => `v${voter}`);
  const weights = {};
  for (const voter of voters) {
    if (random() % 3 === 0) weights[voter] = 1 + (random() % 5);
  }
  const totalWeight = voters.reduce((sum, voter) => sum + (weights[voter] ?? 1), 0);
  const requiredSignoffs = voters.filter(() => random() % 5 === 0);
  const proposal = {
    proposal_id: `p${index}`,
    voters,
    required_signoffs: requiredSignoffs,
    quorum: 1 + (random() % totalWeight),
    weights,
    deadline: random() % 3 === 0 ? 5 + (random() % 20) : null,
    silence_policy: pick(["abstain", "approve"]),
  };
  const actions = [];
  const receiptIds = [];
  let at = 0;
  const actionCount = 1 + (random() % 20);
  for (let actionIndex = 0; actionIndex < actionCount; actionIndex += 1) {
    at += random() % 3;
    if (random() % 4 === 0) {
      actions.push({ op: "resolve", at });
      continue;
    }
    const voter = random() % 8 === 0 ? "outsider" : pick(voters);
    const prior = actions.filter((action) => action.op === "vote" && action.voter_id === voter);
    let voteSeq = prior.length ? Math.max(...prior.map((action) => action.seq)) + 1 : 0;
    if (random() % 5 === 0) voteSeq += 1;
    let receiptId = `r${index}-${actionIndex}`;
    if (receiptIds.length && random() % 7 === 0) receiptId = pick(receiptIds);
    else receiptIds.push(receiptId);
    actions.push({
      op: "vote",
      at,
      receipt_id: receiptId,
      voter_id: voter,
      seq: voteSeq,
      decision: pick(["approve", "decline"]),
    });
  }
  return {
    profile: "meshfleet.a2a.handoff-quorum.v0.1",
    case_id: `F${index}`,
    proposal,
    actions,
  };
}

try {
  const parserTranscript = parserInputs.map((bytes, index) => {
    const javascript = parserOutcome(bytes);
    const pythonResult = python(parserPython, bytes);
    if (javascript !== pythonResult) {
      throw new Error(`parser mismatch ${index}: JavaScript=${javascript} Python=${pythonResult}`);
    }
    return { index, input_sha256: digest(bytes.toString("base64")), outcome: javascript };
  });

  const generatedReceipts = [];
  for (let index = 0; index < 300; index += 1) {
    const input = scenario(index);
    const javascriptResult = evaluateScenario(input);
    const pythonResult = python(scenarioPython, Buffer.from(canonical(input), "utf8"));
    if (canonical(javascriptResult) !== pythonResult) {
      throw new Error(`scenario mismatch ${index}`);
    }
    for (const command of javascriptResult.command_results) {
      if (!command.accepted && command.pre_state_sha256 !== command.post_state_sha256) {
        throw new Error(`rejected action mutated state ${index}:${command.index}`);
      }
    }
    if (javascriptResult.events.some((event, eventIndex) => event.seq !== eventIndex)) {
      throw new Error(`event sequence gap ${index}`);
    }
    const partition = [
      ...javascriptResult.tally.approvals,
      ...javascriptResult.tally.declines,
      ...javascriptResult.tally.pending,
    ];
    if (partition.length !== input.proposal.voters.length || new Set(partition).size !== partition.length) {
      throw new Error(`tally partition mismatch ${index}`);
    }
    if (javascriptResult.status !== "open" && javascriptResult.resolved_at === null) {
      throw new Error(`terminal state lacks resolved_at ${index}`);
    }
    generatedReceipts.push({
      case_id: input.case_id,
      input_sha256: digest(input),
      result_sha256: digest(javascriptResult),
    });
  }

  process.stdout.write(`${canonical({
    ok: true,
    seed: `0x${seedValue.toString(16)}`,
    parser_cases: parserTranscript.length,
    parser_transcript_sha256: digest(parserTranscript),
    generated_scenarios: generatedReceipts.length,
    generated_transcript_sha256: digest(generatedReceipts),
  })}\n`);
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
}
