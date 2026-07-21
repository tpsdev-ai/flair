/**
 * trust-block-zero-authority-tripwire.test.ts — structural guard that the
 * flair#744 slice-1 trust-evidence block NEVER enters an authority decision
 * (the #735-spirit invariant Sherlock made binding for #744, condition 2).
 *
 * ─── The contract this enforces ────────────────────────────────────────────
 * resources/trust-block.ts's buildTrustBlock()/attachTrust() assemble a
 * compact, advisory trust block from a record's already-stored fields. It
 * INFORMS THE READER ONLY: it must never re-enter read-scope resolution,
 * attribution stamping, dedup matching, usage counting, or the retrieval/
 * ranking core. The block is assembled strictly DOWNSTREAM of read-scope
 * resolution, in the response tail of each recall wrapper (SemanticSearch.post,
 * Memory.get, MemoryBootstrap.post) — never in a shared authority chokepoint.
 * Today that's enforced by where the assembler is called; this test makes it a
 * structural, CI-enforced invariant, so a future edit can't quietly wire the
 * trust block into a decision path (exactly the failure mode #735 exists to
 * prevent for `claimed.*`). Mirrors claimed-zero-authority-tripwire.test.ts.
 *
 * ─── Scan targets, and why each is an authority / core-scoping site ────────
 *   1-2. record-type-kit.ts + memory-read-scope.ts (WHOLE FILES) — the shared
 *        read-scope + no-forge-attribution machinery every cross-agent Memory
 *        read/write funnels through.
 *   3-4. Memory.ts, SCOPED to findConservativeDedupMatch + runDedupGate — the
 *        dedup-match gate. NOT a whole-file scan: Memory.ts's get() legitimately
 *        imports/calls attachTrust to surface the block on a by-id read (a
 *        response path, already read-scope-gated), the same way the claimed
 *        tripwire scopes around Memory.ts's legitimate `claimedClient` stamp.
 *   5.   RecordUsage.ts (WHOLE FILE) — the only writer of Memory.usageCount
 *        (the anti-gaming usage-count authority feeding scoring.ts's usageBoost).
 *   6.   mcp-handler.ts (WHOLE FILE) — turns a verified token into a scoped
 *        flair identity for every MCP tool call.
 *   7.   semantic-retrieval-core.ts (WHOLE FILE) — the pure retrieval + post-
 *        retrieval scoping/filter core (retrieveCandidates). The trust block
 *        must be assembled by the WRAPPER (SemanticSearch.post/MemoryBootstrap
 *        .post) AFTER this core returns already-scoped results, never inside the
 *        core's ranking/filter path. (This module exports DEFAULT_SELECT, which
 *        the wrappers widen for the block — but the core itself references the
 *        trust assembler nowhere.)
 *
 * ─── Explicitly OUT of scope (so a reviewer doesn't wonder) ────────────────
 *   - resources/trust-block.ts — WHERE the block is constructed (the write-time
 *     contract itself, not a consumer). resources/SemanticSearch.ts /
 *     resources/MemoryBootstrap.ts / resources/Memory.ts's get() — the response
 *     tails that legitimately assemble the block AFTER scope resolution.
 *
 * ─── Comment handling / CodeQL note ────────────────────────────────────────
 * Both block and line comments are blanked (content → spaces, newlines kept so
 * failure line numbers stay real) before scanning — several scanned files carry
 * doc comments that mention "trust" in prose. Token matching is plain
 * String.includes() over STATIC literals, never a runtime-built RegExp
 * (js/regex-injection — same discipline as the sibling tripwires).
 *
 * ─── If this test fails ────────────────────────────────────────────────────
 * A scanned authority/core module now references the trust-block assembler. The
 * trust block is advisory, reader-facing data and must never influence read-
 * scope / attribution / dedup / usage-count / retrieval-ranking outcomes. If
 * this is a display/serialization path, it belongs in a recall wrapper's
 * response tail, not interleaved with decision logic. See flair#744 (Sherlock
 * condition 2) and flair#735.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/**
 * Tokens that indicate a REFERENCE to the trust-block assembler. All are
 * unambiguous identifiers owned by resources/trust-block.ts (buildTrustBlock /
 * attachTrust / the TrustBlock type / the module specifier), plus `.trust` — a
 * direct read of an attached block off a record, which must never happen in a
 * decision path. Deliberately NOT a bare `"trust"` token: that matches
 * unrelated prose/identifiers (`wrapUntrusted`, `defaultTrustTier`, "trusted
 * internal call") with no connection to this contract.
 */
