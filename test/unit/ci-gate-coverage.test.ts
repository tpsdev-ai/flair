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
function ciTestTargets(): { dirs: string[]; rootGlob: boolean } {
  const text = workflowText();
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
    // Both *-isolated/ directories are run file-by-file in a shell loop
    // (`bun test "$f"` per file), which the target parser sees as neither a
    // directory nor the root glob — enumerate them here rather than teaching
    // the parser about shell loops. See flair#1063 (follow-up: derive this
    // list conventionally from workflow or filesystem).
    const loopRun = ["test/unit-isolated", "test/integration-isolated"];
    const covered = (f: string) =>
      (f.split("/").length === 2 && rootGlob) ||
      [...dirs, ...loopRun].some((d) => f.startsWith(`${d}/`));

    const orphans = files.filter((f) => !covered(f));
    expect(orphans).toEqual([]);
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
