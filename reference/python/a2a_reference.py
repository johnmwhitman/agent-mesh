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
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple


PROTOCOL = "meshfleet.a2a"
VERSION = "0.1"
KIND = "message"
TYPES = {"handoff", "question", "result", "alert", "request_help"}
MAX_BODY_BYTES = 64 * 1024


class InvalidEnvelope(ValueError):
    pass


def stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def expand_fixture(value: Any) -> Any:
    if isinstance(value, list):
        return [expand_fixture(item) for item in value]
    if isinstance(value, dict):
        if value.get("$fixture") == "repeat" and isinstance(value.get("value"), str) and isinstance(value.get("count"), int):
            return value["value"] * value["count"]
        return {key: expand_fixture(nested) for key, nested in value.items()}
    return value


def non_empty(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise InvalidEnvelope(field + " must be a non-empty string")
    return value


def timestamp(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise InvalidEnvelope(field + " must be a finite non-negative integer")
    return value


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


def media_type(value: str) -> bool:
    base = value.split(";", 1)[0].strip()
    return bool(base) and "/" in base and all(part and not any(char.isspace() for char in part) for part in base.split("/", 1))


def validate_envelope(input_value: Any, now_ms: int | None = None, for_acceptance: bool = False) -> Dict[str, Any]:
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
    if len(body.encode("utf-8")) > MAX_BODY_BYTES:
        raise InvalidEnvelope("payload.body exceeds " + str(MAX_BODY_BYTES) + " UTF-8 bytes")
    if not media_type(payload_media_type):
        raise InvalidEnvelope("payload.media_type must be a valid media type")
    base_media_type = payload_media_type.split(";", 1)[0].lower()
    if base_media_type == "application/json" or base_media_type.endswith("+json"):
        try:
            json.loads(body)
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
            source = expand_fixture(case["input"])
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
                fingerprint = stable_json(normalized)
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
    return hashlib.sha256(stable_json(envelope).encode("ascii")).hexdigest()


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
    if not isinstance(principal_id, str) or not principal_id:
        return decision("rejected", "PRINCIPAL_CONTEXT_REQUIRED")
    if not isinstance(request_id, str) or not request_id:
        return decision("rejected", "REQUEST_ID_INVALID")
    binding = policy_ref(policy, principal_id)
    if binding is None:
        return decision("rejected", "PRINCIPAL_UNKNOWN")
    try:
        envelope = sorted_envelope(validate_envelope(step.get("envelope"), step.get("now_ms"), False))
    except InvalidEnvelope:
        return decision("rejected", "MALFORMED_ENVELOPE")
    if binding != envelope["sender"]:
        return decision("rejected", "SENDER_BINDING_DENIED")
    request_key = (principal_id, request_id)
    digest = fingerprint(envelope)
    previous_request = state["requests"].get(request_key)
    if previous_request is not None:
        if previous_request["digest"] == digest:
            result = copy.deepcopy(previous_request["result"])
            result["replayed_request"] = True
            return result
        return decision("conflict", "REQUEST_ID_REUSE")
    grants = policy.get("grants", {}).get(principal_id, {})
    if envelope["type"] not in grants.get("types", []):
        return decision("rejected", "TYPE_NOT_AUTHORIZED")
    audience = envelope.get("audience")
    allowed_audiences = grants.get("audiences", [])
    if audience is not None and audience not in allowed_audiences:
        return decision("rejected", "AUDIENCE_NOT_AUTHORIZED")
    allowed_recipients = set(tuple(value) for value in grants.get("recipients", []))
    if any(ref_key(recipient) not in allowed_recipients for recipient in envelope["recipients"]):
        return decision("rejected", "RECIPIENT_AUTHORIZATION_DENIED")
    semantic_key = (binding["namespace"], binding["agent_id"], envelope["message_id"])
    previous_message = state["messages"].get(semantic_key)
    if previous_message is not None:
        if previous_message["digest"] != digest:
            return decision("conflict", "MESSAGE_ID_CONFLICT")
        result = decision("duplicate", "DUPLICATE")
        state["requests"][request_key] = {"digest": digest, "result": copy.deepcopy(result)}
        return result
    expires_at = envelope.get("expires_at_ms")
    if expires_at is not None and expires_at <= step.get("now_ms", 0):
        return decision("rejected", "EXPIRED_AT_ACCEPTANCE")
    candidate = copy.deepcopy(state)
    result = decision("accepted", "ACCEPTED")
    candidate["messages"][semantic_key] = {"digest": digest, "recipients": copy.deepcopy(envelope["recipients"])}
    candidate["requests"][request_key] = {"digest": digest, "result": copy.deepcopy(result)}
    candidate["deliveries"] += len(envelope["recipients"])
    if step.get("inject_failure"):
        return decision("rejected", "PERSISTENCE_FAILED")
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
            actual = ingress_attempt(state, case["policy"], step)
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
    parser.add_argument("--v01-corpus", required=True)
    parser.add_argument("--ingress-corpus", required=True)
    args = parser.parse_args()
    v01_cases = json.loads(Path(args.v01_corpus).read_text(encoding="utf-8"))
    ingress_document = json.loads(Path(args.ingress_corpus).read_text(encoding="utf-8"))
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
