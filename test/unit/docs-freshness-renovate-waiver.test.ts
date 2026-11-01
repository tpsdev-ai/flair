// Renovate dependency-bump waiver for the docs-freshness gate (flair#2872).
//
// The waiver has two independent halves: the PR author comes from the workflow
// event (FLAIR_PR_AUTHOR_LOGIN), and every changed path is a dependency
// manifest or lockfile. These are behaviour tests: each builds a throwaway git
// repo, runs the real gate as a subprocess, and asserts on the exit code and the
// message. The release-time cases read the same rule from merged history.

import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { tempDir } from "../helpers/temp-dir.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT_REL = join("scripts", "docs-freshness-check.mjs");
const SCRIPT_FILES = [
  "docs-freshness-check.mjs",
  "changelog-fragments.mjs",
  "changelog-release-notes.mjs",
  "changelog-extract.mjs",
  "published-paths.mjs",
  "dependency-change.mjs",
];

function fakeCli(n: number): string {
  const cmds = Array.from({ length: n }, (_, i) =>
    `{ name: () => "cmd${i}", description: () => "does thing ${i}", commands: [] }`,
  ).join(", ");
  return `export const program = { commands: [${cmds}] };\n`;
}

function git(dir: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "ignore"] });
}

function gitOut(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Commit with an explicit author, then leave the fixture identity restored. */
function commitAs(dir: string, name: string, email: string, message: string): void {
  git(dir, "config", "user.name", name);
  git(dir, "config", "user.email", email);
  git(dir, "commit", "-qm", message);
  git(dir, "config", "user.name", "Fixture");
  git(dir, "config", "user.email", "fixture@example.invalid");
}

function writeFixtureFile(dir: string, rel: string, body: string): void {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

function makeRepo(): string {
  const dir = tempDir("flair-renovate-waiver-");
  const origin = tempDir("flair-renovate-waiver-origin-");

  mkdirSync(join(dir, "scripts"), { recursive: true });
  for (const f of SCRIPT_FILES) {
    cpSync(join(REPO_ROOT, "scripts", f), join(dir, "scripts", f));
  }

  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "@tpsdev-ai/flair",
    version: "0.1.0",
    private: true,
    workspaces: ["packages/*"],
    files: ["dist/", "docs/", "schemas/", "templates/", "config.yaml", "LICENSE", "README.md", "SECURITY.md"],
  }, null, 2) + "\n");
  writeFileSync(join(dir, "bun.lock"), "# fixture lockfile\n");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "cli.ts"), "const DEFAULT_PORT = 9927;\nexport { DEFAULT_PORT };\n");
  writeFileSync(join(dir, "README.md"), "# Fixture\n\nNothing stale in here.\n");
  mkdirSync(join(dir, "docs"), { recursive: true });
  mkdirSync(join(dir, "schemas"), { recursive: true });
  writeFileSync(join(dir, "schemas", "memory.graphql"), "type Memory @table(database: \"flair\") {\n  id: ID @primaryKey\n}\n");
  writeFileSync(join(dir, "docs", "api-reference.md"), "# API\n\nMemory is the agent memory table.\n");
  writeFileSync(join(dir, "docs", "quickstart.md"), "# Quickstart\n\nInstall vX.Y.Z and go.\n");
  writeFileSync(
    join(dir, "CHANGELOG.md"),
    "# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2020-01-01\n\n### Added\n\n- Initial.\n",
  );
  mkdirSync(join(dir, ".changelog", "unreleased"), { recursive: true });
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "cli.js"), fakeCli(3));

  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Fixture");
  git(dir, "config", "user.email", "fixture@example.invalid");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "chore: fixture");
  git(dir, "tag", "v0.1.0");

  execFileSync("git", ["init", "--bare", "-q"], { cwd: origin });
  git(dir, "remote", "add", "origin", origin);
  git(dir, "push", "-q", "origin", "HEAD:refs/heads/main");
  git(dir, "fetch", "-q", "origin");
  return dir;
}

function runGate(dir: string, author?: string): { status: number | null; out: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_ACTIONS: "" };
  delete env.FLAIR_PR_AUTHOR_LOGIN;
  if (author !== undefined) env.FLAIR_PR_AUTHOR_LOGIN = author;
  const r = spawnSync(process.execPath, [join(dir, SCRIPT_REL)], { cwd: dir, encoding: "utf8", env });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function addDependencyOnlyCommit(dir: string, opts: { author?: "renovate" } = {}): void {
  writeFixtureFile(dir, join("packages", "dep", "package.json"), JSON.stringify({
    name: "@example/dep",
    version: "1.0.0",
  }, null, 2) + "\n");
  writeFixtureFile(dir, "bun.lock", "# fixture lockfile\n# left-pad 1.3.0\n");
  git(dir, "add", "-A");
  if (opts.author === "renovate") {
    commitAs(dir, "renovate[bot]", "fixture@example.invalid", "fix(deps): update dependency left-pad to v1.3.0 (#42)");
  } else {
    commitAs(dir, "Fixture", "fixture@example.invalid", "fix(deps): update dependency left-pad to v1.3.0 (#42)");
  }
}

