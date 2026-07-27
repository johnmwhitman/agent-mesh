PROFILE = "meshfleet.a2a.effect-key-collapse.v0.1"
LIMITS = {
    "max_bytes": 65536,
    "max_depth": 16,
    "max_declarations": 64,
    "max_safe_integer": 9007199254740991,
}


class ConformanceError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def fail(code):
    raise ConformanceError(code)


def canonicalize_surrogate_pairs(value):
    output = []
    index = 0
    while index < len(value):
        unit = ord(value[index])
        if 0xD800 <= unit <= 0xDBFF and index + 1 < len(value):
            low = ord(value[index + 1])
            if 0xDC00 <= low <= 0xDFFF:
                output.append(chr(0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00)))
                index += 2
                continue
        output.append(value[index])
        index += 1
    return "".join(output)


def is_delimiter(character):
    return character is None or character in ",]} \n\r\t"


class StrictParser:
    def __init__(self, text):
        self.text = text
        self.index = 0

    def whitespace(self):
        while self.index < len(self.text) and self.text[self.index] in " \n\r\t":
            self.index += 1

    def parse(self):
        self.whitespace()
        value = self.value(1)
        self.whitespace()
        if self.index != len(self.text):
            fail("MALFORMED_JSON")
        return value

    def value(self, depth):
        self.whitespace()
        character = self.text[self.index] if self.index < len(self.text) else None
        if character == "{":
            return self.object(depth)
        if character == "[":
            return self.array(depth)
        if character == '"':
            return self.string()
        if character == "-" or (character is not None and "0" <= character <= "9"):
            return self.number()
        if self.text.startswith("true", self.index):
            self.index += 4
            return True
        if self.text.startswith("false", self.index):
            self.index += 5
            return False
        if self.text.startswith("null", self.index):
            self.index += 4
            return None
        fail("MALFORMED_JSON")

    def object(self, depth):
        if depth > LIMITS["max_depth"]:
            fail("JSON_DEPTH_LIMIT")
        output = {}
        seen = set()
        self.index += 1
        self.whitespace()
        if self.index < len(self.text) and self.text[self.index] == "}":
            self.index += 1
            return output
        while True:
            self.whitespace()
            if self.index >= len(self.text) or self.text[self.index] != '"':
                fail("MALFORMED_JSON")
            key = self.string()
            self.whitespace()
            if self.index >= len(self.text) or self.text[self.index] != ":":
                fail("MALFORMED_JSON")
            self.index += 1
            value = self.value(depth + 1)
            if key in seen:
                fail("DUPLICATE_JSON_KEY")
            seen.add(key)
            output[key] = value
            self.whitespace()
            separator = self.text[self.index] if self.index < len(self.text) else None
            if separator == "}":
                self.index += 1
                return output
            if separator != ",":
                fail("MALFORMED_JSON")
            self.index += 1

    def array(self, depth):
        if depth > LIMITS["max_depth"]:
            fail("JSON_DEPTH_LIMIT")
        output = []
        self.index += 1
        self.whitespace()
        if self.index < len(self.text) and self.text[self.index] == "]":
            self.index += 1
            return output
        while True:
            output.append(self.value(depth + 1))
            self.whitespace()
            separator = self.text[self.index] if self.index < len(self.text) else None
            if separator == "]":
                self.index += 1
                return output
            if separator != ",":
                fail("MALFORMED_JSON")
            self.index += 1

    def string(self):
        if self.index >= len(self.text) or self.text[self.index] != '"':
            fail("MALFORMED_JSON")
        self.index += 1
        output = []
        simple = {'"': '"', "\\": "\\", "/": "/", "b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t"}
        while self.index < len(self.text):
            character = self.text[self.index]
            self.index += 1
            if character == '"':
                return canonicalize_surrogate_pairs("".join(output))
            if character == "\\":
                if self.index >= len(self.text):
                    fail("MALFORMED_JSON")
                escape = self.text[self.index]
                self.index += 1
                if escape in simple:
                    output.append(simple[escape])
                elif escape == "u":
                    digits = self.text[self.index:self.index + 4]
                    if len(digits) != 4 or any(digit not in "0123456789abcdefABCDEF" for digit in digits):
                        fail("MALFORMED_JSON")
                    output.append(chr(int(digits, 16)))
                    self.index += 4
                else:
                    fail("MALFORMED_JSON")
            else:
                if ord(character) < 0x20:
                    fail("MALFORMED_JSON")
                output.append(character)
        fail("MALFORMED_JSON")

    def number(self):
        start = self.index
        if self.text[self.index] == "-":
            self.index += 1
        if self.index < len(self.text) and self.text[self.index] == "0":
            self.index += 1
            if self.index < len(self.text) and "0" <= self.text[self.index] <= "9":
                fail("MALFORMED_JSON")
        else:
            if self.index >= len(self.text) or self.text[self.index] < "1" or self.text[self.index] > "9":
                fail("MALFORMED_JSON")
            while self.index < len(self.text) and "0" <= self.text[self.index] <= "9":
                self.index += 1
        marker = self.text[self.index] if self.index < len(self.text) else None
        if marker in (".", "e", "E"):
            fail("NON_CANONICAL_INTEGER")
        if not is_delimiter(marker):
            fail("MALFORMED_JSON")
        token = self.text[start:self.index]
        if token == "-0":
            fail("NON_CANONICAL_INTEGER")
        value = int(token)
        if abs(value) > LIMITS["max_safe_integer"]:
            fail("UNSAFE_INTEGER")
        return value


