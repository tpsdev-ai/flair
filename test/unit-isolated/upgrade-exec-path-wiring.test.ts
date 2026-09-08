/**
 * upgrade-exec-path-wiring.test.ts — flair#1109 (b)
 *
 * Proves `flair upgrade --check` actually *invokes* collectUpgradeExecPathWarning
 * and prints its result before the package listing. A source grep cannot catch
 * a commented-out or late-moved call (Bugbot on #1560). Isolated because
 * mock.module is process-global.
 */

import { describe, test, expect, mock, spyOn } from "bun:test";

const SENTINEL = "SENTINEL-1109b-exec-path-warning";
const collectCalls: unknown[] = [];

mock.module("../../src/lib/upgrade-exec-path.js", () => ({
  collectUpgradeExecPathWarning: (input: unknown) => {
    collectCalls.push(input);
    return SENTINEL;
  },
}));

const { program } = await import("../../src/cli.ts");

describe("flair upgrade wiring", () => {
  test("upgrade --check invokes collectUpgradeExecPathWarning before listing packages", async () => {
    collectCalls.length = 0;
    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(" "));
    });
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ version: "0.99.0" }), { status: 200 })
    ) as typeof fetch;

    try {
      await program.parseAsync(["node", "flair", "upgrade", "--check"]);
    } finally {
      globalThis.fetch = origFetch;
      logSpy.mockRestore();
      errSpy.mockRestore();
    }

    expect(collectCalls.length).toBeGreaterThanOrEqual(1);
    expect(collectCalls[0]).toEqual(expect.objectContaining({
      cliPackageDir: expect.any(String),
    }));
    expect("servingPid" in (collectCalls[0] as object)).toBe(true);
    expect("npmGlobalPrefix" in (collectCalls[0] as object)).toBe(true);

    const checking = logs.findIndex((l) => l.includes("Checking for updates"));
    expect(checking).toBeGreaterThanOrEqual(0);
    const sentinel = logs.findIndex((l) => l.includes(SENTINEL));
    expect(sentinel).toBeGreaterThan(checking);
    const listing = logs.findIndex((l, i) => i > checking && /@tpsdev-ai\/flair:/.test(l));
    expect(listing).toBeGreaterThan(sentinel);
  });
});
