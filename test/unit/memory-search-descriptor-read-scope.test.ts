/**
 * memory-search-descriptor-read-scope.test.ts — flair#1870.
 *
 * The `memory_search` tool descriptor is the text every MCP client reads from
 * `tools/list`. It used to say the search was "Scoped to your agent's own +
 * granted memories" — a leftover from the pre-reframe, grant-gated read model.
 * Since resources/memory-read-scope.ts's within-org-read-open change, reads
 * carry NO per-owner grant gate: MemoryGrant is not consulted by
 * resolveReadScope() at all, and a reader's scope is
 *
 *   - ALL of the reader's own records, any visibility, and
 *   - EVERY other agent's non-private record on the instance.
 *
 * The registry (resources/record-types.ts) is the SINGLE declarative source of
 * Memory's read model (`readScope: "open-within-org"`, which delegates to that
 * same resolveReadScope()). This test imports that declaration and holds the
 * descriptor wording to it: while Memory is declared open-within-org, no
 * descriptor text may claim the scope is grant-based. If the read model is
 * narrowed back to a grant gate, the declaration assertion fails first — the
 * coupling is explicit, never a silent stale sentence in tools/list.
 *
 * The `+ granted` claim lived in exactly two places at flair#1870: the
 * descriptor source (packages/flair-tool-descriptors/src/index.ts, whose source
 * is the single source of truth) and the built-in /mcp contract summary
 * (resources/mcp-tools.ts, pinned equal to the descriptor's outputShape by
 * test/unit/mcp-surface-tripwire.test.ts). Both are scanned here.
 */
import { describe, expect, test } from "bun:test";
import { RECORD_TYPES } from "../../resources/record-types.ts";
import {
  NATIVE_TOOL_DESCRIPTORS,
  TOOL_DESCRIPTORS,
} from "../../packages/flair-tool-descriptors/src/index.ts";
import { TOOLS } from "../../resources/mcp-tools.ts";

/** The word that must not describe a read whose model no longer consults grants. */
const GRANT_CLAIM = "granted";

interface DescriptorText {
  where: string;
  text: string;
}

/**
 * Every descriptor-owned string an MCP client can see: each descriptor's
 * description + outputShape, and the /mcp TOOLS contract summary (shipped on
 * the native surface and pinned equal to the descriptor's outputShape).
 */
function descriptorTexts(): DescriptorText[] {
  const out: DescriptorText[] = [];
  for (const d of TOOL_DESCRIPTORS) {
    out.push({ where: `descriptor ${d.name}.description`, text: d.description });
    out.push({ where: `descriptor ${d.name}.outputShape`, text: d.outputShape });
  }
  for (const d of NATIVE_TOOL_DESCRIPTORS) {
    const summary = TOOLS[d.name]?.contract?.summary;
    if (typeof summary === "string") {
      out.push({ where: `TOOLS.${d.name}.contract.summary`, text: summary });
    }
  }
  return out;
}

const READ_MODEL = RECORD_TYPES.Memory.readScope;

describe("flair#1870 — memory_search descriptor wording tracks Memory's read model", () => {
  test("Memory's declared read model is open-within-org (the anchor this wording depends on)", () => {
    // The registry is the single declarative source of the read model; the
    // descriptor wording below is only correct while this holds. If the model
    // narrows to a grant gate, this assertion fails and forces a deliberate
    // wording decision instead of leaving a stale claim shipped.
    expect(READ_MODEL).toBe("open-within-org");
  });

  test("no descriptor text claims the read is 'granted' while the model is open-within-org", () => {
    // Count the input, not just the matches: an empty scan must not read as a
    // clean scan.
    const texts = descriptorTexts();
    expect(texts.length).toBe(TOOL_DESCRIPTORS.length * 2 + NATIVE_TOOL_DESCRIPTORS.length);

    if (READ_MODEL === "open-within-org") {
      const offenders = texts
        .filter((t) => t.text.includes(GRANT_CLAIM))
        .map((t) => t.where);
      expect(offenders).toEqual([]);
    } else {
      // The read model no longer matches the wording this test justifies.
      // Fail loudly so the descriptor text is re-decided, never silently
      // assumed still correct.
      expect.unreachable(
        `Memory read model is "${READ_MODEL}", not "open-within-org" — re-decide the memory_search descriptor wording (it is no longer covered by this guard).`,
      );
    }
  });

  test("memory_search's description and outputShape state the open-within-org scope", () => {
    const search = TOOL_DESCRIPTORS.find((d) => d.name === "memory_search");
    expect(search).toBeDefined();
    expect(search!.description).toContain("non-private");
    expect(search!.outputShape).toContain("non-private");
    expect(search!.description).not.toContain(GRANT_CLAIM);
    expect(search!.outputShape).not.toContain(GRANT_CLAIM);
  });
});
