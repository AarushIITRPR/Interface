/** Subject navigation never restarts a finalized session or bypasses an operator gate. */
export function subjectNavigationTarget(status: string, index: number, types: string[], direction: number) {
  if (status !== "running" || ![-1, 1].includes(direction)) return null;
  if (direction === 1 && ["setup", "gate"].includes(types[index])) return null;
  const target = index + direction;
  if (target < 0 || target >= types.length || ["setup", "end"].includes(types[target])) return null;
  return target;
}
