import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";

import { HOSTS, findHost, initMain, renderHost } from "../src/init.js";

// `init` prints; it must never write. The tests pin the print-only property as
// a property of the module, not of one call: the source is read back and any
// filesystem-write import is a failure. A future session adding `--write` has
// to delete this test on purpose.

test("init writes nothing to disk", () => {
  const before = snapshot();
  let out = "";
  for (const host of HOSTS) initMain([host.id], (s) => { out += s; });
  initMain([], (s) => { out += s; });
  assert.deepEqual(snapshot(), before, "init changed the working directory");
  assert.ok(out.length > 0);
});

test("the init module imports no write capability", async () => {
  const src = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/init.ts", import.meta.url), "utf8"),
  );
  for (const forbidden of ["writeFile", "writeFileSync", "appendFile", "mkdir", "rename", "createWriteStream"]) {
    assert.ok(!src.includes(forbidden), `init.ts references ${forbidden} — it is print-only`);
  }
});

test("every host block names its file and the verify step", () => {
  for (const host of HOSTS) {
    const rendered = renderHost(host);
    assert.ok(rendered.includes(host.path), `${host.id} does not say where the block goes`);
    assert.ok(rendered.includes("meshfleet doctor"), `${host.id} does not hand off to doctor`);
    // The command the block launches must be the real one, argument-free.
    assert.ok(
      rendered.includes("meshfleet"),
      `${host.id} block does not launch meshfleet`,
    );
  }
});

test("an unknown host is a non-zero exit, not a silent success", () => {
  let out = "";
  const code = initMain(["emacs"], (s) => { out += s; });
  assert.equal(code, 2);
  assert.match(out, /unknown host/);
});

test("no argument lists the hosts and the zero-config escape", () => {
  let out = "";
  const code = initMain([], (s) => { out += s; });
  assert.equal(code, 0);
  for (const host of HOSTS) assert.ok(out.includes(host.id), `${host.id} unlisted`);
  assert.ok(out.includes("meshfleet demo"), "no pointer to the zero-config path");
});

test("claude is a known host", () => {
  assert.ok(findHost("claude"));
  assert.equal(findHost("nope"), undefined);
});

function snapshot(): string[] {
  return readdirSync(process.cwd())
    .filter((f) => !f.startsWith("."))
    .map((f) => {
      try {
        return `${f}:${statSync(f).mtimeMs}`;
      } catch {
        return `${f}:gone`;
      }
    });
}
