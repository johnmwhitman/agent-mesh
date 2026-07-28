from __future__ import annotations

import binascii
import hashlib
import re
from dataclasses import dataclass
from typing import Any

PROFILE = "meshfleet.a2a.artifact-bundle-integrity.v0.1"
LIMITS = {
    "MAX_DOCUMENT_BYTES": 12 * 1024 * 1024,
    "MAX_JSON_DEPTH": 16,
    "MAX_ARTIFACTS": 128,
    "MAX_ARTIFACT_ID_BYTES": 64,
    "MAX_LOGICAL_NAME_BYTES": 255,
    "MAX_ENCODED_BYTES_PER_ARTIFACT": 1_398_104,
    "MAX_DECODED_BYTES_PER_ARTIFACT": 1_048_576,
    "MAX_TOTAL_DECODED_BYTES": 8 * 1024 * 1024,
    "MAX_SAFE_INTEGER": 9_007_199_254_740_991,
}


class ProfileError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class JsonNumber:
    value: int
    lexeme: str


def fail(code: str) -> None:
    raise ProfileError(code)


class StrictJsonParser:
    def __init__(self, text: str):
        self.text = text
        self.index = 0

    def parse(self) -> Any:
        self.skip_whitespace()
        value = self.parse_value(0)
        self.skip_whitespace()
        if self.index != len(self.text):
            fail("MALFORMED_JSON")
        return value

    def skip_whitespace(self) -> None:
        while self.index < len(self.text) and self.text[self.index] in " \n\r\t":
            self.index += 1

    def parse_value(self, depth: int) -> Any:
        self.skip_whitespace()
        if self.index >= len(self.text):
            fail("MALFORMED_JSON")
        char = self.text[self.index]
        if char == "{":
            return self.parse_object(depth + 1)
        if char == "[":
            return self.parse_array(depth + 1)
        if char == '"':
            return self.parse_string()
        if self.consume_literal("true"):
            return True
        if self.consume_literal("false"):
            return False
        if self.consume_literal("null"):
            return None
        if char == "-" or char.isdigit():
            return self.parse_number()
        fail("MALFORMED_JSON")

    def consume_literal(self, literal: str) -> bool:
        if self.text.startswith(literal, self.index):
            self.index += len(literal)
            return True
        return False

    def parse_object(self, depth: int) -> dict[str, Any]:
        if depth > LIMITS["MAX_JSON_DEPTH"]:
            fail("JSON_DEPTH_LIMIT")
        self.index += 1
        self.skip_whitespace()
        value: dict[str, Any] = {}
        if self.peek("}"):
            self.index += 1
            return value
        while True:
            if not self.peek('"'):
                fail("MALFORMED_JSON")
            key = self.parse_string()
            if key in value:
                fail("DUPLICATE_JSON_KEY")
            self.skip_whitespace()
            if not self.peek(":"):
                fail("MALFORMED_JSON")
            self.index += 1
            value[key] = self.parse_value(depth)
            self.skip_whitespace()
            if self.peek("}"):
                self.index += 1
                return value
            if not self.peek(","):
                fail("MALFORMED_JSON")
            self.index += 1
            self.skip_whitespace()

    def parse_array(self, depth: int) -> list[Any]:
        if depth > LIMITS["MAX_JSON_DEPTH"]:
            fail("JSON_DEPTH_LIMIT")
        self.index += 1
        self.skip_whitespace()
        value: list[Any] = []
        if self.peek("]"):
            self.index += 1
            return value
        while True:
            value.append(self.parse_value(depth))
            self.skip_whitespace()
            if self.peek("]"):
                self.index += 1
                return value
            if not self.peek(","):
                fail("MALFORMED_JSON")
            self.index += 1
            self.skip_whitespace()

    def parse_string(self) -> str:
        self.index += 1
        output: list[str] = []
        while self.index < len(self.text):
            char = self.text[self.index]
            self.index += 1
            if char == '"':
                return "".join(output)
            if ord(char) < 0x20:
                fail("MALFORMED_JSON")
            if char != "\\":
                if 0xD800 <= ord(char) <= 0xDFFF:
                    fail("INVALID_UNICODE")
                output.append(char)
                continue
            if self.index >= len(self.text):
                fail("MALFORMED_JSON")
            escape = self.text[self.index]
            self.index += 1
            simple = {'"': '"', "\\": "\\", "/": "/", "b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t"}
            if escape in simple:
                output.append(simple[escape])
            elif escape == "u":
                output.append(self.parse_unicode_escape())
            else:
                fail("MALFORMED_JSON")
        fail("MALFORMED_JSON")

    def parse_unicode_escape(self) -> str:
        first = self.read_hex_code_unit()
        if 0xDC00 <= first <= 0xDFFF:
            fail("INVALID_UNICODE")
        if first < 0xD800 or first > 0xDBFF:
            return chr(first)
        if not self.text.startswith("\\u", self.index):
            fail("INVALID_UNICODE")
        self.index += 2
        second = self.read_hex_code_unit()
        if second < 0xDC00 or second > 0xDFFF:
            fail("INVALID_UNICODE")
        return chr(0x10000 + ((first - 0xD800) << 10) + second - 0xDC00)

    def read_hex_code_unit(self) -> int:
        token = self.text[self.index:self.index + 4]
        if not re.fullmatch(r"[0-9a-fA-F]{4}", token):
            fail("MALFORMED_JSON")
        self.index += 4
        return int(token, 16)

    def parse_number(self) -> JsonNumber:
        start = self.index
        if self.peek("-"):
            self.index += 1
        if self.peek("0"):
            self.index += 1
        else:
            if self.index >= len(self.text) or self.text[self.index] not in "123456789":
                fail("MALFORMED_JSON")
            while self.index < len(self.text) and self.text[self.index].isdigit():
                self.index += 1
        if self.index < len(self.text) and self.text[self.index] in ".eE":
            fail("NON_CANONICAL_INTEGER")
        lexeme = self.text[start:self.index]
        if lexeme == "-0":
            fail("NON_CANONICAL_INTEGER")
        value = int(lexeme)
        if abs(value) > LIMITS["MAX_SAFE_INTEGER"]:
            fail("UNSAFE_INTEGER")
        return JsonNumber(value=value, lexeme=lexeme)

    def peek(self, expected: str) -> bool:
        return self.index < len(self.text) and self.text[self.index] == expected


