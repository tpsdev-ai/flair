/**
 * doctor-install-tree-wiring-2034.test.ts — flair#2034 §2.
 *
 * Round 1 put the node-path diagnosis inside the catalog's launchd check,
 * which `flair doctor` filters OUT of its catalog — so the check could never
 * fire in doctor, and a helper-level test could not notice. This drives the
 * REAL `flair doctor` action in-process and proves its "Install tree" section
 * runs and counts: the federation-sync classifier is replaced with one that
 * reports a shim running another tree, and doctor must print it and exit 1.
 *
 * Isolation: HOME is a scratch directory (node:os homedir follows it, set
 * BEFORE src/cli.ts is imported), the port is one nothing listens on, network
 * access is rejected, and process.exit is captured. No launchctl call can be
 * reached: no plist exists under the scratch HOME. mock.module is
 * process-global, hence unit-isolated.
 */
import { describe, test, expect, mock, spyOn, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as scheduler from "../../src/federation/scheduler.js";

const TEST_HOME = mkdtempSync(join(tmpdir(), "flair-2034-doctor-home-"));
const ISOLATED_ENV_KEYS = ["HOME", "FLAIR_URL", "FLAIR_TARGET", "ROOTPATH", "FLAIR_ADMIN_PASS", "HDB_ADMIN_PASSWORD"] as const;
const SAVED_ENV: Record<string, string | undefined> = {};
for (const key of ISOLATED_ENV_KEYS) SAVED_ENV[key] = process.env[key];
process.env.HOME = TEST_HOME;
for (const key of ISOLATED_ENV_KEYS) if (key !== "HOME") delete process.env[key];

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

const SENTINEL = "SENTINEL-2034-federation-shim-runs-another-tree";
const calls: Array<{ dryRun?: boolean }> = [];
let federationStatus: "would-rewrite" | "not-enabled" = "would-rewrite";
mock.module("../../src/federation/scheduler.js", () => ({
  ...scheduler,
  rewriteFederationSchedulerRuntime: (opts: { dryRun?: boolean } = {}) => {
    calls.push({ dryRun: opts.dryRun });
    return { status: federationStatus, platform: process.platform, shimPath: "/x", unitPath: "/y", detail: SENTINEL };
  },
}));

const { program } = await import("../../src/cli.ts");

/** Run `flair doctor` in-process; returns its stdout lines and exit code. */
async function runDoctor(): Promise<{ text: string; exitCode: number | undefined; issues: number }> {
  const logs: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(" "));
  });
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  let exitCode: number | undefined;
  const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error("__exit__");
  }) as any);
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network disabled in this test");
  }) as unknown as typeof fetch;

  try {
    await program.parseAsync(["node", "flair", "doctor", "--port", "9"]);
  } catch (err) {
    if ((err as Error).message !== "__exit__") throw err;
  } finally {
    globalThis.fetch = origFetch;
    logSpy.mockRestore();
    errSpy.mockRestore();
    warnSpy.mockRestore();
    exitSpy.mockRestore();
  }

  const text = logs.join("\n");
  const m = /(\d+) issues? found/.exec(text);
  return { text, exitCode, issues: m ? Number(m[1]) : 0 };
}

describe("flair doctor wiring (#2034)", () => {
  test("doctor runs the Install tree section and counts what it finds", async () => {
    federationStatus = "not-enabled";
    const baseline = await runDoctor();
    expect(baseline.text).toContain("Install tree");
    // The serving tree cannot be proven under a scratch HOME: said, not counted.
    expect(baseline.text).toContain("serving install tree: unknown");
    expect(baseline.text).not.toContain(SENTINEL);

    federationStatus = "would-rewrite";
    calls.length = 0;
    const withFinding = await runDoctor();
    // The section consulted the federation-sync classifier (report-only: dry run)…
    expect(calls).toContainEqual({ dryRun: true });
    expect(calls.some((c) => c.dryRun === false)).toBe(false);
    // …printed its finding, and counted it as exactly one more issue.
    expect(withFinding.text).toContain(SENTINEL);
    expect(withFinding.issues).toBe(baseline.issues + 1);
    expect(withFinding.exitCode).toBe(1);
  }, 60_000);
});
