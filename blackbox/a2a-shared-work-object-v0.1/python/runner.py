from __future__ import annotations

import base64
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
        parse_strict_json(raw) if parse_only else evaluate_bytes(raw)
    except ConformanceError as error:
        require(error.code == code, f"expected {code}, got {error.code}")
        return
    raise AssertionError(f"expected {code}, accepted input")


def expect_action_error(action, code: str) -> None:
    try:
        action()
    except ConformanceError as error:
        require(error.code == code, f"expected {code}, got {error.code}")
        return
    raise AssertionError(f"expected {code}, accepted input")


def initial() -> dict:
    return {"object_id": "work-1", "revision": 0, "status": "draft", "fields": {}, "notes": []}


def set_field(operation_id: str, actor: str, revision: int, field: str, value) -> dict:
    return {
        "operation_id": operation_id, "actor_label": actor, "expected_revision": revision,
        "kind": "set_field", "field": field, "value": value,
    }


def scenario(operations=None, initial_value=None, **overrides) -> dict:
    value = {
        "profile": PROFILE, "case_id": "control",
        "initial": initial() if initial_value is None else initial_value,
        "operations": [] if operations is None else operations,
    }
    value.update(overrides)
    return value


def self_test() -> dict:
    parser_controls = [
        (bytes([0xC3, 0x28]), "INVALID_UTF8"),
        ('{"a":1,"a":2}', "DUPLICATE_MEMBER"),
        ('{"a":1.0}', "NON_CANONICAL_INTEGER"),
        ('{"a":1e2}', "NON_CANONICAL_INTEGER"),
        ('{"a":1.}', "MALFORMED_JSON"),
        ('{"a":1e}', "MALFORMED_JSON"),
        ('{"a":-0}', "NON_CANONICAL_INTEGER"),
        ('{"a":9007199254740992}', "UNSAFE_INTEGER"),
        ('{"a":"\\ud800"}', "INVALID_UNICODE"),
        ('{"a":"\ud800"}', "INVALID_UNICODE"),
        ("{", "MALFORMED_JSON"),
        ("", "MALFORMED_JSON"),
        ('{"a":01}', "MALFORMED_JSON"),
        ('{"a":+1}', "MALFORMED_JSON"),
        ("[" * 65 + "0" + "]" * 65, "DEPTH_LIMIT"),
        (b" " * 131073, "SIZE_LIMIT"),
    ]
    for raw, code in parser_controls:
        expect_error(raw, code)
    parser_accept_controls = [
        b"0" + b" " * 131071,
        "[" * 63 + "0" + "]" * 63,
        '{"__proto__":null}',
    ]
    for raw in parser_accept_controls:
        parse_strict_json(raw)
    require("__proto__" in parse_strict_json('{"__proto__":null}'), "hostile member was lost")
    expect_action_error(lambda: canonical(object()), "INVALID_SCENARIO")

    missing = scenario()
    del missing["initial"]
    duplicate_notes = initial()
    duplicate_notes["notes"] = [
        {"note_id": "n", "actor_label": "a", "body": "one"},
        {"note_id": "n", "actor_label": "b", "body": "two"},
    ]
    oversized_fields = initial()
    oversized_fields["fields"] = {f"f{index}": index for index in range(129)}
    oversized_notes = initial()
    oversized_notes["notes"] = [
        {"note_id": f"n{index}", "actor_label": "a", "body": ""}
        for index in range(129)
    ]
    validation_controls = [
        (scenario(profile="wrong"), "PROFILE_REJECT"),
        (missing, "MISSING_FIELD"),
        ({**scenario(), "extra": True}, "UNKNOWN_FIELD"),
        (scenario(initial_value={**initial(), "status": "unknown"}), "INVALID_FIELD"),
        (scenario([{"operation_id": "x", "actor_label": "a", "expected_revision": 0, "kind": "unknown"}]), "INVALID_OPERATION"),
        (scenario([set_field("", "a", 0, "x", 1)]), "INVALID_FIELD"),
        (scenario([set_field("x", "a", -1, "x", 1)]), "INVALID_FIELD"),
        (scenario(initial_value=duplicate_notes), "DUPLICATE_ENTRY"),
        (scenario([set_field(f"o{index}", "a", 0, "x", index) for index in range(257)]), "LIMIT_EXCEEDED"),
        (scenario(initial_value={**initial(), "object_id": "é" * 129}), "LIMIT_EXCEEDED"),
        (scenario(initial_value=oversized_fields), "LIMIT_EXCEEDED"),
        (scenario(initial_value=oversized_notes), "LIMIT_EXCEEDED"),
        (scenario([{
            "operation_id": "x", "actor_label": "a", "expected_revision": 0,
            "kind": "append_note", "note_id": "n", "body": "x" * 4097,
        }]), "LIMIT_EXCEEDED"),
    ]
    for value, code in validation_controls:
        expect_error(canonical(value), code, False)
    max_fields = initial()
    max_fields["fields"] = {f"f{index}": index for index in range(128)}
    max_notes = initial()
    max_notes["notes"] = [
        {"note_id": f"n{index}", "actor_label": "a", "body": ""}
        for index in range(128)
    ]
    validation_accept_controls = [
        scenario(initial_value={**initial(), "object_id": "é" * 128}),
        scenario(initial_value=max_fields),
        scenario(initial_value=max_notes),
        scenario([{
            "operation_id": "x", "actor_label": "a", "expected_revision": 0,
            "kind": "append_note", "note_id": "n", "body": "x" * 4096,
        }]),
        scenario([{
            "operation_id": f"o{index}", "actor_label": "a", "expected_revision": 0,
            "kind": "remove_field", "field": "x",
        } for index in range(256)]),
    ]
    for value in validation_accept_controls:
        evaluate_scenario(value)

    first = set_field("op-1", "a", 0, "title", "alpha")
    competing = set_field("op-2", "b", 0, "title", "beta")
    result = evaluate_scenario(scenario([first, competing]))
    require(result["state"]["fields"]["title"] == "alpha" and result["state"]["revision"] == 1, "stale conflict mutated state")
    require(result["outcomes"][1]["code"] == "STALE_REVISION", "stale conflict code drift")
    replay = evaluate_scenario(scenario([first, dict(first)]))
    require(replay["outcomes"][1]["disposition"] == "idempotent", "exact replay was not idempotent")
    conflict = evaluate_scenario(scenario([first, {**first, "value": "beta"}]))
    require(conflict["outcomes"][1]["code"] == "OPERATION_ID_CONFLICT", "ID conflict precedence drift")
    finalized = evaluate_scenario(scenario([
        {"operation_id": "f", "actor_label": "a", "expected_revision": 0, "kind": "finalize"},
        set_field("late", "b", 0, "title", "late"),
    ]))
    require(finalized["outcomes"][1]["code"] == "OBJECT_FINAL", "final did not dominate stale revision")
    original = scenario([set_field("op", "a", 0, "__proto__", {"nested": True})])
    before = canonical(original)
    hostile = evaluate_scenario(original)
    require(canonical(original) == before, "input was mutated")
    require("__proto__" in hostile["state"]["fields"], "hostile field key was lost")
    left = evaluate_scenario(scenario([
        set_field("a", "a", 0, "left", 1),
        set_field("b", "b", 1, "right", 2),
    ]))
    right = evaluate_scenario(scenario([
        set_field("b", "b", 0, "right", 2),
        set_field("a", "a", 1, "left", 1),
    ]))
    require(canonical(left["state"]) == canonical(right["state"]), "independent fields did not converge")
    return {
        "ok": True, "profile": PROFILE,
        "parser_controls": len(parser_controls),
        "parser_accept_controls": len(parser_accept_controls),
        "canonical_controls": 1,
        "validation_controls": len(validation_controls),
        "validation_accept_controls": len(validation_accept_controls),
        "semantic_controls": 8,
    }


