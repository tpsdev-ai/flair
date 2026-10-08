// Scenario (npm's nested install layout):
//   1. Boot the CURRENT BUILD (this worktree's own `dist/`, via
//      `startHarper()` — same mechanism test/integration/*.test.ts and
//      test/compat/federation-mixed-version.test.ts use) against a FRESH,
//      throwaway data directory.
//   2. Write real data through it: register an agent, add a permanent
//      memory, set presence.
//   3. Stop it WITHOUT deleting the data directory
//      (`stopHarper(inst, { keepInstallDir: true })` — flair#637's harness
//      addition to test/helpers/harper-lifecycle.ts).
//   4. Boot the previously-published npm baseline (`@tpsdev-ai/flair@0.59.0`,
//      installed with npm's nested strategy) against THAT SAME data directory,
//      through the baseline's OWN CLI (`node <baseline>/dist/cli.js start`).
//   5. If it boots: read the memory and presence rows back through the
//      baseline's own HTTP surface — a clean boot that can't actually see
//      its own data isn't "downgrade works", it's a different failure mode.
//      If it refuses (the engine changed): assert the refusal names the engine
//      change, and that regular-file paths and contents are unchanged afterward.
//
// ─── HOME isolation ─────────────────────────────────────────────────────
// Same hard rule as federation-mixed-version.test.ts: every `flair` CLI
// invocation is spawned as its own subprocess with an explicit per-instance
// `HOME` env var, never by mutating `process.env.HOME` in this test's own
// process (Bun's `os.homedir()` ignores live mutation) — this test must
// never read or write this machine's real `~/.flair`.
//
// ─── Why this doesn't reuse federation-mixed-version.test.ts's baseline
// install code ────────────────────────────────────────────────────────────
// Both files need an "install the npm-published baseline into a throwaway
// dir" step, but that file is a `.test.ts` module — importing anything from
// it at module scope would re-execute its top-level `describe()` block and
// register its tests a second time under this file too. The npm-baseline
// bootstrap below is intentionally a close copy of that file's `beforeAll`
// (same rationale, same comments trimmed to what applies here); the actual
// HARNESS reuse this issue asked for is `startHarper`/`stopHarper` from
// test/helpers/harper-lifecycle.ts, which both files share for real.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const NODE_BIN = process.env.NODE_BIN ?? "node";

const BASELINE_NPM_VERSION = "0.59.0";

// ─── Outcome classification (flair#1050) ────────────────────────────────────
// The restated downgrade invariant names three outcomes:
//   (a) old binary boots and serves correctly
//   (b) old binary refuses loudly naming the engine change and how to recover
//   (c) anything else — the silent bad outcome it forbids
//
// This function classifies a downgrade boot attempt from its exit code and
// stderr.  It is pure (no side effects) so it can be unit-tested directly.

export type DowngradeOutcome =
  | { kind: "booted" }
  | { kind: "refusal"; exitCode: number; stderr: string }
  | { kind: "hung"; stderr: string };

export function classifyDowngradeOutcome(
  exitCode: number | null,
  stderr: string,
): DowngradeOutcome {
  // Exit 124 is the timeout command's exit code: the process HUNG and was
  // killed by the harness, it did not refuse.
  if (exitCode === 124) return { kind: "hung", stderr };
  // Exit 0 means the baseline booted successfully.
  if (exitCode === 0) return { kind: "booted" };
  // Any other non-zero exit is a refusal (outcome b).
  return { kind: "refusal", exitCode: exitCode ?? -1, stderr };
}

/** startHarper timeout text — a hang, not a refusal (flair#1050).
 *  `waitForHealth` says "did not respond within"; the startup timer says
 *  "timed out" and appends the Harper log, so LZ4 can appear on a hang. */
export function isHungBootMessage(msg: string): boolean {
  return msg.includes("timed out") || msg.includes("did not respond within");
}

/** Harper 5.2.7→5.2.0 LZ4 crash is loud refusal only if the process did not hang. */
export function isLz4LoudRefusal(msg: string): boolean {
  if (isHungBootMessage(msg)) return false;
  return /LZ4 not supported/i.test(msg);
}

