/**
 * doctor-fix-reverify-2520.test.ts — flair#2520 round 1.
 *
 * `flair doctor` verifies one ops target (`verifyDoctorRosterInstance`) before
 * its audit-log and instance-identity reads. With `--fix` it can then repair
 * launchd management (which may clean-stop the instance and load it under
 * launchd) and restart the instance onto this CLI's install tree, both BEFORE
 * the Agent roster and home reads. A target verified before such a step proves
 * nothing about the process serving the probed port after it. Doctor therefore
 * verifies again after a process-changing fix and the roster and home reads use
 * only that answer: they read from the newly verified ops port, or report NOT
 * RUN with the new refusal.
 *
 * This drives the REAL `flair doctor --fix` action in-process through the
 * `bindCli` seam (as doctor-mcp-redirect-agent-2270 does): the launchd repair,
 * the install-tree adapters and the pair verifier are fixtures, the verifier's
 * answer changes when a fixture fix "changes the serving process", and every
 * fetch is answered locally and recorded with the phase it happened in.
 *
 * Isolation: HOME and the working directory are a scratch directory (set BEFORE
 * src/cli.ts is imported; node:os homedir follows HOME), deployment variables
 * are removed, PATH holds only failing stubs behind a launchctl tripwire that
 * must stay clear, the port is one nothing listens on, and process.exit is
 * captured. mock.module is process-global, hence unit-isolated.
 */
import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessTreeDivergence, withRunningVersion, type TreeAssessment } from "../../src/lib/tree-divergence.ts";
import { installLaunchctlTripwire } from "../helpers/fake-launchctl.ts";

const home = mkdtempSync(join(tmpdir(), "flair-2520-reverify-"));
const savedEnv = { ...process.env };
const savedCwd = process.cwd();
for (const key of Object.keys(process.env)) {
  if (/^(FLAIR_|HARPER_|HDB_|FABRIC_)/.test(key)) delete process.env[key];
}
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.FLAIR_ADMIN_PASS = "fixture-admin-pass-2520";
process.env.NO_COLOR = "1";

