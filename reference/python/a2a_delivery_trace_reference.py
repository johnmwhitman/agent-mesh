#!/usr/bin/env python3
"""Offline reference witness for the meshfleet.a2a delivery-trace profile."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple

from a2a_reference import (
    DuplicateMember,
    InvalidEnvelope,
    RawResourceLimit,
    canonical_envelope_digest,
    stable_json,
    strict_json_loads,
    validate_envelope,
)


PROTOCOL = "meshfleet.a2a.delivery-trace"
VERSION = "0.1"
LABEL = "reference-conformance-only-not-live-transport-delivery-auth-wake-execution"
MAX_EVENTS = 256
MAX_RECEIPT_ACTION_LENGTH = 64
TRANSPORTS = frozenset(("stdio", "mailbox", "http_sse", "websocket"))
KINDS = frozenset((
    "message_offered",
    "message_arrived",
    "recipient_observed",
    "receipt_recorded",
    "acknowledgment",
    "retryable_failure",
    "terminal_rejection",
))
AGENT_KINDS = frozenset((
    "message_arrived",
    "recipient_observed",
    "receipt_recorded",
    "acknowledgment",
))
EVENT_FIELDS = frozenset((
    "sequence",
    "transport",
    "kind",
    "message_id",
    "envelope_digest",
    "agent",
    "receipt_action",
))
CLAIMS = {
    "live_transport": False,
    "interoperability": False,
    "durable_acceptance": False,
    "authenticated_principal": False,
    "wake_authority": False,
    "execution": False,
    "persisted": False,
}
TOKEN = re.compile(r"[a-z0-9][a-z0-9._:-]*\Z")


def utf16_sort_key(value: str) -> bytes:
    return value.encode("utf-16-be", errors="surrogatepass")


def failure(code: str, path: str, precedence_row: str) -> Dict[str, Any]:
    return {
        "ok": False,
        "protocol": PROTOCOL,
        "version": VERSION,
        "error": {
            "code": code,
            "path": path,
            "precedence_row": precedence_row,
        },
    }


def first_unknown_key(value: Dict[str, Any], allowed: frozenset[str]) -> str | None:
    for key in sorted(value, key=utf16_sort_key):
        if key not in allowed:
            return key
    return None


def normalize_agent_ref(value: Any) -> Dict[str, str] | None:
    if not isinstance(value, dict):
        return None
    if first_unknown_key(value, frozenset(("namespace", "agent_id"))) is not None:
        return None
    namespace = value.get("namespace")
    agent_id = value.get("agent_id")
    if (
        not isinstance(namespace, str)
        or not namespace
        or namespace == "*"
        or not isinstance(agent_id, str)
        or not agent_id
        or agent_id == "*"
    ):
        return None
    return {"namespace": namespace, "agent_id": agent_id}


def agent_key(agent: Dict[str, str]) -> Tuple[str, str]:
    return (agent["namespace"], agent["agent_id"])


def receipt_key(agent: Dict[str, str], action: str) -> Tuple[str, str, str]:
    return (agent["namespace"], agent["agent_id"], action)


def copy_agent(agent: Dict[str, str]) -> Dict[str, str]:
    return {"namespace": agent["namespace"], "agent_id": agent["agent_id"]}


def decode_envelope(raw: str) -> Dict[str, Any]:
    parsed = strict_json_loads(raw)
    return validate_envelope(parsed)


def evaluate_delivery_trace(input_value: Any) -> Dict[str, Any]:
    if not isinstance(input_value, dict):
        return failure("INVALID_INPUT", "$", "D00")
    root_unknown = first_unknown_key(input_value, frozenset(("envelope_json", "events")))
    if root_unknown is not None:
        return failure("UNKNOWN_FIELD", "$." + root_unknown, "D01")
    envelope_json = input_value.get("envelope_json")
    if not isinstance(envelope_json, str):
        return failure("INVALID_INPUT", "$.envelope_json", "D02")
    try:
        envelope = decode_envelope(envelope_json)
        envelope_digest = canonical_envelope_digest(envelope)
    except (DuplicateMember, InvalidEnvelope, RawResourceLimit, json.JSONDecodeError, TypeError, ValueError):
        return failure("INVALID_ENVELOPE", "$.envelope_json", "D03")

    events = input_value.get("events")
    if not isinstance(events, list) or not events or len(events) > MAX_EVENTS:
        return failure("INVALID_INPUT", "$.events", "D04")

    recipients = {agent_key(recipient) for recipient in envelope["recipients"]}
    arrived: set[Tuple[str, str]] = set()
    acknowledged: set[Tuple[str, str]] = set()
    recorded_receipts: set[Tuple[str, str, str]] = set()
    timeline: List[Dict[str, Any]] = []
    previous_sequence = -1
    terminal_rejected = False
    successfully_completed = False

    for index, raw in enumerate(events):
        path = "$.events[" + str(index) + "]"
        if not isinstance(raw, dict):
            return failure("INVALID_EVENT", path, "D05")
        unknown = first_unknown_key(raw, EVENT_FIELDS)
        if unknown is not None:
            return failure("UNKNOWN_FIELD", path + "." + unknown, "D06")

        sequence = raw.get("sequence")
        transport = raw.get("transport")
        kind = raw.get("kind")
        if (
            type(sequence) is not int
            or sequence < 0
            or sequence > 9007199254740991
            or not isinstance(transport, str)
            or transport not in TRANSPORTS
            or not isinstance(kind, str)
            or kind not in KINDS
        ):
            return failure("INVALID_EVENT", path, "D07")
        if sequence <= previous_sequence or terminal_rejected:
            return failure("ORDER_VIOLATION", path, "D08")
        previous_sequence = sequence
        if raw.get("message_id") != envelope["message_id"] or raw.get("envelope_digest") != envelope_digest:
            return failure("BINDING_MISMATCH", path, "D09")

        requires_agent = kind in AGENT_KINDS
        has_agent = "agent" in raw
        if requires_agent != has_agent:
            return failure("INVALID_EVENT", path + ".agent", "D10")
        agent = normalize_agent_ref(raw.get("agent")) if has_agent else None
        if requires_agent and agent is None:
            return failure("INVALID_EVENT", path + ".agent", "D10")
        if requires_agent and agent_key(agent) not in recipients:
            return failure("NON_RECIPIENT", path + ".agent", "D11")

        has_receipt_action = "receipt_action" in raw
        if kind == "receipt_recorded":
            action = raw.get("receipt_action")
            if (
                not isinstance(action, str)
                or not action
                or len(action) > MAX_RECEIPT_ACTION_LENGTH
                or TOKEN.fullmatch(action) is None
                or action == "ack"
            ):
                return failure("INVALID_EVENT", path + ".receipt_action", "D12")
        elif has_receipt_action:
            return failure("INVALID_EVENT", path + ".receipt_action", "D12")

        if index == 0 and kind != "message_offered":
            return failure("ORDER_VIOLATION", path, "D13")
        if index > 0 and kind == "message_offered":
            return failure("ORDER_VIOLATION", path, "D15")
        if requires_agent and kind != "message_arrived" and agent_key(agent) not in arrived:
            return failure("ORDER_VIOLATION", path, "D14")
        if kind == "acknowledgment" and agent_key(agent) in acknowledged:
            return failure("ORDER_VIOLATION", path, "D16")
        if kind == "receipt_recorded" and receipt_key(agent, raw["receipt_action"]) in recorded_receipts:
            return failure("ORDER_VIOLATION", path, "D16")
        if successfully_completed:
            return failure("ORDER_VIOLATION", path, "D17")

        if kind == "message_arrived":
            arrived.add(agent_key(agent))
        elif kind == "receipt_recorded":
            recorded_receipts.add(receipt_key(agent, raw["receipt_action"]))
        elif kind == "acknowledgment":
            acknowledged.add(agent_key(agent))
            successfully_completed = all(agent_key(recipient) in acknowledged for recipient in envelope["recipients"])
        elif kind == "terminal_rejection":
            terminal_rejected = True

        normalized: Dict[str, Any] = {"sequence": sequence, "kind": kind}
        if agent is not None:
            normalized["agent"] = copy_agent(agent)
        if has_receipt_action:
            normalized["receipt_action"] = raw["receipt_action"]
        timeline.append(normalized)

    def count(kind_name: str) -> int:
        return sum(1 for event in timeline if event["kind"] == kind_name)

    return {
        "ok": True,
        "protocol": PROTOCOL,
        "version": VERSION,
        "conformance": "offline_modeled_trace",
        "binding": {
            "message_id": envelope["message_id"],
            "envelope_digest": envelope_digest,
            "sender": copy_agent(envelope["sender"]),
            "recipients": [copy_agent(recipient) for recipient in envelope["recipients"]],
        },
        "timeline": timeline,
        "summary": {
            "offered_count": count("message_offered"),
            "arrived_count": count("message_arrived"),
            "observed_count": count("recipient_observed"),
            "receipt_count": count("receipt_recorded"),
            "acknowledgment_count": count("acknowledgment"),
            "retryable_failure_count": count("retryable_failure"),
            "terminal_rejection_count": count("terminal_rejection"),
            "all_recipients_acknowledged": all(agent_key(recipient) in acknowledged for recipient in envelope["recipients"]),
        },
        "claims": CLAIMS,
    }


def invalid_corpus() -> int:
    print(stable_json({"label": LABEL, "ok": False, "error": "invalid_corpus_json"}))
    return 2


def require_record(value: Any) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("expected object")
    return value


def validate_expected(fixture: Dict[str, Any], result: Dict[str, Any], claims: Dict[str, Any]) -> Dict[str, Any] | None:
    expected = require_record(fixture.get("expected"))
    if type(expected.get("ok")) is not bool or result["ok"] != expected["ok"]:
        return {"expected": expected, "actual": result}
    if result["ok"]:
        if result["claims"] != claims:
            return {"expected": claims, "actual": result["claims"]}
        if "timeline_kinds" in expected:
            actual_kinds = [event["kind"] for event in result["timeline"]]
            if actual_kinds != expected["timeline_kinds"]:
                return {"expected": expected["timeline_kinds"], "actual": actual_kinds}
        if "summary" in expected and result["summary"] != expected["summary"]:
            return {"expected": expected["summary"], "actual": result["summary"]}
        if "timeline_has_transport" in expected:
            actual_has_transport = any("transport" in event for event in result["timeline"])
            if actual_has_transport != expected["timeline_has_transport"]:
                return {"expected": expected["timeline_has_transport"], "actual": actual_has_transport}
    else:
        error = result["error"]
        for key in ("error_code", "error_path", "precedence_row"):
            if key in expected:
                actual_key = {
                    "error_code": "code",
                    "error_path": "path",
                    "precedence_row": "precedence_row",
                }[key]
                actual = error[actual_key]
                if actual != expected[key]:
                    return {"expected": expected[key], "actual": actual}
    return None


def run_corpus(document: Any) -> Dict[str, Any]:
    corpus = require_record(document)
    if corpus.get("corpus_version") != PROTOCOL + "/v" + VERSION:
        raise ValueError("corpus version")
    envelopes = require_record(corpus.get("envelopes"))
    cases = corpus.get("cases")
    claims = require_record(corpus.get("claims"))
    if not isinstance(cases, list) or claims != CLAIMS:
        raise ValueError("corpus shape")

    validated_envelopes: Dict[str, Tuple[str, Dict[str, Any]]] = {}
    for envelope_name, envelope_fixture_value in envelopes.items():
        if not isinstance(envelope_name, str) or not envelope_name:
            raise ValueError("envelope fixture name")
        envelope_fixture = require_record(envelope_fixture_value)
        envelope_json = envelope_fixture.get("envelope_json")
        if not isinstance(envelope_json, str):
            raise ValueError("envelope fixture")
        envelope = decode_envelope(envelope_json)
        digest = canonical_envelope_digest(envelope)
        expected_binding = {
            "message_id": envelope["message_id"],
            "envelope_digest": digest,
            "sender": copy_agent(envelope["sender"]),
            "recipients": [
                copy_agent(recipient) for recipient in envelope["recipients"]
            ],
        }
        if (
            envelope_fixture.get("envelope_digest") != digest
            or envelope_fixture.get("expected_binding") != expected_binding
        ):
            raise ValueError("envelope fixture expectation")
        validated_envelopes[envelope_name] = (envelope_json, expected_binding)

    outcomes: List[Dict[str, Any]] = []
    failures: List[Dict[str, Any]] = []
    group_results: Dict[str, Dict[str, Any]] = {}
    seen_ids: set[str] = set()
    for fixture_value in cases:
        fixture = require_record(fixture_value)
        fixture_id = fixture.get("id")
        envelope_name = fixture.get("envelope")
        events = fixture.get("events")
        if not isinstance(fixture_id, str) or not fixture_id or fixture_id in seen_ids:
            raise ValueError("case id")
        if (
            not isinstance(envelope_name, str)
            or envelope_name not in validated_envelopes
            or not isinstance(events, list)
        ):
            raise ValueError("case input")
        seen_ids.add(fixture_id)
        envelope_json, _expected_binding = validated_envelopes[envelope_name]

        result = evaluate_delivery_trace({"envelope_json": envelope_json, "events": events})
        outcomes.append({"id": fixture_id, "result": result})
        mismatch = validate_expected(fixture, result, claims)
        if mismatch is not None:
            failures.append({"id": fixture_id, **mismatch})
        group = fixture.get("equivalence_group")
        if group is not None:
            if not isinstance(group, str) or not result["ok"]:
                raise ValueError("equivalence group")
            previous = group_results.get(group)
            if previous is None:
                group_results[group] = result
            elif previous != result:
                failures.append({"id": fixture_id, "expected": previous, "actual": result})

    return {"label": LABEL, "ok": not failures, "outcomes": outcomes, "failures": failures}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", required=True)
    args = parser.parse_args()
    try:
        document = strict_json_loads(Path(args.corpus).read_text(encoding="utf-8"))
        report = run_corpus(document)
    except (DuplicateMember, InvalidEnvelope, RawResourceLimit, json.JSONDecodeError, OSError, TypeError, ValueError):
        return invalid_corpus()
    print(stable_json(report))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
