from __future__ import annotations

import hashlib
import json
import re
from typing import Any

PROFILE = "meshfleet.a2a.two-host-coordinator.v0.1"
SAFE_MAX = 9007199254740991
MAX_BYTES = 131072
MAX_DEPTH = 64
MAX_COMMANDS = 128
HOSTS = ("host-a", "host-b")
TERMINAL = {"succeeded", "failed", "cancelled"}
TOKEN_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")


class ProfileError(Exception):
    def __init__(self, code: str, path: str = "$") -> None:
        super().__init__(f"{code} at {path}")
        self.code = code
        self.path = path


def fail(code: str, path: str = "$") -> None:
    raise ProfileError(code, path)


def scalar_string(value: str) -> bool:
    return all(not (0xD800 <= ord(character) <= 0xDFFF) for character in value)


def strict_parse(raw: str) -> Any:
    if not isinstance(raw, str):
        fail("INVALID_SCENARIO")
    try:
        encoded = raw.encode("utf-8")
    except UnicodeEncodeError:
        fail("INVALID_UTF8")
    return strict_parse_bytes(encoded)


def strict_parse_bytes(raw_bytes: bytes | bytearray | memoryview) -> Any:
    if not isinstance(raw_bytes, (bytes, bytearray, memoryview)):
        fail("INVALID_SCENARIO")
    encoded = bytes(raw_bytes)
    if len(encoded) > MAX_BYTES:
        fail("INVALID_SCENARIO")
    try:
        raw = encoded.decode("utf-8")
    except UnicodeDecodeError:
        fail("INVALID_UTF8")
    return _strict_parse_text(raw)


