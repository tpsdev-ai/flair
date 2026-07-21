/**
 * abstention-no-per-principal-tripwire.test.ts — structural guard that the
 * flair#744 slice-2 abstention threshold is GLOBAL and can NEVER become
 * per-principal (Sherlock BINDING condition 2, #735-spirit zero-authority
 * spine).
 *
 * ─── The contract this enforces ────────────────────────────────────────────
 * A per-principal abstention threshold ("this principal's memories need higher
 * confidence to surface") would be an authority lever and would violate the
 * trust spine — the same discipline as the `claimed.*` guard (flair#735).
 * resources/abstention.ts is the decision core; the invariant is that it, and
 * every call site's abstention argument, consult ONLY a retrieval-confidence
 * number — never an agentId / principal / trust tier / any authority signal.
 *
 * This makes that structural, not just documented:
 *   1. abstention.ts (code, comments stripped) references NO authority token —
 *      it literally cannot read a principal to key a threshold on.
 *   2. The decision function takes exactly ONE input (the confidence number):
 *      there is no threshold parameter (so the floor can't be varied per call)
 *      and no principal parameter.
 *   3. At each recall call site (SemanticSearch.post / BootstrapMemories.post),
 *      the argument handed to `evaluateAbstention(` carries no authority token —
 *      it is fed a similarity, never an identity.
 *
 * ─── If this test fails ────────────────────────────────────────────────────
 * The abstention decision now touches a principal/tier/authority signal. The
 * threshold must stay a single global (or scope-wide) constant; abstention is a
 * recall-quality signal to the reader, never a per-principal access lever. See
 * flair#744 (Sherlock condition 2) and flair#735.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ABSTENTION_THRESHOLD,
  MODERATE_BAND,
  STRONG_BAND,
  evaluateAbstention,
  bestSemanticSimilarity,
} from "../../resources/abstention.ts";
import { classifyMatchQuality } from "../../resources/trust-block.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/**
 * Tokens that indicate a per-principal / authority signal. If any appears in
 * the abstention DECISION code (or in an abstention call's argument), the
 * threshold could be keyed on *who* authored a match rather than *how well* it
 * matched — the exact lever this guard forbids. Plain String.includes() over
 * STATIC literals (never a runtime-built RegExp — js/regex-injection, same
 * discipline as the sibling tripwires).
 */
const AUTHORITY_TOKENS = [
  "agentId",
  "authorId",
  "principal",
  "tier",
  "Tier",
  "defaultTrustTier",
] as const;

function stripComments(text: string): string {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  out = out.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
  return out;
}

interface Offense {
  line: number;
  token: string;
  excerpt: string;
}

function scanForAuthorityTokens(strippedLines: string[], rawLines: string[], startLine = 1): Offense[] {
  const offenses: Offense[] = [];
  for (let i = 0; i < strippedLines.length; i++) {
    for (const token of AUTHORITY_TOKENS) {
      if (strippedLines[i].includes(token)) {
        offenses.push({ line: startLine + i, token, excerpt: (rawLines[i] ?? "").trim() });
      }
    }
  }
  return offenses;
}

/** Extract one top-level `function <fnName>(` body via brace-matching. Throws
 *  loudly if the function was renamed/moved so a refactor can't disarm the
 *  guard (fix the marker, don't delete the check). Mirrors the sibling
 *  trust-block-zero-authority-tripwire's extractor. */
function extractFunctionBody(src: string, file: string, fnName: string): { text: string; startLine: number } {
  const marker = `function ${fnName}(`;
  const start = src.indexOf(marker);
  if (start === -1) {
    throw new Error(
      `abstention-no-per-principal-tripwire: expected to find "${marker}" in ${file} — has the band ` +
        `classifier been renamed or moved? Update this test's extraction target; do not delete the check ` +
        `(flair#744 confidence-band refinement).`,
    );
  }
  const braceStart = src.indexOf("{", start);
  let depth = 0;
  let i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  const startLine = src.slice(0, start).split("\n").length;
  return { text: src.slice(start, i), startLine };
}

