import { OpenCodeRuntimeAdapter } from "./opencode.js";
import type { RuntimeAdapter } from "./types.js";

/** Registry is internal: there is no public runtime-adapter selector. */
export class RuntimeAdapterRegistry {
  private readonly adapters = new Map<string, RuntimeAdapter>();

  register(adapter: RuntimeAdapter): void {
    if (this.adapters.has(adapter.id)) throw new Error(`Runtime adapter already registered: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): RuntimeAdapter | undefined {
    return this.adapters.get(id);
  }

  require(id: string): RuntimeAdapter {
    const adapter = this.get(id);
    if (!adapter) throw new Error(`Unknown runtime adapter: ${id}`);
    return adapter;
  }

  ids(): string[] {
    return [...this.adapters.keys()].sort();
  }
}

export function createDefaultRuntimeRegistry(): RuntimeAdapterRegistry {
  const registry = new RuntimeAdapterRegistry();
  registry.register(new OpenCodeRuntimeAdapter());
  return registry;
}

const defaultRegistry = createDefaultRuntimeRegistry();

/** Existing spawn_fleet behavior stays OpenCode-backed: there is no public adapter selector.
 *  Public callers may select a `model` (provider/model) on the agent; that flows through
 *  `ExecutionSpec.requestedModel` and the default adapter's argv, not through this registry. */
export function getDefaultRuntimeAdapter(): RuntimeAdapter {
  return defaultRegistry.require("opencode-cli");
}
