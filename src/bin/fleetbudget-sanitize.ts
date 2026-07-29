#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import {
  FleetBudgetSanitizerError,
  sanitizeFleetBudgetReport,
  type FleetBudgetSanitizerErrorCode,
  type SanitizeFleetBudgetReportInput,
} from "../fleetbudget-sanitizer.js";

const MAX_REPORT_BYTES = 1_048_576;
const MAX_TTL_MS = 600_000;
const TIMESTAMP = /^(0|[1-9]\d*)$/;
const POSITIVE_INTEGER = /^[1-9]\d*$/;

type FleetBudgetCliArguments = Omit<SanitizeFleetBudgetReportInput, "report_bytes">;

const FLAG_FIELDS = {
  "--collection-start-ms": "collection_started_at_ms",
  "--collection-finish-ms": "collection_finished_at_ms",
  "--now-ms": "now_ms",
  "--ttl-ms": "ttl_ms",
} as const;

type FleetBudgetCliFlag = keyof typeof FLAG_FIELDS;

function invalidArguments(): never {
  throw new FleetBudgetSanitizerError("invalid_input");
}

function parseDecimal(value: string | undefined, allowZero: boolean): number {
  if (
    value === undefined
    || !(allowZero ? TIMESTAMP : POSITIVE_INTEGER).test(value)
  ) {
    invalidArguments();
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) invalidArguments();
  return parsed;
}

export function parseFleetBudgetSanitizerArgs(
  argv: readonly string[],
): FleetBudgetCliArguments {
  const parsed: Partial<FleetBudgetCliArguments> = {};
  const seen = new Set<FleetBudgetCliFlag>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (
      flag === undefined
      || !Object.prototype.hasOwnProperty.call(FLAG_FIELDS, flag)
    ) {
      invalidArguments();
    }
    const typedFlag = flag as FleetBudgetCliFlag;
    if (seen.has(typedFlag)) invalidArguments();
    seen.add(typedFlag);
    const field = FLAG_FIELDS[typedFlag];
    const value = parseDecimal(argv[index + 1], typedFlag !== "--ttl-ms");
    if (typedFlag === "--ttl-ms" && value > MAX_TTL_MS) invalidArguments();
    parsed[field] = value;
  }
  for (const required of [
    "--collection-start-ms",
    "--collection-finish-ms",
    "--now-ms",
  ] as const) {
    if (!seen.has(required)) invalidArguments();
  }
  return parsed as FleetBudgetCliArguments;
}

export async function readBoundedFleetBudgetInput(
  source: AsyncIterable<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of source) {
      if (!(chunk instanceof Uint8Array)) {
        throw new FleetBudgetSanitizerError("input_read_failed");
      }
      size += chunk.byteLength;
      if (size > MAX_REPORT_BYTES) {
        throw new FleetBudgetSanitizerError(
          "input_too_large",
          "input.report_bytes",
        );
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof FleetBudgetSanitizerError) throw error;
    throw new FleetBudgetSanitizerError("input_read_failed");
  }
  const reportBytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    reportBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return reportBytes;
}

function serializeError(
  code: FleetBudgetSanitizerErrorCode,
  path?: string,
): string {
  return `${JSON.stringify({
    error: {
      code,
      ...(path === undefined ? {} : { path }),
    },
  })}\n`;
}

export async function runFleetBudgetSanitizerCli(
  argv: readonly string[],
  stdin: AsyncIterable<Uint8Array>,
  writeStdout: (value: string) => void,
  writeStderr: (value: string) => void,
): Promise<number> {
  let args: FleetBudgetCliArguments;
  try {
    args = parseFleetBudgetSanitizerArgs(argv);
  } catch {
    writeStderr(serializeError("invalid_input"));
    return 2;
  }

  try {
    const reportBytes = await readBoundedFleetBudgetInput(stdin);
    const snapshot = sanitizeFleetBudgetReport({
      report_bytes: reportBytes,
      ...args,
    });
    writeStdout(`${JSON.stringify(snapshot)}\n`);
    return 0;
  } catch (error) {
    const sanitizedError = error instanceof FleetBudgetSanitizerError
      ? error
      : new FleetBudgetSanitizerError("invalid_report");
    writeStderr(serializeError(sanitizedError.code, sanitizedError.path));
    return 1;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runFleetBudgetSanitizerCli(
    process.argv.slice(2),
    process.stdin,
    (value) => process.stdout.write(value),
    (value) => process.stderr.write(value),
  );
}

const invokedPath = process.argv[1];
const invokedName = invokedPath?.split(/[\\/]/).at(-1);
if (
  invokedPath !== undefined
  && (
    import.meta.url === pathToFileURL(invokedPath).href
    || invokedName === "meshfleet-fleetbudget-sanitize"
  )
) {
  void main();
}
