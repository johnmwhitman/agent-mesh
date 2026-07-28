#!/usr/bin/env python3
"""Dependency-free Python raw-stdio parity witness for Meshfleet."""

from __future__ import annotations

import hashlib
import json
import os
import queue
import signal
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable


HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
CONTRACT_PATH = HERE / "contract.json"
EXPECTED_OPERATIONS = [
    "initialize",
    "notifications/initialized",
    "ping",
    "tools/list",
    "tools/call:get_health",
    "tools/call:unknown",
]


class WitnessError(RuntimeError):
    pass


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def reject_json_constant(token: str) -> None:
    raise ValueError(f"non-standard JSON constant {token}")


def reject_duplicate_members(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, member in pairs:
        if key in value:
            raise ValueError(f"duplicate JSON member {key!r}")
        value[key] = member
    return value


def strict_json_loads(text: str, fault: str = "INVALID_JSON") -> Any:
    try:
        return json.loads(
            text,
            parse_constant=reject_json_constant,
            object_pairs_hook=reject_duplicate_members,
        )
    except (json.JSONDecodeError, ValueError) as exc:
        raise WitnessError(fault) from exc


def compact_json(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def normalize_scalar_string(value: str) -> str:
    output: list[str] = []
    index = 0
    while index < len(value):
        code = ord(value[index])
        if 0xD800 <= code <= 0xDBFF:
            if index + 1 >= len(value):
                raise WitnessError("canonical strings may not contain lone surrogates")
            low = ord(value[index + 1])
            if not 0xDC00 <= low <= 0xDFFF:
                raise WitnessError("canonical strings may not contain lone surrogates")
            output.append(chr(0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00)))
            index += 2
            continue
        if 0xDC00 <= code <= 0xDFFF:
            raise WitnessError("canonical strings may not contain lone surrogates")
        output.append(value[index])
        index += 1
    return "".join(output)


def canonical_json(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        if not -(2**53 - 1) <= value <= 2**53 - 1:
            raise WitnessError("canonical integer is outside the safe range")
        return str(value)
    if isinstance(value, float):
        raise WitnessError("canonical floats are not allowed")
    if isinstance(value, str):
        return json.dumps(
            normalize_scalar_string(value),
            ensure_ascii=False,
            separators=(",", ":"),
        )
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(item) for item in value) + "]"
    if isinstance(value, dict):
        keys = list(value)
        if any(not isinstance(key, str) or not key.isascii() for key in keys):
            raise WitnessError("canonical object keys must be ASCII strings")
        return "{" + ",".join(
            f"{canonical_json(key)}:{canonical_json(value[key])}"
            for key in sorted(keys)
        ) + "}"
    raise WitnessError(f"unsupported canonical value: {type(value).__name__}")


StreamEvent = bytes | WitnessError | None


class StreamReader:
    def __init__(
        self,
        stream: Any,
        line_limit: int,
        output_limit: int,
        queue_chunks: int,
    ) -> None:
        self._stream = stream
        self._line_limit = line_limit
        self._output_limit = output_limit
        self._chunks: queue.Queue[StreamEvent] = queue.Queue(maxsize=queue_chunks)
        self._buffer = bytearray()
        self._messages: list[tuple[dict[str, Any], bytes]] = []
        self._eof = False
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._pump, daemon=True)
        self._thread.start()

    def _put(self, event: StreamEvent) -> bool:
        while not self._stop.is_set():
            try:
                self._chunks.put(event, timeout=0.05)
                return True
            except queue.Full:
                continue
        return False

    def _pump(self) -> None:
        total = 0
        try:
            while not self._stop.is_set():
                chunk = os.read(self._stream.fileno(), 4096)
                if not chunk:
                    break
                total += len(chunk)
                if total > self._output_limit:
                    self._put(WitnessError("OUTPUT_CAP"))
                    return
                if not self._put(chunk):
                    return
        except OSError as exc:
            if not self._stop.is_set():
                self._put(WitnessError(f"stdout read failed: {exc}"))
        finally:
            self._put(None)

    def _consume(self, event: StreamEvent) -> None:
        if isinstance(event, WitnessError):
            raise event
        if event is None:
            self._eof = True
            if self._buffer:
                raise WitnessError("TRAILING_FRAME")
            return
        self._buffer.extend(event)
        if len(self._buffer) > self._line_limit and b"\n" not in self._buffer:
            raise WitnessError("OVERSIZED_LINE")
        while True:
            newline = self._buffer.find(b"\n")
            if newline < 0:
                return
            raw = bytes(self._buffer[:newline])
            del self._buffer[: newline + 1]
            if len(raw) > self._line_limit:
                raise WitnessError("OVERSIZED_LINE")
            if not raw or raw.endswith(b"\r"):
                raise WitnessError("INVALID_JSON")
            try:
                text = raw.decode("utf-8", errors="strict")
            except UnicodeDecodeError as exc:
                raise WitnessError("INVALID_UTF8") from exc
            value = strict_json_loads(text)
            if not isinstance(value, dict):
                raise WitnessError("INVALID_RESPONSE")
            self._messages.append((value, raw))

    def _take(self, deadline: float) -> StreamEvent:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise WitnessError("REQUEST_TIMEOUT")
        try:
            return self._chunks.get(timeout=remaining)
        except queue.Empty as exc:
            raise WitnessError("REQUEST_TIMEOUT") from exc

    def next(self, deadline: float) -> tuple[dict[str, Any], bytes]:
        while not self._messages:
            if self._eof:
                raise WitnessError("CHILD_EXIT")
            self._consume(self._take(deadline))
        return self._messages.pop(0)

    def finish(self, deadline: float) -> None:
        while not self._eof:
            self._consume(self._take(deadline))
        if self._messages:
            raise WitnessError("UNEXPECTED_STDOUT")
        self.join(max(0.0, deadline - time.monotonic()))

    def stop(self) -> None:
        self._stop.set()

    def join(self, timeout: float) -> None:
        self._thread.join(timeout)
        if self._thread.is_alive():
            raise WitnessError("stdout reader did not terminate")


