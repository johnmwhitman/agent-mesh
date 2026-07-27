from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any

PROFILE = "meshfleet.a2a.capability-compat.v0.1"
MAX_BYTES = 131072
MAX_DEPTH = 64
MAX_ENTRIES = 128
MAX_LABEL_BYTES = 256
MAX_SAFE_INTEGER = 9007199254740991
MAX_VERSION_COMPONENT = 999999
VERSION_RE = re.compile(r"^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$")


@dataclass
class ConformanceError(Exception):
    code: str
    message: str

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"


def reject(code: str, message: str) -> None:
    raise ConformanceError(code, message)


def valid_scalar_string(value: Any) -> bool:
    return isinstance(value, str) and not any(0xD800 <= ord(char) <= 0xDFFF for char in value)


def canonical(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int) and not isinstance(value, bool):
        if abs(value) > MAX_SAFE_INTEGER:
            reject("UNSAFE_INTEGER", "canonical value contains unsafe integer")
        return str(value)
    if isinstance(value, str):
        if not valid_scalar_string(value):
            reject("INVALID_UNICODE", "canonical value contains invalid Unicode")
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list):
        return "[" + ",".join(canonical(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(canonical(key) + ":" + canonical(value[key]) for key in sorted(value)) + "}"
    reject("INVALID_SCENARIO", "unsupported canonical value")


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def _pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    output: dict[str, Any] = {}
    for key, value in pairs:
        if key in output:
            reject("DUPLICATE_MEMBER", f"duplicate object member {key}")
        output[key] = value
    return output


def _integer(token: str) -> int:
    if token == "-0":
        reject("NON_CANONICAL_INTEGER", "negative zero is not canonical")
    value = int(token)
    if abs(value) > MAX_SAFE_INTEGER:
        reject("UNSAFE_INTEGER", "integer exceeds safe range")
    return value


def _non_integer(_: str) -> None:
    reject("NON_CANONICAL_INTEGER", "non-integer JSON number")


def _constant(_: str) -> None:
    reject("NON_CANONICAL_INTEGER", "non-finite JSON number")


def _depth(value: Any) -> int:
    if isinstance(value, list):
        return 1 + max((_depth(item) for item in value), default=0)
    if isinstance(value, dict):
        return 1 + max((_depth(item) for item in value.values()), default=0)
    return 0


def _validate_unicode(value: Any) -> None:
    if isinstance(value, str) and not valid_scalar_string(value):
        reject("INVALID_UNICODE", "string contains lone surrogate")
    if isinstance(value, list):
        for item in value:
            _validate_unicode(item)
    if isinstance(value, dict):
        for key, item in value.items():
            _validate_unicode(key)
            _validate_unicode(item)


def parse_strict_json(raw: bytes | str) -> Any:
    data = raw.encode("utf-8") if isinstance(raw, str) else bytes(raw)
    if len(data) > MAX_BYTES:
        reject("SIZE_LIMIT", "input exceeds byte limit")
    try:
        text = data.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        reject("INVALID_UTF8", "input is not valid UTF-8")
    try:
        value = json.loads(
            text,
            object_pairs_hook=_pairs,
            parse_int=_integer,
            parse_float=_non_integer,
            parse_constant=_constant,
        )
    except ConformanceError:
        raise
    except (json.JSONDecodeError, RecursionError):
        reject("MALFORMED_JSON", "malformed JSON")
    _validate_unicode(value)
    if _depth(value) > MAX_DEPTH:
        reject("DEPTH_LIMIT", "JSON nesting is too deep")
    return value


def exact_fields(value: Any, required: list[str], context: str) -> None:
    if not isinstance(value, dict):
        reject("INVALID_FIELD", f"{context} must be an object")
    allowed = set(required)
    for field in required:
        if field not in value:
            reject("MISSING_FIELD", f"{context}.{field} is required")
    for field in value:
        if field not in allowed:
            reject("UNKNOWN_FIELD", f"{context}.{field} is unknown")


def label(value: Any, context: str) -> None:
    if not valid_scalar_string(value) or len(value) == 0:
        reject("INVALID_FIELD", f"{context} must be a non-empty scalar string")
    if len(value.encode("utf-8")) > MAX_LABEL_BYTES:
        reject("LIMIT_EXCEEDED", f"{context} is too long")


def label_list(value: Any, context: str) -> None:
    if not isinstance(value, list):
        reject("INVALID_FIELD", f"{context} must be an array")
    if len(value) > MAX_ENTRIES:
        reject("LIMIT_EXCEEDED", f"{context} is too large")
    seen: set[str] = set()
    for index, item in enumerate(value):
        label(item, f"{context}[{index}]")
        if item in seen:
            reject("DUPLICATE_ENTRY", f"{context} contains duplicate labels")
        seen.add(item)


def parse_version(value: Any, context: str = "version") -> tuple[int, int, int]:
    if not isinstance(value, str):
        reject("INVALID_VERSION", f"{context} must be a string")
    match = VERSION_RE.fullmatch(value)
    if match is None:
        reject("INVALID_VERSION", f"{context} is outside the frozen grammar")
    parts = tuple(int(part) for part in match.groups())
    if any(part > MAX_VERSION_COMPONENT for part in parts):
        reject("INVALID_VERSION", f"{context} component exceeds limit")
    return parts


def validate_range(value: Any, context: str) -> None:
    exact_fields(value, ["min_inclusive", "max_exclusive"], context)
    minimum = parse_version(value["min_inclusive"], f"{context}.min_inclusive")
    if value["max_exclusive"] is not None:
        maximum = parse_version(value["max_exclusive"], f"{context}.max_exclusive")
        if minimum >= maximum:
            reject("INVALID_VERSION_RANGE", f"{context} must be non-empty")


def in_range(version: str, version_range: dict[str, Any]) -> bool:
    candidate = parse_version(version)
    minimum = parse_version(version_range["min_inclusive"])
    if candidate < minimum:
        return False
    if version_range["max_exclusive"] is None:
        return True
    return candidate < parse_version(version_range["max_exclusive"])


def range_text(version_range: dict[str, Any]) -> str:
    if version_range["max_exclusive"] is None:
        return f">={version_range['min_inclusive']}"
    return f">={version_range['min_inclusive']} <{version_range['max_exclusive']}"


def capability_entries(value: Any, context: str, requirement: bool) -> None:
    if not isinstance(value, list):
        reject("INVALID_FIELD", f"{context} must be an array")
    if len(value) > MAX_ENTRIES:
        reject("LIMIT_EXCEEDED", f"{context} is too large")
    seen: set[str] = set()
    version_field = "version_range" if requirement else "version"
    for index, entry in enumerate(value):
        item_context = f"{context}[{index}]"
        exact_fields(entry, ["id", version_field], item_context)
        label(entry["id"], f"{item_context}.id")
        if entry["id"] in seen:
            reject("DUPLICATE_ENTRY", f"{context} contains duplicate id {entry['id']}")
        seen.add(entry["id"])
        validate_range(entry[version_field], f"{item_context}.{version_field}") if requirement else parse_version(entry[version_field], f"{item_context}.{version_field}")


def tool_entries(value: Any, context: str, requirement: bool) -> None:
    if not isinstance(value, list):
        reject("INVALID_FIELD", f"{context} must be an array")
    if len(value) > MAX_ENTRIES:
        reject("LIMIT_EXCEEDED", f"{context} is too large")
    seen: set[str] = set()
    version_field = "version_range" if requirement else "version"
    for index, entry in enumerate(value):
        item_context = f"{context}[{index}]"
        exact_fields(entry, ["id", version_field, "input_schema_id", "output_schema_id"], item_context)
        for field in ("id", "input_schema_id", "output_schema_id"):
            label(entry[field], f"{item_context}.{field}")
        if entry["id"] in seen:
            reject("DUPLICATE_ENTRY", f"{context} contains duplicate id {entry['id']}")
        seen.add(entry["id"])
        validate_range(entry[version_field], f"{item_context}.{version_field}") if requirement else parse_version(entry[version_field], f"{item_context}.{version_field}")


def validate_scenario(scenario: Any) -> dict[str, Any]:
    exact_fields(scenario, ["profile", "case_id", "requirement", "advertisement"], "scenario")
    if scenario["profile"] != PROFILE:
        reject("PROFILE_REJECT", "unsupported profile")
    label(scenario["case_id"], "scenario.case_id")
    requirement = scenario["requirement"]
    exact_fields(requirement, ["requester_label", "protocol", "capabilities", "interaction_modes_any", "content_types_any", "tools", "extensions"], "requirement")
    label(requirement["requester_label"], "requirement.requester_label")
    exact_fields(requirement["protocol"], ["id", "version_range"], "requirement.protocol")
    label(requirement["protocol"]["id"], "requirement.protocol.id")
    validate_range(requirement["protocol"]["version_range"], "requirement.protocol.version_range")
    capability_entries(requirement["capabilities"], "requirement.capabilities", True)
    label_list(requirement["interaction_modes_any"], "requirement.interaction_modes_any")
    label_list(requirement["content_types_any"], "requirement.content_types_any")
    tool_entries(requirement["tools"], "requirement.tools", True)
    if not isinstance(requirement["extensions"], dict):
        reject("INVALID_FIELD", "requirement.extensions must be an object")

    advertisement = scenario["advertisement"]
    exact_fields(advertisement, ["advertiser_label", "completeness", "protocol", "capabilities", "interaction_modes", "content_types", "tools", "extensions"], "advertisement")
    label(advertisement["advertiser_label"], "advertisement.advertiser_label")
    if advertisement["completeness"] not in ("complete", "partial"):
        reject("INVALID_FIELD", "advertisement.completeness is invalid")
    exact_fields(advertisement["protocol"], ["id", "version"], "advertisement.protocol")
    label(advertisement["protocol"]["id"], "advertisement.protocol.id")
    parse_version(advertisement["protocol"]["version"], "advertisement.protocol.version")
    capability_entries(advertisement["capabilities"], "advertisement.capabilities", False)
    label_list(advertisement["interaction_modes"], "advertisement.interaction_modes")
    label_list(advertisement["content_types"], "advertisement.content_types")
    tool_entries(advertisement["tools"], "advertisement.tools", False)
    if not isinstance(advertisement["extensions"], dict):
        reject("INVALID_FIELD", "advertisement.extensions must be an object")
    return scenario


def fact(code: str, path: str, expected: str | None, actual: str | None, certainty: str) -> dict[str, Any]:
    return {"code": code, "path": path, "expected": expected, "actual": actual, "certainty": certainty}


def sorted_intersection(left: list[str], right: list[str]) -> list[str]:
    right_set = set(right)
    return sorted(item for item in left if item in right_set)


def evaluate_scenario(input_value: Any) -> dict[str, Any]:
    scenario = validate_scenario(input_value)
    requirement = scenario["requirement"]
    advertisement = scenario["advertisement"]
    partial = advertisement["completeness"] == "partial"
    mismatches: list[dict[str, Any]] = []
    matched_capabilities: list[str] = []
    matched_tools: list[str] = []

    if requirement["protocol"]["id"] != advertisement["protocol"]["id"]:
        mismatches.append(fact("PROTOCOL_ID_MISMATCH", "advertisement.protocol.id", requirement["protocol"]["id"], advertisement["protocol"]["id"], "definite"))
    if not in_range(advertisement["protocol"]["version"], requirement["protocol"]["version_range"]):
        mismatches.append(fact("PROTOCOL_VERSION_MISMATCH", "advertisement.protocol.version", range_text(requirement["protocol"]["version_range"]), advertisement["protocol"]["version"], "definite"))

    advertised_capabilities = {entry["id"]: entry for entry in advertisement["capabilities"]}
    for required in requirement["capabilities"]:
        advertised = advertised_capabilities.get(required["id"])
        if advertised is None:
            mismatches.append(fact(
                "CAPABILITY_UNDECLARED" if partial else "CAPABILITY_MISSING",
                "advertisement.capabilities", required["id"], None,
                "unknown" if partial else "definite",
            ))
        elif not in_range(advertised["version"], required["version_range"]):
            mismatches.append(fact(
                "CAPABILITY_VERSION_MISMATCH", f"advertisement.capabilities[{required['id']}].version",
                range_text(required["version_range"]), advertised["version"], "definite",
            ))
        else:
            matched_capabilities.append(required["id"])

    matched_modes = sorted_intersection(requirement["interaction_modes_any"], advertisement["interaction_modes"])
    if requirement["interaction_modes_any"] and not matched_modes:
        mismatches.append(fact(
            "INTERACTION_MODE_UNDECLARED" if partial else "INTERACTION_MODE_MISSING",
            "advertisement.interaction_modes",
            ",".join(sorted(requirement["interaction_modes_any"])),
            ",".join(sorted(advertisement["interaction_modes"])),
            "unknown" if partial else "definite",
        ))

    matched_content_types = sorted_intersection(requirement["content_types_any"], advertisement["content_types"])
    if requirement["content_types_any"] and not matched_content_types:
        mismatches.append(fact(
            "CONTENT_TYPE_UNDECLARED" if partial else "CONTENT_TYPE_MISSING",
            "advertisement.content_types",
            ",".join(sorted(requirement["content_types_any"])),
            ",".join(sorted(advertisement["content_types"])),
            "unknown" if partial else "definite",
        ))

    advertised_tools = {entry["id"]: entry for entry in advertisement["tools"]}
    for required in requirement["tools"]:
        advertised = advertised_tools.get(required["id"])
        if advertised is None:
            mismatches.append(fact(
                "TOOL_UNDECLARED" if partial else "TOOL_MISSING",
                "advertisement.tools", required["id"], None,
                "unknown" if partial else "definite",
            ))
            continue
        matched = True
        if not in_range(advertised["version"], required["version_range"]):
            mismatches.append(fact("TOOL_VERSION_MISMATCH", f"advertisement.tools[{required['id']}].version", range_text(required["version_range"]), advertised["version"], "definite"))
            matched = False
        if advertised["input_schema_id"] != required["input_schema_id"]:
            mismatches.append(fact("TOOL_INPUT_SCHEMA_MISMATCH", f"advertisement.tools[{required['id']}].input_schema_id", required["input_schema_id"], advertised["input_schema_id"], "definite"))
            matched = False
        if advertised["output_schema_id"] != required["output_schema_id"]:
            mismatches.append(fact("TOOL_OUTPUT_SCHEMA_MISMATCH", f"advertisement.tools[{required['id']}].output_schema_id", required["output_schema_id"], advertised["output_schema_id"], "definite"))
            matched = False
        if matched:
            matched_tools.append(required["id"])

    mismatches.sort(key=lambda item: tuple(item[field] or "" for field in ("code", "path", "expected", "actual", "certainty")))
    reasons = sorted(set(item["code"] for item in mismatches))
    result = "incompatible" if any(item["certainty"] == "definite" for item in mismatches) else "indeterminate" if mismatches else "compatible"
    return {
        "profile": PROFILE,
        "case_id": scenario["case_id"],
        "result": result,
        "reasons": reasons,
        "mismatches": mismatches,
        "normalized": {
            "requester_label": requirement["requester_label"],
            "advertiser_label": advertisement["advertiser_label"],
            "matched_capability_ids": sorted(matched_capabilities),
            "matched_interaction_modes": matched_modes,
            "matched_content_types": matched_content_types,
            "matched_tool_ids": sorted(matched_tools),
        },
        "input_sha256": digest(scenario),
    }


def evaluate_bytes(raw: bytes | str) -> dict[str, Any]:
    return evaluate_scenario(parse_strict_json(raw))


def projection(result: dict[str, Any]) -> dict[str, Any]:
    return {
        "case_id": result["case_id"],
        "result": result["result"],
        "reasons": result["reasons"],
        "mismatch_facts": [
            "|".join([
                item["code"], item["path"], item["expected"] or "",
                item["actual"] or "", item["certainty"],
            ])
            for item in result["mismatches"]
        ],
        "requester_label": result["normalized"]["requester_label"],
        "advertiser_label": result["normalized"]["advertiser_label"],
        "matched_capability_ids": result["normalized"]["matched_capability_ids"],
        "matched_interaction_modes": result["normalized"]["matched_interaction_modes"],
        "matched_content_types": result["normalized"]["matched_content_types"],
        "matched_tool_ids": result["normalized"]["matched_tool_ids"],
    }
