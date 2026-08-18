#!/usr/bin/env python3
"""Run the FULL corpus through the Python witness. Usage: python3 scripts/probe-full-corpus-py.py"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

corpus_path = Path("test/fixtures/a2a/local-admission/v0.1/corpus.json")
witness_path = Path("reference/python/a2a_local_admission_reference.py")
corpus = json.loads(corpus_path.read_text("utf8"))

pass_n = 0
fail_n = 0
with tempfile.TemporaryDirectory() as td:
    for c in corpus["cases"]:
        invocation = {
            "request_json": c["invocation_args"]["request_json"],
            "envelope_json": c["invocation_args"]["envelope_json"],
            "replay_oracle_result": c["invocation_args"]["replay_oracle_result"],
        }
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, dir=td) as f:
            json.dump(invocation, f)
            inv_file = f.name
        proc = subprocess.run(
            ["python3", str(witness_path), "--evaluate-file", inv_file],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if proc.returncode != 0:
            print(f"FAIL {c['id']} (witness exit {proc.returncode}): {proc.stderr[:200]}")
            fail_n += 1
            continue
        actual = json.loads(proc.stdout)
        if json.dumps(actual, sort_keys=True) == json.dumps(c["expected"], sort_keys=True):
            pass_n += 1
        else:
            print(f"FAIL {c['id']}")
            print(f"  expected: {json.dumps(c['expected'])}")
            print(f"  actual:   {json.dumps(actual)}")
            fail_n += 1

print(f"Python corpus: {pass_n} pass / {fail_n} fail / {len(corpus['cases'])} total")
sys.exit(0 if fail_n == 0 else 1)