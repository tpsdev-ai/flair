/** Local init may finish without starting Harper. Keep its skill seed pending
 * until the next successful `flair start`; a refused seed leaves it pending. */
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SkillSeedOutcome } from "./skill-seed.js";

export function skillSeedPendingPath(dataDir: string): string {
  return join(dataDir, "using-flair-seed-pending");
}

export function markSkillSeedPending(dataDir: string): void {
  writeFileSync(skillSeedPendingPath(dataDir), "pending\n", { mode: 0o600 });
}

export function clearSkillSeedPending(dataDir: string): void {
  const path = skillSeedPendingPath(dataDir);
  if (existsSync(path)) unlinkSync(path);
}

/** Return null when there is no pending seed; retain the marker on any failure. */
export async function reconcilePendingSkillSeed(
  dataDir: string,
  seed: () => Promise<SkillSeedOutcome>,
): Promise<SkillSeedOutcome | null> {
  const path = skillSeedPendingPath(dataDir);
  if (!existsSync(path)) return null;
  const outcome = await seed();
  if (outcome.kind === "refused") return outcome;
  clearSkillSeedPending(dataDir);
  return outcome;
}
