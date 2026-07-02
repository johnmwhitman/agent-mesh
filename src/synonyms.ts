/**
 * Synonym expansion — light, fast semantic-ish routing without ML.
 *
 * route_work historically scored by keyword overlap. "frontend" only matched
 * if the role or skills literally contained "frontend". With this module,
 * "ui" or "ux" in the description expands to also match a `frontend` agent.
 *
 * This is NOT a true embedding model. It is a curated synonym table for
 * common developer-tooling terms. It runs at zero network cost, has no
 * runtime dependency, and gives better routing for the ~80% case of
 * "user asked for the wrong keyword" misses.
 *
 * To extend: call setSynonymOverrides() with your domain-specific terms.
 * To swap for a real embedding model later: replace expandKeywordsWithSynonyms
 * in routeWork with your model.
 */

const BUILTIN_SYNONYMS: Record<string, string[]> = {
  frontend: ["ui", "ux", "web", "client", "browser", "spa"],
  backend: ["api", "server", "server-side", "service"],
  database: ["db", "sql", "postgres", "postgresql", "mysql", "mongo", "mongodb", "redis", "sqlite"],
  auth: ["authentication", "authorization", "login", "oauth", "jwt", "session", "sso"],
  testing: ["test", "qa", "jest", "vitest", "mocha", "unit-test", "e2e"],
  devops: ["deploy", "ci", "cd", "docker", "k8s", "kubernetes", "infra", "infrastructure"],
  mobile: ["ios", "android", "react-native", "flutter", "swift", "kotlin"],
  data: ["etl", "analytics", "ml", "ai", "bigquery", "spark", "warehouse"],
  security: ["secure", "vulnerability", "encryption", "owasp", "xss", "csrf"],
  api: ["rest", "graphql", "grpc", "endpoint", "route"],
  python: ["py", "django", "flask", "fastapi"],
  javascript: ["js", "node", "nodejs", "es6"],
  typescript: ["ts", "types"],
  rust: ["rust-lang", "cargo"],
  go: ["golang"],
  aws: ["amazon", "s3", "lambda", "ec2"],
  gcp: ["google-cloud", "cloud-run"],
  azure: ["microsoft-azure"],
  react: ["reactjs", "react.js", "jsx"],
  vue: ["vuejs", "vue.js"],
  svelte: ["sveltekit"],
  css: ["styles", "styling", "tailwind"],
  html: ["markup", "dom"],
  ci: ["continuous-integration"],
  cd: ["continuous-deployment"],
  performance: ["perf", "optimization", "speed", "latency"],
  refactor: ["cleanup", "rewrite", "modernize"],
  documentation: ["docs", "readme", "comments"],
  monitoring: ["observability", "logs", "metrics", "tracing", "otel"],
};

let overrides: Record<string, string[]> = {};

export function getSynonyms(term: string): string[] {
  const lower = term.toLowerCase();
  if (lower in overrides) return [...overrides[lower]];
  if (lower in BUILTIN_SYNONYMS) return [...BUILTIN_SYNONYMS[lower]];
  for (const [key, syns] of Object.entries(BUILTIN_SYNONYMS)) {
    if (syns.includes(lower)) return [key, ...syns.filter((s) => s !== lower)];
  }
  for (const [key, syns] of Object.entries(overrides)) {
    if (syns.includes(lower)) return [key, ...syns.filter((s) => s !== lower)];
  }
  return [];
}

export function expandKeywordsWithSynonyms(keywords: string[]): string[] {
  const out = new Set<string>();
  for (const kw of keywords) {
    const lower = kw.toLowerCase();
    out.add(lower);
    for (const syn of getSynonyms(lower)) out.add(syn);
  }
  return Array.from(out);
}

export function getAllSynonymKeys(): string[] {
  const keys = new Set<string>(Object.keys(BUILTIN_SYNONYMS));
  for (const k of Object.keys(overrides)) keys.add(k);
  return Array.from(keys).sort();
}

export function setSynonymOverrides(map: Record<string, string[]>): void {
  overrides = { ...map };
}

export function resetSynonymOverrides(): void {
  overrides = {};
}