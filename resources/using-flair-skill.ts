/**
 * using-flair-skill.ts — the shipped `using-flair` skill text (flair#2141 S2).
 *
 * ONE reviewed text, reconciled from the flair best-practices guidance and the
 * cursor-flair skills (remember, bootstrap, coordinate, soul). It covers when
 * to write and at what durability, provenance, recall habits, what not to
 * store, identity, and how to find teammates. Since item 3 (a directory tool)
 * has not landed, the teammates part points at the Agent/Presence records.
 *
 * The text is code: it is reviewed like any other file, it carries a content
 * hash, and the shipped-hash list below is the record of every version this
 * repo has ever shipped. `resources/SkillSeed.ts` (the installer) and
 * `resources/skill-seed.ts` (the decision) read them.
 *
 * Pure constants + one hash function, no Harper import, so the seed decision is
 * unit-testable without the runtime.
 */
import { createHash } from "node:crypto";

/** The skill's Memory `metadata.name` and the org assignment's `skillName`. */
export const USING_FLAIR_SKILL_NAME = "using-flair";

/** The recall trigger — the "when to use" text a skill row embeds from. */
export const USING_FLAIR_SKILL_TRIGGER =
  "Use when you are about to store a durable decision, lesson, preference or fact, " +
  "recall prior context at session start or after a gap, or find a teammate.";

/** The procedure. Each line states current Flair behaviour. */
export const USING_FLAIR_SKILL_CONTENT = [
  "# Using Flair",
  "",
  "## When to write, and at what durability",
  "- Store a decision, lesson, preference, or fact that should outlive this session: one concise `content` string.",
  "- `permanent` for identity and never-forget facts; `persistent` for decisions and lessons; `standard` (the default) for ordinary working memory; `ephemeral` for this-session scratch.",
  "- `permanent` and `persistent` default to `shared`; `standard` and `ephemeral` default to `private`. Set `visibility: \"shared\"` explicitly to share an ordinary working fact with teammates.",
  "",
  "## Provenance",
  "- Write as yourself: the server stamps the author from your signed key, never from the request body. Do not claim another agent's id.",
  "- Confirm a write with the returned id and a short preview.",
  "",
  "## Recall habits",
  "- At session start, on resume, or after a long gap, load your bootstrap (soul plus memories) before answering from memory.",
  "- On a task switch, search memory from two or three angles before acting.",
  "- When a search surfaces a row you just wrote or a near-duplicate, update that row instead of adding another.",
  "",
  "## What not to store",
  "- Never store secrets: API keys, passwords, tokens, or key-file contents.",
  "- Never store another person's private data.",
  "",
  "## Identity",
  "- Your identity and standing instructions live in Soul, and ride in every bootstrap. Set them deliberately rather than leaving them to memory.",
  "",
  "## Finding teammates",
  "- Read the `Agent` table for who is in this office: one row per principal, with `kind`, `role`, and `status`.",
  "- Read `Presence` for who is live: `lastHeartbeatAt` and `activity` for each agent.",
  "- A directory tool that answers \"who is here and how do I reach them\" in one call is planned; until then those two records are the answer.",
].join("\n");

/** sha256 of a skill row's `content` — the value the shipped-hash list holds. */
export function usingFlairSkillHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * The hashes of every `using-flair` text this repository has shipped. A stored
 * row whose content hash is in this list is an UNEDITED shipped version, so an
 * installer may replace it; a hash that is not in the list is an operator edit,
 * which is left alone. Append a new hash here whenever the text above changes.
 */
export const USING_FLAIR_SHIPPED_HASHES: readonly string[] = Object.freeze([
  usingFlairSkillHash(USING_FLAIR_SKILL_CONTENT),
]);

/** The current shipped content's hash. */
export const USING_FLAIR_CURRENT_HASH = usingFlairSkillHash(USING_FLAIR_SKILL_CONTENT);
