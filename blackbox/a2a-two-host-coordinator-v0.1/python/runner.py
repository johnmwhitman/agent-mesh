from __future__ import annotations

import base64
import copy
import hashlib
import json
import sys
from pathlib import Path

from evaluator import (
    PROFILE,
    ProfileError,
    canonical_json,
    evaluate_two_host_scenario,
    evaluate_two_host_scenario_bytes,
    project_result,
    sha256,
)

ROOT = Path(__file__).resolve().parents[1]
CORPUS_TEXT = (ROOT / "corpus/v0.1/cases.json").read_text(encoding="utf-8")
CONTRACT_TEXT = (ROOT / "contract.json").read_text(encoding="utf-8")
CORPUS = json.loads(CORPUS_TEXT)
CONTRACT = json.loads(CONTRACT_TEXT)


def scenario_raw(test_case: dict) -> str:
    return canonical_json({
        "profile": PROFILE,
        "scenario_id": test_case["id"].lower(),
        "work_id": "work-1",
        "commands": test_case["commands"],
    })


def initial_digest() -> str:
    return sha256({
        "authority": None,
        "events": [],
        "hosts": [
            {"host_id": "host-a", "reachable": True, "token": None},
            {"host_id": "host-b", "reachable": True, "token": None},
        ],
    })


def assert_equal(actual, expected, label: str) -> None:
    if canonical_json(actual) != canonical_json(expected):
        raise AssertionError(f"{label}: expected {canonical_json(expected)} got {canonical_json(actual)}")


def assert_runtime_invariants(result: dict, label: str) -> None:
    for index, event in enumerate(result["events"]):
        if event["seq"] != index + 1 or event["event_id"] != f"event-{index + 1}":
            raise AssertionError(f"{label}: non-dense event sequence")
    previous_digest = initial_digest()
    for command in result["command_results"]:
        if command["error"] is not None and command["state_sha256"] != previous_digest:
            raise AssertionError(f"{label}: rejection {command['error']} mutated state")
        previous_digest = command["state_sha256"]
    if result["authority"] is not None:
        epochs = [attempt["owner_epoch"] for attempt in result["authority"]["attempts"]]
        for index in range(1, len(epochs)):
            if epochs[index] <= epochs[index - 1]:
                raise AssertionError(f"{label}: attempt epochs are not strictly increasing")


def execute_case(test_case: dict) -> dict:
    result = evaluate_two_host_scenario(scenario_raw(test_case))
    assert_equal(project_result(result), test_case["expected"], test_case["id"])
    assert_runtime_invariants(result, test_case["id"])
    return result


def control_input(control: dict) -> str | bytes:
    if "raw_base64" in control:
        return base64.b64decode(control["raw_base64"], validate=True)
    if "nested_array_depth" in control:
        depth = control["nested_array_depth"]
        return "[" * depth + "0" + "]" * depth
    return control["raw"]


def control_input_sha256(value: str | bytes) -> str:
    encoded = value if isinstance(value, bytes) else value.encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def capture_error(control: dict) -> dict:
    value = control_input(control)
    try:
        if isinstance(value, bytes):
            evaluate_two_host_scenario_bytes(value)
        else:
            evaluate_two_host_scenario(value)
    except ProfileError as error:
        if error.code != control["error_code"]:
            raise
        if "error_path" in control and error.path != control["error_path"]:
            raise AssertionError(f"{control['id']}: expected path {control['error_path']} got {error.path}")
        return {
            "error_code": error.code,
            "error_path": error.path,
            "id": control["id"],
            "input_sha256": control_input_sha256(value),
        }
    raise AssertionError(f"{control['id']}: expected {control['error_code']}")


def mutation_detected(test_case: dict) -> bool:
    result = evaluate_two_host_scenario(scenario_raw(test_case))
    mutated = copy.deepcopy(test_case["expected"])
    mutated["owner_epoch"] = 0 if mutated["owner_epoch"] is None else mutated["owner_epoch"] + 1
    try:
        assert_equal(project_result(result), mutated, f"{test_case['id']}-mutation")
    except AssertionError:
        return True
    return False


def canonical_controls() -> int:
    actual = canonical_json({"\uE000": 2, "\U00010000": 1, "10": 10, "2": 2})
    expected = "{\"10\":10,\"2\":2,\"\":2,\"𐀀\":1}"
    if actual != expected:
        raise AssertionError(f"code-point canonical order mismatch: {actual}")
    return 1


if CORPUS["profile"] != PROFILE or CONTRACT["profile"] != PROFILE:
    raise AssertionError("profile mismatch")
mandatory = [case["id"] for case in CORPUS["cases"] if case["tier"] == "mandatory"]
assert_equal(mandatory, CONTRACT["mandatory_case_ids"], "mandatory case registry")

records = []
for test_case in CORPUS["cases"]:
    output = execute_case(test_case)
    bound = {"case_id": test_case["id"], "output": output}
    records.append({**bound, "receipt_sha256": sha256(bound)})
controls = [
    capture_error(control)
    for control in CORPUS["validation_controls"] + CORPUS["parser_controls"]
]
assert_equal(
    sorted({control["error_code"] for control in controls}),
    sorted(CONTRACT["validation_errors"]),
    "closed validation error coverage",
)
for test_case in CORPUS["cases"]:
    if not mutation_detected(test_case):
        raise AssertionError(f"{test_case['id']}: expectation mutation survived")
canonical_control_count = canonical_controls()

if "--emit-transcript" in sys.argv:
    print(canonical_json({"cases": records, "controls": controls, "profile": PROFILE}))
else:
    print(canonical_json({
        "profile": PROFILE,
        "implementation": "python",
        "case_count": len(CORPUS["cases"]),
        "mandatory_count": len(mandatory),
        "supplemental_count": len(CORPUS["cases"]) - len(mandatory),
        "validation_controls": len(CORPUS["validation_controls"]),
        "parser_controls": len(CORPUS["parser_controls"]),
        "validation_error_codes_covered": len({control["error_code"] for control in controls}),
        "mutation_controls": len(CORPUS["cases"]),
        "canonical_controls": canonical_control_count,
        "passed": len(CORPUS["cases"]),
        "failed": 0,
        "contract_sha256": sha256(CONTRACT_TEXT),
        "corpus_sha256": sha256(CORPUS_TEXT),
        "transcript_sha256": sha256(records),
    }))
