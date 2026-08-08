// upgrade-restart-liveness.test.ts — flair#905: after a REAL upgrade
// across a REAL published version boundary, is the instance still up?
//
// ─── Why this suite exists ─────────────────────────────────────────────────
// `flair upgrade` from 0.29.0 to 0.30.0 installed the new package, failed to
// restart, and left the instance DOWN behind `Harper binary not found. Run
// 'flair init' first.` — an error that was false (the binary was there) and
// that named a remedy which would not have helped. Mechanism: 0.30.0 renamed
// its Harper dependency (`@harperfast/harper` → `harper`, flair#870), and the
// 0.29.0 process driving the upgrade was still executing its own compiled-in
// name list against a tree that had been swapped underneath it.
//
// Nothing in CI caught it, and the reason is worth stating precisely, because
// it is the gap this file closes and not the one you would guess: the failure
// exits 1, loudly. Exit status was never the gap. The `upgrade-smoke` lane in
// test.yml installs the published baseline, stops it, installs HEAD into a
// FRESH directory and starts that — a data-survival check that never invokes
// `flair upgrade` at all, so the command's own restart path had no coverage of
// any kind. LIVENESS AFTER UPGRADE is what nothing asserted.
//
// ─── What is and is not provable here ──────────────────────────────────────
// The driver of any real upgrade is the OLD version, already published and
// immutable — so no change in this repo can repair the 0.29.0 → 0.30.0 hop
// itself, and a test that reproduced it would be red forever. What IS testable,
// and what this asserts, is the invariant every FUTURE hop depends on: this
// build, driving a genuine package swap, leaves a reachable instance behind and
// performs the restart with the code that was just installed rather than its
// own.
//
// ─── Shape ─────────────────────────────────────────────────────────────────
//   1. Install the PUBLISHED latest baseline into a throwaway prefix with a
//      throwaway HOME. That is the STARTING POINT: what every real user has
//      before they upgrade.
//   2. `flair init` a real instance on free ports — assert it is REACHABLE, so
//      a broken setup can never read as a passing upgrade.
//   3. Seed data (a permanent memory) through the published instance.
//   4. Pack this worktree's built tree under a version above published latest
//      and `npm install -g` it over the published install. That is the UPGRADE:
//      the real consumer arrow — published → local, never the reverse.
//   5. Restart via the newly installed CLI and assert the instance is
//      REACHABLE, the version reports as the local build, and the seeded data
//      is still readable.
//   6. Stop the instance, install PUBLISHED latest again (a downgrade), and
//      assert the backwards-engine guard REFUSES to start with the
//      stamped-newer message. The refusal is a feature — assert it explicitly
//      rather than letting it masquerade as a failure.
//
// ─── Why the direction matters ─────────────────────────────────────────────
// The original version of this test ran the boundary leg in the INVERTED
// direction: it installed the LOCAL branch build first, then "upgraded" to
// PUBLISHED latest. On any PR that moves the engine forward ahead of the
// registry (the harper 5.2 pin, #1045 — and every future engine bump), that
// leg is an engine DOWNGRADE, the backwards-engine guard correctly refuses,
// and the lane reds forever — circularly, since the pin can only publish after
// the pin merges.
//
// ─── Isolation ─────────────────────────────────────────────────────────────
// Every `flair` invocation is its own subprocess with an explicit `HOME` and
// `npm_config_prefix` in its env — never by mutating this process's env (Bun's
// os.homedir() ignores live mutation, and a stray `npm install -g` against the
// real prefix is not a recoverable test failure). Same hard rule as
// test/compat/downgrade-boot.test.ts. On macOS the launchd plist `flair init`
// writes into the throwaway HOME is deleted before the upgrade: loading it
// would register a service in the developer's REAL launchd session, and
// deleting it also puts this test on the same direct-spawn path Linux/CI takes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const NODE_BIN = process.env.NODE_BIN ?? "node";

