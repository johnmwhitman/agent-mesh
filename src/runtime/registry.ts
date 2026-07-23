import { OpenCodeRuntimeAdapter } from "./opencode.js";
import type { RuntimeAdapter } from "./types.js";

/** Registry is internal until runtime selection has a reviewed public contract. */
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

/** Existing spawn_fleet behavior stays OpenCode-backed without a public selector. */
export function getDefaultRuntimeAdapter(): RuntimeAdapter {
  return defaultRegistry.require("opencode-cli");
}
