/**
 * doctor-fix-reverify-2520.test.ts — flair#2520.
 *
 * `flair doctor` resolves the admin credential and verifies one ops target
 * (`verifyDoctorRosterInstance`) before its audit-log and instance-identity
 * reads. With `--fix` it can then repair launchd management (which may
 * clean-stop the instance and load it under launchd, and can write the
 * admin-pass file from HDB_ADMIN_PASSWORD) and restart the instance onto this
 * CLI's install tree, both BEFORE the Agent roster and home reads. A credential
 * and target resolved before such a step prove nothing about the process
 * serving the probed port after it. Doctor therefore resolves the credential
 * again after such a fix and, when one is available, verifies the target with
 * it; the roster and home checks use only that answer. Diagnostic reads that
 * run use the verified target; pairing refusals report NOT RUN, and existing
 * UNVERIFIED/skipped outcomes remain.
 *
 * This drives the REAL `flair doctor --fix` action in-process through the
 * `bindCli` seam (as doctor-mcp-redirect-agent-2270 does). The launchd repair
 * and the install-tree adapters are fixtures. The first describe also replaces
 * the pair verifier, whose answer changes when a fixture fix "changes the
 * serving process". The second keeps the real verifier and credential
 * resolution: the repair fixture writes a real admin-pass file, and the probed
 * instance is answered at the fetch layer, accepting only its own password.
 *
 * Isolation: HOME and the working directory are a scratch directory (set BEFORE
 * src/cli.ts is imported; node:os homedir follows HOME), deployment variables
 * are removed, PATH holds only failing stubs behind a launchctl tripwire that
 * must stay clear, and process.exit is captured. Port 9 is a fixture port:
 * every fetch is intercepted and answered in this file and recorded with the
 * phase it happened in, so nothing on the host is addressed. mock.module is
 * process-global, hence unit-isolated.
 */
import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessTreeDivergence, withRunningVersion, type TreeAssessment } from "../../src/lib/tree-divergence.ts";
import { installLaunchctlTripwire } from "../helpers/fake-launchctl.ts";
import { setInstancePairOsReadsForTests } from "../../src/lib/local-instance-pair.ts";

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

// Imported after HOME is set, so every path they resolve is under it.
const { defaultAdminPassPath, resolveAdminUser } = await import("../../src/lib/auth-resolve.ts");
const PASS_FILE = join(home, ".flair", "admin-pass");
if (defaultAdminPassPath() !== PASS_FILE) throw new Error(`refusing to run: the admin-pass path ${defaultAdminPassPath()} is not under the scratch HOME`);

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

/** The probed instance of the credential case: its ops port, admin password, and one Agent row. */
const INSTANCE_OPS = 47303;
const INSTANCE_PASS = "fixture-hdb-admin-password-2520";
const INSTANCE_AGENT = "fixture-agent-2520";
const INSTANCE_ID = "fixture-instance-2520";

type Phase = "before-fix" | "after-fix";
type Scenario = {
  /** Which --fix step changes the serving process, if any. */
  change: "launchd-repair" | "install-tree-restart" | "none";
  /** What the fixture pair verifier answers once the process changed. */
  afterFix?: { kind: "run"; opsPort: number } | { kind: "not-run"; reason: string; remedy: string };
  /**
   * The credential case: the real pair verifier runs against the probed
   * instance answered at the fetch layer, and the launchd repair writes the
   * admin-pass file from HDB_ADMIN_PASSWORD after proving it, as
   * prepareLaunchdRepair does (flair#1685).
   */
  repairWritesPassFile?: boolean;
};

let scenario: Scenario = { change: "none", afterFix: { kind: "run", opsPort: PRE_FIX_OPS } };
let phase: Phase = "before-fix";
let restarted = false;
const verifyCalls: Array<{ phase: Phase; port: unknown }> = [];
const verifyPasses: unknown[] = [];
const auditOpsUrls: string[] = [];
const fetches: Array<{ phase: Phase; url: string }> = [];
const instanceOps: Array<{ phase: Phase; operation: string; authorized: boolean }> = [];
let writePassFile: (path: string, content: string) => void = () => {
  throw new Error("src/cli.ts is not imported yet");
};

/**
 * The probed instance of the credential case, answered at the fetch layer:
 * fixture port 9 is its HTTP port and INSTANCE_OPS its ops port, whose own
 * configuration records that pair. Its admin reads accept only INSTANCE_PASS.
 */
