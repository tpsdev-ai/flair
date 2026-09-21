// Pure promotion policy shared by the CLI and trusted server workflow.
export function validatePromoteOpts(opts: { rationale?: string; to?: string; key?: string }): string | null {
  if (!opts.rationale || !opts.rationale.trim()) {
    return "--rationale is required (per spec § 5: no rubber-stamp)";
  }
  if (!opts.to || (opts.to !== "soul" && opts.to !== "memory")) {
    return "--to must be 'soul' or 'memory'";
  }
  if (opts.to === "soul" && (!opts.key || !opts.key.trim())) {
    return "--key is required when --to=soul (gives the Soul entry a meaningful identifier)";
  }
  return null;
}

export function validateRejectOpts(opts: { reason?: string }): string | null {
  if (!opts.reason || !opts.reason.trim()) {
    return "--reason is required";
  }
  return null;
}

/**
 * Decide whether a promote/reject action can proceed against a candidate's
 * current state, and what message to surface to the operator. Pure function;
 * action side effects happen in the CLI body after this returns ok.
 */
export function decideCandidateAction(
  candidate: { status?: string; target?: string; reviewerId?: string; decidedAt?: string } | null,
  action: "promote" | "reject",
): { ok: true } | { ok: false; severity: "error" | "info"; message: string } {
  if (!candidate) return { ok: false, severity: "error", message: "candidate not found" };
  const status = candidate.status;
  if (status === "promoted") {
    return action === "promote"
      ? { ok: false, severity: "error", message: `already promoted (target=${candidate.target}, reviewer=${candidate.reviewerId})` }
      : { ok: false, severity: "error", message: `already promoted; cannot reject after promotion` };
  }
  if (status === "rejected") {
    return action === "reject"
      ? { ok: false, severity: "info", message: `already rejected on ${candidate.decidedAt} by ${candidate.reviewerId}` }
      : { ok: false, severity: "error", message: `already rejected; use a fresh candidate or reset status manually` };
  }
  return { ok: true };
}

// ─── ADK tag-lineage on promote (#1205 slice 1205a — Sherlock security req) ───
// ADK session records are written by adk-flair (memory_service.py) under a
// SHARED-namespace agentId, with per-user separation carried ENTIRELY by a
// compound scope tag `adk:<app>:<user>`. That tag is the access-control
// boundary. A candidate distilled from those records therefore MUST carry the
// scope tag when promoted, or the promoted claim lands in the shared agentId
// memory retrievable by every other user of the app — a cross-user leak.
//
// `rem promote` historically hard-coded `["nightly-rem-promoted", from:<id>]`
// and DROPPED the source tag. We now propagate the source scope tag for
// ADK-sourced candidates, and FAIL CLOSED (refuse) when a candidate is
// ADK-sourced but its scope tag can't be uniquely+completely determined.
//
// SCOPING (deliberate, per spec): fail-closed applies ONLY to ADK-sourced
// candidates. Non-ADK candidates carry no `adk:` tag and promote byte-for-byte
// as before — a transient/deleted source on a non-ADK candidate must NOT block
// its promotion.
//
// SEAM (foundation only; the distillation engine is slice #1205b): ADK-sourcing
// is detected here by re-reading the candidate's source memories and inspecting
// their tags. That leaves ONE residual fail-open: an ADK-sourced candidate all
// of whose source memories are unreadable (deleted/transient) yields no `adk:`
// evidence and is treated as non-ADK. Closing that corner without regressing
// non-ADK promotion requires the ENGINE to stamp the authoritative scope tag
// onto the MemoryCandidate row at distillation time (it distills per single
// scope:tagged tag, so it knows it authoritatively). `derivePromotedTags` is
// written so that override can be threaded in later without touching callers.

export const ADK_SCOPE_TAG_PREFIX = "adk:";

export type SourceMemoryFetch =
  | { ok: true; tags: string[] } // source memory was read; these are its tags
  | { ok: false }; // source memory could not be read (missing/transient/authz)

export type PromotedTagsDecision =
  | { ok: true; tags: string[]; adkSourced: boolean }
  | { ok: false; reason: string };

