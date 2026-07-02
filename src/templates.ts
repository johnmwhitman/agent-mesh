/**
 * Templates — save, list, retrieve, and spawn fleet templates.
 *
 * A template is a named collection of agent specs. Once saved, you can
 * spawn a fresh fleet from it without re-typing the prompts. Templates
 * persist in the same JSON ledger as fleets/agents/messages (under a
 * `templates` key) so they survive restarts and travel with the user.
 *
 * Versioning (v0.8.5):
 *   - Each save creates a new version; old versions are preserved
 *   - save(name, ...) without an explicit version auto-increments
 *   - get(name) returns the latest; get(name, version) returns a specific one
 *   - listFleetTemplateVersions(name) returns all versions sorted newest first
 *   - delete(name, version) removes one; delete(name) removes all
 *
 * Internal ledger key is `${name}@v${version}` so multiple versions coexist
 * in the same `templates` dict without collision.
 */

import { randomUUID } from 'node:crypto'
import { loadData, saveData, type MeshData } from './core.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TemplateAgent {
  role: string
  prompt: string
  agent?: string
}

export interface FleetTemplate {
  name: string
  description: string
  agents: TemplateAgent[]
  created_at: number
  version: number
}

interface TemplateWithMeta extends FleetTemplate {
  id: string // internal UUID for the ledger key
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const NAME_PATTERN = /^[a-z0-9_-]+$/

function validateName(name: string): void {
  if (!name || name.trim().length === 0) {
    throw new Error('Template name is required')
  }
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      'Template name must contain only lowercase letters, numbers, dashes, and underscores'
    )
  }
  if (name.length > 64) {
    throw new Error('Template name must be 64 characters or fewer')
  }
}

function validateAgents(agents: TemplateAgent[]): void {
  if (!agents || agents.length === 0) {
    throw new Error('Template must have at least one agent')
  }
  if (agents.length > 32) {
    throw new Error('Template must have 32 or fewer agents')
  }
  for (const a of agents) {
    if (!a.role || a.role.trim().length === 0) {
      throw new Error('Each template agent must have a non-empty role')
    }
    if (!a.prompt || a.prompt.trim().length === 0) {
      throw new Error(`Template agent "${a.role}" must have a non-empty prompt`)
    }
  }
}

// ---------------------------------------------------------------------------
// Ledger access (templates stored under .templates)
// ---------------------------------------------------------------------------

function loadTemplates(): Record<string, TemplateWithMeta> {
  const data = loadData() as MeshData & {
    templates?: Record<string, TemplateWithMeta>
  }
  return data.templates ?? {}
}

function saveTemplates(
  templates: Record<string, TemplateWithMeta>
): void {
  const data = loadData() as MeshData & {
    templates?: Record<string, TemplateWithMeta>
  }
  data.templates = templates
  saveData(data as MeshData)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function key(name: string, version: number): string {
  return `${name}@v${version}`;
}

function nextVersion(name: string): number {
  const templates = loadTemplates();
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

export function saveFleetTemplate(
  name: string,
  agents: TemplateAgent[],
  description: string = '',
  version?: number
): FleetTemplate {
  validateName(name);
  validateAgents(agents);

  const templates = loadTemplates();
  const targetVersion = version ?? nextVersion(name);
  const storageKey = key(name, targetVersion);

  if (templates[storageKey]) {
    throw new Error(`Template "${name}" version ${targetVersion} already exists`);
  }

  const tpl: TemplateWithMeta = {
    id: randomUUID(),
    name,
    description: description.trim(),
    agents: agents.map((a) => ({
      role: a.role.trim(),
      prompt: a.prompt.trim(),
      ...(a.agent ? { agent: a.agent } : {}),
    })),
    created_at: Date.now(),
    version: targetVersion,
  };

  templates[storageKey] = tpl;
  saveTemplates(templates);

  return stripMeta(tpl);
}

export function listFleetTemplates(): FleetTemplate[] {
  const templates = loadTemplates();
  return Object.values(templates)
    .map(stripMeta)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function listFleetTemplateVersions(name: string): FleetTemplate[] {
  const templates = loadTemplates();
  const prefix = `${name}@v`;
  return Object.keys(templates)
    .filter((k) => k.startsWith(prefix))
    .map((k) => stripMeta(templates[k]!))
    .sort((a, b) => b.version - a.version);
}

export function getFleetTemplate(name: string, version?: number): FleetTemplate | null {
  const templates = loadTemplates();
  if (version !== undefined) {
    const tpl = templates[key(name, version)];
    return tpl ? stripMeta(tpl) : null;
  }
  const versions = listFleetTemplateVersions(name);
  return versions.length > 0 ? versions[0]! : null;
}

export function deleteFleetTemplate(name: string, version?: number): boolean {
  const templates = loadTemplates();
  if (version !== undefined) {
    const k = key(name, version);
    if (!templates[k]) return false;
    delete templates[k];
    saveTemplates(templates);
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
  if (removed) saveTemplates(templates);
  return removed;
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