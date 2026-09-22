/**
 * build-cli-once.ts — build dist/cli.js AT MOST ONCE per test process (flair#1807).
 *
 * WHAT WAS ACTUALLY WRONG. Every unit file that needs dist/cli.js used to run
 * its own unbounded `execSync("bun run build:cli")` in a `beforeAll`. On the
 * pinned bun the files of one `bun test` invocation run SEQUENTIALLY in ONE
 * process (measured: up to 24 files, one pid, no overlapping hooks), and CI runs
 * each lane as a single invocation — so those rebuilds never raced. The real
 * defect was serial REDUNDANCY: N files each re-ran the same untimed build, and
 * a hung tsc killed the hook with bun's timer and no name.
 *
 * (The earlier "concurrent lanes racing over dist/, all racing a 5 s hook"
 * story was never true on this bun. The lock that defended it is deleted — a
 * lock would only come back WITH a fixture that proves the contention first. As
 * of this writing there is none.)
 *
 * WHAT THIS DOES. A freshness check skips the build when dist/cli.js is at least
 * as new as every build INPUT; a module-level memo — set ONLY after a build
 * succeeds and the output validates fresh — skips it for the rest of the
 * process. Otherwise it runs ONE BOUNDED build.
 *
 * BOUNDED MEANS TERMINATED, NOT "a timeout option". `execSync(cmd, { timeout })`
 * sends SIGTERM by default and a child that ignores it survives: a measured
 * `trap '' TERM; sleep 0.8` with `timeout: 100` returned only after 949 ms. So
 * the build is spawned with `killSignal: "SIGKILL"`, and the steps are invoked
 * DIRECTLY (tsc + write-build-info — exactly package.json's `build:cli` chain)
 * rather than through a `bun run` shell layer that can orphan grandchildren. The
 * timeout becomes a NAMED error. No Atomics.wait anywhere.
 *
 * FRESHNESS INPUTS. cliIsFresh compares dist/cli.js against src/, the
 * tsconfig.cli.json chain (following `extends` recursively; none today),
 * package.json, bun.lock and scripts/write-build-info.mjs. Exclusions an mtime
 * set CANNOT see, named here so they are not mistaken for coverage:
 *   - installed node_modules contents (assumed to equal the lockfile install);
 *   - the git identity scripts/write-build-info.mjs reads, so build-info.json
 *     may lag a commit;
 *   - a partial build (cli.js written, the rest of dist/ missing) — impossible
 *     in CI, where both lanes pre-build unconditionally, but possible on a dev
 *     box. There is no completion stamp on purpose.
 *
 * Not a CLI spawn: a build entry is not the CLI, so flair#1807's class gate
 * (a spawned CLI ENTRY with no deadline) neither flags nor counts it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const CLI_JS = join(ROOT, "dist", "cli.js");
const SRC_DIR = join(ROOT, "src");
const TSCONFIG_CLI = join(ROOT, "tsconfig.cli.json");
const TSC_JS = join(ROOT, "node_modules", "typescript", "bin", "tsc");
const WRITE_BUILD_INFO = join(ROOT, "scripts", "write-build-info.mjs");

/**
 * The build budget. Must leave room, under the smallest caller hook budget
 * (120 s in every caller's `beforeAll`), for the freshness scan and the kill.
 */
export const BUILD_TIMEOUT_MS = 90_000;

let builtThisProcess = false;

/** Newest mtime at `path`, descending directories — the whole tree, not one file. */
function newestMtimeMs(path: string): number {
  let st;
  try {
    st = statSync(path);
  } catch {
    return 0;
  }
  if (st.isDirectory()) {
    // Children only — the directory's OWN mtime changes on add/remove and would
    // force spurious rebuilds; the file mtimes cover real edits.
    let newest = 0;
    for (const name of readdirSync(path)) newest = Math.max(newest, newestMtimeMs(join(path, name)));
    return newest;
  }
  return st.mtimeMs;
}

