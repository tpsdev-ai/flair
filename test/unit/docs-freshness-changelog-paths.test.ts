// docs-freshness changelog rule is path-aware (flair#1098).
//
// The per-change rule used to demand a fragment from any feat/fix since the
// merge-base, regardless of which paths the change touched. A scripts/-only
// fix cannot reach a user — it is not a changelog event. A src/ fix ships via
// dist/ and still must carry a fragment.
//
// These tests are behaviour tests: they build a throwaway repo, run the real
// gate as a subprocess, and assert on the exit code and the message. Helper
// tests pin the published-set derivation to publishedEntryNames() so the two
// readers cannot drift.

import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { publishedEntryNames as deployPublishedEntryNames } from "../../src/deploy.js";
import {
  changeTouchesPublished,
  pathTouchesPublished,
  publishedEntryNames,
} from "../../scripts/published-paths.mjs";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT_REL = join("scripts", "docs-freshness-check.mjs");
const SCRIPT_FILES = ["docs-freshness-check.mjs", "changelog-fragments.mjs", "published-paths.mjs"];

const created: string[] = [];
function track(dir: string): string {
  created.push(dir);
  return dir;
}

function fakeCli(n: number): string {
  const cmds = Array.from({ length: n }, (_, i) =>
    `{ name: () => "cmd${i}", description: () => "does thing ${i}", commands: [] }`,
  ).join(", ");
  return `export const program = { commands: [${cmds}] };\n`;
}

function runGate(dir: string) {
  const r = spawnSync(process.execPath, [join(dir, SCRIPT_REL)], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GITHUB_ACTIONS: "" },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/**
 * A repo the changelog per-change rule can see end to end: `files[]` matching
 * the real package shape, origin/main as the merge-base, a v-tag so the
 * since-tag half has history, and one feat/fix commit that touches `commitRel`.
 */
function makePathAwareRepo(opts: {
  commitRel: string;
  commitBody?: string;
  commitMsg: string;
  files?: unknown;
}): string {
  const dir = track(mkdtempSync(join(tmpdir(), "flair-docs-freshness-paths-")));
  const origin = track(mkdtempSync(join(tmpdir(), "flair-docs-freshness-origin-")));

  mkdirSync(join(dir, "scripts"), { recursive: true });
  for (const f of SCRIPT_FILES) {
    cpSync(join(REPO_ROOT, "scripts", f), join(dir, "scripts", f));
  }

  const pkg: Record<string, unknown> = {
    name: "@tpsdev-ai/flair",
    version: "0.1.0",
    private: true,
  };
  if (opts.files !== undefined) pkg.files = opts.files;
  else {
    pkg.files = [
      "dist/",
      "docs/",
      "schemas/",
      "templates/",
      "config.yaml",
      "LICENSE",
      "README.md",
      "SECURITY.md",
    ];
  }
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "cli.ts"), "const DEFAULT_PORT = 9927;\nexport { DEFAULT_PORT };\n");

  writeFileSync(join(dir, "README.md"), "# Fixture\n\nNothing stale in here.\n");
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs", "quickstart.md"), "# Quickstart\n\nInstall vX.Y.Z and go.\n");
  writeFileSync(
    join(dir, "CHANGELOG.md"),
    "# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2020-01-01\n\n### Added\n\n- Initial.\n",
  );
  mkdirSync(join(dir, ".changelog", "unreleased"), { recursive: true });
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "cli.js"), fakeCli(3));

  const g = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "ignore"] });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "fixture@example.invalid");
  g("config", "user.name", "Fixture");
  g("config", "commit.gpgsign", "false");
  g("add", "-A");
  g("commit", "-qm", "chore: fixture");
  g("tag", "v0.1.0");

  execFileSync("git", ["init", "--bare", "-q"], { cwd: origin });
  g("remote", "add", "origin", origin);
  g("push", "-q", "origin", "HEAD:refs/heads/main");
  g("fetch", "-q", "origin");

  const abs = join(dir, opts.commitRel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, opts.commitBody ?? "// change\n");
  g("add", "--", opts.commitRel);
  g("commit", "-qm", opts.commitMsg);

  return dir;
}

describe("published set matches publishedEntryNames()", () => {
  test("the gate and the deploy filter read the same names on this repo", () => {
    // One definition of "ships". If someone edits the always-includes in
    // src/deploy.ts and not here (or the reverse), this is the failure.
    const fromDeploy = [...deployPublishedEntryNames(REPO_ROOT)].sort();
    const fromGate = [...publishedEntryNames(REPO_ROOT)].sort();
    expect(fromGate).toEqual(fromDeploy);
  });
});

describe("pathTouchesPublished mapping", () => {
  const published = publishedEntryNames(REPO_ROOT);

  test("src/ ships via dist even though src is not in files[]", () => {
    expect(published.has("src")).toBe(false);
    expect(published.has("dist")).toBe(true);
    expect(pathTouchesPublished("src/cli.ts", published)).toBe(true);
  });

  test("resources/ ships via dist even though resources is not in files[]", () => {
    expect(published.has("resources")).toBe(false);
    expect(pathTouchesPublished("resources/memory.ts", published)).toBe(true);
  });

  test("docs/ ships — it is in files[]", () => {
    expect(published.has("docs")).toBe(true);
    expect(pathTouchesPublished("docs/quickstart.md", published)).toBe(true);
  });

  test("scripts/, tests, and CI do not ship", () => {
    expect(pathTouchesPublished("scripts/release.sh", published)).toBe(false);
    expect(pathTouchesPublished("test/unit/foo.test.ts", published)).toBe(false);
    expect(pathTouchesPublished(".github/workflows/test.yml", published)).toBe(false);
  });

  test("missing files[] is fail-closed — cannot prove a path is unpublished", () => {
    const empty = track(mkdtempSync(join(tmpdir(), "flair-published-nofiles-")));
    writeFileSync(join(empty, "package.json"), JSON.stringify({ name: "x", version: "0.0.0" }));
    expect(changeTouchesPublished(["scripts/only.mjs"], empty)).toBe(true);
  });

  test("an empty changed-path list is fail-closed", () => {
    expect(changeTouchesPublished([], REPO_ROOT)).toBe(true);
  });
});

describe("changelog-unreleased per-change rule, path-aware", () => {
  test("a feat/fix that only touches scripts/ does not require a fragment", () => {
    const dir = makePathAwareRepo({
      commitRel: join("scripts", "unrelated.mjs"),
      commitMsg: "fix: tweak a release helper",
    });
    const res = runGate(dir);
    expect(res.out).not.toContain("changelog fragment");
    expect(res.status).toBe(0);
  });

  test("a feat/fix that touches src/ still requires a fragment", () => {
    const dir = makePathAwareRepo({
      commitRel: join("src", "cli.ts"),
      commitBody: "const DEFAULT_PORT = 9927;\nexport { DEFAULT_PORT };\n// shipping change\n",
      commitMsg: "fix: shipping CLI change",
    });
    const res = runGate(dir);
    expect(res.status).not.toBe(0);
    expect(res.out).toContain("changelog fragment");
    expect(res.out).toMatch(/feat\/fix commit/);
  });
});

describe("cleanup", () => {
  test("removes fixtures", () => {
    for (const d of created) rmSync(d, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});
