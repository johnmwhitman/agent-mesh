from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any

PROFILE = "meshfleet.a2a.policy-replay.v0.1"
MAX_BYTES = 131072
MAX_DEPTH = 64
MAX_ACTIONS = 128
MAX_RULES = 128
MAX_CAPABILITIES = 64
MAX_LABEL_BYTES = 256
MAX_SAFE_INTEGER = 9007199254740991


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
        return "{" + ",".join(
            canonical(key) + ":" + canonical(value[key])
            for key in sorted(value.keys())
        ) + "}"
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


def exact_fields(value: Any, required: list[str], optional: list[str], context: str) -> None:
    if not isinstance(value, dict):
        reject("INVALID_FIELD", f"{context} must be an object")
    allowed = set(required + optional)
    for field in required:
        if field not in value:
            reject("MISSING_FIELD", f"{context}.{field} is required")
    for field in value:
        if field not in allowed:
            reject("UNKNOWN_FIELD", f"{context}.{field} is unknown")


def label(value: Any, context: str, wildcard: bool = False) -> None:
    if not valid_scalar_string(value) or len(value) == 0:
        reject("INVALID_FIELD", f"{context} must be a non-empty scalar string")
    if len(value.encode("utf-8")) > MAX_LABEL_BYTES:
        reject("LIMIT_EXCEEDED", f"{context} is too long")
    if not wildcard and value == "*":
        reject("INVALID_FIELD", f"{context} cannot be wildcard")