def parse_raw_json(raw_bytes: bytes) -> Any:
    if len(raw_bytes) > LIMITS["MAX_DOCUMENT_BYTES"]:
        fail("DOCUMENT_TOO_LARGE")
    if raw_bytes.startswith(b"\xef\xbb\xbf"):
        fail("BOM_NOT_ALLOWED")
    try:
        text = raw_bytes.decode("utf-8", "strict")
    except UnicodeDecodeError:
        fail("INVALID_UTF8")
    return StrictJsonParser(text).parse()


def assert_exact_object(value: Any, expected: list[str], object_code: str) -> None:
    if not isinstance(value, dict):
        fail(f"{object_code}_NOT_OBJECT")
    for key in value:
        if key not in expected:
            fail(f"UNKNOWN_{object_code}_FIELD")
    for key in expected:
        if key not in value:
            fail(f"MISSING_{object_code}_FIELD")


def assert_string(value: Any, field: str) -> str:
    if not isinstance(value, str):
        fail(f"INVALID_{field}_TYPE")
    return value


def assert_byte_length(value: str, maximum: int, code: str) -> None:
    if len(value.encode("utf-8")) > maximum:
        fail(code)


def decode_canonical_base64(value: str) -> bytes:
    import base64

    if len(value) > LIMITS["MAX_ENCODED_BYTES_PER_ARTIFACT"]:
        fail("BASE64_TOO_LONG")
    if re.fullmatch(r"[A-Za-z0-9+/]*={0,2}", value) is None or len(value) % 4 != 0:
        fail("INVALID_BASE64")
    padding = 2 if value.endswith("==") else 1 if value.endswith("=") else 0
    non_padding_length = len(value) - padding
    if (padding == 1 and non_padding_length % 4 != 3) or (padding == 2 and non_padding_length % 4 != 2):
        fail("INVALID_BASE64")
    try:
        decoded = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error):
        fail("INVALID_BASE64")
    if base64.b64encode(decoded).decode("ascii") != value:
        fail("NON_CANONICAL_BASE64")
    if len(decoded) > LIMITS["MAX_DECODED_BYTES_PER_ARTIFACT"]:
        fail("DECODED_BYTE_LENGTH_LIMIT")
    return decoded


