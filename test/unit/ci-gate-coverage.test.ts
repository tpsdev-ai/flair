// Gates that cover nothing (flair#953, sweep half).
//
// The defect this PR is about — an absent result rendering as a passing one —
// has a quiet cousin: a gate whose *corpus* silently shrinks. Nothing goes red,
// nothing prints "skipping"; the check simply examines fewer things than anyone
// believes it does, and reports the same tick either way.
//
// Two live instances, both found by asking "what does this gate actually scan?"
// rather than by reading its logic:
//
//   - `test/*.test.ts` — 12 files, 250 cases — were run by NO CI command. Every
//     `bun test` in every workflow targets a subdirectory, and a subdirectory
//     filter does not pick up root-level files. A bare `bun test` (what
//     CONTRIBUTING.md tells contributors to run) DOES run them, so they passed
//     locally and were enforced nowhere.
//   - `packages/hermes-flair/` has no tsconfig.json, so the typecheck job
//     printed one "Skipping" line into a folded log and stayed green.
//
// These are invariant tests, not source-string tests: they enumerate what exists
// on disk and assert CI reaches all of it. Adding a test directory that no job
// runs, or a package nobody typechecks, fails here.

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const WORKFLOW_DIR = join(REPO_ROOT, ".github", "workflows");

function workflowText(): string {
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => readFileSync(join(WORKFLOW_DIR, f), "utf8"))
    .join("\n");
}

/** Every *.test.ts under test/, as a repo-relative path. */
function allTestFiles(dir = join(REPO_ROOT, "test")): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    if (name.isDirectory()) out.push(...allTestFiles(full));
    else if (name.name.endsWith(".test.ts")) out.push(relative(REPO_ROOT, full));
  }
  return out.sort();
}

/**
 * The directory prefixes CI actually hands to `bun test`, plus whether the
 * root-level glob is present. Derived from the workflow text so it cannot drift
 * from what CI runs.
 */
