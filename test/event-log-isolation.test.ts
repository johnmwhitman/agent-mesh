/**
 * A SPAWNED CHILD must be able to have its event log redirected.
 *
 * `setEventLogPath` is an in-process override, and a child process inherits
 * environment — not module state. So until 0.16.0 there was no way to redirect
 * a spawned server's or CLI's event log at all, and every test that spawned one
 * appended to the real `~/.config/opencode/agent-mesh.events.log`.
 *
 * On POSIX this was partly masked by tests overriding `HOME`. On Windows it was
 * not masked at all: `os.homedir()` reads `USERPROFILE` there, so the redirect
 * silently did nothing and children wrote into the developer's — or the CI
 * runner's — actual profile. A byte-compat guard asserting "No events recorded."
 * passed for months only because that shared file happened to be empty, and went
 * red the moment another test in the same run wrote an event first.
 *
 * This is the writer half of that defect. The test asserts the property the fix
 * exists for — a child writes where it was TOLD to and nowhere else — rather
 * than asserting that the code contains a particular line.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { DEFAULT_EVENT_LOG, resolveEventLogFile, setEventLogPath } from "../src/core.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

test("a spawned child writes its events to MESHFLEET_EVENT_LOG_FILE, not the user profile", () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-evlog-"));
  const eventLog = join(dir, "events.log");
  try {
    // A child that appends one event, told where to put it ONLY via environment
    // — exactly the channel a spawned process actually has.
    //
    // Written to a FILE rather than passed with `-e`, and imported as a file://
    // URL rather than a bare path. Both are Windows requirements: an inline
    // script has to survive Windows command-line quoting (the first version of
    // this test died there with an empty stderr), and Node refuses to dynamic-
    // import an absolute Windows path like `C:\...` because it reads as a URL
    // scheme.
    const childScript = join(dir, "probe.mjs");
    writeFileSync(
      childScript,
      `import { appendEvent } from ${JSON.stringify(pathToFileURL(join(repoRoot, "src", "core.ts")).href)};\n` +
        `appendEvent("isolation_probe", { marker: "child-wrote-here" });\n`
    );

    const child = spawnSync(process.execPath, ["--import", "tsx", childScript], {
      env: {
        ...process.env,
        MESHFLEET_EVENT_LOG_FILE: eventLog,
        MESHFLEET_DB_FILE: join(dir, "l.db"),
        MESHFLEET_DATA_FILE: join(dir, "l.json"),
      },
      encoding: "utf8",
    });

    assert.equal(
      child.status,
      0,
      `child failed (status=${child.status}, signal=${child.signal})\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`
    );
    assert.ok(existsSync(eventLog), "the child must have created the redirected event log");
    assert.match(
      readFileSync(eventLog, "utf8"),
      /child-wrote-here/,
      "the event must be in the file the environment named"
    );
    assert.notEqual(
      eventLog,
      DEFAULT_EVENT_LOG,
      "sanity: the redirect target must not BE the default, or this proves nothing"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an explicit setEventLogPath override still beats the environment", () => {
  const prev = process.env.MESHFLEET_EVENT_LOG_FILE;
  try {
    process.env.MESHFLEET_EVENT_LOG_FILE = "/tmp/from-env.log";
    setEventLogPath("/tmp/from-call.log");
    assert.equal(
      resolveEventLogFile(),
      "/tmp/from-call.log",
      "in-process callers are more specific than ambient environment and must win"
    );
  } finally {
    setEventLogPath(DEFAULT_EVENT_LOG);
    if (prev === undefined) delete process.env.MESHFLEET_EVENT_LOG_FILE;
    else process.env.MESHFLEET_EVENT_LOG_FILE = prev;
  }
});

test("with no override at all, the default is still the home config dir", () => {
  const prev = process.env.MESHFLEET_EVENT_LOG_FILE;
  try {
    delete process.env.MESHFLEET_EVENT_LOG_FILE;
    setEventLogPath(DEFAULT_EVENT_LOG);
    assert.equal(
      resolveEventLogFile(),
      DEFAULT_EVENT_LOG,
      "adding an env layer must not move the default for ordinary users"
    );
  } finally {
    if (prev === undefined) delete process.env.MESHFLEET_EVENT_LOG_FILE;
    else process.env.MESHFLEET_EVENT_LOG_FILE = prev;
  }
});
