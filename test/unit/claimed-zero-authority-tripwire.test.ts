/**
 * claimed-zero-authority-tripwire.test.ts — structural guard that
 * `provenance.claimed.*` (`claimed.model`, `claimed.client`) never enters an
 * authority decision (flair#735, follow-up to #718).
 *
 * ─── The contract this enforces ────────────────────────────────────────────
 * `resources/provenance.ts`'s `buildProvenance()` stamps an OPTIONAL,
 * UNVERIFIED `claimed` sub-object onto every write's `provenance` blob —
 * self-reported by the (already-authenticated) caller, never independently
 * corroborated. Sherlock's flair#718 binding refinement: `claimed.*` MUST
 * grant zero authority anywhere — never read for read-scope resolution,
 * attribution stamping, dedup matching, or usage counting. Today that's
 * enforced only by field-naming convention (`claimed` vs. `verified`) and
 * code review. This test makes it a structural, CI-enforced invariant: it
 * fails the build the moment any of the modules below reads a `claimed.*`
 * token, instead of relying on every future reviewer to remember the rule.
 *
 * ─── Scan targets, and why each is an authority-decision site ─────────────
 * Chosen by reading the code, not by the letter of the originating issue —
 * see the "deviations" note below for the one place actual code diverged
 * from the issue's suggested list.
 *
 *   1. resources/record-type-kit.ts (WHOLE FILE) — the shared read-scope
 *      (`resolveAuthGate`/`makeReadScope`/`makeByIdReadGate`) and no-forge
 *      attribution (`stampAttribution`) machinery composed by Memory,
 *      Relationship, WorkspaceState, OrgEvent, and Soul. Every non-owner
 *      read-scope decision and every write-attribution decision for those
 *      five tables funnels through this one module.
 *   2. resources/memory-read-scope.ts (WHOLE FILE) — the ONE function
 *      (`resolveReadScope`) every cross-agent Memory read path (Memory.ts,
 *      SemanticSearch.ts, MemoryBootstrap.ts, auth-middleware.ts) resolves
 *      its read-scope through, per that module's own header. Centralized
 *      specifically so the read-scope rule can't drift per-path — the exact
 *      kind of chokepoint this guard needs to watch.
 *   3. resources/Memory.ts, SCOPED to `findConservativeDedupMatch` and
 *      `runDedupGate` ONLY — the dedup-match gate that decides whether a new
 *      write collides with an existing memory. Deliberately NOT a whole-file
 *      scan: Memory.ts's post()/put() ALSO legitimately reference
 *      `claimedClient` (`delete content.claimedClient` after folding it into
 *      `buildProvenance`'s output) as part of the write-time provenance
 *      STAMP — that's `claimed.*` being constructed, already reviewed and
 *      approved under flair#718, not an authority decision. A whole-file
 *      scan would permanently false-positive on that legitimate code, which
 *      is exactly the "false positive from a legitimate display/
 *      serialization-adjacent path" the originating issue warned about.
 *      Function-level extraction (source-text slice, brace-matched — see
 *      extractFunctionBody below) keeps the guard scoped to the actual
 *      decision code without needing a comment-only exemption to compensate.
 *   4. resources/RecordUsage.ts (WHOLE FILE) — DEVIATION from the issue's
 *      suggested list (which named "usage-count logic in Memory.ts"):
 *      reading the code shows `Memory.usageCount` is a passive field with NO
 *      special-case logic inside Memory.ts itself. The actual usage-count
 *      AUTHORITY decision — the only writer of `usageCount`, the anti-gaming
 *      dedup ledger, the ranking-affecting bump that feeds `scoring.ts`'s
 *      `usageBoost` — lives entirely in `POST /RecordUsage`
 *      (resources/RecordUsage.ts). That is the real usage-count decision
 *      site, so that's what this guard scans instead of a Memory.ts region
 *      that doesn't exist.
 *   5. resources/mcp-handler.ts (WHOLE FILE) — auth resolution for the
 *      native `/mcp` OAuth path: `resolveAgentFromSub` / `jitProvisionPrincipal`
 *      / `isAgentAdmin` / `handleToolCall`'s sub→agent dispatch. This is the
 *      sole place that turns a verified token into a scoped flair identity
 *      for every MCP tool call — if `claimed.*` ever leaked into WHO a call
 *      is attributed to, it would start here.
 *
 * ─── Explicitly OUT of scope, and why (so a reviewer doesn't wonder) ──────
 *   - resources/provenance.ts: this is WHERE `claimed.*` is legitimately
 *     CONSTRUCTED from write-body input (`sanitizeClaim`, `buildProvenance`).
 *     Scanning it would be a guaranteed permanent failure of a file that is
 *     the write-time contract itself, not an authority-decision consumer.
 *   - resources/Relationship.ts's identical write-stamp site (same shape as
 *     Memory.ts's, per the relationship-write-path spec's "reuse
 *     buildProvenance as-is" contract) — same reasoning as Memory.ts's
 *     post()/put(), and Relationship.ts has no dedup/usage-count logic to
 *     scope down to.
 *   - resources/mcp-tools.ts — where the VERIFIED `client_id` (already
 *     resolved by mcp-handler.ts) gets threaded into `claimedClient` on
 *     write-tool bodies (`memory_store`/`memory_update`). This mirrors
 *     Memory.ts's write-stamp site: constructing the claim, not consuming it
 *     for a decision.
 *
 * ─── Comment handling (pick ONE approach — this file EXEMPTS comments) ────
 * Both `/* * /` block and `// ` line comments are stripped before scanning.
 * Chosen because at least two of the scanned files carry LEGITIMATE doc
 * comments that mention the tokens below in prose (Memory.ts's write-stamp
 * doc references `claimed.client`/`claimedClient`; mcp-handler.ts's
 * `resolveAgentFromSub` doc references `claimedClient` to explain where its
 * resolved `clientId` eventually feeds). Flagging those would make the
 * guard fire on documentation instead of code, training reviewers to
 * ignore it. Comment-stripping preserves newlines (blanks out characters,
 * never removes them) so line numbers in failure messages still match the
 * real file — see stripComments() below.
 *
 * ─── CodeQL js/regex-injection note ────────────────────────────────────────
 * This repo has been burned twice on `new RegExp(...)` built from a runtime
 * string (see mcp-surface-tripwire.test.ts's header). Every regex below is a
 * STATIC LITERAL (comment-stripping only) — token matching itself uses plain
 * `String.prototype.includes()`, never a dynamically-constructed pattern.
 *
 * ─── If this test fails ────────────────────────────────────────────────────
 * A scanned authority module now references `claimed.*` provenance data. If
 * this is a genuine display/serialization/logging path, move it OUT of the
 * authority module (or out of the scanned region) — it does not belong
 * interleaved with scope/attribution/dedup/usage-count logic even when it
 * doesn't currently influence the decision, because the next edit might
 * make it. If it's an actual decision reading `claimed.*`, that is exactly
 * the bug flair#735 exists to catch: `claimed.*` is self-reported and
 * unverified and MUST NOT influence read-scope, attribution, dedup, or
 * usage-count outcomes anywhere. See flair#735 and Sherlock's flair#718
 * design review for the full rationale.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/**
 * Plain-string tokens that indicate a READ of `claimed.*` provenance data or
 * the write-body-only `claimedClient`/`claimedModel` passthrough fields (see
 * resources/provenance.ts). `.claimed` alone (a bare property-access dot)
 * catches ANY variable name holding a parsed provenance object
 * (`provenance.claimed`, `parsed.claimed`, `p?.claimed`, etc.) — the
 * `claimed.client`/`claimed.model` and bracket-notation forms are additional
 * explicit coverage for shapes that wouldn't otherwise match. Deliberately
 * NOT a bare `"claimed"` token: that would also match unrelated English
 * prose/identifiers (e.g. a future `unclaimed`/`reclaimed` field) with no
 * connection to this provenance contract.
 */
