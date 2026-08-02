import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

const REQUIRED_AUDIT_PATHS = [
  "MESHFLEET_ISOLATION_ROOT",
  "MESHFLEET_DB_FILE",
  "MESHFLEET_DATA_FILE",
  "MESHFLEET_EVENT_LOG_FILE",
] as const;

export interface AuditStorageDefaults {
  dbFile: string;
  dataFile: string;
  eventLogFile: string;
}

export type MeshfleetAccessProfileConfiguration =
  | { readonly profile: "standard" }
  | {
      readonly profile: "audit";
      readonly isolationRoot: string;
      readonly dbFile: string;
      readonly dataFile: string;
      readonly eventLogFile: string;
    };

function canonicalizeProspectivePath(input: string): string {
  const unresolved: string[] = [];
  let cursor = resolve(input);

  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) {
      throw new Error(`Cannot canonicalize audit path: ${input}`);
    }
    unresolved.unshift(basename(cursor));
    cursor = parent;
  }

  return resolve(realpathSync(cursor), ...unresolved);
}

function isStrictlyInside(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return Boolean(fromRoot)
    && fromRoot !== ".."
    && !fromRoot.startsWith(`..${sep}`)
    && !isAbsolute(fromRoot);
}

function rejectStorageSymlinkComponents(
  configuredRoot: string,
  canonicalRoot: string,
  target: string,
  name: string,
): void {
  const lexicalTarget = resolve(target);
  const walkRoot = isStrictlyInside(configuredRoot, lexicalTarget)
    ? configuredRoot
    : isStrictlyInside(canonicalRoot, lexicalTarget)
      ? canonicalRoot
      : undefined;
  if (!walkRoot) {
    throw new Error(`${name} escapes MESHFLEET_ISOLATION_ROOT`);
  }

  const parts = relative(walkRoot, lexicalTarget).split(sep).filter(Boolean);
  let cursor = walkRoot;
  for (let index = 0; index < parts.length; index++) {
    cursor = resolve(cursor, parts[index]!);
    let entry: ReturnType<typeof lstatSync>;
    try {
      entry = lstatSync(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`${name} must not contain symbolic links`);
    }
    if (index < parts.length - 1 && !entry.isDirectory()) {
      throw new Error(`${name} has a non-directory path component`);
    }
  }
}

/**
 * Audit mode is intentionally opt-in and must never fall back to a user's live
 * storage. Require every current storage path to be named before the server
 * accepts an MCP connection.
 */
export function requireAuditIsolationEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  defaults: AuditStorageDefaults,
): MeshfleetAccessProfileConfiguration {
  const requestedProfile = env.MESHFLEET_ACCESS_PROFILE;
  if (requestedProfile === undefined) return Object.freeze({ profile: "standard" });
  if (requestedProfile !== "audit") {
    throw new Error("Unknown MESHFLEET_ACCESS_PROFILE");
  }

  for (const name of REQUIRED_AUDIT_PATHS) {
    if (!env[name]?.trim()) {
      throw new Error(`Audit access profile requires ${name}`);
    }
  }

  const isolationRoot = env.MESHFLEET_ISOLATION_ROOT!;
  if (!isAbsolute(isolationRoot)) {
    throw new Error("Audit isolation root must be an absolute path");
  }
  const configuredRoot = resolve(isolationRoot);
  const canonicalRoot = realpathSync(isolationRoot);
  if (!statSync(canonicalRoot).isDirectory()) {
    throw new Error("Audit isolation root must be a directory");
  }

  const configured = [
    ["MESHFLEET_DB_FILE", env.MESHFLEET_DB_FILE!, defaults.dbFile],
    ["MESHFLEET_DATA_FILE", env.MESHFLEET_DATA_FILE!, defaults.dataFile],
    ["MESHFLEET_EVENT_LOG_FILE", env.MESHFLEET_EVENT_LOG_FILE!, defaults.eventLogFile],
  ] as const;
  const canonicalTargets = new Map<string, string>();
  const resolvedTargets: Record<string, string> = {};

  for (const [name, target, defaultTarget] of configured) {
    if (!isAbsolute(target)) {
      throw new Error(`${name} must be an absolute path in the audit access profile`);
    }
    rejectStorageSymlinkComponents(configuredRoot, canonicalRoot, target, name);
    const canonicalTarget = canonicalizeProspectivePath(target);
    if (existsSync(target)) {
      if (lstatSync(target).isSymbolicLink()) {
        throw new Error(`${name} must not be a symbolic link`);
      }
      const targetStat = statSync(target);
      if (!targetStat.isFile() || targetStat.nlink !== 1) {
        throw new Error(`${name} must be a regular file with exactly one hard link`);
      }
    }
    if (!isStrictlyInside(canonicalRoot, canonicalTarget)) {
      throw new Error(`${name} escapes MESHFLEET_ISOLATION_ROOT`);
    }
    if (canonicalTarget === canonicalizeProspectivePath(defaultTarget)) {
      throw new Error(`${name} must not name MeshFleet's compiled default storage`);
    }
    if (canonicalTargets.has(canonicalTarget)) {
      throw new Error(`${name} duplicates ${canonicalTargets.get(canonicalTarget)}`);
    }
    canonicalTargets.set(canonicalTarget, name);
    resolvedTargets[name] = canonicalTarget;
  }

  return Object.freeze({
    profile: "audit",
    isolationRoot: canonicalRoot,
    dbFile: resolvedTargets.MESHFLEET_DB_FILE!,
    dataFile: resolvedTargets.MESHFLEET_DATA_FILE!,
    eventLogFile: resolvedTargets.MESHFLEET_EVENT_LOG_FILE!,
  });
}
