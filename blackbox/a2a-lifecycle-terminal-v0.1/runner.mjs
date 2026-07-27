#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  PROFILE,
  canonical,
  evaluateLifecycleTrace,
  parseStrictJson,
  projectReceipt,
  sha256
} from "./evaluator.mjs";

const root = dirname(fileURLToPath(import.meta.url));

async function load() {
  const contractBytes = await readFile(join(root, "contract.json"));
  const corpusBytes = await readFile(join(root, "corpus/v0.1/cases.json"));
  const contract = parseStrictJson(contractBytes.toString("utf8"));
  const corpus = parseStrictJson(corpusBytes.toString("utf8"));
  if (contract.profile !== PROFILE || corpus.profile !== PROFILE) throw new Error("profile mismatch");
  if (canonical(corpus.mandatory_case_ids) !== canonical(corpus.cases.map((item) => item.id))) {
    throw new Error("mandatory_case_ids must exactly match cases in order");
  }
  if (canonical(corpus.supplemental_case_ids) !== canonical(corpus.supplemental_cases.map((item) => item.id))) {
    throw new Error("supplemental_case_ids must exactly match supplemental_cases in order");
  }
  return { contractBytes, corpusBytes, corpus };
}

function expectedEvents(trace, stepCodes) {
  if (stepCodes.length === 0) return [];
  let workId = null;
  let attemptNumber = 0;
  let ownerEpoch = 0;
  let maxAttempts = 0;
  const events = [];
  const push = (kind, at) => {
    const seq = events.length + 1;
    events.push({
      id: `${workId}:event:${seq}`,
      seq,
      kind,
      attempt_id: `${workId}:attempt:${attemptNumber}`,
      owner_epoch: ownerEpoch,
      occurred_at: at
    });
  };
  trace.commands.forEach((command, index) => {
    if (stepCodes[index] !== "OK") return;
    switch (command.op) {
      case "create":
        workId = command.work_id;
        attemptNumber = 1;
        ownerEpoch = 0;
        maxAttempts = command.max_attempts;
        push("attempt_created", command.at);
        break;
      case "acquire":
        ownerEpoch += 1;
        push("lease_acquired", command.at);
        break;
      case "renew":
        push("lease_acquired", command.at);
        break;
      case "expire":
        push("lease_expired", command.at);
        if (attemptNumber < maxAttempts) {
          attemptNumber += 1;
          ownerEpoch += 1;
          push("attempt_retried", command.at);
        } else {
          push("attempt_failed", command.at);
        }
        break;
      case "settle":
        push(command.outcome === "success" ? "attempt_succeeded" : "attempt_failed", command.at);
        break;
      case "settle_with_retry":
        push("attempt_failed", command.at);
        if (attemptNumber < maxAttempts) {
          attemptNumber += 1;
          ownerEpoch += 1;
          push("attempt_retried", command.at);
        }
        break;
      case "cancel":
        push("attempt_cancelled", command.at);
        break;
    }
  });
  return events;
}

function executeCases(corpus) {
  return [...corpus.cases, ...corpus.supplemental_cases].map((item) => {
    const receipt = evaluateLifecycleTrace(item.trace);
    const actual = projectReceipt(receipt);
    const metadataPassed = receipt.final === null
      ? expectedEvents(item.trace, item.expected.step_codes).length === 0
      : canonical(receipt.final.events) === canonical(expectedEvents(item.trace, item.expected.step_codes));
    return {
      id: item.id,
      passed: canonical(actual) === canonical(item.expected) && metadataPassed,
      metadata_passed: metadataPassed,
      expected_sha256: sha256(item.expected),
      actual_sha256: sha256(actual),
      receipt
    };
  });
}

async function main() {
  const { contractBytes, corpusBytes, corpus } = await load();
  const results = executeCases(corpus);
  if (process.argv.includes("--emit-cases")) {
    if (results.some((item) => !item.passed)) throw new Error("cannot emit a failing corpus");
    process.stdout.write(`${canonical(results.map((item) => item.receipt))}\n`);
    return;
  }
  if (process.argv.includes("--self-test")) {
    if (results.some((item) => !item.passed)) throw new Error("baseline corpus failed");
    let mutationDetections = 0;
    for (const item of [...corpus.cases, ...corpus.supplemental_cases]) {
      const mutated = JSON.parse(JSON.stringify(item.expected));
      mutated.step_codes.push("__MUTATED__");
      if (canonical(projectReceipt(evaluateLifecycleTrace(item.trace))) !== canonical(mutated)) mutationDetections += 1;
    }
    const controls = [
      () => parseStrictJson("{\"a\":1,\"a\":2}"),
      () => parseStrictJson("{\"a\":1.5}"),
      () => parseStrictJson("{\"a\":-0}"),
      () => parseStrictJson("{\"a\":9007199254740992}"),
      () => parseStrictJson("{\"a\":\"\\ud800\"}"),
      () => parseStrictJson("\u00a0{\"a\":1}"),
      () => parseStrictJson("\ufeff{\"a\":1}")
    ];
    let parserDetections = 0;
    for (const control of controls) {
      try {
        control();
      } catch {
        parserDetections += 1;
      }
    }
    const canonicalControls = [
      canonical(parseStrictJson("{\"__proto__\":1,\"10\":2,\"2\":3}")) === "{\"10\":2,\"2\":3,\"__proto__\":1}",
      canonical(parseStrictJson("{\"\\ud800\\udc00\":5,\"\\ue000\":4}")) === "{\"\":4,\"𐀀\":5}"
    ].filter(Boolean).length;
    if (mutationDetections !== results.length || parserDetections !== controls.length || canonicalControls !== 2) {
      throw new Error("self-test control escaped detection");
    }
    process.stdout.write(`${canonical({
      profile: PROFILE,
      implementation: "javascript",
      corpus_cases: results.length,
      mandatory_cases: corpus.cases.length,
      supplemental_cases: corpus.supplemental_cases.length,
      baseline_passed: results.length,
      mutation_controls_passed: mutationDetections,
      parser_controls_passed: parserDetections,
      canonical_controls_passed: canonicalControls
    })}\n`);
    return;
  }
  const failed = results.filter((item) => !item.passed);
  const transcript = results.map(({ id, passed, expected_sha256, actual_sha256, receipt }) => ({
    id, passed, expected_sha256, actual_sha256, receipt_sha256: receipt.receipt_sha256
  }));
  const report = {
    profile: PROFILE,
    implementation: "javascript",
    contract_sha256: sha256(contractBytes.toString("utf8")),
    corpus_sha256: sha256(corpusBytes.toString("utf8")),
    case_count: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    failed_case_ids: failed.map((item) => item.id),
    transcript_sha256: sha256(transcript)
  };
  process.stdout.write(`${canonical(report)}\n`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
