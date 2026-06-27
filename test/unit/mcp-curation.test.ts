/**
 * mcp-curation.test.ts — the native-MCP feature-flag + suppression-marker
 * contract, Harper-free (FLAIR-NATIVE-MCP, slice 1).
 *
 * This file deliberately imports ONLY mcp-curation.ts (no `@harperfast/harper`,
 * no FlairMcp) so it needs no module mock — a mock of `@harperfast/harper` here
 * would leak globally in bun's single-process test run and break the other
 * harper-mocking unit tests (e.g. coordination-write-auth). The FULL FlairMcp
 * curated-9-tool contract — names, verb-stripping, "exactly 9, no mutators" — is
 * proven end-to-end against a real Harper in
 * test/integration/mcp-surface.test.ts.
 */
import { describe, test, expect } from "bun:test";
import { MCP_HIDDEN, mcpEnabled } from "../../resources/mcp-curation.ts";

describe("mcp-curation — feature flag (default OFF)", () => {
  const cases: Array<[string | undefined, boolean]> = [
    [undefined, false], ["", false], ["false", false], ["0", false], ["no", false], ["off", false],
    ["FALSE", false], ["nope", false], ["2", false], ["enabled", false],
    ["1", true], ["true", true], ["TRUE", true], ["yes", true], ["YES", true], ["on", true], ["  on  ", true],
  ];
  for (const [val, expected] of cases) {
    test(`FLAIR_MCP_ENABLED=${JSON.stringify(val)} → ${expected}`, () => {
      const prev = process.env.FLAIR_MCP_ENABLED;
      if (val === undefined) delete process.env.FLAIR_MCP_ENABLED;
      else process.env.FLAIR_MCP_ENABLED = val;
      try {
        expect(mcpEnabled()).toBe(expected);
      } finally {
        if (prev === undefined) delete process.env.FLAIR_MCP_ENABLED;
        else process.env.FLAIR_MCP_ENABLED = prev;
      }
    });
  }

  test("default (unset) is OFF — byte-identical config / no /mcp surface", () => {
    const prev = process.env.FLAIR_MCP_ENABLED;
    delete process.env.FLAIR_MCP_ENABLED;
    try {
      expect(mcpEnabled()).toBe(false);
    } finally {
      if (prev !== undefined) process.env.FLAIR_MCP_ENABLED = prev;
    }
  });

  test("MCP_HIDDEN is the literal `true` Harper's enumerator checks for", () => {
    // buildApplicationTools skips a Resource iff `ResourceClass.hidden === true`,
    // so the suppression marker MUST be exactly true.
    expect(MCP_HIDDEN).toBe(true);
  });
});
