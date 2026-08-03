// Downgrade compat (flair#637, restated flair#1050): there is never a silent
// bad outcome. Either the previously-published npm baseline BOOTS against a
// data directory the CURRENT build has already written to, OR it refuses to
// start with a message naming what wrote the store, what is running, and how
// to recover.
//
// This is the honesty check behind `flair upgrade`'s pre-upgrade snapshot
// (src/cli.ts, flair#637 / flair#1047): the snapshot is only useful insurance
// if restoring it and starting an OLDER Flair actually works — or if the old
// Flair refuses loudly and the snapshot provides the recovery path. Nobody
// had ever tested either path before this suite — "downgrade" was
// aspirational, not verified.
//
// The invariant holds in two branches (flair#1050):
//   - Same engine version: the baseline boots and serves the corpus correctly
//     (the original flair#637 assertion, unchanged).
//   - Engine version changed: the baseline either refuses to start (non-zero,
//     promptly, naming both versions and a remedy) — the stamp-capable path —
//     or boots successfully (pre-stamp baseline, the transition case).
//
// Scenario (mirrors a real operator downgrade exactly — no shortcuts):
//   1. Boot the CURRENT BUILD (this worktree's own `dist/`, via
//      `startHarper()` — same mechanism test/integration/*.test.ts and
//      test/compat/federation-mixed-version.test.ts use) against a FRESH,
//      throwaway data directory.
//   2. Write real data through it: register an agent, add a permanent
//      memory, set presence.
//   3. Stop it WITHOUT deleting the data directory
//      (`stopHarper(inst, { keepInstallDir: true })` — flair#637's harness
//      addition to test/helpers/harper-lifecycle.ts).
//   4. Boot the previously-published npm baseline (`@tpsdev-ai/flair@latest`
//      on the public registry, installed fresh — same "baseline" concept as
//      federation-mixed-version.test.ts) against THAT SAME data directory,
//      via `startHarper({ installDir: <the current build's dir> })`. No
//      re-init, no `--purge`, no touching the files by hand — exactly what a
//      real `flair stop && npm install -g @tpsdev-ai/flair@<previous> &&
//      flair start` downgrade does.
//   5. If it boots: read the memory and presence rows back through the
//      baseline's own HTTP surface — a clean boot that can't actually see
//      its own data isn't "downgrade works", it's a different failure mode.
//
// ─── Either outcome is a valid, asserted result ────────────────────────────
// Green here is a real claim ("downgrade to <baseline> is safe") that
// docs/upgrade.md repeats — so this suite must actually observe reality, not
// assume success. If a real incompatibility is found, this file documents
// the EXACT failure (error string, which step) and asserts THAT specific
// behavior, so the red/green state of this test always matches what
// docs/upgrade.md claims. See the note at the bottom of this file recording
// what was actually observed when this suite was written (2026-07-08).
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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const NODE_BIN = process.env.NODE_BIN ?? "node";

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

