/**
 * upgrade-exec-path-wiring.test.ts — flair#1109 (b), flair#1788
 *
 * Proves `flair upgrade --check` actually *invokes* collectUpgradeExecPathWarning
 * and prints its result before the package listing. A source grep cannot catch
 * a commented-out or late-moved call (Bugbot on #1560). Isolated because
 * mock.module is process-global.
 *
 * flair#1788: the wiring runs IN-PROCESS, so the upgrade action's serving-instance
 * probe would consult the REAL $HOME. On any host with a live Flair instance the
 * probe finds it, `flair upgrade` takes the plain-tree lane, and the exec-path
 * warning this test asserts on is suppressed (the warning is printed only when
 * the npm-global lane is still the target). A scratch HOME makes the probe find
 * nothing, so the npm-global lane is taken. Environment-only is enough — the
 * probe reads no other surface (see the note above the setup).
 */

import { describe, test, expect, mock, spyOn, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as execPath from "../../src/lib/upgrade-exec-path.js";

// ── flair#1788: isolate the probe from the host's live instance ──────────────
//
// The wiring runs IN-PROCESS, so the upgrade action's serving-instance probe
// (src/cli.ts's resolveInstanceServingPid -> resolveHttpPort + readHarperPid)
// would consult the REAL $HOME. On a host with a live Flair instance the probe
// finds it, `flair upgrade` takes the plain-tree lane, and the exec-path warning
// this test asserts on is suppressed. A scratch HOME makes the probe find
// nothing.
//
// The variables the probe honours, enumerated from its source (not guessed):
//   - HOME        — defaultDataDir() = join(homedir(), ".flair", "data").
//                   `homedir()` caches at first call, so a late process.env.HOME
//                   is too late: this is the same `node:os` override
//                   test/unit/cli.test.ts uses (reused, not a second helper).
//   - FLAIR_URL   — resolveHttpPort() returns its :port before any disk read.
// ROOTPATH/FLAIR_TARGET are not read on THIS path; scrubbed so a different
// instance's identity cannot leak in.
const TEST_HOME = mkdtempSync(join(tmpdir(), "flair-1109b-home-"));
const ISOLATED_ENV_KEYS = ["HOME", "FLAIR_URL", "FLAIR_TARGET", "ROOTPATH"] as const;
const SAVED_ENV: Record<string, string | undefined> = {};
for (const key of ISOLATED_ENV_KEYS) SAVED_ENV[key] = process.env[key];
process.env.HOME = TEST_HOME;
delete process.env.FLAIR_URL;
delete process.env.FLAIR_TARGET;
delete process.env.ROOTPATH;

// homedir() delegates to process.env.HOME (falling back to the real one when
// unset) — registered BEFORE cli.ts is imported so defaultDataDir() resolves
// under the scratch tree.
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

const SENTINEL = "SENTINEL-1109b-exec-path-warning";
const collectCalls: unknown[] = [];

// Keep the rest of the module (plain-tree lane reads findFlairPackageDir /
// resolveServingFlairPackage / readFlairPackageAt). Only the warning
// collector is replaced — this is still the (b) wiring proof.
mock.module("../../src/lib/upgrade-exec-path.js", () => ({
  ...execPath,
  collectUpgradeExecPathWarning: (input: unknown) => {
    collectCalls.push(input);
    return SENTINEL;
  },
}));

// Imported AFTER HOME is owned, so any module-level ~/.flair resolution lands
// in the scratch tree.
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
    ) as unknown as typeof fetch;

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

    // flair#1788: prove the wiring never read the REAL HOME. HOME resolves to
    // the scratch tree (via the node:os override), so the serving-instance
    // probe resolves nothing — a live instance on the host can no longer
    // suppress this warning — and the resolved data dir sits under the scratch
    // path. Remove the isolation and these fail on a host that has a running
    // instance.
    const isolatedOs = await import("node:os");
    expect(isolatedOs.homedir()).toBe(TEST_HOME);
    expect(join(isolatedOs.homedir(), ".flair", "data").startsWith(TEST_HOME)).toBe(true);
    expect((collectCalls[0] as { servingPid: number | null }).servingPid).toBeNull();

    const checking = logs.findIndex((l) => l.includes("Checking for updates"));
    expect(checking).toBeGreaterThanOrEqual(0);
    const sentinel = logs.findIndex((l) => l.includes(SENTINEL));
    expect(sentinel).toBeGreaterThan(checking);
    const listing = logs.findIndex((l, i) => i > checking && /@tpsdev-ai\/flair:/.test(l));
    expect(listing).toBeGreaterThan(sentinel);
  });
});