function assertBaselineDidNotHang(err: Error | null): void {
  if (!err) return;
  if (isHungBootMessage(err.message)) {
    throw new Error(
      `baseline HUNG (timeout) — this is the silent-bad-outcome case ` +
      `the invariant forbids:\n${err.message}`,
    );
  }
}

// Generous but bounded — a fresh `npm install` from the public registry plus
// two real Harper installs/boots easily takes 1-3 minutes on a cold cache
// (same figure federation-mixed-version.test.ts uses for the same reason).
const SETUP_TIMEOUT_MS = 300_000;
const CLI_TIMEOUT_MS = 45_000;
const NPM_INSTALL_TIMEOUT_MS = 180_000;

const AGENT_ID = "flair637-downgrade-agent";

/** Strip CI secrets from the inherited env before handing it to a child
 * process — same deny-list rationale as harper-lifecycle.ts's baseEnv
 * (Sherlock review on #467).
 */
function sanitizedParentEnv(): Record<string, string> {
  const env = { ...(process.env as Record<string, string>) };
  delete env.GITHUB_TOKEN;
  delete env.NPM_TOKEN;
  return env;
}

/** Spawn `node <cliPath> ...args` and wait for it to exit. Rejects (with the
 * full captured stdout/stderr in the error message) on a non-zero exit code
 * or timeout.
 */
async function runFlairCli(
  cliPath: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs = CLI_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const proc = spawn(NODE_BIN, [cliPath, ...args], { env });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(
        `flair CLI timed out after ${timeoutMs}ms: ${args.join(" ")}\n` +
        `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
      ));
    }, timeoutMs);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(
          `flair CLI exited ${code}: ${args.join(" ")}\n` +
          `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
        ));
      } else {
        resolve({ stdout, stderr });
      }
    });
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

/** Like runFlairCli, but a NON-ZERO exit resolves with the captured output
 *  instead of rejecting — the refusal of the baseline start is an asserted
 *  outcome, not a setup error. A timeout still rejects: a hang is the distinct,
 *  forbidden failure mode the invariant calls out. */
