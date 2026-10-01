/**
 * using-flair-skill.ts — the shipped `using-flair` skill text (flair#2141 S2).
 *
 * Normal `flair init` writes this text as one skill-tagged Memory row and an
 * org assignment; local `--skip-start` on the default install defers that
 * write until `flair start`.
 * Re-runs preserve edited text. An eligible agent's bootstrap may list it when
 * the assignment wins same-name conflict resolution and fits the budget.
 *
 * ONE reviewed text, reconciled from the flair best-practices guidance and the
 * cursor-flair skills (remember, bootstrap, coordinate, soul). It covers when to
 * write and at what durability, provenance, recall habits, what not to store,
 * identity, and where the Agent and Presence records describe the office.
 *
 * The text is code: it is reviewed like any other file, it carries a content
 * hash, and the shipped-hash list below is the record of every version this
 * repo has ever shipped. `src/lib/skill-seed.ts` (the decision and the write)
 * reads them.
 *
 * Pure constants + one hash function, no runtime import, so the seed decision is
 * unit-testable without a server.
 */
import { createHash } from "node:crypto";

/** The skill's Memory `metadata.name` and the org assignment's `skillName`. */
export const USING_FLAIR_SKILL_NAME = "using-flair";

/** The recall trigger — the "when to use" text a skill row embeds from. */
export const USING_FLAIR_SKILL_TRIGGER =
  "Use when you are about to store a durable decision, lesson, preference or fact, " +
  "recall prior context at session start or after a gap, or look up who is in the office.";

/** The procedure. Each line states current Flair behaviour. */
export const USING_FLAIR_SKILL_CONTENT = [
  "# Using Flair",
  "",
  "## When to write, and at what durability",
  "- Store a decision, lesson, preference, or fact that should outlive this session: one concise `content` string.",
  "- `permanent` for identity and never-forget facts; `persistent` for decisions and lessons; `standard` (the default) for ordinary working memory; `ephemeral` for private scratch that expires on a timer (24 hours by default), not at the end of a session.",
  "- `permanent` and `persistent` default to `shared`; `standard` and `ephemeral` default to `private`. Set `visibility: \"shared\"` explicitly to share an ordinary working fact with teammates.",
  "",
  "## Provenance",
  "- Write as yourself: a row's provenance records the principal id the request authenticated as. Flair refuses a non-admin write whose `agentId` names another principal; an admin's write is not checked against `agentId`.",
  "- Confirm a write with the returned id and a short preview.",
  "",
  "## Recall habits",
  "- At session start, on resume, or after a long gap, load your bootstrap before answering from memory.",
  "- On a task switch, search memory from two or three angles before acting.",
  "- When a search surfaces a row you just wrote or a near-duplicate, update that row instead of adding another.",
  "",
  "## What not to store",
  "- Never store secrets: API keys, passwords, tokens, or key-file contents.",
  "- Never store another person's private data.",
  "",
  "## Identity",
  "- Your identity and standing instructions live in Soul. A bootstrap carries them when it is asked for soul (`includeSoul`) and when they fit its token budget; set them deliberately rather than leaving them to memory.",
  "",
  "## Finding teammates",
  "- Read the `Agent` table for who is in this office: one row per principal, with `kind`, `role`, and `status` fields. A record identifies a principal; it is not a promise that the principal is reachable.",
  "- Read `Presence` for who is live where a record exists: `lastHeartbeatAt` and `activity` report liveness, not a guaranteed address.",
].join("\n");

/** sha256 of a skill row's `content` — the value the shipped-hash list holds. */
export function usingFlairSkillHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * The hashes of every `using-flair` text this repository has shipped. A stored
 * row whose content hash is in this list holds text that matches a listed
 * shipped version, so the installer may replace it; any other text is left
 * alone. (A hash does not identify who wrote the text.) Append a new hash here
 * whenever the text above changes.
 */
export const USING_FLAIR_SHIPPED_HASHES: readonly string[] = Object.freeze([
  usingFlairSkillHash(USING_FLAIR_SKILL_CONTENT),
]);

/** The current shipped content's hash. */
export const USING_FLAIR_CURRENT_HASH = usingFlairSkillHash(USING_FLAIR_SKILL_CONTENT);
