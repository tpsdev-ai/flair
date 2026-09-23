/**
 * Test-process sandbox home (flair#1853).
 *
 * Loaded as a `bun test` preload (see bunfig.toml), so it runs BEFORE any test
 * module is evaluated — before a writer can compute `join(HOME, ...)` at import
 * time. Flair's writers resolve the home on every call
 * (`process.env.HOME || process.env.USERPROFILE || homedir()`), so a test that
 * forgets to swap HOME writes the developer's real `~/.claude.json`,
 * `~/.codex/config.toml` or `~/.claude/settings.json`.
 *
 * This points `HOME`, `USERPROFILE` and `PI_CODING_AGENT_DIR` at a fresh
 * `mkdtemp` directory for the whole process and removes it on exit. The
 * directory is created HERE — at preload time, before any test module — not
 * inside a test body: a temp dir created after the process starts does not
 * isolate import-time reads.
 *
 * NOTE: importing this module also installs the sandbox (the side effect is the
 * point of a preload). `scripts/test-unit.ts` reuses `createSandboxHome` for the
 * HOME it hands to each child step, and the runner is sandboxed by the same
 * import — which is harmless, since the lane guard resolves the REAL home from
 * the passwd entry for the current uid, never from `HOME`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SandboxHome {
  /** The freshly created sandbox directory. */
  dir: string;
  /** The environment a child test process needs to stay inside the sandbox. */
  env: Record<string, string>;
  /** Remove the directory (idempotent, best-effort). */
  cleanup: () => void;
}

/** Create a fresh sandbox home directory plus the env that points at it. */
export function createSandboxHome(prefix = "flair-test-home-"): SandboxHome {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const env: Record<string, string> = {
    HOME: dir,
    USERPROFILE: dir,
    PI_CODING_AGENT_DIR: dir,
  };
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort: a leftover tmp dir must never fail the lane */
    }
  };
  return { dir, env, cleanup };
}

/**
 * Point THIS process at a fresh sandbox home and arrange its removal. Called at
 * preload time; the returned handle is also usable by callers that want to know
 * the directory.
 */
export function installSandboxHome(): SandboxHome {
  const sandbox = createSandboxHome();
  process.env.HOME = sandbox.dir;
  process.env.USERPROFILE = sandbox.dir;
  process.env.PI_CODING_AGENT_DIR = sandbox.dir;
  // ── Exit hook only. NO SIGNAL HANDLERS. ───────────────────────────────────
  //
  // A signal handler that calls process.exit() looked obviously right — clean up
  // the temp dir even on an interrupt. It is wrong here. This preload is loaded
  // into the IN-PROCESS `bun test` runner, and
  // test/integration/federation-watch.test.ts SIGTERMs its own process as its
  // fixture. An unconditional exit intercepts that SIGTERM and kills the WHOLE
  // run mid-file with exit 143 — measured in CI (flair#1853 round 2): the
  // Integration Tests job died in federation-watch right after the first sync,
  // the remaining files never ran. This is the same death harper-lifecycle.ts
  // already documents for the signal handler it deliberately does NOT install:
  // "this harness cannot own a process-wide signal handler: its own tests use
  // signals as data."
  //
  // The exit hook covers a clean exit (a suite that finishes with the sandbox
  // still present). An interrupted run leaves its temp home behind — the accepted
  // cost, and harmless: the dir is under the OS temp dir, never a real home.
  process.on("exit", sandbox.cleanup);
  return sandbox;
}

installSandboxHome();