def safe_nonnegative(value: Any, context: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or abs(value) > MAX_SAFE_INTEGER:
        reject("INVALID_FIELD", f"{context} must be a safe integer")
    if value < 0:
        reject("INVALID_FIELD", f"{context} must be nonnegative")


def capabilities(value: Any, context: str) -> None:
    if not isinstance(value, list):
        reject("INVALID_FIELD", f"{context} must be an array")
    if len(value) > MAX_CAPABILITIES:
        reject("LIMIT_EXCEEDED", f"{context} is too large")
    seen: set[str] = set()
    for index, item in enumerate(value):
        label(item, f"{context}[{index}]")
        if item in seen:
            reject("DUPLICATE_CAPABILITY", f"{context} contains duplicate labels")
        seen.add(item)


def validate_scenario(scenario: Any) -> dict[str, Any]:
    exact_fields(scenario, ["profile", "case_id", "policy", "actions"], [], "scenario")
    if scenario["profile"] != PROFILE:
        reject("PROFILE_REJECT", "unsupported profile")
    label(scenario["case_id"], "scenario.case_id")
    policy = scenario["policy"]
    exact_fields(policy, ["namespace", "snapshot_id", "revocation_epoch", "rules"], [], "policy")
    label(policy["namespace"], "policy.namespace")
    label(policy["snapshot_id"], "policy.snapshot_id")
    safe_nonnegative(policy["revocation_epoch"], "policy.revocation_epoch")
    if not isinstance(policy["rules"], list):
        reject("INVALID_FIELD", "policy.rules must be an array")
    if len(policy["rules"]) > MAX_RULES:
        reject("LIMIT_EXCEEDED", "too many policy rules")
    rule_ids: set[str] = set()
    for index, rule in enumerate(policy["rules"]):
        context = f"policy.rules[{index}]"
        exact_fields(rule, ["rule_id", "effect", "principal", "resource", "action", "required_capabilities", "not_before", "expires_at"], [], context)
        label(rule["rule_id"], f"{context}.rule_id")
        if rule["rule_id"] in rule_ids:
            reject("DUPLICATE_RULE", f"duplicate rule {rule['rule_id']}")
        rule_ids.add(rule["rule_id"])
        if rule["effect"] not in ("allow", "deny"):
            reject("INVALID_FIELD", f"{context}.effect is invalid")
        label(rule["principal"], f"{context}.principal", True)
        label(rule["resource"], f"{context}.resource", True)
        label(rule["action"], f"{context}.action", True)
        capabilities(rule["required_capabilities"], f"{context}.required_capabilities")
        for field in ("not_before", "expires_at"):
            if rule[field] is not None:
                safe_nonnegative(rule[field], f"{context}.{field}")
        if rule["not_before"] is not None and rule["expires_at"] is not None and rule["expires_at"] <= rule["not_before"]:
            reject("INVALID_FIELD", f"{context} has an empty or inverted time window")
    if not isinstance(scenario["actions"], list):
        reject("INVALID_FIELD", "scenario.actions must be an array")
    if len(scenario["actions"]) > MAX_ACTIONS:
        reject("LIMIT_EXCEEDED", "too many actions")
    for index, action in enumerate(scenario["actions"]):
        context = f"actions[{index}]"
        exact_fields(action, ["request_id", "nonce", "namespace", "principal", "resource", "action", "capabilities", "policy_epoch", "at"], [], context)
        for field in ("request_id", "nonce", "namespace", "principal", "resource", "action"):
            label(action[field], f"{context}.{field}")
        capabilities(action["capabilities"], f"{context}.capabilities")
        safe_nonnegative(action["policy_epoch"], f"{context}.policy_epoch")
        safe_nonnegative(action["at"], f"{context}.at")
    return scenario


def selector_matches(selector: str, value: str) -> bool:
    return selector == "*" or selector == value


def includes_all(actual: list[str], required: list[str]) -> bool:
    available = set(actual)
    return all(item in available for item in required)


def lowest_rule(rules: list[dict[str, Any]]) -> str | None:
    return min((rule["rule_id"] for rule in rules), default=None)


def decide(policy: dict[str, Any], action: dict[str, Any]) -> dict[str, Any]:
    if action["policy_epoch"] < policy["revocation_epoch"]:
        return {"decision": "deny", "reason": "REVOCATION_EPOCH_STALE", "matched_rule_id": None}
    if action["namespace"] != policy["namespace"]:
        return {"decision": "deny", "reason": "NAMESPACE_MISMATCH", "matched_rule_id": None}
    scoped = [
        rule for rule in policy["rules"]
        if selector_matches(rule["principal"], action["principal"])
        and selector_matches(rule["resource"], action["resource"])
        and selector_matches(rule["action"], action["action"])
    ]
    capability_matched = [rule for rule in scoped if includes_all(action["capabilities"], rule["required_capabilities"])]
    active = [
        rule for rule in capability_matched
        if (rule["not_before"] is None or action["at"] >= rule["not_before"])
        and (rule["expires_at"] is None or action["at"] < rule["expires_at"])
    ]
    denies = [rule for rule in active if rule["effect"] == "deny"]
    if denies:
        return {"decision": "deny", "reason": "DENY_RULE", "matched_rule_id": lowest_rule(denies)}
    allows = [rule for rule in active if rule["effect"] == "allow"]
    if allows:
        return {"decision": "allow", "reason": "ALLOW_RULE", "matched_rule_id": lowest_rule(allows)}
    if any(not includes_all(action["capabilities"], rule["required_capabilities"]) for rule in scoped):
        return {"decision": "deny", "reason": "CAPABILITY_MISSING", "matched_rule_id": None}
    if any(rule["not_before"] is not None and action["at"] < rule["not_before"] for rule in capability_matched):
        return {"decision": "deny", "reason": "NOT_YET_VALID", "matched_rule_id": None}
    if any(rule["expires_at"] is not None and action["at"] >= rule["expires_at"] for rule in capability_matched):
        return {"decision": "deny", "reason": "EXPIRED", "matched_rule_id": None}
    return {"decision": "deny", "reason": "NO_MATCH", "matched_rule_id": None}


def fingerprint_input(policy: dict[str, Any], action: dict[str, Any]) -> dict[str, Any]:
    return {
        "action": action["action"],
        "at": action["at"],
        "capabilities": sorted(action["capabilities"]),
        "namespace": action["namespace"],
        "nonce": action["nonce"],
        "policy_epoch": action["policy_epoch"],
        "principal": action["principal"],
        "request_id": action["request_id"],
        "resource": action["resource"],
        "snapshot_id": policy["snapshot_id"],
    }


def public_state(state: dict[str, Any]) -> dict[str, Any]:
    return {"receipts": state["receipts"], "events": state["events"]}


def evaluate_scenario(input_value: Any) -> dict[str, Any]:
    scenario = validate_scenario(input_value)
    policy = scenario["policy"]
    state: dict[str, Any] = {"receipts": [], "events": [], "by_nonce": {}}
    command_results: list[dict[str, Any]] = []
    for index, action in enumerate(scenario["actions"]):
        pre = digest(public_state(state))
        fingerprint = fingerprint_input(policy, action)
        fingerprint_canonical = canonical(fingerprint)
        fingerprint_sha256 = digest(fingerprint)
        existing = state["by_nonce"].get(action["nonce"])
        if existing is not None:
            if existing["fingerprint_canonical"] == fingerprint_canonical:
                result = {
                    "index": index, "accepted": True, "outcome": "replayed",
                    "decision": existing["decision"], "reason": existing["reason"],
                    "error": None, "matched_rule_id": existing["matched_rule_id"],
                    "request_fingerprint_sha256": fingerprint_sha256, "state_mutated": False,
                }
            else:
                result = {
                    "index": index, "accepted": False, "outcome": "rejected",
                    "decision": None, "reason": None, "error": "NONCE_REPLAY_CONFLICT",
                    "matched_rule_id": None, "request_fingerprint_sha256": fingerprint_sha256,
                    "state_mutated": False,
                }
        elif action["policy_epoch"] > policy["revocation_epoch"]:
            result = {
                "index": index, "accepted": False, "outcome": "rejected",
                "decision": None, "reason": None, "error": "POLICY_EPOCH_AHEAD",
                "matched_rule_id": None, "request_fingerprint_sha256": fingerprint_sha256,
                "state_mutated": False,
            }
        else:
            decision = decide(policy, action)
            receipt = {
                "seq": len(state["receipts"]), "nonce": action["nonce"],
                "request_id": action["request_id"], "request_fingerprint_sha256": fingerprint_sha256,
                "decision": decision["decision"], "reason": decision["reason"],
                "matched_rule_id": decision["matched_rule_id"], "first_action_index": index,
            }
            state["receipts"].append(receipt)
            state["events"].append({
                "seq": len(state["events"]), "kind": "decision_recorded",
                "nonce": action["nonce"], "decision": decision["decision"], "reason": decision["reason"],
            })
            state["by_nonce"][action["nonce"]] = {**receipt, "fingerprint_canonical": fingerprint_canonical}
            result = {
                "index": index, "accepted": True, "outcome": "decided",
                "decision": decision["decision"], "reason": decision["reason"], "error": None,
                "matched_rule_id": decision["matched_rule_id"],
                "request_fingerprint_sha256": fingerprint_sha256, "state_mutated": True,
            }
        post = digest(public_state(state))
        command_results.append({**result, "pre_state_sha256": pre, "post_state_sha256": post})
    return {
        "profile": PROFILE, "case_id": scenario["case_id"],
        "policy_snapshot_id": policy["snapshot_id"], "receipts": state["receipts"],
        "events": state["events"], "command_results": command_results,
        "state_sha256": digest(public_state(state)),
    }


def evaluate_bytes(raw: bytes | str) -> dict[str, Any]:
    return evaluate_scenario(parse_strict_json(raw))


def projection(result: dict[str, Any]) -> dict[str, Any]:
    return {
        "case_id": result["case_id"],
        "decisions": [{
            "accepted": item["accepted"], "outcome": item["outcome"],
            "decision": item["decision"], "reason": item["reason"], "error": item["error"],
            "matched_rule_id": item["matched_rule_id"], "state_mutated": item["state_mutated"],
        } for item in result["command_results"]],
        "receipt_count": len(result["receipts"]),
        "event_kinds": [event["kind"] for event in result["events"]],
    }
