// Type declarations for scripts/lib/abi-preflight.mjs.
//
// The `.mjs` is runnable as plain ESM by Node (typed via JSDoc in-source), but
// the test file imports it from TypeScript-land. Without this declaration
// file, `tsc` (with the lane's strict settings) refuses the import as implicit
// `any`. The declaration mirrors the JSDoc typedefs in the .mjs so both surfaces
// agree.
//
// Mirror the constants the preflight exports so consumers (run-tests.mjs, the
// CLI receipt, future test additions) all use the same source of truth.

export const EXPECTED_NODE_MAJOR: number;
export const EXPECTED_NODE_MINOR: number;
export const EXPECTED_ABI: number;
export const EXPECTED_ABI_SOURCE: string;
export const ADDON_MODULE: string;

export type AbiRuntime = {
  version: string | null;
  execPath: string | null;
  abi: number | null;
  modules: string | null;
};

export type ParsedNodeVersion = {
  major: number;
  minor: number;
  patch: number;
  raw: string;
};

export type AddonProbeResult =
  | { loaded: true; version: string | null; sqliteVersion: string | null }
  | { loaded: false; error: string };

export type AbiFailure =
  | {
      kind: "no_runtime";
      runtime: AbiRuntime;
      addon: AddonProbeResult;
      message: string;
    }
  | {
      kind: "wrong_major";
      runtime: AbiRuntime;
      parsed: ParsedNodeVersion;
      addon: AddonProbeResult;
      message: string;
    }
  | {
      kind: "wrong_minor";
      runtime: AbiRuntime;
      parsed: ParsedNodeVersion;
      addon: AddonProbeResult;
      message: string;
    }
  | {
      kind: "wrong_abi";
      runtime: AbiRuntime;
      parsed: ParsedNodeVersion;
      addon: AddonProbeResult;
      message: string;
    }
  | {
      kind: "addon_load_failed";
      runtime: AbiRuntime;
      parsed: ParsedNodeVersion;
      addon: AddonProbeResult;
      message: string;
    };

export function inspectRuntime(): AbiRuntime;
export function parseNodeVersion(version: unknown): ParsedNodeVersion | null;
export function probeAddon(moduleName?: string): AddonProbeResult;
export function findAbiMismatch(opts?: {
  runtime?: AbiRuntime;
  addon?: AddonProbeResult;
  moduleName?: string;
}): AbiFailure | null;
export function abiRefusal(failure: AbiFailure): string;
export function abiSuccessReceipt(runtime: AbiRuntime, addon: AddonProbeResult): string;
export function main(argv: string[]): void;
