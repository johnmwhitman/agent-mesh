from __future__ import annotations

import base64
import hashlib
import json
import sys
from pathlib import Path

from evaluator import LIMITS, PROFILE, evaluate_artifact_bundle_integrity


ROOT = Path(__file__).resolve().parents[1]


def expected_canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True)


def raw_bytes(case_definition: dict) -> bytes:
    if "raw_json" in case_definition:
        return case_definition["raw_json"].encode("utf-8")
    return base64.urlsafe_b64decode(case_definition["raw_base64url"] + "=" * (-len(case_definition["raw_base64url"]) % 4))


def run_corpus() -> str:
    corpus = json.loads((ROOT / "corpus/v0.1/cases.json").read_text("utf-8"))
    transcript: list[str] = []
    for definition in corpus["cases"]:
        actual = evaluate_artifact_bundle_integrity(raw_bytes(definition))
        expected = expected_canonical(definition["expected_output"])
        if actual != expected:
            raise RuntimeError(f"{definition['id']}: expected {expected}, got {actual}")
        transcript.append(f"{definition['id']}\n{actual}\n")
    return expected_canonical({"cases": len(corpus["cases"]), "mandatory_cases": sum(1 for item in corpus["cases"] if item["mandatory"]), "passed": True, "transcript_sha256": hashlib.sha256("".join(transcript).encode("utf-8")).hexdigest()})


def raw_bundle(artifacts: list[dict]) -> str:
    return json.dumps({"profile": PROFILE, "artifacts": artifacts}, separators=(",", ":"))