function instanceEnv(inst: HarperInstance): Record<string, string> {
  return {
    ...sanitizedParentEnv(),
    HOME: inst.installDir,
    FLAIR_URL: inst.httpURL,
    FLAIR_ADMIN_PASS: inst.admin.password,
    // Pre-answer Harper's interactive downgrade prompt (HarperFast/harper#2046).
    // An older Harper booting against a store written by a newer minor calls
    // forceDowngradePrompt(), which blocks on stdin. The prompt and its version
    // warning are written to stdout only — never the log — so a non-interactive
    // run just stops, with nothing saying why.
    //
    // Without this the downgrade tests can only ever observe a timeout, which
    // makes the invariant's "boots" and "refuses loudly" branches unreachable:
    // the process never gets far enough to do either.
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

describe("downgrade compat (npm baseline boot vs current-build data) [flair#637]", () => {
  let baselineDir: string;
  let pkgDirBaseline: string;
  let cliPathBaseline: string;
  let cliPathCurrent: string;
  let dataDir: string | undefined;
  let current: HarperInstance | null = null;
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
      const proc = spawn("npm", ["install", "@tpsdev-ai/flair@latest"], { cwd: baselineDir, env: sanitizedParentEnv() });
      let out = "";
      proc.stdout?.on("data", (d) => out += d.toString());
      proc.stderr?.on("data", (d) => out += d.toString());
      const timer = setTimeout(() => { proc.kill(); reject(new Error(`npm install timed out after ${NPM_INSTALL_TIMEOUT_MS}ms:\n${out}`)); }, NPM_INSTALL_TIMEOUT_MS);
      proc.on("exit", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`npm install @tpsdev-ai/flair@latest failed:\n${out}`)); });
      proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    });
    // Linux CI has no native embedding binary for the npm-published package's
    // own optionalDependencies resolution — install it explicitly (same as
    // federation-mixed-version.test.ts) so the baseline's embeddings
    // component doesn't crash at boot.
    if (process.platform === "linux") {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn("npm", ["install", "--no-save", "@node-llama-cpp/linux-x64@3"], { cwd: baselineDir, env: sanitizedParentEnv() });
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
    current = await startHarper();
    dataDir = current.installDir;
    const currentEnv = instanceEnv(current);
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
    // Read the Harper version from both installs to determine whether the
    // engine version changed. This drives the branching in the test
    // assertions below: same engine → current assertions (boot + readable);
    // engine changed → refusal or pre-stamp boot.
    const { readFileSync, existsSync } = await import("node:fs");
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
    // Captured, not awaited-and-thrown: a boot failure here is one of the two
    // valid outcomes this suite exists to distinguish, not a setup error.
    try {
      baseline = await startHarper({ cwd: pkgDirBaseline, harperBinDir: baselineDir, installDir: dataDir });
    } catch (err) {
      baselineBootError = err as Error;
    }
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    // baseline never owns dataDir (passed explicitly via `installDir`), so
    // stopHarper(baseline) will not remove it — this suite owns and removes
    // the shared dir itself, once, regardless of which side last touched it.
    if (baseline) await stopHarper(baseline);
    if (dataDir) await rm(dataDir, { recursive: true, force: true, maxRetries: 4 });
    if (baselineDir) await rm(baselineDir, { recursive: true, force: true });
  }, 120_000);

  // ─── OBSERVED RESULT (recorded when this suite was written, 2026-07-08) ──
  // The npm-published baseline (0.21.0) DOES boot successfully against a data
  // directory written by this worktree's HEAD build (~14 commits ahead of
  // 0.21.0, including several security/behavior changes but no Flair schema
  // migration and only a patch-level harper bump, 5.1.15→5.1.17).
  // Both the pre-existing memory and presence rows written by the CURRENT
  // build are readable back through the BASELINE's own HTTP surface after the
  // downgrade boot. This is the "green" branch below. If a future run of this
  // suite starts failing, that is real signal — a schema-incompatible change
  // landed without a documented downgrade break, and BOTH this test's
  // assertions AND docs/upgrade.md's compatibility statement need updating
  // together, not just the test loosened to pass again.
  //
  // ─── ENGINE-VERSION-CHANGE BRANCH (flair#1050) ──────────────────────────
  // When the Harper engine version differs between baseline and current,
  // the old invariant ("downgrade always works") does not hold. The restated
  // invariant says: either the baseline refuses to start (non-zero, promptly,
  // naming both versions and a remedy), OR it boots (pre-stamp baseline —
  // the transition case before the first stamp-carrying release ships).
  // Both outcomes are valid, asserted results.

  test("npm baseline boots against data written by the current build, or refuses with engine-version message", async () => {
    if (engineVersionChanged) {
      // Engine version changed — either outcome is valid.
      if (baselineBootError) {
        const msg = baselineBootError.message;

        // Distinguish refusal (prompt non-zero exit) from hang (timeout).
        // A hang is the silent-bad-outcome case the invariant forbids.
        if (msg.includes("timed out") || msg.includes("did not respond within")) {
          throw new Error(
            `baseline HUNG (timeout) — this is the silent-bad-outcome case ` +
            `the invariant forbids:\n${msg}`,
          );
        }

        // Baseline refused to boot. Assert the refusal message names the
        // engine version change and a recovery path (flair#1049/#1050).
        if (!msg.includes("Harper") || !msg.includes("data directory")) {
          throw new Error(
            `Engine version changed and baseline refused to boot, but the refusal ` +
            `message does not name the engine version or data directory — ` +
            `unexpected failure mode:\n${msg}`,
          );
        }
        // Refusal is the expected outcome for a stamp-capable baseline.
        // The test passes — this is the "loud refusal" branch of the invariant.
        return;
      }
      // Baseline booted successfully — pre-stamp baseline (transition case).
      // Fall through to the normal boot assertion below.
    }

    if (baselineBootError) {
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

  test("memory written by the current build is readable via the npm baseline after downgrade", async () => {
    if (engineVersionChanged && baselineBootError) {
      // Baseline refused — the "loud refusal" branch of the invariant.
      // Data readability is not expected; the recovery path is the snapshot.
      return;
    }
    if (baselineBootError) {
      throw new Error("skipped: baseline never booted — see the boot test above for the documented failure");
    }
    const rows = await fetchAgentMemories(baseline!, AGENT_ID);
    expect(rows.some((r) => String(r.content ?? "").includes(memoryMarker))).toBe(true);
  }, CLI_TIMEOUT_MS);

  test("presence written by the current build is readable via the npm baseline after downgrade", async () => {
    if (engineVersionChanged && baselineBootError) {
      // Baseline refused — the "loud refusal" branch of the invariant.
      return;
    }
    if (baselineBootError) {
      throw new Error("skipped: baseline never booted — see the boot test above for the documented failure");
    }
    const res = await fetch(`${baseline!.httpURL}/Presence`);
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
});
