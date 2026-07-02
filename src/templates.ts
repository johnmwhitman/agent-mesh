/**
 * Templates — save, list, retrieve, and spawn fleet templates.
 *
 * A template is a named collection of agent specs. Once saved, you can
 * spawn a fresh fleet from it without re-typing the prompts. Templates
 * persist in the same JSON ledger as fleets/agents/messages (under a
 * `templates` key) so they survive restarts and travel with the user.
 *
 * Design choices:
 *   - Names: lowercase letters, numbers, dashes, underscores (validated)
 *   - Storage: same ledger (no new files, no new dirs)
 *   - No versioning yet: re-saving overwrites. v0.7+ will add versions.
 *
 * Three MCP tools:
 *   - save_fleet_template(name, agents, description?)
 *   - list_fleet_templates()
 *   - spawn_from_template(name)
 *
 * (delete_fleet_template is a CLI/admin convenience, not exposed as MCP
 * in v0.6.0 — it's available as `deleteFleetTemplate` here for scripts.)
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

export function saveFleetTemplate(
  name: string,
  agents: TemplateAgent[],
  description: string = ''
): FleetTemplate {
  validateName(name)
  validateAgents(agents)

  const templates = loadTemplates()
  if (templates[name]) {
    throw new Error(`Template "${name}" already exists`)
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
  }

  templates[name] = tpl
  saveTemplates(templates)

  return stripMeta(tpl)
}

export function listFleetTemplates(): FleetTemplate[] {
  const templates = loadTemplates()
  return Object.values(templates)
    .map(stripMeta)
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function getFleetTemplate(name: string): FleetTemplate | null {
  const templates = loadTemplates()
  const tpl = templates[name]
  return tpl ? stripMeta(tpl) : null
}

export function deleteFleetTemplate(name: string): boolean {
  const templates = loadTemplates()
  if (!templates[name]) return false
  delete templates[name]
  saveTemplates(templates)
  return true
}

export interface SpawnSpec {
  agents: TemplateAgent[]
}

export function spawnFromTemplate(name: string): SpawnSpec | null {
  const tpl = getFleetTemplate(name)
  if (!tpl) return null
  return { agents: tpl.agents }
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
  }
}