async function runFlairCliRaw(
  cliPath: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs = CLI_TIMEOUT_MS,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const proc = spawn(NODE_BIN, [cliPath, ...args], { env });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(
        `flair CLI timed out after ${timeoutMs}ms (HANG, not a refusal): ${args.join(" ")}\n` +
        `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
      ));
    }, timeoutMs);
    proc.on("exit", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

function instanceEnv(inst: HarperInstance, home: string = inst.installDir): Record<string, string> {
  return {
    ...sanitizedParentEnv(),
    HOME: home,
    FLAIR_URL: inst.httpURL,
    FLAIR_ADMIN_PASS: inst.admin.password,
    // Defence in depth for CLI spawns only. This does NOT fix the baseline
    // boot — startHarper() builds its env from process.env and never reads
    // this, so the real override lives in beforeAll. Kept because runFlairCli()
    // can also invoke commands that start Harper, and the same prompt would
    // block those. See beforeAll for the mechanism and the review that caught
    // the difference.
    //
    // MUST be lowercase "yes" or "y". Harper tests membership in
    // UPGRADE_PROCEED = ['yes','y'] behind a case-sensitive /y(es)?$|n(o)?$/
    // pattern; any other value (YES, true, 1, "yes ") fails validation, and the
    // prompt library discards the invalid override and falls through to reading
    // stdin — reproducing the exact hang this avoids. Measured against
    // harper 5.1.22 with prompt 1.3.0.
    CONFIRM_DOWNGRADE: "yes",
  };
}

/** Read an agent's Memory rows via the Harper OPERATIONS API directly (raw
 * `search_by_value`, Basic admin auth) — the same version-stable read path
 * federation-mixed-version.test.ts's fetchAgentMemories uses, for the same
 * reason: it doesn't depend on either build's `flair memory search` CLI/REST
 * auth resolution, which has genuinely differed across versions.
 */
async function fetchAgentMemories(inst: HarperInstance, agentId: string): Promise<any[]> {
  const auth = "Basic " + Buffer.from(`admin:${inst.admin.password}`).toString("base64");
  const res = await fetch(`${inst.opsURL}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify({
      operation: "search_by_value",
      schema: "flair",
      table: "Memory",
      search_attribute: "agentId",
      search_value: agentId,
      get_attributes: ["*"],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`ops search_by_value(Memory, agentId=${agentId}) failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  return await res.json() as any[];
}

/** Recursively hash every regular file under `dir` (relative path + sha256),
 *  sorted. Compares regular-file paths and contents only. */
function hashDataDir(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    const abs = join(dir, rel);
    for (const name of readdirSync(abs).sort()) {
      const childRel = rel ? join(rel, name) : name;
      const childAbs = join(dir, childRel);
      const st = statSync(childAbs);
      if (st.isDirectory()) walk(childRel);
      else if (st.isFile()) {
        const h = createHash("sha256").update(readFileSync(childAbs)).digest("hex");
        out.push(`${childRel} ${h}`);
      }
    }
  };
  walk("");
  return out.sort();
}

describe("downgrade compat (npm baseline boot vs current-build data) [flair#637]", () => {
  let priorConfirmDowngrade: string | undefined;
  let baselineDir: string;
  let pkgDirBaseline: string;
  let cliPathBaseline: string;
  let cliPathCurrent: string;
  let homeRoot: string;
  let dataDir: string | undefined;
  let current: HarperInstance | null = null;
  /** The baseline's `flair start` refusal (engine-changed branch), captured —
   *  not thrown — so the test can assert on it. */
  let baselineStart: { code: number | null; stdout: string; stderr: string } | null = null;
  /** Data-dir file hashes (relative path + sha256) around the refused start. */
  let dataDirHashBefore: string[] | null = null;
  let dataDirHashAfter: string[] | null = null;
  let baseline: HarperInstance | null = null;
  let memoryMarker: string;
  /** Set when the baseline fails to boot — captured, not thrown, so the
   * suite can assert on the DOCUMENTED failure mode instead of erroring out
   * of every test via a failed beforeAll. */
  let baselineBootError: Error | null = null;
  /** Whether the Harper engine version differs between baseline and current. */
  let engineVersionChanged = false;
  let baselineHarperVersion: string | null = null;
  let currentHarperVersion: string | null = null;

  beforeAll(async () => {
    // ── 0. Pre-answer Harper's interactive downgrade prompt ────────────────
    //
    // MUST be set on `process.env`, not via instanceEnv(). `startHarper()` —
    // which is what actually boots the baseline against the newer store —
    // builds its own env as `{ ...process.env }` minus two token keys
    // (test/helpers/harper-lifecycle.ts). It never calls instanceEnv(), whose
    // only consumer is runFlairCli(). Setting the key there looks like it
    // covers this and does not: the baseline spawn would still block on stdin.
    //
    // Caught in review by Kern, after I had put it in instanceEnv() and
    // convinced myself the test was fixed. The lane and the compat test are two
    // separate enforcement points and each needs the override on its own path.
    //
    // See migration-ci-lanes.yml for why the value must be lowercase.
    priorConfirmDowngrade = process.env.CONFIRM_DOWNGRADE;
    process.env.CONFIRM_DOWNGRADE = "yes";

    // ── 1. Install the previous published baseline from npm (same recipe as
    // federation-mixed-version.test.ts's beforeAll) ─────────────────────────
    baselineDir = await mkdtemp(join(tmpdir(), "flair-downgrade-baseline-"));
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("npm", ["init", "-y"], { cwd: baselineDir, env: sanitizedParentEnv() });
      let out = "";
      proc.stdout?.on("data", (d) => out += d.toString());
      proc.stderr?.on("data", (d) => out += d.toString());
      proc.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`npm init failed: ${out}`)));
      proc.on("error", reject);
    });
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("npm", ["install", "--install-strategy=nested", `@tpsdev-ai/flair@${BASELINE_NPM_VERSION}`], { cwd: baselineDir, env: sanitizedParentEnv() });
      let out = "";
      proc.stdout?.on("data", (d) => out += d.toString());
      proc.stderr?.on("data", (d) => out += d.toString());
      const timer = setTimeout(() => { proc.kill(); reject(new Error(`npm install timed out after ${NPM_INSTALL_TIMEOUT_MS}ms:\n${out}`)); }, NPM_INSTALL_TIMEOUT_MS);
      proc.on("exit", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`npm install @tpsdev-ai/flair@${BASELINE_NPM_VERSION} failed:\n${out}`)); });
      proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    });
    // Linux CI has no native embedding binary for the npm-published package's
    // own optionalDependencies resolution — install it explicitly (same as
    // federation-mixed-version.test.ts) so the baseline's embeddings
    // component doesn't crash at boot.
    if (process.platform === "linux") {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn("npm", ["install", "--install-strategy=nested", "--no-save", "@node-llama-cpp/linux-x64@3"], { cwd: baselineDir, env: sanitizedParentEnv() });
        let out = "";
        proc.stdout?.on("data", (d) => out += d.toString());
        proc.stderr?.on("data", (d) => out += d.toString());
        proc.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`native embedding binary install failed:\n${out}`)));
        proc.on("error", reject);
      });
    }
    pkgDirBaseline = join(baselineDir, "node_modules", "@tpsdev-ai", "flair");
    cliPathBaseline = join(pkgDirBaseline, "dist", "cli.js");
    cliPathCurrent = join(process.cwd(), "dist", "cli.js");

    // ── 2. Boot the CURRENT BUILD against a fresh data dir ─────────────────
    //
    // Layout is load-bearing: the store MUST sit at `$HOME/.flair/data`. The
    // published baseline's backwards-engine guard — and `flair start` itself —
    // resolves the store as `flairDataDir()` = `$HOME/.flair/data`; a bare
    // Harper root that only ROOTPATH names would leave that guard reading a
    // directory this build never wrote. So HOME is a throwaway root and the
    // store is its `.flair/data`.
    homeRoot = await mkdtemp(join(tmpdir(), "flair-downgrade-home-"));
    dataDir = join(homeRoot, ".flair", "data");
    mkdirSync(dataDir, { recursive: true });
    current = await startHarper({ installDir: dataDir, homeDir: homeRoot });
    const currentEnv = instanceEnv(current, homeRoot);
    const currentPort = String(new URL(current.httpURL).port);
    const currentOpsPort = String(new URL(current.opsURL).port);

    await runFlairCli(
      cliPathCurrent,
      ["agent", "add", AGENT_ID, "--admin-pass", current.admin.password, "--port", currentPort, "--ops-port", currentOpsPort],
      currentEnv,
    );

    memoryMarker = `flair637-downgrade-marker-${Date.now()}`;
    await runFlairCli(
      cliPathCurrent,
      ["memory", "add", `downgrade compat marker: ${memoryMarker}`, "--agent", AGENT_ID, "--durability", "permanent"],
      currentEnv,
    );

    // Presence — cheap to add, per the issue ("write memories (and presence
    // if cheap)"); also exercises a second table through the same boot.
    await runFlairCli(
      cliPathCurrent,
      ["presence", "set", "--agent", AGENT_ID, "--activity", "coding", "--task", "flair#637 downgrade compat check", "--port", currentPort],
      currentEnv,
    );

    // ── 3. Stop the current build WITHOUT deleting its data dir ────────────
    await stopHarper(current, { keepInstallDir: true });

    // ── 3a. Detect engine version change (flair#1050) ────────────────────
    for (const pkgName of ["harper", "@harperfast/harper"]) {
      const pkgPath = join(pkgDirBaseline, "node_modules", ...pkgName.split("/"), "package.json");
      if (existsSync(pkgPath)) {
        try {
          baselineHarperVersion = (JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string }).version ?? null;
        } catch { /* keep null */ }
        break;
      }
    }
    for (const pkgName of ["harper", "@harperfast/harper"]) {
      const pkgPath = join(process.cwd(), "node_modules", ...pkgName.split("/"), "package.json");
      if (existsSync(pkgPath)) {
        try {
          currentHarperVersion = (JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string }).version ?? null;
        } catch { /* keep null */ }
        break;
      }
    }
    engineVersionChanged = baselineHarperVersion !== null &&
      currentHarperVersion !== null &&
      baselineHarperVersion !== currentHarperVersion;
    if (engineVersionChanged) {
      console.log(`Engine version changed: baseline Harper ${baselineHarperVersion} → current Harper ${currentHarperVersion}`);
    }

    // ── 4. Boot the npm baseline against the SAME data dir ─────────────────
    //
    if (engineVersionChanged) {
      const baselineEnv = instanceEnv(current!, homeRoot);
      dataDirHashBefore = hashDataDir(dataDir!);
      baselineStart = await runFlairCliRaw(
        cliPathBaseline,
        ["start", "--port", String(new URL(current!.httpURL).port)],
        baselineEnv,
        CLI_TIMEOUT_MS,
      );
      dataDirHashAfter = hashDataDir(dataDir!);
    } else {
      try {
        baseline = await startHarper({ cwd: pkgDirBaseline, harperBinDir: pkgDirBaseline, installDir: dataDir, homeDir: homeRoot });
      } catch (err) {
        baselineBootError = err as Error;
      }
    }
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    // Restore CONFIRM_DOWNGRADE — this suite mutates the real process env, so
    // leaving it set would silently pre-answer the prompt for anything else
    // sharing this process.
    if (priorConfirmDowngrade === undefined) delete process.env.CONFIRM_DOWNGRADE;
    else process.env.CONFIRM_DOWNGRADE = priorConfirmDowngrade;

    // baseline never owns dataDir (passed explicitly via `installDir`), so
    // stopHarper(baseline) will not remove it — this suite owns and removes
    // the shared dir itself, once, regardless of which side last touched it.
    if (baseline) await stopHarper(baseline);
    if (homeRoot) await rm(homeRoot, { recursive: true, force: true, maxRetries: 4 });
    if (baselineDir) await rm(baselineDir, { recursive: true, force: true });
  }, 120_000);

  test("npm baseline refuses a store written by this build (engine-version message), before Harper opens it", async () => {
    expect(engineVersionChanged).toBe(true);
    if (engineVersionChanged) {
      // Assert refusal and unchanged regular-file paths and contents.
      expect(baselineStart).not.toBeNull();
      expect(baselineStart!.code).not.toBe(0);
      const output = `${baselineStart!.stdout}\n${baselineStart!.stderr}`;
      // Flair's OWN guard message, not Harper's installer refusal.
      expect(output).toContain("the data directory was written by a newer Harper engine");
      expect(output).toContain("was last written by Harper");
      expect(output).toMatch(/newer/);
      // Regular-file paths and contents unchanged.
      expect(dataDirHashBefore).not.toBeNull();
      expect(dataDirHashBefore!.length).toBeGreaterThan(0);
      expect(dataDirHashAfter).toEqual(dataDirHashBefore);
      return;
    }

    if (baselineBootError) {
      assertBaselineDidNotHang(baselineBootError);
      if (isLz4LoudRefusal(baselineBootError.message)) {
        return;
      }
      throw new Error(
        `npm baseline failed to boot against current-build data — this is a REAL downgrade break, ` +
        `not a test bug. docs/upgrade.md's compatibility statement must be updated to say so.\n` +
        `${baselineBootError.stack ?? baselineBootError.message}`,
      );
    }
    expect(baseline).not.toBeNull();
    const res = await fetch(`${baseline!.httpURL}/Health`);
    expect(res.status).toBeGreaterThan(0);
  }, CLI_TIMEOUT_MS);

  test("memory read when the npm baseline boots", async () => {
    if (engineVersionChanged) {
      return;
    }
    assertBaselineDidNotHang(baselineBootError);
    if (baselineBootError) {
      if (isLz4LoudRefusal(baselineBootError.message)) return;
      throw new Error("skipped: baseline never booted — see the boot test above for the documented failure");
    }
    const rows = await fetchAgentMemories(baseline!, AGENT_ID);
    expect(rows.some((r) => String(r.content ?? "").includes(memoryMarker))).toBe(true);
  }, CLI_TIMEOUT_MS);

  test("presence read when the npm baseline boots", async () => {
    if (engineVersionChanged) {
      return;
    }
    assertBaselineDidNotHang(baselineBootError);
    if (baselineBootError) {
      if (isLz4LoudRefusal(baselineBootError.message)) return;
      throw new Error("skipped: baseline never booted — see the boot test above for the documented failure");
    }
    // GET /Presence needs a verified reader since 0.56.0 (PRESENCE_PUBLIC_ROSTER opts
    // back in), and the pinned baseline (0.59.0) is newer than that. Read as the
    // baseline's admin so the check holds for the pinned baseline version.
    const auth = "Basic " + Buffer.from(`admin:${baseline!.admin.password}`).toString("base64");
    const res = await fetch(`${baseline!.httpURL}/Presence`, { headers: { Authorization: auth } });
    expect(res.status).toBe(200);
    const roster = await res.json() as any[];
    const entry = roster.find((r) => r.id === AGENT_ID);
    expect(entry).toBeDefined();
    expect(entry.presenceStatus).toBe("active");
  }, CLI_TIMEOUT_MS);
});