const CLAIMED_ACCESS_TOKENS = [
  "claimedClient",
  "claimedModel",
  "claimed.client",
  "claimed.model",
  ".claimed",
  '["claimed"]',
  "['claimed']",
] as const;

/**
 * Blank out comment CONTENT (replace non-newline characters with spaces) so
 * doc comments don't trip the token scan below, while every surviving
 * character keeps its original line number — failure messages report real,
 * clickable "file:line" locations. Static regex literals only (see file
 * header's CodeQL note): never `new RegExp(...)` built from a variable.
 */
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

/** Scan (comment-stripped) `text`, whose first line is `startLine` in the
 *  real file, for every CLAIMED_ACCESS_TOKENS occurrence. */
function findOffenses(text: string, startLine: number): Offense[] {
  const strippedLines = stripComments(text).split("\n");
  const rawLines = text.split("\n");
  const offenses: Offense[] = [];
  for (let i = 0; i < strippedLines.length; i++) {
    for (const token of CLAIMED_ACCESS_TOKENS) {
      if (strippedLines[i].includes(token)) {
        offenses.push({ line: startLine + i, token, excerpt: (rawLines[i] ?? "").trim() });
      }
    }
  }
  return offenses;
}

/**
 * Extract one top-level `function <fnName>(` declaration's full body from
 * `src` via brace-matching (naive character-count, no string/template-
 * literal awareness — sufficient for the two specific functions this test
 * extracts; see the header for why Memory.ts is scoped this way instead of
 * whole-file). Throws loudly (rather than silently scanning nothing) if the
 * function has been renamed or moved, so a refactor can't quietly disarm
 * this guard — fix the marker below, don't delete the check.
 */
