// Tests for the PR event login and the recorded release author name.

import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { load } from "js-yaml";
import { pathToFileURL } from "node:url";

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
  execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
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
  // A source file the docs-freshness check never reads at load, so deleting it
  // exercises the diff rule rather than the checker's own inputs.
  writeFileSync(join(dir, "src", "util.ts"), "export const unit = 1;\n");
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

function runGate(dir: string, author?: string, gitEnv: NodeJS.ProcessEnv = process.env): { status: number | null; out: string } {
  const env: NodeJS.ProcessEnv = { ...gitEnv, GITHUB_ACTIONS: "", GITHUB_BASE_REF: "main" };
  delete env.FLAIR_PR_AUTHOR_LOGIN;
  if (author !== undefined) env.FLAIR_PR_AUTHOR_LOGIN = author;
  const r = spawnSync(process.execPath, [join(dir, SCRIPT_REL)], { cwd: dir, encoding: "utf8", env });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function runPromotion(dir: string, extraArgs: string[] = [], env: NodeJS.ProcessEnv = process.env) {
  const r = spawnSync("bash", [join(dir, "scripts", "release-promote-changelog.sh"), "0.2.0", ...extraArgs], {
    cwd: dir, encoding: "utf8", env,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function failingGitEnv(dir: string, command: string): NodeJS.ProcessEnv {
  const bin = join(dir, "fake-bin");
  mkdirSync(bin);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const shim = join(bin, "git");
  writeFileSync(shim, `#!/bin/sh\nif [ "$1" = "${command}" ]; then echo forced-${command}-failure >&2; exit 1; fi\nexec "${realGit}" "$@"\n`);
  chmodSync(shim, 0o755);
  return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
}

function addDependencyOnlyCommit(dir: string, opts: { author?: "renovate"; type?: "chore" | "fix" } = {}): void {
  writeFixtureFile(dir, join("packages", "dep", "package.json"), JSON.stringify({
    name: "@example/dep",
    version: "1.0.0",
  }, null, 2) + "\n");
  writeFixtureFile(dir, "bun.lock", "# fixture lockfile\n# left-pad 1.3.0\n");
  git(dir, "add", "-A");
  if (opts.author === "renovate") {
    commitAs(dir, "renovate[bot]", "fixture@example.invalid", `${opts.type ?? "fix"}(deps): update dependency left-pad to v1.3.0 (#42)`);
  } else {
    commitAs(dir, "Fixture", "fixture@example.invalid", `${opts.type ?? "fix"}(deps): update dependency left-pad to v1.3.0 (#42)`);
  }
}

/** One fix commit, recorded author renovate[bot], touching only root package.json. */
function addRenovateRootManifestCommit(dir: string): void {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  pkg.dependencies = { "left-pad": "1.3.0" };
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  git(dir, "add", "-A");
  commitAs(dir, "renovate[bot]", "fixture@example.invalid", "fix(deps): update dependency left-pad to v1.3.0 (#42)");
}

describe("Git basename classification", () => {
  test.each([
    { paths: [" package.json"], accepted: false },
    { paths: ["package.json "], accepted: false },
    { paths: ["packages\\package.json"], accepted: false },
    { paths: ["packages/dep/ package.json"], accepted: false },
    { paths: ["packages/dep/package.json "], accepted: false },
    { paths: ["package.json", ""], accepted: false },
    { paths: [], accepted: false },
    { paths: ["packages/dep/package.json", "packages/dep/bun.lock", "packages/dep/bun.lockb", "packages/dep/package-lock.json", "packages/dep/npm-shrinkwrap.json"], accepted: true },
  ])("classifies %j", ({ paths, accepted }) => {
    const url = pathToFileURL(join(REPO_ROOT, "scripts", "dependency-change.mjs")).href;
    const result = execFileSync(process.execPath, ["--input-type=module", "-e",
      `import { isDependencyOnlyChange } from ${JSON.stringify(url)}; console.log(isDependencyOnlyChange(${JSON.stringify(paths)}));`,
    ], { encoding: "utf8" });
    expect(result.trim()).toBe(String(accepted));
  });
});

describe("PR author login and accepted JavaScript filenames", () => {
  test("Renovate dependency-only fix without a fragment prints the waiver", () => {
    const dir = makeRepo();
    addDependencyOnlyCommit(dir, { author: "renovate" });
    const res = runGate(dir, "renovate[bot]");
    expect(res.out).toContain("waived the per-PR fragment requirement");
    expect(res.out).not.toContain("adds no changelog fragment");
    expect(res.status).toBe(0);
  });

  test.each([" package.json", "package.json ", "packages\\package.json"])(
    "PR gate refuses the dependency waiver for %j",
    (filename) => {
      const dir = makeRepo();
      writeFixtureFile(dir, filename, "{}\n");
      git(dir, "add", "-A");
      commitAs(dir, "renovate[bot]", "fixture@example.invalid", "fix(deps): add manifest lookalike");
      const result = runGate(dir, "renovate[bot]");
      expect(result.out).not.toContain("waived the per-PR fragment requirement");
      expect(result.out).toContain("adds no changelog fragment");
      expect(result.status).not.toBe(0);
    },
  );

  test("nested accepted basenames waive the PR fragment and enter release notes", () => {
    const dir = makeRepo();
    for (const directory of ["packages/dep", "packages/line\nbreak"]) {
      for (const filename of ["package.json", "bun.lock", "bun.lockb", "package-lock.json", "npm-shrinkwrap.json"]) {
        writeFixtureFile(dir, `${directory}/${filename}`, "{}\n");
      }
    }
    git(dir, "add", "-A");
    commitAs(dir, "renovate[bot]", "fixture@example.invalid", "fix(deps): add nested manifests");
    const result = runGate(dir, "renovate[bot]");
    expect(result.status).toBe(0);
    expect(result.out).toContain("waived the per-PR fragment requirement");
    cpSync(join(REPO_ROOT, "scripts", "release-promote-changelog.sh"), join(dir, "scripts", "release-promote-changelog.sh"));
    expect(runPromotion(dir).status).toBe(0);
    expect(readFileSync(join(dir, "CHANGELOG.md"), "utf8")).toContain("- fix(deps): add nested manifests");
  });

  test("Renovate dependency-only chore prints no waiver", () => {
    const dir = makeRepo();
    addDependencyOnlyCommit(dir, { author: "renovate", type: "chore" });
    const res = runGate(dir, "renovate[bot]");
    expect(res.out).not.toContain("waived the per-PR fragment requirement");
    expect(res.status).toBe(0);
  });

  test("Renovate fix adding a fragment prints no waiver", () => {
    const dir = makeRepo();
    addDependencyOnlyCommit(dir, { author: "renovate" });
    writeFixtureFile(dir, ".changelog/unreleased/fixed-dependency.md", "- **Update the dependency.**\n");
    git(dir, "add", "-A");
    commitAs(dir, "renovate[bot]", "fixture@example.invalid", "chore: add fragment");
    const res = runGate(dir, "renovate[bot]");
    expect(res.out).not.toContain("waived the per-PR fragment requirement");
    expect(res.status).toBe(0);
  });

  test("Renovate fix adding a source file requires a fragment", () => {
    const dir = makeRepo();
    addDependencyOnlyCommit(dir);
    writeFixtureFile(dir, join("packages", "dep", "src", "index.ts"), "export const n = 1;\n");
    git(dir, "add", "-A");
    commitAs(dir, "Fixture", "fixture@example.invalid", "fix(deps): adjust dependency source");
    const res = runGate(dir, "renovate[bot]");
    expect(res.out).toContain("adds no changelog fragment");
    expect(res.status).not.toBe(0);
  });

  test.each(["deletion", "mode change"])("dependency diff with a source %s requires a fragment", (change) => {
    const dir = makeRepo();
    addDependencyOnlyCommit(dir, { author: "renovate" });
    // The deletion removes src/util.ts: deleting src/cli.ts would stop the
    // checker itself, which reads it for the default port, before the diff rule runs.
    if (change === "deletion") git(dir, "rm", "-q", "src/util.ts");
    else git(dir, "update-index", "--chmod=+x", "src/cli.ts");
    commitAs(dir, "renovate[bot]", "fixture@example.invalid", `fix(deps): source ${change}`);
    expect(gitOut(dir, "diff", "--name-status", "origin/main..HEAD")).toMatch(
      change === "deletion" ? /^D\s+src\/util\.ts$/m : /^M\s+src\/cli\.ts$/m,
    );
    if (change === "mode change") {
      const diff = gitOut(dir, "diff", "origin/main..HEAD", "--", "src/cli.ts");
      expect(diff).toContain("old mode 100644\nnew mode 100755");
      expect(diff).not.toContain("@@");
    }
    const result = runGate(dir, "renovate[bot]");
    expect(result.out).not.toContain("waived the per-PR fragment requirement");
    expect(result.out).toContain("adds no changelog fragment");
    expect(result.status).not.toBe(0);
  });

  test.each(["merge-base", "diff"])("git %s failure still requires a fragment for a human-authored dependency commit", (command) => {
    const dir = makeRepo();
    addDependencyOnlyCommit(dir);
    const result = runGate(dir, "renovate[bot]", failingGitEnv(dir, command));
    expect(result.out).not.toContain("waived the per-PR fragment requirement");
    expect(result.out).toContain("no changelog fragments staged");
    expect(result.status).not.toBe(0);
  });

  test.each(["human-a", undefined])(
    "unavailable merge base skips when the only fix commit was excluded as Renovate (login %p)",
    (login) => {
      const dir = makeRepo();
      addRenovateRootManifestCommit(dir);
      git(dir, "update-ref", "-d", "refs/remotes/origin/main");
      const res = runGate(dir, login);
      expect(res.status).not.toBe(0);
      expect(res.out).toContain("DID NOT RUN");
      expect(res.out).toContain("no merge base with origin/main");
      expect(res.out).toContain("fetch-depth: 0");
      expect(res.out).not.toContain("waived the per-PR fragment requirement");
    },
  );

  test("a reachable merge base with a human login fails on the missing fragment", () => {
    const dir = makeRepo();
    addRenovateRootManifestCommit(dir);
    const res = runGate(dir, "human-a");
    expect(res.status).toBe(1);
    expect(res.out).toContain("adds no changelog fragment");
    expect(res.out).not.toContain("waived the per-PR fragment requirement");
  });

  test("Renovate fix renaming a source file to package.json requires a fragment", () => {
    const dir = makeRepo();
    writeFixtureFile(dir, "src/manifest.json", "{\"name\":\"example\"}\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "chore: add source manifest");
    git(dir, "push", "-q", "origin", "HEAD:refs/heads/main");
    git(dir, "fetch", "-q", "origin");
    mkdirSync(join(dir, "packages", "renamed"), { recursive: true });
    git(dir, "mv", "src/manifest.json", "packages/renamed/package.json");
    commitAs(dir, "renovate[bot]", "fixture@example.invalid", "fix(deps): rename source manifest");
    expect(gitOut(dir, "diff", "--name-status", "origin/main..HEAD")).toMatch(/^R\d+\s+src\/manifest.json\s+packages\/renamed\/package.json/m);
    const res = runGate(dir, "renovate[bot]");
    expect(res.out).toContain("adds no changelog fragment");
    expect(res.status).not.toBe(0);
    cpSync(join(REPO_ROOT, "scripts", "release-promote-changelog.sh"), join(dir, "scripts", "release-promote-changelog.sh"));
    const promotion = runPromotion(dir);
    expect(promotion.status).not.toBe(0);
    expect(promotion.out).toContain("no fragments");
  });

  test("dependency-only fix with a human event login requires a fragment", () => {
    const dir = makeRepo();
    addDependencyOnlyCommit(dir);
    const res = runGate(dir, "human-a");
    expect(res.out).not.toContain("waived the per-PR fragment requirement");
    expect(res.out).toContain("adds no changelog fragment");
    expect(res.status).not.toBe(0);
  });

  test("dependency-only fix without an event login requires a fragment", () => {
    const dir = makeRepo();
    addDependencyOnlyCommit(dir);
    const res = runGate(dir);
    expect(res.out).not.toContain("waived the per-PR fragment requirement");
    expect(res.out).toContain("adds no changelog fragment");
    expect(res.status).not.toBe(0);
  });

  test("dependency-only fix with an empty event login requires a fragment", () => {
    const dir = makeRepo();
    addDependencyOnlyCommit(dir);
    const res = runGate(dir, "");
    expect(res.out).not.toContain("waived the per-PR fragment requirement");
    expect(res.out).toContain("adds no changelog fragment");
    expect(res.status).not.toBe(0);
  });

  test("Renovate-named fix with a human event login requires a fragment", () => {
    const dir = makeRepo();
    addDependencyOnlyCommit(dir, { author: "renovate" });
    const res = runGate(dir, "human-a");
    expect(res.out).not.toContain("waived the per-PR fragment requirement");
    expect(res.out).toContain("adds no changelog fragment");
    expect(res.status).not.toBe(0);
  });
});

describe("release-time history", () => {
  test.each([" package.json", "package.json ", "packages\\package.json"])(
    "promotion excludes a commit adding %j",
    (filename) => {
      const dir = makeRepo();
      writeFixtureFile(dir, filename, "{}\n");
      git(dir, "add", "-A");
      commitAs(dir, "renovate[bot]", "fixture@example.invalid", "fix(deps): add manifest lookalike");
      cpSync(join(REPO_ROOT, "scripts", "release-promote-changelog.sh"), join(dir, "scripts", "release-promote-changelog.sh"));
      const result = runPromotion(dir);
      expect(result.status).not.toBe(0);
      expect(result.out).toContain("no fragments");
    },
  );

  test("a dependency-only root commit enters a no-tag release with explicit permission", () => {
    const dir = tempDir("flair-renovate-root-");
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "commit.gpgsign", "false");
    writeFixtureFile(dir, "packages/dep/package.json", "{}\n");
    git(dir, "add", "-A");
    commitAs(dir, "renovate[bot]", "fixture@example.invalid", "fix(deps): initial dependency");
    for (const file of [...SCRIPT_FILES, "release-promote-changelog.sh"]) {
      writeFixtureFile(dir, `scripts/${file}`, readFileSync(join(REPO_ROOT, "scripts", file), "utf8"));
    }
    writeFixtureFile(dir, "CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n");
    const refused = runPromotion(dir);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("pass --allow-no-release-tag");
    const allowed = runPromotion(dir, ["--allow-no-release-tag"]);
    expect(allowed.status).toBe(0);
    expect(readFileSync(join(dir, "CHANGELOG.md"), "utf8")).toContain("### Dependencies\n\n- fix(deps): initial dependency");
  });

  test.each(["deletion", "mode change"])("promotion includes a dependency-only %s", (change) => {
    const dir = makeRepo();
    if (change === "deletion") git(dir, "rm", "-q", "package.json");
    else git(dir, "update-index", "--chmod=+x", "package.json");
    commitAs(dir, "renovate[bot]", "fixture@example.invalid", `fix(deps): manifest ${change}`);
    cpSync(join(REPO_ROOT, "scripts", "release-promote-changelog.sh"), join(dir, "scripts", "release-promote-changelog.sh"));
    expect(runPromotion(dir).status).toBe(0);
    expect(readFileSync(join(dir, "CHANGELOG.md"), "utf8")).toContain(`- fix(deps): manifest ${change}`);
  });

  test("an eligible recorded-name commit does not count as a missing-fragment commit", () => {
    const dir = makeRepo();
    addDependencyOnlyCommit(dir, { author: "renovate" });
    // On main the per-change range is empty; only the since-tag count can fire.
    git(dir, "push", "-q", "origin", "HEAD:refs/heads/main");
    const res = runGate(dir);
    expect(res.out).not.toContain("changelog fragment");
    expect(res.status).toBe(0);
  });

  test("release notes include a human fix and an eligible recorded-name commit", () => {
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

    cpSync(join(REPO_ROOT, "scripts", "release-promote-changelog.sh"), join(dir, "scripts", "release-promote-changelog.sh"));
    const deps = runPromotion(dir);
    expect(deps.status).toBe(0);
    expect(deps.out).toContain("promoted 1 fragment entr(ies)");

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

  test("promotion and rendered notes include dependency commits without fragments", () => {
    const dir = makeRepo();
    addDependencyOnlyCommit(dir, { author: "renovate" });
    cpSync(join(REPO_ROOT, "scripts", "release-promote-changelog.sh"), join(dir, "scripts", "release-promote-changelog.sh"));
    const result = runPromotion(dir);
    expect(result.status).toBe(0);
    expect(result.out).toContain("promoted 0 fragment entr(ies)");
    const changelog = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
    expect(changelog).toContain("### Dependencies\n\n- fix(deps): update dependency left-pad to v1.3.0 (#42)");
    const rendered = execFileSync(process.execPath, [join(dir, "scripts", "changelog-release-notes.mjs"), "0.2.0", "CHANGELOG.md"], { cwd: dir, encoding: "utf8" });
    expect(rendered).toContain("update dependency left-pad to v1.3.0");
  });

  test("promotion refuses a section without fragments or eligible commits", () => {
    const dir = makeRepo();
    addDependencyOnlyCommit(dir);
    cpSync(join(REPO_ROOT, "scripts", "release-promote-changelog.sh"), join(dir, "scripts", "release-promote-changelog.sh"));
    const result = runPromotion(dir);
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("no fragments");
  });

  test("promotion names a failed tag lookup", () => {
    const dir = makeRepo();
    cpSync(join(REPO_ROOT, "scripts", "release-promote-changelog.sh"), join(dir, "scripts", "release-promote-changelog.sh"));
    const result = runPromotion(dir, [], failingGitEnv(dir, "describe"));
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("could not resolve release tag with git describe");
  });

  test("release helper without a tag needs an explicit no-tag flag", () => {
    const dir = makeRepo();
    addDependencyOnlyCommit(dir, { author: "renovate" });
    git(dir, "tag", "-d", "v0.1.0");
    cpSync(join(REPO_ROOT, "scripts", "release-promote-changelog.sh"), join(dir, "scripts", "release-promote-changelog.sh"));
    const refused = runPromotion(dir);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("pass --allow-no-release-tag");
    const allowed = runPromotion(dir, ["--allow-no-release-tag"]);
    expect(allowed.status).toBe(0);
    expect(readFileSync(join(dir, "CHANGELOG.md"), "utf8")).toContain("### Dependencies");
  });

  test.each(["show", "diff-tree"])("promotion stops when git %s fails", (command) => {
    const dir = makeRepo();
    addDependencyOnlyCommit(dir, { author: "renovate" });
    cpSync(join(REPO_ROOT, "scripts", "release-promote-changelog.sh"), join(dir, "scripts", "release-promote-changelog.sh"));
    const result = runPromotion(dir, [], failingGitEnv(dir, command));
    expect(result.status).not.toBe(0);
    expect(result.out).toContain(command === "show" ? "could not read commit" : "could not read diff for commit");
  });
});

describe("release wiring", () => {
  test.each([{ tagArgs: [] }, { tagArgs: ["--allow-no-release-tag"] }])("release promotion invocation runs under /bin/bash with %j", ({ tagArgs }) => {
    const sh = readFileSync(join(REPO_ROOT, "scripts", "release.sh"), "utf8");
    const invocation = sh.split("\n").find((line) => line.startsWith('(cd "$ROOT" && bash scripts/release-promote-changelog.sh '));
    expect(invocation).toBeDefined();
    const dir = tempDir("flair-release-invocation-");
    writeFixtureFile(dir, "scripts/release-promote-changelog.sh", 'printf "%s\\n" "$@"\n');
    writeFixtureFile(dir, "invoke.sh", [
      "set -euo pipefail",
      'ROOT="$1"',
      "VERSION=0.2.0",
      `RELEASE_TAG_ARGS=(${tagArgs.join(" ")})`,
      `${invocation} exit 97; }`,
    ].join("\n"));
    const result = spawnSync("/bin/bash", [join(dir, "invoke.sh"), dir], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(["0.2.0", ...tagArgs]);
  });

  test("promote refuses --allow-no-release-tag without --with-dependencies", () => {
    const dir = tempDir("flair-promote-flags-");
    for (const file of SCRIPT_FILES) {
      writeFixtureFile(dir, `scripts/${file}`, readFileSync(join(REPO_ROOT, "scripts", file), "utf8"));
    }
    writeFixtureFile(dir, "CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n");
    writeFixtureFile(dir, ".changelog/unreleased/fixed-fixture.md", "- **Fixture fix.**\n");
    const result = spawnSync(process.execPath, [join(dir, "scripts", "changelog-fragments.mjs"),
      "promote", "0.2.0", "--allow-no-release-tag"], { cwd: dir, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("promote: --allow-no-release-tag requires --with-dependencies");
  });

  test("docs-freshness step gets the PR event author login exactly once", () => {
    const workflow = load(readFileSync(join(REPO_ROOT, ".github", "workflows", "test.yml"), "utf8")) as {
      jobs: Record<string, { env?: Record<string, string>; steps: Array<{ run?: string; env?: Record<string, string> }> }>;
    };
    const job = workflow.jobs["docs-freshness"];
    const step = job.steps.find((entry) => entry.run === "node scripts/docs-freshness-check.mjs");
    expect(step?.env?.FLAIR_PR_AUTHOR_LOGIN).toBe("${{ github.event.pull_request.user.login }}");
    const bindings = [job.env, ...job.steps.map((entry) => entry.env)].filter((env) => env && Object.hasOwn(env, "FLAIR_PR_AUTHOR_LOGIN"));
    expect(bindings).toHaveLength(1);
    expect(JSON.stringify(job).match(/FLAIR_PR_AUTHOR_LOGIN/g)).toHaveLength(1);
  });
});
