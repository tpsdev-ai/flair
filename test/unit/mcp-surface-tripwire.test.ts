/**
 * mcp-surface-tripwire.test.ts — bidirectional enforcement that the MCP
 * surface declared in resources/record-types.ts (`RECORD_TYPES.<Table>.mcp`
 * + `COMPOSITE_MCP_TOOLS`) and resources/mcp-tools.ts's `TOOLS` dispatch
 * table never drift (record-types slice 3, flair#520).
 *
 * Design record: https://github.com/tpsdev-ai/flair/issues/520 — Flint's
 * slice-3 design comment, Kern's DESIGN REVIEW (APPROVE all four asks),
 * Sherlock's Security Review (APPROVE with the COMPOSITE_MCP_TOOLS
 * relocation-into-record-types.ts refinement, adopted by both).
 *
 * "Declare-and-enforce, not runtime-derive": resources/mcp-tools.ts's
 * `TOOLS` map stays the hand-written dispatch table — nothing in this file
 * generates a tool. What IS enforced is that the two reviewed chokepoints
 * (a table's `mcp` verbs, and the `COMPOSITE_MCP_TOOLS` allowlist) and the
 * actually-shipped `TOOLS` map describe the SAME SET, in both directions:
 *
 *   1. registry → tools: every verb declared on a `RECORD_TYPES.<Table>.mcp`
 *      entry resolves (default naming, or a `TOOL_NAME_OVERRIDES` entry) to
 *      a tool that exists in `TOOLS`. A declaration cannot outrun reality.
 *   2. tools → registry: every tool name in `TOOLS` is either derived from
 *      a declared verb or listed in `COMPOSITE_MCP_TOOLS`. A shipped tool
 *      cannot exist undeclared — this is the check that makes "any PR
 *      touching the MCP surface must also touch a policy chokepoint" an
 *      enforced CI failure, not an aspiration.
 *   3. absence means absence: a table with no `mcp` field (Relationship, in
 *      this slice) contributes zero tools carrying its table-name-style
 *      prefix.
 *   4. the full 12-tool `tools/list` surface is pinned as a golden value —
 *      belt-and-suspenders on the single highest-value invariant (an
 *      undeclared tool silently reaching a client is exactly flair#541's
 *      failure mode), independent of whether the bidirectional checks above
 *      would also have caught a given drift.
 *
 * CRITICAL (CodeQL js/regex-injection — we've been burned twice on this
 * class of finding): every "does this tool name carry this prefix" check
 * below uses plain string methods (`startsWith`, `===`), never
 * `new RegExp(...)` built from a runtime string.
 */
import { describe, it, expect } from "bun:test";
import { RECORD_TYPES, COMPOSITE_MCP_TOOLS, type RecordTypeName } from "../../resources/record-types.ts";
import { TOOLS, TOOL_NAME_OVERRIDES, mcpToolName } from "../../resources/mcp-tools.ts";

const TABLE_NAMES = Object.keys(RECORD_TYPES) as RecordTypeName[];
const SHIPPED_TOOL_NAMES = Object.keys(TOOLS).sort();

/** Every (table, verb, toolPrefix) triple declared across RECORD_TYPES. */
const DECLARED_VERBS: Array<[table: RecordTypeName, verb: string, toolPrefix: string]> = [];
for (const table of TABLE_NAMES) {
  const mcp = RECORD_TYPES[table].mcp;
  if (!mcp) continue;
  for (const verb of [...mcp.readVerbs, ...mcp.writeVerbs]) {
    DECLARED_VERBS.push([table, verb, mcp.toolPrefix]);
  }
}

/**
 * The full set of tool names the registry + composite allowlist declare —
 * computed the SAME way direction-1's per-verb check computes a single
 * name, then unioned with COMPOSITE_MCP_TOOLS. Used by direction 2 to
 * decide "declared vs. undeclared" for every shipped tool.
 */
function declaredToolNames(): Set<string> {
  const names = new Set<string>();
  for (const [table, verb, toolPrefix] of DECLARED_VERBS) names.add(mcpToolName(table, toolPrefix, verb));
  for (const name of COMPOSITE_MCP_TOOLS) names.add(name);
  return names;
}

