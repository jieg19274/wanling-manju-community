/** Recovery may tolerate only newly added library assets. Existing identities,
 * states, authoritative beats, model and project must remain exactly unchanged.
 * Returned suggestions still require normal evidence review and explicit apply. */
export function compatibleAssetRecoveryInput(saved: Record<string, unknown>, current: Record<string, unknown>): boolean {
  const { existingAssets: oldAssets, ...oldInput } = saved;
  const { existingAssets: newAssets, ...newInput } = current;
  if (JSON.stringify(oldInput) !== JSON.stringify(newInput) || !Array.isArray(oldAssets) || !Array.isArray(newAssets)) return false;
  const key = (a: Record<string, unknown>) => JSON.stringify([a.kind, a.name]);
  const currentByKey = new Map<string, unknown>();
  for (const raw of newAssets) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const k = key(raw as Record<string, unknown>);
    if (currentByKey.has(k)) return false;
    currentByKey.set(k, raw);
  }
  const seen = new Set<string>();
  for (const raw of oldAssets) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const k = key(raw as Record<string, unknown>);
    if (seen.has(k) || JSON.stringify(raw) !== JSON.stringify(currentByKey.get(k))) return false;
    seen.add(k);
  }
  return true;
}
