/**
 * stamp-outstanding-cli-parity.test.ts — stay-in-sync guard for the
 * CLI copy of resources/migrations/stamp-outstanding.ts (flair#1073).
 *
 * src/stamp-outstanding.ts exists only because cli.ts cannot import
 * across the src/ → resources/ packaging boundary (tsconfig.cli.json
 * rootDir). Extend one file without the other and this file goes red.
 */
import { describe, it, expect } from "bun:test";
import * as canonical from "../../resources/migrations/stamp-outstanding.ts";
import * as cliCopy from "../../src/stamp-outstanding.ts";

const CURRENT = "gguf:nomic-embed-text-v1.5-Q4_K_M+searchprefix";

describe("src/stamp-outstanding stays in sync with resources/migrations/stamp-outstanding.ts", () => {
  it("EMBEDDING_STAMP_ID is identical", () => {
    expect(cliCopy.EMBEDDING_STAMP_ID).toBe(canonical.EMBEDDING_STAMP_ID);
  });

  it("export names match", () => {
    const names = (mod: object) => Object.keys(mod).sort();
    expect(names(cliCopy)).toEqual(names(canonical));
  });

  it("known-answer table agrees (expected verdicts asserted — parity cannot go vacuous)", () => {
    const CASES: Array<{
      name: string;
      input: canonical.StampOutstandingInput;
      outstanding: boolean;
      warningIncludes?: string[];
      warningExcludes?: string[];
    }> = [
      {
        name: "already current",
        input: {
          modelCounts: { "nomic-embed-text-v1.5-Q4_K_M+searchprefix": 599 },
          currentModelId: CURRENT,
          migration: { id: "embedding-stamp", state: "completed" },
          cyclePhase: "done",
        },
        outstanding: false,
      },
      {
        name: "pre-flip split",
        input: {
          modelCounts: {
            "nomic-embed-text-v1.5-Q4_K_M": 554,
            "nomic-embed-text-v1.5-Q4_K_M+searchprefix": 40,
          },
          currentModelId: CURRENT,
          cyclePhase: "done",
        },
        outstanding: true,
        warningIncludes: ["embedding-stamp", "554", "duplicate detection is inactive"],
      },
      {
        name: "client audience, no cycle state",
        input: {
          modelCounts: { "nomic-embed-text-v1.5-Q4_K_M": 10 },
          currentModelId: CURRENT,
          audience: "client",
        },
        outstanding: true,
        warningIncludes: ["the Harper process applies it on its next migration cycle"],
        warningExcludes: ["this process's next migration cycle"],
      },
      {
        name: "process audience, no cycle state",
        input: {
          modelCounts: { "nomic-embed-text-v1.5-Q4_K_M": 10 },
          currentModelId: CURRENT,
        },
        outstanding: true,
        warningIncludes: ["this process's next migration cycle"],
        warningExcludes: ["this CLI does not"],
      },
    ];

    for (const c of CASES) {
      const a = canonical.describeStampOutstanding(c.input);
      const b = cliCopy.describeStampOutstanding(c.input);
      expect(a, c.name).toEqual(b);
      expect(a.outstanding, c.name).toBe(c.outstanding);
      if (a.outstanding) {
        for (const s of c.warningIncludes ?? []) expect(a.warning, c.name).toContain(s);
        for (const s of c.warningExcludes ?? []) expect(a.warning, c.name).not.toContain(s);
      }
    }
  });

  it("resolveCurrentModelId agrees on same-space and uniform pre-flip", () => {
    const sameSpace = {
      "nomic-embed-text-v1.5-Q4_K_M+searchprefix": 40,
      "gguf:nomic-embed-text-v1.5-Q4_K_M+searchprefix": 60,
    };
    expect(cliCopy.resolveCurrentModelId(sameSpace)).toBe(canonical.resolveCurrentModelId(sameSpace));
    expect(cliCopy.resolveCurrentModelId({ "nomic-embed-text-v1.5-Q4_K_M": 554 })).toBe(
      canonical.resolveCurrentModelId({ "nomic-embed-text-v1.5-Q4_K_M": 554 }),
    );
  });
});