// No harness is detectable and no host tool answers: PATH holds only failing
// stubs, behind a per-test launchctl tripwire (see runDoctorFix).
const bin = join(home, "bin");
mkdirSync(bin);
for (const name of ["lsof", "npm", "npx"]) {
  writeFileSync(join(bin, name), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
}
symlinkSync("/bin/sh", join(bin, "sh"));
process.env.PATH = bin;
process.chdir(home);

mock.module("node:os", () => {
  const actual = { ...require("node:os") };
  return { ...actual, homedir: () => process.env.HOME || actual.homedir() };
});

afterAll(() => {
  process.chdir(savedCwd);
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  rmSync(home, { recursive: true, force: true });
});

/** The ops port verified before any fix, and the one a re-verification names after it. */
const PRE_FIX_OPS = 47101;
const POST_FIX_OPS = 47202;
const POST_FIX_REASON = "SENTINEL-2520-post-fix-refusal: the ops endpoint no longer records the probed HTTP port";
const POST_FIX_REMEDY = "SENTINEL-2520-post-fix-remedy";

type Phase = "before-fix" | "after-fix";
type Scenario = {
  /** Which --fix step changes the serving process, if any. */
  change: "launchd-repair" | "install-tree-restart" | "none";
  /** What the pair verifier answers once the process changed. */
  afterFix: { kind: "run"; opsPort: number } | { kind: "not-run"; reason: string; remedy: string };
};

let scenario: Scenario = { change: "none", afterFix: { kind: "run", opsPort: PRE_FIX_OPS } };
let phase: Phase = "before-fix";
let restarted = false;
const verifyCalls: Array<{ phase: Phase; port: unknown }> = [];
const auditOpsUrls: string[] = [];
const fetches: Array<{ phase: Phase; url: string }> = [];

const NEW_TREE = "/u/lib/node_modules/@tpsdev-ai/flair";
const OLD_TREE = "/u/old/lib/node_modules/@tpsdev-ai/flair";
function treeAssessment(state: "diverged" | "same"): TreeAssessment {
  const dir = state === "same" ? NEW_TREE : OLD_TREE;
  return withRunningVersion(
    assessTreeDivergence({
      cli: { dir: NEW_TREE, version: "0.61.0" },
      serving: {
        kind: "proven",
        dir,
        version: "0.61.0",
        pid: 4242,
        manager: "launchd",
        unitName: "ai.tpsdev.flair.fixture2520",
        unitPath: join(home, "Library", "LaunchAgents", "ai.tpsdev.flair.fixture2520.plist"),
        unitNodeBin: null,
        unitTree: dir,
        dropInPaths: [],
      },
      currentNodeBin: "/n",
      samePath: (a, b) => a === b,
    }),
    "0.61.0",
  );
}

const doctor = await import("../../src/commands/doctor.ts");
const bindDoctor = doctor.bindCli;
mock.module("../../src/commands/doctor.ts", () => ({
  ...doctor,
  bindCli: (bindings: import("../../src/commands/doctor.ts").DoctorCli) => bindDoctor({
    ...bindings,
    api: async () => [],
    probeFlairReachable: async () => true,
    verifySemanticSearch: async () => ({ state: "skipped", reason: "fixture", detail: "fixture" }),
    checkAgentRegistered: async () => ({ state: "registered" }),
    verifyAuditLog: async (...args: unknown[]) => {
      auditOpsUrls.push(String(args[3]));
      return { state: "ok" };
    },
    verifyDoctorRosterInstance: async (_opts: unknown, port: unknown) => {
      verifyCalls.push({ phase, port });
      return phase === "before-fix" ? { kind: "run", opsPort: PRE_FIX_OPS } : scenario.afterFix;
    },
    // 7b. The fixture repair adopts the instance into launchd: the process
    // serving the probed port is a new one.
    repairLaunchdManagement: async () => {
      if (scenario.change !== "launchd-repair") {
        return { kind: "no-op", reason: "already-managed", detail: "fixture: launchd already manages this instance" };
      }
      phase = "after-fix";
      return { kind: "repaired", detail: "fixture: adopted the instance into launchd" };
    },
    planLaunchdRepairFor: () => ({
      plan: { kind: "no-op", reason: "already-managed", detail: "fixture: launchd already manages this instance" },
      plistPath: undefined,
      isLegacy: false,
      config: null,
    }),
    // 7c. A proven divergence, re-pointed and restarted onto this CLI's tree.
    assessInstallTree: () =>
      treeAssessment(scenario.change === "install-tree-restart" && !restarted ? "diverged" : "same"),
    repointMainServiceUnit: () => ({ kind: "repointed", detail: "fixture: re-pointed the unit" }),
    restartFlair: async () => {
      restarted = true;
      phase = "after-fix";
    },
  }),
}));
await import("../../src/cli.ts");

async function runDoctorFix(s: Scenario): Promise<{ output: string; exit: number | undefined }> {
  scenario = s;
  phase = "before-fix";
  restarted = false;
  verifyCalls.length = 0;
  auditOpsUrls.length = 0;
  fetches.length = 0;
  // A launchctl any call would reach first; it must stay clear. tempDir sweeps
  // it after each test, so each run installs its own.
  const tripwire = installLaunchctlTripwire("flair-2520-reverify-tripwire-");
  process.env.PATH = `${tripwire.dir}:${bin}`;
  const lines: string[] = [];
  let exit: number | undefined;
  const spies = [
    spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); }),
    spyOn(console, "error").mockImplementation(() => {}),
    spyOn(console, "warn").mockImplementation(() => {}),
    spyOn(globalThis, "fetch").mockImplementation((async (input: unknown) => {
      const url = input instanceof Request ? input.url : String(input);
      fetches.push({ phase, url });
      return url.endsWith("/Health") ? Response.json({}) : Response.json([]);
    }) as unknown as typeof fetch),
    spyOn(process, "exit").mockImplementation(((code?: number) => {
      exit = code;
      throw new Error("fixture exit");
    }) as typeof process.exit),
  ];
  const { Command } = await import("commander");
  const program = new Command();
  doctor.register(program);
  try {
    await program.parseAsync(["node", "flair", "doctor", "--port", "9", "--fix"]);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "fixture exit") throw error;
  } finally {
    for (const spy of spies) spy.mockRestore();
    process.env.PATH = bin;
  }
  tripwire.assertClear();
  return { output: lines.join("\n"), exit };
}