describe("Renovate dependency waiver at PR time", () => {
  test("Renovate author + dependency-only diff is waived", () => {
    const dir = makeRepo();
    addDependencyOnlyCommit(dir);
    const res = runGate(dir, "renovate[bot]");
    expect(res.out).toContain("waived the per-PR fragment requirement");
    expect(res.out).not.toContain("adds no changelog fragment");
    expect(res.status).toBe(0);
  });

  test("Renovate author + a source file in the diff still requires a fragment", () => {
    const dir = makeRepo();
    addDependencyOnlyCommit(dir);
    writeFixtureFile(dir, join("packages", "dep", "src", "index.ts"), "export const n = 1;\n");
    git(dir, "add", "-A");
    commitAs(dir, "Fixture", "fixture@example.invalid", "fix(deps): adjust dependency source");
    const res = runGate(dir, "renovate[bot]");
    expect(res.out).toContain("adds no changelog fragment");
    expect(res.status).not.toBe(0);
  });

  test("a human author + dependency-only diff still requires a fragment", () => {
    const dir = makeRepo();
    addDependencyOnlyCommit(dir);
    const res = runGate(dir, "human-a");
    expect(res.out).not.toContain("waived the per-PR fragment requirement");
    expect(res.out).toContain("adds no changelog fragment");
    expect(res.status).not.toBe(0);
  });

  test("a missing author keeps the requirement", () => {
    const dir = makeRepo();
    addDependencyOnlyCommit(dir);
    const res = runGate(dir);
    expect(res.out).not.toContain("waived the per-PR fragment requirement");
    expect(res.out).toContain("adds no changelog fragment");
    expect(res.status).not.toBe(0);
  });

  test("an empty author keeps the requirement", () => {
    const dir = makeRepo();
    addDependencyOnlyCommit(dir);
    const res = runGate(dir, "");
    expect(res.out).not.toContain("waived the per-PR fragment requirement");
    expect(res.out).toContain("adds no changelog fragment");
    expect(res.status).not.toBe(0);
  });

  test("a commit author named renovate[bot] does not waive without the event author", () => {
    const dir = makeRepo();
    addDependencyOnlyCommit(dir, { author: "renovate" });
    const res = runGate(dir, "human-a");
    expect(res.out).not.toContain("waived the per-PR fragment requirement");
    expect(res.out).toContain("adds no changelog fragment");
    expect(res.status).not.toBe(0);
  });
});

describe("release-time history", () => {
  test("a merged Renovate dependency commit does not count as a missing-fragment commit", () => {
    const dir = makeRepo();
    addDependencyOnlyCommit(dir, { author: "renovate" });
    // On main the per-change range is empty; only the since-tag count can fire.
    git(dir, "push", "-q", "origin", "HEAD:refs/heads/main");
    const res = runGate(dir);
    expect(res.out).not.toContain("changelog fragment");
    expect(res.status).toBe(0);
  });

  test("release notes record a human fix and a merged Renovate dependency commit", () => {
    const dir = makeRepo();

    writeFixtureFile(dir, join("src", "cli.ts"), "const DEFAULT_PORT = 9927;\nexport const fixed = true;\n");
    writeFixtureFile(
      dir,
      join(".changelog", "unreleased", "fixed-human.md"),
      "- **Human fix for the widget**\n",
    );
    git(dir, "add", "-A");
    commitAs(dir, "Fixture", "fixture@example.invalid", "fix: correct the widget");

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    pkg.dependencies = { "left-pad": "1.3.0" };
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
    writeFixtureFile(dir, "bun.lock", "# fixture lockfile\n# left-pad 1.3.0\n");
    git(dir, "add", "-A");
    commitAs(dir, "renovate[bot]", "fixture@example.invalid", "fix(deps): update dependency left-pad to v1.3.0 (#42)");

    const before = runGate(dir);
    expect(before.status).toBe(0);

    const deps = execFileSync(
      process.execPath,
      [
        join(dir, "scripts", "changelog-fragments.mjs"),
        "promote",
        "0.2.0",
        "--date=2026-11-01",
        "--with-dependencies",
      ],
      { cwd: dir, encoding: "utf8" },
    );
    expect(deps).toContain("promoted 1 entr(ies)");

    const changelog = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
    expect(changelog).toContain("### Dependencies");
    expect(changelog).toContain("fix(deps): update dependency left-pad to v1.3.0 (#42)");

    const notes = execFileSync(
      process.execPath,
      [join(dir, "scripts", "changelog-release-notes.mjs"), "0.2.0", "CHANGELOG.md"],
      { cwd: dir, encoding: "utf8" },
    );
    expect(notes).toContain("Human fix for the widget");
    expect(notes).toContain("update dependency left-pad to v1.3.0");
    expect(notes).toContain("#42");

    // Release branch: the promoted section matches package.json and no v0.2.0
    // tag exists, so the release-PR exception lets the gate pass.
    const bumped = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    bumped.version = "0.2.0";
    writeFileSync(join(dir, "package.json"), JSON.stringify(bumped, null, 2) + "\n");
    const after = runGate(dir);
    expect(after.status).toBe(0);
  });
});

describe("release wiring", () => {
  test("release.sh asks promote to record dependency commits", () => {
    const sh = readFileSync(join(REPO_ROOT, "scripts", "release.sh"), "utf8");
    expect(sh).toContain('promote "$VERSION" --with-dependencies');
  });
});