/**
 * Decide the tag set for a promoted Memory given the candidate id and the
 * result of fetching each of its source memories. Pure — no I/O; the action
 * callback does the fetching and threads the results here so this is unit-
 * testable and the fail-closed logic is exercised directly.
 *
 * `stampedScopeTag` (#1205b-1 — the engine slice the #1205a SEAM note below
 * anticipated): the authoritative scope:"tagged" tag the distillation engine
 * stamped onto the MemoryCandidate row (resources/MemoryReflect.ts →
 * buildStagedCandidateRow). When present it is AUTHORITATIVE and short-circuits
 * the source re-read entirely — the engine distilled under exactly this one
 * tag, so it knows the per-user scope tag independent of whether the source
 * memories are still readable. This closes the residual fail-open the SEAM
 * note describes: a candidate all of whose sources are unreadable yields no
 * `adk:` evidence and would otherwise be mis-classified NON-ADK and promoted
 * tagless into the shared agentId namespace (a cross-user leak). Threading it
 * in as an optional trailing arg keeps every pre-#1205b caller (and every
 * candidate that never carried a stamp) on the unchanged source-re-read path.
 *
 * With NO stamp (undefined/empty) the source-re-read classification runs
 * exactly as in #1205a:
 *  - No `adk:` scope tag across readable sources → NON-ADK candidate; return
 *    the provenance tags only (unchanged behavior).
 *  - Exactly one `adk:` scope tag AND every source readable → ADK-sourced;
 *    return [scopeTag, ...provenance].
 *  - `adk:` evidence present but the scope tag is ambiguous (>1 distinct tag)
 *    OR incomplete (some source unreadable) → REFUSE (fail-closed): a
 *    tagless/mis-tagged claim in a shared ADK namespace is a cross-user leak,
 *    not a benign miss.
 */
export function derivePromotedTags(
  candidateId: string,
  sources: SourceMemoryFetch[],
  stampedScopeTag?: string | null,
): PromotedTagsDecision {
  const provenance = ["nightly-rem-promoted", `from:${candidateId}`];

  // #1205b-1: a stamped scope tag is AUTHORITATIVE — consume it directly, never
  // re-read sources. This is the seam closure: correctness no longer depends on
  // source readability. `adkSourced` (which gates the Soul-promotion refusal in
  // the promote action) tracks whether the stamped tag is an ADK scope tag.
  if (typeof stampedScopeTag === "string" && stampedScopeTag.length > 0) {
    return {
      ok: true,
      tags: [stampedScopeTag, ...provenance],
      adkSourced: stampedScopeTag.startsWith(ADK_SCOPE_TAG_PREFIX),
    };
  }

  const adkTags = new Set<string>();
  let anySourceUnreadable = false;
  for (const s of sources) {
    if (!s.ok) {
      anySourceUnreadable = true;
      continue;
    }
    for (const t of s.tags) {
      if (typeof t === "string" && t.startsWith(ADK_SCOPE_TAG_PREFIX)) adkTags.add(t);
    }
  }

  // No positive ADK evidence → non-ADK. An unreadable source with zero ADK
  // evidence does NOT fail closed here (that would regress non-ADK promotion);
  // see the SEAM note above.
  if (adkTags.size === 0) {
    return { ok: true, tags: provenance, adkSourced: false };
  }

  if (adkTags.size > 1) {
    return {
      ok: false,
      reason: `ADK-sourced candidate spans multiple scope tags (${[...adkTags].sort().join(", ")}); refusing to promote — a merged cross-user claim would leak across users`,
    };
  }
  if (anySourceUnreadable) {
    return {
      ok: false,
      reason: `ADK-sourced candidate has unreadable source memories; the per-user scope tag cannot be confirmed — refusing to promote (fail-closed)`,
    };
  }
  const scopeTag = [...adkTags][0];
  return { ok: true, tags: [scopeTag, ...provenance], adkSourced: true };
}

// ─── Promoted-row visibility (flair#1257 slice 3 — default-private-unless) ────
// Continuity-journal scope tag prefix. Canonical string duplicated in
// resources/memory-reflect-lib.ts / resources/auto-promote-lib.ts and
// packages/flair-mcp/src/continuity.ts — this file sits on the CLI side of the
// npm-packaging boundary (see this file's header) and cannot import them; kept
// in sync by the shared canonical string, same discipline as
// MACHINE_REVIEWER_* below.
export const CONTINUITY_SCOPE_TAG_PREFIX = "adk:continuity:";

/**
 * Decide a promoted Memory row's visibility for the HUMAN `rem promote` path
 * (flair#1257 slice 3). Mirror of resources/auto-promote-lib.ts
 * decidePromotedVisibility (the server-side auto-promote half) — Sherlock's
 * default-private-unless ruling covers BOTH promotion paths: the sources of a
 * continuity candidate are the most sensitive tier (ephemeral+private journal
 * rows), so leaving visibility unset here would let Memory's durability-keyed
 * default widen it to shared ("persistent" defaults shared) — a silent
 * visibility escalation. "shared" only when the candidate is continuity-scoped
 * AND carries the distiller's affirmative ruling WITH its recorded
 * team-relevance justification; every other case — including every
 * uncertainty — is "private".
 *
 * Returns undefined for NON-continuity candidates: their visibility behavior
 * (durability-keyed default) is byte-for-byte the pre-slice-3 contract and is
 * deliberately not changed here.
 */