/** The ops ports doctor addressed in `phase`. */
function opsPortsFetched(p: Phase): number[] {
  return fetches
    .filter((f) => f.phase === p)
    .map((f) => Number(new URL(f.url).port))
    .filter((port) => port === PRE_FIX_OPS || port === POST_FIX_OPS);
}

describe("flair#2520 — doctor --fix verifies the target again after a fix that changes the serving process", () => {
  test("launchd repair, then the pair check refuses: the roster and home sections report NOT RUN and their reads do not run", async () => {
    const r = await runDoctorFix({
      change: "launchd-repair",
      afterFix: { kind: "not-run", reason: POST_FIX_REASON, remedy: POST_FIX_REMEDY },
    });
    expect(r.output).toContain("fixture: adopted the instance into launchd");
    // Verified once before the fix, and again after it, against the probed port.
    expect(verifyCalls).toEqual([{ phase: "before-fix", port: 9 }, { phase: "after-fix", port: 9 }]);
    // The audit-log and instance-identity reads ran before the fix, on the target verified then.
    expect(auditOpsUrls).toEqual([`http://127.0.0.1:${PRE_FIX_OPS}`]);
    expect(opsPortsFetched("before-fix")).toContain(PRE_FIX_OPS);
    // After the fix, the new refusal stands: both sections are NOT RUN with its
    // reason, and neither diagnostic read runs. The fixture verifier reads
    // nothing, so no ops endpoint is addressed after the fix, the pre-fix one
    // included.
    expect(r.output).toContain(`Agent IDs: NOT RUN — ${POST_FIX_REASON}`);
    expect(r.output).toContain(`Agent homes: NOT RUN — ${POST_FIX_REASON}`);
    expect(r.output).toContain(POST_FIX_REMEDY);
    expect(opsPortsFetched("after-fix")).toEqual([]);
    expect(r.exit).toBe(1);
  }, 60_000);

  test("install-tree restart, then the pair check names a new ops port: the roster and home reads use it", async () => {
    const r = await runDoctorFix({
      change: "install-tree-restart",
      afterFix: { kind: "run", opsPort: POST_FIX_OPS },
    });
    expect(r.output).toContain("restarted; verified");
    expect(verifyCalls).toEqual([{ phase: "before-fix", port: 9 }, { phase: "after-fix", port: 9 }]);
    expect(auditOpsUrls).toEqual([`http://127.0.0.1:${PRE_FIX_OPS}`]);
    // After the restart only the newly verified endpoint is read, by both sections.
    const after = opsPortsFetched("after-fix");
    expect(after.length).toBeGreaterThanOrEqual(2);
    expect(after.every((port) => port === POST_FIX_OPS)).toBe(true);
    expect(r.output).not.toContain("Agent IDs: NOT RUN");
    expect(r.output).not.toContain("Agent homes: NOT RUN");
  }, 60_000);

  test("no fix changes the serving process: one verification serves all four reads", async () => {
    const r = await runDoctorFix({
      change: "none",
      afterFix: { kind: "not-run", reason: POST_FIX_REASON, remedy: POST_FIX_REMEDY },
    });
    expect(verifyCalls).toEqual([{ phase: "before-fix", port: 9 }]);
    expect(auditOpsUrls).toEqual([`http://127.0.0.1:${PRE_FIX_OPS}`]);
    // The identity, roster and home reads all addressed the one verified port.
    const reads = opsPortsFetched("before-fix");
    expect(reads.length).toBeGreaterThanOrEqual(3);
    expect(reads.every((port) => port === PRE_FIX_OPS)).toBe(true);
    expect(r.output).not.toContain(POST_FIX_REASON);
  }, 60_000);
});
