/**
 * Templates — save, list, retrieve, and spawn fleet templates.
 *
 * A template is a named collection of agent specs. Once saved, you can spawn a
 * fresh fleet from it without re-typing the prompts. Templates persist in the
 * SQLite ledger under the `templates` collection (keyed `${name}@v${version}`),
 * so they survive restarts and travel with the user. Every write runs inside a
 * single withLedger transaction; reads use readLedger.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { withLedger, readLedger } from "./db.js";
import type { MeshData } from "./core.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TemplateAgent {
  role: string;
  prompt: string;
  agent?: string;
}

export interface FleetTemplate {
  name: string;
  description: string;
  agents: TemplateAgent[];
  created_at: number;
  version: number;
}

interface TemplateWithMeta extends FleetTemplate {
  id: string; // internal UUID for the ledger key
}

type TemplateDict = Record<string, TemplateWithMeta>;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const NAME_PATTERN = /^[a-z0-9_-]+$/;

function validateName(name: string): void {
  if (!name || name.trim().length === 0) {
    throw new Error("Template name is required");
  }
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      "Template name must contain only lowercase letters, numbers, dashes, and underscores"
    );
  }
  if (name.length > 64) {
    throw new Error("Template name must be 64 characters or fewer");
  }
}

function validateAgents(agents: TemplateAgent[]): void {
  if (!agents || agents.length === 0) {
    throw new Error("Template must have at least one agent");
  }
  if (agents.length > 32) {
    throw new Error("Template must have 32 or fewer agents");
  }
  for (const a of agents) {
    if (!a.role || a.role.trim().length === 0) {
      throw new Error("Each template agent must have a non-empty role");
    }
    if (!a.prompt || a.prompt.trim().length === 0) {
      throw new Error(`Template agent "${a.role}" must have a non-empty prompt`);
    }
  }
}

// ---------------------------------------------------------------------------
// Ledger access (templates stored under the `templates` collection)
// ---------------------------------------------------------------------------

function currentTemplates(): TemplateDict {
  return (readLedger().templates ?? {}) as TemplateDict;
}

/** The templates dict inside a withLedger mutator's `data` (lazily initialized). */
function templatesOf(data: MeshData): TemplateDict {
  if (!data.templates) data.templates = {};
  return data.templates as TemplateDict;
}

function key(name: string, version: number): string {
  return `${name}@v${version}`;
}