export function derivePromotedVisibility(candidate: {
  scopeTag?: string | null;
  visibilityRuling?: string | null;
  visibilityRationale?: string | null;
}): "private" | "shared" | undefined {
  const scopeTag = candidate.scopeTag;
  const isContinuity =
    typeof scopeTag === "string" &&
    scopeTag.length > CONTINUITY_SCOPE_TAG_PREFIX.length &&
    scopeTag.startsWith(CONTINUITY_SCOPE_TAG_PREFIX);
  if (!isContinuity) return undefined;
  if (candidate.visibilityRuling !== "shared") return "private";
  const rationale = typeof candidate.visibilityRationale === "string" ? candidate.visibilityRationale.trim() : "";
  return rationale.length > 0 ? "shared" : "private";
}

// ─── Machine reviewer namespace (#1205 slice 1205a — Sherlock security req 4) ─
// A promotion records a reviewerId that feeds audit/attribution
// (schemas/memory.graphql:209). An automated (machine-driven) promotion path
// must record a reviewerId that can NEVER be mistaken for a human/agent
// reviewer, so attribution isn't laundered. Reserve the `machine:` namespace
// for that, and forbid the human `--reviewer` path from claiming it.

export const MACHINE_REVIEWER_PREFIX = "machine:";
/** Canonical machine reviewerId for the ADK auto-promote consumer (#1205b). */
export const MACHINE_REVIEWER_ADK_AUTO_PROMOTE = "machine:adk-auto-promote";

/** True iff `id` is in the reserved machine-reviewer namespace — i.e. it
 *  denotes an automated path, not a human or agent reviewer. */
export function isMachineReviewerId(id: string | undefined | null): boolean {
  return typeof id === "string" && id.startsWith(MACHINE_REVIEWER_PREFIX);
}

/** The human `flair rem promote` path must not record a reviewerId in the
 *  reserved machine namespace — that would launder automated attribution onto
 *  a human-operated promotion. Returns an error string, or null if allowed. */
export function validateHumanReviewerId(reviewerId: string): string | null {
  if (isMachineReviewerId(reviewerId)) {
    return `--reviewer '${reviewerId}' uses the reserved '${MACHINE_REVIEWER_PREFIX}' namespace (reserved for automated promotion); use a human/agent reviewer id`;
  }
  return null;
}

// ─── Structural-truncation signal (flair#1756 slice 2, #1776 slice 3) ────────
// The SINGLE definition of the structural-truncation signal. The GATE for it
// lives server-side in resources/auto-promote-lib.ts (decideAutoPromote — the
// UNATTENDED path), which IMPORTS these from here. The direction is deliberate
// and established in this repo: a server file may import a PURE helper from src/
// (resources/PromoteMemoryCandidate.ts and resources/soul-adk-guard.ts already
// import this very module); it is a CLI file importing FROM resources/ that does
// not survive npm packaging. Defining it here lets the CLI side
// (src/commands/rem.ts, `flair rem candidates`) and the server gate share ONE
// implementation rather than a hand-kept pair.
//
// Detects STRUCTURAL imbalance (unclosed/unmatched backtick, bracket, paren,
// brace) — NOT semantic completeness. A balanced claim can still be a fragment.
//
// The delimiter set is an ENUMERATED table (STRUCTURAL_PAIRS, below): the ASCII
// pairs `( )`, `[ ]`, `{ }` AND the full-width/CJK pairs
// `（）［］｛｝【】〔〕〖〗「」『』《》〈〉〘〙〚〛`. Both the opener set and the closer
// map are DERIVED from that one list, so a pair cannot be added to one side and
// missed on the other. The table IS the boundary: mathematical and ornamental
// brackets (`⟨⟩ ⟦⟧ ⌈⌉ ⌊⌋ ⁅⁆ ｟｠ ❨❩ ༺༻`) are deliberately EXCLUDED — they are used
// standalone in real text, so counting them by category would over-refuse. The
// set is deliberately NOT derived from Unicode general categories
// (`\p{Ps}` / `\p{Pe}`) and is NOT described as "Unicode-aware": category
// membership does not establish paired usage (Ogham `᚛` and bare `༺`/`༻`,
// `⸢`/`⸣`, `⌈`/`⌉` are permitted standalone by the core spec), and a category
// counter refuses ordinary COMPLETE prose — see the quotation-mark note
// immediately below. There is no vendored Unicode data and no codegen here.
//
// QUOTATION MARKS OF EVERY SCRIPT ARE OUT OF SCOPE. `“ ” ‘ ’ „ “ ‚ ‘ « »` are
// NOT counted, so a claim truncated mid-quotation is judged balanced. The reason
// is concrete, not a preference: U+201E `„` (and U+201A `‚`) is category Ps
// while its closing mark U+201C (U+2018) is Pi, so ANY category-based counter
// reports positive depth on the ordinary COMPLETE German quotation `„Fertig.“`
// and refuses it; and U+2019 `’` is the standard English apostrophe (category
// Pf), so a quote-counting leg refuses every English contraction (e.g. `isn’t`).
// Enumerating matched bracket pairs avoids both false positives. That is why
// categories were rejected in favour of this table.
//
// The check counts delimiters without interpreting context, so a complete claim
// that merely DISCUSSES an unmatched delimiter is also flagged/refused
// (fail-closed; nothing is lost — the candidate stays pending for the human
// `rem promote` path).
//
// Runtimes this signal was exercised against (2026-09-21): Node v22.22.1
// (process.versions.unicode = 17.0) and Bun 1.3.10 (process.versions.unicode =
// 15.1). Passing the check means NO DETECTED IMBALANCE for the enumerated
// pairs — never completeness, and never coverage of an unenumerated script.

