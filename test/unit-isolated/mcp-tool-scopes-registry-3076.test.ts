// mcp-tool-scopes-registry-3076.test.ts — resources/mcp-tools.ts refuses to load
// when MCP_TOOL_SCOPES lists a tool that TOOLS does not serve (flair#3076).
//
// The registry guard checks both directions: a served tool with no table entry,
// and a table entry with no served tool. This file covers the second: the real
// table plus one extra entry. It is isolated because the substituted table is a
// process-global mock.module.
import { expect, mock, test } from "bun:test";

mock.module("harper", () => ({
  Resource: class {},
  server: {},
  databases: {},
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}));

const real = await import("../../resources/mcp-tool-scopes.ts");
const { MCP_TOOL_SCOPES, MCP_REQUESTED_SCOPES, requiredToolScope, grantedScopes, challengeScope } = real;
const EXTRA = "not_a_served_tool";
expect(Object.prototype.hasOwnProperty.call(MCP_TOOL_SCOPES, EXTRA)).toBe(false);

mock.module("../../resources/mcp-tool-scopes.ts", () => ({
  MCP_TOOL_SCOPES: Object.freeze({ ...MCP_TOOL_SCOPES, [EXTRA]: "memory:read" }),
  MCP_REQUESTED_SCOPES,
  requiredToolScope,
  grantedScopes,
  challengeScope,
}));

test("mcp-tools.ts refuses to load when MCP_TOOL_SCOPES has an entry for a tool TOOLS does not serve", async () => {
  await expect(import("../../resources/mcp-tools.ts")).rejects.toThrow(
    `MCP_TOOL_SCOPES does not match TOOLS: no scope for []; not in TOOLS [${EXTRA}]`,
  );
}, 30_000);