function ciTestTargetsFromText(text: string): { dirs: string[]; rootGlob: boolean } {
  const dirs = new Set<string>();
  let rootGlob = false;
  for (const m of text.matchAll(/bun test ((?:[^\s|&;`\n]+\s*)+)/g)) {
    for (const target of m[1].trim().split(/\s+/)) {
      if (target === "test/*.test.ts") rootGlob = true;
      else if (target.startsWith("test/")) dirs.add(target.replace(/\/$/, ""));
    }
  }
  return { dirs: [...dirs], rootGlob };
}

function ciTestTargets(): { dirs: string[]; rootGlob: boolean } {
  return ciTestTargetsFromText(workflowText());
}

/**
 * Detect file-by-file shell loops that run test files in isolated directories.
 *
 * Pattern: `for f in test/<dir>/*.test.ts; do bun test "$f"` (in workflows)
 *          `for f in "$ROOT"/test/<dir>/*.test.ts; do` (in release.sh)
 *
 * Returns the repo-relative directories these loops cover. This replaces the
 * hand-maintained `loopRun` allowlist (flair#1063) — coverage is now derived
 * from what CI actually does, not from a list someone must edit.
 */
function loopRunDirsFromText(workflowText: string, releaseScriptText: string): string[] {
  const dirs = new Set<string>();

  // Workflow: `for f in test/<dir>/*.test.ts; do` inside a YAML `run:` block
  for (const m of workflowText.matchAll(/for f in (test\/[^\/]+)\/\*\.test\.ts; do/g)) {
    dirs.add(m[1]);
  }

  // Release script: `for f in "$ROOT"/test/<dir>/*.test.ts; do`
  for (const m of releaseScriptText.matchAll(/for f in "\$ROOT"\/(test\/[^\/]+)\/\*\.test\.ts; do/g)) {
    dirs.add(m[1]);
  }

  return [...dirs].sort();
}

function loopRunDirs(): string[] {
  const wf = workflowText();
  const rs = readFileSync(join(REPO_ROOT, "scripts", "release.sh"), "utf8");
  return loopRunDirsFromText(wf, rs);
}

describe("every test file is reachable from a CI command", () => {
  const files = allTestFiles();
  const { dirs, rootGlob } = ciTestTargets();

  test("the enumeration itself found tests (positive control)", () => {
    // A zero-length list would make every assertion below vacuously true — the
    // exact failure mode this file exists to catch.
    expect(files.length).toBeGreaterThan(100);
  });

  test("CI runs the root-level test/*.test.ts files", () => {
    // These were invisible to CI entirely. `bun test test/unit/` does not match
    // test/foo.test.ts, and nothing else targeted them.
    const rootLevel = files.filter((f) => f.split("/").length === 2);
    if (rootLevel.length > 0) {
      expect(rootGlob).toBe(true);
    }
  });

  test("no test file sits in a directory CI never runs", () => {
    // Directories run file-by-file in a shell loop (`bun test "$f"` per file)
    // are detected by parsing the actual workflow and release script for
    // `for f in <dir>/*.test.ts; do` constructs. No hand-maintained list
    // (flair#1063).
    const loopDirs = loopRunDirs();
    const covered = (f: string) =>
      (f.split("/").length === 2 && rootGlob) ||
      [...dirs, ...loopDirs].some((d) => f.startsWith(`${d}/`));

    const orphans = files.filter((f) => !covered(f));
    expect(orphans).toEqual([]);
  });

  test("loop directory parser detects file-by-file loops from workflow + release.sh", () => {
    // Proves the parser sees the actual loop constructs, not a hand-maintained list.
    // Using synthetic text so the assertion is self-contained and cannot be
    // invalidated by workflow refactors that move the loops elsewhere.
    const syntheticWorkflow = `
      run: |
        for f in test/unit-isolated/*.test.ts; do
          bun test "$f" || exit 1
        done
        for f in test/integration-isolated/*.test.ts; do
          bun test "$f" || exit 1
        done
    `;
    const syntheticRelease = `
      for f in "$ROOT"/test/unit-isolated/*.test.ts; do
        bun test "$f"
      done
    `;
    const detected = loopRunDirsFromText(syntheticWorkflow, syntheticRelease);
    expect(detected).toContain("test/unit-isolated");
    expect(detected).toContain("test/integration-isolated");
  });

  test("dangerous staleness: removing a loop from CI leaves orphans (the guard fails)", () => {
    // This is the core invariant that flair#1063 fixes. If a loop is removed
    // from the workflow/release.sh but the directory still contains test files,
    // the coverage guard MUST report them as orphans — not silently pass.
    //
    // We prove this with synthetic text that omits one loop. The test files
    // we enumerate come from the real filesystem (allTestFiles()), so the
    // orphan directory really exists with real .test.ts files in it.

    // Synthetic workflow that has the unit-isolated loop but NOT the integration-isolated loop.
    // (mimics: someone deleted the integration-isolated CI step but the directory still has files)
    const workflowWithMissingLoop = `
      - run: bun test test/unit/ test/*.test.ts
      - name: "Isolated unit files"
        run: |
          for f in test/unit-isolated/*.test.ts; do
            bun test "$f" || exit 1
          done
    `;
    const releaseScriptWithBothLoops = `
      for f in "$ROOT"/test/unit-isolated/*.test.ts; do
        bun test "$f"
      done
      for f in "$ROOT"/test/integration-isolated/*.test.ts; do
        bun test "$f"
      done
    `;

    // Parse the synthetic workflow (missing integration-isolated loop) but keep
    // release.sh with it — simulates workflow CI was trimmed but release script
    // still has it. Files in test/integration-isolated/ are still covered via
    // release.sh, so we need a scenario where NEITHER source has the loop.

    // Better: remove the loop from BOTH sources to prove the dangerous case.
    const releaseScriptAlsoMissing = `
      for f in "$ROOT"/test/unit-isolated/*.test.ts; do
        bun test "$f"
      done
    `;

    const { dirs: _dirs, rootGlob: _rootGlob } = ciTestTargetsFromText(workflowWithMissingLoop);
    const loopDirs = loopRunDirsFromText(workflowWithMissingLoop, releaseScriptAlsoMissing);

    // test/integration-isolated/ must NOT be in loopDirs (the loop was removed from both sources)
    expect(loopDirs).not.toContain("test/integration-isolated");

    // But the directory still has real test files on disk
    const isolatedFiles = allTestFiles(join(REPO_ROOT, "test", "integration-isolated"));
    expect(isolatedFiles.length).toBeGreaterThan(0);

    // Every file in that directory must now be an orphan
    const covered = (f: string) =>
      (f.split("/").length === 2 && _rootGlob) ||
      [..._dirs, ...loopDirs].some((d) => f.startsWith(`${d}/`));
    const orphans = isolatedFiles.filter((f) => !covered(f));
    expect(orphans.length).toBeGreaterThan(0);
  });
});

describe("every workspace package is typechecked or explicitly excused", () => {
  const packagesDir = join(REPO_ROOT, "packages");
  const pkgs = readdirSync(packagesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  test("the enumeration found packages (positive control)", () => {
    expect(pkgs.length).toBeGreaterThan(0);
  });

  test("a package with no tsconfig.json is named in the workflow's allowlist", () => {
    // Before this, an unlisted package without a tsconfig got zero type coverage
    // and one line in a folded log. The allowlist makes the exclusion a decision
    // somebody wrote down rather than an accident nobody can see.
    const text = workflowText();
    const m = text.match(/ALLOWED_UNTYPED="([^"]*)"/);
    expect(m).not.toBeNull();
    const allowed = (m?.[1] ?? "").split(/\s+/).filter(Boolean);

    const untyped = pkgs.filter((p) => !existsSync(join(packagesDir, p, "tsconfig.json")));
    for (const p of untyped) {
      expect(allowed).toContain(p);
    }
  });
});

describe("the impl-term-leak gate cannot report clean without scanning", () => {
  const src = readFileSync(join(REPO_ROOT, "scripts", "check-impl-term-leaks.sh"), "utf8");

  test("grep's exit status is inspected rather than discarded with || true", () => {
    // `grep ... || true` collapses grep's error status (>=2: unreadable file,
    // argv overflow) into its "no matches" status (1). Verified empirically: a
    // grep over a chmod-000 file returns 2, and the old line printed
    // "No leaks found." and exited 0.
    const grepLine = src.split("\n").find((l) => l.includes("grep -n -E \"$PATTERNS\"")) ?? "";
    expect(grepLine.length).toBeGreaterThan(0);
    expect(grepLine).not.toMatch(/\|\|\s*(true|:)/);
    expect(src).toContain("GREP_RC");
  });

  test("an empty corpus is a failure, not a pass", () => {
    expect(src).not.toContain('echo "No files to search."');
    expect(src).toMatch(/found 0 files to search[\s\S]*?exit 1/);
  });

  test("the file list is not word-split", () => {
    // `$(cat "$TMPFILE")` unquoted splits `docs/name with space.md` into three
    // nonexistent paths — which the old code then reported as clean.
    expect(src).not.toMatch(/grep[^\n]*\$\(cat "\$TMPFILE"\)/);
  });

  test("the ops-* allowlist is four exact literals compared by string equality (flair#1381)", () => {
    // A regex or "looks like a word" heuristic would exempt a real bead ID
    // the first time one happened to look English. The behavioural suite in
    // impl-term-leaks.test.ts proves the list is load-bearing; this pins the
    // committed shape so the exemption cannot widen in the source unnoticed.
    expect(src).toMatch(/^ops-port$/m);
    expect(src).toMatch(/^ops-api$/m);
    expect(src).toMatch(/^ops-target$/m);
    expect(src).toMatch(/^ops-server$/m);
    expect(src).toContain('[ "$1" = "$allowed" ]');
    expect(src).not.toMatch(/ops-\(port\|api\|target\|server\)/);
  });
});

describe("the release script does not tag a partial publish", () => {
  const src = readFileSync(join(REPO_ROOT, "scripts", "release.sh"), "utf8");

  test("soft-failed publishes are collected", () => {
    expect(src).toContain("SOFT_FAILED");
  });

  test("the failure count is checked before the tag is created", () => {
    const guardAt = src.indexOf("${#SOFT_FAILED[@]} > 0");
    const tagAt = src.indexOf('git -C "$ROOT" tag -a "v${VERSION}"');
    expect(guardAt).toBeGreaterThan(-1);
    expect(tagAt).toBeGreaterThan(-1);
    // Order is the whole point: a check after the tag is not a check.
    expect(guardAt).toBeLessThan(tagAt);
  });

  test("no publish is soft-failed with a bare warning that returns success", () => {
    const bare = src
      .split("\n")
      .filter((l) => /npm publish\)\s*\|\|\s*\{\s*echo\s+"⚠/.test(l));
    expect(bare).toEqual([]);
  });
});
