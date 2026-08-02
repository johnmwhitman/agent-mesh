import base64
import binascii
import hashlib
import json
import os
import sys
from evaluator import PROFILE, evaluate_bytes

# Byte-differential contract: stdout is UTF-8 with "\n" newlines on every platform. The five
# runners patched in #106 proved this line on real windows-2022 CI; the unpatched ones failed
# there (#108 first run) -- Windows text-mode stdout emits \r\n from print(), bytes the
# JavaScript side of the differential never emits, and cp1252 cannot encode all corpus content.
sys.stdout.reconfigure(encoding="utf-8", newline="\n")


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CORPUS_PATH = os.path.join(ROOT, "corpus", "v0.1", "cases.json")


def encode_expected(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"))


def decode_base64url(value):
    if not isinstance(value, str) or any(character not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_" for character in value) or len(value) % 4 == 1:
        raise ValueError("INVALID_BASE64URL")
    try:
        return base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)
    except (binascii.Error, ValueError):
        raise ValueError("INVALID_BASE64URL") from None


def raw_case(item):
    if "raw_json" in item:
        return item["raw_json"].encode("utf-8")
    return decode_base64url(item["raw_base64url"])


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


if len(sys.argv) == 3 and sys.argv[1] == "--raw-base64url":
    raw = decode_base64url(sys.argv[2])
    sys.stdout.write(json.dumps(evaluate_bytes(raw), ensure_ascii=True, separators=(",", ":")))
elif len(sys.argv) == 2 and sys.argv[1] == "--raw-stdin":
    # Same evaluation as --raw-base64url, payload on stdin instead of argv. Exists because a
    # corpus document can exceed an OS argv limit: M51-document-too-large is an 87,383-character
    # base64url argument, and Windows CreateProcess caps a command line at 32,767 characters, so
    # the argv transport cannot carry it there at all (measured on the #108 CI matrix).
    raw = decode_base64url(sys.stdin.read().strip())
    sys.stdout.write(json.dumps(evaluate_bytes(raw), ensure_ascii=True, separators=(",", ":")))
elif len(sys.argv) == 1 or (len(sys.argv) == 2 and sys.argv[1] == "--corpus"):
    sys.stdout.write(json.dumps(run_corpus(), ensure_ascii=True, separators=(",", ":")))
elif len(sys.argv) == 2 and sys.argv[1] == "--hash-corpus":
    with open(CORPUS_PATH, "rb") as handle:
        sys.stdout.write(hashlib.sha256(handle.read()).hexdigest())
elif len(sys.argv) == 2 and sys.argv[1] == "--self":
    sys.stdout.write(json.dumps(run_self(), ensure_ascii=True, separators=(",", ":")))
else:
    raise ValueError("invalid arguments: " + " ".join(sys.argv[1:]))
