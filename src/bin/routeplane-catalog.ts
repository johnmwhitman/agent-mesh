#!/usr/bin/env node
import { fetchRoutePlaneCatalog } from "../routeplane-catalog.js";

type CatalogOptions = {
  ttl_ms?: number;
  timeout_ms?: number;
};

function usageError(): Error {
  return new Error("RoutePlane catalog CLI only accepts --ttl-ms and --timeout-ms with positive integer values");
}

function parsePositiveInteger(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) {
    throw usageError();
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw usageError();
  }
  return parsed;
}

function parseArgs(argv: string[]): CatalogOptions {
  const options: CatalogOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== "--ttl-ms" && flag !== "--timeout-ms") {
      throw usageError();
    }
    if (index + 1 >= argv.length) {
      throw usageError();
    }
    const value = parsePositiveInteger(argv[index + 1]);
    if (flag === "--ttl-ms") {
      if (options.ttl_ms !== undefined) throw usageError();
      options.ttl_ms = value;
    } else {
      if (options.timeout_ms !== undefined) throw usageError();
      options.timeout_ms = value;
    }
    index += 1;
  }
  return options;
}

async function main(): Promise<void> {
  try {
    const snapshot = await fetchRoutePlaneCatalog(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(snapshot)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

void main();