def validate_artifact(value: Any) -> dict[str, Any]:
    assert_exact_object(value, ["artifact_id", "logical_name", "content_base64", "decoded_byte_length", "sha256"], "ARTIFACT")
    artifact_id = assert_string(value["artifact_id"], "ARTIFACT_ID")
    logical_name = assert_string(value["logical_name"], "LOGICAL_NAME")
    content_base64 = assert_string(value["content_base64"], "CONTENT_BASE64")
    if not isinstance(value["decoded_byte_length"], JsonNumber):
        fail("INVALID_DECODED_BYTE_LENGTH_TYPE")
    sha256 = assert_string(value["sha256"], "SHA256")
    assert_byte_length(artifact_id, LIMITS["MAX_ARTIFACT_ID_BYTES"], "ARTIFACT_ID_TOO_LONG")
    if re.fullmatch(r"[A-Za-z][A-Za-z0-9._-]{0,63}", artifact_id) is None:
        fail("INVALID_ARTIFACT_ID")
    assert_byte_length(logical_name, LIMITS["MAX_LOGICAL_NAME_BYTES"], "LOGICAL_NAME_TOO_LONG")
    if re.fullmatch(r"[a-z0-9][a-z0-9._-]*(?:/[a-z0-9][a-z0-9._-]*)*", logical_name) is None or any(segment in (".", "..") for segment in logical_name.split("/")):
        fail("INVALID_LOGICAL_NAME")
    decoded = decode_canonical_base64(content_base64)
    declared = value["decoded_byte_length"]
    if re.fullmatch(r"(?:0|[1-9][0-9]*)", declared.lexeme) is None or declared.value > LIMITS["MAX_DECODED_BYTES_PER_ARTIFACT"]:
        fail("INVALID_DECODED_BYTE_LENGTH")
    if re.fullmatch(r"[0-9a-f]{64}", sha256) is None:
        fail("INVALID_SHA256")
    return {"artifact_id": artifact_id, "logical_name": logical_name, "content_base64": content_base64, "declared": declared.value, "sha256": sha256, "decoded": decoded}


def canonical_output(value: Any) -> str:
    import json

    return json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True)


def rejected(code: str) -> dict[str, Any]:
    return {"profile": PROFILE, "outcome": "rejected", "error_code": code}


def verified(entries: list[dict[str, Any]], total: int) -> dict[str, Any]:
    artifacts = [
        {"artifact_id": entry["artifact_id"], "logical_name": entry["logical_name"], "decoded_byte_length": len(entry["decoded"]), "sha256": entry["sha256"]}
        for entry in entries
    ]
    artifacts.sort(key=lambda entry: (entry["logical_name"].encode("ascii"), entry["artifact_id"].encode("ascii")))
    return {"profile": PROFILE, "outcome": "verified", "artifact_count": len(artifacts), "total_decoded_bytes": total, "artifacts": artifacts}


def evaluate_artifact_bundle_integrity(raw_bytes: bytes) -> str:
    try:
        root = parse_raw_json(raw_bytes)
        assert_exact_object(root, ["profile", "artifacts"], "ROOT")
        if root["profile"] != PROFILE:
            fail("UNSUPPORTED_PROFILE")
        if not isinstance(root["artifacts"], list):
            fail("ARTIFACTS_NOT_ARRAY")
        if len(root["artifacts"]) > LIMITS["MAX_ARTIFACTS"]:
            fail("ARTIFACT_COUNT_LIMIT")
        entries = [validate_artifact(value) for value in root["artifacts"]]
        ids: set[str] = set()
        for entry in entries:
            if entry["artifact_id"] in ids:
                fail("DUPLICATE_ARTIFACT_ID")
            ids.add(entry["artifact_id"])
        names: set[str] = set()
        for entry in entries:
            if entry["logical_name"] in names:
                fail("DUPLICATE_LOGICAL_NAME")
            names.add(entry["logical_name"])
        declared_total = sum(entry["declared"] for entry in entries)
        if declared_total > LIMITS["MAX_TOTAL_DECODED_BYTES"]:
            fail("TOTAL_DECODED_BYTES_LIMIT")
        for entry in entries:
            if len(entry["decoded"]) != entry["declared"]:
                fail("DECODED_BYTE_LENGTH_MISMATCH")
        for entry in entries:
            if hashlib.sha256(entry["decoded"]).hexdigest() != entry["sha256"]:
                fail("SHA256_MISMATCH")
        return canonical_output(verified(entries, declared_total))
    except ProfileError as error:
        return canonical_output(rejected(error.code))
    except Exception:
        return canonical_output(rejected("MALFORMED_JSON"))