function extractFunctionBody(src: string, fnName: string): { text: string; startLine: number } {
  const marker = `function ${fnName}(`;
  const start = src.indexOf(marker);
  if (start === -1) {
    throw new Error(
      `claimed-zero-authority-tripwire: expected to find "${marker}" in resources/Memory.ts — ` +
        `has the dedup gate been renamed or moved? Update this test's extraction target to match; ` +
        `do not delete the check (flair#735).`,
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

interface ScanTarget {
  /** Repo-relative path, used both to load the file and in messages. */
  file: string;
  /** Human label identifying the specific region scanned within the file. */
  label: string;
  /** One-line justification: why this is an authority-decision site. */
  why: string;
  /** Extracts the region to scan (whole file, or a function body slice). */
  extract: (src: string) => { text: string; startLine: number };
}

const wholeFile = (src: string) => ({ text: src, startLine: 1 });

const SCAN_TARGETS: ScanTarget[] = [
  {
    file: "resources/record-type-kit.ts",
    label: "record-type-kit.ts (whole file)",
    why: "shared read-scope (resolveAuthGate/makeReadScope/makeByIdReadGate) + no-forge attribution (stampAttribution) for Memory/Relationship/WorkspaceState/OrgEvent/Soul",
    extract: wholeFile,
  },
  {
    file: "resources/memory-read-scope.ts",
    label: "memory-read-scope.ts (whole file)",
    why: "the ONE resolveReadScope() every cross-agent Memory read path resolves its scope through",
    extract: wholeFile,
  },
  {
    file: "resources/Memory.ts",
    label: "Memory.ts:findConservativeDedupMatch",
    why: "the dedup-match gate — decides whether a write collides with an existing memory",
    extract: (src) => extractFunctionBody(src, "findConservativeDedupMatch"),
  },
  {
    file: "resources/Memory.ts",
    label: "Memory.ts:runDedupGate",
    why: "wraps findConservativeDedupMatch for the create-shaped write path",
    extract: (src) => extractFunctionBody(src, "runDedupGate"),
  },
  {
    file: "resources/RecordUsage.ts",
    label: "RecordUsage.ts (whole file)",
    why: "the actual usage-count authority: the ONLY writer of Memory.usageCount, which drives scoring.ts's usageBoost/ranking (Memory.ts itself has no usage-count-specific logic)",
    extract: wholeFile,
  },
  {
    file: "resources/mcp-handler.ts",
    label: "mcp-handler.ts (whole file)",
    why: "auth resolution (resolveAgentFromSub/jitProvisionPrincipal/isAgentAdmin/handleToolCall) — turns a verified token into a scoped flair identity for every MCP tool call",
    extract: wholeFile,
  },
];

describe("claimed-zero-authority tripwire (flair#735, follow-up to #718)", () => {
  it.each(SCAN_TARGETS)("$label never reads claimed.* provenance data", ({ file, label, why, extract }) => {
    const src = readFileSync(join(REPO_ROOT, file), "utf8");
    const { text, startLine } = extract(src);
    const offenses = findOffenses(text, startLine);
    expect(
      offenses,
      offenses
        .map(
          (o) =>
            `${file}:${o.line} — token "${o.token}" found in ${label} (${why}): ${JSON.stringify(o.excerpt)}. ` +
            `claimed.* is self-reported, unverified provenance data and must never enter an authority ` +
            `decision (read-scope/attribution/dedup/usage-count). If this is a display/serialization path, ` +
            `move it out of this authority module. See flair#735.`,
        )
        .join("\n"),
    ).toEqual([]);
  });

  it("SCAN_TARGETS is non-empty and covers every module named in flair#735", () => {
    const files = new Set(SCAN_TARGETS.map((t) => t.file));
    expect(files).toEqual(
      new Set([
        "resources/record-type-kit.ts",
        "resources/memory-read-scope.ts",
        "resources/Memory.ts",
        "resources/RecordUsage.ts",
        "resources/mcp-handler.ts",
      ]),
    );
  });
});
