export function migrationCycleDone(status: {
  cyclePhase?: string;
  lastCycleError?: string | null;
} | null | undefined): boolean {
  if (status?.cyclePhase !== "done") return false;
  if (status.lastCycleError != null) throw new Error(status.lastCycleError);
  return true;
}