// ─── Classification unit tests (flair#1050) ─────────────────────────────────
// The classifyDowngradeOutcome function is pure — these tests feed it
// simulated exit codes and stderr to assert the classification itself,
// independent of a real Harper boot.

describe("classifyDowngradeOutcome", () => {
  test("exit 0 → booted", () => {
    expect(classifyDowngradeOutcome(0, "").kind).toBe("booted");
  });

  test("exit 124 → hung (the silent-bad-outcome case)", () => {
    const result = classifyDowngradeOutcome(124, "some startup output");
    expect(result.kind).toBe("hung");
    if (result.kind === "hung") {
      expect(result.stderr).toBe("some startup output");
    }
  });

  test("exit null → refusal (process killed by signal, not a timeout)", () => {
    const result = classifyDowngradeOutcome(null, "Killed\n");
    expect(result.kind).toBe("refusal");
    if (result.kind === "refusal") {
      expect(result.exitCode).toBe(-1);
    }
  });

  test("non-zero exit (not 124) → refusal", () => {
    const result = classifyDowngradeOutcome(1, "Harper v5.2.0 wrote this data directory; you are running v5.1.17. Restore the pre-upgrade snapshot.");
    expect(result.kind).toBe("refusal");
    if (result.kind === "refusal") {
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Harper");
    }
  });

  test("exit 124 with Harper-naming stderr is still hung, not refusal", () => {
    // A hang is a hang regardless of what stderr says — exit 124 means
    // the timeout command killed it, not that it printed a message and exited.
    const result = classifyDowngradeOutcome(124, "Harper engine version mismatch");
    expect(result.kind).toBe("hung");
  });

  test("LZ4 in a startHarper timeout is hung, not loud refusal", () => {
    const timedOut =
      "Harper startup timed out after 60000ms. Log:\nLZ4 not supported in this build";
    const noHealth =
      "Harper at http://127.0.0.1:1 did not respond within 60000ms (120 attempts). " +
      "Process still alive. Harper log:\nLZ4 not supported in this build";
    expect(isHungBootMessage(timedOut)).toBe(true);
    expect(isHungBootMessage(noHealth)).toBe(true);
    expect(isLz4LoudRefusal(timedOut)).toBe(false);
    expect(isLz4LoudRefusal(noHealth)).toBe(false);
    expect(isLz4LoudRefusal("Error: LZ4 not supported in this build")).toBe(true);
    expect(isHungBootMessage("Error: LZ4 not supported in this build")).toBe(false);
  });
});
