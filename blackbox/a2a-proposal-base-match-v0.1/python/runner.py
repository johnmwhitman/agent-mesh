from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

from evaluator import evaluate_proposal_base_match

HERE = Path(__file__).resolve().parent.parent


def stable_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True)


def raw_bytes(case: dict[str, object]) -> bytes:
    if "raw_base64url" in case:
        token = str(case["raw_base64url"])
        return base64.urlsafe_b64decode(token + "=" * (-len(token) % 4))
    return str(case["raw_json"]).encode("utf-8")


def run_corpus() -> dict[str, object]:
    corpus = json.loads((HERE / "corpus/v0.1/cases.json").read_text("utf-8"))
    for case in corpus["cases"]:
        actual = evaluate_proposal_base_match(raw_bytes(case))
        if stable_json(actual) != stable_json(case["expected_output"]):
            raise RuntimeError(f"case {case['id']} mismatch")
    return {"cases": len(corpus["cases"]), "passed": True, "suite": "corpus"}


def self_check() -> dict[str, object]:
    source = (HERE / "python/evaluator.py").read_text("utf-8")
    forbidden = ("import os", "import pathlib", "open(", "subprocess", "socket", "urllib", "requests", "http.client")
    if any(token in source for token in forbidden):
        raise RuntimeError("evaluator I/O boundary violation")
    raw = b'{"profile":"meshfleet.a2a.proposal-base-match.v0.1","comparison_revision":"R","proposals":[{"proposal_id":"P","base_revision":"R"}]}'
    if evaluate_proposal_base_match(raw)["classification"] != "single_match":
        raise RuntimeError("self control mismatch")
    return {"cases": 2, "passed": True, "suite": "self"}


if "--raw-base64url" in sys.argv:
    token = sys.argv[sys.argv.index("--raw-base64url") + 1]
    raw = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4))
    print(stable_json(evaluate_proposal_base_match(raw)))
elif "--self" in sys.argv:
    print(stable_json(self_check()))
else:
    print(stable_json(run_corpus()))