class StderrCollector:
    def __init__(self, stream: Any, byte_limit: int) -> None:
        self.data = bytearray()
        self.truncated = False
        self._stream = stream
        self._byte_limit = byte_limit
        self._thread = threading.Thread(target=self._pump, daemon=True)
        self._thread.start()

    def _pump(self) -> None:
        while True:
            chunk = os.read(self._stream.fileno(), 4096)
            if not chunk:
                return
            remaining = self._byte_limit - len(self.data)
            if remaining > 0:
                self.data.extend(chunk[:remaining])
            if len(chunk) > remaining:
                self.truncated = True

    def join(self, timeout: float) -> None:
        self._thread.join(timeout)
        if self._thread.is_alive():
            raise WitnessError("stderr reader did not terminate")


def validate_response(
    value: dict[str, Any],
    expected_ids: set[int],
    settled_ids: set[int],
) -> int:
    if value.get("jsonrpc") != "2.0" or "id" not in value:
        raise WitnessError("INVALID_RESPONSE")
    response_id = value["id"]
    if isinstance(response_id, bool) or not isinstance(response_id, int):
        raise WitnessError("INVALID_RESPONSE")
    if response_id in settled_ids:
        raise WitnessError("DUPLICATE_SETTLED_ID")
    if response_id not in expected_ids:
        raise WitnessError("WRONG_RESPONSE_ID")
    if ("result" in value) == ("error" in value):
        raise WitnessError("INVALID_RESPONSE")
    expected_keys = (
        {"jsonrpc", "id", "result"}
        if "result" in value
        else {"jsonrpc", "id", "error"}
    )
    if set(value) != expected_keys:
        raise WitnessError("INVALID_RESPONSE")
    if "error" in value and not isinstance(value["error"], dict):
        raise WitnessError("INVALID_RESPONSE")
    settled_ids.add(response_id)
    return response_id


def write_all(fd: int, payload: bytes) -> None:
    view = memoryview(payload)
    while view:
        try:
            written = os.write(fd, view)
        except BrokenPipeError as exc:
            raise WitnessError("CHILD_EXIT") from exc
        if written <= 0:
            raise WitnessError("stdout write made no progress")
        view = view[written:]


