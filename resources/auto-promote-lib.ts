// ─── ADK auto-promote — pure policy for /AutoPromoteCandidates (#1205b-2) ─────
//
// The UNATTENDED promotion path. After the tag-aware nightly cycle (#1205b-1)
// stages per-user MemoryCandidates each carrying a `scopeTag`, this policy
// decides whether an ADK-sourced candidate may be auto-promoted to the user's
// OWN memory with NO human reviewer in the loop — replacing the human
// `rem promote` for this one narrow path.
//
// Because there is no human to catch a mistake, every one of Sherlock's four
// hard requirements is a load-bearing gate here (issue #1205 authz review):
//
//   Req 1 (memory-only, server-side): NOT decided here. The target is
//     hard-locked to `memory` STRUCTURALLY in resources/AutoPromoteCandidates.ts
//     — this lib has no notion of a target at all, so no value it returns can
//     ever route a write to Soul. Keeping the target out of the policy object is
//     the point: a policy field could be flipped; an absent one cannot.
//
//   Req 2 (tag lineage, FAIL-CLOSED): decideAutoPromote REFUSES any candidate
//     whose stamped `scopeTag` is absent/empty or not an `adk:` scope tag. A
//     tagless promoted claim lands in the SHARED agentId namespace and becomes
//     retrievable by every other user of the app (cross-user leak) — so a
//     missing scope tag is a hard STOP, never a benign "promote untagged". The
//     stamped scopeTag (resources/memory-reflect-lib.ts buildStagedCandidateRow)
//     is AUTHORITATIVE and consumed directly — we never re-read source memories
//     (the seam #1205b-1 closed).
//
//   Req 3 (content-safety, STRICT for the unattended path): the human gate was
//     also a content-safety gate. decideAutoPromote scans the claim through the
//     SAME scanFields path Memory.ts uses (content-safety.ts) and, unlike
//     Memory.ts's write scan, ALWAYS refuses a flagged claim regardless of
//     FLAIR_CONTENT_SAFETY — an unattended write must not silently promote a
//     prompt-injection payload merely because the instance runs in `warn` mode.
//
//   Req 4 (non-impersonating machine reviewerId): a promoted claim records
//     MACHINE_REVIEWER_ADK_AUTO_PROMOTE in the reserved `machine:` namespace, so
//     audit/attribution can never mistake an automated decision for a human or
//     agent reviewer.
//
// Pure and Harper-free (its only import, content-safety.ts, is pure regex), so
// the whole fail-closed/strict-safety decision is unit-testable directly with no
// Harper process — the same split resources/memory-reflect-lib.ts uses.

import { scanFields } from "./content-safety.js";

// ─── ADK scope tag (the per-user access-control boundary) ────────────────────
// adk-flair collapses (app, user) → ONE Flair agentId, separating users ONLY by
// a compound tag `adk:<app>:<user>`. That tag IS the access-control boundary, so
// an auto-promoted claim that does not carry it is a cross-user leak.
export const ADK_SCOPE_TAG_PREFIX = "adk:";

// ─── Machine reviewer namespace (Sherlock req 4) ─────────────────────────────
// A promotion records a reviewerId that feeds audit/attribution
// (schemas/memory.graphql). An automated path must record one that can NEVER be
// mistaken for a human/agent reviewer. Reserved `machine:` namespace; canonical
// id for this consumer is machine:adk-auto-promote.
//
// NOTE ON DUPLICATION: src/cli.ts declares its own copies of these constants
// (and validateHumanReviewerId, which refuses the reserved namespace on the
// HUMAN promote path). The two live on opposite sides of the npm-packaging
// boundary — src/ ships as the CLI bundle, resources/ ships as the Harper
// component, and cli.ts's own header notes imports across that boundary "don't
// survive npm packaging". They are kept in sync by the shared canonical string;
// there is no runtime path that imports one into the other.
export const MACHINE_REVIEWER_PREFIX = "machine:";
export const MACHINE_REVIEWER_ADK_AUTO_PROMOTE = "machine:adk-auto-promote";

