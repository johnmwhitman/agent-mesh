import { posix, win32 } from "node:path";

// npm 12's pack command keys JSON output by package name; earlier npm emits an array.
export function npmPackFilename(stdout: string, expectedName: string): string {
  const parsed: unknown = JSON.parse(stdout);
  if (!expectedName) throw new Error("Expected package name is required");
  let record: unknown;
  if (Array.isArray(parsed)) {
    if (parsed.length !== 1) throw new Error("Expected one packed package");
    record = parsed[0];
  } else if (parsed !== null && typeof parsed === "object") {
    const entries = Object.entries(parsed);
    if (entries.length !== 1 || entries[0][0] !== expectedName) {
      throw new Error("Expected one named packed package");
    }
    record = entries[0][1];
  } else {
    throw new Error("Invalid npm pack result");
  }
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("Invalid packed package metadata");
  }
  const { name, filename } = record as Record<string, unknown>;
  if (name !== expectedName || typeof filename !== "string" || !filename.endsWith(".tgz")
      || filename.length <= 4 || /[\x00-\x1f\x7f:]/.test(filename)
      || posix.basename(filename) !== filename || win32.basename(filename) !== filename) {
    throw new Error("Invalid packed package name or filename");
  }
  return filename;
}
