import { ProjectSnapshot } from "./types";

export function snapshotHasRecords(
  snapshot: ProjectSnapshot | undefined | null
): boolean {
  if (!snapshot) {
    return false;
  }

  if (snapshot.current) {
    return true;
  }

  const days = Object.values(snapshot.days ?? {});
  for (const day of days) {
    const hasTime =
      (day.totalSeconds ?? 0) > 0 ||
      Object.keys(day.tasks ?? {}).length > 0 ||
      (day.entries?.length ?? 0) > 0;
    if (hasTime) {
      return true;
    }
  }

  return false;
}
