/**
 * build-cli-once-freshness.test.ts — flair#1807 round 2, item 2.
 *
 * cliIsFresh() must compare dist/cli.js against EVERY build input, not just
 * src/. A build-config change (tsconfig.cli.json, package.json, bun.lock, the
 * write-build-info script) that leaves dist "fresh" is the stale-dist escape
 * both reviewers found. This pins the input SET by name, so dropping one is a
 * red test rather than a silent hole. The exclusions an mtime set cannot see
 * (installed node_modules contents, the git identity build-info reads, a
 * partial build) are named in the helper's header, not asserted here.
 */
import { describe, it, expect } from "bun:test";
import { resolve } from "node:path";
import { buildCliInputs, cliIsFresh } from "../helpers/build-cli-once.js";

const ROOT = resolve(import.meta.dirname, "..", "..");

describe("cliIsFresh inputs (flair#1807 round 2)", () => {
  it("includes src/, the tsconfig.cli.json chain, package.json, bun.lock and scripts/write-build-info.mjs", () => {
    const inputs = buildCliInputs().map((p) => p.replace(ROOT + "/", ""));
    expect(inputs).toContain("src");
    expect(inputs).toContain("tsconfig.cli.json");
    expect(inputs).toContain("package.json");
    expect(inputs).toContain("bun.lock");
    expect(inputs).toContain("scripts/write-build-info.mjs");
    // At least these five — a removal is the regression this guards.
    expect(inputs.length).toBeGreaterThanOrEqual(5);
  });

  it("cliIsFresh returns a boolean without throwing on any input state", () => {
    expect(typeof cliIsFresh()).toBe("boolean");
  });
});
