import base64, hashlib, json, sys
from pathlib import Path
from evaluator import BarrierError, PROFILE, canonical_json, evaluate_bytes
ROOT = Path(__file__).resolve().parents[1]
def one(case):
    data = base64.b64decode(case["raw_base64"]) if "raw_base64" in case else json.dumps(case["input"], ensure_ascii=False, separators=(",", ":")).encode()
    try:
        output = evaluate_bytes(data)
        if "expected_error" in case: raise RuntimeError("expected error")
        if canonical_json(output) != canonical_json(case["expected"]): raise RuntimeError("frozen expectation mismatch")
        return {"id":case["id"], "output":output}
    except BarrierError as error:
        if case.get("expected_error") != error.code: raise RuntimeError(f"{case['id']}: expected {case.get('expected_error')}, got {error.code}")
        return {"error":error.code, "id":case["id"]}
def corpus():
    raw = (ROOT / "corpus/v0.1/cases.json").read_bytes(); data = json.loads(raw)
    results = [one(case) for case in data["cases"]]
    return {"corpus_sha256":hashlib.sha256(raw).hexdigest(), "mandatory":sum(c.get("mandatory", False) for c in data["cases"]), "passed":len(results), "profile":data["profile"], "results":results, "total":len(results)}
def self_test():
    def nested(n): return ("[" * n + "0" + "]" * n).encode()
    def sized(n): return (b'{"a":"' + b"x" * (n - 8) + b'"}')
    controls = [
        {"raw_base64":"/w==", "expected_error":"INVALID_UTF8"}, {"raw_base64":base64.b64encode(b'\xef\xbb\xbf{}').decode(), "expected_error":"MALFORMED_JSON"}, {"raw_base64":base64.b64encode(b'{"a":').decode(), "expected_error":"MALFORMED_JSON"}, {"raw_base64":base64.b64encode(b'{"a":1,"a":2}').decode(), "expected_error":"DUPLICATE_MEMBER"},
        {"raw_base64":base64.b64encode(b'{"a":1.5}').decode(), "expected_error":"NON_CANONICAL_INTEGER"}, {"raw_base64":base64.b64encode(b'{"a":-0}').decode(), "expected_error":"NON_CANONICAL_INTEGER"}, {"raw_base64":base64.b64encode(b'{"a":9007199254740992}').decode(), "expected_error":"UNSAFE_INTEGER"}, {"raw_base64":base64.b64encode(b'{"a":"\\ud83d\\ude00"}').decode(), "expected_error":"MISSING_FIELD"}, {"raw_base64":base64.b64encode(b'{"a":"\\ud800"}').decode(), "expected_error":"INVALID_UNICODE"},
        {"raw_base64":base64.b64encode(nested(64)).decode(), "expected_error":"INVALID_FIELD"}, {"raw_base64":base64.b64encode(nested(65)).decode(), "expected_error":"DEPTH_LIMIT"}, {"raw_base64":base64.b64encode(sized(131072)).decode(), "expected_error":"MISSING_FIELD"}, {"raw_base64":base64.b64encode(sized(131073)).decode(), "expected_error":"SIZE_LIMIT"},
        {"input":{"profile":PROFILE, "members":["a", "a"], "child_states":[], "mode":"not-a-mode", "extra":True}, "expected_error":"UNKNOWN_FIELD"}, {"input":{"profile":PROFILE, "members":["a"], "child_states":[], "mode":"not-a-mode"}, "expected_error":"MISSING_MEMBER"}
    ]
    for case in controls: one({"id":"self", **case})
    return {"controls":len(controls), "profile":PROFILE, "self_test":"passed"}
def receipt(data):
    try: return {"output":evaluate_bytes(data)}
    except BarrierError as error: return {"error":error.code}
if "--stdin" in sys.argv:
    data = sys.stdin.buffer.read()
    if "--receipt" in sys.argv: sys.stdout.write(canonical_json(receipt(data)))
    else:
        value = receipt(data)
        if "error" in value: sys.stderr.write(value["error"] + "\n"); sys.exit(2)
        sys.stdout.write(canonical_json(value["output"]))
else: sys.stdout.write(canonical_json(self_test() if "--self-test" in sys.argv else corpus()) + "\n")
