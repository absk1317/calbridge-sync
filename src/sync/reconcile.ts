export function findStaleOutlookIds(
  mappedOutlookIds: Iterable<string>,
  activeOutlookIds: Set<string>,
): string[] {
  const stale: string[] = [];
  for (const mappedId of mappedOutlookIds) {
    if (!activeOutlookIds.has(mappedId)) {
      stale.push(mappedId);
    }
  }
  return stale;
}
