export function findStaleSourceIds(
  mappedSourceIds: Iterable<string>,
  activeSourceIds: Set<string>,
): string[] {
  const stale: string[] = [];
  for (const mappedId of mappedSourceIds) {
    if (!activeSourceIds.has(mappedId)) {
      stale.push(mappedId);
    }
  }
  return stale;
}
