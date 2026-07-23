#!/usr/bin/env python3
"""Offline, stdlib-only reference conformance witness for meshfleet.a2a v0.1.

This is reference-conformance evidence only. It is not a production, public,
durable, or authenticated ingress implementation.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import struct
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Dict, List, Tuple


PROTOCOL = "meshfleet.a2a"
VERSION = "0.1"
KIND = "message"
TYPES = {"handoff", "question", "result", "alert", "request_help"}
MAX_BODY_BYTES = 64 * 1024
MAX_MEDIA_TYPE_BYTES = 1024
MAX_RAW_JSON_BYTES = 128 * 1024
MAX_RAW_JSON_DEPTH = 64
MAX_SAFE_INTEGER = 9007199254740991
FINGERPRINT_DOMAIN = "meshfleet.a2a.fingerprint.v1"
FINGERPRINT_LABEL = FINGERPRINT_DOMAIN + ":sha256"
TOKEN_CHARACTERS = frozenset("!#$%&'*+-.^_`|~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")


class InvalidEnvelope(ValueError):
    pass


class DuplicateMember(ValueError):
    pass


class RawResourceLimit(ValueError):
    pass


def scan_raw_bounds(value: str) -> None:
    try:
        encoded_size = len(value.encode("utf-8"))
    except UnicodeEncodeError as error:
        raise InvalidEnvelope("raw JSON must contain Unicode scalar values") from error
    if encoded_size > MAX_RAW_JSON_BYTES:
        raise RawResourceLimit("raw JSON input exceeds size limit")
    depth = 0
    in_string = False
    escaped = False
    for character in value:
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            continue
        if character == '"':
            in_string = True
        elif character in "[{":
            depth += 1
            if depth > MAX_RAW_JSON_DEPTH:
                raise RawResourceLimit("raw JSON nesting depth exceeds limit")
        elif character in "]}":
            depth -= 1


def strict_object(pairs: List[Tuple[str, Any]]) -> Dict[str, Any]:
    result: Dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateMember("duplicate JSON object member")
        result[key] = value
    return result


def reject_constant(_value: str) -> Any:
    raise InvalidEnvelope("nonstandard JSON numeric constant")


def parse_raw_integer(token: str) -> int:
    value = int(token)
    if value < -MAX_SAFE_INTEGER or value > MAX_SAFE_INTEGER:
        raise InvalidEnvelope("JSON exact integer exceeds the safe integer range")
    return value


def parse_raw_float(token: str) -> float:
    try:
        exact = Decimal(token)
        parsed = float(token)
    except (InvalidOperation, OverflowError, ValueError) as error:
        raise InvalidEnvelope("invalid JSON number") from error
    if not math.isfinite(parsed):
        raise InvalidEnvelope("JSON number must be finite binary64")
    if exact == exact.to_integral_value():
        if exact < -MAX_SAFE_INTEGER or exact > MAX_SAFE_INTEGER:
            raise InvalidEnvelope("JSON exact integer exceeds the safe integer range")
    elif parsed.is_integer():
        raise InvalidEnvelope("JSON non-integer must not round to an integer")
    return parsed


def strict_json_loads(value: str) -> Any:
    scan_raw_bounds(value)
    return json.loads(
        value,
        object_pairs_hook=strict_object,
        parse_constant=reject_constant,
        parse_int=parse_raw_integer,
        parse_float=parse_raw_float,
    )


def json_value_loads(value: str) -> Any:
    return strict_json_loads(value)


def parse_raw_json(value: str) -> Any:
    try:
        return strict_json_loads(value)
    except (DuplicateMember, json.JSONDecodeError) as error:
        raise InvalidEnvelope("serialized input must be unambiguous JSON") from error


def stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False)


def length_prefix(value: int) -> bytes:
    return struct.pack(">Q", value)


def canonical_string(value: str) -> bytes:
    validate_scalar_tree(value, "canonical string")
    encoded = value.encode("utf-8")
    return b"\x04" + length_prefix(len(encoded)) + encoded


def canonical_tree(value: Any, ancestors: set[int] | None = None, depth: int = 0) -> bytes:
    if ancestors is None:
        ancestors = set()
    if value is None:
        return b"\x00"
    if value is False:
        return b"\x01"
    if value is True:
        return b"\x02"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        validate_json_number(value, "canonical number")
        number = float(value)
        if number == 0.0:
            number = 0.0
        return b"\x03" + struct.pack(">d", number)
    if isinstance(value, str):
        return canonical_string(value)
    if isinstance(value, list):
        if depth >= MAX_RAW_JSON_DEPTH:
            raise InvalidEnvelope("canonical tree exceeds maximum JSON depth")
        identity = id(value)
        if identity in ancestors:
            raise InvalidEnvelope("canonical tree must be acyclic")
        ancestors.add(identity)
        try:
            return b"\x05" + length_prefix(len(value)) + b"".join(
                canonical_tree(nested, ancestors, depth + 1) for nested in value
            )
        finally:
            ancestors.remove(identity)
    if isinstance(value, dict):
        if depth >= MAX_RAW_JSON_DEPTH:
            raise InvalidEnvelope("canonical tree exceeds maximum JSON depth")
        identity = id(value)
        if identity in ancestors:
            raise InvalidEnvelope("canonical tree must be acyclic")
        ancestors.add(identity)
        try:
            entries = []
            for key, nested in value.items():
                if not isinstance(key, str):
                    raise InvalidEnvelope("canonical object keys must be strings")
                validate_scalar_tree(key, "canonical object key")
                encoded_key = key.encode("utf-8")
                entries.append((encoded_key, nested))
            entries.sort(key=lambda entry: entry[0])
            encoded_entries = b"".join(
                b"\x04" + length_prefix(len(encoded_key)) + encoded_key
                + canonical_tree(nested, ancestors, depth + 1)
                for encoded_key, nested in entries
            )
            return b"\x06" + length_prefix(len(entries)) + encoded_entries
        finally:
            ancestors.remove(identity)
    raise InvalidEnvelope("canonical fingerprint requires a JSON value tree")


def canonical_envelope_digest(input_value: Any) -> str:
    envelope = validate_envelope(input_value)
    fingerprint_bytes = FINGERPRINT_DOMAIN.encode("utf-8") + b"\x00" + canonical_tree(envelope)
    return FINGERPRINT_LABEL + ":" + hashlib.sha256(fingerprint_bytes).hexdigest()


def expand_fixture(value: Any) -> Any:
    if isinstance(value, list):
        return [expand_fixture(item) for item in value]
    if isinstance(value, dict):
        if value.get("$fixture") == "repeat" and isinstance(value.get("value"), str) and isinstance(value.get("count"), int):
            return value["value"] * value["count"]
        if value.get("$fixture") == "json_depth" and isinstance(value.get("depth"), int) and value["depth"] >= 0:
            return "[" * value["depth"] + "null" + "]" * value["depth"]
        if value.get("$fixture") == "number" and isinstance(value.get("value"), str):
            token = value["value"]
            return float(token) if any(marker in token for marker in ".eE") else int(token)
        return {key: expand_fixture(nested) for key, nested in value.items()}
    return value


def non_empty(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise InvalidEnvelope(field + " must be a non-empty string")
    if any(0xD800 <= ord(character) <= 0xDFFF for character in value):
        raise InvalidEnvelope(field + " must contain only Unicode scalar values")
    return value


def validate_scalar_tree(
    value: Any,
    field: str,
    ancestors: set[int] | None = None,
    depth: int = 0,
) -> None:
    if ancestors is None:
        ancestors = set()
    if isinstance(value, str):
        if any(0xD800 <= ord(character) <= 0xDFFF for character in value):
            raise InvalidEnvelope(field + " must contain only Unicode scalar values")
        return
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        validate_json_number(value, field)
        return
    if value is None or isinstance(value, bool):
        return
    if isinstance(value, list):
        if depth >= MAX_RAW_JSON_DEPTH:
            raise InvalidEnvelope(field + " exceeds maximum JSON depth")
        identity = id(value)
        if identity in ancestors:
            raise InvalidEnvelope(field + " must be acyclic")
        ancestors.add(identity)
        try:
            for index, nested in enumerate(value):
                validate_scalar_tree(nested, field + "[" + str(index) + "]", ancestors, depth + 1)
        finally:
            ancestors.remove(identity)
        return
    if isinstance(value, dict):
        if depth >= MAX_RAW_JSON_DEPTH:
            raise InvalidEnvelope(field + " exceeds maximum JSON depth")
        identity = id(value)
        if identity in ancestors:
            raise InvalidEnvelope(field + " must be acyclic")
        ancestors.add(identity)
        try:
            for key, nested in value.items():
                if not isinstance(key, str):
                    raise InvalidEnvelope(field + " keys must be strings")
                validate_scalar_tree(key, field + " key", ancestors, depth + 1)
                validate_scalar_tree(nested, field + "." + key, ancestors, depth + 1)
        finally:
            ancestors.remove(identity)
        return
    raise InvalidEnvelope(field + " must contain JSON values only")


def validate_json_number(value: int | float, field: str) -> None:
    if isinstance(value, int):
        if value < -MAX_SAFE_INTEGER or value > MAX_SAFE_INTEGER:
            raise InvalidEnvelope(field + " integral value must be a safe integer")
        return
    if not math.isfinite(value):
        raise InvalidEnvelope(field + " must be a finite binary64 number")
    if value.is_integer() and (value < -MAX_SAFE_INTEGER or value > MAX_SAFE_INTEGER):
        raise InvalidEnvelope(field + " integral value must be a safe integer")


def timestamp(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise InvalidEnvelope(field + " must be a safe non-negative integer")
    validate_json_number(value, field)
    number = float(value)
    if not number.is_integer() or number < 0:
        raise InvalidEnvelope(field + " must be a safe non-negative integer")
    return int(number)


def record(value: Any, field: str) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise InvalidEnvelope(field + " must be an object")
    return value


def agent_ref(value: Any, field: str) -> Dict[str, str]:
    item = record(value, field)
    namespace = non_empty(item.get("namespace"), field + ".namespace")
    agent_id = non_empty(item.get("agent_id"), field + ".agent_id")
    if namespace == "*" or agent_id == "*":
        raise InvalidEnvelope(field + " must not contain a wildcard")
    return {"namespace": namespace, "agent_id": agent_id}


def ref_key(ref: Dict[str, str]) -> Tuple[str, str]:
    return (ref["namespace"], ref["agent_id"])


def consume_token(value: str, start: int) -> int:
    index = start
    while index < len(value) and value[index] in TOKEN_CHARACTERS:
        index += 1
    return index


def consume_ows(value: str, start: int) -> int:
    index = start
    while index < len(value) and value[index] in (" ", "\t"):
        index += 1
    return index


def media_type(value: str) -> bool:
    # Same language-neutral grammar as the TypeScript codec: ASCII token/type,
    # SP-or-HTAB OWS, and non-empty token or bounded-ASCII quoted parameters.
    if not value or len(value) > MAX_MEDIA_TYPE_BYTES or any(ord(character) > 0x7F for character in value):
        return False
    index = consume_token(value, 0)
    if index == 0 or index >= len(value) or value[index] != "/":
        return False
    index += 1
    subtype_start = index
    index = consume_token(value, index)
    if index == subtype_start:
        return False
    while True:
        index = consume_ows(value, index)
        if index == len(value):
            return True
        if value[index] != ";":
            return False
        index = consume_ows(value, index + 1)
        name_start = index
        index = consume_token(value, index)
        if index == name_start:
            return False
        index = consume_ows(value, index)
        if index >= len(value) or value[index] != "=":
            return False
        index = consume_ows(value, index + 1)
        if index < len(value) and value[index] == '"':
            index += 1
            closed = False
            while index < len(value):
                code = ord(value[index])
                if code == 0x22:
                    index += 1
                    closed = True
                    break
                if code == 0x5C:
                    index += 1
                    if index >= len(value):
                        return False
                    escaped = ord(value[index])
                    if not (escaped == 0x09 or 0x20 <= escaped <= 0x7E):
                        return False
                    index += 1
                    continue
                if not (code in (0x09, 0x20, 0x21) or 0x23 <= code <= 0x5B or 0x5D <= code <= 0x7E):
                    return False
                index += 1
            if not closed:
                return False
        else:
            value_start = index
            index = consume_token(value, index)
            if index == value_start:
                return False


def validate_envelope(input_value: Any, now_ms: int | None = None, for_acceptance: bool = False) -> Dict[str, Any]:
    validate_scalar_tree(input_value, "envelope")
    if len(stable_json(input_value).encode("utf-8")) > MAX_RAW_JSON_BYTES:
        raise InvalidEnvelope("envelope exceeds encoded UTF-8 size limit")
    item = record(input_value, "envelope")
    if item.get("protocol") != PROTOCOL:
        raise InvalidEnvelope("protocol must equal " + PROTOCOL)
    version = non_empty(item.get("version"), "version")
    if version != VERSION:
        raise InvalidEnvelope("unsupported version " + version)
    if item.get("kind") != KIND:
        raise InvalidEnvelope("kind must equal " + KIND)
    sender = agent_ref(item.get("sender"), "sender")
    raw_recipients = item.get("recipients")
    if not isinstance(raw_recipients, list) or not raw_recipients:
        raise InvalidEnvelope("recipients must be a non-empty array")
    recipients = [agent_ref(value, "recipients[" + str(index) + "]") for index, value in enumerate(raw_recipients)]
    keys = set()
    for recipient in recipients:
        key = ref_key(recipient)
        if key in keys:
            raise InvalidEnvelope("recipients must be unique")
        if key == ref_key(sender):
            raise InvalidEnvelope("sender must not be a recipient")
        keys.add(key)
    message_type = non_empty(item.get("type"), "type")
    if message_type not in TYPES:
        raise InvalidEnvelope("unsupported message type " + message_type)
    issued_at = timestamp(item.get("issued_at_ms"), "issued_at_ms")
    expires_at = item.get("expires_at_ms")
    if expires_at is not None:
        expires_at = timestamp(expires_at, "expires_at_ms")
        if expires_at <= issued_at:
            raise InvalidEnvelope("expires_at_ms must be greater than issued_at_ms")
        if for_acceptance and expires_at <= (now_ms if now_ms is not None else 0):
            raise InvalidEnvelope("envelope is expired")
    payload = record(item.get("payload"), "payload")
    payload_media_type = non_empty(payload.get("media_type"), "payload.media_type")
    body = payload.get("body")
    if not isinstance(body, str):
        raise InvalidEnvelope("payload.body must be a string")
    if any(0xD800 <= ord(character) <= 0xDFFF for character in body):
        raise InvalidEnvelope("payload.body must contain only Unicode scalar values")
    if len(body.encode("utf-8")) > MAX_BODY_BYTES:
        raise InvalidEnvelope("payload.body exceeds " + str(MAX_BODY_BYTES) + " UTF-8 bytes")
    if not media_type(payload_media_type):
        raise InvalidEnvelope("payload.media_type must be a valid media type")
    base_media_type = payload_media_type.split(";", 1)[0].rstrip(" \t").lower()
    if base_media_type == "application/json" or base_media_type.endswith("+json"):
        try:
            parsed_payload = json_value_loads(body)
            validate_scalar_tree(parsed_payload, "payload JSON")
        except (TypeError, ValueError) as error:
            raise InvalidEnvelope("payload.body must be valid JSON for a JSON media type") from error
    extensions = item.get("extensions")
    if extensions is not None and not isinstance(extensions, dict):
        raise InvalidEnvelope("extensions must be an object")
    scope = item.get("scope")
    if scope is not None:
        scope = record(scope, "scope")
        scope = {"fleet_id": non_empty(scope.get("fleet_id"), "scope.fleet_id")}
    result: Dict[str, Any] = {
        "protocol": PROTOCOL, "version": VERSION, "kind": KIND,
        "message_id": non_empty(item.get("message_id"), "message_id"),
        "sender": sender, "recipients": recipients, "type": message_type,
        "issued_at_ms": issued_at,
        "payload": {"media_type": payload_media_type, "body": body},
    }
    if expires_at is not None:
        result["expires_at_ms"] = expires_at
    for field in ("audience", "correlation_id", "dedupe_key"):
        if field in item:
            result[field] = non_empty(item[field], field)
    if extensions is not None:
        result["extensions"] = extensions
    if scope is not None:
        result["scope"] = scope
    return result


def map_legacy(value: Dict[str, Any], options: Dict[str, Any]) -> Dict[str, Any]:
    namespace = options.get("namespace", "mesh-local")
    recipients = options.get("broadcast_recipients") if value.get("to_agent_id") == "*" else [value.get("to_agent_id")]
    if not isinstance(recipients, list) or not recipients:
        raise InvalidEnvelope("Legacy broadcast requires resolved recipients")
    source = {
        "protocol": PROTOCOL, "version": VERSION, "kind": KIND,
        "message_id": value.get("id"),
        "sender": {"namespace": namespace, "agent_id": value.get("from_agent_id")},
        "recipients": [{"namespace": namespace, "agent_id": recipient} for recipient in recipients],
        "type": value.get("type"), "issued_at_ms": value.get("timestamp"),
        "payload": {"media_type": "text/plain", "body": value.get("payload")},
        "scope": {"fleet_id": value.get("fleet_id")},
    }
    if "correlation_id" in value:
        source["correlation_id"] = value["correlation_id"]
    envelope = validate_envelope(source)
    return {"envelope": envelope, "recipients": [recipient["agent_id"] for recipient in envelope["recipients"]]}


def project_legacy(mapping: Dict[str, Any], target: str) -> Dict[str, Any]:
    envelope = mapping["envelope"]
    result: Dict[str, Any] = {
        "id": envelope["message_id"], "from_agent_id": envelope["sender"]["agent_id"],
        "to_agent_id": target, "fleet_id": envelope.get("scope", {}).get("fleet_id", ""),
        "type": envelope["type"], "payload": envelope["payload"]["body"],
        "timestamp": envelope["issued_at_ms"], "acknowledged": False,
    }
    if "correlation_id" in envelope:
        result["correlation_id"] = envelope["correlation_id"]
    if target == "*":
        result["recipients"] = mapping["recipients"]
    return result


def run_v01(cases: List[Dict[str, Any]]) -> Dict[str, Any]:
    identity: Dict[str, str] = {}
    outcomes = []
    failures = []
    for case in cases:
        name = case["name"]
        expected = case["expected"]
        try:
            source = parse_raw_json(case["raw_json"]) if "raw_json" in case else expand_fixture(case["input"])
            if case.get("kind") == "legacy_mapping":
                options = case.get("options", {})
                mapping = map_legacy(source, options)
                expected_mapping = case.get("expected_mapping", {})
                target = "*" if source.get("to_agent_id") == "*" else source.get("to_agent_id")
                actual = {"envelope": mapping["envelope"], "recipients": mapping["recipients"], "projection": project_legacy(mapping, target)}
                expected_value = {"envelope": expected_mapping.get("envelope"), "recipients": expected_mapping.get("recipients"), "projection": expected_mapping.get("projection")}
                actual_outcome = "mapping" if actual == expected_value else "mismatch"
            else:
                options = case.get("options", {})
                normalized = validate_envelope(source, options.get("nowMs"), bool(options.get("forAcceptance")))
                key = normalized.get("dedupe_key", normalized["message_id"])
                fingerprint = canonical_envelope_digest(normalized)
                previous = identity.get(key)
                actual_outcome = "accepted" if previous is None else ("duplicate" if previous == fingerprint else "conflict")
                if previous is None:
                    identity[key] = fingerprint
                if expected == "valid":
                    actual_outcome = "valid" if actual_outcome == "accepted" else actual_outcome
            if actual_outcome != expected:
                failures.append({"name": name, "expected": expected, "actual": actual_outcome})
            outcomes.append({"name": name, "outcome": actual_outcome})
        except InvalidEnvelope:
            actual_outcome = "invalid"
            if expected != actual_outcome:
                failures.append({"name": name, "expected": expected, "actual": actual_outcome})
            outcomes.append({"name": name, "outcome": actual_outcome})
    return {"case_count": len(cases), "outcomes": outcomes, "failures": failures}


def sorted_envelope(envelope: Dict[str, Any]) -> Dict[str, Any]:
    normalized = copy.deepcopy(envelope)
    normalized["recipients"] = sorted(normalized["recipients"], key=lambda item: (item["namespace"], item["agent_id"]))
    return normalized


def fingerprint(envelope: Dict[str, Any]) -> str:
    return canonical_envelope_digest(envelope)


def policy_ref(policy: Dict[str, Any], principal_id: str) -> Dict[str, str] | None:
    binding = policy.get("bindings", {}).get(principal_id)
    if not isinstance(binding, dict):
        return None
    if not isinstance(binding.get("namespace"), str) or not isinstance(binding.get("agent_id"), str):
        return None
    return {"namespace": binding["namespace"], "agent_id": binding["agent_id"]}


def decision(disposition: str, code: str, replayed_request: bool = False) -> Dict[str, Any]:
    return {"disposition": disposition, "code": code, "replayed_request": replayed_request}


def ingress_attempt(state: Dict[str, Any], policy: Dict[str, Any], step: Dict[str, Any]) -> Dict[str, Any]:
    principal_id = step.get("principal_id")
    request_id = step.get("request_id")
    if not isinstance(request_id, str) or not request_id:
        return decision("rejected", "request_id_invalid")
    if not isinstance(principal_id, str) or not principal_id:
        return decision("rejected", "principal_context_required")
    raw_envelope = step.get("envelope")
    if isinstance(raw_envelope, dict) and isinstance(raw_envelope.get("version"), str) and raw_envelope["version"] != VERSION:
        return decision("rejected", "unsupported_version")
    try:
        envelope = sorted_envelope(validate_envelope(raw_envelope, step.get("now_ms"), False))
    except InvalidEnvelope:
        return decision("rejected", "malformed_envelope")
    binding = policy_ref(policy, principal_id)
    if binding is None:
        return decision("rejected", "AUTHORIZATION_DENIED")
    if binding != envelope["sender"]:
        return decision("rejected", "AUTHORIZATION_DENIED")
    grants = policy.get("grants", {}).get(principal_id, {})
    if envelope["type"] not in grants.get("types", []):
        return decision("rejected", "AUTHORIZATION_DENIED")
    audience = envelope.get("audience")
    allowed_audiences = grants.get("audiences", [])
    if audience is not None and audience not in allowed_audiences:
        return decision("rejected", "AUTHORIZATION_DENIED")
    allowed_recipients = set(tuple(value) for value in grants.get("recipients", []))
    if any(ref_key(recipient) not in allowed_recipients for recipient in envelope["recipients"]):
        return decision("rejected", "AUTHORIZATION_DENIED")
    request_key = (principal_id, request_id)
    digest = fingerprint(envelope)
    previous_request = state["requests"].get(request_key)
    if previous_request is not None:
        if previous_request["digest"] == digest:
            return decision("replayed_request", "replayed_request", True)
        return decision("conflict", "request_id_reuse")
    semantic_key = (binding["namespace"], binding["agent_id"], envelope["message_id"])
    previous_message = state["messages"].get(semantic_key)
    if previous_message is not None:
        if previous_message["digest"] != digest:
            return decision("conflict", "message_id_conflict")
        result = decision("duplicate", "duplicate")
        state["requests"][request_key] = {"digest": digest, "result": copy.deepcopy(result)}
        return result
    expires_at = envelope.get("expires_at_ms")
    if expires_at is not None and expires_at <= step.get("now_ms", 0):
        return decision("rejected", "expired_at_acceptance")
    candidate = copy.deepcopy(state)
    result = decision("accepted", "accepted")
    candidate["messages"][semantic_key] = {"digest": digest, "recipients": copy.deepcopy(envelope["recipients"])}
    candidate["requests"][request_key] = {"digest": digest, "result": copy.deepcopy(result)}
    candidate["deliveries"] += len(envelope["recipients"])
    if step.get("inject_failure"):
        return decision("rejected", "ingress_storage_unavailable")
    state.clear()
    state.update(candidate)
    return result


def run_ingress(cases: List[Dict[str, Any]]) -> Dict[str, Any]:
    outcomes = []
    failures = []
    for case in cases:
        state: Dict[str, Any] = {"messages": {}, "requests": {}, "deliveries": 0}
        case_outcomes = []
        for step in case["steps"]:
            if "raw_json" in step:
                try:
                    parsed_step = parse_raw_json(step["raw_json"])
                    if not isinstance(parsed_step, dict):
                        raise InvalidEnvelope("ingress request must be an object")
                    actual = ingress_attempt(state, step.get("policy", case["policy"]), parsed_step)
                except InvalidEnvelope:
                    actual = decision("rejected", "malformed_envelope")
            else:
                actual = ingress_attempt(state, step.get("policy", case["policy"]), step)
            expected = step["expected"]
            wanted = {key: expected[key] for key in ("disposition", "code", "replayed_request") if key in expected}
            observed = {key: actual[key] for key in wanted}
            if wanted != observed:
                failures.append({"name": case["name"], "expected": wanted, "actual": observed})
            if "state" in expected:
                snapshot = {"messages": len(state["messages"]), "requests": len(state["requests"]), "deliveries": state["deliveries"]}
                if snapshot != expected["state"]:
                    failures.append({"name": case["name"] + ":state", "expected": expected["state"], "actual": snapshot})
            case_outcomes.append(actual)
        outcomes.append({"name": case["name"], "outcomes": case_outcomes})
    return {"case_count": len(cases), "outcomes": outcomes, "failures": failures}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--v01-corpus")
    parser.add_argument("--ingress-corpus")
    parser.add_argument("--digest-envelope")
    args = parser.parse_args()
    if args.digest_envelope is not None:
        try:
            envelope = strict_json_loads(Path(args.digest_envelope).read_text(encoding="utf-8"))
            print(stable_json({"label": FINGERPRINT_DOMAIN, "digest": canonical_envelope_digest(envelope)}))
            return 0
        except RawResourceLimit:
            print(stable_json({"label": FINGERPRINT_DOMAIN, "ok": False, "error": "raw_json_resource_limit"}))
            return 2
        except (InvalidEnvelope, DuplicateMember, json.JSONDecodeError, OSError):
            print(stable_json({"label": FINGERPRINT_DOMAIN, "ok": False, "error": "invalid_digest_json"}))
            return 2
    if args.v01_corpus is None or args.ingress_corpus is None:
        parser.error("--v01-corpus and --ingress-corpus are required unless --digest-envelope is used")
    try:
        v01_cases = strict_json_loads(Path(args.v01_corpus).read_text(encoding="utf-8"))
        ingress_document = strict_json_loads(Path(args.ingress_corpus).read_text(encoding="utf-8"))
    except (InvalidEnvelope, DuplicateMember, RawResourceLimit, json.JSONDecodeError):
        print(stable_json({
            "label": "reference-conformance-only-not-production-public-durable-authenticated",
            "ok": False,
            "error": "invalid_corpus_json",
        }))
        return 2
    v01 = run_v01(v01_cases)
    ingress = run_ingress(ingress_document["cases"])
    report = {
        "label": "reference-conformance-only-not-production-public-durable-authenticated",
        "v01": v01,
        "ingress": ingress,
        "ok": not v01["failures"] and not ingress["failures"],
    }
    print(stable_json(report))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