def write_payload(stream: Any, payload: bytes, fragmented: bool) -> None:
    fd = stream.fileno()
    if fragmented:
        for byte in payload:
            write_all(fd, bytes((byte,)))
    else:
        write_all(fd, payload)


def process_group_alive(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def wait_group_gone(
    pgid: int,
    process: subprocess.Popen[bytes],
    deadline: float,
) -> bool:
    while time.monotonic() < deadline:
        process.poll()
        if not process_group_alive(pgid):
            return True
        time.sleep(0.02)
    process.poll()
    return not process_group_alive(pgid)


def terminate_tree(process: subprocess.Popen[bytes], timeout: float) -> None:
    if os.name == "nt":
        if process.poll() is None:
            try:
                subprocess.run(
                    ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                    check=False,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=timeout,
                )
            except subprocess.TimeoutExpired as exc:
                raise WitnessError("Windows taskkill exceeded its deadline") from exc
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            raise WitnessError("Windows child survived bounded teardown") from exc
        return

    pgid = process.pid
    if not process_group_alive(pgid):
        if process.poll() is None:
            try:
                process.wait(timeout=timeout)
            except subprocess.TimeoutExpired as exc:
                raise WitnessError("child survived bounded teardown") from exc
        return
    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.monotonic() + timeout
    if not wait_group_gone(pgid, process, deadline):
        try:
            os.killpg(pgid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        if not wait_group_gone(
            pgid,
            process,
            time.monotonic() + timeout,
        ):
            raise WitnessError("process group survived bounded teardown")
    if process.poll() is None:
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            raise WitnessError("child survived bounded teardown") from exc


def cleanup_process_and_readers(
    process: subprocess.Popen[bytes],
    stdout: StreamReader,
    stderr: StderrCollector,
    timeout: float,
) -> None:
    failures: list[WitnessError] = []
    try:
        terminate_tree(process, timeout)
    except WitnessError as exc:
        failures.append(exc)
    stdout.stop()
    for action in (
        lambda: stdout.join(timeout),
        lambda: stderr.join(timeout),
    ):
        try:
            action()
        except WitnessError as exc:
            failures.append(exc)
    if failures:
        raise failures[0]


def minimal_child_environment(temp_path: Path) -> dict[str, str]:
    allowed = (
        "PATH",
        "PATHEXT",
        "SystemRoot",
        "WINDIR",
        "ComSpec",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "TMPDIR",
        "TMP",
        "TEMP",
    )
    env = {key: os.environ[key] for key in allowed if key in os.environ}
    env.update(
        {
            "HOME": str(temp_path),
            "USERPROFILE": str(temp_path),
            "XDG_CONFIG_HOME": str(temp_path / "config"),
            "XDG_DATA_HOME": str(temp_path / "share"),
            "XDG_CACHE_HOME": str(temp_path / "cache"),
            "APPDATA": str(temp_path / "appdata"),
            "LOCALAPPDATA": str(temp_path / "localappdata"),
            "MESHFLEET_DB_FILE": str(temp_path / "meshfleet.db"),
            "MESHFLEET_DATA_FILE": str(temp_path / "meshfleet.json"),
            "MESHFLEET_DATA_DIR": str(temp_path / "data"),
            "MESHFLEET_EVENT_LOG_FILE": str(temp_path / "events.jsonl"),
            "NO_COLOR": "1",
        }
    )
    return env


def resolve_server_command(
    contract: dict[str, Any],
    entrypoint: Path,
) -> list[str]:
    if contract.get("server_command") != ["node", "dist/index.js"]:
        raise WitnessError("server command drift from pinned dist/index.js")
    node = shutil.which("node")
    if node is None:
        raise WitnessError("node runtime is unavailable")
    return [str(Path(node).resolve()), str(entrypoint.resolve())]


def tool_json_result(response: dict[str, Any], operation: str) -> Any:
    result = response.get("result")
    if not isinstance(result, dict) or result.get("isError") is True:
        raise WitnessError(f"{operation} returned an MCP tool error")
    content = result.get("content")
    if not isinstance(content, list):
        raise WitnessError(f"{operation} omitted content")
    texts = [
        item.get("text")
        for item in content
        if isinstance(item, dict) and item.get("type") == "text"
    ]
    if len(texts) != 1 or not isinstance(texts[0], str):
        raise WitnessError(f"{operation} did not return exactly one text item")
    return strict_json_loads(texts[0], f"{operation} text was not strict JSON")


def launch_profile(
    profile: dict[str, Any],
    fixture: dict[str, Any],
    contract: dict[str, Any],
) -> dict[str, Any]:
    limits = contract["limits"]
    request_ids = contract["request_ids"]
    expected_ids = {
        request_ids["initialize"],
        request_ids["ping"],
        request_ids["tools/list"],
        request_ids["tools/call:get_health"],
        request_ids["tools/call:unknown"],
    }
    settled_ids: set[int] = set()
    observed_raw: list[bytes] = []
    responses: dict[int, dict[str, Any]] = {}

    with tempfile.TemporaryDirectory(prefix="meshfleet-python-wire-") as temp:
        temp_path = Path(temp)
        env = minimal_child_environment(temp_path)
        creationflags = (
            subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
        )
        process = subprocess.Popen(
            contract["server_command"],
            cwd=REPO,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
            start_new_session=os.name != "nt",
            creationflags=creationflags,
        )
        assert process.stdin is not None
        assert process.stdout is not None
        assert process.stderr is not None
        stdout = StreamReader(
            process.stdout,
            limits["line_bytes"],
            limits["stdout_bytes"],
            limits["stdout_queue_chunks"],
        )
        stderr = StderrCollector(process.stderr, limits["stderr_bytes"])

        initialize = {
            "jsonrpc": "2.0",
            "id": request_ids["initialize"],
            "method": "initialize",
            "params": {
                "protocolVersion": fixture["protocol_version"],
                "capabilities": {},
                "clientInfo": {
                    "name": profile["name"],
                    "version": "0.1",
                },
            },
        }
        initialize_wire = compact_json(initialize) + b"\n"
        post_messages = [
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {
                "jsonrpc": "2.0",
                "id": request_ids["ping"],
                "method": "ping",
            },
            {
                "jsonrpc": "2.0",
                "id": request_ids["tools/list"],
                "method": "tools/list",
                "params": {},
            },
            {
                "jsonrpc": "2.0",
                "id": request_ids["tools/call:get_health"],
                "method": "tools/call",
                "params": {"name": "get_health", "arguments": {}},
            },
            {
                "jsonrpc": "2.0",
                "id": request_ids["tools/call:unknown"],
                "method": "tools/call",
                "params": {
                    "name": "__meshfleet_catalog_boundary_unknown_tool__",
                    "arguments": {},
                },
            },
        ]
        post_wire = b"".join(compact_json(message) + b"\n" for message in post_messages)

        deadline = time.monotonic() + limits["request_timeout_seconds"]
        try:
            write_payload(
                process.stdin,
                initialize_wire,
                profile["initialize_write"] == "fragmented",
            )
            value, raw = stdout.next(deadline)
            response_id = validate_response(value, expected_ids, settled_ids)
            if response_id != request_ids["initialize"]:
                raise WitnessError("initialize response arrived with the wrong id")
            responses[response_id] = value
            observed_raw.append(raw)

            write_payload(
                process.stdin,
                post_wire,
                profile["post_initialize_write"] == "fragmented",
            )
            while len(settled_ids) < len(expected_ids):
                value, raw = stdout.next(deadline)
                response_id = validate_response(value, expected_ids, settled_ids)
                responses[response_id] = value
                observed_raw.append(raw)

            process.stdin.close()
            exit_deadline = time.monotonic() + limits["exit_timeout_seconds"]
            stdout.finish(exit_deadline)
            remaining = max(0.0, exit_deadline - time.monotonic())
            try:
                exit_code = process.wait(timeout=remaining)
            except subprocess.TimeoutExpired as exc:
                raise WitnessError("server did not exit after stdin closed") from exc
            if exit_code != 0:
                raise WitnessError(f"server exited with status {exit_code}")
        finally:
            if not process.stdin.closed:
                process.stdin.close()
            cleanup_process_and_readers(
                process,
                stdout,
                stderr,
                limits["exit_timeout_seconds"],
            )

        if stderr.truncated:
            raise WitnessError("stderr exceeded the configured byte limit")

    initialize_result = responses[request_ids["initialize"]].get("result")
    if not isinstance(initialize_result, dict):
        raise WitnessError("initialize result is not an object")
    if initialize_result.get("protocolVersion") != fixture["protocol_version"]:
        raise WitnessError("initialize protocol version drift")
    capabilities = initialize_result.get("capabilities")
    server_info = initialize_result.get("serverInfo")
    if not isinstance(capabilities, dict) or not isinstance(server_info, dict):
        raise WitnessError("initialize capabilities or serverInfo drift")
    if not all(
        isinstance(server_info.get(key), str) and server_info[key]
        for key in ("name", "version")
    ):
        raise WitnessError("initialize serverInfo is malformed")

    ping_result = responses[request_ids["ping"]].get("result")
    if ping_result != {}:
        raise WitnessError("ping result must be an empty object")

    tools_result = responses[request_ids["tools/list"]].get("result")
    if not isinstance(tools_result, dict) or not isinstance(tools_result.get("tools"), list):
        raise WitnessError("tools/list result is malformed")
    tools = tools_result["tools"]
    names = [tool.get("name") for tool in tools if isinstance(tool, dict)]
    if (
        len(names) != len(tools)
        or any(
            not isinstance(name, str) or not name or not name.isascii()
            for name in names
        )
    ):
        raise WitnessError("tool names are malformed")
    if len(set(names)) != len(names):
        raise WitnessError("tool names are not unique")
    sorted_tools = sorted(tools, key=lambda tool: tool["name"])
    catalog_sha256 = sha256_bytes(
        canonical_json({"tools": sorted_tools}).encode("utf-8")
    )
    if catalog_sha256 != contract["catalog_sha256"]:
        raise WitnessError(
            f"catalog digest drift: {catalog_sha256} != {contract['catalog_sha256']}"
        )

    health = tool_json_result(
        responses[request_ids["tools/call:get_health"]],
        "get_health",
    )
    expected_health = {
        "status": "ok",
        "fleets": 0,
        "agents": 0,
        "messages": 0,
        "capabilities": 0,
        "events": 0,
    }
    if not isinstance(health, dict) or any(
        health.get(key) != value for key, value in expected_health.items()
    ):
        raise WitnessError("get_health stable fields drift")

    unknown = responses[request_ids["tools/call:unknown"]]
    if set(unknown) != {"jsonrpc", "id", "error"}:
        raise WitnessError("unknown-tool response envelope drift")
    unknown_error = unknown.get("error")
    if not isinstance(unknown_error, dict) or set(unknown_error) != {"code", "message"}:
        raise WitnessError("unknown-tool error envelope drift")
    if unknown_error.get("code") != contract["unknown_tool_exception_code"]:
        raise WitnessError("unknown-tool rejection code drift")
    if unknown_error.get("message") != fixture["unknown_tool_expected_message"]:
        raise WitnessError("unknown-tool rejection message drift")

    normalized_observed = {
        "initialize": {
            "protocol_version": initialize_result["protocolVersion"],
            "capabilities": capabilities,
            "server_info": server_info,
        },
        "ping": ping_result,
        "catalog_sha256": catalog_sha256,
        "health": {key: health[key] for key in expected_health},
        "unknown_tool_error": unknown_error,
        "response_ids": sorted(settled_ids),
    }
    return {
        "name": profile["name"],
        "initialize_write": profile["initialize_write"],
        "post_initialize_write": profile["post_initialize_write"],
        "observed_response_lines": len(observed_raw),
        "observed_response_bytes": sum(len(raw) + 1 for raw in observed_raw),
        "observed_response_sha256": sha256_bytes(b"\n".join(observed_raw) + b"\n"),
        "normalized_transcript_sha256": sha256_bytes(
            canonical_json(normalized_observed).encode("utf-8")
        ),
        "stderr_sha256": sha256_bytes(bytes(stderr.data)),
    }


def expect_fault(checks: list[str], name: str, expected: str, action: Callable[[], Any]) -> None:
    try:
        action()
    except WitnessError as exc:
        if str(exc) != expected:
            raise WitnessError(
                f"self-test {name} expected {expected}, observed {exc}"
            ) from exc
        checks.append(name)
        return
    raise WitnessError(f"self-test {name} did not fail closed")


def reader_for(data: bytes, line_limit: int = 1024, output_limit: int = 4096) -> StreamReader:
    read_fd, write_fd = os.pipe()
    stream = os.fdopen(read_fd, "rb", buffering=0)
    reader = StreamReader(stream, line_limit, output_limit, 4)
    write_all(write_fd, data)
    os.close(write_fd)
    return reader


def run_self_tests() -> int:
    checks: list[str] = []
    expect_fault(
        checks,
        "strict-json-nan",
        "INVALID_JSON",
        lambda: strict_json_loads('{"value":NaN}'),
    )
    expect_fault(
        checks,
        "strict-json-infinity",
        "INVALID_JSON",
        lambda: strict_json_loads('{"value":Infinity}'),
    )
    expect_fault(
        checks,
        "strict-json-duplicate-member",
        "INVALID_JSON",
        lambda: strict_json_loads('{"id":1,"id":2}'),
    )
    expect_fault(
        checks,
        "server-command-drift",
        "server command drift from pinned dist/index.js",
        lambda: resolve_server_command(
            {"server_command": ["node", "not-dist.js"]},
            REPO / "dist" / "index.js",
        ),
    )
    if canonical_json("\ud83d\ude80") != canonical_json("🚀"):
        raise WitnessError("self-test surrogate-pair equivalence drift")
    checks.append("surrogate-pair-equivalence")
    expect_fault(
        checks,
        "lone-surrogate",
        "canonical strings may not contain lone surrogates",
        lambda: canonical_json("\ud83d"),
    )

    valid = compact_json({"jsonrpc": "2.0", "id": 1, "result": {"probe": "🚀"}}) + b"\n"
    reader = reader_for(valid)
    try:
        value, _ = reader.next(time.monotonic() + 1)
        if value["result"]["probe"] != "🚀":
            raise WitnessError("self-test fragmented UTF-8 value drift")
        reader.finish(time.monotonic() + 1)
        checks.append("strict-valid-frame")
    finally:
        reader.stop()
        reader.join(1)

    extra = valid + compact_json({"jsonrpc": "2.0", "id": 2, "result": {}}) + b"\n"
    reader = reader_for(extra)
    try:
        reader.next(time.monotonic() + 1)
        expect_fault(
            checks,
            "post-settlement-extra-output",
            "UNEXPECTED_STDOUT",
            lambda: reader.finish(time.monotonic() + 1),
        )
    finally:
        reader.stop()
        reader.join(1)

    for name, data, expected, line_limit, output_limit in (
        ("malformed-utf8", b"\xff\n", "INVALID_UTF8", 1024, 4096),
        ("trailing-frame", b'{"jsonrpc":"2.0"', "TRAILING_FRAME", 1024, 4096),
        ("oversized-line", b"x" * 65 + b"\n", "OVERSIZED_LINE", 64, 4096),
        ("output-cap", b"x" * 129, "OUTPUT_CAP", 1024, 128),
    ):
        reader = reader_for(data, line_limit, output_limit)
        try:
            expect_fault(
                checks,
                name,
                expected,
                lambda reader=reader: reader.finish(time.monotonic() + 1),
            )
        finally:
            reader.stop()
            reader.join(1)

    expected_ids = {1}
    settled: set[int] = set()
    expect_fault(
        checks,
        "wrong-response-id",
        "WRONG_RESPONSE_ID",
        lambda: validate_response(
            {"jsonrpc": "2.0", "id": 2, "result": {}},
            expected_ids,
            settled,
        ),
    )
    validate_response(
        {"jsonrpc": "2.0", "id": 1, "result": {}},
        expected_ids,
        settled,
    )
    expect_fault(
        checks,
        "duplicate-response-id",
        "DUPLICATE_SETTLED_ID",
        lambda: validate_response(
            {"jsonrpc": "2.0", "id": 1, "result": {}},
            expected_ids,
            settled,
        ),
    )
    if os.name != "nt":
        process = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(60)"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        terminate_tree(process, 1.0)
        if process.poll() is None or process_group_alive(process.pid):
            raise WitnessError("self-test POSIX process group survived teardown")
        checks.append("posix-zombie-aware-group-teardown")
    print(
        canonical_json(
            {
                "schema_version": "0.1",
                "witness": "meshfleet-python-raw-stdio-self-test",
                "checks": checks,
                "count": len(checks),
                "result": "PASS",
            }
        )
    )
    return 0


def main() -> int:
    if sys.argv[1:] == ["--self-test"]:
        return run_self_tests()
    if sys.argv[1:]:
        raise WitnessError("usage: runner.py [--self-test]")
    if os.name == "nt":
        raise WitnessError(
            "Windows live witness is held pending Job Object tree supervision"
        )

    contract_raw = CONTRACT_PATH.read_bytes()
    contract = strict_json_loads(contract_raw.decode("utf-8"), "invalid contract JSON")
    fixture_path = (HERE / contract["shared_fixture"]).resolve()
    fixture_raw = fixture_path.read_bytes()
    fixture_sha256 = sha256_bytes(fixture_raw)
    if fixture_sha256 != contract["shared_fixture_sha256"]:
        raise WitnessError("shared transcript fixture hash drift")
    fixture = strict_json_loads(fixture_raw.decode("utf-8"), "invalid fixture JSON")
    if fixture.get("operations") != EXPECTED_OPERATIONS:
        raise WitnessError("shared transcript operation order drift")

    entrypoint = REPO / "dist" / "index.js"
    if not entrypoint.is_file():
        raise WitnessError("dist/index.js is missing; run npm run build")
    entrypoint_sha256 = sha256_bytes(entrypoint.read_bytes())
    if entrypoint_sha256 != contract["server_entrypoint_sha256"]:
        raise WitnessError("dist/index.js digest drift; rebuild or review the contract pin")
    runtime_contract = dict(contract)
    runtime_contract["server_command"] = resolve_server_command(contract, entrypoint)

    profiles = [
        launch_profile(profile, fixture, runtime_contract)
        for profile in fixture["profiles"]
    ]
    transcript_digests = {
        profile["normalized_transcript_sha256"] for profile in profiles
    }
    if len(transcript_digests) != 1:
        raise WitnessError("cross-profile normalized transcript drift")
    if not any("🚀" in profile["name"] for profile in profiles):
        raise WitnessError("non-BMP fragmentation profile is missing")

    receipt = {
        "schema_version": "0.1",
        "witness": "meshfleet-python-raw-stdio-parity",
        "python": sys.version.split()[0],
        "platform": sys.platform,
        "contract_sha256": sha256_bytes(contract_raw),
        "server_entrypoint_sha256": entrypoint_sha256,
        "shared_fixture_sha256": fixture_sha256,
        "catalog_sha256": contract["catalog_sha256"],
        "normalized_transcript_sha256": next(iter(transcript_digests)),
        "profiles": profiles,
        "checks": {
            "actual_server_process": True,
            "dependency_free_python_client": True,
            "shared_language_neutral_fixture": True,
            "byte_fragmented_non_bmp_utf8": True,
            "coalesced_multi_message_write": True,
            "minimal_child_environment": True,
            "redirected_named_meshfleet_state": True,
            "runtime_command_bound_to_pinned_entrypoint": True,
            "complete_stdout_validation": True,
            "bounded_failure_teardown": True,
        },
        "result": "PASS",
    }
    print(canonical_json(receipt))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except WitnessError as exc:
        print(f"python raw-stdio parity witness: FAIL: {exc}", file=sys.stderr)
        raise SystemExit(1)
