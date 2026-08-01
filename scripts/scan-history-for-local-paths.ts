// Reachable-history scanner for operator-local path disclosures.
//
// WHY THIS EXISTS, AND WHY IT IS NOT A TEST.
//
// `test/public-surface-sanitization.test.ts` is the repo's public-surface guard. It scans with
// `git grep --cached` and `git ls-files`, which read STAGE 0 OF THE INDEX ONLY. Its own
// `staged`/`committed` control proves it catches content that is still TRACKED even when the
// working tree has been sanitized — but a blob that was tracked, leaked, and then DELETED from the
// index is invisible to it, while remaining reachable from every clone of the branch. On a public
// repo that is the whole exposure: the guard reports clean and the history does not agree.
//
// This file is a REPORTER, not a gate, and is deliberately not wired into `npm test`. Wiring it in
// today would leave two options, both bad: a suite that is red on `main` for a leak this script
// cannot fix, or an allowlist that silences a real finding to keep a pipeline green. Remediating
// reachable public history means rewriting and force-pushing it, which is the maintainer's call
// alone. Detector first, honest inventory second, remediation and only then a gate.
//
// NO OFFENDING VALUE IS WRITTEN DOWN HERE. Every pattern is constructed at run time — the
// operator-specific one from `os.homedir()` (or `--home`), the rest from generic shapes assembled
// out of parts. This file is itself a tracked public file and is scanned by the guard above, so it
// must survive its own subject matter.
//
// Usage:
//   npx tsx scripts/scan-history-for-local-paths.ts [--ref <rev>] [--home <path>] [--json]
//
// Exit codes: 0 clean · 1 findings · 2 the scan could not be trusted.
// Send the output OUTSIDE this repository. It quotes the very strings the repository must not hold.

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SLASH = String.fromCharCode(47);
const BACKSLASH = String.fromCharCode(92);
const joinParts = (...parts: string[]): string => parts.join("");

/** Default ceiling per blob. Above this a blob is reported as skipped, never silently dropped. */
export const DEFAULT_MAX_BLOB_BYTES = 4 * 1024 * 1024;

/** How many leading bytes decide "binary". A NUL in this window means the blob is not scanned. */
const BINARY_SNIFF_BYTES = 8000;

export type PatternSpec = {
  id: string;
  description: string;
  source: string;
};

export type Finding = {
  patternId: string;
  oid: string;
  /** Every reachable path this blob has ever been known at, sorted. */
  paths: string[];
  line: number;
  match: string;
  /** The matching line, trimmed and length-capped. */
  excerpt: string;
};

export type ScanCoverage = {
  ref: string;
  commits: number;
  objects: number;
  uniqueBlobs: number;
  blobsScanned: number;
  bytesScanned: number;
  skippedBinary: number;
  skippedOversize: number;
};

export type ScanResult = {
  coverage: ScanCoverage;
  patterns: PatternSpec[];
  findings: Finding[];
};

const USERNAME_SHAPE = "[A-Za-z0-9._-]{2,32}";

/**
 * Patterns are assembled, never spelled. The operator-specific entry is derived from the running
 * machine, so this scanner needs no configuration to be correct for a different maintainer — and
 * carries no maintainer's path in its own bytes.
 */
export function buildPatterns(home: string): PatternSpec[] {
  const patterns: PatternSpec[] = [
    {
      id: "posix-user-home",
      description: "a POSIX per-user home directory path",
      source: joinParts(SLASH, "(?:Users|home)", SLASH, USERNAME_SHAPE, SLASH),
    },
    {
      id: "windows-user-home",
      description: "a Windows per-user profile path",
      source: joinParts(
        "[A-Za-z]:",
        BACKSLASH,
        BACKSLASH,
        "Users",
        BACKSLASH,
        BACKSLASH,
        USERNAME_SHAPE,
        BACKSLASH,
        BACKSLASH,
      ),
    },
    {
      id: "macos-private-temp",
      description: "a macOS private temporary directory path",
      source: joinParts(
        "(?:",
        SLASH,
        "private",
        SLASH,
        "tmp",
        SLASH,
        "|",
        SLASH,
        "var",
        SLASH,
        "folders",
        SLASH,
        ")",
      ),
    },
  ];

  const trimmedHome = home.replace(/[/\\]+$/, "");
  if (trimmedHome.length > 0) {
    patterns.push({
      id: "operator-home",
      description: "this machine's own home directory path",
      source: escapeRegExp(trimmedHome),
    });
  }
  return patterns;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, joinParts(BACKSLASH, "$&"));
}

function git(args: string[], cwd: string, maxBuffer = 256 * 1024 * 1024): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer,
    // A hook or an outer git invocation can export these; inheriting them would silently point the
    // scan at a DIFFERENT repository than `cwd` and produce a confident, empty, wrong report.
    env: gitCleanEnv(),
  });
}

