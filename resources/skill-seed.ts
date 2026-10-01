/**
 * skill-seed.ts — the `using-flair` seed decision and orchestration (flair#2141 S2).
 *
 * The seeding rule is small and pure, so it is unit-tested without the runtime:
 *
 *   - no stored row             → create it;
 *   - stored = the current text → unchanged (a re-run changes nothing);
 *   - stored hash ∈ shipped     → replace it (an unedited shipped version);
 *   - stored hash ∉ shipped     → keep it (an operator edited it) and report.
 *
 * `runSkillSeed` applies the rule over an injectable IO seam, so the fail-closed
 * contract (an unreadable existing row or assignment refuses, never writes a
 * duplicate) is testable without inducing a real table read failure.
 *
 * `resources/SkillSeed.ts` (the operator endpoint) supplies the real IO.
 * No Harper import.
 */
import { usingFlairSkillHash } from "./using-flair-skill.js";

/**
 * The agentId that owns the installer-seeded skill row. A reserved id, never a
 * real agent: the seed is operator/infrastructure content, not one agent's.
 */
export const SEED_SKILL_AGENT_ID = "flair-seed";

/** The seed row's Memory id and the org assignment's `skillRef`. */
export const SEED_SKILL_ID = "using-flair";

export type SeedAction = "create" | "unchanged" | "replace" | "keep";

/** The decision for one seeding pass. `stored` is the row's `content`, or null. */
export function decideSkillSeed(
  stored: string | null,
  currentContent: string,
  shippedHashes: readonly string[],
  currentHash: string = usingFlairSkillHash(currentContent),
): SeedAction {
  if (stored === null) return "create";
  const hash = usingFlairSkillHash(stored);
  if (hash === currentHash) return "unchanged";
  if (shippedHashes.includes(hash)) return "replace";
  return "keep";
}

/** A skill row as the seed reads it. */
export interface SeedRowShape {
  id?: unknown;
  agentId?: unknown;
  content?: unknown;
}

/** The seed rows among `rows` — those the reserved system writer owns. */
export function seedSkillRows<T extends SeedRowShape>(rows: T[]): T[] {
  return rows.filter((row) => row.agentId === SEED_SKILL_AGENT_ID);
}

export interface SeedAssignment {
  id?: unknown;
  skillName?: unknown;
  skillRef?: unknown;
}

export interface SkillSeedIo {
  /** Read the seed Memory row. `ok:false` = the read FAILED (never "absent"). */
  readRow(): Promise<{ ok: true; row: SeedRowShape | null } | { ok: false }>;
  /** Read the org assignments named `using-flair`. `ok:false` = the read FAILED. */
  readAssignments(): Promise<{ ok: true; rows: SeedAssignment[] } | { ok: false }>;
  createRow(): Promise<void>;
  replaceRow(): Promise<void>;
  createAssignment(fields: { skillName: string; skillRef: string; priority: string }): Promise<SeedAssignment>;
}

export type SkillSeedOutcome =
  | { kind: "ok"; action: SeedAction; skillId: string; skillName: string; assignmentId: string; message: string }
  | { kind: "refused"; error: string; message: string };

/** Apply the seed rule over `io`. Never writes when a read failed. */
export async function runSkillSeed(
  io: SkillSeedIo,
  current: { name: string; content: string; hashes: readonly string[]; priority: string },
  log?: (message: string, detail: unknown) => void,
): Promise<SkillSeedOutcome> {
  const rowRead = await io.readRow();
  if (!rowRead.ok) {
    log?.("SkillSeed: the existing using-flair row could not be read; refusing the seed", {});
    return {
      kind: "refused",
      error: "skill_seed_read_failed",
      message:
        "the existing using-flair skill row could not be read, so the seed was refused (retry; if it persists, inspect the Memory table)",
    };
  }
  const stored = rowRead.row;
  if (stored && stored.agentId !== SEED_SKILL_AGENT_ID) {
    return {
      kind: "refused",
      error: "skill_seed_id_conflict",
      message: `Memory row "${SEED_SKILL_ID}" exists and is not the using-flair seed (owner ${String(stored.agentId)}); rename or remove it, then retry`,
    };
  }

  const assignRead = await io.readAssignments();
  if (!assignRead.ok) {
    log?.("SkillSeed: the existing using-flair assignment could not be read; refusing the seed", {});
    return {
      kind: "refused",
      error: "skill_seed_read_failed",
      message:
        "the existing using-flair org assignment could not be read, so the seed was refused (retry; if it persists, inspect the OrgSkillAssignment table)",
    };
  }

  const storedContent = typeof stored?.content === "string" ? (stored.content as string) : null;
  const action = decideSkillSeed(storedContent, current.content, current.hashes);
  if (action === "create") await io.createRow();
  else if (action === "replace") await io.replaceRow();

  let assignmentId: string;
  if (assignRead.rows.length === 0) {
    const created = await io.createAssignment({
      skillName: current.name,
      skillRef: SEED_SKILL_ID,
      priority: current.priority,
    });
    assignmentId = String(created?.id ?? "");
  } else {
    assignmentId = String(assignRead.rows[0].id ?? "");
  }

  const message =
    action === "create"
      ? `seeded the using-flair skill (${SEED_SKILL_ID}) and its org assignment`
      : action === "replace"
        ? `replaced the using-flair skill with the current shipped text (${SEED_SKILL_ID})`
        : action === "unchanged"
          ? `using-flair is already current (${SEED_SKILL_ID})`
          : `using-flair was edited by an operator; kept it unchanged (${SEED_SKILL_ID})`;

  return { kind: "ok", action, skillId: SEED_SKILL_ID, skillName: current.name, assignmentId, message };
}