describe("MCP surface tripwire — RECORD_TYPES.mcp + COMPOSITE_MCP_TOOLS vs. resources/mcp-tools.ts TOOLS", () => {
  describe("direction 1: every declared registry verb resolves to an existing tool", () => {
    it.each(DECLARED_VERBS)("%s.mcp verb \"%s\" (toolPrefix \"%s\") resolves to a tool present in TOOLS", (table, verb, toolPrefix) => {
      const name = mcpToolName(table, toolPrefix, verb);
      expect(
        Object.prototype.hasOwnProperty.call(TOOLS, name),
        `RECORD_TYPES.${table}.mcp declares write/read verb "${verb}" (resolved tool name "${name}"), ` +
          `but resources/mcp-tools.ts's TOOLS map has no such entry. Either implement the tool in ` +
          `resources/mcp-tools.ts, add/fix a TOOL_NAME_OVERRIDES entry there if the shipped name differs ` +
          `from the default "\${toolPrefix}_\${verb}" shape, or remove the verb from ` +
          `resources/record-types.ts's RECORD_TYPES.${table}.mcp.`,
      ).toBe(true);
    });
  });

  describe("direction 2: every shipped tool is declared (a registry verb, or a composite)", () => {
    const declared = declaredToolNames();

    it.each(SHIPPED_TOOL_NAMES)('TOOLS["%s"] is declared (registry verb or COMPOSITE_MCP_TOOLS)', (name) => {
      expect(
        declared.has(name),
        `resources/mcp-tools.ts's TOOLS map has a tool named "${name}" that is neither derived from any ` +
          `RECORD_TYPES.<Table>.mcp verb nor listed in COMPOSITE_MCP_TOOLS (both declared in ` +
          `resources/record-types.ts). Declare it there: if it maps to a single table + verb, add the verb ` +
          `to that table's \`mcp\` field (and a TOOL_NAME_OVERRIDES entry in resources/mcp-tools.ts if the ` +
          `name isn't the default "\${toolPrefix}_\${verb}" shape); otherwise add "${name}" to ` +
          `COMPOSITE_MCP_TOOLS in resources/record-types.ts.`,
      ).toBe(true);
    });
  });

  describe("absence means absence: a table with no `mcp` field contributes zero tools", () => {
    const undeclaredTables = TABLE_NAMES.filter((t) => !RECORD_TYPES[t].mcp);

    it("at least one table (Relationship) has no mcp field in this slice", () => {
      expect(undeclaredTables).toContain("Relationship");
    });

    it.each(undeclaredTables)("%s: zero tools in TOOLS carry a table-name-style prefix for it", (table) => {
      const prefix = table.toLowerCase();
      const matches = SHIPPED_TOOL_NAMES.filter(
        (name) => name === prefix || name.startsWith(`${prefix}_`),
      );
      expect(matches).toEqual([]);
    });
  });

  describe("golden value: the complete 12-tool tools/list surface is pinned", () => {
    it("sorted TOOLS keys deep-equal the pinned list (tools/list byte-identical)", () => {
      expect(SHIPPED_TOOL_NAMES).toEqual([
        "attention",
        "bootstrap",
        "flair_orgevent",
        "flair_workspace_set",
        "memory_delete",
        "memory_get",
        "memory_search",
        "memory_store",
        "memory_update",
        "record_usage",
        "soul_get",
        "soul_set",
      ]);
    });

    it("the declared surface (registry verbs ∪ composites) also totals exactly 12 unique names", () => {
      expect(declaredToolNames().size).toBe(12);
    });
  });

  describe("TOOL_NAME_OVERRIDES sanity", () => {
    it("every override target is itself a real tool in TOOLS", () => {
      for (const table of Object.keys(TOOL_NAME_OVERRIDES) as RecordTypeName[]) {
        const verbs = TOOL_NAME_OVERRIDES[table] ?? {};
        for (const verb of Object.keys(verbs)) {
          const name = verbs[verb as keyof typeof verbs] as string;
          expect(Object.prototype.hasOwnProperty.call(TOOLS, name)).toBe(true);
        }
      }
    });
  });
});