function answerAsProbedInstance(url: URL, init: RequestInit | undefined): Response {
  const expected = `Basic ${Buffer.from(`${resolveAdminUser()}:${INSTANCE_PASS}`).toString("base64")}`;
  const authorized = new Headers(init?.headers).get("authorization") === expected;
  const unauthorized = () => new Response("unauthorized", { status: 401 });
  if (Number(url.port) !== INSTANCE_OPS) {
    if (url.pathname.startsWith("/Instance")) return authorized ? Response.json([]) : unauthorized();
    return url.pathname === "/Health" ? Response.json({}) : Response.json([]);
  }
  const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
  instanceOps.push({ phase, operation: `${body.operation}${body.table ? `:${body.table}` : ""}`, authorized });
  if (!authorized) return unauthorized();
  switch (body.operation) {
    case "get_configuration":
      return Response.json({ http: { port: 9 }, operationsApi: { network: { port: INSTANCE_OPS } } });
    case "sql":
      return Response.json([{ id: INSTANCE_AGENT }]);
    case "search_by_value":
      return Response.json(body.table === "Agent" ? [{ id: INSTANCE_AGENT, originatorInstanceId: INSTANCE_ID }] : []);
    default:
      return Response.json([]);
  }
}

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
      return args[5] ? { state: "ok" } : { state: "skipped", reason: "no-admin-credentials", detail: "fixture: no admin credential" };
    },
    verifyDoctorRosterInstance: async (...args: unknown[]) => {
      verifyCalls.push({ phase, port: args[1] });
      verifyPasses.push(args[2]);
      if (scenario.repairWritesPassFile) return bindings.verifyDoctorRosterInstance(...args);
      return phase === "before-fix" ? { kind: "run", opsPort: PRE_FIX_OPS } : scenario.afterFix;
    },
    // 7b. The fixture repair adopts the instance into launchd: the process
    // serving the probed port is a new one. In the credential case it first
    // proves the environment credential against the probed instance and
    // writes the 0600 admin-pass file with the real writer.
    repairLaunchdManagement: async () => {
      if (scenario.change !== "launchd-repair") {
        return { kind: "no-op", reason: "already-managed", detail: "fixture: launchd already manages this instance" };
      }
      if (scenario.repairWritesPassFile) {
        const candidate = process.env.FLAIR_ADMIN_PASS ?? process.env.HDB_ADMIN_PASSWORD;
        if (candidate !== INSTANCE_PASS) {
          return { kind: "refused", reason: "missing-credential", detail: "fixture: the environment credential does not authenticate" };
        }
        writePassFile(defaultAdminPassPath(), candidate);
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
writePassFile = (await import("../../src/cli.ts")).writeAdminPassFile;

async function runDoctorFix(s: Scenario): Promise<{ output: string; exit: number | undefined }> {
  scenario = s;
  phase = "before-fix";
  restarted = false;
  verifyCalls.length = 0;
  verifyPasses.length = 0;
  auditOpsUrls.length = 0;
  fetches.length = 0;
  instanceOps.length = 0;
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
    spyOn(globalThis, "fetch").mockImplementation((async (input: unknown, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      fetches.push({ phase, url });
      if (s.repairWritesPassFile) return answerAsProbedInstance(new URL(url), init);
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

describe("flair#2520 — doctor --fix resolves the admin credential again after the launchd repair writes the pass file", () => {
  test("no credential at start, a valid HDB_ADMIN_PASSWORD: the repair writes admin-pass, and the roster and home sections run on the probed instance with it", async () => {
    // The probed pair, in the per-user config: fixture HTTP port 9 and the
    // instance's ops port. No FLAIR_ADMIN_PASS and no pass file; the instance's
    // password is only in HDB_ADMIN_PASSWORD, which the credential for these
    // reads (resolveLocalAdminPass) does not consult.
    mkdirSync(join(home, ".flair"), { recursive: true });
    writeFileSync(join(home, ".flair", "config.yaml"), `port: 9\nopsPort: ${INSTANCE_OPS}\n`);
    const flairAdminPass = process.env.FLAIR_ADMIN_PASS;
    delete process.env.FLAIR_ADMIN_PASS;
    process.env.HDB_ADMIN_PASSWORD = INSTANCE_PASS;
    // flair#2526: the real pair check also proves from the OS listener table
    // that one process with a Harper command line listens on both ports. The
    // probed instance here exists only at the fetch layer, so its listener
    // table is simulated the same way: one simulated process with a Harper
    // command line on fixture port 9 and its ops port, with a fixed start
    // time. No such process exists.
    setInstancePairOsReadsForTests({
      listeners: (port) => ({ kind: "listeners", pids: port === 9 || port === INSTANCE_OPS ? [25_200] : [] }),
      birth: (pid) => ({ kind: "birth", id: `${pid}@simulated` }),
      commandLine: () => "node\u0000/simulated/node_modules/harper/dist/bin/harper.js\u0000run\u0000.",
    });
    try {
      expect(existsSync(PASS_FILE)).toBe(false);
      const r = await runDoctorFix({ change: "launchd-repair", repairWritesPassFile: true });
      expect(r.output).toContain("fixture: adopted the instance into launchd");
      // The repair wrote the real 0600 pass file from the proven credential.
      expect(readFileSync(PASS_FILE, "utf-8").trim()).toBe(INSTANCE_PASS);
      expect(statSync(PASS_FILE).mode & 0o777).toBe(0o600);
      // Before the repair there was no credential: no target was verified, and
      // the instance-identity section kept its no-credential UNVERIFIED state.
      expect(r.output).toContain("Instance identity: UNVERIFIED");
      expect(instanceOps.filter((op) => op.phase === "before-fix")).toEqual([]);
      // After it, both sections ran: doctor resolved the credential from the new
      // file and verified the target with it (the real pair check against the
      // probed instance), then read the roster and the home rows with it.
      expect(r.output).not.toContain("Skipped: no admin credentials");
      expect(r.output).not.toContain("Agent homes check skipped");
      expect(r.output).toContain("No stored agent id is outside");
      expect(r.output).toContain("Every stored agent row names a home instance.");
      expect(verifyCalls).toEqual([{ phase: "after-fix", port: 9 }]);
      expect(verifyPasses).toEqual([INSTANCE_PASS]);
      const after = instanceOps.filter((op) => op.phase === "after-fix");
      expect(after.map((op) => op.operation)).toContain("get_configuration");
      expect(after.map((op) => op.operation)).toContain("sql");
      expect(after.map((op) => op.operation)).toContain("search_by_value:Agent");
      expect(after.every((op) => op.authorized)).toBe(true);
    } finally {
      setInstancePairOsReadsForTests(null);
      if (flairAdminPass === undefined) delete process.env.FLAIR_ADMIN_PASS;
      else process.env.FLAIR_ADMIN_PASS = flairAdminPass;
      delete process.env.HDB_ADMIN_PASSWORD;
      rmSync(PASS_FILE, { force: true });
      rmSync(join(home, ".flair", "config.yaml"), { force: true });
    }
  }, 60_000);
});
