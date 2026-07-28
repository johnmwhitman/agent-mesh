from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

PROFILE = "meshfleet.a2a.proposal-base-match.v0.1"
MAX_DOCUMENT_BYTES = 65536
MAX_JSON_DEPTH = 16
MAX_PROPOSALS = 32
MAX_TOKEN_UTF8_BYTES = 128
MAX_SAFE_INTEGER = 9007199254740991
TOKEN_RE = re.compile(r"^[A-Za-z][A-Za-z0-9._:-]{0,127}$")


@dataclass
class ProfileError(Exception):
    code: str


def fail(code: str) -> None:
    raise ProfileError(code)


def valid_scalar(value: Any) -> bool:
    return isinstance(value, str) and not any(0xD800 <= ord(ch) <= 0xDFFF for ch in value)


def whitespace(ch: str) -> bool:
    return ch in (" ", "\n", "\r", "\t")


class StrictJsonParser:
    def __init__(self, text: str) -> None:
        self.text = text
        self.index = 0

    def parse(self) -> Any:
        self.skip()
        value = self.value(0)
        self.skip()
        if self.index != len(self.text):
            fail("MALFORMED_JSON")
        return value

    def skip(self) -> None:
        while self.index < len(self.text) and whitespace(self.text[self.index]):
            self.index += 1

    def value(self, depth: int) -> Any:
        self.skip()
        if self.index >= len(self.text):
            fail("MALFORMED_JSON")
        ch = self.text[self.index]
        if ch == "{":
            return self.object(depth + 1)
        if ch == "[":
            return self.array(depth + 1)
        if ch == '"':
            return self.string()
        if ch == "t":
            self.literal("true")
            return True
        if ch == "f":
            self.literal("false")
            return False
        if ch == "n":
            self.literal("null")
            return None
        if ch == "-" or "0" <= ch <= "9":
            return self.number()
        fail("MALFORMED_JSON")

    def literal(self, token: str) -> None:
        if self.text[self.index:self.index + len(token)] != token:
            fail("MALFORMED_JSON")
        self.index += len(token)

    def object(self, depth: int) -> dict[str, Any]:
        if depth > MAX_JSON_DEPTH:
            fail("JSON_DEPTH_LIMIT")
        self.index += 1
        self.skip()
        output: dict[str, Any] = {}
        if self.index < len(self.text) and self.text[self.index] == "}":
            self.index += 1
            return output
        while True:
            if self.index >= len(self.text) or self.text[self.index] != '"':
                fail("MALFORMED_JSON")
            key = self.string()
            self.skip()
            if self.index >= len(self.text) or self.text[self.index] != ":":
                fail("MALFORMED_JSON")
            self.index += 1
            item = self.value(depth)
            if key in output:
                fail("DUPLICATE_JSON_KEY")
            output[key] = item
            self.skip()
            if self.index < len(self.text) and self.text[self.index] == "}":
                self.index += 1
                return output
            if self.index >= len(self.text) or self.text[self.index] != ",":
                fail("MALFORMED_JSON")
            self.index += 1
            self.skip()

    def array(self, depth: int) -> list[Any]:
        if depth > MAX_JSON_DEPTH:
            fail("JSON_DEPTH_LIMIT")
        self.index += 1
        self.skip()
        output: list[Any] = []
        if self.index < len(self.text) and self.text[self.index] == "]":
            self.index += 1
            return output
        while True:
            output.append(self.value(depth))
            self.skip()
            if self.index < len(self.text) and self.text[self.index] == "]":
                self.index += 1
                return output
            if self.index >= len(self.text) or self.text[self.index] != ",":
                fail("MALFORMED_JSON")
            self.index += 1
            self.skip()

    def string(self) -> str:
        self.index += 1
        output: list[str] = []
        while self.index < len(self.text):
            ch = self.text[self.index]
            self.index += 1
            if ch == '"':
                return "".join(output)
            if ord(ch) < 0x20:
                fail("MALFORMED_JSON")
            if ch != "\\":
                output.append(ch)
                continue
            if self.index >= len(self.text):
                fail("MALFORMED_JSON")
            escaped = self.text[self.index]
            self.index += 1
            if escaped in ('"', "\\", "/"):
                output.append(escaped)
            elif escaped == "b":
                output.append("\b")
            elif escaped == "f":
                output.append("\f")
            elif escaped == "n":
                output.append("\n")
            elif escaped == "r":
                output.append("\r")
            elif escaped == "t":
                output.append("\t")
            elif escaped == "u":
                output.append(self.unicode_escape())
            else:
                fail("MALFORMED_JSON")
        fail("MALFORMED_JSON")

    def unicode_escape(self) -> str:
        first = self.hex_code_unit()
        if not (0xD800 <= first <= 0xDBFF) or self.text[self.index:self.index + 2] != "\\u":
            return chr(first)
        saved = self.index
        self.index += 2
        second = self.hex_code_unit()
        if not (0xDC00 <= second <= 0xDFFF):
            self.index = saved
            return chr(first)
        return chr(0x10000 + ((first - 0xD800) << 10) + second - 0xDC00)

    def hex_code_unit(self) -> int:
        token = self.text[self.index:self.index + 4]
        if re.fullmatch(r"[0-9a-fA-F]{4}", token) is None:
            fail("MALFORMED_JSON")
        self.index += 4
        return int(token, 16)

    def number(self) -> int:
        start = self.index
        if self.text[self.index] == "-":
            self.index += 1
        if self.index >= len(self.text):
            fail("MALFORMED_JSON")
        if self.text[self.index] == "0":
            self.index += 1
        else:
            if not ("1" <= self.text[self.index] <= "9"):
                fail("MALFORMED_JSON")
            while self.index < len(self.text) and "0" <= self.text[self.index] <= "9":
                self.index += 1
        if self.index < len(self.text) and self.text[self.index] in (".", "e", "E"):
            fail("NON_CANONICAL_INTEGER")
        token = self.text[start:self.index]
        if token == "-0":
            fail("NON_CANONICAL_INTEGER")
        try:
            value = int(token)
        except ValueError:
            fail("MALFORMED_JSON")
        if abs(value) > MAX_SAFE_INTEGER:
            fail("UNSAFE_INTEGER")
        return value


