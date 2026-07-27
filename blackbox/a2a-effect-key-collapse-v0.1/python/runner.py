import base64
import hashlib
import json
import os
import sys
from evaluator import PROFILE, evaluate_bytes

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CORPUS_PATH = os.path.join(ROOT, "corpus", "v0.1", "cases.json")


def encode_expected(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"))


def raw_case(item):
    if "raw_json" in item:
        return item["raw_json"].encode("utf-8")
    return base64.urlsafe_b64decode(item["raw_base64url"] + "=" * (-len(item["raw_base64url"]) % 4))


def assert_equal(actual, expected, label):
    if encode_expected(actual) != encode_expected(expected):
        raise RuntimeError(label + ": projection mismatch")


def run_corpus():
    with open(CORPUS_PATH, "r", encoding="utf-8") as handle:
        corpus = json.load(handle)
    for item in corpus["cases"]:
        assert_equal(evaluate_bytes(raw_case(item)), item["expected_output"], item["id"])
    return {"suite": "corpus", "cases": len(corpus["cases"]), "passed": True}


def run_self():
    digest = "a" * 64
    assert_equal(evaluate_bytes(json.dumps({"profile": PROFILE, "declarations": [{"effect_key": "K", "effect_digest": digest}]}).encode("utf-8")), {
        "profile": PROFILE, "outcome": "classified", "groups": [{"effect_key": "K", "classification": "single_digest", "digests": [{"effect_digest": digest, "declaration_count": 1}]}]
    }, "self-valid")
    assert_equal(evaluate_bytes(b'{"profile":1,"declarations":[]}'), {"profile": PROFILE, "outcome": "rejected", "error_code": "INVALID_PROFILE_TYPE"}, "self-precedence")
    with open(os.path.join(ROOT, "evaluator.mjs"), "r", encoding="utf-8") as handle:
        javascript = handle.read()
    if any(token in javascript for token in ("node:fs", "node:net", "node:http", "node:child_process", "fetch(", "process.")):
        raise RuntimeError("self-no-io")
    return {"suite": "self", "cases": 3, "passed": True}


if len(sys.argv) > 1 and sys.argv[1] == "--raw-base64url":
    raw = base64.urlsafe_b64decode((sys.argv[2] if len(sys.argv) > 2 else "") + "=" * (-(len(sys.argv[2]) if len(sys.argv) > 2 else 0) % 4))
    sys.stdout.write(json.dumps(evaluate_bytes(raw), ensure_ascii=True, separators=(",", ":")))
elif len(sys.argv) == 1 or sys.argv[1] == "--corpus":
    sys.stdout.write(json.dumps(run_corpus(), ensure_ascii=True, separators=(",", ":")))
elif len(sys.argv) > 1 and sys.argv[1] == "--hash-corpus":
    with open(CORPUS_PATH, "rb") as handle:
        sys.stdout.write(hashlib.sha256(handle.read()).hexdigest())
elif sys.argv[1] == "--self":
    sys.stdout.write(json.dumps(run_self(), ensure_ascii=True, separators=(",", ":")))
else:
    raise ValueError("unknown argument: " + sys.argv[1])
