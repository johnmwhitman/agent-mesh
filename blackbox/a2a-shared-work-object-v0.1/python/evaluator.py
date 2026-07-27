from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any

PROFILE = "meshfleet.a2a.shared-work-object.v0.1"
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
    reject("MALFORMED_JSON", "invalid JSON constant")


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
    try:
        data = raw.encode("utf-8") if isinstance(raw, str) else bytes(raw)
    except UnicodeEncodeError:
        reject("INVALID_UNICODE", "input string contains invalid Unicode")
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
    if _depth(value) >= MAX_DEPTH:
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


MAX_OPERATIONS = 256
MAX_BODY_BYTES = 4096


def object_value(value: Any, context: str) -> None:
    if not isinstance(value, dict):
        reject("INVALID_FIELD", f"{context} must be an object")


def body(value: Any, context: str) -> None:
    if not valid_scalar_string(value):
        reject("INVALID_FIELD", f"{context} must be a scalar string")
    if len(value.encode("utf-8")) > MAX_BODY_BYTES:
        reject("LIMIT_EXCEEDED", f"{context} is too long")


def safe_integer(value: Any, context: str) -> None:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0 or value > MAX_SAFE_INTEGER:
        reject("INVALID_FIELD", f"{context} must be a non-negative safe integer")


def json_value(value: Any, context: str, depth: int = 1) -> None:
    if depth > MAX_DEPTH:
        reject("DEPTH_LIMIT", f"{context} is too deep")
    if value is None or isinstance(value, bool):
        return
    if isinstance(value, int):
        if abs(value) > MAX_SAFE_INTEGER:
            reject("UNSAFE_INTEGER", f"{context} must contain safe integers")
        return
    if isinstance(value, str):
        if not valid_scalar_string(value):
            reject("INVALID_UNICODE", f"{context} contains invalid Unicode")
        return
    if isinstance(value, list):
        if len(value) > MAX_ENTRIES:
            reject("LIMIT_EXCEEDED", f"{context} has too many entries")
        for index, item in enumerate(value):
            json_value(item, f"{context}[{index}]", depth + 1)
        return
    if isinstance(value, dict):
        if len(value) > MAX_ENTRIES:
            reject("LIMIT_EXCEEDED", f"{context} has too many members")
        for key, item in value.items():
            label(key, f"{context} key", True)
            json_value(item, f"{context}.{key}", depth + 1)
        return
    reject("INVALID_SCENARIO", f"{context} contains an unsupported value")


def label(value: Any, context: str, allow_empty: bool = False) -> None:
    if not valid_scalar_string(value) or (not allow_empty and len(value) == 0):
        reject("INVALID_FIELD", f"{context} must be a scalar string")
    if len(value.encode("utf-8")) > MAX_LABEL_BYTES:
        reject("LIMIT_EXCEEDED", f"{context} is too long")


def validate_fields(value: Any, context: str) -> None:
    object_value(value, context)
    if len(value) > MAX_ENTRIES:
        reject("LIMIT_EXCEEDED", f"{context} has too many fields")
    for key, item in value.items():
        label(key, f"{context} key")
        json_value(item, f"{context}.{key}")


def validate_notes(value: Any, context: str) -> None:
    if not isinstance(value, list):
        reject("INVALID_FIELD", f"{context} must be an array")
    if len(value) > MAX_ENTRIES:
        reject("LIMIT_EXCEEDED", f"{context} has too many notes")
    seen: set[str] = set()
    for index, note in enumerate(value):
        item_context = f"{context}[{index}]"
        exact_fields(note, ["note_id", "actor_label", "body"], item_context)
        label(note["note_id"], f"{item_context}.note_id")
        label(note["actor_label"], f"{item_context}.actor_label")
        body(note["body"], f"{item_context}.body")
        if note["note_id"] in seen:
            reject("DUPLICATE_ENTRY", f"{context} contains duplicate note IDs")
        seen.add(note["note_id"])


OPERATION_FIELDS = {
    "set_field": ["operation_id", "actor_label", "expected_revision", "kind", "field", "value"],
    "remove_field": ["operation_id", "actor_label", "expected_revision", "kind", "field"],
    "append_note": ["operation_id", "actor_label", "expected_revision", "kind", "note_id", "body"],
    "finalize": ["operation_id", "actor_label", "expected_revision", "kind"],
}


def validate_operation(operation: Any, context: str) -> None:
    object_value(operation, context)
    kind = operation.get("kind")
    if kind not in OPERATION_FIELDS:
        reject("INVALID_OPERATION", f"{context}.kind is unsupported")
    exact_fields(operation, OPERATION_FIELDS[kind], context)
    label(operation["operation_id"], f"{context}.operation_id")
    label(operation["actor_label"], f"{context}.actor_label")
    safe_integer(operation["expected_revision"], f"{context}.expected_revision")
    if kind == "set_field":
        label(operation["field"], f"{context}.field")
        json_value(operation["value"], f"{context}.value")
    elif kind == "remove_field":
        label(operation["field"], f"{context}.field")
    elif kind == "append_note":
        label(operation["note_id"], f"{context}.note_id")
        body(operation["body"], f"{context}.body")


