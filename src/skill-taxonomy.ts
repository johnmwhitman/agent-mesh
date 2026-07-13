/**
 * Skill taxonomy — hierarchical skills for richer route_work matching.
 *
 * Loads a JSON taxonomy like:
 *   { frontend: { react: ["nextjs", "remix"], vue: ["nuxt"] } }
 *
 * Lets route_work match a description like "build a nextjs app" not only to
 * a `nextjs` agent but also to ancestors (`react`, `frontend`) with decaying
 * weight. Matches the v0.8 ROADMAP commitment without requiring an embed
 * model at runtime.
 */

import { readFileSync } from "node:fs";

export type Taxonomy = Record<string, Record<string, string[]>>;

export interface SkillScore {
  skill: string;
  score: number;
  /** Number of hops from the matched keyword to this skill. 0 = direct hit. */
  distance: number;
}

// ---------------------------------------------------------------------------
// In-memory taxonomy store (mirrors synonyms' override pattern).
//
// route_work reads the active taxonomy through getSkillTaxonomy(). It is empty
// by default, so routing is byte-for-byte unchanged until a taxonomy is set —
// programmatically via setSkillTaxonomy(), or once from the environment:
//   AGENT_MESH_TAXONOMY=/path/to/taxonomy.json   (a file), or
//   AGENT_MESH_TAXONOMY='{"frontend":{"react":["nextjs"]}}'   (inline JSON).
// ---------------------------------------------------------------------------

let activeTaxonomy: Taxonomy | null = null;
let envChecked = false;

export function setSkillTaxonomy(input: string | Taxonomy): void {
  activeTaxonomy = parseSkillTaxonomy(input);
  envChecked = true; // an explicit set wins over the env; don't reload it later
}

export function resetSkillTaxonomy(): void {
  activeTaxonomy = {};
  envChecked = true; // an explicit reset means "empty on purpose" — ignore env
}

export function getSkillTaxonomy(): Taxonomy {
  if (activeTaxonomy === null && !envChecked) {
    envChecked = true;
    const raw = process.env.AGENT_MESH_TAXONOMY;
    if (raw && raw.trim().length > 0) {
      const looksInline = raw.trimStart().startsWith("{");
      if (looksInline) {
        activeTaxonomy = parseSkillTaxonomy(raw);
      } else {
        try {
          activeTaxonomy = parseSkillTaxonomy(readFileSync(raw, "utf8"));
        } catch {
          activeTaxonomy = {};
        }
      }
    } else {
      activeTaxonomy = {};
    }
  }
  return activeTaxonomy ?? {};
}

export function parseSkillTaxonomy(input: string | Taxonomy): Taxonomy {
  let parsed: Taxonomy;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input) as Taxonomy;
    } catch {
      return {};
    }
  } else {
    parsed = input;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  return parsed;
}

export function expandSkillWithAncestors(skill: string, tree: Taxonomy): string[] {
  const lower = skill.toLowerCase();
  for (const [top, mid] of Object.entries(tree)) {
    if (top.toLowerCase() === lower) return [top];
    for (const [middle, leaves] of Object.entries(mid)) {
      if (middle.toLowerCase() === lower) return [top, middle];
      if (Array.isArray(leaves) && leaves.some((l) => l.toLowerCase() === lower)) {
        return [top, middle, ...leaves.filter((l) => l.toLowerCase() === lower)];
      }
    }
  }
  return [];
}

export function scoreSkillsAgainstKeywords(keywords: string[], tree: Taxonomy): SkillScore[] {
  if (keywords.length === 0) return [];
  const scores = new Map<string, SkillScore>();

  for (const kw of keywords) {
    const kwLower = kw.toLowerCase();
    for (const [top, mid] of Object.entries(tree)) {
      const topLower = top.toLowerCase();
      const topHit = topLower.includes(kwLower);
      for (const [middle, leaves] of Object.entries(mid)) {
        const middleLower = middle.toLowerCase();
        const midHit = middleLower.includes(kwLower);
        let leafHit = false;
        for (const leaf of Array.isArray(leaves) ? leaves : []) {
          const leafLower = leaf.toLowerCase();
          if (leafLower.includes(kwLower)) {
            record(scores, leaf, 1.0, 0);
            leafHit = true;
          }
        }
        if (midHit) {
          record(scores, middle, 1.0, 0);
          for (const leaf of Array.isArray(leaves) ? leaves : []) {
            record(scores, leaf, 1.0 / 2, 1);
          }
        } else if (leafHit) {
          record(scores, middle, 1.0 / 2, 1);
        }
        if (topHit) {
          record(scores, top, 1.0, 0);
          for (const [middle2, leaves2] of Object.entries(mid)) {
            record(scores, middle2, 1.0 / 2, 1);
            for (const leaf of Array.isArray(leaves2) ? leaves2 : []) {
              record(scores, leaf, 1.0 / 3, 2);
            }
          }
        } else if (midHit) {
          record(scores, top, 1.0 / 2, 1);
        }
      }
    }
  }

  return Array.from(scores.values()).sort((a, b) => b.score - a.score || a.skill.localeCompare(b.skill));
}

function record(map: Map<string, SkillScore>, skill: string, score: number, distance: number): void {
  const existing = map.get(skill);
  if (existing === undefined || score > existing.score) {
    map.set(skill, { skill, score, distance });
  }
}