def run_corpus() -> dict:
    corpus = parse_strict_json((ROOT / "corpus/v0.1/cases.json").read_bytes())
    require(corpus["profile"] == PROFILE, "corpus profile mismatch")
    receipts = []
    for item in corpus["cases"]:
        require(item["scenario"]["case_id"] == item["id"], f"case ID mismatch for {item['id']}")
        result = evaluate_scenario(item["scenario"])
        actual = projection(result)
        require(canonical(actual) == canonical(item["expect"]), f"projection mismatch for {item['id']}")
        receipts.append({"case_id": item["id"], "result_sha256": digest(result), "projection": actual})
    return {
        "ok": True, "profile": PROFILE, "corpus_sha256": digest(corpus),
        "mandatory_cases": sum(item["mandatory"] for item in corpus["cases"]),
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


def validate_lines() -> list[str]:
    output = []
    for line in sys.stdin.read().splitlines():
        try:
            evaluate_bytes(line)
            output.append("OK")
        except ConformanceError as error:
            output.append(error.code)
    return output


def evaluate_lines() -> list[dict]:
    return [evaluate_bytes(line) for line in sys.stdin.read().splitlines() if line]


try:
    if "--classify-base64-lines" in sys.argv:
        output = classify_lines()
    elif "--validate-lines" in sys.argv:
        output = validate_lines()
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
