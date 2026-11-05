import assert from "node:assert/strict";
import { test } from "node:test";
import { npmPackFilename } from "./helpers/npm-pack-json.js";

const packageName = "meshfleet";
const filename = "meshfleet-0.22.0.tgz";

test("accepts the legacy npm pack JSON array", () => {
  assert.equal(
    npmPackFilename(JSON.stringify([{ name: packageName, filename }]), packageName),
    filename,
  );
});

test("accepts npm 12 package-name keyed metadata from the installed npm CLI", () => {
  const actualNpm12Shape = {
    [packageName]: { name: packageName, filename },
  };
  assert.equal(npmPackFilename(JSON.stringify(actualNpm12Shape), packageName), filename);
});

test("rejects malformed JSON and unknown root shapes", () => {
  for (const input of ["{", "null", "[]", "{}", JSON.stringify("metadata")]) {
    assert.throws(() => npmPackFilename(input, packageName));
  }
});

test("rejects multiple legacy records and extra npm 12 metadata keys", () => {
  assert.throws(() => npmPackFilename(JSON.stringify([
    { name: packageName, filename },
    { name: packageName, filename },
  ]), packageName));
  assert.throws(() => npmPackFilename(JSON.stringify({
    [packageName]: { name: packageName, filename },
    extra: { name: "extra", filename: "extra-1.0.0.tgz" },
  }), packageName));
});

test("rejects wrong record names and missing or invalid filenames", () => {
  for (const record of [
    { name: "other", filename },
    { name: packageName },
    { name: packageName, filename: "" },
    { name: packageName, filename: "meshfleet-0.22.0.zip" },
  ]) {
    assert.throws(() => npmPackFilename(JSON.stringify({ [packageName]: record }), packageName));
  }
});

test("rejects absolute and traversal filenames on POSIX and Windows", () => {
  for (const unsafeFilename of [
    "/tmp/meshfleet-0.22.0.tgz",
    "../meshfleet-0.22.0.tgz",
    "..\\meshfleet-0.22.0.tgz",
    "C:\\temp\\meshfleet-0.22.0.tgz",
  ]) {
    assert.throws(() => npmPackFilename(JSON.stringify({
      [packageName]: { name: packageName, filename: unsafeFilename },
    }), packageName));
  }
});