def valid(artifact_id: str = "A1", logical_name: str = "docs/a.txt", content_base64: str = "YWJj", length: int = 3, sha256: str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad") -> dict:
    return {"artifact_id": artifact_id, "logical_name": logical_name, "content_base64": content_base64, "decoded_byte_length": length, "sha256": sha256}


def rejected(code: str) -> str:
    return expected_canonical({"profile": PROFILE, "outcome": "rejected", "error_code": code})


def verified(artifacts: list[dict], total_decoded_bytes: int) -> str:
    projection = [
        {"artifact_id": item["artifact_id"], "logical_name": item["logical_name"], "decoded_byte_length": item["decoded_byte_length"], "sha256": item["sha256"]}
        for item in artifacts
    ]
    projection.sort(key=lambda item: (item["logical_name"].encode("ascii"), item["artifact_id"].encode("ascii")))
    return expected_canonical({"profile": PROFILE, "outcome": "verified", "artifact_count": len(projection), "total_decoded_bytes": total_decoded_bytes, "artifacts": projection})


def run_self_test() -> str:
    cases: list[tuple[str, bytes, str]] = []
    add = lambda label, raw, expected: cases.append((label, raw if isinstance(raw, bytes) else raw.encode("utf-8"), expected))
    add("valid-abc", raw_bundle([valid()]), verified([valid()], 3))
    add("empty", raw_bundle([valid("Empty", "empty", "", 0, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")]), verified([valid("Empty", "empty", "", 0, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")], 0))
    add("id-boundary", raw_bundle([valid("A" * 64, "id-boundary")]), verified([valid("A" * 64, "id-boundary")], 3))
    add("id-over-boundary", raw_bundle([valid("A" * 65, "id-over")]), "ARTIFACT_ID_TOO_LONG")
    add("name-boundary", raw_bundle([valid("N1", "a" * 255)]), verified([valid("N1", "a" * 255)], 3))
    add("name-over-boundary", raw_bundle([valid("N1", "a" * 256)]), "LOGICAL_NAME_TOO_LONG")
    add("base64-upper-lower-plus-slash", raw_bundle([valid("B64", "binary", "+/8=", 2, "0" * 64)]), "SHA256_MISMATCH")
    add("base64-one-padding", raw_bundle([valid("Pad1", "pad/one", "TWE=", 2, "0" * 64)]), "SHA256_MISMATCH")
    add("base64-two-padding", raw_bundle([valid("Pad2", "pad/two", "TQ==", 1, "0" * 64)]), "SHA256_MISMATCH")
    add("nonzero-pad-bits", raw_bundle([valid("PadBits", "pad/bits", "TR==", 1, "0" * 64)]), "NON_CANONICAL_BASE64")
    add("binary-octets", raw_bundle([valid("Octet", "binary/octet", "/w==", 1, "0" * 64)]), "SHA256_MISMATCH")
    add("per-artifact-encoded-limit", raw_bundle([valid("Long", "limits/encoded", "A" * (LIMITS["MAX_ENCODED_BYTES_PER_ARTIFACT"] + 4), 0, "0" * 64)]), "BASE64_TOO_LONG")
    add("artifact-count-limit", raw_bundle([valid(f"A{index}", f"count/a{index}", "", 0, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855") for index in range(LIMITS["MAX_ARTIFACTS"] + 1)]), "ARTIFACT_COUNT_LIMIT")
    add("total-declared-limit", raw_bundle([valid(f"T{index}", f"total/a{index}", "", LIMITS["MAX_DECODED_BYTES_PER_ARTIFACT"], "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855") for index in range(9)]), "TOTAL_DECODED_BYTES_LIMIT")
    add("duplicate-before-digest", raw_bundle([valid("D1", "one", "YWJj", 3, "0" * 64), valid("D1", "two", "YWJj", 3, "0" * 64)]), "DUPLICATE_ARTIFACT_ID")
    add("invalid-id-before-base64", raw_bundle([valid("1bad", "good", "???", 0, "0" * 64)]), "INVALID_ARTIFACT_ID")
    add("bom", bytes([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), "BOM_NOT_ALLOWED")
    add("invalid-utf8", bytes([0xff, 0x7b, 0x7d]), "INVALID_UTF8")
    add("surrogate", '{"profile":"\\uD800","artifacts":[]}', "INVALID_UNICODE")
    add("unsafe-integer", raw_bundle([valid("U1", "unsafe", "", 9007199254740992, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")]), "UNSAFE_INTEGER")
    add("noncanonical-integer", '{"profile":"meshfleet.a2a.artifact-bundle-integrity.v0.1","artifacts":[{"artifact_id":"A1","logical_name":"x","content_base64":"","decoded_byte_length":1e0,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}]}', "NON_CANONICAL_INTEGER")
    add("depth", "[" * 17 + "0" + "]" * 17, "JSON_DEPTH_LIMIT")
    for label, raw, expected in cases:
        actual = evaluate_artifact_bundle_integrity(raw)
        expected_output = expected if expected.startswith("{") else rejected(expected)
        if actual != expected_output:
            raise RuntimeError(f"{label}: expected {expected}, got {actual}")
    permutation_artifacts = [valid("Z1", "z/z", "", 0, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"), valid()]
    expected_permutation = verified(permutation_artifacts, 3)
    left = evaluate_artifact_bundle_integrity(raw_bundle(permutation_artifacts).encode("utf-8"))
    right = evaluate_artifact_bundle_integrity(raw_bundle(list(reversed(permutation_artifacts))).encode("utf-8"))
    if left != right:
        raise RuntimeError("permutation-output mismatch")
    if left != expected_permutation:
        raise RuntimeError(f"permutation-projection: expected {expected_permutation}, got {left}")
    return expected_canonical({"cases": len(cases) + 1, "passed": True, "suite": "self"})


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "--self-test":
        print(run_self_test())
    elif len(sys.argv) > 1 and sys.argv[1] == "--single-base64url":
        print(evaluate_artifact_bundle_integrity(base64.urlsafe_b64decode((sys.argv[2] if len(sys.argv) > 2 else "") + "=" * (-(len(sys.argv[2]) if len(sys.argv) > 2 else 0) % 4))))
    else:
        print(run_corpus())


if __name__ == "__main__":
    main()
