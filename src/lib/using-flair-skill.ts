/**
 * using-flair-skill.ts — the shipped `using-flair` skill text (flair#2141 S2).
 *
 * Normal `flair init` ensures this skill's Memory row and org assignment.
 * Re-initializing an already-installed default local instance
 * with `flair init --skip-start` defers that to a later `flair start`
 * with the admin credential.
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
 * Pure constants + one hash function, no Harper import, so the seed decision is
 * unit-testable without a server.
 */
import { createHash } from "node:crypto";

/** The skill's Memory `metadata.name` and the org assignment's `skillName`. */
export const USING_FLAIR_SKILL_NAME = "using-flair";

/** The recall trigger — the "when to use" text a skill row embeds from. */
export const USING_FLAIR_SKILL_TRIGGER =
  "Use when you are about to store a durable decision, lesson, preference or fact, " +
  "recall prior context at session start or after a gap, or look up who is in the office.";

/** The procedure, separating current Flair behaviour from recommended practice. */
export const USING_FLAIR_SKILL_CONTENT = [
  "# Using Flair",
  "",
  "## Current Flair behavior",
  "",
  "### Durability and visibility",
  "- Memory supports `permanent`, `persistent`, `standard` (the default), and `ephemeral` durability. Ephemeral memory expires on a timer (24 hours by default), not at the end of a session.",
  "- permanent — routine maintenance never reaps or age-archives it (a writer-set validTo still archives it, as for every tier); it never decays and loads first in bootstrap.",
  "- persistent — routine maintenance never reaps or age-archives it (a writer-set validTo still archives it, as for every tier).",
  "- standard — routine maintenance archives it once its validTo passes or, as a session note, after 30 days.",
  "- ephemeral — routine maintenance reaps it once its TTL (24h by default) passes.",
  "- No tier adds a flush, fsync, backup or replica acknowledgement: an explicit delete (owner or admin) or a store failure can end any of them.",
  "- `permanent` and `persistent` default to `shared`; `standard` and `ephemeral` default to `private`.",
  "",
  "### Provenance",
  "- `Memory.post` and `Memory.put` refuse a non-admin write whose `agentId` names another principal; admins bypass this mismatch check.",
  "",
  "### Identity and office records",
  "- Your identity and standing instructions live in Soul. A bootstrap carries them when it is asked for soul (`includeSoul`) and when they fit its token budget.",
  "- `Agent` holds registered agent records with `kind`, `role`, and `status` fields. A Basic administrator need not have an Agent row, and an Agent record is not a promise that the principal is reachable.",
  "- Where a record exists, `Presence` uses `lastHeartbeatAt` to decide its `presenceStatus`. `activity` describes work; it is not a liveness verdict. A Presence record is not a guaranteed address.",
  "",
  "## Recommended practice",
  "",
  "### Writing and recall",
  "- Store a decision, lesson, preference, or fact that should outlive this session as one concise `content` string.",
  "- Use `permanent` for identity and long-lived facts, `persistent` for decisions and lessons, `standard` for ordinary working memory, and `ephemeral` for private scratch.",
  "- Set `visibility: \"shared\"` explicitly to share an ordinary working fact with teammates.",
  "- Write as yourself.",
  "- Confirm a write with the returned id and a short preview.",
  "- At session start, on resume, or after a long gap, load your bootstrap before answering from memory.",
  "- On a task switch, search memory from two or three angles before acting.",
  "- When a search surfaces a row you just wrote or a near-duplicate, update that row instead of adding another.",
  "",
  "### What not to store",
  "- Never store secrets: API keys, passwords, tokens, or key-file contents.",
  "- Never store another person's private data.",
  "",
  "### Identity",
  "- Set identity and standing instructions deliberately in Soul rather than leaving them to memory.",
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