def valid_scalar_string(value):
    if not isinstance(value, str):
        return False
    index = 0
    while index < len(value):
        unit = ord(value[index])
        if 0xD800 <= unit <= 0xDBFF:
            if index + 1 >= len(value) or not (0xDC00 <= ord(value[index + 1]) <= 0xDFFF):
                return False
            index += 2
        elif 0xDC00 <= unit <= 0xDFFF:
            return False
        else:
            index += 1
    return True


def scalar_utf8_length(value):
    total = 0
    index = 0
    while index < len(value):
        unit = ord(value[index])
        if 0xD800 <= unit <= 0xDBFF:
            total += 4
            index += 2
        elif unit <= 0x7F:
            total += 1
            index += 1
        elif unit <= 0x7FF:
            total += 2
            index += 1
        elif unit <= 0xFFFF:
            total += 3
            index += 1
        else:
            total += 4
            index += 1
    return total


def validate_unicode(value):
    pending = [value]
    while pending:
        current = pending.pop()
        if isinstance(current, str):
            if not valid_scalar_string(current):
                fail("INVALID_UNICODE")
        elif isinstance(current, list):
            pending.extend(current)
        elif isinstance(current, dict):
            for key, item in current.items():
                if not valid_scalar_string(key):
                    fail("INVALID_UNICODE")
                pending.append(item)


def parse_strict_json(raw):
    if isinstance(raw, str):
        raw = raw.encode("utf-8")
    else:
        raw = bytes(raw)
    if len(raw) > LIMITS["max_bytes"]:
        fail("DOCUMENT_TOO_LARGE")
    if raw.startswith(b"\xef\xbb\xbf"):
        fail("BOM_NOT_ALLOWED")
    try:
        text = raw.decode("utf-8", "strict")
    except UnicodeDecodeError:
        fail("INVALID_UTF8")
    parsed = StrictParser(text).parse()
    validate_unicode(parsed)
    return parsed


def exact_fields(value, required, object_code, unknown_code, missing_code):
    if not isinstance(value, dict):
        fail(object_code)
    allowed = set(required)
    for key in value:
        if key not in allowed:
            fail(unknown_code)
    for key in required:
        if key not in value:
            fail(missing_code)


def validate_and_classify(input_value):
    exact_fields(input_value, ["profile", "declarations"], "ROOT_NOT_OBJECT", "UNKNOWN_ROOT_FIELD", "MISSING_ROOT_FIELD")
    if not isinstance(input_value["profile"], str):
        fail("INVALID_PROFILE_TYPE")
    if not isinstance(input_value["declarations"], list):
        fail("DECLARATIONS_NOT_ARRAY")
    if input_value["profile"] != PROFILE:
        fail("UNSUPPORTED_PROFILE")
    if len(input_value["declarations"]) > LIMITS["max_declarations"]:
        fail("DECLARATION_COUNT_LIMIT")
    grouped = {}
    for declaration in input_value["declarations"]:
        exact_fields(declaration, ["effect_key", "effect_digest"], "DECLARATION_NOT_OBJECT", "UNKNOWN_DECLARATION_FIELD", "MISSING_DECLARATION_FIELD")
        key = declaration["effect_key"]
        digest = declaration["effect_digest"]
        if not isinstance(key, str):
            fail("INVALID_EFFECT_KEY_TYPE")
        if not isinstance(digest, str):
            fail("INVALID_EFFECT_DIGEST_TYPE")
        if scalar_utf8_length(key) > 128:
            fail("EFFECT_KEY_TOO_LONG")
        if not key or not ("A" <= key[0] <= "Z" or "a" <= key[0] <= "z") or len(key) > 128:
            fail("INVALID_EFFECT_KEY")
        if any(not (character.isascii() and (character.isalnum() or character in "._:-")) for character in key):
            fail("INVALID_EFFECT_KEY")
        if len(digest) != 64 or any(character not in "0123456789abcdef" for character in digest):
            fail("INVALID_EFFECT_DIGEST")
        digests = grouped.setdefault(key, {})
        digests[digest] = digests.get(digest, 0) + 1
    groups = []
    for key in sorted(grouped):
        digests = grouped[key]
        groups.append({
            "effect_key": key,
            "classification": "single_digest" if len(digests) == 1 else "digest_conflict",
            "digests": [{"effect_digest": digest, "declaration_count": digests[digest]} for digest in sorted(digests)],
        })
    return {"profile": PROFILE, "outcome": "classified", "groups": groups}


def classify_effect_key_declarations(raw_utf8_json_bytes):
    try:
        return validate_and_classify(parse_strict_json(raw_utf8_json_bytes))
    except ConformanceError as error:
        return {"profile": PROFILE, "outcome": "rejected", "error_code": error.code}


evaluate_bytes = classify_effect_key_declarations
