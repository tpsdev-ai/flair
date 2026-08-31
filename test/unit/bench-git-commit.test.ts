/**
 * bench-git-commit.test.ts — the FAIL-CLOSED benchmark commit resolver
 * (flair#1432: test/bench/git-commit.ts) and the artifact-builder guard it
 * backs.
 *
 * THE DEFECT. Bench artifacts recorded `gitCommit: null` silently: the resolver
 * ran `git rev-parse HEAD` in the flair code directory and swallowed the failure
 * to null when that directory was an exported / npm-installed tree with no
 * `.git`. `artifactHash` then sealed the null — the run log, the artifact and
 * the self-verify all passed — so the two most expensive n=500 runs could not
 * name the code they measured. A benchmark whose edge is reproducibility must
 * REFUSE rather than seal a null.
 *
 * Each not-a-repo case runs inside an isolated mkdtemp fixture with a git
 * discovery ceiling (GIT_CEILING_DIRECTORIES), so `git rev-parse` can never
 * wander UP out of the fixture and report some OTHER repo's HEAD (this repo's,
 * or a parent of /tmp) — the same isolation build-info-stamp.test.ts uses.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveBenchGitCommit, assertBenchGitCommit, COMMIT_ENV_OVERRIDE, COMMIT_SHA_RE,
} from "../bench/git-commit";
import { buildArtifact } from "../bench/longmemeval/artifact";

const cleanups: string[] = [];
afterAll(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway directory, realpath'd so git and fs agree on macOS (/var/folders
 *  is a symlink). Not a git repo unless the caller inits one. */
function tmpDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `flair-bench-commit-${prefix}-`)));
  cleanups.push(dir);
  return dir;
}

/** Env that pins a git discovery ceiling at the fixture's parent and strips any
 *  inherited git redirection, so a `git rev-parse` inside `dir` sees ONLY `dir`
 *  (and its immediate parent) — never a repo further up. */
function isolateGit(dir: string): () => void {
  const saved = {
    GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES,
    GIT_DIR: process.env.GIT_DIR,
    GIT_WORK_TREE: process.env.GIT_WORK_TREE,
    GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
  };
  process.env.GIT_CEILING_DIRECTORIES = dirname(dir);
  delete process.env.GIT_DIR;
  delete process.env.GIT_WORK_TREE;
  delete process.env.GIT_INDEX_FILE;
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/** A git repo with exactly one commit; returns [dir, HEAD sha]. */
function makeGitRepo(): [string, string] {
  const dir = tmpDir("repo");
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(dir) };
  execFileSync("git", ["init", "-q"], { cwd: dir, env });
  execFileSync(
    "git",
    ["-c", "user.email=fixture@test", "-c", "user.name=fixture", "commit", "--allow-empty", "-q", "-m", "fixture"],
    { cwd: dir, env },
  );
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, env, encoding: "utf-8" }).trim();
  expect(head).toMatch(COMMIT_SHA_RE); // fixture sanity
  return [dir, head];
}

/** Write a dist/build-info.json stamp (as write-build-info.mjs would). */
function writeStamp(dir: string, commit: string | null): void {
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(
    join(dir, "dist", "build-info.json"),
    JSON.stringify({ version: "9.9.9-test", commit, builtAt: new Date().toISOString(), builder: "tsc" }, null, 2),
  );
}