/** A tsconfig and every file it `extends`, transitively (none today). */
function tsconfigInputs(path: string, seen = new Set<string>()): string[] {
  const out: string[] = [];
  if (seen.has(path) || !existsSync(path)) return out;
  seen.add(path);
  out.push(path);
  try {
    // tsconfig.json is JSONC; `extends` here is a bare string with no comments
    // on its line, so a targeted match is enough and avoids a JSON5 dep.
    const text = readFileSync(path, "utf-8");
    const m = text.match(/"extends"\s*:\s*"([^"]+)"/);
    if (m) {
      const base = m[1].startsWith(".") ? resolve(path, "..", m[1]) : resolve(ROOT, "node_modules", m[1]);
      out.push(...tsconfigInputs(base, seen));
    }
  } catch {
    /* unreadable — the file's own mtime still counts via the caller */
  }
  return out;
}

/** Every build INPUT whose change must make dist/cli.js stale. */
function buildInputs(): string[] {
  return [
    SRC_DIR,
    ...tsconfigInputs(TSCONFIG_CLI),
    join(ROOT, "package.json"),
    join(ROOT, "bun.lock"),
    WRITE_BUILD_INFO,
  ];
}

/** dist/cli.js exists and is at least as new as the newest build input. */
export function cliIsFresh(): boolean {
  try {
    if (!existsSync(CLI_JS)) return false;
    const cli = statSync(CLI_JS).mtimeMs;
    return buildInputs().every((input) => cli >= newestMtimeMs(input));
  } catch {
    return false;
  }
}

interface BuildStep {
  label: string;
  command: string;
  args: string[];
}

const BUILD_STEPS: BuildStep[] = [
  { label: "tsc -p tsconfig.cli.json --noCheck", command: process.execPath, args: [TSC_JS, "-p", TSCONFIG_CLI, "--noCheck"] },
  { label: "scripts/write-build-info.mjs", command: process.execPath, args: [WRITE_BUILD_INFO] },
];

/** Run ONE bounded step, translating a timeout into a NAMED error. */
function runBoundedStep(step: BuildStep, timeoutMs: number): void {
  const res = spawnSync(step.command, step.args, {
    cwd: ROOT,
    stdio: "ignore",
    timeout: timeoutMs,
    // SIGTERM does not stop a child that ignores it; SIGKILL does.
    killSignal: "SIGKILL",
  });
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT" || res.signal === "SIGKILL") {
      throw new Error(`build:cli exceeded ${timeoutMs} ms (${step.label}) — SIGKILLed, no output produced`);
    }
    throw new Error(`build:cli failed to start ${step.label}: ${res.error.message}`);
  }
  if (res.signal === "SIGKILL") {
    throw new Error(`build:cli exceeded ${timeoutMs} ms (${step.label}) — SIGKILLed, no output produced`);
  }
  if (res.status !== 0) {
    throw new Error(`build:cli step failed: ${step.label} exited ${res.status ?? `signal ${res.signal}`}`);
  }
}

/**
 * Ensure dist/cli.js is fresh, building it ONCE if not. Repeat calls in the same
 * process are a no-op once a build has succeeded and validated.
 */
export function ensureCliBuild(opts: { timeoutMs?: number } = {}): void {
  // TEST-ONLY stub: replaces the build with a shell command so a fixture can
  // exercise the bounded-termination path without a real build. Inert in
  // production, and it never sets the process memo.
  const stub = process.env.FLAIR_TEST_BUILD_CLI_STUB;
  const timeoutMs = opts.timeoutMs ?? BUILD_TIMEOUT_MS;

  if (!stub) {
    if (builtThisProcess) return;
    if (cliIsFresh()) {
      builtThisProcess = true;
      return;
    }
  }

  const steps: BuildStep[] = stub
    ? [{ label: "build stub", command: "/bin/sh", args: ["-c", stub] }]
    : BUILD_STEPS;

  for (const step of steps) runBoundedStep(step, timeoutMs);

  if (!stub) {
    if (!cliIsFresh()) {
      throw new Error(`build:cli did not produce a fresh ${CLI_JS}`);
    }
    builtThisProcess = true; // set ONLY after a build succeeded AND validated
  }
}
