import { spawn, execFileSync, ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import type { AddressInfo, Server } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── Leak backstop: clean up even when the test framework never gets to ──────
//
// `stopHarper` is correct when it is CALLED. The leak is that it often is not:
// if a `beforeAll` throws or times out, `afterAll` does not run, and the spawned
// Harper survives holding its ~3 GB install tree open.
//
// Measured on rockit 2026-08-05, after a night of integration runs: NINE orphaned
// `flair-test-*` trees totalling 27 GB, held open by four abandoned `harper dev`
// processes — two of them FOUR DAYS old. The disk hit 0 bytes and no command
// could run at all, because every tool needs to write before it executes.
//
// Deleting the directories alone would not have helped: a file held open by a
// live process does not return its blocks. The process has to die first, which
// is why this tracks processes rather than just paths.
//
// So: every instance registers here on spawn and deregisters on clean stop, and
// a process-exit hook kills whatever is left. Exit handlers must be SYNCHRONOUS,
// hence `process.kill` + `rmSync` rather than the async paths `stopHarper` uses.
const LIVE_INSTANCES = new Set<{ pid?: number; installDir?: string; owns: boolean }>();
let exitHookInstalled = false;

/**
 * Is `pid` still a direct child of this process?
 *
 * The reaper's one real hazard is pid REUSE: a tracked Harper dies on its own,
 * the OS reuses its pid, and the exit hook SIGKILLs whatever now holds it.
 * Sherlock found that window on review and judged it acceptable because "the
 * blast radius is a test runner process on a dev machine."
 *
 * That is true in general and FALSE HERE. rockit runs production Flair
 * (~/flair-prod, serving :9926) alongside these tests. A wrong kill on this
 * machine can hit production — which is exactly the July 2026 incident, where a
 * `pkill -f harper` took prod down. Rebuilding that with better manners is still
 * rebuilding it.
 *
 * A spawned Harper is our CHILD. Production is not, and neither is any unrelated
 * process that inherits a recycled pid. Checking parentage costs one `ps` at
 * exit and turns "kill whatever holds this pid" into "kill it only if it is
 * still the child we started".
 *
 * Not atomic — the pid could in principle be reused between this check and the
 * kill — but it removes the entire class of victim that matters, since nothing
 * we did not spawn is ever our child. Fails CLOSED: if parentage cannot be
 * determined, the process is left alone and the tree is left behind. A leaked
 * directory is recoverable; a killed production instance is not.
 */
function isOwnChild(pid: number): boolean {
  try {
    const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
      encoding: "utf-8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"],
    });
    return Number(out.trim()) === process.pid;
  } catch {
    return false; // gone, or unknowable — either way, do not kill it
  }
}

function reapLiveInstances(): void {
  for (const inst of LIVE_INSTANCES) {
    if (inst.pid && isOwnChild(inst.pid)) {
      try { process.kill(inst.pid, "SIGKILL"); } catch { /* already gone */ }
    }
    if (inst.installDir && inst.owns) {
      try { rmSync(inst.installDir, { recursive: true, force: true, maxRetries: 2 }); } catch { /* best effort */ }
    }
  }
  LIVE_INSTANCES.clear();
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", reapLiveInstances);
  // A signalled run must not skip the reap. Re-raise after cleaning so the exit
  // code still reflects the signal rather than being swallowed.
  //
  // The listener MUST be removed before re-raising. Registering a handler for
  // SIGINT/SIGTERM/SIGHUP replaces Node's default action (terminate), so
  // re-raising while still registered re-enters this handler — forever. The
  // process then survives the signal it was told to die on.
  //
  // That is not theoretical: the first version of this hung CI's Integration
  // Tests for 35 minutes against a ~15 minute norm, until the runner hard-killed
  // it. And it broke the case this hook exists for — Ctrl-C would no longer stop
  // a test run. Verified both ways in isolation: re-raising while registered
  // loops indefinitely; removing the listener first exits 143, terminated by the
  // signal, which is what a caller expects to see.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      reapLiveInstances();
      process.removeAllListeners(sig);
      process.kill(process.pid, sig);
    });
  }
}

/**
 * How many abandoned `flair-test-*` trees are sitting in the temp dir.
 *
 * Surfaced so a leak fails a TEST rather than a machine three hours later. The
 * incident above was invisible until the disk was full: nothing counted, so
 * nothing complained, and the only signal was every command failing at once.
 */
