import hashlib
import json

PROFILE = "meshfleet.a2a.lifecycle-terminal.v0.1"
OPS = {"create", "acquire", "renew", "expire", "settle", "settle_with_retry", "cancel"}
TERMINAL = {"succeeded", "failed", "cancelled"}
SAFE_MAX = 9007199254740991


def _scalar_string(value):
    if not isinstance(value, str):
        return False
    for char in value:
        if 0xD800 <= ord(char) <= 0xDFFF:
            return False
    return True


def _assert_data(value):
    if value is None or isinstance(value, bool):
        return
    if isinstance(value, str):
        if not _scalar_string(value):
            raise ValueError("lone surrogate")
        return
    if isinstance(value, int) and not isinstance(value, bool):
        if abs(value) > SAFE_MAX:
            raise ValueError("non-canonical number")
        return
    if isinstance(value, float):
        raise ValueError("non-canonical number")
    if isinstance(value, list):
        for item in value:
            _assert_data(item)
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not _scalar_string(key):
                raise ValueError("lone surrogate key")
            _assert_data(item)
        return
    raise ValueError("unsupported JSON value")


def canonical(value):
    _assert_data(value)
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def sha256(value):
    text = value if isinstance(value, str) else canonical(value)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _pairs(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise ValueError("duplicate member: " + key)
        out[key] = value
    return out


def parse_strict_json(text):
    def parse_int(token):
        if token == "-0":
            raise ValueError("non-canonical number")
        value = int(token)
        if abs(value) > SAFE_MAX:
            raise ValueError("non-canonical number")
        return value

    value = json.loads(
        text,
        object_pairs_hook=_pairs,
        parse_int=parse_int,
        parse_float=lambda _: (_ for _ in ()).throw(ValueError("non-canonical number")),
    )
    _assert_data(value)
    return value


def _exact_fields(command, allowed):
    return set(command) == set(allowed)


def _nonempty(value):
    return _scalar_string(value) and len(value) > 0


def _safe_nonnegative(value):
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= SAFE_MAX


def _safe_positive(value):
    return isinstance(value, int) and not isinstance(value, bool) and 0 < value <= SAFE_MAX


def _valid_data(value):
    try:
        _assert_data(value)
        return True
    except ValueError:
        return False


def _command_shape_code(command):
    op = command["op"]
    if op == "create":
        if not _exact_fields(command, {"op", "at", "work_id", "max_attempts", "retry_base_ms", "retry_jitter"}) or not _nonempty(command.get("work_id")):
            return "MALFORMED_COMMAND"
        if not _safe_positive(command.get("max_attempts")) or not _safe_positive(command.get("retry_base_ms")) or command.get("retry_jitter") is not False:
            return "INVALID_RETRY_POLICY"
        return None
    if op == "acquire":
        valid = (_exact_fields(command, {"op", "at", "owner_id", "lease_ms"})
                 and _nonempty(command.get("owner_id")) and _safe_positive(command.get("lease_ms"))
                 and command["at"] + command["lease_ms"] <= SAFE_MAX)
    elif op == "renew":
        valid = (_exact_fields(command, {"op", "at", "owner_id", "owner_epoch", "lease_ms"})
                 and _nonempty(command.get("owner_id")) and _safe_nonnegative(command.get("owner_epoch"))
                 and _safe_positive(command.get("lease_ms")) and command["at"] + command["lease_ms"] <= SAFE_MAX)
    elif op == "expire":
        valid = _exact_fields(command, {"op", "at"})
    elif op == "settle":
        valid = (_exact_fields(command, {"op", "at", "owner_id", "owner_epoch", "outcome", "result", "error"})
                 and _nonempty(command.get("owner_id")) and _safe_nonnegative(command.get("owner_epoch"))
                 and command.get("outcome") in {"success", "failure"} and _valid_data(command.get("result"))
                 and (command.get("error") is None or _scalar_string(command.get("error"))))
    elif op == "settle_with_retry":
        valid = (_exact_fields(command, {"op", "at", "owner_id", "owner_epoch", "outcome", "error"})
                 and _nonempty(command.get("owner_id")) and _safe_nonnegative(command.get("owner_epoch"))
                 and command.get("outcome") == "failure"
                 and (command.get("error") is None or _scalar_string(command.get("error"))))
    elif op == "cancel":
        valid = (_exact_fields(command, {"op", "at", "reason"})
                 and (command.get("reason") is None or _scalar_string(command.get("reason"))))
    else:
        raise ValueError("shape requested for unknown operation")
    return None if valid else "MALFORMED_COMMAND"


def _copy(value):
    if value is None:
        return None
    return json.loads(json.dumps(value, ensure_ascii=False))


def _attempt(work, number, epoch, eligible_at):
    return {
        "id": f"{work['id']}:attempt:{number}",
        "number": number,
        "status": "pending",
        "owner_id": None,
        "owner_epoch": epoch,
        "eligible_at": eligible_at,
        "lease_until": None,
        "result": None,
        "error": None,
    }


def _current(state):
    for item in state["attempts"]:
        if item["id"] == state["work"]["current_attempt_id"]:
            return item
    return None


def _emit(state, kind, item, at):
    seq = len(state["events"]) + 1
    state["events"].append({
        "id": f"{state['work']['id']}:event:{seq}",
        "seq": seq,
        "kind": kind,
        "attempt_id": item["id"],
        "owner_epoch": item["owner_epoch"],
        "occurred_at": at,
    })


def _retry_eligible_at(state, old, at):
    delay = state["work"]["retry_base_ms"] * (2 ** (old["number"] - 1))
    return at + delay if delay <= SAFE_MAX and at + delay <= SAFE_MAX else None


def _make_retry(state, old, at, eligible_at):
    nxt = _attempt(state["work"], old["number"] + 1, state["work"]["owner_epoch"] + 1, eligible_at)
    state["attempts"].append(nxt)
    state["work"]["status"] = "pending"
    state["work"]["current_attempt_id"] = nxt["id"]
    state["work"]["owner_epoch"] = nxt["owner_epoch"]
    state["work"]["result"] = None
    state["work"]["error"] = None
    _emit(state, "attempt_retried", nxt, at)


def _validate_state(state):
    if state is None:
        return
    active = _current(state)
    if active is None:
        raise ValueError("missing current attempt")
    if len(state["attempts"]) > state["work"]["max_attempts"]:
        raise ValueError("attempt cap exceeded")
    for index, item in enumerate(state["attempts"]):
        if item["number"] != index + 1:
            raise ValueError("non-contiguous attempt number")
    if sum(item["status"] == "running" for item in state["attempts"]) > 1:
        raise ValueError("multiple running attempts")
    if state["work"]["status"] == "running" and active["status"] != "running":
        raise ValueError("running work mismatch")
    if state["work"]["status"] == "pending" and active["status"] != "pending":
        raise ValueError("pending work mismatch")
    if state["work"]["status"] in TERMINAL and active["status"] not in TERMINAL:
        raise ValueError("terminal work mismatch")
    if state["work"]["owner_epoch"] != active["owner_epoch"]:
        raise ValueError("current epoch mismatch")
    epochs = [item["owner_epoch"] for item in state["attempts"]]
    if any(epochs[index] <= epochs[index - 1] for index in range(1, len(epochs))):
        raise ValueError("retry epoch not increasing")
    if any(event["seq"] != index + 1 for index, event in enumerate(state["events"])):
        raise ValueError("event sequence gap")


def _accepted():
    return {"accepted": True, "code": "OK"}


def _rejected(code):
    return {"accepted": False, "code": code}


def _apply(state, command):
    if not isinstance(command, dict) or not _nonempty(command.get("op")) or not _safe_nonnegative(command.get("at")):
        return state, _rejected("MALFORMED_COMMAND")
    op = command["op"]
    if op not in OPS:
        return state, _rejected("UNKNOWN_OP")
    shape_code = _command_shape_code(command)
    if shape_code is not None:
        return state, _rejected(shape_code)

    if op == "create":
        if state is not None:
            return state, _rejected("WORK_ALREADY_EXISTS")
        work = {
            "id": command["work_id"],
            "status": "pending",
            "current_attempt_id": f"{command['work_id']}:attempt:1",
            "owner_epoch": 0,
            "max_attempts": command["max_attempts"],
            "retry_base_ms": command["retry_base_ms"],
            "retry_jitter": False,
            "result": None,
            "error": None,
        }
        state = {"work": work, "attempts": [_attempt(work, 1, 0, command["at"])], "events": []}
        _emit(state, "attempt_created", state["attempts"][0], command["at"])
        return state, _accepted()

    if state is None or state["work"]["status"] in TERMINAL:
        return state, _rejected("WORK_TERMINAL_OR_UNKNOWN")
    active = _current(state)
    if active is None:
        return state, _rejected("WORK_HAS_NO_CURRENT_ATTEMPT")

    if op == "acquire":
        allowed = {"op", "at", "owner_id", "lease_ms"}
        if (not _exact_fields(command, allowed) or not _nonempty(command.get("owner_id"))
                or not _safe_positive(command.get("lease_ms")) or command["at"] + command["lease_ms"] > SAFE_MAX):
            return state, _rejected("MALFORMED_COMMAND")
        if state["work"]["status"] != "pending" or active["status"] != "pending" or command["at"] < active["eligible_at"]:
            return state, _rejected("WORK_NOT_LEASEABLE")
        epoch = max(state["work"]["owner_epoch"], active["owner_epoch"]) + 1
        state["work"]["status"] = "running"
        state["work"]["owner_epoch"] = epoch
        active["status"] = "running"
        active["owner_id"] = command["owner_id"]
        active["owner_epoch"] = epoch
        active["lease_until"] = command["at"] + command["lease_ms"]
        _emit(state, "lease_acquired", active, command["at"])
        return state, _accepted()

    if op == "cancel":
        allowed = {"op", "at", "reason"}
        if not _exact_fields(command, allowed) or not (command.get("reason") is None or isinstance(command.get("reason"), str)):
            return state, _rejected("MALFORMED_COMMAND")
        state["work"]["status"] = "cancelled"
        state["work"]["result"] = None
        state["work"]["error"] = command.get("reason")
        active["status"] = "cancelled"
        active["result"] = None
        active["error"] = command.get("reason")
        _emit(state, "attempt_cancelled", active, command["at"])
        return state, _accepted()

    if op == "expire":
        if not _exact_fields(command, {"op", "at"}):
            return state, _rejected("MALFORMED_COMMAND")
        if (state["work"]["status"] != "running" or active["status"] != "running"
                or active["lease_until"] is None or command["at"] < active["lease_until"]):
            return state, _rejected("ATTEMPT_NOT_EXPIRED")
        eligible_at = _retry_eligible_at(state, active, command["at"]) if active["number"] < state["work"]["max_attempts"] else None
        if active["number"] < state["work"]["max_attempts"] and eligible_at is None:
            return state, _rejected("RETRY_TIME_OVERFLOW")
        active["status"] = "expired"
        _emit(state, "lease_expired", active, command["at"])
        if active["number"] >= state["work"]["max_attempts"]:
            message = "lease expired after final allowed attempt"
            active["status"] = "failed"
            active["error"] = message
            state["work"]["status"] = "failed"
            state["work"]["error"] = message
            _emit(state, "attempt_failed", active, command["at"])
        else:
            _make_retry(state, active, command["at"], eligible_at)
        return state, _accepted()

    if op == "renew":
        allowed = {"op", "at", "owner_id", "owner_epoch", "lease_ms"}
        if (not _exact_fields(command, allowed) or not _nonempty(command.get("owner_id"))
                or not _safe_nonnegative(command.get("owner_epoch")) or not _safe_positive(command.get("lease_ms"))
                or command["at"] + command["lease_ms"] > SAFE_MAX):
            return state, _rejected("MALFORMED_COMMAND")
        if (state["work"]["status"] != "running" or active["status"] != "running"
                or active["owner_id"] != command["owner_id"] or active["owner_epoch"] != command["owner_epoch"]
                or active["lease_until"] is None or command["at"] >= active["lease_until"]):
            return state, _rejected("STALE_OR_TERMINAL_LEASE")
        active["lease_until"] = command["at"] + command["lease_ms"]
        _emit(state, "lease_acquired", active, command["at"])
        return state, _accepted()

    if op == "settle":
        allowed = {"op", "at", "owner_id", "owner_epoch", "outcome", "result", "error"}
    else:
        allowed = {"op", "at", "owner_id", "owner_epoch", "outcome", "error"}
    if not _exact_fields(command, allowed) or not _nonempty(command.get("owner_id")) or not _safe_nonnegative(command.get("owner_epoch")):
        return state, _rejected("MALFORMED_COMMAND")
    if op == "settle" and command.get("outcome") not in {"success", "failure"}:
        return state, _rejected("MALFORMED_COMMAND")
    if op == "settle_with_retry" and command.get("outcome") != "failure":
        return state, _rejected("MALFORMED_COMMAND")
    if not (command.get("error") is None or isinstance(command.get("error"), str)):
        return state, _rejected("MALFORMED_COMMAND")
    if (state["work"]["status"] != "running" or active["status"] != "running"
            or active["owner_id"] != command["owner_id"] or active["owner_epoch"] != command["owner_epoch"]
            or active["lease_until"] is None or command["at"] >= active["lease_until"]):
        return state, _rejected("STALE_OR_TERMINAL_LEASE")
    eligible_at = (_retry_eligible_at(state, active, command["at"])
                   if op == "settle_with_retry" and active["number"] < state["work"]["max_attempts"] else None)
    if op == "settle_with_retry" and active["number"] < state["work"]["max_attempts"] and eligible_at is None:
        return state, _rejected("RETRY_TIME_OVERFLOW")
    if op == "settle" and command["outcome"] == "success":
        active["status"] = "succeeded"
        active["result"] = _copy(command.get("result"))
        active["error"] = None
        state["work"]["status"] = "succeeded"
        state["work"]["result"] = _copy(command.get("result"))
        state["work"]["error"] = None
        _emit(state, "attempt_succeeded", active, command["at"])
        return state, _accepted()
    active["status"] = "failed"
    active["result"] = None
    active["error"] = command.get("error")
    _emit(state, "attempt_failed", active, command["at"])
    if op == "settle_with_retry" and active["number"] < state["work"]["max_attempts"]:
        _make_retry(state, active, command["at"], eligible_at)
    else:
        state["work"]["status"] = "failed"
        state["work"]["result"] = None
        state["work"]["error"] = command.get("error")
    return state, _accepted()


def _finish(body):
    body = dict(body)
    body["receipt_sha256"] = sha256(body)
    return body


def evaluate_lifecycle_trace(trace):
    if not isinstance(trace, dict):
        return _finish({"profile": PROFILE, "case_id": None, "top_code": "MALFORMED_TRACE", "steps": [], "final": None})
    case_id = trace.get("case_id") if _nonempty(trace.get("case_id")) else None
    if not _exact_fields(trace, {"profile", "case_id", "commands"}) or case_id is None or not isinstance(trace.get("commands"), list):
        return _finish({"profile": PROFILE, "case_id": case_id, "top_code": "MALFORMED_TRACE", "steps": [], "final": None})
    if trace.get("profile") != PROFILE:
        return _finish({"profile": PROFILE, "case_id": case_id, "top_code": "PROFILE_REJECT", "steps": [], "final": None})
    state = None
    last_at = -1
    steps = []
    for index, command in enumerate(trace["commands"]):
        before = sha256(state)
        if isinstance(command, dict) and _safe_nonnegative(command.get("at")) and command["at"] < last_at:
            result = _rejected("MALFORMED_COMMAND")
        else:
            if isinstance(command, dict) and _safe_nonnegative(command.get("at")):
                last_at = command["at"]
            state, result = _apply(state, command)
        _validate_state(state)
        after = sha256(state)
        if not result["accepted"] and before != after:
            raise ValueError("rejected command mutated state")
        steps.append({
            "index": index,
            "op": command.get("op") if isinstance(command, dict) and isinstance(command.get("op"), str) else None,
            "accepted": result["accepted"],
            "code": result["code"],
            "state_sha256": after,
        })
    return _finish({"profile": PROFILE, "case_id": case_id, "top_code": "OK", "steps": steps, "final": _copy(state)})


def project_receipt(receipt):
    state = receipt["final"]
    return {
        "top_code": receipt["top_code"],
        "step_codes": [step["code"] for step in receipt["steps"]],
        "work": None if state is None else {
            "status": state["work"]["status"],
            "current_attempt_number": _current(state)["number"],
            "owner_epoch": state["work"]["owner_epoch"],
            "result": state["work"]["result"],
            "error": state["work"]["error"],
        },
        "attempts": [] if state is None else [{
            "number": item["number"],
            "status": item["status"],
            "owner_id": item["owner_id"],
            "owner_epoch": item["owner_epoch"],
            "eligible_at": item["eligible_at"],
            "lease_until": item["lease_until"],
            "result": item["result"],
            "error": item["error"],
        } for item in state["attempts"]],
        "event_kinds": [] if state is None else [event["kind"] for event in state["events"]],
    }