describe("abstention no-per-principal tripwire (flair#744 Sherlock condition 2)", () => {
  it("resources/abstention.ts (code, comments stripped) references NO authority token", () => {
    const src = readFileSync(join(REPO_ROOT, "resources/abstention.ts"), "utf8");
    const stripped = stripComments(src).split("\n");
    const raw = src.split("\n");
    const offenses = scanForAuthorityTokens(stripped, raw);
    expect(
      offenses,
      offenses
        .map(
          (o) =>
            `resources/abstention.ts:${o.line} — authority token "${o.token}" in abstention decision code: ` +
            `${JSON.stringify(o.excerpt)}. The abstention threshold must be GLOBAL and read ONLY a confidence ` +
            `number — never a principal/tier. See flair#744 (Sherlock condition 2) and flair#735.`,
        )
        .join("\n"),
    ).toEqual([]);
  });

  it("the decision function takes exactly ONE input (a confidence number) — no threshold, no principal param", () => {
    // Arity 1 = there is no threshold parameter to vary per call/per principal
    // (the floor is always the module-global ABSTENTION_THRESHOLD) and no
    // identity parameter the outcome could branch on.
    expect(evaluateAbstention.length).toBe(1);
    expect(bestSemanticSimilarity.length).toBe(1);
  });

  it("ABSTENTION_THRESHOLD is a single global numeric constant", () => {
    expect(typeof ABSTENTION_THRESHOLD).toBe("number");
    expect(Number.isFinite(ABSTENTION_THRESHOLD)).toBe(true);
  });

  it.each([
    "resources/SemanticSearch.ts",
    "resources/MemoryBootstrap.ts",
  ])("%s feeds evaluateAbstention a confidence, never an authority signal", (file) => {
    const src = readFileSync(join(REPO_ROOT, file), "utf8");
    const stripped = stripComments(src);
    const marker = "evaluateAbstention(";
    // Every call site must exist (a rename must update this guard, not disarm
    // it) and hand in an argument with no authority token in its immediate
    // region.
    let idx = stripped.indexOf(marker);
    expect(idx, `${file}: expected a call to evaluateAbstention( — did the slice-2 wiring move? Update this guard, do not delete it.`).toBeGreaterThanOrEqual(0);
    while (idx !== -1) {
      const argStart = idx + marker.length;
      const argEnd = stripped.indexOf(")", argStart);
      const arg = stripped.slice(argStart, argEnd === -1 ? argStart : argEnd);
      for (const token of AUTHORITY_TOKENS) {
        expect(
          arg.includes(token),
          `${file}: evaluateAbstention(...) argument ${JSON.stringify(arg.trim())} contains authority token ` +
            `"${token}". The abstention decision must be fed a similarity/confidence, never an identity — a ` +
            `per-principal threshold is a hard no (flair#744 Sherlock condition 2, flair#735).`,
        ).toBe(false);
      }
      idx = stripped.indexOf(marker, argStart);
    }
  });
});

/**
 * ─── Band-classifier extension (flair#744 confidence-band refinement) ───────
 * `matchQuality` rides the SAME zero-authority spine as the abstention
 * threshold: the band classifier (resources/trust-block.ts's
 * classifyMatchQuality) must be GLOBAL and score-only — take exactly one numeric
 * input, reference no principal/tier, and read its cut-points from module-level
 * constants (never a per-principal config lookup). Per Sherlock's note on the
 * design, this guards BOTH the classifier function AND the band-boundary
 * constants: someone later reading the boundaries off a config/principal instead
 * of the module constants must trip this. A per-principal band would be an
 * authority lever — the same hard no as a per-principal abstention threshold.
 */