// The one source of truth: [opener, closer]. The two lookups below are DERIVED,
// so there is no second hand-kept list that can drift out of step. All three are
// exported so the pair-table invariant can be pinned by a test without
// duplicating the list here.
export const STRUCTURAL_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["(", ")"], ["[", "]"], ["{", "}"],
  ["（", "）"], ["［", "］"], ["｛", "｝"],
  ["【", "】"], ["〔", "〕"], ["〖", "〗"],
  ["「", "」"], ["『", "』"],
  ["《", "》"], ["〈", "〉"], ["〘", "〙"], ["〚", "〛"],
];

export const STRUCTURAL_OPENERS: ReadonlyMap<string, string> = new Map(STRUCTURAL_PAIRS);
export const STRUCTURAL_CLOSERS: ReadonlyMap<string, string> = new Map(
  STRUCTURAL_PAIRS.map(([opener, closer]) => [closer, opener] as const),
);

/**
 * Return a description of the STRUCTURAL imbalance in `claim` (an unmatched or
 * closing-first bracket, an unclosed opener, or an odd number of backticks), or
 * null if it is balanced. The delimiter set is the ENUMERATED table above
 * (ASCII + full-width/CJK pairs); a delimiter outside that set — in particular a
 * quotation mark of any script — is not examined and does not make this
 * non-null. Pure. The description is for diagnostics only — it is NOT surfaced
 * as a claim about completeness.
 */
export function structuralImbalance(claim: string): string | null {
  const stack: string[] = [];
  for (const ch of claim) {
    if (STRUCTURAL_OPENERS.has(ch)) {
      stack.push(ch);
    } else {
      const opener = STRUCTURAL_CLOSERS.get(ch);
      if (opener !== undefined && stack.pop() !== opener) return `unmatched '${ch}'`;
    }
  }
  if (stack.length > 0) return `unclosed '${stack[stack.length - 1]}'`;
  if (((claim.match(/`/g) ?? []).length) % 2 !== 0) return "unbalanced backtick";
  return null;
}

/**
 * True iff `claim` ends with terminal punctuation (optionally followed by a
 * closing quote/bracket). This is a FLAG INPUT ONLY, never a refusal: plenty of
 * legitimate claims end without a full stop, and on the UNATTENDED path a false
 * refusal is silent. `flair rem candidates` surfaces it for the human reviewer.
 *
 * Terminators: ASCII `.` `!` `?` plus the full-width/CJK `。` (U+3002), `！`
 * (U+FF01), `？` (U+FF1F). The trailing-suffix class accepts the quote/bracket
 * closers it always did plus the enumerated bracket closers
 * `」』）］｝】〕〗》〉〙〛`. The single-dot leaders `…` `‥` `․` are deliberately NOT
 * terminators — they are not interchangeable with a full stop.
 */
export function hasTerminalPunctuation(claim: string): boolean {
  return /[.!?。！？]["')\]}»”’」』）］｝】〕〗》〉〙〛]*$/.test(claim.trimEnd());
}

