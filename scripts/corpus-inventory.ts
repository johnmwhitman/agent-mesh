export function assertCompleteCorpusInventory(
  generatedIds: readonly string[],
  committedIds: readonly string[],
): void {
  const generated = new Set(generatedIds);
  const missing = [...new Set(committedIds)].filter((id) => !generated.has(id)).sort();
  if (missing.length === 0) return;

  throw new Error(
    `INCOMPLETE CORPUS INVENTORY: canonical generator is missing ${missing.length} committed manifest ` +
      `entr${missing.length === 1 ? "y" : "ies"}: ${missing.join(", ")}. ` +
      "Refusing to write fixtures or manifest.",
  );
}