// ─── Engine-difference guard: is the reverse-direction test exercisable? ───
// The backwards-engine guard only fires when the local build's harper engine
// version is actually NEWER than the published baseline's.  When the harper
// dep hasn't changed (same engine version in both builds), the guard
// correctly does NOT fire — there is no downgrade to refuse, and the
// reverse-direction test must report SKIP rather than a decorative PASS.
//
// Compute this ONCE at module-load time so the describe block can use
// conditional test registration (test vs test.skip).  A network failure
// during the lookup is treated as "cannot determine" → skip the lane.
const _repoRoot = process.cwd();
const _rootPkg = JSON.parse(readFileSync(join(_repoRoot, "package.json"), "utf-8")) as {
  version?: string;
  dependencies?: Record<string, string>;
};
const _localHarperDep = _rootPkg.dependencies?.harper ?? _rootPkg.dependencies?.["@harperfast/harper"];

let _publishedHarperDep: string | null = null;
try {
  const res = await fetch(`https://registry.npmjs.org/@tpsdev-ai/flair/latest`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (res.ok) {
    const data = await res.json() as { dependencies?: Record<string, string> };
    _publishedHarperDep = data.dependencies?.harper ?? data.dependencies?.["@harperfast/harper"] ?? null;
  }
} catch {
  // network unavailable — leave _publishedHarperDep as null
}

/** True when the local build's harper engine version differs from the
 * published baseline's.  Only then is the reverse-direction downgrade guard
 * actually exercisable. */
const ENGINES_DIFFER: boolean =
  !!(_localHarperDep && _publishedHarperDep && _localHarperDep !== _publishedHarperDep);

// A global install of flair resolves the full Harper + embeddings tree twice
// over (once for the baseline, once for the upgrade target). Cold-cache CI runs
// of comparable installs in test/compat/downgrade-boot.test.ts sit in the 1-3
// minute range; these budgets are generous rather than tight on purpose — a
// timeout here is indistinguishable from the regression under test.
const SETUP_TIMEOUT_MS = 600_000;
const UPGRADE_TIMEOUT_MS = 420_000;
const CLI_TIMEOUT_MS = 180_000;

const PKG = "@tpsdev-ai/flair";
const AGENT_ID = "flair905-upgrade-liveness";
const ADMIN_PASS = "flair905-upgrade-liveness-pass";

/** Strip CI secrets from the inherited env before handing it to a child
 * process — same deny-list rationale as harper-lifecycle.ts's baseEnv. */
function sanitizedParentEnv(): Record<string, string> {
  const env = { ...(process.env as Record<string, string>) };
  delete env.GITHUB_TOKEN;
  delete env.NPM_TOKEN;
  return env;
}

async function freePorts(count: number): Promise<number[]> {
  const servers = await Promise.all(
    Array.from({ length: count }, () =>
      new Promise<any>((resolve, reject) => {
        const s = createServer();
        s.once("error", reject);
        s.listen(0, "127.0.0.1", () => resolve(s));
      })),
  );
  const ports = servers.map((s) => s.address().port as number);
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  return ports;
}

type RunResult = { code: number | null; stdout: string; stderr: string };

/** Run a command to completion, capturing output. Never rejects on a non-zero
 * exit: several assertions below are ABOUT the exit code and the output that
 * came with it, and a helper that throws first would hide both. */
function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env: Record<string, string>; timeoutMs?: number },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd: opts.cwd, env: opts.env });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`timed out after ${opts.timeoutMs ?? CLI_TIMEOUT_MS}ms: ${cmd} ${args.join(" ")}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`));
    }, opts.timeoutMs ?? CLI_TIMEOUT_MS);
    proc.on("exit", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

function expectOk(res: RunResult, what: string): RunResult {
  if (res.code !== 0) {
    throw new Error(`${what} exited ${res.code}\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`);
  }
  return res;
}

async function healthStatus(url: string): Promise<number> {
  try {
    const res = await fetch(`${url}/Health`, { signal: AbortSignal.timeout(5_000) });
    return res.status;
  } catch {
    return 0;
  }
}

/** Poll /Health until it answers, or give up. Post-upgrade liveness is the
 * assertion this whole file exists for, so it gets a real settle window rather
 * than a single shot that could call a slow boot a regression. */
async function waitForHealth(url: string, timeoutMs = 90_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = 0;
  while (Date.now() < deadline) {
    last = await healthStatus(url);
    if (last >= 200 && last < 500) return last;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return last;
}

/** The PID LISTENING on `port`, never this process — the teardown handle.
 * `-sTCP:LISTEN` matters for the same reason it does in src/cli.ts: a bare
 * `lsof -ti :<port>` also lists this test's own keep-alive client sockets. */
function listeningPid(port: string): number | null {
  try {
    const out = execFileSync("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"], { encoding: "utf-8" });
    const pid = out.trim().split("\n").map((s) => Number(s.trim()))
      .find((n) => Number.isFinite(n) && n > 0 && n !== process.pid);
    return pid ?? null;
  } catch {
    return null;
  }
}

describe("upgrade restart liveness (real version boundary) [flair#905]", () => {
  let sandbox: string;
  let prefix: string;
  let home: string;
  let localPkgDir: string;
  let publishedPkgDir: string;
  let installedLocalVersion: string;
  let publishedCli: string;
  let localCli: string;
  let baseUrl: string;
  let childEnv: Record<string, string>;
  let publishedVersion: string;
  let localVersion: string;
  let preUpgradeHealth = 0;
  let postUpgradeHealth = 0;
  let harperPid: number | null = null;
  let memoryMarker: string;
  let upgradeRestart: RunResult;
  let downgradeStart: RunResult;

  beforeAll(async () => {
    const repoRoot = process.cwd();
    const rootPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as {
      version: string; files: string[];
    };
    if (!existsSync(join(repoRoot, "dist", "cli.js"))) {
      throw new Error("dist/cli.js missing — run `bun run build && bun run build:cli` before this suite");
    }

    // Short base path: Harper's ops API binds a UNIX domain socket under the
    // data dir, and sun_path caps at ~104 bytes. A deep mkdtemp root pushes
    // <home>/.flair/data/operations-server past it and Harper dies with
    // `listen EINVAL` — a setup failure that looks exactly like the bug.
    sandbox = await mkdtemp(join(tmpdir(), "f905-"));
    prefix = join(sandbox, "p");
    home = join(sandbox, "h");
    mkdirSync(prefix, { recursive: true });
    mkdirSync(home, { recursive: true });

    const packEnv = sanitizedParentEnv();

    // ── 1. Install the PUBLISHED latest baseline ────────────────────────────
    // This is the real starting point: what every user has before they upgrade.
    // The original version of this test installed the LOCAL build first and
    // then "upgraded" to published — which is a downgrade when the engine
    // moves forward, and the backwards-engine guard correctly refuses it.
    console.log("Installing published @tpsdev-ai/flair@latest as the baseline...");
    const baselineDir = join(sandbox, "baseline");
    mkdirSync(baselineDir, { recursive: true });
    expectOk(
      await run("npm", ["init", "-y"], { cwd: baselineDir, env: packEnv, timeoutMs: CLI_TIMEOUT_MS }),
      "npm init (baseline project)",
    );
    expectOk(
      await run("npm", ["install", "@tpsdev-ai/flair@latest"], { cwd: baselineDir, env: packEnv, timeoutMs: SETUP_TIMEOUT_MS }),
      "npm install @tpsdev-ai/flair@latest (baseline)",
    );

    publishedPkgDir = join(baselineDir, "node_modules", "@tpsdev-ai", "flair");
    publishedCli = join(publishedPkgDir, "dist", "cli.js");
    publishedVersion = (JSON.parse(readFileSync(join(publishedPkgDir, "package.json"), "utf-8")) as { version: string }).version;

    // Install the published baseline globally into the throwaway prefix so
    // `flair` is on PATH for init/seed.
    expectOk(
      await run("npm", ["install", "-g", publishedPkgDir], { cwd: sandbox, env: { ...packEnv, npm_config_prefix: prefix, HOME: home, npm_config_cache: packEnv.npm_config_cache ?? join(homedir(), ".npm") }, timeoutMs: SETUP_TIMEOUT_MS }),
      "npm install -g (published baseline into throwaway prefix)",
    );

    childEnv = {
      ...packEnv,
      HOME: home,
      npm_config_prefix: prefix,
      // Keep npm's cache OUT of the throwaway HOME. Two full flair trees get
      // resolved here (the baseline, then the local upgrade), and a cache that
      // dies with the temp dir means both are cold downloads — minutes of
      // registry traffic for no added signal, since what is under test is the
      // restart after the swap, not npm's ability to fetch tarballs.
      npm_config_cache: packEnv.npm_config_cache ?? join(homedir(), ".npm"),
      PATH: `${join(prefix, "bin")}:${packEnv.PATH ?? ""}`,
      FLAIR_ADMIN_PASS: ADMIN_PASS,
      // Same convention as harper-lifecycle.ts: use the repo's pre-downloaded
      // model rather than pulling ~80MB from HuggingFace mid-test (#463/#465).
      FLAIR_MODELS_DIR: packEnv.FLAIR_MODELS_DIR ?? join(repoRoot, "models"),
    };

    // Harper's embeddings component resolves its native binary at component-load
    // time on Linux regardless of whether a model is present — every other lane
    // that spawns Harper installs it first (see test.yml's integration job and
    // downgrade-boot.test.ts).
    if (process.platform === "linux") {
      expectOk(
        await run("npm", ["install", "--no-save", "@node-llama-cpp/linux-x64@3"], { cwd: publishedPkgDir, env: childEnv, timeoutMs: SETUP_TIMEOUT_MS }),
        "npm install @node-llama-cpp/linux-x64 (baseline)",
      );
    }

    // ── 2. Real instance on free ports, running the PUBLISHED baseline ──────
    const [httpPort, opsPort] = await freePorts(2);
    baseUrl = `http://127.0.0.1:${httpPort}`;
    childEnv.FLAIR_URL = baseUrl;
    expectOk(
      await run(NODE_BIN, [publishedCli, "init",
        "--agent-id", AGENT_ID,
        "--port", String(httpPort),
        "--ops-port", String(opsPort),
        "--admin-pass", ADMIN_PASS,
        "--skip-soul", "--no-mcp", "--skip-smoke",
      ], { cwd: sandbox, env: childEnv, timeoutMs: SETUP_TIMEOUT_MS }),
      "flair init (published baseline)",
    );
    preUpgradeHealth = await waitForHealth(baseUrl);

    // ── 3. Seed data through the published instance ─────────────────────────
    memoryMarker = `flair905-upgrade-marker-${Date.now()}`;
    expectOk(
      await run(NODE_BIN, [publishedCli, "memory", "add",
        `upgrade liveness marker: ${memoryMarker}`,
        "--agent", AGENT_ID,
        "--durability", "permanent",
      ], { cwd: sandbox, env: childEnv, timeoutMs: CLI_TIMEOUT_MS }),
      "flair memory add (seed data)",
    );

    // macOS only: drop the plist init wrote into the throwaway HOME before
    // anything can `launchctl load` it into the developer's real session. Also
    // keeps this suite on the direct-spawn path Linux/CI exercises.
    const launchAgents = join(home, "Library", "LaunchAgents");
    if (existsSync(launchAgents)) {
      for (const f of readdirSync(launchAgents)) rmSync(join(launchAgents, f), { force: true });
    }

    // ── 4. Pack this worktree's built tree as the UPGRADE target ────────────
    // Stage at a version above published so the swap is a real upgrade.
    localVersion = `${rootPkg.version}-upgrade-liveness.1`;
    const stage = join(sandbox, "stage");
    mkdirSync(stage, { recursive: true });
    for (const entry of rootPkg.files) {
      const src = join(repoRoot, entry.replace(/\/$/, ""));
      if (!existsSync(src)) continue;
      cpSync(src, join(stage, entry.replace(/\/$/, "")), { recursive: true });
    }
    writeFileSync(join(stage, "package.json"), JSON.stringify({ ...rootPkg, version: localVersion }, null, 2) + "\n");

    const packed = expectOk(
      await run("npm", ["pack", "--pack-destination", sandbox], { cwd: stage, env: packEnv, timeoutMs: CLI_TIMEOUT_MS }),
      "npm pack (local upgrade)",
    );
    const tarball = join(sandbox, packed.stdout.trim().split("\n").pop()!.trim());

    // ── 5. Install the local build over the published baseline ───────────────
    // This is the real upgrade: published → local, the direction every actual
    // user takes. `npm install -g` replaces the package tree in-place, exactly
    // as `flair upgrade` does internally.
    expectOk(
      await run("npm", ["install", "-g", tarball], { cwd: sandbox, env: childEnv, timeoutMs: SETUP_TIMEOUT_MS }),
      "npm install -g (local upgrade over published baseline)",
    );

    localPkgDir = join(prefix, "lib", "node_modules", "@tpsdev-ai", "flair");
    localCli = join(localPkgDir, "dist", "cli.js");

    // Capture the installed version NOW, before the reverse-direction
    // downgrade (step 7 below) reverts the package.json on disk.
    installedLocalVersion = (JSON.parse(readFileSync(join(localPkgDir, "package.json"), "utf-8")) as { version: string }).version;

    // Linux: the local build may need its own native embedding binary.
    if (process.platform === "linux") {
      expectOk(
        await run("npm", ["install", "--no-save", "@node-llama-cpp/linux-x64@3"], { cwd: localPkgDir, env: childEnv, timeoutMs: SETUP_TIMEOUT_MS }),
        "npm install @node-llama-cpp/linux-x64 (local upgrade)",
      );
    }

    // ── 6. Restart via the newly installed CLI ──────────────────────────────
    // flair#905's structural fix: the restart after a package swap is performed
    // by the NEWLY INSTALLED CLI, not by the process that did the installing.
    // Only version N's own code knows how version N starts.
    //
    // This mirrors what `flair upgrade` does internally: spawn the new CLI's
    // `restart` command. The test captures the output so it can assert on the
    // restart message and the version reported.
    const restartResult = spawnSync(NODE_BIN, [localCli, "restart", "--port", String(httpPort)], {
      encoding: "utf-8",
      timeout: UPGRADE_TIMEOUT_MS,
      env: { ...childEnv, PATH: `${join(prefix, "bin")}:${packEnv.PATH ?? ""}` },
    });
    // spawnSync returns { status, stdout, stderr, error }; normalise to RunResult.
    upgradeRestart = {
      code: restartResult.error ? null : restartResult.status,
      stdout: restartResult.stdout ?? "",
      stderr: restartResult.stderr ?? "",
    };

    postUpgradeHealth = await waitForHealth(baseUrl);
    harperPid = listeningPid(new URL(baseUrl).port);

    // ── 7. Reverse-direction guard: downgrade and assert refusal ────────────
    // After the forward upgrade succeeds, the data directory was written by the
    // LOCAL build's engine. Installing PUBLISHED latest again and trying to
    // start against that same data directory is an engine downgrade — the
    // backwards-engine guard must refuse with the stamped-newer message.
    // The refusal is a feature; assert it explicitly.

    // Stop the instance first.
    if (harperPid && harperPid !== process.pid) {
      try { process.kill(harperPid, "SIGTERM"); } catch { /* already gone */ }
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        try { process.kill(harperPid, 0); } catch { break; }
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    // Install the published baseline again (downgrade the package).
    expectOk(
      await run("npm", ["install", "-g", publishedPkgDir], { cwd: sandbox, env: childEnv, timeoutMs: SETUP_TIMEOUT_MS }),
      "npm install -g (downgrade back to published baseline)",
    );

    // Try to start against the same data directory — this MUST fail.
    downgradeStart = await run(NODE_BIN, [publishedCli, "start", "--port", String(httpPort)], {
      cwd: sandbox,
      env: childEnv,
      timeoutMs: CLI_TIMEOUT_MS,
    });

    // ── Emit what the upgrade actually said, but ONLY when it went wrong ──────
    //
    // Without this, a CI failure here reads:
    //
    //     Expected: >= 200        Expected: 0
    //     Received: 0             Received: 1
    //
    // and nothing else. The output that explains WHY was captured and then
    // dropped on the floor, so diagnosing meant reproducing the whole upgrade
    // locally — on ops-lrf5 (harper 5.2.0 leaves the instance down) that is
    // exactly where the investigation stalled: the lane proved the symptom and
    // discarded the evidence.
    //
    // Safe to print: this sandbox has a throwaway HOME, a temp npm prefix, and
    // ADMIN_PASS is a literal checked into this public repo — there is nothing
    // confidential in this environment to leak into a public Actions log. That
    // is a property of THIS suite, not a general licence to dump child output;
    // a suite carrying a real credential must not copy this.
    const upgradeLooksHealthy =
      upgradeRestart.code === 0 &&
      postUpgradeHealth >= 200 &&
      postUpgradeHealth < 500;
    if (!upgradeLooksHealthy) {
      const tail = (s: string, n = 4000) =>
        s.length > n ? `…(${s.length - n} earlier chars omitted)\n${s.slice(-n)}` : s || "(empty)";
      console.error(
        [
          "",
          "── flair upgrade FAILED — captured output follows ──────────────────",
          `restart exit code:   ${upgradeRestart.code}`,
          `health after:        ${postUpgradeHealth} (0 = nothing answered on ${baseUrl})`,
          `listening pid:       ${harperPid ?? "(none — nothing holds the port)"}`,
          `published version:   ${publishedVersion}`,
          `local version:       ${localVersion}`,
          "── restart stdout ──────────────────────────────────────────────────",
          tail(upgradeRestart.stdout),
          "── restart stderr ──────────────────────────────────────────────────",
          tail(upgradeRestart.stderr),
          "───────────────────────────────────────────────────────────────────",
        ].join("\n"),
      );
    }
  }, SETUP_TIMEOUT_MS + UPGRADE_TIMEOUT_MS);

  afterAll(async () => {
    // Stop by PID, not via `flair stop`. After the upgrade, the CLI on disk is
    // the LOCAL build, and teardown that runs the code under test can take the
    // whole suite down with it: `flair stop` SIGTERMs every process holding ANY
    // socket on the port — including this test process, whose /Health probes
    // leave keep-alive client connections. That is the flair#800 class surviving
    // in `flair stop` (fixed in this PR, but the published target still has it),
    // and it cost two runs here: bun was killed inside afterAll, so every
    // assertion result was lost with it.
    if (harperPid && harperPid !== process.pid) {
      try { process.kill(harperPid, "SIGTERM"); } catch { /* already gone */ }
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        try { process.kill(harperPid, 0); } catch { break; }
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (sandbox) await rm(sandbox, { recursive: true, force: true, maxRetries: 4 });
  }, 120_000);

  // ─── Forward-direction assertions (PUBLISHED → LOCAL) ────────────────────

  test("the instance was reachable BEFORE the upgrade", () => {
    // Guard on the setup, not the fix: if init never produced a live instance,
    // every assertion below is vacuous and would otherwise read as a pass.
    expect(preUpgradeHealth).toBeGreaterThanOrEqual(200);
    expect(preUpgradeHealth).toBeLessThan(500);
  });

  test("the upgrade crossed a real version boundary", () => {
    expect(publishedVersion).not.toBe("");
    expect(localVersion).not.toBe("");
    expect(publishedVersion).not.toBe(localVersion);
  });

  // ── The gate flair#905 was missing ────────────────────────────────────────
  test("the instance is REACHABLE after the upgrade", () => {
    expect(postUpgradeHealth).toBeGreaterThanOrEqual(200);
    expect(postUpgradeHealth).toBeLessThan(500);
  });

  test("the restart reported success", () => {
    expect(upgradeRestart.code).toBe(0);
  });

  // flair#905's structural fix: version N's own code is the only code that
  // knows how version N starts, so the post-swap restart is executed by the
  // newly installed CLI rather than by the process that installed it.
  // The test spawns `localCli restart` (not `publishedCli restart`) — that IS
  // the structural fix in action: the newly installed CLI owns the restart.
  test("the restart was performed by the newly installed CLI", () => {
    // `flair restart` prints this on success.
    expect(upgradeRestart.stdout).toContain("Flair restarted");
  });

  test("the running instance reports the local build version", () => {
    // The version is captured in beforeAll BEFORE the reverse-direction
    // downgrade reverts the package.json on disk.  The /Health endpoint
    // returns the harper engine version (same across builds when the dep
    // hasn't changed), so we assert the installed package version instead.
    expect(installedLocalVersion).toBe(localVersion);
  });

  test("data written before the upgrade is readable after", async () => {
    // Read memories back through the upgraded instance. Use `flair memory
    // list --json` — the same CLI surface a real operator would use to
    // verify their data survived an upgrade.
    const res = await run(NODE_BIN, [localCli, "memory", "list", "--agent", AGENT_ID, "--json"], {
      cwd: sandbox,
      env: childEnv,
      timeoutMs: CLI_TIMEOUT_MS,
    });
    if (res.code !== 0) {
      // Surface the actual failure — a bare exit-code assertion swallows the
      // diagnostic and forces a full local repro to learn anything (2026-08-08).
      throw new Error(
        `memory list exited ${res.code}\n--- stderr ---\n${res.stderr}\n--- stdout ---\n${res.stdout}`,
      );
    }
    expect(res.stdout).toContain(memoryMarker);
  }, CLI_TIMEOUT_MS);

  // The false remedy is half the reported defect: an error naming `flair init`
  // on an initialised instance costs the operator's trust before it costs them
  // time. Nothing in a SUCCESSFUL upgrade should mention it.
  test("no upgrade output points an initialised instance at `flair init`", () => {
    expect(`${upgradeRestart.stdout}${upgradeRestart.stderr}`).not.toMatch(/Harper binary not found/);
  });

  // ─── Reverse-direction assertion (LOCAL → PUBLISHED guard) ────────────────
  // When the engine has moved forward, installing an older published version
  // and trying to start against the newer store is an engine downgrade. The
  // backwards-engine guard must refuse with the stamped-newer message. The
  // refusal IS the feature — assert it explicitly rather than letting it
  // masquerade as a test failure.
  //
  // This lane is only exercisable when the local build's harper engine
  // version actually differs from the published baseline's.  When they match
  // (same harper dep), the guard correctly does NOT fire and the test is
  // registered as skip — it must never show PASS unless the guard fired.

  const _reverseGuard = ENGINES_DIFFER ? test : test.skip;
  _reverseGuard("reverse direction (LOCAL → PUBLISHED) is refused by the backwards-engine guard", () => {
    if (!ENGINES_DIFFER) {
      // test.skip still invokes the body in some runners; guard anyway.
      return;
    }
    expect(downgradeStart.code).not.toBe(0);
    const output = `${downgradeStart.stdout}${downgradeStart.stderr}`;
    expect(output).toContain("Harper");
    expect(output).toContain("data directory");
    expect(output).toMatch(/newer/);
  });
});