/** Standard, honest rationale recorded on every auto-promoted claim + its
 *  candidate row, so the audit trail states plainly that no human reviewed it. */
export const AUTO_PROMOTE_RATIONALE =
  "auto-promoted from ADK session distillation (#1205) — unattended, own-memory only, scope-tag verified, content-safety scanned; no human reviewer";

/**
 * Per-call ceiling on auto-promotions (Kern's cost-ceiling note). Auto-promote
 * runs once per nightly cycle, not on every write, and each promotion is a
 * bounded DB write (plus at most one embedding compute on the Memory.put path),
 * so this caps the blast radius of a single cycle rather than throttling a hot
 * path. Overflow stays `pending` and is swept on subsequent cycles.
 */
export const DEFAULT_MAX_AUTO_PROMOTE_PER_CYCLE = 200;

/** Reason codes for a NON-promotion (recorded per-candidate for audit). Each is
 *  a deliberate fail-closed STOP, not an error — the candidate stays pending. */
export type AutoPromoteSkipReason =
  | "not_pending"          // already promoted/rejected (idempotency)
  | "no_adk_scope_tag"     // Req 2: absent/empty/non-adk stamped scopeTag → fail closed
  | "empty_claim"          // nothing to promote
  | `content_safety:${string}`; // Req 3: claim flagged by scanFields (flags appended)

export type AutoPromoteDecision =
  | { promote: true; scopeTag: string; reviewerId: string; rationale: string }
  | { promote: false; reason: AutoPromoteSkipReason };

/** The candidate fields this policy inspects. */
export interface AutoPromoteCandidateInput {
  status?: string;
  claim?: string;
  scopeTag?: string | null;
}

/**
 * Decide whether an ADK-sourced candidate may be auto-promoted to own memory.
 *
 * FAIL-CLOSED throughout: any condition that cannot be positively confirmed
 * results in `{ promote: false }` (the candidate is left pending for the human
 * `rem promote` path), never a promotion. This function decides ONLY whether to
 * promote and with what per-user scope tag / reviewer — never WHERE (the target
 * is memory-only and enforced structurally by the resource; see this file's
 * header, Req 1).
 */
export function decideAutoPromote(candidate: AutoPromoteCandidateInput): AutoPromoteDecision {
  // Idempotency (Kern 2d): only ever act on a still-pending candidate. A
  // re-run after a crash re-enumerates and skips anything already promoted.
  if (candidate.status !== "pending") {
    return { promote: false, reason: "not_pending" };
  }

  // Req 2 — tag lineage, FAIL CLOSED. Consume the stamped scopeTag directly
  // (authoritative; never re-read sources). Absent, empty, or non-`adk:` ⇒
  // refuse: a tagless claim in the shared agentId namespace is a cross-user
  // leak, and auto-promote is ONLY for ADK-sourced (scopeTag-bearing)
  // candidates — a non-ADK candidate still requires human `rem promote`.
  const scopeTag = candidate.scopeTag;
  if (typeof scopeTag !== "string" || !scopeTag.startsWith(ADK_SCOPE_TAG_PREFIX)) {
    return { promote: false, reason: "no_adk_scope_tag" };
  }

  const claim = candidate.claim;
  if (typeof claim !== "string" || claim.trim().length === 0) {
    return { promote: false, reason: "empty_claim" };
  }

  // Req 3 — content-safety, STRICT for the unattended path. Same scanFields the
  // Memory write path uses (content-safety.ts), but here a flag is ALWAYS a
  // refusal, independent of FLAIR_CONTENT_SAFETY: an unattended promotion must
  // never let a prompt-injection payload through merely because the instance is
  // in `warn` mode. (The Memory.put() write scan still runs on top of this as
  // defense-in-depth.)
  const safety = scanFields({ content: claim }, ["content"]);
  if (!safety.safe) {
    return { promote: false, reason: `content_safety:${safety.flags.join(",")}` };
  }

  return {
    promote: true,
    scopeTag,
    reviewerId: MACHINE_REVIEWER_ADK_AUTO_PROMOTE,
    rationale: AUTO_PROMOTE_RATIONALE,
  };
}