const TRUST_BLOCK_TOKENS = [
  "buildTrustBlock",
  "attachTrust",
  "TrustBlock",
  "trust-block",
  ".trust",
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

function findOffenses(text: string, startLine: number): Offense[] {
  const strippedLines = stripComments(text).split("\n");
  const rawLines = text.split("\n");
  const offenses: Offense[] = [];
  for (let i = 0; i < strippedLines.length; i++) {
    for (const token of TRUST_BLOCK_TOKENS) {
      if (strippedLines[i].includes(token)) {
        offenses.push({ line: startLine + i, token, excerpt: (rawLines[i] ?? "").trim() });
      }
    }
  }
  return offenses;
}

/** Extract one top-level `function <fnName>(` body via brace-matching. Throws
 *  loudly if the function was renamed/moved so a refactor can't disarm the
 *  guard (fix the marker, don't delete the check). */
function extractFunctionBody(src: string, fnName: string): { text: string; startLine: number } {
  const marker = `function ${fnName}(`;
  const start = src.indexOf(marker);
  if (start === -1) {
    throw new Error(
      `trust-block-zero-authority-tripwire: expected to find "${marker}" in resources/Memory.ts — ` +
        `has the dedup gate been renamed or moved? Update this test's extraction target; do not delete ` +
        `the check (flair#744).`,
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
  file: string;
  label: string;
  why: string;
  extract: (src: string) => { text: string; startLine: number };
}

const wholeFile = (src: string) => ({ text: src, startLine: 1 });

const SCAN_TARGETS: ScanTarget[] = [
  {
    file: "resources/record-type-kit.ts",
    label: "record-type-kit.ts (whole file)",
    why: "shared read-scope + no-forge attribution for Memory/Relationship/WorkspaceState/OrgEvent/Soul",
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
    why: "the only writer of Memory.usageCount (the usage-count authority feeding scoring.ts's usageBoost)",
    extract: wholeFile,
  },
  {
    file: "resources/mcp-handler.ts",
    label: "mcp-handler.ts (whole file)",
    why: "turns a verified token into a scoped flair identity for every MCP tool call",
    extract: wholeFile,
  },
  {
    file: "resources/semantic-retrieval-core.ts",
    label: "semantic-retrieval-core.ts (whole file)",
    why: "the retrieval + post-retrieval scoping/filter core; the trust block must be assembled by the wrapper AFTER this returns scoped results, never inside it",
    extract: wholeFile,
  },
];

describe("trust-block zero-authority tripwire (flair#744 Sherlock condition 2, #735-spirit)", () => {
  it.each(SCAN_TARGETS)("$label never references the trust-block assembler", ({ file, label, why, extract }) => {
    const src = readFileSync(join(REPO_ROOT, file), "utf8");
    const { text, startLine } = extract(src);
    const offenses = findOffenses(text, startLine);
    expect(
      offenses,
      offenses
        .map(
          (o) =>
            `${file}:${o.line} — token "${o.token}" found in ${label} (${why}): ${JSON.stringify(o.excerpt)}. ` +
            `The trust block is advisory, reader-facing data and must never enter an authority/scope/` +
            `attribution/dedup/usage-count/ranking decision. Assemble it in a recall wrapper's response ` +
            `tail instead. See flair#744 (Sherlock condition 2) and flair#735.`,
        )
        .join("\n"),
    ).toEqual([]);
  });

  it("SCAN_TARGETS covers every authority/core module the trust block must stay out of", () => {
    const files = new Set(SCAN_TARGETS.map((t) => t.file));
    expect(files).toEqual(
      new Set([
        "resources/record-type-kit.ts",
        "resources/memory-read-scope.ts",
        "resources/Memory.ts",
        "resources/RecordUsage.ts",
        "resources/mcp-handler.ts",
        "resources/semantic-retrieval-core.ts",
      ]),
    );
  });
});
