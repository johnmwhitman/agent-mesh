from __future__ import annotations

import base64
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

# Byte-differential contract: stdout is UTF-8 with "\n" newlines on every platform. Without
# this, a cp1252 console (the Windows default) raises UnicodeEncodeError on corpus content --
# measured under PYTHONIOENCODING=cp1252 on 2026-08-02 -- and Windows text-mode newline
# translation would emit \r\n bytes the JavaScript side of the differential never emits.
# PYTHONIOENCODING outranks this only if set to a non-UTF-8 value deliberately; the runner
# pins its own contract rather than trusting the console.
sys.stdout.reconfigure(encoding="utf-8", newline="\n")


ROOT = pathlib.Path(__file__).resolve().parent.parent


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def expect_error(raw: bytes | str, code: str, parse_only: bool = True) -> None:
    try:
        parse_strict_json(raw) if parse_only else evaluate_bytes(raw)
    except ConformanceError as error:
        require(error.code == code, f"expected {code}, got {error.code}")
        return
    raise AssertionError(f"expected {code}, accepted input")


def base_policy() -> dict:
    return {
        "namespace": "mesh.demo", "snapshot_id": "snapshot-control", "revocation_epoch": 2,
        "rules": [{
            "rule_id": "allow", "effect": "allow", "principal": "alice",
            "resource": "doc", "action": "read", "required_capabilities": [],
            "not_before": None, "expires_at": None,
        }],
    }


def base_scenario(**overrides) -> dict:
    value = {"profile": PROFILE, "case_id": "control", "policy": base_policy(), "actions": []}
    value.update(overrides)
    return value


def self_test() -> dict:
    parser_controls = [
        (bytes([0xC3, 0x28]), "INVALID_UTF8"),
        ('{"a":1,"a":2}', "DUPLICATE_MEMBER"),
        ('{"a":1.0}', "NON_CANONICAL_INTEGER"),
        ('{"a":1e2}', "NON_CANONICAL_INTEGER"),
        ('{"a":-0}', "NON_CANONICAL_INTEGER"),
        ('{"a":9007199254740992}', "UNSAFE_INTEGER"),
        ('{"a":"\\ud800"}', "INVALID_UNICODE"),
        ("{", "MALFORMED_JSON"),
        ("", "MALFORMED_JSON"),
        ('{"a":01}', "MALFORMED_JSON"),
        ('{"a":+1}', "MALFORMED_JSON"),
        ("[" * 65 + "0" + "]" * 65, "DEPTH_LIMIT"),
        (b" " * 131073, "SIZE_LIMIT"),
    ]
    for raw, code in parser_controls:
        expect_error(raw, code)

    action = {
        "request_id": "q1", "nonce": "n1", "namespace": "mesh.demo",
        "principal": "alice", "resource": "doc", "action": "read",
        "capabilities": [], "policy_epoch": 2, "at": 1,
    }
    missing_nonce = dict(action)
    del missing_nonce["nonce"]
    duplicate_rules = base_policy()
    duplicate_rules["rules"].append(copy.deepcopy(duplicate_rules["rules"][0]))
    duplicate_rule_caps = base_policy()
    duplicate_rule_caps["rules"][0]["required_capabilities"] = ["x", "x"]
    invalid_window = base_policy()
    invalid_window["rules"][0].update({"not_before": 2, "expires_at": 2})
    validation_controls = [
        (base_scenario(profile="wrong"), "PROFILE_REJECT"),
        (base_scenario(policy=duplicate_rules), "DUPLICATE_RULE"),
        (base_scenario(policy=duplicate_rule_caps), "DUPLICATE_CAPABILITY"),
        (base_scenario(actions=[{**action, "capabilities": ["x", "x"]}]), "DUPLICATE_CAPABILITY"),
        (base_scenario(actions=[missing_nonce]), "MISSING_FIELD"),
        (base_scenario(actions=[{**action, "extra": True}]), "UNKNOWN_FIELD"),
        (base_scenario(actions=[{**action, "nonce": ""}]), "INVALID_FIELD"),
        (base_scenario(policy=invalid_window), "INVALID_FIELD"),
    ]
    for value, code in validation_controls:
        expect_error(canonical(value), code, False)

    mutation = base_scenario(actions=[
        action,
        {**action, "request_id": "conflict"},
        action,
        {**action, "request_id": "future", "nonce": "n2", "policy_epoch": 3},
    ])
    result = evaluate_scenario(mutation)
    for item in (entry for entry in result["command_results"] if entry["outcome"] != "decided"):
        require(item["pre_state_sha256"] == item["post_state_sha256"], f"{item['outcome']} action mutated state")
    require(len(result["receipts"]) == 1, "replay rejection or future epoch consumed nonce")
    return {
        "ok": True, "profile": PROFILE, "parser_controls": len(parser_controls),
        "validation_controls": len(validation_controls), "mutation_controls": 3,
    }


def materialize(corpus: dict, item: dict) -> dict:
    require(item["policy_ref"] in corpus["policies"], f"unknown policy_ref {item['policy_ref']}")
    return {
        "profile": PROFILE, "case_id": item["id"],
        "policy": copy.deepcopy(corpus["policies"][item["policy_ref"]]),
        "actions": copy.deepcopy(item["actions"]),
    }


def run_corpus() -> dict:
    corpus = parse_strict_json((ROOT / "corpus/v0.1/cases.json").read_bytes())
    require(corpus["profile"] == PROFILE, "corpus profile mismatch")
    receipts = []
    for item in corpus["cases"]:
        result = evaluate_scenario(materialize(corpus, item))
        actual = projection(result)
        require(canonical(actual) == canonical(item["expect"]), f"projection mismatch for {item['id']}")
        for command in result["command_results"]:
            if command["outcome"] != "decided":
                require(
                    command["pre_state_sha256"] == command["post_state_sha256"],
                    f"non-mutating action changed state in {item['id']}:{command['index']}",
                )
        receipts.append({"case_id": item["id"], "result_sha256": digest(result), "projection": actual})
    return {
        "ok": True, "profile": PROFILE, "corpus_sha256": digest(corpus),
        "mandatory_cases": sum(1 for item in corpus["cases"] if item["mandatory"]),
        "total_cases": len(corpus["cases"]), "receipts": receipts,
    }


def classify_lines() -> list[str]:
    output = []
    for line in sys.stdin.read().splitlines():
        try:
            parse_strict_json(base64.b64decode(line))
            output.append("OK")
        except ConformanceError as error:
            output.append(error.code)
    return output


def evaluate_lines() -> list[dict]:
    return [evaluate_bytes(line) for line in sys.stdin.read().splitlines() if line]


try:
    if "--classify-base64-lines" in sys.argv:
        output = classify_lines()
    elif "--evaluate-lines" in sys.argv:
        output = evaluate_lines()
    elif "--self-test" in sys.argv:
        output = self_test()
    else:
        output = run_corpus()
    print(canonical(output))
except Exception as error:
    print(f"{type(error).__name__}: {error}", file=sys.stderr)
    raise