def _scan_strict_json(raw: str) -> tuple[int, bool]:
    index = 0
    maximum_depth = 1
    invalid_scalar = False
    stack: list[dict[str, Any]] = []
    root_state = "value"
    number_re = re.compile(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?")

    def malformed() -> None:
        fail("MALFORMED_JSON")

    def whitespace() -> None:
        nonlocal index
        while index < len(raw) and raw[index] in " \t\n\r":
            index += 1

    def string_token() -> str:
        nonlocal index, invalid_scalar
        start = index
        if index >= len(raw) or raw[index] != '"':
            malformed()
        index += 1
        while index < len(raw):
            code = ord(raw[index])
            if raw[index] == '"':
                index += 1
                try:
                    decoded = json.loads(raw[start:index])
                except (json.JSONDecodeError, ValueError):
                    malformed()
                if not scalar_string(decoded):
                    invalid_scalar = True
                return decoded
            if code < 0x20:
                malformed()
            if raw[index] == "\\":
                index += 1
                if index >= len(raw):
                    malformed()
                if raw[index] == "u":
                    if not re.fullmatch(r"[0-9a-fA-F]{4}", raw[index + 1:index + 5]):
                        malformed()
                    index += 5
                    continue
                if raw[index] not in '"\\/bfnrt':
                    malformed()
            index += 1
        malformed()

    def number_token() -> None:
        nonlocal index
        match = number_re.match(raw, index)
        if match is None:
            malformed()
        token = match.group(0)
        index = match.end()
        if "." in token or "e" in token or "E" in token or token == "-0":
            fail("NON_CANONICAL_INTEGER")
        if abs(int(token)) > SAFE_MAX:
            fail("UNSAFE_INTEGER")

    def parse_value(depth: int) -> None:
        nonlocal index, maximum_depth
        maximum_depth = max(maximum_depth, depth)
        if index >= len(raw):
            malformed()
        if raw[index] == '"':
            string_token()
            return
        if raw[index] == "{":
            index += 1
            stack.append({"kind": "object", "state": "key_or_end", "keys": []})
            return
        if raw[index] == "[":
            index += 1
            stack.append({"kind": "array", "state": "value_or_end"})
            return
        for literal in ("true", "false", "null"):
            if raw.startswith(literal, index):
                index += len(literal)
                return
        number_token()

    def close_object(frame: dict[str, Any]) -> None:
        seen: set[str] = set()
        for key in frame["keys"]:
            if key in seen:
                fail("DUPLICATE_MEMBER")
            seen.add(key)
        stack.pop()

    while True:
        whitespace()
        if not stack:
            if root_state == "value":
                if index == len(raw):
                    malformed()
                parse_value(1)
                root_state = "done"
                continue
            if index != len(raw):
                malformed()
            break

        frame = stack[-1]
        if frame["kind"] == "object":
            if frame["state"] in ("key_or_end", "key"):
                if frame["state"] == "key_or_end" and index < len(raw) and raw[index] == "}":
                    index += 1
                    close_object(frame)
                    continue
                frame["keys"].append(string_token())
                frame["state"] = "colon"
                continue
            if frame["state"] == "colon":
                if index >= len(raw) or raw[index] != ":":
                    malformed()
                index += 1
                frame["state"] = "value"
                continue
            if frame["state"] == "value":
                frame["state"] = "comma_or_end"
                parse_value(len(stack) + 1)
                continue
            if index < len(raw) and raw[index] == "}":
                index += 1
                close_object(frame)
                continue
            if index >= len(raw) or raw[index] != ",":
                malformed()
            index += 1
            frame["state"] = "key"
            continue

        if frame["state"] in ("value_or_end", "value"):
            if frame["state"] == "value_or_end" and index < len(raw) and raw[index] == "]":
                index += 1
                stack.pop()
                continue
            frame["state"] = "comma_or_end"
            parse_value(len(stack) + 1)
            continue
        if index < len(raw) and raw[index] == "]":
            index += 1
            stack.pop()
            continue
        if index >= len(raw) or raw[index] != ",":
            malformed()
        index += 1
        frame["state"] = "value"

    return maximum_depth, invalid_scalar


def _strict_parse_text(raw: str) -> Any:
    maximum_depth, invalid_scalar = _scan_strict_json(raw)
    if maximum_depth > MAX_DEPTH:
        fail("DEPTH_LIMIT")
    if invalid_scalar:
        fail("MALFORMED_JSON")

    def parse_int(token: str) -> int:
        if token == "-0":
            fail("NON_CANONICAL_INTEGER")
        value = int(token)
        if abs(value) > SAFE_MAX:
            fail("UNSAFE_INTEGER")
        return value

    def parse_float(_token: str) -> None:
        fail("NON_CANONICAL_INTEGER")

    def parse_constant(_token: str) -> None:
        fail("MALFORMED_JSON")

    try:
        return json.loads(
            raw,
            parse_int=parse_int,
            parse_float=parse_float,
            parse_constant=parse_constant,
        )
    except ProfileError:
        raise
    except (json.JSONDecodeError, RecursionError, ValueError):
        fail("MALFORMED_JSON")


def canonical_json(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int) and not isinstance(value, bool):
        if abs(value) > SAFE_MAX:
            fail("UNSAFE_INTEGER")
        return str(value)
    if isinstance(value, str):
        if not scalar_string(value):
            fail("INVALID_SCENARIO")
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(
            canonical_json(key) + ":" + canonical_json(value[key])
            for key in sorted(value.keys())
        ) + "}"
    fail("INVALID_SCENARIO")


def sha256(value: Any) -> str:
    text = value if isinstance(value, str) else canonical_json(value)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def exact_keys(value: Any, required: list[str], path: str) -> None:
    if not isinstance(value, dict):
        fail("INVALID_FIELD", path)
    required_set = set(required)
    for key in value:
        if key not in required_set:
            fail("UNKNOWN_FIELD", f"{path}.{key}")
    for key in required:
        if key not in value:
            fail("MISSING_FIELD", f"{path}.{key}")


def token(value: Any, path: str) -> None:
    if not isinstance(value, str) or TOKEN_RE.fullmatch(value) is None:
        fail("INVALID_FIELD", path)


def nonnegative_integer(value: Any, path: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > SAFE_MAX:
        fail("INVALID_FIELD", path)


def positive_integer(value: Any, path: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0 or value > SAFE_MAX:
        fail("INVALID_FIELD", path)


def validate_scenario(value: Any) -> dict[str, Any]:
    exact_keys(value, ["profile", "scenario_id", "work_id", "commands"], "$")
    if value["profile"] != PROFILE:
        fail("INVALID_SCENARIO", "$.profile")
    token(value["scenario_id"], "$.scenario_id")
    token(value["work_id"], "$.work_id")
    commands = value["commands"]
    if not isinstance(commands, list) or not 1 <= len(commands) <= MAX_COMMANDS:
        fail("INVALID_FIELD", "$.commands")
    schemas = {
        "create_work": ["op", "at", "max_attempts", "retry_base_ms"],
        "acquire_lease": ["op", "at", "host", "lease_ms"],
        "renew_lease": ["op", "at", "host", "lease_ms"],
        "settle": ["op", "at", "host", "outcome"],
        "cancel": ["op", "at", "host"],
        "recover_expired": ["op", "at", "host"],
        "partition": ["op", "at", "host"],
        "heal": ["op", "at", "host"],
        "replay_check": ["op", "at"],
    }
    previous_at = -1
    for index, command in enumerate(commands):
        path = f"$.commands[{index}]"
        if not isinstance(command, dict):
            fail("INVALID_FIELD", path)
        op = command.get("op")
        if not isinstance(op, str) or op not in schemas:
            fail("UNKNOWN_OP", f"{path}.op")
        exact_keys(command, schemas[op], path)
        nonnegative_integer(command["at"], f"{path}.at")
        if command["at"] < previous_at:
            fail("NON_MONOTONIC_TIME", f"{path}.at")
        previous_at = command["at"]
        if "host" in command and command["host"] not in HOSTS:
            fail("UNKNOWN_HOST", f"{path}.host")
        if "lease_ms" in command:
            positive_integer(command["lease_ms"], f"{path}.lease_ms")
        if op == "create_work":
            max_attempts = command["max_attempts"]
            if isinstance(max_attempts, bool) or not isinstance(max_attempts, int) or not 1 <= max_attempts <= 32:
                fail("INVALID_FIELD", f"{path}.max_attempts")
            nonnegative_integer(command["retry_base_ms"], f"{path}.retry_base_ms")
        if op == "settle" and command["outcome"] not in ("success", "failure"):
            fail("INVALID_FIELD", f"{path}.outcome")
    return value


def initial_hosts() -> list[dict[str, Any]]:
    return [{"host_id": host_id, "reachable": True, "token": None} for host_id in HOSTS]


def clone(value: Any) -> Any:
    return json.loads(json.dumps(value, ensure_ascii=False))


def retry_eligible_at(at: int, retry_base_ms: int, failed_attempt_number: int) -> int | None:
    delay = retry_base_ms
    for _ in range(1, failed_attempt_number):
        if delay > SAFE_MAX // 2:
            return None
        delay *= 2
    if delay > SAFE_MAX or at > SAFE_MAX - delay:
        return None
    return at + delay


def find_attempt(authority: dict[str, Any], attempt_id: str) -> dict[str, Any] | None:
    return next((attempt for attempt in authority["attempts"] if attempt["attempt_id"] == attempt_id), None)


def replay_authority(events: list[dict[str, Any]]) -> dict[str, Any] | None:
    authority = None
    for index, event in enumerate(events):
        if event["seq"] != index + 1 or event["event_id"] != f"event-{index + 1}":
            return None
        data = event["data"]
        kind = event["kind"]
        if kind == "attempt_created":
            if authority is not None:
                return None
            authority = {
                "work": {
                    "work_id": event["work_id"],
                    "status": "pending",
                    "current_attempt_id": event["attempt_id"],
                    "owner_epoch": 0,
                    "max_attempts": data["max_attempts"],
                    "retry_base_ms": data["retry_base_ms"],
                    "terminal_at": None,
                },
                "attempts": [clone(data["attempt"])],
            }
            continue
        if authority is None:
            return None
        attempt = find_attempt(authority, event["attempt_id"])
        if kind == "lease_acquired":
            if attempt is None:
                return None
            authority["work"]["status"] = "running"
            authority["work"]["current_attempt_id"] = event["attempt_id"]
            authority["work"]["owner_epoch"] = event["owner_epoch"]
            attempt["status"] = "running"
            attempt["owner_id"] = data["owner_id"]
            attempt["owner_epoch"] = event["owner_epoch"]
            attempt["lease_until"] = data["lease_until"]
        elif kind == "attempt_succeeded":
            if attempt is None:
                return None
            attempt["status"] = "succeeded"
            attempt["terminal_at"] = event["at"]
            authority["work"]["status"] = "succeeded"
            authority["work"]["terminal_at"] = event["at"]
        elif kind == "attempt_failed":
            if attempt is None:
                return None
            attempt["status"] = "failed"
            attempt["terminal_at"] = event["at"]
            if data["work_terminal"]:
                authority["work"]["status"] = "failed"
                authority["work"]["terminal_at"] = event["at"]
        elif kind == "lease_expired":
            if attempt is None:
                return None
            attempt["status"] = "expired"
            attempt["terminal_at"] = event["at"]
            if data["work_terminal"]:
                authority["work"]["status"] = "failed"
                authority["work"]["terminal_at"] = event["at"]
        elif kind == "attempt_retried":
            authority["work"]["status"] = "pending"
            authority["work"]["current_attempt_id"] = data["attempt"]["attempt_id"]
            authority["work"]["owner_epoch"] = event["owner_epoch"]
            authority["attempts"].append(clone(data["attempt"]))
        elif kind == "attempt_cancelled":
            if attempt is None:
                return None
            attempt["status"] = "cancelled"
            attempt["terminal_at"] = event["at"]
            authority["work"]["status"] = "cancelled"
            authority["work"]["terminal_at"] = event["at"]
        else:
            return None
    return authority


def evaluate_two_host_scenario(raw: str) -> dict[str, Any]:
    return _evaluate_parsed_scenario(validate_scenario(strict_parse(raw)))


def evaluate_two_host_scenario_bytes(raw_bytes: bytes | bytearray | memoryview) -> dict[str, Any]:
    return _evaluate_parsed_scenario(validate_scenario(strict_parse_bytes(raw_bytes)))


def _evaluate_parsed_scenario(scenario: dict[str, Any]) -> dict[str, Any]:
    authority: dict[str, Any] | None = None
    hosts = initial_hosts()
    events: list[dict[str, Any]] = []
    command_results: list[dict[str, Any]] = []
    replay_match: bool | None = None

    def host(host_id: str) -> dict[str, Any]:
        return next(entry for entry in hosts if entry["host_id"] == host_id)

    def emit(kind: str, command: dict[str, Any], attempt_id: str, owner_epoch: int, data: dict[str, Any] | None = None) -> None:
        seq = len(events) + 1
        events.append({
            "at": command["at"],
            "data": data or {},
            "event_id": f"event-{seq}",
            "kind": kind,
            "owner_epoch": owner_epoch,
            "seq": seq,
            "work_id": scenario["work_id"],
            "attempt_id": attempt_id,
        })

    def record(index: int, command: dict[str, Any], accepted: bool, error: str | None = None) -> None:
        command_results.append({
            "accepted": accepted,
            "at": command["at"],
            "error": error,
            "index": index,
            "op": command["op"],
            "state_sha256": sha256({"authority": authority, "events": events, "hosts": hosts}),
        })

    def reject(index: int, command: dict[str, Any], error: str) -> None:
        record(index, command, False, error)

    def connected(index: int, command: dict[str, Any]) -> bool:
        if not host(command["host"])["reachable"]:
            reject(index, command, "HOST_PARTITIONED")
            return False
        return True

    def existing(index: int, command: dict[str, Any]) -> bool:
        if authority is None:
            reject(index, command, "WORK_NOT_FOUND")
            return False
        return True

    def nonterminal(index: int, command: dict[str, Any]) -> bool:
        assert authority is not None
        if authority["work"]["status"] in TERMINAL:
            reject(index, command, "WORK_TERMINAL")
            return False
        return True

    def fenced_attempt(index: int, command: dict[str, Any]) -> dict[str, Any] | None:
        assert authority is not None
        cached = host(command["host"])["token"]
        if cached is None:
            reject(index, command, "NO_LOCAL_TOKEN")
            return None
        attempt = find_attempt(authority, authority["work"]["current_attempt_id"])
        if (
            attempt is None
            or authority["work"]["status"] != "running"
            or attempt["status"] != "running"
            or cached["attempt_id"] != attempt["attempt_id"]
            or cached["host_id"] != attempt["owner_id"]
            or cached["owner_epoch"] != attempt["owner_epoch"]
            or cached["owner_epoch"] != authority["work"]["owner_epoch"]
            or command["host"] != attempt["owner_id"]
        ):
            reject(index, command, "STALE_FENCE")
            return None
        if command["at"] >= attempt["lease_until"]:
            reject(index, command, "LEASE_EXPIRED")
            return None
        return attempt

    def create_retry(command: dict[str, Any], failed_attempt: dict[str, Any], eligible_at: int) -> None:
        assert authority is not None
        authority["work"]["owner_epoch"] += 1
        attempt_number = failed_attempt["attempt_number"] + 1
        attempt = {
            "attempt_id": f"attempt-{attempt_number}",
            "attempt_number": attempt_number,
            "status": "pending",
            "owner_id": None,
            "owner_epoch": authority["work"]["owner_epoch"],
            "lease_until": None,
            "eligible_at": eligible_at,
            "terminal_at": None,
        }
        authority["work"]["status"] = "pending"
        authority["work"]["current_attempt_id"] = attempt["attempt_id"]
        authority["attempts"].append(attempt)
        emit("attempt_retried", command, attempt["attempt_id"], authority["work"]["owner_epoch"], {"attempt": clone(attempt)})

    for index, command in enumerate(scenario["commands"]):
        op = command["op"]
        if op in ("partition", "heal"):
            host(command["host"])["reachable"] = op == "heal"
            record(index, command, True)
            continue
        if op == "replay_check":
            replay_match = canonical_json(replay_authority(events)) == canonical_json(authority)
            record(index, command, True)
            continue
        if op == "create_work":
            if authority is not None:
                reject(index, command, "WORK_ALREADY_EXISTS")
                continue
            attempt = {
                "attempt_id": "attempt-1",
                "attempt_number": 1,
                "status": "pending",
                "owner_id": None,
                "owner_epoch": 0,
                "lease_until": None,
                "eligible_at": command["at"],
                "terminal_at": None,
            }
            authority = {
                "work": {
                    "work_id": scenario["work_id"],
                    "status": "pending",
                    "current_attempt_id": "attempt-1",
                    "owner_epoch": 0,
                    "max_attempts": command["max_attempts"],
                    "retry_base_ms": command["retry_base_ms"],
                    "terminal_at": None,
                },
                "attempts": [attempt],
            }
            emit("attempt_created", command, "attempt-1", 0, {
                "attempt": clone(attempt),
                "max_attempts": command["max_attempts"],
                "retry_base_ms": command["retry_base_ms"],
            })
            record(index, command, True)
            continue
        if not connected(index, command) or not existing(index, command) or not nonterminal(index, command):
            continue
        assert authority is not None

        if op == "acquire_lease":
            attempt = find_attempt(authority, authority["work"]["current_attempt_id"])
            if authority["work"]["status"] != "pending" or attempt is None or attempt["status"] != "pending":
                reject(index, command, "NOT_LEASEABLE")
                continue
            if command["at"] < attempt["eligible_at"]:
                reject(index, command, "NOT_ELIGIBLE")
                continue
            if command["at"] > SAFE_MAX - command["lease_ms"]:
                reject(index, command, "TIME_OVERFLOW")
                continue
            authority["work"]["owner_epoch"] += 1
            authority["work"]["status"] = "running"
            attempt["status"] = "running"
            attempt["owner_id"] = command["host"]
            attempt["owner_epoch"] = authority["work"]["owner_epoch"]
            attempt["lease_until"] = command["at"] + command["lease_ms"]
            host(command["host"])["token"] = {
                "attempt_id": attempt["attempt_id"],
                "host_id": command["host"],
                "lease_until": attempt["lease_until"],
                "owner_epoch": attempt["owner_epoch"],
            }
            emit("lease_acquired", command, attempt["attempt_id"], attempt["owner_epoch"], {
                "lease_until": attempt["lease_until"],
                "owner_id": command["host"],
                "renewal": False,
            })
            record(index, command, True)
            continue

        if op == "cancel":
            attempt = find_attempt(authority, authority["work"]["current_attempt_id"])
            assert attempt is not None
            attempt["status"] = "cancelled"
            attempt["terminal_at"] = command["at"]
            authority["work"]["status"] = "cancelled"
            authority["work"]["terminal_at"] = command["at"]
            emit("attempt_cancelled", command, attempt["attempt_id"], authority["work"]["owner_epoch"])
            record(index, command, True)
            continue

        if op == "recover_expired":
            attempt = find_attempt(authority, authority["work"]["current_attempt_id"])
            if authority["work"]["status"] != "running" or attempt is None or attempt["status"] != "running":
                reject(index, command, "NOT_RUNNING")
                continue
            if command["at"] < attempt["lease_until"]:
                reject(index, command, "NOT_EXPIRED")
                continue
            eligible_at = None
            if attempt["attempt_number"] < authority["work"]["max_attempts"]:
                eligible_at = retry_eligible_at(command["at"], authority["work"]["retry_base_ms"], attempt["attempt_number"])
                if eligible_at is None:
                    reject(index, command, "RETRY_TIME_OVERFLOW")
                    continue
            attempt["status"] = "expired"
            attempt["terminal_at"] = command["at"]
            terminal = attempt["attempt_number"] >= authority["work"]["max_attempts"]
            if terminal:
                authority["work"]["status"] = "failed"
                authority["work"]["terminal_at"] = command["at"]
            emit("lease_expired", command, attempt["attempt_id"], attempt["owner_epoch"], {"work_terminal": terminal})
            if not terminal:
                assert eligible_at is not None
                create_retry(command, attempt, eligible_at)
            record(index, command, True)
            continue

        attempt = fenced_attempt(index, command)
        if attempt is None:
            continue
        if op == "renew_lease":
            if command["at"] > SAFE_MAX - command["lease_ms"]:
                reject(index, command, "TIME_OVERFLOW")
                continue
            attempt["lease_until"] = command["at"] + command["lease_ms"]
            host(command["host"])["token"]["lease_until"] = attempt["lease_until"]
            emit("lease_acquired", command, attempt["attempt_id"], attempt["owner_epoch"], {
                "lease_until": attempt["lease_until"],
                "owner_id": command["host"],
                "renewal": True,
            })
            record(index, command, True)
            continue
        if command["outcome"] == "success":
            attempt["status"] = "succeeded"
            attempt["terminal_at"] = command["at"]
            authority["work"]["status"] = "succeeded"
            authority["work"]["terminal_at"] = command["at"]
            emit("attempt_succeeded", command, attempt["attempt_id"], attempt["owner_epoch"])
            record(index, command, True)
            continue
        eligible_at = None
        if attempt["attempt_number"] < authority["work"]["max_attempts"]:
            eligible_at = retry_eligible_at(command["at"], authority["work"]["retry_base_ms"], attempt["attempt_number"])
            if eligible_at is None:
                reject(index, command, "RETRY_TIME_OVERFLOW")
                continue
        attempt["status"] = "failed"
        attempt["terminal_at"] = command["at"]
        terminal = attempt["attempt_number"] >= authority["work"]["max_attempts"]
        if terminal:
            authority["work"]["status"] = "failed"
            authority["work"]["terminal_at"] = command["at"]
        emit("attempt_failed", command, attempt["attempt_id"], attempt["owner_epoch"], {"work_terminal": terminal})
        if not terminal:
            assert eligible_at is not None
            create_retry(command, attempt, eligible_at)
        record(index, command, True)

    return {
        "profile": PROFILE,
        "scenario_id": scenario["scenario_id"],
        "work_id": scenario["work_id"],
        "authority": authority,
        "hosts": hosts,
        "events": events,
        "command_results": command_results,
        "replay_match": replay_match,
    }


def project_result(result: dict[str, Any]) -> dict[str, Any]:
    authority = result["authority"]
    attempts = authority["attempts"] if authority is not None else []
    return {
        "work_status": authority["work"]["status"] if authority is not None else None,
        "current_attempt_id": authority["work"]["current_attempt_id"] if authority is not None else None,
        "owner_epoch": authority["work"]["owner_epoch"] if authority is not None else None,
        "attempt_statuses": [attempt["status"] for attempt in attempts],
        "attempt_epochs": [attempt["owner_epoch"] for attempt in attempts],
        "attempt_lease_until": [attempt["lease_until"] for attempt in attempts],
        "attempt_eligible_at": [attempt["eligible_at"] for attempt in attempts],
        "host_token_epochs": [
            host["token"]["owner_epoch"] if host["token"] is not None else None
            for host in result["hosts"]
        ],
        "event_kinds": [event["kind"] for event in result["events"]],
        "command_errors": [entry["error"] for entry in result["command_results"]],
        "replay_match": result["replay_match"],
    }
