/**
 * build-cli-once.ts — build dist/cli.js AT MOST ONCE per test lane (flair#1807).
 *
 * Several unit files own their own `dist/cli.js` so a stale or absent build
 * cannot make their run vacuous. Each ran `execSync("bun run build:cli")` in a
 * `beforeAll`, and bun runs the files of one lane concurrently, so those hooks
 * all fired the SAME `bun run build:cli` at once: N concurrent tsc runs writing
 * the same `dist/`, and each hook racing bun's 5 s hook default. That is a race
 * with a real cost — a hook can be killed at 5 s while a sibling's build is
 * still writing, and the case then fails with a bare "timed out" that names
 * nothing.
 *
 * The fix is to build once, not to raise one timeout: a freshness check skips
 * the build when `dist/cli.js` is already newer than the newest source under
 * `src/`, and a lock file created with `"wx"` (exclusive) makes concurrent
 * callers WAIT for the one build instead of starting their own. The caller
 * still gives its hook a budget so a genuine build hang is named.
 *
 * Not a CLI spawn: `bun run build:cli` is a build, so flair#1807's class gate
 * (a spawned CLI ENTRY with no deadline) neither flags nor counts it.
 */
import { execSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const CLI_JS = join(ROOT, "dist", "cli.js");
const SRC_DIR = join(ROOT, "src");
/** Under node_modules so the lock is never a repo artifact. */
const LOCK = join(ROOT, "node_modules", ".flair-cli-build.lock");
const LOCK_STALE_MS = 10 * 60_000;

/** Newest mtime under `dir`, recursively — the whole src tree, not just cli.ts. */
function newestMtimeMs(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtimeMs(p));
    else if (entry.isFile()) newest = Math.max(newest, statSync(p).mtimeMs);
  }
  return newest;
}

/** dist/cli.js exists and is at least as new as the newest source under src/. */
function cliIsFresh(): boolean {
  try {
    if (!existsSync(CLI_JS)) return false;
    return statSync(CLI_JS).mtimeMs >= newestMtimeMs(SRC_DIR);
  } catch {
    return false;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Ensure dist/cli.js is fresh, building it ONCE if not. Concurrent callers
 * serialize on the lock: the first builds, the rest wait and then find it fresh.
 */
export function ensureCliBuild(opts: { waitMs?: number } = {}): void {
  if (cliIsFresh()) return;
  mkdirSync(join(ROOT, "node_modules"), { recursive: true });
  const waitMs = opts.waitMs ?? 180_000;
  const deadline = Date.now() + waitMs;

  for (;;) {
    let fd: number;
    try {
      fd = openSync(LOCK, "wx");
    } catch {
      // Held by a sibling. Break only a STALE lock (a crashed holder), then wait.
      try {
        if (existsSync(LOCK) && Date.now() - statSync(LOCK).mtimeMs > LOCK_STALE_MS) rmSync(LOCK, { force: true });
      } catch {
        /* ignore */
      }
      if (cliIsFresh()) return;
      if (Date.now() > deadline) throw new Error(`ensureCliBuild: timed out waiting for the CLI build lock ${LOCK}`);
      sleepSync(100);
      continue;
    }
    try {
      writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
    } finally {
      closeSync(fd);
    }
    try {
      if (cliIsFresh()) return; // another lane built it while we waited for the lock
      execSync("bun run build:cli", { cwd: ROOT, stdio: "ignore" });
    } finally {
      try {
        unlinkSync(LOCK);
      } catch {
        /* already gone */
      }
    }
    if (!cliIsFresh()) throw new Error(`ensureCliBuild: bun run build:cli did not produce a fresh ${CLI_JS}`);
    return;
  }
}