def validate_scenario(scenario: Any) -> dict[str, Any]:
    exact_fields(scenario, ["profile", "case_id", "initial", "operations"], "scenario")
    if scenario["profile"] != PROFILE:
        reject("PROFILE_REJECT", "unsupported profile")
    label(scenario["case_id"], "scenario.case_id")
    initial = scenario["initial"]
    exact_fields(initial, ["object_id", "revision", "status", "fields", "notes"], "scenario.initial")
    label(initial["object_id"], "scenario.initial.object_id")
    safe_integer(initial["revision"], "scenario.initial.revision")
    if initial["status"] not in ("draft", "final"):
        reject("INVALID_FIELD", "scenario.initial.status is invalid")
    validate_fields(initial["fields"], "scenario.initial.fields")
    validate_notes(initial["notes"], "scenario.initial.notes")
    operations = scenario["operations"]
    if not isinstance(operations, list):
        reject("INVALID_FIELD", "scenario.operations must be an array")
    if len(operations) > MAX_OPERATIONS:
        reject("LIMIT_EXCEEDED", "scenario.operations is too large")
    for index, operation in enumerate(operations):
        validate_operation(operation, f"scenario.operations[{index}]")
    return scenario


def clone(value: Any) -> Any:
    return parse_strict_json(canonical(value))


def operation_outcome(
    operation: dict[str, Any],
    disposition: str,
    code: str | None,
    before: int,
    after: int,
    replayed_disposition: str | None = None,
    replayed_code: str | None = None,
) -> dict[str, Any]:
    return {
        "operation_id": operation["operation_id"],
        "actor_label": operation["actor_label"],
        "kind": operation["kind"],
        "disposition": disposition,
        "code": code,
        "revision_before": before,
        "revision_after": after,
        "replayed_disposition": replayed_disposition,
        "replayed_code": replayed_code,
    }


def evaluate_scenario(input_value: Any) -> dict[str, Any]:
    scenario = validate_scenario(input_value)
    input_sha256 = digest(scenario)
    state = clone(scenario["initial"])
    note_ids = {note["note_id"] for note in state["notes"]}
    seen_operations: dict[str, dict[str, Any]] = {}
    outcomes: list[dict[str, Any]] = []

    for operation in scenario["operations"]:
        before = state["revision"]
        operation_canonical = canonical(operation)
        seen = seen_operations.get(operation["operation_id"])
        if seen is not None:
            if seen["operation_canonical"] == operation_canonical:
                outcomes.append(operation_outcome(
                    operation, "idempotent", "EXACT_REPLAY", before, before,
                    seen["outcome"]["disposition"], seen["outcome"]["code"],
                ))
            else:
                outcomes.append(operation_outcome(
                    operation, "rejected", "OPERATION_ID_CONFLICT", before, before
                ))
            continue

        if state["status"] == "final":
            outcome = operation_outcome(operation, "rejected", "OBJECT_FINAL", before, before)
        elif operation["expected_revision"] != state["revision"]:
            outcome = operation_outcome(operation, "rejected", "STALE_REVISION", before, before)
        elif operation["kind"] == "set_field":
            field = operation["field"]
            if field in state["fields"] and canonical(state["fields"][field]) == canonical(operation["value"]):
                outcome = operation_outcome(operation, "rejected", "NO_CHANGE", before, before)
            else:
                state["fields"][field] = clone(operation["value"])
                state["revision"] += 1
                outcome = operation_outcome(operation, "applied", None, before, state["revision"])
        elif operation["kind"] == "remove_field":
            field = operation["field"]
            if field not in state["fields"]:
                outcome = operation_outcome(operation, "rejected", "FIELD_ABSENT", before, before)
            else:
                del state["fields"][field]
                state["revision"] += 1
                outcome = operation_outcome(operation, "applied", None, before, state["revision"])
        elif operation["kind"] == "append_note":
            if operation["note_id"] in note_ids:
                outcome = operation_outcome(operation, "rejected", "NOTE_ID_CONFLICT", before, before)
            else:
                state["notes"].append({
                    "note_id": operation["note_id"],
                    "actor_label": operation["actor_label"],
                    "body": operation["body"],
                })
                note_ids.add(operation["note_id"])
                state["revision"] += 1
                outcome = operation_outcome(operation, "applied", None, before, state["revision"])
        else:
            state["status"] = "final"
            state["revision"] += 1
            outcome = operation_outcome(operation, "applied", None, before, state["revision"])
        outcomes.append(outcome)
        seen_operations[operation["operation_id"]] = {
            "operation_canonical": operation_canonical,
            "outcome": outcome,
        }

    summary = {
        "applied": sum(item["disposition"] == "applied" for item in outcomes),
        "idempotent": sum(item["disposition"] == "idempotent" for item in outcomes),
        "rejected": sum(item["disposition"] == "rejected" for item in outcomes),
    }
    return {
        "profile": PROFILE,
        "case_id": scenario["case_id"],
        "input_sha256": input_sha256,
        "state": state,
        "outcomes": outcomes,
        "summary": summary,
    }


def evaluate_bytes(raw: bytes | str) -> dict[str, Any]:
    return evaluate_scenario(parse_strict_json(raw))


def projection(result: dict[str, Any]) -> dict[str, Any]:
    return {
        "case_id": result["case_id"],
        "revision": result["state"]["revision"],
        "status": result["state"]["status"],
        "fields": result["state"]["fields"],
        "notes": [
            [note["note_id"], note["actor_label"], note["body"]]
            for note in result["state"]["notes"]
        ],
        "outcomes": [
            [
                outcome["operation_id"],
                outcome["disposition"],
                outcome["code"],
                outcome["revision_before"],
                outcome["revision_after"],
                outcome["replayed_disposition"],
                outcome["replayed_code"],
            ]
            for outcome in result["outcomes"]
        ],
        "summary": result["summary"],
    }
