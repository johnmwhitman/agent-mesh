import json
import re

MAX_BYTES, MAX_DEPTH, MAX_MEMBERS, MAX_LABEL = 131072, 64, 128, 256
PROFILE = "meshfleet.a2a.dependency-join-barrier.v0.1"
class BarrierError(Exception):
    def __init__(self, code): self.code = code; super().__init__(code)
def fail(code): raise BarrierError(code)
def cmp_key(value): return tuple(ord(c) for c in value)
def scalar(value):
    if any(0xD800 <= ord(c) <= 0xDFFF for c in value): fail("INVALID_UNICODE")
    return value
class Parser:
    def __init__(self, source): self.s, self.i = source, 0
    def ws(self):
        while self.i < len(self.s) and self.s[self.i] in " \t\r\n": self.i += 1
    def value(self, depth=0):
        self.ws()
        if self.i >= len(self.s): fail("MALFORMED_JSON")
        c = self.s[self.i]
        if c == '"': return self.string()
        if c == '{': return self.object(depth)
        if c == '[': return self.array(depth)
        for word, value in (("true", True), ("false", False), ("null", None)):
            if self.s.startswith(word, self.i): self.i += len(word); return value
        if c == '-' or c.isdigit(): return self.number()
        fail("MALFORMED_JSON")
    def string(self):
        self.i += 1; out = []
        while self.i < len(self.s):
            c = self.s[self.i]; self.i += 1
            if c == '"': return scalar("".join(out))
            if ord(c) < 32: fail("MALFORMED_JSON")
            if c != '\\': out.append(c); continue
            if self.i >= len(self.s): fail("MALFORMED_JSON")
            e = self.s[self.i]; self.i += 1
            simple = {'"':'"', '\\':'\\', '/':'/', 'b':'\b', 'f':'\f', 'n':'\n', 'r':'\r', 't':'\t'}
            if e in simple: out.append(simple[e]); continue
            if e != 'u': fail("MALFORMED_JSON")
            h = self.s[self.i:self.i+4]
            if not re.fullmatch(r"[0-9a-fA-F]{4}", h): fail("MALFORMED_JSON")
            self.i += 4; cp = int(h, 16)
            if 0xDC00 <= cp <= 0xDFFF: fail("INVALID_UNICODE")
            if 0xD800 <= cp <= 0xDBFF:
                if self.s[self.i:self.i+2] != "\\u": fail("INVALID_UNICODE")
                low_text = self.s[self.i+2:self.i+6]
                if not re.fullmatch(r"[0-9a-fA-F]{4}", low_text): fail("MALFORMED_JSON")
                low = int(low_text, 16)
                if not 0xDC00 <= low <= 0xDFFF: fail("INVALID_UNICODE")
                self.i += 6; cp = 0x10000 + (cp - 0xD800) * 0x400 + low - 0xDC00
            out.append(chr(cp))
        fail("MALFORMED_JSON")
    def number(self):
        match = re.match(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?", self.s[self.i:])
        if not match: fail("MALFORMED_JSON")
        token = match.group(0); self.i += len(token)
        if any(x in token for x in '.eE') or token == '-0': fail("NON_CANONICAL_INTEGER")
        value = int(token)
        if abs(value) > 9007199254740991: fail("UNSAFE_INTEGER")
        return value
    def object(self, depth):
        if depth >= MAX_DEPTH: fail("DEPTH_LIMIT")
        self.i += 1; self.ws(); result, seen = {}, set()
        if self.i < len(self.s) and self.s[self.i] == '}': self.i += 1; return result
        while True:
            self.ws()
            if self.i >= len(self.s) or self.s[self.i] != '"': fail("MALFORMED_JSON")
            key = self.string()
            if key in seen: fail("DUPLICATE_MEMBER")
            seen.add(key); self.ws()
            if self.i >= len(self.s) or self.s[self.i] != ':': fail("MALFORMED_JSON")
            self.i += 1; result[key] = self.value(depth + 1); self.ws()
            if self.i >= len(self.s): fail("MALFORMED_JSON")
            c = self.s[self.i]; self.i += 1
            if c == '}': return result
            if c != ',': fail("MALFORMED_JSON")
    def array(self, depth):
        if depth >= MAX_DEPTH: fail("DEPTH_LIMIT")
        self.i += 1; self.ws(); result = []
        if self.i < len(self.s) and self.s[self.i] == ']': self.i += 1; return result
        while True:
            result.append(self.value(depth + 1)); self.ws()
            if self.i >= len(self.s): fail("MALFORMED_JSON")
            c = self.s[self.i]; self.i += 1
            if c == ']': return result
            if c != ',': fail("MALFORMED_JSON")
def parse_strict(data):
    if len(data) > MAX_BYTES: fail("SIZE_LIMIT")
    try: source = data.decode("utf-8", "strict")
    except UnicodeDecodeError: fail("INVALID_UTF8")
    if source.startswith("\ufeff"): fail("MALFORMED_JSON")
    parser = Parser(source); value = parser.value(); parser.ws()
    if parser.i != len(source): fail("MALFORMED_JSON")
    return value
def exact(obj, allowed):
    if not isinstance(obj, dict): fail("INVALID_FIELD")
    for key in obj:
        if key not in allowed: fail("UNKNOWN_FIELD")
def required(obj, key):
    if key not in obj: fail("MISSING_FIELD")
    return obj[key]
def label(value):
    if not isinstance(value, str) or not value: fail("INVALID_FIELD")
    scalar(value)
    if len(value.encode("utf-8")) > MAX_LABEL: fail("LIMIT_EXCEEDED")
    return value
def evaluate_scenario(s):
    if not isinstance(s, dict): fail("INVALID_FIELD")
    profile = required(s, "profile")
    if not isinstance(profile, str): fail("INVALID_FIELD")
    if profile != PROFILE: fail("PROFILE_REJECT")
    required(s, "members"); required(s, "child_states"); required(s, "mode"); exact(s, {"profile", "members", "child_states", "mode", "k"})
    members, children, mode = s["members"], s["child_states"], s["mode"]
    if not isinstance(members, list) or not isinstance(children, list): fail("INVALID_FIELD")
    if not members: fail("INVALID_FIELD")
    if len(members) > MAX_MEMBERS or len(children) > MAX_MEMBERS: fail("LIMIT_EXCEEDED")
    member_set = set()
    for member in members:
        member = label(member)
        if member in member_set: fail("DUPLICATE_MEMBER")
        member_set.add(member)
    states = {}
    for entry in children:
        exact(entry, {"member", "state"}); member = label(required(entry, "member")); state = required(entry, "state")
        if not isinstance(state, str) or state not in {"open", "success", "failure", "cancelled"}: fail("INVALID_FIELD")
        if member in states: fail("DUPLICATE_MEMBER")
        states[member] = state
    for member in states:
        if member not in member_set: fail("UNKNOWN_MEMBER")
    for member in member_set:
        if member not in states: fail("MISSING_MEMBER")
    if not isinstance(mode, str) or mode not in {"all_success", "any_success", "k_of_n_success", "all_terminal"}: fail("INVALID_FIELD")
    k = None
    if mode == "k_of_n_success":
        k = required(s, "k")
        if isinstance(k, bool) or not isinstance(k, int) or k < 1 or k > len(members): fail("K_OUT_OF_RANGE")
    elif "k" in s: fail("K_FORBIDDEN")
    ordered = sorted(member_set, key=cmp_key); counts = {"cancelled":0, "failure":0, "open":0, "success":0}; evidence = []
    for member in ordered:
        state = states[member]; counts[state] += 1; evidence.append({"code":state.upper()+"_MEMBER", "member":member})
    evidence.sort(key=lambda x: (cmp_key(x["code"]), cmp_key(x["member"])))
    if mode == "all_success": outcome = "satisfied" if counts["success"] == len(ordered) else "unsatisfiable" if counts["failure"] or counts["cancelled"] else "waiting"
    elif mode == "any_success": outcome = "satisfied" if counts["success"] else "waiting" if counts["open"] else "unsatisfiable"
    elif mode == "k_of_n_success": outcome = "satisfied" if counts["success"] >= k else "unsatisfiable" if counts["success"] + counts["open"] < k else "waiting"
    else: outcome = "satisfied" if counts["open"] == 0 else "waiting"
    return {"admitted": outcome == "satisfied", "counts":counts, "evidence":evidence, "members":ordered, "mode":mode, "outcome":outcome, "required_successes":k}
def evaluate_bytes(data): return evaluate_scenario(parse_strict(data))
def canonical_json(value):
    if value is None: return "null"
    if value is True: return "true"
    if value is False: return "false"
    if isinstance(value, int):
        if abs(value) > 9007199254740991: fail("UNSAFE_INTEGER")
        return str(value)
    if isinstance(value, str): scalar(value); return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list): return "[" + ",".join(canonical_json(x) for x in value) + "]"
    if isinstance(value, dict): return "{" + ",".join(canonical_json(k)+":"+canonical_json(value[k]) for k in sorted(value, key=cmp_key)) + "}"
    fail("INVALID_FIELD")