function gitBuffer(args: string[], cwd: string, input: string): Buffer {
  return execFileSync("git", args, {
    cwd,
    input,
    maxBuffer: 512 * 1024 * 1024,
    env: gitCleanEnv(),
  }) as unknown as Buffer;
}

export function gitCleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_CEILING_DIRECTORIES",
  ]) {
    delete env[key];
  }
  return env;
}

type BlobRecord = { oid: string; size: number; paths: Set<string> };

/** Every blob reachable from `ref`, deduplicated by object id, with every path it is known at. */
export function reachableBlobs(root: string, ref: string): { blobs: Map<string, BlobRecord>; objects: number } {
  const listing = git(["rev-list", "--objects", ref], root);
  const named = new Map<string, Set<string>>();
  let objects = 0;
  for (const line of listing.split("\n")) {
    if (line.length === 0) continue;
    objects += 1;
    const separator = line.indexOf(" ");
    if (separator < 0) continue; // a commit: no path, and never a blob
    const oid = line.slice(0, separator);
    const path = line.slice(separator + 1);
    const known = named.get(oid);
    if (known) known.add(path);
    else named.set(oid, new Set([path]));
  }

  const oids = [...named.keys()];
  const blobs = new Map<string, BlobRecord>();
  if (oids.length === 0) return { blobs, objects };

  const facts = execFileSync("git", ["cat-file", "--batch-check"], {
    cwd: root,
    input: joinParts(oids.join("\n"), "\n"),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: gitCleanEnv(),
  });
  for (const line of facts.split("\n")) {
    if (line.length === 0) continue;
    const [oid, type, sizeText] = line.split(" ");
    if (type !== "blob") continue;
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`git reported an unusable size for blob ${oid}: ${sizeText}`);
    }
    blobs.set(oid, { oid, size, paths: new Set(named.get(oid) ?? []) });
  }
  return { blobs, objects };
}

/** Read a set of blobs in as few `git cat-file --batch` calls as the byte budget allows. */
function readBlobs(root: string, records: BlobRecord[], chunkBytes: number): Map<string, Buffer> {
  const contents = new Map<string, Buffer>();
  let pending: BlobRecord[] = [];
  let pendingBytes = 0;

  const flush = (): void => {
    if (pending.length === 0) return;
    const stream = gitBuffer(
      ["cat-file", "--batch"],
      root,
      joinParts(pending.map((record) => record.oid).join("\n"), "\n"),
    );
    let cursor = 0;
    for (const record of pending) {
      const headerEnd = stream.indexOf(0x0a, cursor);
      if (headerEnd < 0) throw new Error(`git cat-file --batch truncated before ${record.oid}`);
      const header = stream.subarray(cursor, headerEnd).toString("utf8");
      const [oid, type, sizeText] = header.split(" ");
      if (oid !== record.oid || type !== "blob") {
        throw new Error(`git cat-file --batch answered ${header} for ${record.oid}`);
      }
      const size = Number(sizeText);
      if (size !== record.size) {
        throw new Error(`git cat-file --batch sized ${record.oid} as ${size}, expected ${record.size}`);
      }
      const start = headerEnd + 1;
      contents.set(oid, stream.subarray(start, start + size));
      cursor = start + size + 1; // the record is followed by a single LF
    }
    pending = [];
    pendingBytes = 0;
  };

  for (const record of records) {
    if (pending.length > 0 && pendingBytes + record.size > chunkBytes) flush();
    pending.push(record);
    pendingBytes += record.size;
  }
  flush();
  return contents;
}

function looksBinary(content: Buffer): boolean {
  return content.subarray(0, BINARY_SNIFF_BYTES).includes(0x00);
}

export type ScanOptions = {
  root: string;
  ref?: string;
  home?: string;
  maxBlobBytes?: number;
  chunkBytes?: number;
};

