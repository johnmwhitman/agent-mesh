from __future__ import annotations

import copy
import pathlib
import sys

from evaluator import (
    PROFILE,
    ConformanceError,
    canonical,
    digest,
    evaluate_bytes,
    evaluate_scenario,
    parse_strict_json,
    projection,
)

ROOT = pathlib.Path(__file__).resolve().parent.parent


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def expect_error(raw: bytes | str, code: str, parse_only: bool = True) -> None:
    try:
        if parse_only:
            parse_strict_json(raw)
        else:
            evaluate_bytes(raw.encode("utf-8") if isinstance(raw, str) else raw)
    except ConformanceError as error:
        require(error.code == code, f"expected {code}, got {error.code}")
        return
    raise AssertionError(f"expected {code}, accepted input")


def base(**overrides):
    value = {
        "profile": PROFILE,
        "case_id": "control",
        "proposal": {
            "proposal_id": "p",
            "voters": ["a", "b"],
            "required_signoffs": [],
            "quorum": 1,
            "weights": {},
            "deadline": None,
            "silence_policy": "abstain",
        },
        "actions": [],
    }
    value.update(overrides)
    return value


def self_test():
    parser = [
        (b"\xc3\x28", "INVALID_UTF8"),
        ('{"a":1,"a":2}', "DUPLICATE_MEMBER"),
        ('{"a":1.0}', "NON_CANONICAL_INTEGER"),
        ('{"a":-0}', "NON_CANONICAL_INTEGER"),
        ('{"a":00}', "MALFORMED_JSON"),
        ('{"a":01}', "MALFORMED_JSON"),
        ('{"a":1.}', "MALFORMED_JSON"),
        ('{"a":1-2}', "MALFORMED_JSON"),
        ('{"a":1+2}', "MALFORMED_JSON"),
        ('{"a":9007199254740992}', "UNSAFE_INTEGER"),
        ('{"a":"\\ud800"}', "INVALID_UNICODE"),
        ("{", "MALFORMED_JSON"),
        (b" " * 131073, "SIZE_LIMIT"),
    ]
    for raw, code in parser:
        expect_error(raw, code)

    def proposal(**overrides):
        value = copy.deepcopy(base()["proposal"])
        value.update(overrides)
        return value

    controls = [
        (canonical(base(profile="wrong")), "PROFILE_REJECT"),
        (canonical(base(proposal=proposal(voters=["a", "a"]))), "DUPLICATE_VOTER"),
        (canonical(base(proposal=proposal(required_signoffs=["c"]))), "INVALID_SIGNOFF"),
        (canonical(base(proposal=proposal(weights={"c": 2}))), "INVALID_WEIGHT"),
        (canonical(base(proposal=proposal(weights={"a": 0}))), "INVALID_WEIGHT"),
        (canonical(base(proposal=proposal(quorum=3))), "INVALID_QUORUM"),
        (canonical(base(actions=[{"op": "resolve", "at": 2}, {"op": "resolve", "at": 1}])), "NON_MONOTONIC_TIME"),
        (canonical(base(actions=[{"op": "unknown", "at": 1}])), "INVALID_FIELD"),
    ]
    for raw, code in controls:
        expect_error(raw, code, False)

    result = evaluate_scenario(base(actions=[
        {"op": "vote", "at": 1, "receipt_id": "r1", "voter_id": "a", "seq": 0, "decision": "approve"},
        {"op": "vote", "at": 2, "receipt_id": "r1", "voter_id": "b", "seq": 0, "decision": "approve"},
        {"op": "vote", "at": 3, "receipt_id": "r2", "voter_id": "b", "seq": 2, "decision": "approve"},
    ]))
    for item in (entry for entry in result["command_results"] if not entry["accepted"]):
        require(item["pre_state_sha256"] == item["post_state_sha256"], "rejection mutated state")
    return {"ok": True, "parser_controls": len(parser), "validation_controls": len(controls), "mutation_controls": 2}


def run_corpus():
    corpus = parse_strict_json((ROOT / "corpus/v0.1/cases.json").read_bytes())
    require(corpus["profile"] == PROFILE, "corpus profile mismatch")
    receipts = []
    for item in corpus["cases"]:
        result = evaluate_scenario(item["scenario"])
        actual = projection(result)
        require(canonical(actual) == canonical(item["expect"]), f"projection mismatch for {item['id']}")
        for command in (entry for entry in result["command_results"] if not entry["accepted"]):
            require(
                command["pre_state_sha256"] == command["post_state_sha256"],
                f"rejected action mutated state in {item['id']}:{command['index']}",
            )
        receipts.append({"case_id": item["id"], "result_sha256": digest(result), "projection": actual})
    return {
        "ok": True,
        "profile": PROFILE,
        "corpus_sha256": digest(corpus),
        "mandatory_cases": sum(1 for item in corpus["cases"] if item["mandatory"]),
        "total_cases": len(corpus["cases"]),
        "receipts": receipts,
    }


try:
    output = self_test() if "--self-test" in sys.argv else run_corpus()
    print(canonical(output))
except Exception as error:
    print(f"{type(error).__name__}: {error}", file=sys.stderr)
    raise
