/**
 * durability-doc-contract.test.ts — flair#2217.
 *
 * The documentation contract for durability tiers. `permanent` prevents
 * routine retention removal (resources/MemoryMaintenance.ts) but supplies no
 * special flush, fsync, backup or replica acknowledgement, and an explicit
 * delete or a store failure still ends a row at any tier. The durability
 * selection points enumerated below — the MCP tool descriptions, the CLI help,
 * the SDK doc comments, the shipped skills, README and the docs — must state
 * the SAME guarantee per tier, and none may re-introduce a claim the code does
 * not provide.
 *
 * This test is a pure text contract (no imports of the modules under test), so
 * it runs unchanged against `origin/main` and reports the over-promise there:
 * the pre-#2217 README said `permanent` is "retained until explicitly deleted",
 * which the code does not guarantee.
 *
 * It fails on `origin/main` (missing canonical statements + a forbidden
 * over-promise on README) and passes once every selection point carries the
 * canonical copy.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "../..");

/**
 * THE canonical statement, one line per tier plus the shared caveat. Copied
 * verbatim into every selection point; this literal is the contract.
 */
const CANONICAL_TIERS: readonly string[] = [
  "permanent — routine maintenance never reaps or age-archives it (a writer-set validTo still archives it, as for every tier); it never decays and loads first in bootstrap.",
  "persistent — routine maintenance never reaps or age-archives it (a writer-set validTo still archives it, as for every tier).",
  "standard — routine maintenance archives it once its validTo passes or, as a session note, after 30 days.",
  "ephemeral — routine maintenance reaps it once its TTL (24h by default) passes.",
];

const CANONICAL_CAVEAT =
  "No tier adds a flush, fsync, backup or replica acknowledgement: an explicit delete (owner or admin) or a store failure can end any of them.";

const CANONICAL: readonly string[] = [...CANONICAL_TIERS, CANONICAL_CAVEAT];

/**
 * Every file whose prose must carry the full canonical statement. Covers the
 * descriptor source of truth and both build-time vendored copies, the server
 * durability module, the CLI copy module and the rendered CLI-surface snapshot,
 * the SDK doc comments, the shipped skills, and the README/docs pages.
 */
const SURFACES: readonly string[] = [
  "resources/memory-durability.ts",
  "packages/flair-tool-descriptors/src/index.ts",
  "resources/tool-descriptors/index.ts",
  "packages/flair-mcp/src/tool-descriptors/index.ts",
  "src/lib/durability-copy.ts",
  "src/lib/using-flair-skill.ts",
  "test/unit-isolated/cli-surface.snapshot.txt",
  "packages/flair-client/src/types.ts",
  "packages/flair-client/src/client.ts",
  "packages/adk-flair-js/src/memory_service.ts",
  "packages/pi-flair/src/index.ts",
  "packages/openclaw-flair/index.ts",
  "packages/hermes-flair/__init__.py",
  "packages/n8n-nodes-flair/src/nodes/FlairWrite/FlairWrite.node.ts",
  "packages/cursor-flair/skills/remember/SKILL.md",
  "README.md",
  "DESIGN.md",
  "docs/api-reference.md",
  "docs/rem.md",
  "docs/quickstart.md",
];

/** CLI commands whose `--durability` help must be rendered from the copy module. */
const CLI_COPY_CONSUMERS: readonly string[] = [
  "src/commands/memory.ts",
  "src/commands/soul.ts",
  "src/commands/search.ts",
];

/**
 * Guarantees the code does NOT provide, checked per raw line. A line is a
 * violation only when it also names a durability tier, so unrelated prose
 * ("this port is not guaranteed distinct", "never deleted" in a test note) is
 * not a false positive.
 */
const TIER_WORD = /(?:durab|permanent|persistent|ephemeral|retention)/i;
const FORBIDDEN: readonly RegExp[] = [
  /until explicitly deleted/i,
  /guaranteed/i,
  /never lost/i,
  /never be deleted/i,
  /never deleted/i,
  /cannot be deleted/i,
  /can not be deleted/i,
  /can't be deleted/i,
  /permanent(?:ly)? stor(?:e|ed|age)/i,
  /inviolable/i,
  /never-forget/i,
];

/** Collapse all whitespace so a wrapped/multi-line statement still matches. */
function squash(text: string): string {
  return text.replace(/\s+/g, " ");
}

function read(repoRelPath: string): string | null {
  try {
    return readFileSync(join(REPO, repoRelPath), "utf8");
  } catch {
    return null;
  }
}

/** Missing canonical lines in one file's text ([] means fully compliant). */
function missingCanonical(text: string): string[] {
  const flat = squash(text);
  return CANONICAL.filter((line) => !flat.includes(squash(line)));
}

/** Forbidden over-promises in one file's text. */
function forbiddenHits(text: string): string[] {
  const hits: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (TIER_WORD.test(raw) && FORBIDDEN.some((re) => re.test(raw))) hits.push(raw.trim());
  }
  return hits;
}

describe("flair#2217 — durability documentation contract", () => {
  test("the canonical statement is one line per tier plus a caveat", () => {
    expect(CANONICAL_TIERS).toHaveLength(4);
    for (const tier of ["permanent", "persistent", "standard", "ephemeral"]) {
      expect(CANONICAL_TIERS.filter((l) => l.startsWith(`${tier} —`))).toHaveLength(1);
    }
    expect(CANONICAL_CAVEAT.length).toBeGreaterThan(0);
  });

  test(`each enumerated selection point carries the canonical statement (${SURFACES.length} files)`, () => {
    const failures: string[] = [];
    for (const file of SURFACES) {
      const text = read(file);
      if (text === null) {
        failures.push(`${file}: MISSING FILE`);
        continue;
      }
      for (const line of missingCanonical(text)) {
        failures.push(`${file}: dropped canonical line -> ${line.slice(0, 60)}…`);
      }
    }
    expect(failures).toEqual([]);
  });

  test("no selection point re-introduces a guarantee the code does not provide", () => {
    const failures: string[] = [];
    for (const file of SURFACES) {
      const text = read(file);
      if (text === null) continue; // reported by the previous test
      for (const hit of forbiddenHits(text)) {
        failures.push(`${file}: ${hit}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test("the CLI surfaces render from the shared copy module, not their own words", () => {
    const failures: string[] = [];
    for (const file of CLI_COPY_CONSUMERS) {
      const text = read(file);
      if (text === null || !text.includes("DURABILITY_TIERS_HELP")) {
        failures.push(`${file}: does not use DURABILITY_TIERS_HELP`);
      }
    }
    expect(failures).toEqual([]);
  });

  test("guard the guard: the checker flags the pre-#2217 README claim", () => {
    const overPromise =
      "| **Tiered durability** | `permanent` (retained until explicitly deleted by its owner or an admin) / `persistent` / `standard` (default) / `ephemeral` (24h TTL). |";
    expect(forbiddenHits(overPromise)).not.toEqual([]);
    // And a compliant line is not flagged.
    expect(forbiddenHits(`- ${CANONICAL_TIERS[0]}`)).toEqual([]);
    expect(missingCanonical(CANONICAL.join("\n"))).toEqual([]);
  });
});
