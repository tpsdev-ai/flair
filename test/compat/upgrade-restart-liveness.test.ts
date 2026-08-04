// upgrade-restart-liveness.test.ts — flair#905: after a REAL `flair upgrade`
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
//   1. Pack this worktree's built tree under a version above published latest
//      and `npm install -g` it into a throwaway prefix with a throwaway HOME.
//      That is the DRIVER: this PR's actual code, installed the way users have
//      it, not a module imported into the test process.
//   2. `flair init` a real instance on free ports — assert it is REACHABLE, so
//      a broken setup can never read as a passing upgrade.
//   3. `flair upgrade` — a real npm install of the published `latest` over a
//      running install, i.e. the real package swap.
//   4. Assert the instance is REACHABLE, that the swap really happened, and
//      that the restart went through the newly installed CLI.
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
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const NODE_BIN = process.env.NODE_BIN ?? "node";

// A global install of flair resolves the full Harper + embeddings tree twice
// over (once for the driver, once for the upgrade target). Cold-cache CI runs
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

function installedVersion(prefix: string): string | null {
  try {
    const pkgJson = join(prefix, "lib", "node_modules", "@tpsdev-ai", "flair", "package.json");
    return (JSON.parse(readFileSync(pkgJson, "utf-8")) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

describe("upgrade restart liveness (real version boundary) [flair#905]", () => {
  let sandbox: string;
  let prefix: string;
  let home: string;
  let flairCli: string;
  let baseUrl: string;
  let childEnv: Record<string, string>;
  let driverVersion: string;
  let targetVersion: string;
  let upgrade: RunResult;
  let preUpgradeHealth = 0;
  let postUpgradeHealth = 0;
  let harperPid: number | null = null;

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

    // ── 1. Stage this worktree's built tree as a publishable package at a
    // version the registry does not have, so `flair upgrade` sees itself as
    // outdated and performs a REAL swap to published latest. Staged into a temp
    // dir rather than by editing package.json in place: a test that mutates the
    // repo it is testing leaves it dirty on every failure.
    driverVersion = `${rootPkg.version}-upgrade-liveness.1`;
    const stage = join(sandbox, "stage");
    mkdirSync(stage, { recursive: true });
    for (const entry of rootPkg.files) {
      const src = join(repoRoot, entry.replace(/\/$/, ""));
      if (!existsSync(src)) continue;
      cpSync(src, join(stage, entry.replace(/\/$/, "")), { recursive: true });
    }
    writeFileSync(join(stage, "package.json"), JSON.stringify({ ...rootPkg, version: driverVersion }, null, 2) + "\n");

    const packEnv = sanitizedParentEnv();
    const packed = expectOk(
      await run("npm", ["pack", "--pack-destination", sandbox], { cwd: stage, env: packEnv, timeoutMs: CLI_TIMEOUT_MS }),
      "npm pack (driver)",
    );
    const tarball = join(sandbox, packed.stdout.trim().split("\n").pop()!.trim());

    childEnv = {
      ...packEnv,
      HOME: home,
      npm_config_prefix: prefix,
      // Keep npm's cache OUT of the throwaway HOME. Two full flair trees get
      // resolved here (the driver, then the upgrade target), and a cache that
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

    expectOk(
      await run("npm", ["install", "-g", tarball], { cwd: sandbox, env: childEnv, timeoutMs: SETUP_TIMEOUT_MS }),
      "npm install -g (driver)",
    );

    const pkgDir = join(prefix, "lib", "node_modules", "@tpsdev-ai", "flair");
    flairCli = join(pkgDir, "dist", "cli.js");

    // Harper's embeddings component resolves its native binary at component-load
    // time on Linux regardless of whether a model is present — every other lane
    // that spawns Harper installs it first (see test.yml's integration job and
    // downgrade-boot.test.ts).
    if (process.platform === "linux") {
      expectOk(
        await run("npm", ["install", "--no-save", "@node-llama-cpp/linux-x64@3"], { cwd: pkgDir, env: childEnv, timeoutMs: SETUP_TIMEOUT_MS }),
        "npm install @node-llama-cpp/linux-x64",
      );
    }

    // ── 2. Real instance on free ports ───────────────────────────────────────
    const [httpPort, opsPort] = await freePorts(2);
    baseUrl = `http://127.0.0.1:${httpPort}`;
    childEnv.FLAIR_URL = baseUrl;
    expectOk(
      await run(NODE_BIN, [flairCli, "init",
        "--agent-id", AGENT_ID,
        "--port", String(httpPort),
        "--ops-port", String(opsPort),
        "--admin-pass", ADMIN_PASS,
        "--skip-soul", "--no-mcp", "--skip-smoke",
      ], { cwd: sandbox, env: childEnv, timeoutMs: SETUP_TIMEOUT_MS }),
      "flair init",
    );
    preUpgradeHealth = await waitForHealth(baseUrl);

    // macOS only: drop the plist init wrote into the throwaway HOME before
    // anything can `launchctl load` it into the developer's real session. Also
    // keeps this suite on the direct-spawn path Linux/CI exercises.
    const launchAgents = join(home, "Library", "LaunchAgents");
    if (existsSync(launchAgents)) {
      for (const f of readdirSync(launchAgents)) rmSync(join(launchAgents, f), { force: true });
    }

    // ── 3. The real upgrade ──────────────────────────────────────────────────
    upgrade = await run(NODE_BIN, [flairCli, "upgrade"], { cwd: sandbox, env: childEnv, timeoutMs: UPGRADE_TIMEOUT_MS });
    targetVersion = installedVersion(prefix) ?? "";
    postUpgradeHealth = await waitForHealth(baseUrl);
    harperPid = listeningPid(new URL(baseUrl).port);

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
    if (upgrade.code !== 0 || postUpgradeHealth < 200) {
      const tail = (s: string, n = 4000) =>
        s.length > n ? `…(${s.length - n} earlier chars omitted)\n${s.slice(-n)}` : s || "(empty)";
      console.error(
        [
          "",
          "── flair upgrade FAILED — captured output follows ──────────────────",
          `exit code:          ${upgrade.code}`,
          `health after:       ${postUpgradeHealth} (0 = nothing answered on ${baseUrl})`,
          `listening pid:      ${harperPid ?? "(none — nothing holds the port)"}`,
          `installed version:  ${targetVersion || "(could not read)"}`,
          "── stdout ─────────────────────────────────────────────────────────",
          tail(upgrade.stdout),
          "── stderr ─────────────────────────────────────────────────────────",
          tail(upgrade.stderr),
          "───────────────────────────────────────────────────────────────────",
        ].join("\n"),
      );
    }
  }, SETUP_TIMEOUT_MS + UPGRADE_TIMEOUT_MS);

  afterAll(async () => {
    // Stop by PID, not via `flair stop`. After the upgrade, `flairCli` IS the
    // published target version, and teardown that runs the code under test can
    // take the whole suite down with it: published `flair stop` SIGTERMs every
    // process holding ANY socket on the port — including this test process,
    // whose /Health probes leave keep-alive client connections. That is the
    // flair#800 class surviving in `flair stop` (fixed in this PR, but the
    // published target still has it), and it cost two runs here: bun was
    // killed inside afterAll, so every assertion result was lost with it.
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

  test("the instance was reachable BEFORE the upgrade", () => {
    // Guard on the setup, not the fix: if init never produced a live instance,
    // every assertion below is vacuous and would otherwise read as a pass.
    expect(preUpgradeHealth).toBeGreaterThanOrEqual(200);
    expect(preUpgradeHealth).toBeLessThan(500);
  });

  test("the upgrade crossed a real version boundary", () => {
    expect(targetVersion).not.toBe("");
    expect(targetVersion).not.toBe(driverVersion);
    expect(upgrade.stdout).toContain(`Installing ${PKG}@${targetVersion}`);
  });

  // ── The gate flair#905 was missing ────────────────────────────────────────
  test("the instance is REACHABLE after the upgrade", () => {
    expect(postUpgradeHealth).toBeGreaterThanOrEqual(200);
    expect(postUpgradeHealth).toBeLessThan(500);
  });

  test("the upgrade reported success", () => {
    expect(upgrade.code).toBe(0);
  });

  // flair#905's structural fix: version N's own code is the only code that
  // knows how version N starts, so the post-swap restart is executed by the
  // newly installed CLI rather than by the process that installed it.
  test("the restart was performed by the newly installed CLI", () => {
    expect(upgrade.stdout).toContain("restarting via the newly installed CLI");
    expect(upgrade.stdout).toContain(`@ ${targetVersion}`);
  });

  // The false remedy is half the reported defect: an error naming `flair init`
  // on an initialised instance costs the operator's trust before it costs them
  // time. Nothing in a SUCCESSFUL upgrade should mention it.
  test("no upgrade output points an initialised instance at `flair init`", () => {
    expect(`${upgrade.stdout}${upgrade.stderr}`).not.toMatch(/Harper binary not found/);
  });
});
