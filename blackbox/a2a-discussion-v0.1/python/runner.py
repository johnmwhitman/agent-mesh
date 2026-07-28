#!/usr/bin/env python3
"""Independent Python runner for the discussion-derivation v0.1 witness."""

import argparse
import hashlib
import json
import re
import sys

from evaluator import derive_discussion, parse_envelope, parse_receipt_action


PROFILE = "meshfleet.a2a.discussion-derivation.v0.1"
MAX_DOCUMENT_BYTES = 12 * 1024 * 1024
MAX_JSON_DEPTH = 32


def _reject_constant(value):
    raise ValueError(f"nonstandard JSON constant: {value}")


def _object_without_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _check_depth(value):
    pending = [(value, 0)]
    while pending:
        current, depth = pending.pop()
        if depth > MAX_JSON_DEPTH:
            raise ValueError("JSON depth limit exceeded")
        if isinstance(current, dict):
            pending.extend((item, depth + 1) for item in current.values())
        elif isinstance(current, list):
            pending.extend((item, depth + 1) for item in current)


def _load_document(raw):
    if len(raw) > MAX_DOCUMENT_BYTES:
        raise ValueError("document size limit exceeded")
    document = json.loads(
        raw.decode("utf-8"),
        parse_constant=_reject_constant,
        object_pairs_hook=_object_without_duplicates,
    )
    _check_depth(document)
    return document


def _read_bounded(stream):
    raw = stream.read(MAX_DOCUMENT_BYTES + 1)
    if len(raw) > MAX_DOCUMENT_BYTES:
        raise ValueError("document size limit exceeded")
    return raw


def _validate_cases(cases):
    if not isinstance(cases, list) or not cases:
        raise ValueError("cases must be non-empty")
    case_ids = []
    seen_ids = set()
    for item in cases:
        if not isinstance(item, dict):
            raise ValueError("cases must be objects")
        case_id = item.get("id")
        if not isinstance(case_id, str) or not case_id or case_id in seen_ids:
            raise ValueError("case ids must be unique non-empty strings")
        seen_ids.add(case_id)
        case_ids.append(case_id)
    return case_ids


def _project_derived(derived, include_attempts=True):
    output = {
        "status": derived["status"],
        "turns_used": derived["turns_used"],
        "turns_remaining": derived["turns_remaining"],
        "transcript_length": len(derived["transcript"]),
        "integrity_finding_codes": sorted(
            finding["code"] for finding in derived["integrity_findings"]
        ),
    }
    if include_attempts:
        output["attempts_count"] = len(derived["attempts"])
    return output


def _evaluate_input(input_value, include_attempts=True):
    if "action" in input_value:
        parsed = parse_receipt_action(input_value["action"])
        if parsed is None:
            return None
        return {
            key: parsed[key]
            for key in ("kind", "state", "turn", "attempt_id")
        }

    if "payload" in input_value:
        parsed = parse_envelope(input_value["payload"])
        if parsed is None:
            return None
        return {
            "discussion_id": parsed["discussion_id"],
            "turn": parsed["turn"],
            "kind": parsed["kind"],
            "close": parsed["close"],
            "has_policy": "policy" in parsed,
        }

    derived = derive_discussion(
        input_value["discussion_id"],
        input_value["messages"],
        input_value["receipts"],
        input_value["now"],
    )
    return _project_derived(derived, include_attempts=include_attempts)


def _run_corpus(path, expected_sha256):
    with open(path, "rb") as handle:
        raw = _read_bounded(handle)
    actual_sha256 = hashlib.sha256(raw).hexdigest()
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha256 or ""):
        raise ValueError("expected sha256 must be 64 lowercase hex characters")
    if actual_sha256 != expected_sha256:
        raise ValueError(
            f"corpus sha256 mismatch: {actual_sha256} != {expected_sha256}"
        )
    corpus = _load_document(raw)
    if corpus.get("profile") != PROFILE:
        raise ValueError("unsupported profile")
    cases = corpus.get("cases")
    case_ids = _validate_cases(cases)

    failures = []
    for item in cases:
        actual = _evaluate_input(item["input"])
        expected = item["expected_output"]
        if actual != expected:
            failures.append(
                {"id": item["id"], "actual": actual, "expected": expected}
            )

    report = {
        "profile": PROFILE,
        "cases": len(cases),
        "corpus_sha256": actual_sha256,
        "case_ids": case_ids,
        "passed": not failures,
        "failures": failures,
    }
    print(json.dumps(report, sort_keys=True, separators=(",", ":")))
    return 0 if not failures else 1


def _evaluate_batch():
    document = _load_document(_read_bounded(sys.stdin.buffer))
    if document.get("profile") != PROFILE:
        raise ValueError("unsupported profile")
    cases = document.get("cases")
    _validate_cases(cases)

    outcomes = []
    seen_ids = set()
    for item in cases:
        case_id = item.get("id")
        if not isinstance(case_id, str) or not case_id or case_id in seen_ids:
            raise ValueError("case ids must be unique non-empty strings")
        seen_ids.add(case_id)
        outcomes.append(
            {
                "id": case_id,
                "output": _evaluate_input(
                    item["input"],
                    include_attempts=False,
                ),
            }
        )

    print(
        json.dumps(
            {"profile": PROFILE, "outcomes": outcomes},
            sort_keys=True,
            separators=(",", ":"),
        )
    )
    return 0


def main():
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--corpus")
    group.add_argument("--evaluate-json", action="store_true")
    parser.add_argument("--expected-sha256")
    args = parser.parse_args()

    try:
        if args.corpus:
            return _run_corpus(args.corpus, args.expected_sha256)
        return _evaluate_batch()
    except Exception as error:
        print(
            json.dumps(
                {
                    "profile": PROFILE,
                    "passed": False,
                    "error": f"{type(error).__name__}: {error}",
                    "failures": [],
                },
                sort_keys=True,
                separators=(",", ":"),
            )
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
