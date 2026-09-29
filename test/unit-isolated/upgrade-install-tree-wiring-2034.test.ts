/**
 * upgrade-install-tree-wiring-2034.test.ts — flair#2034 §2.
 *
 * Drives the REAL `flair upgrade --check` action in-process and proves that a
 * PROVEN install-tree divergence is compared once, BEFORE any branch (the
 * package listing, and whatever upgrade then decides), with the version the
 * instance reports, and that it replaces the generic exec-path warning instead
 * of printing beside it.
 *
 * The proof itself is replaced (proveServingTree) so the test needs no real
 * launchd/systemd; everything else — the cli.ts assessment, the upgrade action
 * — is real. HOME is a scratch directory set BEFORE src/cli.ts is imported, and
 * every network request is answered by a stub. mock.module is process-global,
 * hence unit-isolated.
 */
import { describe, test, expect, mock, spyOn, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as treeDivergence from "../../src/lib/tree-divergence.js";
import * as execPath from "../../src/lib/upgrade-exec-path.js";

const TEST_HOME = mkdtempSync(join(tmpdir(), "flair-2034-upgrade-home-"));
const ISOLATED_ENV_KEYS = ["HOME", "FLAIR_URL", "FLAIR_TARGET", "ROOTPATH"] as const;
const SAVED_ENV: Record<string, string | undefined> = {};
for (const key of ISOLATED_ENV_KEYS) SAVED_ENV[key] = process.env[key];
process.env.HOME = TEST_HOME;
delete process.env.FLAIR_URL;
delete process.env.FLAIR_TARGET;
delete process.env.ROOTPATH;

mock.module("node:os", () => {
  const actual = { ...require("node:os") };
  return { ...actual, homedir: () => process.env.HOME || actual.homedir() };
});

afterAll(() => {
  for (const key of ISOLATED_ENV_KEYS) {
    if (SAVED_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED_ENV[key];
  }
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const OLD_TREE = "/u/.local/share/mise/installs/node/24.18.0/lib/node_modules/@tpsdev-ai/flair";
const probes: unknown[] = [];
mock.module("../../src/lib/tree-divergence.js", () => ({
  ...treeDivergence,
  proveServingTree: (p: unknown) => {
    probes.push(p);
    return {
      kind: "proven",
      dir: OLD_TREE,
      version: "0.57.0",
      pid: 4242,
      manager: "launchd",
      unitName: "ai.tpsdev.flair.abcd1234",
      unitPath: "/u/Library/LaunchAgents/ai.tpsdev.flair.abcd1234.plist",
      unitNodeBin: null,
      unitTree: OLD_TREE,
      dropInPaths: [],
    };
  },
}));
const EXEC_PATH_SENTINEL = "SENTINEL-2034-exec-path-warning";
mock.module("../../src/lib/upgrade-exec-path.js", () => ({
  ...execPath,
  collectUpgradeExecPathWarning: () => EXEC_PATH_SENTINEL,
}));

const { program } = await import("../../src/cli.ts");

describe("flair upgrade wiring (#2034)", () => {
  test("a proven divergence prints once, before the listing, with the running version, and replaces the exec-path warning", async () => {
    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(" "));
    });
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ version: "0.99.0" }), { status: 200 })
    ) as unknown as typeof fetch;
    try {
      await program.parseAsync(["node", "flair", "upgrade", "--check"]);
    } finally {
      globalThis.fetch = origFetch;
      logSpy.mockRestore();
      errSpy.mockRestore();
    }

    expect(probes.length).toBe(1);
    expect((probes[0] as { local: boolean }).local).toBe(true);
    const text = logs.join("\n");
    expect(text.split("DIFFERENT install trees")).toHaveLength(2);
    expect(text).toContain("running flair 0.99.0");
    expect(text).toContain("changes this CLI's tree only");
    expect(text).not.toContain(EXEC_PATH_SENTINEL);
    const block = logs.findIndex((l) => l.includes("DIFFERENT install trees"));
    const listing = logs.findIndex((l) => /@tpsdev-ai\/flair:/.test(l));
    expect(block).toBeGreaterThanOrEqual(0);
    expect(listing).toBeGreaterThan(block);
    expect(text).not.toContain("✅ Everything is up to date");
  }, 60_000);
});