describe("resolveBenchGitCommit — the resolution order (flair#1432)", () => {
  test("git checkout: returns the tree's real 40-hex HEAD (a normal build records a real commit)", () => {
    const [dir, head] = makeGitRepo();
    const restore = isolateGit(dir);
    try {
      const got = resolveBenchGitCommit(dir);
      expect(got).toBe(head);
      expect(got).toMatch(COMMIT_SHA_RE);
    } finally {
      restore();
    }
  });

  test("NOT a repo, no stamp, no override: THROWS — never returns a null-commit", () => {
    const dir = tmpDir("bare");
    const restore = isolateGit(dir);
    try {
      // The core of the fix: the old code returned null here and the artifact
      // sealed it. It must now refuse, actionably.
      expect(() => resolveBenchGitCommit(dir)).toThrow(/gitCommit unresolved/);
      expect(() => resolveBenchGitCommit(dir)).toThrow(new RegExp(COMMIT_ENV_OVERRIDE));
      // And it never yields a value that could be recorded.
      let returned: string | undefined;
      try { returned = resolveBenchGitCommit(dir); } catch { /* expected */ }
      expect(returned).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("installed/exported package: resolves the commit from dist/build-info.json (no .git needed)", () => {
    const dir = tmpDir("stamped");
    const stamped = "abcdef0123456789abcdef0123456789abcdef01";
    writeStamp(dir, stamped);
    const restore = isolateGit(dir);
    try {
      expect(resolveBenchGitCommit(dir)).toBe(stamped);
    } finally {
      restore();
    }
  });

  test("a build-info stamp whose commit is NULL (tarball build) falls through to the throw — the stamped null is never adopted", () => {
    const dir = tmpDir("stampnull");
    writeStamp(dir, null);
    const restore = isolateGit(dir);
    try {
      expect(() => resolveBenchGitCommit(dir)).toThrow(/gitCommit unresolved/);
    } finally {
      restore();
    }
  });

  test("a malformed (short) stamp commit is rejected, not truncated — falls through to the throw", () => {
    const dir = tmpDir("stampshort");
    writeStamp(dir, "abc123" as unknown as string);
    const restore = isolateGit(dir);
    try {
      expect(() => resolveBenchGitCommit(dir)).toThrow(/gitCommit unresolved/);
    } finally {
      restore();
    }
  });

  test(`${COMMIT_ENV_OVERRIDE}: a valid 40-hex override is used when there is no .git and no stamp`, () => {
    const dir = tmpDir("override");
    const override = "0011223344556677889900aabbccddeeff001122";
    const restore = isolateGit(dir);
    process.env[COMMIT_ENV_OVERRIDE] = override;
    try {
      expect(resolveBenchGitCommit(dir)).toBe(override);
    } finally {
      delete process.env[COMMIT_ENV_OVERRIDE];
      restore();
    }
  });

  test(`${COMMIT_ENV_OVERRIDE}: a malformed override THROWS rather than attributing the run to a bad sha`, () => {
    const dir = tmpDir("badoverride");
    const restore = isolateGit(dir);
    process.env[COMMIT_ENV_OVERRIDE] = "not-a-real-sha";
    try {
      expect(() => resolveBenchGitCommit(dir)).toThrow(/not a 40-hex commit sha/);
    } finally {
      delete process.env[COMMIT_ENV_OVERRIDE];
      restore();
    }
  });
});

describe("resolveBenchGitCommit — upward .git discovery guard (flair#1477)", () => {
  // These tests deliberately do NOT use isolateGit(exportDir): the point is to
  // let git's upward discovery REACH the parent repo (the production hazard) and
  // prove the resolver's own --show-toplevel guard — not the test's ceiling —
  // rejects it. The ceiling is set ABOVE the parent so git can still find it.
  function nestedExport(): { parent: string; parentHead: string; exportDir: string; restore: () => void } {
    const [parent, parentHead] = makeGitRepo();
    const exportDir = join(parent, "export"); // an export unpacked INSIDE an unrelated repo, not its own repo
    mkdirSync(exportDir, { recursive: true });
    const saved = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = dirname(parent);
    const restore = () => {
      if (saved === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = saved;
    };
    return { parent, parentHead, exportDir, restore };
  }

  test("the hazard is real: a bare `git rev-parse HEAD` in the export DOES adopt the parent repo's HEAD", () => {
    // This asserts the failure the guard exists to prevent, so the guard tests
    // below are a genuine regression lock and not vacuously green.
    const { parentHead, exportDir, restore } = nestedExport();
    try {
      const raw = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: exportDir, encoding: "utf-8", env: { ...process.env },
      }).trim();
      expect(raw).toBe(parentHead);
    } finally {
      restore();
    }
  });

  test("no stamp: the guarded resolver THROWS rather than adopt the parent's HEAD (wrong-but-real > null)", () => {
    const { parentHead, exportDir, restore } = nestedExport();
    try {
      let returned: string | undefined;
      try { returned = resolveBenchGitCommit(exportDir); } catch { /* expected */ }
      expect(returned).toBeUndefined();
      expect(returned).not.toBe(parentHead);
      expect(() => resolveBenchGitCommit(exportDir)).toThrow(/gitCommit unresolved/);
    } finally {
      restore();
    }
  });

  test("own stamp present: resolves to the export's OWN stamp, never the parent repo's HEAD", () => {
    const { parentHead, exportDir, restore } = nestedExport();
    const stamped = "1122334455667788990011223344556677889900";
    writeStamp(exportDir, stamped);
    try {
      const got = resolveBenchGitCommit(exportDir);
      expect(got).toBe(stamped);
      expect(got).not.toBe(parentHead);
    } finally {
      restore();
    }
  });
});

describe("buildArtifact — fail-closed at the seal (defense-in-depth, flair#1432)", () => {
  const baseInput = () => ({
    configHash: "deadbeef",
    config: { schema: "test", a: 1 },
    runHashes: ["r1", "r2"],
    aggregate: [] as any[],
    gitCommit: "1234567890abcdef1234567890abcdef12345678",
    ollamaHost: "http://host:11434",
    benchHost: "rockit",
    validationSlice: true,
  });

  test("a null gitCommit THROWS — no null-commit artifact is ever produced", () => {
    // The seal used to bind a sign-off to a null. It must now refuse before it
    // can content-address one. Building is the only path to an artifact object,
    // so a throw here means no artifact (and thus nothing to write) exists.
    expect(() => buildArtifact({ ...baseInput(), gitCommit: null as unknown as string })).toThrow(/cannot name its code/);
  });

  test("a short/malformed gitCommit THROWS (not sealed, not truncated)", () => {
    expect(() => buildArtifact({ ...baseInput(), gitCommit: "abc123" })).toThrow(/40-hex/);
  });

  test("a real 40-hex gitCommit builds, records the commit verbatim, and self-seals", () => {
    const art = buildArtifact(baseInput());
    expect(art.gitCommit).toBe("1234567890abcdef1234567890abcdef12345678");
    expect(art.gitCommit).toMatch(COMMIT_SHA_RE);
    expect(art.artifactHash).toBeTruthy();
  });
});

describe("assertBenchGitCommit — the shared guard", () => {
  test("returns the sha for a valid 40-hex", () => {
    const sha = "ffffffffffffffffffffffffffffffffffffffff";
    expect(assertBenchGitCommit(sha)).toBe(sha);
  });

  test.each([
    ["null", null],
    ["undefined", undefined],
    ["empty", ""],
    ["short", "abc123"],
    ["39-hex", "f".repeat(39)],
    ["41-hex", "f".repeat(41)],
    ["uppercase", "F".repeat(40)],
    ["non-hex", "g".repeat(40)],
  ])("throws for %s", (_label, value) => {
    expect(() => assertBenchGitCommit(value as unknown as string)).toThrow();
  });
});
