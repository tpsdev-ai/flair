/**
 * skill-write.ts — the WRITE-side skill policy (flair#1542 components 1-3).
 *
 * A skill is a Memory tagged "skill" (reuse the substrate — no new table).
 * This module centralizes the three write-side rules that make a skill-tagged
 * Memory behave like a skill:
 *
 *   1. Embedding source: a skill-tagged row embeds from `trigger` (the
 *      "when to use" text), NOT from `content` (the full procedure). The
 *      recall signal is "when does this skill apply", so the vector must
 *      represent the trigger. Non-skill rows are untouched — `skillEmbedText`
 *      returns `content` for them, byte-identical to the pre-slice behavior.
 *
 *   2. SkillScan gate: every skill-tagged write is statically scanned
 *      (resources/scan/skill-scanner.ts) BEFORE the embedding is computed.
 *      Fail-closed on high/critical risk (a rejected write pays no embed);
 *      allow-with-flag on medium (the findings are recorded on the row's
 *      `_safetyFlags` so the write is auditable, but it is not blocked).
 *
 *   3. Forced durability: a skill MUST be durability=persistent. The 30-day
 *      reaper would archive a default-written ("standard") skill, and an
 *      ephemeral/session skill is a contradiction in terms — ephemeral/session
 *      are rejected outright, and every other value is forced to "persistent".
 *
 * Deliberately ZERO Harper imports — pure functions + constants, so the
 * coverage-gate test and unit tests can import this module without the
 * runtime (same load-bearing reason as memory-durability.ts /
 * memory-visibility.ts).
 */

import { scanSkillContent } from "./scan/skill-scanner.js";

/** The tag that marks a Memory as a skill. */
export const SKILL_TAG = "skill";

/** Is this write a skill-tagged Memory? */
export function isSkillWrite(content: any): boolean {
  return Array.isArray(content?.tags) && content.tags.includes(SKILL_TAG);
}

/**
 * The text a row embeds from. Skill-tagged rows embed from `trigger` (the
 * recall signal); every other row embeds from `content`. Returns `undefined`
 * only when there is no usable text at all.
 */
export function skillEmbedText(content: any): string | undefined {
  if (isSkillWrite(content) && typeof content.trigger === "string" && content.trigger.length > 0) {
    return content.trigger;
  }
  return content.content;
}

/**
 * Force a skill-tagged write to durability=persistent. Rejects an explicit
 * ephemeral/session durability (a skill that expires is a contradiction);
 * every other value — including the "standard" default and "permanent" — is
 * forced to "persistent" so the 30-day reaper never archives a skill.
 *
 * Returns a 400 Response to short-circuit the write, or null to proceed.
 * `content.durability` is mutated to "persistent" on the proceed path.
 */
export function enforceSkillDurability(content: any): Response | null {
  if (!isSkillWrite(content)) return null;
  const d = content.durability;
  if (d === "ephemeral" || d === "session") {
    return new Response(
      JSON.stringify({
        error: "skill_durability",
        message: "skill memories must be durability=persistent; ephemeral/session rejected",
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
  content.durability = "persistent";
  return null;
}

/**
 * Reject a skill-tagged write on a path that does NOT run the SkillScan gate
 * or forced durability (patch, seed, etc.). Skills are written ONLY via
 * skill_store (→ Memory.post) or Memory.put — every other verb rejects a
 * skill-tagged write rather than land it unscanned (the #1537 raw-writer
 * lesson: gate EVERY verb, not just post/put).
 *
 * Returns a 400 Response to short-circuit the write, or null to proceed.
 */
export function rejectSkillWritePath(content: any): Response | null {
  if (!isSkillWrite(content)) return null;
  return new Response(
    JSON.stringify({
      error: "skill_write_path",
      message: "skill memories must be written via skill_store (or Memory post/put); this path does not gate skill writes",
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

/**
 * SkillScan gate — run BEFORE the embedding is computed. Scans the combined
 * `trigger` + `content` text (a dangerous shell/network payload in EITHER is
 * a rejection). Fail-closed on high/critical risk; allow-with-flag on medium
 * (findings appended to `_safetyFlags`); a clean scan is a no-op.
 *
 * Returns a 400 Response to short-circuit the write, or null to proceed.
 */
export function skillScanGate(content: any): Response | null {
  if (!isSkillWrite(content)) return null;
  const parts = [content.trigger, content.content].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  if (parts.length === 0) return null;

  const result = scanSkillContent(parts.join("\n\n"));

  if (result.riskLevel === "high" || result.riskLevel === "critical") {
    return new Response(
      JSON.stringify({
        error: "skill_scan_rejected",
        riskLevel: result.riskLevel,
        violations: result.violations,
        message: "skill content failed SkillScan (fail-closed on high/critical risk)",
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  if (result.riskLevel === "medium") {
    // allow-with-flag: record the findings so the write is auditable, but do
    // not block it. `_safetyFlags` is the existing content-safety flag column;
    // skill findings are namespaced `skill:<type>` so they never collide with
    // the content-safety flags that may already be present.
    const flags = result.violations.map((v) => `skill:${v.type}`);
    const existing = Array.isArray(content._safetyFlags) ? content._safetyFlags : [];
    content._safetyFlags = [...existing, ...flags];
  }

  return null;
}