def validate_unicode(value: Any) -> None:
    if isinstance(value, str):
        if not valid_scalar(value):
            fail("INVALID_UNICODE")
    elif isinstance(value, list):
        for item in value:
            validate_unicode(item)
    elif isinstance(value, dict):
        for key, item in value.items():
            validate_unicode(key)
            validate_unicode(item)


def parse_raw_json(raw: bytes | bytearray | str) -> Any:
    try:
        data = raw.encode("utf-8") if isinstance(raw, str) else bytes(raw)
    except UnicodeEncodeError:
        fail("INVALID_UNICODE")
    if len(data) > MAX_DOCUMENT_BYTES:
        fail("DOCUMENT_TOO_LARGE")
    if data.startswith(b"\xef\xbb\xbf"):
        fail("BOM_NOT_ALLOWED")
    try:
        text = data.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        fail("INVALID_UTF8")
    try:
        value = StrictJsonParser(text).parse()
    except ProfileError:
        raise
    except (RecursionError, ValueError, IndexError):
        fail("MALFORMED_JSON")
    validate_unicode(value)
    return value


def exact_object(value: Any, fields: list[str], kind: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        fail(f"{kind}_NOT_OBJECT")
    for key in value:
        if key not in fields:
            fail(f"UNKNOWN_{kind}_FIELD")
    for key in fields:
        if key not in value:
            fail(f"MISSING_{kind}_FIELD")
    return value


def text(value: Any, code: str) -> str:
    if not isinstance(value, str):
        fail(code)
    return value


def token(value: str, length_code: str, grammar_code: str) -> str:
    if len(value.encode("utf-8")) > MAX_TOKEN_UTF8_BYTES:
        fail(length_code)
    if TOKEN_RE.fullmatch(value) is None:
        fail(grammar_code)
    return value


def rejected(error_code: str) -> dict[str, Any]:
    return {"profile": PROFILE, "outcome": "rejected", "error_code": error_code}


def classified(classification: str, matching: list[str], nonmatching: list[str]) -> dict[str, Any]:
    return {
        "profile": PROFILE,
        "outcome": "classified",
        "classification": classification,
        "matching_proposal_ids": sorted(matching),
        "nonmatching_proposal_ids": sorted(nonmatching),
    }


def evaluate_proposal_base_match(raw_utf8_json_bytes: bytes | bytearray | str) -> dict[str, Any]:
    try:
        root = exact_object(parse_raw_json(raw_utf8_json_bytes), ["profile", "comparison_revision", "proposals"], "ROOT")
        profile = text(root["profile"], "INVALID_PROFILE_TYPE")
        comparison_revision = text(root["comparison_revision"], "INVALID_COMPARISON_REVISION_TYPE")
        proposals_value = root["proposals"]
        if not isinstance(proposals_value, list):
            fail("PROPOSALS_NOT_ARRAY")
        if profile != PROFILE:
            fail("UNSUPPORTED_PROFILE")
        token(comparison_revision, "COMPARISON_REVISION_TOO_LONG", "INVALID_COMPARISON_REVISION")
        if len(proposals_value) > MAX_PROPOSALS:
            fail("PROPOSAL_COUNT_LIMIT")

        proposals: list[dict[str, str]] = []
        for raw_proposal in proposals_value:
            proposal = exact_object(raw_proposal, ["proposal_id", "base_revision"], "PROPOSAL")
            proposal_id = text(proposal["proposal_id"], "INVALID_PROPOSAL_ID_TYPE")
            base_revision = text(proposal["base_revision"], "INVALID_BASE_REVISION_TYPE")
            proposals.append({
                "proposal_id": token(proposal_id, "PROPOSAL_ID_TOO_LONG", "INVALID_PROPOSAL_ID"),
                "base_revision": token(base_revision, "BASE_REVISION_TOO_LONG", "INVALID_BASE_REVISION"),
            })

        seen: set[str] = set()
        for proposal in proposals:
            if proposal["proposal_id"] in seen:
                fail("DUPLICATE_PROPOSAL_ID")
            seen.add(proposal["proposal_id"])

        matching = [proposal["proposal_id"] for proposal in proposals if proposal["base_revision"] == comparison_revision]
        nonmatching = [proposal["proposal_id"] for proposal in proposals if proposal["base_revision"] != comparison_revision]
        if not proposals:
            return classified("empty", matching, nonmatching)
        if len(matching) == 1 and not nonmatching:
            return classified("single_match", matching, nonmatching)
        if len(matching) >= 2 and not nonmatching:
            return classified("multiple_match", matching, nonmatching)
        if not matching:
            return classified("no_match", matching, nonmatching)
        return classified("mixed_match", matching, nonmatching)
    except ProfileError as error:
        return rejected(error.code)
