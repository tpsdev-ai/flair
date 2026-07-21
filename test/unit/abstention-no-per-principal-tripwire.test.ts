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
  evaluateAbstention,
  bestSemanticSimilarity,
} from "../../resources/abstention.ts";

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
