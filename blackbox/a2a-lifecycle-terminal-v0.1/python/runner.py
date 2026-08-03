#!/usr/bin/env python3
import json
import pathlib
import sys

from evaluator import PROFILE, canonical, evaluate_lifecycle_trace, parse_strict_json, project_receipt, sha256

# Byte-differential contract: stdout is UTF-8 with "\n" newlines on every platform. The five
# runners patched in #106 proved this line on real windows-2022 CI; the unpatched ones failed
# there (#108 first run) -- Windows text-mode stdout emits \r\n from print(), bytes the
# JavaScript side of the differential never emits, and cp1252 cannot encode all corpus content.
sys.stdout.reconfigure(encoding="utf-8", newline="\n")


ROOT = pathlib.Path(__file__).resolve().parent.parent


def load():
    contract_text = (ROOT / "contract.json").read_text(encoding="utf-8")
    corpus_text = (ROOT / "corpus/v0.1/cases.json").read_text(encoding="utf-8")
    contract = parse_strict_json(contract_text)
    corpus = parse_strict_json(corpus_text)
    if contract["profile"] != PROFILE or corpus["profile"] != PROFILE:
        raise ValueError("profile mismatch")
    if canonical(corpus["mandatory_case_ids"]) != canonical([item["id"] for item in corpus["cases"]]):
        raise ValueError("mandatory_case_ids must exactly match cases in order")
    if canonical(corpus["supplemental_case_ids"]) != canonical([item["id"] for item in corpus["supplemental_cases"]]):
        raise ValueError("supplemental_case_ids must exactly match supplemental_cases in order")
    return contract_text, corpus_text, corpus


def expected_events(trace, step_codes):
    if not step_codes:
        return []
    work_id = None
    attempt_number = 0
    owner_epoch = 0
    max_attempts = 0
    events = []

    def push(kind, at):
        seq = len(events) + 1
        events.append({
            "id": f"{work_id}:event:{seq}",
            "seq": seq,
            "kind": kind,
            "attempt_id": f"{work_id}:attempt:{attempt_number}",
            "owner_epoch": owner_epoch,
            "occurred_at": at,
        })

    for index, command in enumerate(trace.get("commands", [])):
        if step_codes[index] != "OK":
            continue
        op = command["op"]
        if op == "create":
            work_id = command["work_id"]
            attempt_number = 1
            owner_epoch = 0
            max_attempts = command["max_attempts"]
            push("attempt_created", command["at"])
        elif op == "acquire":
            owner_epoch += 1
            push("lease_acquired", command["at"])
        elif op == "renew":
            push("lease_acquired", command["at"])
        elif op == "expire":
            push("lease_expired", command["at"])
            if attempt_number < max_attempts:
                attempt_number += 1
                owner_epoch += 1
                push("attempt_retried", command["at"])
            else:
                push("attempt_failed", command["at"])
        elif op == "settle":
            push("attempt_succeeded" if command["outcome"] == "success" else "attempt_failed", command["at"])
        elif op == "settle_with_retry":
            push("attempt_failed", command["at"])
            if attempt_number < max_attempts:
                attempt_number += 1
                owner_epoch += 1
                push("attempt_retried", command["at"])
        elif op == "cancel":
            push("attempt_cancelled", command["at"])
    return events


def execute_cases(corpus):
    results = []
    for item in corpus["cases"] + corpus["supplemental_cases"]:
        receipt = evaluate_lifecycle_trace(item["trace"])
        actual = project_receipt(receipt)
        expected_metadata = expected_events(item["trace"], item["expected"]["step_codes"])
        metadata_passed = (not expected_metadata) if receipt["final"] is None else canonical(receipt["final"]["events"]) == canonical(expected_metadata)
        results.append({
            "id": item["id"],
            "passed": canonical(actual) == canonical(item["expected"]) and metadata_passed,
            "metadata_passed": metadata_passed,
            "expected_sha256": sha256(item["expected"]),
            "actual_sha256": sha256(actual),
            "receipt": receipt,
        })
    return results


def main():
    contract_text, corpus_text, corpus = load()
    results = execute_cases(corpus)
    if "--emit-cases" in sys.argv:
        if any(not item["passed"] for item in results):
            raise ValueError("cannot emit a failing corpus")
        print(canonical([item["receipt"] for item in results]))
        return 0
    if "--self-test" in sys.argv:
        if any(not item["passed"] for item in results):
            raise ValueError("baseline corpus failed")
        mutation_detections = 0
        for item in corpus["cases"] + corpus["supplemental_cases"]:
            mutated = json.loads(json.dumps(item["expected"]))
            mutated["step_codes"].append("__MUTATED__")
            if canonical(project_receipt(evaluate_lifecycle_trace(item["trace"]))) != canonical(mutated):
                mutation_detections += 1
        controls = ['{"a":1,"a":2}', '{"a":1.5}', '{"a":-0}', '{"a":9007199254740992}', '{"a":"\\ud800"}', '\u00a0{"a":1}', '\ufeff{"a":1}']
        parser_detections = 0
        for control in controls:
            try:
                parse_strict_json(control)
            except (ValueError, UnicodeError):
                parser_detections += 1
        canonical_controls = sum([
            canonical(parse_strict_json('{"__proto__":1,"10":2,"2":3}')) == '{"10":2,"2":3,"__proto__":1}',
            canonical(parse_strict_json('{"\\ud800\\udc00":5,"\\ue000":4}')) == '{"\ue000":4,"\U00010000":5}',
        ])
        if mutation_detections != len(results) or parser_detections != len(controls) or canonical_controls != 2:
            raise ValueError("self-test control escaped detection")
        print(canonical({
            "profile": PROFILE,
            "implementation": "python",
            "corpus_cases": len(results),
            "mandatory_cases": len(corpus["cases"]),
            "supplemental_cases": len(corpus["supplemental_cases"]),
            "baseline_passed": len(results),
            "mutation_controls_passed": mutation_detections,
            "parser_controls_passed": parser_detections,
            "canonical_controls_passed": canonical_controls,
        }))
        return 0
    failed = [item for item in results if not item["passed"]]
    transcript = [{
        "id": item["id"],
        "passed": item["passed"],
        "expected_sha256": item["expected_sha256"],
        "actual_sha256": item["actual_sha256"],
        "receipt_sha256": item["receipt"]["receipt_sha256"],
    } for item in results]
    print(canonical({
        "profile": PROFILE,
        "implementation": "python",
        "contract_sha256": sha256(contract_text),
        "corpus_sha256": sha256(corpus_text),
        "case_count": len(results),
        "passed": len(results) - len(failed),
        "failed": len(failed),
        "failed_case_ids": [item["id"] for item in failed],
        "transcript_sha256": sha256(transcript),
    }))
    return 1 if failed else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        raise SystemExit(1)
