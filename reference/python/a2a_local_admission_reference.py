#!/usr/bin/env python3
import argparse
import json
import sys
from pathlib import Path
from typing import Any

from a2a_reference import canonical_envelope_digest, strict_json_loads, validate_envelope

PROFILE = "meshfleet.a2a.local-admission.v0.1"
BINDING = "meshfleet.a2a.binding-snapshot.v0.1"
AUTHORIZATION = "meshfleet.a2a.authorization-snapshot.v0.1"
ACTION = "a2a.message.admit"
MAX_BYTES = 262144
MAX_DEPTH = 8
MAX_SAFE = 9007199254740991
OPAQUE = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:@/-")
MESSAGE_TYPES = {"handoff", "question", "result", "alert", "request_help"}

class RawProblem(Exception):
    def __init__(self, code: str, path: str):
        self.code = code
        self.path = path

def stable(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

def reject(code: str, path: str) -> dict[str, Any]:
    return {"kind": "rejected", "code": code, "field_path": path}

def member(path: str, name: str) -> str:
    return path + "." + name if name.replace("_", "").isalnum() and name[:1].isalpha() else path

def record(value: Any) -> bool:
    return isinstance(value, dict)

def opaque(value: Any) -> bool:
    return isinstance(value, str) and 1 <= len(value) <= 128 and value[0].isalnum() and all(char in OPAQUE for char in value)

def adapter(value: Any) -> bool:
    if not isinstance(value, str) or not (1 <= len(value) <= 64):
        return False
    if not value[0].isalnum() or not value[-1].isalnum():
        return False
    return all(char.isdigit() or ("a" <= char <= "z") or char in ".-" for char in value)

def local_time(value: Any) -> bool:
    return type(value) is int and 0 <= value <= MAX_SAFE

def agent(value: Any) -> bool:
    return record(value) and set(value) == {"namespace", "agent_id"} and all(isinstance(value[key], str) and value[key] and value[key] != "*" for key in ("namespace", "agent_id"))

def same_agent(left: dict[str, Any], right: dict[str, Any]) -> bool:
    return left["namespace"] == right["namespace"] and left["agent_id"] == right["agent_id"]

def ref_key(value: dict[str, Any]) -> str:
    return value["namespace"] + "\0" + value["agent_id"]

class Scanner:
    def __init__(self, source: str):
        self.source = source
        self.index = 0

    def bad(self, code: str, path: str) -> None:
        raise RawProblem(code, path)

    def whitespace(self) -> None:
        while self.index < len(self.source) and self.source[self.index] in " \t\n\r":
            self.index += 1

    def parse(self) -> Any:
        self.whitespace()
        self.value(1, ROOT, "$")
        self.whitespace()
        if self.index != len(self.source):
            self.bad("MALFORMED_JSON", "$")
        try:
            return json.loads(self.source)
        except Exception:
            self.bad("MALFORMED_JSON", "$")

    def value(self, depth: int, known: Any, path: str) -> None:
        if depth > MAX_DEPTH:
            self.bad("MAX_DEPTH_EXCEEDED", path)
        char = self.source[self.index] if self.index < len(self.source) else ""
        if char == "{":
            self.object(depth, known, path)
        elif char == "[":
            self.array(depth, known, path)
        elif char == '"':
            self.string(path)
        elif char == "t":
            self.literal("true", path)
        elif char == "f":
            self.literal("false", path)
        elif char == "n":
            self.literal("null", path)
        elif char == "-" or char.isdigit():
            self.number(path)
        else:
            self.bad("MALFORMED_JSON", path)

    def object(self, depth: int, known: Any, path: str) -> None:
        self.index += 1
        self.whitespace()
        names: set[str] = set()
        if self.index < len(self.source) and self.source[self.index] == "}":
            self.index += 1
            return
        while True:
            if self.index >= len(self.source) or self.source[self.index] != '"':
                self.bad("MALFORMED_JSON", path)
            name = self.string(path)
            if name in names:
                self.bad("DUPLICATE_JSON_KEY", path)
            names.add(name)
            self.whitespace()
            if self.index >= len(self.source) or self.source[self.index] != ":":
                self.bad("MALFORMED_JSON", path)
            self.index += 1
            self.whitespace()
            known_member = record(known) and name in known
            child = known[name] if known_member else None
            child_path = member(path, name) if known_member else path
            self.value(depth + 1, child, child_path)
            self.whitespace()
            if self.index < len(self.source) and self.source[self.index] == "}":
                self.index += 1
                return
            if self.index >= len(self.source) or self.source[self.index] != ",":
                self.bad("MALFORMED_JSON", path)
            self.index += 1
            self.whitespace()

    def array(self, depth: int, known: Any, path: str) -> None:
        self.index += 1
        self.whitespace()
        if self.index < len(self.source) and self.source[self.index] == "]":
            self.index += 1
            return
        position = 0
        while True:
            known_member = isinstance(known, list) and bool(known)
            child = known[0] if known_member else None
            self.value(depth + 1, child, f"{path}[{position}]" if known_member else path)
            self.whitespace()
            if self.index < len(self.source) and self.source[self.index] == "]":
                self.index += 1
                return
            if self.index >= len(self.source) or self.source[self.index] != ",":
                self.bad("MALFORMED_JSON", path)
            self.index += 1
            self.whitespace()
            position += 1

    def string(self, path: str) -> str:
        start = self.index
        self.index += 1
        while self.index < len(self.source):
            code = ord(self.source[self.index])
            if code == 34:
                self.index += 1
                try:
                    value = json.loads(self.source[start:self.index])
                    if any(0xD800 <= ord(char) <= 0xDFFF for char in value):
                        self.bad("MALFORMED_JSON", path)
                    return value
                except RawProblem:
                    raise
                except Exception:
                    self.bad("MALFORMED_JSON", path)
            if code < 32:
                self.bad("MALFORMED_JSON", path)
            if code == 92:
                self.index += 1
                escaped = self.source[self.index] if self.index < len(self.source) else ""
                if escaped == "u":
                    if self.index + 4 >= len(self.source) or any(char not in "0123456789abcdefABCDEF" for char in self.source[self.index + 1:self.index + 5]):
                        self.bad("MALFORMED_JSON", path)
                    self.index += 5
                    continue
                if escaped not in '"\\/bfnrt':
                    self.bad("MALFORMED_JSON", path)
            self.index += 1
        self.bad("MALFORMED_JSON", path)

    def literal(self, text: str, path: str) -> None:
        if self.source[self.index:self.index + len(text)] != text:
            self.bad("MALFORMED_JSON", path)
        self.index += len(text)

    def number(self, path: str) -> None:
        start = self.index
        if self.source[self.index:self.index + 1] == "-":
            self.index += 1
        if self.source[self.index:self.index + 1] == "0":
            self.index += 1
        else:
            digit = self.index
            while self.index < len(self.source) and self.source[self.index].isdigit():
                self.index += 1
            if digit == self.index:
                self.bad("MALFORMED_JSON", path)
        if self.source[self.index:self.index + 1] == ".":
            self.index += 1
            digit = self.index
            while self.index < len(self.source) and self.source[self.index].isdigit():
                self.index += 1
            if digit == self.index:
                self.bad("MALFORMED_JSON", path)
        if self.source[self.index:self.index + 1] in ("e", "E"):
            self.index += 1
            if self.source[self.index:self.index + 1] in ("+", "-"):
                self.index += 1
            digit = self.index
            while self.index < len(self.source) and self.source[self.index].isdigit():
                self.index += 1
            if digit == self.index:
                self.bad("MALFORMED_JSON", path)
        raw = self.source[start:self.index]
        if not raw.isdigit() or (len(raw) > 1 and raw[0] == "0") or int(raw) > MAX_SAFE:
            self.bad("MALFORMED_JSON", path)

ROOT = {
    "version": None,
    "evaluation_time_ms": None,
    "request_id": None,
    "action": None,
    "authentication_evidence": {"adapter_id": None, "principal_ref": None, "audience": None, "session_ref": None, "issued_at_ms": None, "expires_at_ms": None, "provenance": None},
    "binding_snapshot": {"snapshot_version": None, "snapshot_id": None, "fixture_provenance": None, "effective_from_ms": None, "effective_until_ms": None, "rules": []},
    "authorization_snapshot": {"snapshot_version": None, "snapshot_id": None, "fixture_provenance": None, "effective_from_ms": None, "effective_until_ms": None, "rules": []},
}

def parse_request(source: Any) -> dict[str, Any]:
    if not isinstance(source, str) or source.startswith("\ufeff"):
        return reject("INVALID_UTF8", "$")
    try:
        if len(source.encode("utf-8")) > MAX_BYTES:
            return reject("REQUEST_TOO_LARGE", "$")
    except UnicodeEncodeError:
        return reject("INVALID_UTF8", "$")
    try:
        value = Scanner(source).parse()
    except RawProblem as error:
        return reject(error.code, error.path)
    return value if record(value) else reject("INVALID_REQUEST", "$")

def issue(code: str, path: str) -> dict[str, Any]:
    return reject(code, path)

def fields(value: Any, names: list[str], code: str, path: str) -> dict[str, Any] | None:
    if not record(value):
        return issue(code, path)
    for name in names:
        if name not in value:
            return issue(code, member(path, name))
    if any(name not in names for name in value):
        return issue(code, path)
    return None

def check_evidence(value: Any) -> dict[str, Any]:
    path = "$.authentication_evidence"
    names = ["adapter_id", "principal_ref", "audience", "session_ref", "issued_at_ms", "expires_at_ms", "provenance"]
    failed = fields(value, names, "INVALID_AUTHENTICATION_EVIDENCE", path)
    if failed:
        return failed
    checks = [
        (adapter(value["adapter_id"]), "adapter_id"),
        (opaque(value["principal_ref"]), "principal_ref"),
        (opaque(value["audience"]), "audience"),
        (opaque(value["session_ref"]), "session_ref"),
        (local_time(value["issued_at_ms"]), "issued_at_ms"),
        (local_time(value["expires_at_ms"]), "expires_at_ms"),
        (value["provenance"] == "trusted_local_adapter", "provenance"),
    ]
    for ok, name in checks:
        if not ok:
            return issue("INVALID_AUTHENTICATION_EVIDENCE", member(path, name))
    return value

def check_snapshot(value: Any, kind: str) -> dict[str, Any]:
    path = "$.binding_snapshot" if kind == "binding" else "$.authorization_snapshot"
    code = "INVALID_BINDING_SNAPSHOT" if kind == "binding" else "INVALID_AUTHORIZATION_SNAPSHOT"
    names = ["snapshot_version", "snapshot_id", "fixture_provenance", "effective_from_ms", "effective_until_ms", "rules"]
    failed = fields(value, names, code, path)
    if failed:
        return failed
    version = BINDING if kind == "binding" else AUTHORIZATION
    if value["snapshot_version"] != version:
        return issue(code, member(path, "snapshot_version"))
    if not opaque(value["snapshot_id"]):
        return issue(code, member(path, "snapshot_id"))
    if value["fixture_provenance"] != "caller_supplied_fixture":
        return issue(code, member(path, "fixture_provenance"))
    if not local_time(value["effective_from_ms"]):
        return issue(code, member(path, "effective_from_ms"))
    if not local_time(value["effective_until_ms"]):
        return issue(code, member(path, "effective_until_ms"))
    maximum = 256 if kind == "binding" else 2048
    if not isinstance(value["rules"], list) or len(value["rules"]) > maximum:
        return issue(code, member(path, "rules"))
    seen: set[str] = set()
    output: list[dict[str, Any]] = []
    for index, rule in enumerate(value["rules"]):
        rule_path = f"{path}.rules[{index}]"
        names = ["adapter_id", "principal_ref", "audience", "session_ref", "sender"]
        if kind != "binding":
            names += ["action", "message_types", "recipients"]
        failed = fields(rule, names, code, rule_path)
        if failed:
            return failed
        checks = [
            (adapter(rule["adapter_id"]), "adapter_id"),
            (opaque(rule["principal_ref"]), "principal_ref"),
            (opaque(rule["audience"]), "audience"),
            (opaque(rule["session_ref"]), "session_ref"),
            (agent(rule["sender"]), "sender"),
        ]
        for ok, name in checks:
            if not ok:
                return issue(code, member(rule_path, name))
        base_key = "\0".join([rule["adapter_id"], rule["principal_ref"], rule["audience"], rule["session_ref"]])
        if kind == "binding":
            if base_key in seen:
                return issue(code, rule_path)
            seen.add(base_key)
            output.append(rule)
            continue
        if rule["action"] != ACTION:
            return issue(code, member(rule_path, "action"))
        if not isinstance(rule["message_types"], list) or not 1 <= len(rule["message_types"]) <= 5:
            return issue(code, member(rule_path, "message_types"))
        types: set[str] = set()
        for type_index, message_type in enumerate(rule["message_types"]):
            if not isinstance(message_type, str) or message_type not in MESSAGE_TYPES or message_type in types:
                return issue(code, f"{rule_path}.message_types[{type_index}]")
            types.add(message_type)
        if not isinstance(rule["recipients"], list) or not 1 <= len(rule["recipients"]) <= 128:
            return issue(code, member(rule_path, "recipients"))
        recipients: set[str] = set()
        for recipient_index, recipient in enumerate(rule["recipients"]):
            if not agent(recipient) or ref_key(recipient) in recipients:
                return issue(code, f"{rule_path}.recipients[{recipient_index}]")
            recipients.add(ref_key(recipient))
        full_key = "\0".join([base_key, ref_key(rule["sender"]), ACTION])
        if full_key in seen:
            return issue(code, rule_path)
        seen.add(full_key)
        output.append(rule)
    return {**value, "rules": output}

def envelope_path(error: Exception) -> str:
    text = str(error)
    for field in ["sender", "recipients", "payload", "scope", "protocol", "version", "kind", "message_id", "type", "issued_at_ms", "expires_at_ms", "audience", "correlation_id", "dedupe_key"]:
        if field in text:
            return "$.envelope." + field
    return "$.envelope"

def evaluate_local_admission(request_json: str, envelope_json: str, replay_oracle) -> dict[str, Any]:
    request = parse_request(request_json)
    if "kind" in request:
        return request
    names = ["version", "evaluation_time_ms", "request_id", "action", "authentication_evidence", "binding_snapshot", "authorization_snapshot"]
    for name in names:
        if name not in request:
            return issue("MISSING_REQUIRED_FIELD", member("$", name))
    if any(name not in names for name in request):
        return issue("UNKNOWN_CORE_FIELD", "$")
    if request["version"] != PROFILE:
        return issue("UNSUPPORTED_PROFILE_VERSION", "$.version")
    if not local_time(request["evaluation_time_ms"]):
        return issue("INVALID_EVALUATION_TIME", "$.evaluation_time_ms")
    if not opaque(request["request_id"]):
        return issue("INVALID_REQUEST_ID", "$.request_id")
    if request["action"] != ACTION:
        return issue("INVALID_REQUEST", "$.action")
    try:
        envelope = validate_envelope(strict_json_loads(envelope_json))
        digest = canonical_envelope_digest(envelope)
    except Exception as error:
        return issue("MALFORMED_ENVELOPE", envelope_path(error))
    evidence = check_evidence(request["authentication_evidence"])
    if "kind" in evidence:
        return evidence
    binding = check_snapshot(request["binding_snapshot"], "binding")
    if "kind" in binding:
        return binding
    authorization = check_snapshot(request["authorization_snapshot"], "authorization")
    if "kind" in authorization:
        return authorization
    now = request["evaluation_time_ms"]
    if evidence["issued_at_ms"] > now or now >= evidence["expires_at_ms"] or evidence["expires_at_ms"] - evidence["issued_at_ms"] > 300000 or binding["effective_from_ms"] >= binding["effective_until_ms"] or authorization["effective_from_ms"] >= authorization["effective_until_ms"] or not (binding["effective_from_ms"] <= now < binding["effective_until_ms"]) or not (authorization["effective_from_ms"] <= now < authorization["effective_until_ms"]):
        return issue("AUTHORIZATION_DENIED", "$")
    def context(rule: dict[str, Any]) -> bool:
        return all(rule[key] == evidence[key] for key in ["adapter_id", "principal_ref", "audience", "session_ref"])
    matching = next((rule for rule in binding["rules"] if context(rule)), None)
    if matching is None or not same_agent(matching["sender"], envelope["sender"]) or envelope.get("audience") != evidence["audience"]:
        return issue("AUTHORIZATION_DENIED", "$")
    policy = next((rule for rule in authorization["rules"] if context(rule) and same_agent(rule["sender"], envelope["sender"]) and rule["action"] == ACTION), None)
    if policy is None or envelope["type"] not in policy["message_types"] or any(not any(same_agent(recipient, allowed) for allowed in policy["recipients"]) for recipient in envelope["recipients"]):
        return issue("AUTHORIZATION_DENIED", "$")
    argument = {
        "principal_ref": evidence["principal_ref"],
        "request_id": request["request_id"],
        "sender": {"namespace": envelope["sender"]["namespace"], "agent_id": envelope["sender"]["agent_id"]},
        "message_id": envelope["message_id"],
        "envelope_digest": digest,
    }
    try:
        verdict = replay_oracle(argument)
    except Exception:
        return issue("REPLAY_PROTECTION_UNAVAILABLE", "$")
    if verdict in {"replayed_request", "request_id_reuse", "duplicate", "message_id_conflict"}:
        return {"kind": "not_admitted", "disposition": verdict}
    if verdict != "unseen":
        return issue("REPLAY_PROTECTION_UNAVAILABLE", "$")
    if envelope.get("expires_at_ms") is not None and envelope["expires_at_ms"] <= now:
        return {"kind": "not_admitted", "disposition": "expired_at_acceptance"}
    return {
        "kind": "admission_plan",
        "version": PROFILE,
        "request_identity": {"principal_ref": evidence["principal_ref"], "request_id": request["request_id"]},
        "semantic_identity": {"sender": {"namespace": envelope["sender"]["namespace"], "agent_id": envelope["sender"]["agent_id"]}, "message_id": envelope["message_id"]},
        "action": ACTION,
        "audience": evidence["audience"],
        "message_type": envelope["type"],
        "recipients": [{"namespace": item["namespace"], "agent_id": item["agent_id"]} for item in envelope["recipients"]],
        "envelope_digest": digest,
        "evaluation_time_ms": now,
        "policy_basis": {
            "binding_snapshot": {"snapshot_version": binding["snapshot_version"], "snapshot_id": binding["snapshot_id"], "effective_from_ms": binding["effective_from_ms"], "effective_until_ms": binding["effective_until_ms"]},
            "authorization_snapshot": {"snapshot_version": authorization["snapshot_version"], "snapshot_id": authorization["snapshot_id"], "effective_from_ms": authorization["effective_from_ms"], "effective_until_ms": authorization["effective_until_ms"]},
        },
    }

def oracle(value: Any, calls: list[dict[str, Any]]):
    def invoke(argument: dict[str, Any]) -> Any:
        calls.append(argument)
        if value == "throws":
            raise RuntimeError("fixture")
        return value
    return invoke

def run_corpus(path: Path, mutate_output: bool) -> dict[str, Any]:
    corpus = json.loads(path.read_text(encoding="utf-8"))
    cases = corpus["cases"]
    failures: list[str] = []
    outputs: list[dict[str, Any]] = []
    for position, case in enumerate(cases):
        arguments = case["invocation_args"]
        calls: list[dict[str, Any]] = []
        result = evaluate_local_admission(arguments["request_json"], arguments["envelope_json"], oracle(arguments["replay_oracle_result"], calls))
        if mutate_output and position == 0:
            result = {"kind": "rejected", "code": "INVALID_REQUEST", "field_path": "$"}
        actual = {"result": result, "replay_oracle_calls": len(calls), "replay_oracle_arguments": calls}
        if stable(actual) != stable(case["expected"]):
            failures.append(case["id"])
        outputs.append({"id": case["id"], "result_json": stable(result), "replay_oracle_calls": len(calls), "replay_oracle_arguments": calls})
    return {"ok": not failures, "case_count": len(cases), "outputs": outputs, "failures": failures}

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus")
    parser.add_argument("--mutate-output", action="store_true")
    parser.add_argument("--evaluate-file")
    args = parser.parse_args()
    if args.corpus:
        report = run_corpus(Path(args.corpus), args.mutate_output)
        print(stable(report))
        return 0 if report["ok"] else 1
    if args.evaluate_file:
        invocation = json.loads(Path(args.evaluate_file).read_text(encoding="utf-8"))
        calls: list[dict[str, Any]] = []
        result = evaluate_local_admission(invocation["request_json"], invocation["envelope_json"], oracle(invocation["replay_oracle_result"], calls))
        print(stable({"result": result, "replay_oracle_calls": len(calls), "replay_oracle_arguments": calls}))
        return 0
    parser.error("one input is required")
    return 2

if __name__ == "__main__":
    raise SystemExit(main())