export function countStaleHarperTrees(): number {
  try {
    return readdirSync(tmpdir()).filter((n) => n.startsWith("flair-test-")).length;
  } catch {
    return 0;
  }
}

const STARTUP_TIMEOUT_MS = 45_000;
const MAX_SPAWN_ATTEMPTS = 3;

// Harper logs exactly this ("Unable to bind to port NNNNN: Address already in
// use") when its HTTP/ops listener can't bind, but it STILL prints "successfully
// started" — so without detecting it, the health poll hammers a dead port for the
// full 60s timeout and the test fails at ~64s (a random port
// occasionally collided with an in-use one).
//
// Match ONLY Harper's specific bind-failure message — NOT a bare "address already
// in use", which also appears in benign noise like Node's inspector failing to
// attach ("Starting inspector on 127.0.0.1:9229 failed: address already in use"),
// which must not be mistaken for a Harper port-bind failure.
const BIND_ERROR_RE = /Unable to bind to port/i;

// Use harper from node_modules — spawned under node (not bun)
// because bun 1.3.x doesn't support uv_ip6_addr which Harper's NAPI modules need.
const NODE_BIN = process.env.NODE_BIN ?? "node";

// flair#870: flair declares the BARE `harper` package name. The scoped
// `@harperfast/harper` layout is still probed as a fallback because the compat
// lanes (test/compat/*) point `harperBinDir` at an install root produced by an
// OLDER published flair, which declared the scoped name.
function harperBinPath(harperBinDir: string): string {
  const candidates = [
    join(harperBinDir, "node_modules", "harper", "dist", "bin", "harper.js"),
    join(harperBinDir, "node_modules", "@harperfast", "harper", "dist", "bin", "harper.js"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[0];
}

// External service mode: set HARPER_HTTP_URL (and optionally HARPER_OPS_URL) to
// skip the local spawn and connect to an already-running Harper instance (e.g. Docker).
const HARPER_HTTP_URL = process.env.HARPER_HTTP_URL;
const HARPER_OPS_URL_ENV = process.env.HARPER_OPS_URL;
const HARPER_ADMIN_USER = process.env.HARPER_ADMIN_USER ?? "admin";
const HARPER_ADMIN_PASS = process.env.HARPER_ADMIN_PASS ?? "test123";

export interface HarperInstance {
  httpURL: string;
  opsURL: string;
  installDir: string;
  process: ChildProcess | null;
  admin: { username: string; password: string };
  external: boolean;
  /**
   * True when `startHarper` created `installDir` itself (mkdtemp), false
   * when the caller supplied it via `StartHarperOptions.installDir`.
   * `stopHarper` only ever removes a directory it created — a caller-owned
   * dir (e.g. one shared across two `startHarper()` calls for a downgrade
   * test) is the caller's to clean up.
   */
  ownsInstallDir: boolean;
  /** Internal: the leak-backstop registry entry, so stopHarper can deregister
   *  by identity. Absent for external instances, which own nothing. */
  __tracked?: { pid?: number; installDir?: string; owns: boolean };
}

interface HarperExit { code: number | null; signal: NodeJS.Signals | null }

// Raised when Harper fails to bind a port. startHarper retries on this with a
// fresh pair of OS-assigned ports rather than failing the whole test.
class PortInUseError extends Error {}

// Ask the OS for `count` distinct free TCP ports by listening on :0. All servers
// are held open together so the ports are guaranteed distinct, then closed. A
// tiny TOCTOU window remains before Harper rebinds them — the spawn-retry loop in
// startHarper covers any residual collision.
async function getFreePorts(count: number): Promise<number[]> {
  const servers = await Promise.all(
    Array.from({ length: count }, () =>
      new Promise<Server>((resolve, reject) => {
        const srv = createServer();
        srv.once("error", reject);
        srv.listen(0, "127.0.0.1", () => resolve(srv));
      }),
    ),
  );
  const ports = servers.map(s => (s.address() as AddressInfo).port);
  await Promise.all(servers.map(s => new Promise<void>(r => s.close(() => r()))));
  return ports;
}

async function killProcess(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill();
  await new Promise<void>(r => {
    proc.on("exit", () => r());
    setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} r(); }, 3000);
  });
  proc.removeAllListeners();
}

