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
 * `os.userInfo().homedir`, never from `HOME`.
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
  process.on("exit", sandbox.cleanup);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      sandbox.cleanup();
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
  return sandbox;
}

installSandboxHome();
