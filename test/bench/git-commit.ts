/**
 * git-commit.ts — resolve the flair commit a benchmark artifact measured,
 * FAIL-CLOSED (flair#1432).
 *
 * ── The defect this closes ───────────────────────────────────────────────────
 *
 * Every bench harness recorded `gitCommit` with a private helper of the shape
 *
 *     try { return execSync("git rev-parse HEAD", { cwd: REPO_ROOT }); }
 *     catch { return null; }
 *
 * The intent was right — `REPO_ROOT` is the harness's own module directory, not
 * `process.cwd()`, so a run launched from `~/bench` still asked git about the
 * FLAIR code, not the launch directory. But the bench VM runs from an EXPORTED
 * tree with no `.git` (an npm-installed / tarball flair, or a `git archive`
 * export). There `git rev-parse HEAD` prints `fatal: not a git repository`, the
 * catch swallows it, and the field becomes `null`. Nothing warned: the run log,
 * the artifact, and the self-verify all passed, because `artifactHash` seals
 * whatever was recorded — INCLUDING a null. The two most expensive n=500 runs
 * therefore cannot say what code they measured, and reproducibility is
 * flair-bench's whole edge.
 *
 * ── The resolution order ─────────────────────────────────────────────────────
 *
 *   1. `git rev-parse HEAD` in the flair code directory — the local checkout
 *      case, the ground truth when a `.git` is present. Trusted ONLY when that
 *      directory IS the repo root (git's `--show-toplevel` resolves to it):
 *      `git rev-parse` uses UPWARD `.git` discovery, so an export unpacked inside
 *      an unrelated repo would otherwise inherit THAT repo's HEAD — a real,
 *      40-hex, self-verifying, WRONG attribution, worse than a null (flair#1477).
 *      On a toplevel mismatch we fall through to the stamp, never adopt it.
 *   2. `<flairDir>/dist/build-info.json`'s `commit` — the installed / exported
 *      package case. `scripts/write-build-info.mjs` (flair#1076) stamps the
 *      build's commit into dist/ at `bun run build`, so an export that carries a
 *      built dist/ still names its own commit even with no `.git`. This is the
 *      "resolve from installed-package metadata" path.
 *   3. `FLAIR_BENCH_COMMIT` — an explicit operator override (validated 40-hex),
 *      the escape hatch for an export that has neither a `.git` nor a stamp.
 *   4. THROW. A benchmark that cannot name its code REFUSES to write an
 *      artifact. A null-commit artifact is worse than a missing field: it looks
 *      complete and self-verifies, so the gap is invisible until someone asks
 *      the one question the artifact exists to answer.
 *
 * Only a full 40-hex sha is accepted at every step; anything shorter, empty, or
 * malformed degrades to the next step and ultimately to the throw, never to a
 * fabricated or truncated identity.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** A commit identity is a full 40-hex sha and nothing else. Matches the writer
 *  side (scripts/write-build-info.mjs) so the two agree on what "a commit" is. */
export const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;

/** The env override consulted before failing closed. Named once here so the
 *  thrown message and the lookup can never disagree. */
export const COMMIT_ENV_OVERRIDE = "FLAIR_BENCH_COMMIT";

/** Repo root relative to THIS module (test/bench/git-commit.ts → ../..), so the
 *  default flair directory is derived from the code's own location and is
 *  independent of the process working directory. */
export const BENCH_REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function gitHead(dir: string): string | null {
  try {
    // execFileSync (argv array, no shell) rather than a shell string: same
    // output, but nothing in `dir` can be interpreted by a shell. stderr is
    // dropped — outside a repo git's "fatal: not a git repository" is the
    // EXPECTED path to step 2, not an error to surface mid-report.
    const out = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
    if (!COMMIT_SHA_RE.test(out)) return null;
    // flair#1477: `git rev-parse HEAD` uses UPWARD `.git` discovery. If `dir` is
    // an export unpacked inside an unrelated repo, git walks up and returns THAT
    // repo's HEAD — a real, 40-hex, self-verifying, WRONG attribution (worse than
    // a null, which at least fails closed). Only trust HEAD when `dir` IS the repo
    // root: the discovered toplevel must resolve to `dir` itself. On any mismatch
    // (or an unresolvable path), fall through to the stamp rather than adopt a
    // parent repo's commit. realpath both sides so /var vs /private/var, `..`
    // segments, and symlinks cannot spuriously disagree.
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
    if (!top || realpathSync(top) !== realpathSync(dir)) return null;
    return out;
  } catch {
    return null;
  }
}

function stampCommit(flairDir: string): string | null {
  try {
    const stampPath = join(flairDir, "dist", "build-info.json");
    if (!existsSync(stampPath)) return null;
    const raw = JSON.parse(readFileSync(stampPath, "utf-8"));
    return raw && typeof raw.commit === "string" && COMMIT_SHA_RE.test(raw.commit) ? raw.commit : null;
  } catch {
    return null; // absent / unreadable / malformed stamp → fall through, never guess
  }
}

/**
 * Resolve the commit of the flair code under test, or THROW. Never returns null.
 *
 * @param flairDir the directory of the flair code being measured — a checkout
 *   root, or an installed/exported package dir (e.g. `LME_FLAIR_PKG_DIR`).
 *   Defaults to this harness's own repo root.
 */
export function resolveBenchGitCommit(flairDir: string = BENCH_REPO_ROOT): string {
  const head = gitHead(flairDir);
  if (head) return head;

  const stamped = stampCommit(flairDir);
  if (stamped) return stamped;

  const override = process.env[COMMIT_ENV_OVERRIDE]?.trim();
  if (override) {
    if (!COMMIT_SHA_RE.test(override)) {
      throw new Error(
        `${COMMIT_ENV_OVERRIDE}=${JSON.stringify(override)} is not a 40-hex commit sha — ` +
        `refusing to attribute the benchmark run to a malformed commit (flair#1432).`,
      );
    }
    return override;
  }

  throw new Error(
    `cannot attribute benchmark run: flair gitCommit unresolved from ${flairDir} — ` +
    `it is not a git checkout and carries no dist/build-info.json commit stamp. ` +
    `Run the bench from a flair checkout, build the flair under test first ` +
    `(\`bun run build\` stamps dist/build-info.json with its commit), ` +
    `or set ${COMMIT_ENV_OVERRIDE}=<40-hex sha>. ` +
    `Refusing to write a null-commit artifact — a benchmark that cannot name its code is not reproducible (flair#1432).`,
  );
}

/**
 * Defense-in-depth guard for the artifact BUILDERS: a resolved value is already
 * fail-closed by resolveBenchGitCommit above, but the builders take a plain
 * string and a future caller could still hand them a null/empty/malformed one.
 * The seal must never again seal a null, so refuse at build time rather than
 * content-address an unidentifiable commit. Returns the validated sha.
 */
export function assertBenchGitCommit(commit: string | null | undefined, where = "artifact"): string {
  if (typeof commit !== "string" || !COMMIT_SHA_RE.test(commit)) {
    throw new Error(
      `${where}: gitCommit is ${commit === null ? "null" : commit === undefined ? "undefined" : JSON.stringify(commit)}, ` +
      `not a 40-hex commit sha — refusing to seal a benchmark artifact that cannot name its code (flair#1432). ` +
      `Resolve it with resolveBenchGitCommit() before building.`,
    );
  }
  return commit;
}