describe("band-classifier no-per-principal tripwire (flair#744 confidence-band refinement)", () => {
  it("classifyMatchQuality's body (resources/trust-block.ts, comments stripped) references NO authority token", () => {
    // Whole-file trust-block.ts legitimately mentions agentId (the `author`
    // field) and `tier` (in prose about the deferred field), so scan the
    // classifier's FUNCTION BODY only — that is the band decision, and it must
    // be number-in / band-out with no identity anywhere.
    const src = readFileSync(join(REPO_ROOT, "resources/trust-block.ts"), "utf8");
    const { text, startLine } = extractFunctionBody(src, "resources/trust-block.ts", "classifyMatchQuality");
    const stripped = stripComments(text).split("\n");
    const raw = text.split("\n");
    const offenses = scanForAuthorityTokens(stripped, raw, startLine);
    expect(
      offenses
        .map(
          (o) =>
            `resources/trust-block.ts:${o.line} — authority token "${o.token}" in classifyMatchQuality body: ` +
            `${JSON.stringify(o.excerpt)}. The confidence band must be GLOBAL and read ONLY a similarity ` +
            `number — never a principal/tier. See flair#744 (Sherlock) and flair#735.`,
        )
        .join("\n"),
    ).toBe("");
    expect(offenses).toEqual([]);
  });

  it("the classifier takes exactly ONE input (a similarity number) — no principal, no per-call threshold param", () => {
    // Arity 1 = no identity parameter the band could branch on, and no cut-point
    // parameter to vary per call/per principal (the cuts are module globals).
    expect(classifyMatchQuality.length).toBe(1);
  });

  it("the band cut-points are single global finite numeric constants", () => {
    for (const c of [ABSTENTION_THRESHOLD, MODERATE_BAND, STRONG_BAND]) {
      expect(typeof c).toBe("number");
      expect(Number.isFinite(c)).toBe(true);
    }
    // Ordered — abstention floor < breadcrumb/moderate cut < strong cut.
    expect(ABSTENTION_THRESHOLD).toBeLessThan(MODERATE_BAND);
    expect(MODERATE_BAND).toBeLessThan(STRONG_BAND);
  });

  it("the breadcrumb floor is the SHARED ABSTENTION_THRESHOLD constant, not a duplicate literal (Kern BINDING condition 1)", () => {
    // The classifier body must reference ABSTENTION_THRESHOLD directly (single
    // source of truth with the abstention floor) — so a future recalibration of
    // the abstention floor moves the breadcrumb floor with it, and can't drift.
    const src = readFileSync(join(REPO_ROOT, "resources/trust-block.ts"), "utf8");
    const { text } = extractFunctionBody(src, "resources/trust-block.ts", "classifyMatchQuality");
    const stripped = stripComments(text);
    expect(
      stripped.includes("ABSTENTION_THRESHOLD"),
      "classifyMatchQuality must reference the shared ABSTENTION_THRESHOLD constant as the breadcrumb floor " +
        "(imported from resources/abstention.ts), NOT a duplicate 0.15 literal (Kern BINDING condition 1).",
    ).toBe(true);
    // And it must NOT hard-code the abstention floor's current numeric value —
    // that would be the duplicate literal the single-source-of-truth rule forbids.
    expect(
      stripped.includes(String(ABSTENTION_THRESHOLD)),
      `classifyMatchQuality must not hard-code the abstention floor's literal value ` +
        `(${ABSTENTION_THRESHOLD}); reference the ABSTENTION_THRESHOLD constant instead (Kern BINDING condition 1).`,
    ).toBe(false);
  });
});

/**
 * ─── withSemSimilarity coupling (flair#744 refinement, Kern BINDING cond. 2) ─
 * matchQuality needs the result's `_semSimilarity` to classify, so a recall
 * wrapper that opts into the trust block MUST also turn on withSemSimilarity on
 * the retrieval call (previously gated on `abstain` alone). Guard it
 * structurally so the coupling can't silently regress into "trust block present
 * but every matchQuality null".
 */
describe("includeTrust ⇒ withSemSimilarity wiring (flair#744 refinement, Kern condition 2)", () => {
  it.each([
    "resources/SemanticSearch.ts",
    "resources/MemoryBootstrap.ts",
  ])("%s enables withSemSimilarity when includeTrust is requested", (file) => {
    const src = readFileSync(join(REPO_ROOT, file), "utf8");
    const stripped = stripComments(src);
    const marker = "withSemSimilarity:";
    const idx = stripped.indexOf(marker);
    expect(
      idx,
      `${file}: expected a withSemSimilarity: assignment on the retrieval call — did the wiring move? ` +
        `Update this guard, do not delete it (flair#744 refinement).`,
    ).toBeGreaterThanOrEqual(0);
    // Read the RHS up to end-of-line; it must depend on includeTrust (e.g.
    // `abstain || includeTrust`) so the trust block always has a signal to band.
    const eol = stripped.indexOf("\n", idx);
    const rhs = stripped.slice(idx + marker.length, eol === -1 ? undefined : eol);
    expect(
      rhs.includes("includeTrust"),
      `${file}: withSemSimilarity RHS ${JSON.stringify(rhs.trim())} must depend on includeTrust so a trust-block ` +
        `recall attaches _semSimilarity for matchQuality (Kern BINDING condition 2, flair#744 refinement).`,
    ).toBe(true);
  });
});
