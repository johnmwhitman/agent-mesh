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

def expect_action_error(action, code: str) -> None:
    try:
        action()
    except ConformanceError as error:
        require(error.code == code, f"expected {code}, got {error.code}")
        return
    raise AssertionError(f"expected {code}, accepted input")


def version_range(minimum: str = "1.0.0", maximum: str | None = "2.0.0") -> dict:
    return {"min_inclusive": minimum, "max_exclusive": maximum}


def requirement() -> dict:
    return {
        "requester_label": "requester",
        "protocol": {"id": "mesh.a2a", "version_range": version_range()},
        "capabilities": [], "interaction_modes_any": [], "content_types_any": [],
        "tools": [], "extensions": {},
    }


def advertisement() -> dict:
    return {
        "advertiser_label": "advertiser", "completeness": "complete",
        "protocol": {"id": "mesh.a2a", "version": "1.0.0"},
        "capabilities": [], "interaction_modes": [], "content_types": [],
        "tools": [], "extensions": {},
    }


def scenario(**overrides) -> dict:
    value = {
        "profile": PROFILE, "case_id": "control",
        "requirement": requirement(), "advertisement": advertisement(),
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
    require("__proto__" in parse_strict_json('{"__proto__":null}'), "__proto__ was not preserved")
    expect_action_error(lambda: canonical(object()), "INVALID_SCENARIO")

    duplicate_requirement = requirement()
    duplicate_requirement["capabilities"] = [
        {"id": "x", "version_range": version_range()},
        {"id": "x", "version_range": version_range()},
    ]
    duplicate_advertisement = advertisement()
    duplicate_advertisement["tools"] = [
        {"id": "t", "version": "1.0.0", "input_schema_id": "in", "output_schema_id": "out"},
        {"id": "t", "version": "1.1.0", "input_schema_id": "in", "output_schema_id": "out"},
    ]
    invalid_range = requirement()
    invalid_range["protocol"]["version_range"] = version_range("2.0.0", "2.0.0")
    missing = scenario()
    del missing["advertisement"]
    oversized_label = scenario()
    oversized_label["requirement"]["requester_label"] = "x" * 257
    oversized_list = scenario()
    oversized_list["requirement"]["interaction_modes_any"] = [f"m{index}" for index in range(129)]
    validation_controls = [
        (scenario(profile="wrong"), "PROFILE_REJECT"),
        (missing, "MISSING_FIELD"),
        ({**scenario(), "extra": True}, "UNKNOWN_FIELD"),
        (scenario(requirement=duplicate_requirement), "DUPLICATE_ENTRY"),
        (scenario(advertisement=duplicate_advertisement), "DUPLICATE_ENTRY"),
        (scenario(requirement=invalid_range), "INVALID_VERSION_RANGE"),
        (scenario(advertisement={**advertisement(), "protocol": {"id": "mesh.a2a", "version": "01.0.0"}}), "INVALID_VERSION"),
        (scenario(advertisement={**advertisement(), "completeness": "unknown"}), "INVALID_FIELD"),
        (oversized_label, "LIMIT_EXCEEDED"),
        (oversized_list, "LIMIT_EXCEEDED"),
    ]
    for value, code in validation_controls:
        expect_error(canonical(value), code, False)

    required_capability = requirement()
    required_capability["capabilities"] = [{"id": "x", "version_range": version_range()}]
    complete_missing = evaluate_scenario(scenario(requirement=required_capability))
    partial_missing = evaluate_scenario(scenario(requirement=required_capability, advertisement={**advertisement(), "completeness": "partial"}))
    matching_advertisement = advertisement()
    matching_advertisement["capabilities"] = [{"id": "x", "version": "1.5.0"}]
    matching = evaluate_scenario(scenario(requirement=required_capability, advertisement=matching_advertisement))
    reordered = evaluate_scenario(scenario(requirement=required_capability, advertisement={**matching_advertisement, "capabilities": list(reversed(matching_advertisement["capabilities"]))}))
    max_label = scenario()
    max_label["requirement"]["requester_label"] = "x" * 256
    max_list = scenario()
    max_list["requirement"]["interaction_modes_any"] = [f"m{index}" for index in range(128)]
    max_list["advertisement"]["interaction_modes"] = list(max_list["requirement"]["interaction_modes_any"])
    require(complete_missing["result"] == "incompatible", "complete absence did not fail closed")
    require(partial_missing["result"] == "indeterminate", "partial absence was not indeterminate")
    require(matching["result"] == "compatible", "matching capability was not compatible")
    require(canonical(projection(matching)) == canonical(projection(reordered)), "set order changed projection")
    require(evaluate_scenario(max_label)["result"] == "compatible", "maximum label length was rejected")
    require(evaluate_scenario(max_list)["result"] == "compatible", "maximum list length was rejected")
    return {
        "ok": True, "profile": PROFILE, "parser_controls": len(parser_controls),
        "parser_accept_controls": len(parser_accept_controls), "canonical_controls": 1,
        "validation_controls": len(validation_controls), "semantic_controls": 6,
    }


def materialize(corpus: dict, item: dict) -> dict:
    require(item["requirement_ref"] in corpus["requirements"], f"unknown requirement_ref {item['requirement_ref']}")
    require(item["advertisement_ref"] in corpus["advertisements"], f"unknown advertisement_ref {item['advertisement_ref']}")
    output = {
        "profile": PROFILE, "case_id": item["id"],
        "requirement": copy.deepcopy(corpus["requirements"][item["requirement_ref"]]),
        "advertisement": copy.deepcopy(corpus["advertisements"][item["advertisement_ref"]]),
    }
    if item.get("requester_label"):
        output["requirement"]["requester_label"] = item["requester_label"]
    if item.get("advertiser_label"):
        output["advertisement"]["advertiser_label"] = item["advertiser_label"]
    return output


def run_corpus() -> dict:
    corpus = parse_strict_json((ROOT / "corpus/v0.1/cases.json").read_bytes())
    require(corpus["profile"] == PROFILE, "corpus profile mismatch")
    receipts = []
    for item in corpus["cases"]:
        result = evaluate_scenario(materialize(corpus, item))
        actual = projection(result)
        require(canonical(actual) == canonical(item["expect"]), f"projection mismatch for {item['id']}")
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

def validate_lines() -> list[str]:
    output = []
    for line in sys.stdin.read().splitlines():
        try:
            evaluate_bytes(line)
            output.append("OK")
        except ConformanceError as error:
            output.append(error.code)
    return output


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