async function waitForHealth(
  httpURL: string,
  timeoutMs = 60_000,
  // Optional probes into the spawned process. When Harper dies mid-startup, or
  // fails to bind its port, we want to fail fast and loud with its log instead
  // of blindly polling a dead port for the full timeout (the failure mode that
  // produced cryptic "did not respond within 60000ms" errors with zero output).
  getExited?: () => HarperExit | null,
  getLog?: () => string,
): Promise<void> {
  const url = `${httpURL}/health`;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  console.log(`[harper-lifecycle] waitForHealth: polling ${url} (timeout ${timeoutMs}ms)`);
  while (Date.now() < deadline) {
    const exit = getExited?.();
    if (exit) {
      throw new Error(
        `Harper exited (code=${exit.code} signal=${exit.signal}) while waiting for ${url} ` +
        `to become healthy. Harper log:\n${getLog?.() ?? "(not captured)"}`,
      );
    }
    // Harper prints "successfully started" even when a port bind failed, so the
    // banner alone is not proof the HTTP port is listening — detect the bind
    // error explicitly and fail fast (retryable) instead of polling a dead port.
    const log = getLog?.() ?? "";
    if (BIND_ERROR_RE.test(log)) {
      throw new PortInUseError(
        `Harper failed to bind a port while waiting for ${url}. Harper log:\n${log}`,
      );
    }
    attempt++;
    const elapsed = Date.now() - (deadline - timeoutMs);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      console.log(`[harper-lifecycle] waitForHealth: attempt ${attempt} → HTTP ${res.status} (${elapsed}ms elapsed)`);
      if (res.status > 0) {
        console.log(`[harper-lifecycle] waitForHealth: server alive after ${elapsed}ms`);
        return;
      }
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      console.log(`[harper-lifecycle] waitForHealth: attempt ${attempt} → error: ${msg} (${elapsed}ms elapsed)`);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  const exit = getExited?.();
  throw new Error(
    `Harper at ${httpURL} did not respond within ${timeoutMs}ms (${attempt} attempts). ` +
    `Process ${exit ? `exited (code=${exit.code} signal=${exit.signal})` : "still alive"}. ` +
    `Harper log:\n${getLog?.() ?? "(not captured)"}`,
  );
}

// Wait for Harper's startup banner. Resolves on the banner, rejects fast on
// process exit or a port-bind error (the latter as a retryable PortInUseError).
function awaitStartup(proc: ChildProcess, getLog: () => string, getExited: () => HarperExit | null): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Harper startup timed out after ${STARTUP_TIMEOUT_MS}ms. Log:\n${getLog()}`));
    }, STARTUP_TIMEOUT_MS);

    const check = () => {
      const log = getLog();
      if (BIND_ERROR_RE.test(log)) {
        clearTimeout(timer);
        cleanup();
        reject(new PortInUseError(`Harper failed to bind a port during startup. Log:\n${log}`));
        return;
      }
      if (log.includes("successfully started") || log.includes("listening on")) {
        clearTimeout(timer);
        cleanup();
        resolve();
      }
    };
    const onError = (err: Error) => { clearTimeout(timer); cleanup(); reject(err); };
    const onExit = () => {
      clearTimeout(timer);
      cleanup();
      const exit = getExited();
      reject(new Error(`Harper exited during startup (code=${exit?.code} signal=${exit?.signal}). Log:\n${getLog()}`));
    };
    const cleanup = () => {
      proc.stdout?.off("data", check);
      proc.stderr?.off("data", check);
      proc.off("error", onError);
      proc.off("exit", onExit);
    };
    proc.stdout?.on("data", check);
    proc.stderr?.on("data", check);
    proc.on("error", onError);
    proc.on("exit", onExit);
  });
}

export interface StartHarperOptions {
  /**
   * Directory `harper dev "."` treats as its component root (i.e. the spawn's
   * `cwd` — the "." argument resolves relative to it). Defaults to
   * `process.cwd()`, matching every existing call site (a bare Flair
   * checkout loading itself as the component).
   *
   * Set this to point Harper at a DIFFERENT component tree — e.g. an
   * npm-installed `@tpsdev-ai/flair` package directory — to spawn that
   * version's code instead of the current worktree's. See
   * test/compat/federation-mixed-version.test.ts.
   */
  cwd?: string;
  /**
   * Directory whose `node_modules/harper` provides the Harper
   * binary. Defaults to `cwd`. Split out from `cwd` because npm hoists
   * `harper` to the INSTALL ROOT, not into the nested
   * `node_modules/@tpsdev-ai/flair` component directory — so a caller
   * pointing `cwd` at an installed package's directory must pass the
   * install root here separately.
   */
  harperBinDir?: string;
  /**
   * Reuse this existing directory as ROOTPATH/HOME instead of `mkdtemp`-ing a
   * fresh one. Used by the downgrade-compat test (flair#637) to boot a
   * DIFFERENT Harper build against data a PRIOR `startHarper()` call already
   * wrote — i.e. "does N-1 boot against data touched by N" — without this
   * function silently handing back an empty temp dir instead.
   *
   * The `install` step still runs but is expected to no-op: Harper's own
   * installer (utility/install/installer.ts) checks for an existing
   * harperdb-config.yaml/hdb boot file in ROOTPATH and exits 0 immediately
   * if found, without touching anything — exactly what a real downgrade
   * does (start the old binary against existing data, no re-init). This
   * mirrors production; do not add a `skipInstall` escape hatch that a real
   * downgrade wouldn't have.
   *
   * When set, `startHarper` does NOT take ownership of the directory —
   * `stopHarper` will never remove it (see `HarperInstance.ownsInstallDir`).
   * The caller created it (directly or via a prior `startHarper()`) and is
   * responsible for cleaning it up.
   */
  installDir?: string;
}

export async function startHarper(opts: StartHarperOptions = {}): Promise<HarperInstance> {
  const cwd = opts.cwd ?? process.cwd();
  const harperBinDir = opts.harperBinDir ?? cwd;
  const HARPER_BIN = harperBinPath(harperBinDir);

  // ── External mode: connect to Docker service ─────────────────────────────
  if (HARPER_HTTP_URL) {
    const httpURL = HARPER_HTTP_URL;
    const opsURL = HARPER_OPS_URL_ENV ?? httpURL.replace(/:(\d+)($|\/)/, (_, port, rest) => `:${Number(port) - 1}${rest}`);
    console.log(`[harper-lifecycle] external mode: httpURL=${httpURL} opsURL=${opsURL} user=${HARPER_ADMIN_USER}`);
    await waitForHealth(httpURL, 120_000); // allow time for Docker install + start
    return {
      httpURL,
      opsURL,
      installDir: "",
      process: null,
      admin: { username: HARPER_ADMIN_USER, password: HARPER_ADMIN_PASS },
      external: true,
      ownsInstallDir: false,
    };
  }

  // ── Local mode: spawn Harper from node_modules ────────────────────────────
  const ownsInstallDir = !opts.installDir;
  const installDir = opts.installDir ?? await mkdtemp(join(tmpdir(), "flair-test-"));

  // Deny-list: strip CI secrets from the inherited env so Harper's child
  // process (and any log dump on failure) doesn't leak them onto a public
  // CI runner (Sherlock review on #467).
  const parentEnv = { ...process.env as Record<string, string> };
  delete parentEnv.GITHUB_TOKEN;
  delete parentEnv.NPM_TOKEN;

  const baseEnv: Record<string, string> = {
    ...parentEnv,
    ROOTPATH: installDir,
    HOME: installDir,               // isolate from system Harper install (~/.harperdb)
    // Point the embeddings model dir at the repo-root models/ that CI / local
    // runs pre-download into (the FLAIR_MODELS_DIR override; see
    // resources/embeddings-provider.ts:resolveModelsDir). Without this, the fix's
    // new default — <ROOTPATH>/models, i.e. the fresh temp installDir — would
    // re-download the ~80MB model on every startHarper (HuggingFace 429-prone,
    // #463/#465). A pre-existing parent FLAIR_MODELS_DIR still wins.
    FLAIR_MODELS_DIR: parentEnv.FLAIR_MODELS_DIR ?? join(process.cwd(), "models"),
    DEFAULTS_MODE: "dev",
    HDB_ADMIN_USERNAME: "admin",
    HDB_ADMIN_PASSWORD: "test123",
    THREADS_COUNT: "1",
    NODE_HOSTNAME: "127.0.0.1",     // IPv4 only — avoids bun uv_ip6_addr panic
  };

  // models (flair#504 Phase 1): no env var needed here anymore — the spawned
  // build's own dist/resources/embeddings-boot.js self-registers the backend
  // in-process at boot (flair#694 fixed the old HARPER_CONFIG mechanism,
  // which persisted a `models.embedding.default` block that an
  // older/downgraded build's boot would tear down to an invalid empty shell;
  // see that file's header). FLAIR_MODELS_DIR above still tells the
  // registration where to find/download the model. A baseline build that
  // predates flair#504 simply has no such file and skips registration —
  // exactly the pre-#504 degrade behavior.

  const install = spawn(NODE_BIN, [HARPER_BIN, "install"], { cwd, env: baseEnv });
  await new Promise<void>((resolve, reject) => {
    let output = "";
    install.stdout?.on("data", (d: Buffer) => output += d.toString());
    install.stderr?.on("data", (d: Buffer) => output += d.toString());
    install.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Harper install exited ${code}: ${output}`)));
    install.on("error", reject);
    setTimeout(() => { install.kill(); reject(new Error(`Harper install timed out: ${output}`)); }, 20_000);
  });

  // Spawn `harper dev` with a fresh pair of OS-assigned free ports. A port can
  // still collide between allocation and bind (TOCTOU, or a lingering instance),
  // and Harper reports "successfully started" even when a bind failed — so we
  // detect the bind error and retry the spawn with new ports.
  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= MAX_SPAWN_ATTEMPTS; attempt++) {
    const [httpPort, opsPort] = await getFreePorts(2);
    const env: Record<string, string> = {
      ...baseEnv,
      OPERATIONSAPI_NETWORK_PORT: String(opsPort),
      HTTP_PORT: String(httpPort),
    };
    const httpURL = `http://127.0.0.1:${httpPort}`;
    const opsURL = `http://127.0.0.1:${opsPort}`;

    const proc = spawn(NODE_BIN, [HARPER_BIN, "dev", "."], { cwd, env });

    // Capture Harper's output for the WHOLE lifetime of the process — not just
    // until the startup banner — so a crash that happens after "listening on"
    // (e.g. an intermittent llama.cpp model-load assert/OOM) stays visible.
    let log = "";
    let exited: HarperExit | null = null;
    proc.stdout?.on("data", (d: Buffer) => { log += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { log += d.toString(); });
    proc.on("exit", (code, signal) => { exited = { code, signal }; });

    try {
      await awaitStartup(proc, () => log, () => exited);
      // Poll both ports. Harper binds httpURL and opsURL at different moments
      // during startup; callers hit opsURL immediately (admin seed), so
      // returning as soon as httpURL answered was racy.
      await Promise.all([
        waitForHealth(httpURL, 60_000, () => exited, () => log),
        waitForHealth(opsURL, 60_000, () => exited, () => log),
      ]);
      // Register BEFORE returning. If a caller's beforeAll times out between
      // here and its afterAll, the exit hook is the only thing that reaps this.
      installExitHook();
      const tracked = { pid: proc.pid, installDir, owns: ownsInstallDir };
      LIVE_INSTANCES.add(tracked);
      return {
        httpURL, opsURL, installDir, process: proc,
        admin: { username: "admin", password: "test123" },
        external: false, ownsInstallDir,
        // Carried so stopHarper can deregister the exact entry rather than
        // searching by pid — a pid can be reused, an object identity cannot.
        __tracked: tracked,
      } as HarperInstance;
    } catch (err) {
      await killProcess(proc);
      lastErr = err as Error;
      if (err instanceof PortInUseError && attempt < MAX_SPAWN_ATTEMPTS) {
        console.log(`[harper-lifecycle] port collision (attempt ${attempt}/${MAX_SPAWN_ATTEMPTS}), retrying with fresh ports`);
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error("Harper failed to start");
}

export interface StopHarperOptions {
  /**
   * Kill the process but leave `installDir` on disk even if this instance
   * owns it. Used by the downgrade-compat test (flair#637) to stop the
   * CURRENT-build instance while preserving its data dir for a SECOND
   * `startHarper({ installDir })` call against a different build.
   */
  keepInstallDir?: boolean;
}

export async function stopHarper(inst: HarperInstance, opts: StopHarperOptions = {}): Promise<void> {
  if (inst.external) return;

  // Deregister first: a clean stop must not leave the exit hook holding a stale
  // entry that would SIGKILL a reused pid later.
  if (inst.__tracked) LIVE_INSTANCES.delete(inst.__tracked);

  if (inst.process) await killProcess(inst.process);
  // Never remove a directory this instance didn't create (ownsInstallDir
  // false — the caller supplied it and owns its lifecycle), and never remove
  // one the caller explicitly asked to keep.
  if (inst.installDir && inst.ownsInstallDir && !opts.keepInstallDir) {
    await rm(inst.installDir, { recursive: true, force: true, maxRetries: 4 });
  }
}