/** True iff `id` is in the reserved machine-reviewer namespace (an automated
 *  path, never a human/agent reviewer). Mirror of src/cli.ts isMachineReviewerId
 *  on the resources side of the packaging boundary. */
export function isMachineReviewerId(id: string | undefined | null): boolean {
  return typeof id === "string" && id.startsWith(MACHINE_REVIEWER_PREFIX);
}

// ─── Promoted-row visibility (flair#1257 slice 3 — default-private-unless) ────
// Continuity-journal scope tag prefix. Canonical string duplicated in
// resources/memory-reflect-lib.ts (CONTINUITY_SCOPE_TAG_PREFIX), packages/
// flair-mcp/src/continuity.ts (the writer) and src/rem/runner.ts — kept in
// sync by the shared canonical string across the npm-packaging boundaries
// (same discipline as MACHINE_REVIEWER_* above).
export const CONTINUITY_SCOPE_TAG_PREFIX = "adk:continuity:";

/** True iff `tag` is a continuity-journal scope tag (non-empty sessionId
 *  component — the bare prefix is not a session). */
export function isContinuityScopeTag(tag: string | null | undefined): boolean {
  return typeof tag === "string" && tag.length > CONTINUITY_SCOPE_TAG_PREFIX.length && tag.startsWith(CONTINUITY_SCOPE_TAG_PREFIX);
}

/** The candidate fields the visibility decision inspects (flair#1257 slice 3). */
export interface PromotedVisibilityCandidateInput {
  scopeTag?: string | null;
  visibilityRuling?: string | null;
  visibilityRationale?: string | null;
}

/**
 * Decide a promoted Memory row's visibility (Sherlock's ruling, flair#1257
 * slice 3): **default-private-unless**. Promotion is a visibility ESCALATION
 * from the most sensitive tier (the sources are ephemeral+private journal
 * rows, or standard+private session episodes), so the DEFAULT — including
 * every uncertainty fallback — is "private". "shared" is returned ONLY when
 * ALL of:
 *
 *   1. the candidate is CONTINUITY-scoped (scopeTag `adk:continuity:*`).
 *      ADK per-user candidates (`adk:<app>:<user>`) are ALWAYS private —
 *      their per-user isolation is client-side tag re-verification that
 *      other agents don't run, so a shared ADK promotion leaks a user's
 *      distilled private data org-wide (the #1205b-2 safety argument). No
 *      ruling can override that; and
 *   2. the distiller AFFIRMATIVELY ruled "shared" (visibilityRuling —
 *      stamped at staging only when the model emitted an explicit shared
 *      ruling, resources/memory-reflect-lib.ts); and
 *   3. a non-empty team-relevance justification is recorded on the candidate
 *      (visibilityRationale). A shared ruling without its justification is
 *      not affirmative — it decays to private, fail-closed.
 *
 * So a shared promoted row always traces to a recorded justification on its
 * candidate — never to a default, never silently.
 */
export function decidePromotedVisibility(candidate: PromotedVisibilityCandidateInput): "private" | "shared" {
  if (!isContinuityScopeTag(candidate.scopeTag)) return "private";
  if (candidate.visibilityRuling !== "shared") return "private";
  const rationale = typeof candidate.visibilityRationale === "string" ? candidate.visibilityRationale.trim() : "";
  if (rationale.length === 0) return "private";
  return "shared";
}

/**
 * The tag set for an auto-promoted Memory. The per-user `scopeTag` MUST come
 * first and is load-bearing — it is the access-control boundary that keeps the
 * promoted claim visible only to its own user's tag filter. `auto-promoted`
 * marks the whole class as machine-written so every auto-promoted claim is
 * identifiable and bulk-removable if the policy is ever rolled back (Kern 2b);
 * `nightly-rem-promoted` matches the human promote path; `from:<id>` preserves
 * candidate lineage.
 */
export function buildAutoPromotedTags(candidateId: string, scopeTag: string): string[] {
  return [scopeTag, "nightly-rem-promoted", "auto-promoted", `from:${candidateId}`];
}
