from __future__ import annotations

import hashlib
import json
from typing import Any

PROFILE = "meshfleet.a2a.handoff-quorum.v0.1"
MAX_BYTES = 131072
MAX_DEPTH = 64
MAX_ACTIONS = 128
MAX_VOTERS = 128
MAX_WEIGHT = 1000000
MAX_TOTAL_WEIGHT = 10000000
MAX_SAFE = 9007199254740991


class ConformanceError(Exception):
    def __init__(self, code: str, message: str | None = None):
        super().__init__(message or code)
        self.code = code


def fail(code: str, message: str | None = None) -> None:
    raise ConformanceError(code, message)


def valid_scalar_string(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    return not any(0xD800 <= ord(char) <= 0xDFFF for char in value)


def _validate_value(value: Any, depth: int = 0) -> None:
    if depth > MAX_DEPTH:
        fail("DEPTH_LIMIT")
    if value is None or isinstance(value, bool):
        return
    if isinstance(value, int):
        if abs(value) > MAX_SAFE:
            fail("UNSAFE_INTEGER")
        return
    if isinstance(value, str):
        if not valid_scalar_string(value):
            fail("INVALID_UNICODE")
        return
    if isinstance(value, list):
        for item in value:
            _validate_value(item, depth + 1)
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not valid_scalar_string(key):
                fail("INVALID_UNICODE")
            _validate_value(item, depth + 1)
        return
    fail("INVALID_SCENARIO")


def canonical(value: Any) -> str:
    _validate_value(value)
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list):
        return "[" + ",".join(canonical(item) for item in value) + "]"
    keys = sorted(value.keys())
    return "{" + ",".join(canonical(key) + ":" + canonical(value[key]) for key in keys) + "}"


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def parse_strict_json(raw: bytes | str) -> Any:
    if isinstance(raw, str):
        raw = raw.encode("utf-8")
    if not isinstance(raw, bytes):
        fail("INVALID_SCENARIO")
    if len(raw) > MAX_BYTES:
        fail("SIZE_LIMIT")
    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        fail("INVALID_UTF8")

    def pairs_hook(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                fail("DUPLICATE_MEMBER")
            result[key] = value
        return result

    def parse_int(token: str) -> int:
        if token == "-0":
            fail("NON_CANONICAL_INTEGER")
        value = int(token)
        if abs(value) > MAX_SAFE:
            fail("UNSAFE_INTEGER")
        return value

    def parse_float(_: str) -> None:
        fail("NON_CANONICAL_INTEGER")

    def parse_constant(_: str) -> None:
        fail("NON_CANONICAL_INTEGER")

    try:
        value = json.loads(
            text,
            object_pairs_hook=pairs_hook,
            parse_int=parse_int,
            parse_float=parse_float,
            parse_constant=parse_constant,
        )
    except ConformanceError:
        raise
    except (json.JSONDecodeError, RecursionError):
        fail("MALFORMED_JSON")
    _validate_value(value)
    return value


def require_object(value: Any, code: str = "INVALID_SCENARIO") -> dict[str, Any]:
    if not isinstance(value, dict):
        fail(code)
    return value


def exact(value: dict[str, Any], required: list[str]) -> None:
    for key in required:
        if key not in value:
            fail("MISSING_FIELD", key)
    for key in value:
        if key not in required:
            fail("UNKNOWN_FIELD", key)


def identifier(value: Any) -> bool:
    return isinstance(value, str) and len(value) > 0 and valid_scalar_string(value)


def integer(value: Any) -> bool:
    return type(value) is int and 0 <= value <= MAX_SAFE


def validate_scenario(raw: Any) -> dict[str, Any]:
    scenario = require_object(raw)
    exact(scenario, ["profile", "case_id", "proposal", "actions"])
    if scenario["profile"] != PROFILE:
        fail("PROFILE_REJECT")
    if not identifier(scenario["case_id"]):
        fail("INVALID_FIELD")
    proposal = require_object(scenario["proposal"])
    exact(proposal, [
        "proposal_id", "voters", "required_signoffs", "quorum", "weights", "deadline", "silence_policy"
    ])
    if not identifier(proposal["proposal_id"]):
        fail("INVALID_FIELD")
    voters = proposal["voters"]
    if not isinstance(voters, list) or not 1 <= len(voters) <= MAX_VOTERS or not all(identifier(v) for v in voters):
        fail("INVALID_FIELD")
    if len(set(voters)) != len(voters):
        fail("DUPLICATE_VOTER")
    signoffs = proposal["required_signoffs"]
    if not isinstance(signoffs, list) or not all(identifier(v) for v in signoffs):
        fail("INVALID_FIELD")
    if len(set(signoffs)) != len(signoffs) or any(v not in voters for v in signoffs):
        fail("INVALID_SIGNOFF")
    weights = require_object(proposal["weights"])
    for voter, weight in weights.items():
        if voter not in voters or type(weight) is not int or not 1 <= weight <= MAX_WEIGHT:
            fail("INVALID_WEIGHT")
    total_weight = sum(weights.get(voter, 1) for voter in voters)
    if total_weight > MAX_TOTAL_WEIGHT:
        fail("INVALID_WEIGHT")
    quorum = proposal["quorum"]
    if type(quorum) is not int or not 1 <= quorum <= total_weight:
        fail("INVALID_QUORUM")
    if proposal["deadline"] is not None and not integer(proposal["deadline"]):
        fail("INVALID_FIELD")
    if proposal["silence_policy"] not in ("abstain", "approve"):
        fail("INVALID_FIELD")
    actions = scenario["actions"]
    if not isinstance(actions, list) or len(actions) > MAX_ACTIONS:
        fail("INVALID_FIELD")
    previous_at = -1
    for action in actions:
        action = require_object(action)
        if action.get("op") == "vote":
            exact(action, ["op", "at", "receipt_id", "voter_id", "seq", "decision"])
            if (
                not integer(action["at"])
                or not integer(action["seq"])
                or not identifier(action["receipt_id"])
                or not identifier(action["voter_id"])
                or action["decision"] not in ("approve", "decline")
            ):
                fail("INVALID_FIELD")
        elif action.get("op") == "resolve":
            exact(action, ["op", "at"])
            if not integer(action["at"]):
                fail("INVALID_FIELD")
        else:
            fail("INVALID_FIELD")
        if action["at"] < previous_at:
            fail("NON_MONOTONIC_TIME")
        previous_at = action["at"]
    return scenario


def public_state(state: dict[str, Any]) -> dict[str, Any]:
    return {
        "proposal": state["proposal"],
        "status": state["status"],
        "resolved_at": state["resolved_at"],
        "votes": state["votes"],
        "events": state["events"],
    }


def tally(state: dict[str, Any], now: int) -> dict[str, Any]:
    proposal = state["proposal"]
    voters = proposal["voters"]
    effective = state["effective"]
    approvals = [v for v in voters if effective.get(v, {}).get("decision") == "approve"]
    declines = [v for v in voters if effective.get(v, {}).get("decision") == "decline"]
    pending = [v for v in voters if v not in effective]

    def weight(voter: str) -> int:
        return proposal["weights"].get(voter, 1)

    approval_weight = sum(weight(v) for v in approvals)
    decline_weight = sum(weight(v) for v in declines)
    pending_weight = sum(weight(v) for v in pending)
    signoffs_met = all(effective.get(v, {}).get("decision") == "approve" for v in proposal["required_signoffs"])
    signoff_rejected = any(effective.get(v, {}).get("decision") == "decline" for v in proposal["required_signoffs"])
    deadline_passed = proposal["deadline"] is not None and now >= proposal["deadline"]
    effective_approval_weight = approval_weight
    if deadline_passed and proposal["silence_policy"] == "approve":
        effective_approval_weight += pending_weight
    reachable = approval_weight + pending_weight >= proposal["quorum"] and not signoff_rejected
    status = state["status"]
    if status == "open":
        if signoff_rejected or not reachable:
            status = "rejected"
        elif effective_approval_weight >= proposal["quorum"] and signoffs_met:
            status = "ratified"
        elif deadline_passed:
            status = "expired"
    return {
        "status": status,
        "approvals": approvals,
        "declines": declines,
        "pending": pending,
        "required_signoffs": proposal["required_signoffs"],
        "signoffs_met": signoffs_met,
        "reachable": reachable,
        "approval_weight": approval_weight,
        "decline_weight": decline_weight,
        "pending_weight": pending_weight,
        "total_weight": approval_weight + decline_weight + pending_weight,
    }


def append_event(state: dict[str, Any], kind: str, at: int, detail: dict[str, Any]) -> None:
    state["events"].append({"seq": len(state["events"]), "kind": kind, "at": at, **detail})


def evaluate_scenario(raw: Any) -> dict[str, Any]:
    scenario = validate_scenario(raw)
    state: dict[str, Any] = {
        "proposal": json.loads(json.dumps(scenario["proposal"], ensure_ascii=False)),
        "status": "open",
        "resolved_at": None,
        "votes": [],
        "events": [],
        "effective": {},
        "receipt_content": {},
    }
    command_results = []
    for index, action in enumerate(scenario["actions"]):
        pre = digest(public_state(state))
        accepted = True
        outcome = None
        error = None
        if action["op"] == "vote":
            fingerprint = canonical(action)
            prior = state["receipt_content"].get(action["receipt_id"])
            if prior is not None:
                if prior == fingerprint:
                    outcome = "idempotent_replay"
                else:
                    accepted = False
                    error = "RECEIPT_REPLAY_CONFLICT"
            elif state["status"] != "open":
                accepted = False
                error = "RATIFICATION_TERMINAL"
            elif action["voter_id"] not in state["proposal"]["voters"]:
                accepted = False
                error = "UNKNOWN_VOTER"
            else:
                current = state["effective"].get(action["voter_id"])
                expected_seq = current["seq"] + 1 if current else 0
                if action["seq"] != expected_seq:
                    accepted = False
                    error = "VOTE_SEQUENCE"
                elif current and current["decision"] == action["decision"]:
                    accepted = False
                    error = "VOTE_NO_CHANGE"
                else:
                    vote = {
                        "receipt_id": action["receipt_id"],
                        "voter_id": action["voter_id"],
                        "seq": action["seq"],
                        "decision": action["decision"],
                        "at": action["at"],
                    }
                    state["votes"].append(vote)
                    state["effective"][action["voter_id"]] = vote
                    state["receipt_content"][action["receipt_id"]] = fingerprint
                    append_event(state, "vote_recorded", action["at"], {
                        "receipt_id": action["receipt_id"],
                        "voter_id": action["voter_id"],
                        "vote_seq": action["seq"],
                        "decision": action["decision"],
                    })
                    outcome = "vote_recorded"
        else:
            if state["status"] != "open":
                outcome = state["status"]
            else:
                current = tally(state, action["at"])
                if current["status"] != "open":
                    state["status"] = current["status"]
                    state["resolved_at"] = action["at"]
                    append_event(state, "ratification_resolved", action["at"], {"status": current["status"]})
                outcome = current["status"]
        post = digest(public_state(state))
        command_results.append({
            "index": index,
            "op": action["op"],
            "accepted": accepted,
            "outcome": outcome,
            "error": error,
            "pre_state_sha256": pre,
            "post_state_sha256": post,
        })
    now = scenario["actions"][-1]["at"] if scenario["actions"] else 0
    return {
        "profile": PROFILE,
        "case_id": scenario["case_id"],
        "status": state["status"],
        "resolved_at": state["resolved_at"],
        "tally": tally(state, now),
        "votes": state["votes"],
        "events": state["events"],
        "command_results": command_results,
        "state_sha256": digest(public_state(state)),
    }


def evaluate_bytes(raw: bytes) -> dict[str, Any]:
    return evaluate_scenario(parse_strict_json(raw))


def projection(result: dict[str, Any]) -> dict[str, Any]:
    tally_value = result["tally"]
    return {
        "case_id": result["case_id"],
        "stored_status": result["status"],
        "tally_status": tally_value["status"],
        "approvals": tally_value["approvals"],
        "declines": tally_value["declines"],
        "pending": tally_value["pending"],
        "signoffs_met": tally_value["signoffs_met"],
        "reachable": tally_value["reachable"],
        "approval_weight": tally_value["approval_weight"],
        "decline_weight": tally_value["decline_weight"],
        "pending_weight": tally_value["pending_weight"],
        "total_weight": tally_value["total_weight"],
        "accepted_actions": sum(1 for item in result["command_results"] if item["accepted"]),
        "rejected_actions": sum(1 for item in result["command_results"] if not item["accepted"]),
        "error_codes": [item["error"] for item in result["command_results"] if item["error"]],
        "event_kinds": [item["kind"] for item in result["events"]],
    }