function nextVersion(templates: TemplateDict, name: string): number {
  let max = 0;
  const prefix = `${name}@v`;
  for (const k of Object.keys(templates)) {
    if (k.startsWith(prefix)) {
      const n = Number(k.slice(prefix.length));
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return max + 1;
}

function normalizeAgents(agents: TemplateAgent[]): TemplateAgent[] {
  return agents.map((a) => ({
    role: a.role.trim(),
    prompt: a.prompt.trim(),
    ...(a.agent ? { agent: a.agent } : {}),
  }));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function saveFleetTemplate(
  name: string,
  agents: TemplateAgent[],
  description: string = "",
  version?: number
): FleetTemplate {
  validateName(name);
  validateAgents(agents);
  return withLedger((data): FleetTemplate => {
    const templates = templatesOf(data);
    const targetVersion = version ?? nextVersion(templates, name);
    const storageKey = key(name, targetVersion);
    if (templates[storageKey]) {
      throw new Error(`Template "${name}" version ${targetVersion} already exists`);
    }
    const tpl: TemplateWithMeta = {
      id: randomUUID(),
      name,
      description: description.trim(),
      agents: normalizeAgents(agents),
      created_at: Date.now(),
      version: targetVersion,
    };
    templates[storageKey] = tpl;
    return stripMeta(tpl);
  });
}

export function listFleetTemplates(): FleetTemplate[] {
  return Object.values(currentTemplates())
    .map(stripMeta)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function listFleetTemplateVersions(name: string): FleetTemplate[] {
  const templates = currentTemplates();
  const prefix = `${name}@v`;
  return Object.keys(templates)
    .filter((k) => k.startsWith(prefix))
    .map((k) => stripMeta(templates[k]!))
    .sort((a, b) => b.version - a.version);
}

export function getFleetTemplate(name: string, version?: number): FleetTemplate | null {
  const templates = currentTemplates();
  if (version !== undefined) {
    const tpl = templates[key(name, version)];
    return tpl ? stripMeta(tpl) : null;
  }
  const versions = listFleetTemplateVersions(name);
  return versions.length > 0 ? versions[0]! : null;
}

export function deleteFleetTemplate(name: string, version?: number): boolean {
  return withLedger((data): boolean => {
    const templates = templatesOf(data);
    if (version !== undefined) {
      const k = key(name, version);
      if (!templates[k]) return false;
      delete templates[k];
      return true;
    }
    const prefix = `${name}@v`;
    let removed = false;
    for (const k of Object.keys(templates)) {
      if (k.startsWith(prefix)) {
        delete templates[k];
        removed = true;
      }
    }
    return removed;
  });
}

export interface SpawnSpec {
  agents: TemplateAgent[];
}

export function spawnFromTemplate(name: string, version?: number): SpawnSpec | null {
  const tpl = getFleetTemplate(name, version);
  if (!tpl) return null;
  return { agents: tpl.agents };
}

// ---------------------------------------------------------------------------
// Export / Import (v0.8.6)
// ---------------------------------------------------------------------------

export const TEMPLATE_SCHEMA = "meshfleet-template-v1";

export interface ExportedTemplate {
  schema: string;
  name: string;
  version: number;
  description: string;
  agents: TemplateAgent[];
  exported_at: number;
}

export function exportFleetTemplate(
  name: string,
  filePath: string,
  version?: number
): ExportedTemplate {
  const tpl = getFleetTemplate(name, version);
  if (!tpl) {
    throw new Error(`Template "${name}" not found`);
  }
  const exported: ExportedTemplate = {
    schema: TEMPLATE_SCHEMA,
    name: tpl.name,
    version: tpl.version,
    description: tpl.description,
    agents: tpl.agents,
    exported_at: Date.now(),
  };
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(exported, null, 2));
  return exported;
}

export function importFleetTemplate(
  filePath: string,
  rename?: string
): FleetTemplate {
  // File I/O + schema validation OUTSIDE the transaction.
  if (!existsSync(filePath)) {
    throw new Error(`Cannot read template file: ${filePath}`);
  }
  let raw: ExportedTemplate;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf-8")) as ExportedTemplate;
  } catch (err) {
    throw new Error(`Failed to parse template file: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (raw.schema !== TEMPLATE_SCHEMA) {
    throw new Error(`Unknown template schema "${raw.schema}"; expected "${TEMPLATE_SCHEMA}"`);
  }
  if (!raw.name || !Array.isArray(raw.agents)) {
    throw new Error("Template file is missing required fields (name, agents)");
  }
  if (rename) validateName(rename);
  const agents = normalizeAgents(raw.agents.map((a) => ({ role: a.role, prompt: a.prompt, ...(a.agent ? { agent: a.agent } : {}) })));
  validateAgents(agents);
  const description = (raw.description ?? "").trim();

  // Collision check + insert in ONE transaction (was a TOCTOU across a read + save).
  return withLedger((data): FleetTemplate => {
    const templates = templatesOf(data);
    let targetName = rename ?? raw.name;
    if (!rename) {
      // Non-rename import: if the name already exists, suffix a timestamp to avoid clobbering.
      const exists = Object.keys(templates).some((k) => k.startsWith(`${raw.name}@v`));
      if (exists) {
        const stamp = new Date().toISOString().replace(/[:.tz]/gi, "-").slice(0, 19);
        targetName = `${raw.name}-${stamp}`;
      }
    }
    validateName(targetName);
    const storageKey = key(targetName, 1);
    if (templates[storageKey]) {
      throw new Error(`Template "${targetName}" version 1 already exists`);
    }
    const tpl: TemplateWithMeta = {
      id: randomUUID(),
      name: targetName,
      description,
      agents,
      created_at: Date.now(),
      version: 1,
    };
    templates[storageKey] = tpl;
    return stripMeta(tpl);
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function stripMeta(tpl: TemplateWithMeta): FleetTemplate {
  return {
    name: tpl.name,
    description: tpl.description,
    agents: tpl.agents,
    created_at: tpl.created_at,
    version: tpl.version,
  };
}