export function scanHistory(options: ScanOptions): ScanResult {
  const root = options.root;
  const ref = options.ref ?? "HEAD";
  const maxBlobBytes = options.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
  const patterns = buildPatterns(options.home ?? homedir());

  const commits = Number(git(["rev-list", "--count", ref], root).trim());
  if (!Number.isSafeInteger(commits)) {
    throw new Error(`git could not count commits reachable from ${ref}`);
  }

  const { blobs, objects } = reachableBlobs(root, ref);

  // A scanner that enumerates nothing reports "clean" — the exact shape of a false assurance. Refuse.
  if (blobs.size === 0) {
    throw new Error(
      `no reachable blobs were found from ${ref}; the scan would report clean vacuously`,
    );
  }

  const scannable = [...blobs.values()].filter((record) => record.size <= maxBlobBytes);
  const skippedOversize = blobs.size - scannable.length;
  const contents = readBlobs(root, scannable, options.chunkBytes ?? 16 * 1024 * 1024);

  const findings: Finding[] = [];
  let skippedBinary = 0;
  let bytesScanned = 0;
  let blobsScanned = 0;

  for (const record of scannable) {
    const content = contents.get(record.oid);
    if (content === undefined) throw new Error(`blob ${record.oid} was enumerated but never read`);
    if (looksBinary(content)) {
      skippedBinary += 1;
      continue;
    }
    blobsScanned += 1;
    bytesScanned += content.length;
    const paths = [...record.paths].sort();
    const lines = content.toString("utf8").split("\n");
    for (const pattern of patterns) {
      const regex = new RegExp(pattern.source, "g");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        regex.lastIndex = 0;
        let match = regex.exec(line);
        while (match !== null) {
          findings.push({
            patternId: pattern.id,
            oid: record.oid,
            paths,
            line: index + 1,
            match: match[0],
            excerpt: line.trim().slice(0, 200),
          });
          match = regex.exec(line);
        }
      }
    }
  }

  if (blobsScanned === 0) {
    throw new Error(
      `every reachable blob from ${ref} was skipped as binary or oversize; the scan would report clean vacuously`,
    );
  }

  findings.sort(
    (left, right) =>
      left.patternId.localeCompare(right.patternId) ||
      (left.paths[0] ?? "").localeCompare(right.paths[0] ?? "") ||
      left.oid.localeCompare(right.oid) ||
      left.line - right.line,
  );

  return {
    coverage: {
      ref,
      commits,
      objects,
      uniqueBlobs: blobs.size,
      blobsScanned,
      bytesScanned,
      skippedBinary,
      skippedOversize,
    },
    patterns,
    findings,
  };
}

/** The commits whose diff adds or removes a blob — i.e. where an occurrence entered history. */
export function commitsCarrying(root: string, ref: string, oid: string): string[] {
  const output = git(
    ["log", "--format=%h %ad %s", "--date=short", `--find-object=${oid}`, ref],
    root,
  );
  return output.split("\n").filter((line) => line.length > 0);
}

function formatReport(root: string, result: ScanResult): string {
  const lines: string[] = [];
  const { coverage } = result;
  lines.push(`reachable-history scan of ${coverage.ref}`);
  lines.push(
    `  ${coverage.commits} commits · ${coverage.objects} objects · ${coverage.uniqueBlobs} unique blobs`,
  );
  lines.push(
    `  ${coverage.blobsScanned} blobs scanned (${coverage.bytesScanned} bytes) · ` +
      `${coverage.skippedBinary} skipped binary · ${coverage.skippedOversize} skipped oversize`,
  );
  lines.push(`  patterns: ${result.patterns.map((pattern) => pattern.id).join(", ")}`);
  lines.push("");

  if (result.findings.length === 0) {
    lines.push("no occurrences found");
    return joinParts(lines.join("\n"), "\n");
  }

  const byPattern = new Map<string, Finding[]>();
  for (const finding of result.findings) {
    const bucket = byPattern.get(finding.patternId);
    if (bucket) bucket.push(finding);
    else byPattern.set(finding.patternId, [finding]);
  }

  for (const [patternId, bucket] of byPattern) {
    const blobs = new Set(bucket.map((finding) => finding.oid));
    lines.push(`## ${patternId} — ${bucket.length} occurrences in ${blobs.size} blobs`);
    for (const oid of [...blobs].sort()) {
      const occurrences = bucket.filter((finding) => finding.oid === oid);
      lines.push(`  blob ${oid}`);
      lines.push(`    paths: ${occurrences[0].paths.join(", ")}`);
      for (const commit of commitsCarrying(root, result.coverage.ref, oid)) {
        lines.push(`    commit: ${commit}`);
      }
      for (const occurrence of occurrences) {
        lines.push(`    :${occurrence.line}  ${occurrence.excerpt}`);
      }
    }
    lines.push("");
  }
  return joinParts(lines.join("\n"), "\n");
}

function parseArgv(argv: string[]): { ref?: string; home?: string; json: boolean } {
  const parsed: { ref?: string; home?: string; json: boolean } = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") parsed.json = true;
    else if (arg === "--ref") parsed.ref = argv[(index += 1)];
    else if (arg === "--home") parsed.home = argv[(index += 1)];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (parsed.ref !== undefined && parsed.ref.length === 0) throw new Error("--ref needs a value");
  if (parsed.home !== undefined && parsed.home.length === 0) throw new Error("--home needs a value");
  return parsed;
}

function main(): void {
  const options = parseArgv(process.argv.slice(2));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = scanHistory({ root, ref: options.ref, home: options.home });
  process.stdout.write(
    options.json ? joinParts(JSON.stringify(result, null, 2), "\n") : formatReport(root, result),
  );
  process.exitCode = result.findings.length > 0 ? 1 : 0;
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 2;
  }
}
