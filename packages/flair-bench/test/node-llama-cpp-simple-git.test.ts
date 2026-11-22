import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { tempDir } from "../../../test/helpers/temp-dir.ts";

/**
 * node-llama-cpp's own simple-git call paths, run against local repositories and
 * the bundle node-llama-cpp ships, with the simple-git
 * that node-llama-cpp resolves in this workspace (#2726 review).
 *
 * node-llama-cpp 3.18.1 declares simple-git ^3.33.0. The root `overrides` move
 * it to simple-git 4, whose major release removed the default export, rejects
 * abbreviated long options and filters ambient GIT_* variables out of git's
 * environment.
 * This test runs node-llama-cpp's real modules (dist/bindings/utils/
 * cloneLlamaCppRepo.js and dist/utils/gitReleaseBundles.js) against that copy:
 *
 *   - the bundle path: the source-build clone from the llama.cpp bundle
 *     node-llama-cpp ships, with the test's .gitconfig rewriting GitHub to a
 *     missing local path;
 *   - the GitHub path: a `--depth 1 --branch <tag>` clone, with
 *     https://github.com/ rewritten to a local bare repo through an isolated
 *     HOME's .gitconfig;
 *   - the CI bundle path (unshallow, squash, re-tag, `git bundle create`) and a
 *     clone from the bundle it writes.
 *
 * The clone and bundle operations exercised here write under node-llama-cpp's
 * install directory (dist/config.js puts llama.cpp/, llama.cpp.info.json and
 * gitRelease.bundle under <package>/llama), so each case runs a COPY of its
 * dist/ in a temp dir. The copy resolves its dependencies (simple-git included)
 * through a node_modules symlink to the directory that holds the real package.
 * The test sets its own HOME and uses its own temp dirs.
 *
 * Skipped only when spawning `git --version` fails with ENOENT (no git could be
 * spawned). Any other probe failure (a nonzero exit, a timeout, unexpected
 * output) fails both git cases with the probe's reason. The GitHub URL that
 * node-llama-cpp builds is rewritten to a local path through the test's own
 * HOME .gitconfig; the system git configuration is not isolated.
 */

const GIT_TIMEOUT_MS = 20_000;
const CASE_BUDGET_MS = 60_000;
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

const requireHere = createRequire(import.meta.url);

/** Walk up from a resolved entry file to the directory whose package.json is `name`. */
function packageRoot(entryFile: string, name: string): string {
  let dir = dirname(realpathSync(entryFile));
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === name) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no package.json named ${name} above ${entryFile}`);
    dir = parent;
  }
}

const nlcRoot = packageRoot(requireHere.resolve("node-llama-cpp"), "node-llama-cpp");
const resolveFrom = (fromDir: string, name: string) =>
  packageRoot(createRequire(join(fromDir, "package.json")).resolve(name), name);
const readVersion = (dir: string): string => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;

type GitProbe = { state: "present" } | { state: "missing" } | { state: "broken"; reason: string };

/**
 * Classify `git --version`. Only ENOENT (no git could be spawned) is "missing"; any other
 * spawn error (a timeout included), a signal, a nonzero exit or output that does
 * not start with "git version" is "broken", which fails the git cases.
 */
function probeGit(env: NodeJS.ProcessEnv = process.env, timeoutMs = GIT_TIMEOUT_MS): GitProbe {
  const res = spawnSync("git", ["--version"], { encoding: "utf8", env, timeout: timeoutMs });
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { state: "missing" };
    if (code === "ETIMEDOUT") return { state: "broken", reason: `\`git --version\` did not finish within ${timeoutMs} ms` };
    return { state: "broken", reason: `\`git --version\` could not run (${code ?? res.error.message})` };
  }
  if (res.status !== 0) {
    const how = res.status === null ? `was killed by ${res.signal}` : `exited ${res.status}`;
    const stderr = (res.stderr ?? "").trim().split("\n")[0];
    return { state: "broken", reason: `\`git --version\` ${how}${stderr ? `: ${stderr}` : ""}` };
  }
  if (!(res.stdout ?? "").startsWith("git version ")) {
    return { state: "broken", reason: `\`git --version\` printed ${JSON.stringify((res.stdout ?? "").slice(0, 80))}, not "git version ..."` };
  }
  return { state: "present" };
}

const gitProbe = probeGit();
const gitMissing = gitProbe.state === "missing";
const skipNote = gitMissing ? " [skipped: git could not be spawned]" : "";

/** Fail a git case, by name and reason, when the git probe failed other than with ENOENT. */
function requireUsableGit(): void {
  if (gitProbe.state === "broken") {
    throw new Error(`git is unusable, so node-llama-cpp's clone paths cannot be checked: ${gitProbe.reason}`);
  }
}

/** The environment for this file's own git calls: no ambient GIT_* (a hook's GIT_DIR, say), an isolated HOME. */
function setupEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith("GIT_")) env[key] = value;
  }
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "flair-bench-test",
    GIT_AUTHOR_EMAIL: "flair-bench-test@example.invalid",
    GIT_COMMITTER_NAME: "flair-bench-test",
    GIT_COMMITTER_EMAIL: "flair-bench-test@example.invalid",
  };
}

function git(args: string[], cwd: string, home: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: setupEnv(home),
    timeout: GIT_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Point https://github.com/ at `target` in this HOME's .gitconfig (system git configuration still applies). */
function writeGitconfig(home: string, target: string): void {
  writeFileSync(
    join(home, ".gitconfig"),
    `[url "${target}"]\n\tinsteadOf = https://github.com/\n[init]\n\tdefaultBranch = master\n`,
  );
}

interface IsolatedNodeLlamaCpp {
  root: string;
  home: string;
  llamaCpp: string;
  infoFile: string;
  bundle: string;
  load: (rel: string) => Promise<any>;
}

/** A copy of node-llama-cpp's dist/ under `work`, resolving its dependencies from the real install. */
function isolatedNodeLlamaCpp(work: string, release: string, shippedBundle: boolean): IsolatedNodeLlamaCpp {
  const pkgDir = join(work, "pkg");
  const root = join(pkgDir, "node-llama-cpp");
  cpSync(join(nlcRoot, "dist"), join(root, "dist"), {
    recursive: true,
    filter: (src) => !src.endsWith(".map") && !src.endsWith(".d.ts"),
  });
  copyFileSync(join(nlcRoot, "package.json"), join(root, "package.json"));
  // The directory holding the real package also holds its dependencies (bun's isolated
  // layout: node_modules/.bun/node-llama-cpp@<v>/node_modules; a hoisted layout: node_modules).
  symlinkSync(dirname(nlcRoot), join(pkgDir, "node_modules"), "dir");
  if (existsSync(join(nlcRoot, "node_modules"))) symlinkSync(join(nlcRoot, "node_modules"), join(root, "node_modules"), "dir");
  const llama = join(root, "llama");
  mkdirSync(llama, { recursive: true });
  writeFileSync(join(llama, "binariesGithubRelease.json"), JSON.stringify({ release }));
  const bundle = join(llama, "gitRelease.bundle");
  if (shippedBundle) symlinkSync(join(nlcRoot, "llama", "gitRelease.bundle"), bundle);
  const home = join(work, "home");
  mkdirSync(join(home, ".config"), { recursive: true });
  return {
    root,
    home,
    llamaCpp: join(llama, "llama.cpp"),
    infoFile: join(llama, "llama.cpp.info.json"),
    bundle,
    load: (rel) => import(pathToFileURL(join(root, rel)).href),
  };
}

/** Run `fn` with HOME (which simple-git 4 passes through to git) pointed at `home`. */
async function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** A directory holding only an executable `git` shell script with `body`. */
function gitStubDir(body: string): string {
  const dir = tempDir("flair-bench-git-stub-");
  const stub = join(dir, "git");
  writeFileSync(stub, `#!/bin/sh\n${body}\n`);
  chmodSync(stub, 0o755);
  return dir;
}

describe("the git probe skips only when spawning git fails with ENOENT", () => {
  test(
    "spawning git failing with ENOENT is missing",
    () => {
      expect(probeGit({ ...process.env, PATH: tempDir("flair-bench-no-git-") })).toEqual({ state: "missing" });
    },
    CASE_BUDGET_MS,
  );

  test(
    "a git that exits nonzero is broken, with its exit code and stderr",
    () => {
      const probe = probeGit({ ...process.env, PATH: gitStubDir('echo "fatal: stub failure" >&2\nexit 1') });
      expect(probe).toEqual({ state: "broken", reason: "`git --version` exited 1: fatal: stub failure" });
    },
    CASE_BUDGET_MS,
  );

  test(
    "a git that does not finish within the timeout is broken",
    () => {
      const probe = probeGit({ ...process.env, PATH: gitStubDir("while :; do :; done") }, 300);
      expect(probe).toEqual({ state: "broken", reason: "`git --version` did not finish within 300 ms" });
    },
    CASE_BUDGET_MS,
  );

  test(
    'a git whose output does not start with "git version" is broken',
    () => {
      const probe = probeGit({ ...process.env, PATH: gitStubDir("echo hello") });
      expect(probe.state).toBe("broken");
    },
    CASE_BUDGET_MS,
  );
});

describe("node-llama-cpp's simple-git call paths against the resolved simple-git", () => {
  test(
    "node-llama-cpp resolves the simple-git and @simple-git/argv-parser versions the root overrides pin",
    () => {
      const rootManifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "package.json"), "utf8"));
      const overrides: Record<string, unknown> = rootManifest.overrides ?? {};
      const pins: Record<string, string> = {};
      for (const name of ["simple-git", "@simple-git/argv-parser"]) {
        const pin = overrides[name];
        if (typeof pin !== "string" || !EXACT_VERSION.test(pin)) {
          throw new Error(
            `the root package.json must pin overrides["${name}"] to an exact version (found ${JSON.stringify(pin)}); ` +
              "this test checks node-llama-cpp's clone paths against that pinned simple-git",
          );
        }
        pins[name] = pin;
      }
      const simpleGitDir = resolveFrom(nlcRoot, "simple-git");
      expect(readVersion(simpleGitDir)).toBe(pins["simple-git"]);
      expect(readVersion(resolveFrom(simpleGitDir, "@simple-git/argv-parser"))).toBe(pins["@simple-git/argv-parser"]);
      expect(Number(pins["simple-git"].split(".")[0])).toBeGreaterThanOrEqual(4);
    },
    CASE_BUDGET_MS,
  );

  test.skipIf(gitMissing)(
    `bundle path: clones the llama.cpp bundle node-llama-cpp ships, with no GitHub fallback${skipNote}`,
    async () => {
      requireUsableGit();
      const release: string = JSON.parse(readFileSync(join(nlcRoot, "llama", "binariesGithubRelease.json"), "utf8")).release;
      const shipped = join(nlcRoot, "llama", "gitRelease.bundle");
      expect(existsSync(shipped)).toBe(true);
      const work = tempDir("flair-bench-nlc-bundle-");
      const nlc = isolatedNodeLlamaCpp(work, release, true);
      expect(realpathSync(resolveFrom(nlc.root, "simple-git"))).toBe(realpathSync(resolveFrom(nlcRoot, "simple-git")));
      // A failed bundle clone falls back to GitHub; the test's .gitconfig rewrites it to a missing local path.
      writeGitconfig(nlc.home, pathToFileURL(join(work, "no-network")).href + "/");

      await withHome(nlc.home, async () => {
        const { cloneLlamaCppRepo, isLlamaCppRepoCloned } = await nlc.load("dist/bindings/utils/cloneLlamaCppRepo.js");
        await cloneLlamaCppRepo("ggml-org", "llama.cpp", release, true, false);
        expect(await isLlamaCppRepoCloned(false)).toBe(true);
      });

      expect(existsSync(join(nlc.llamaCpp, "CMakeLists.txt"))).toBe(true);
      // The bundle path removes `origin`; the GitHub path keeps it.
      expect(git(["remote"], nlc.llamaCpp, nlc.home)).toBe("");
      expect(JSON.parse(readFileSync(nlc.infoFile, "utf8"))).toEqual({ tag: release, llamaCppGithubRepo: "ggml-org/llama.cpp" });
    },
    CASE_BUDGET_MS,
  );

  test.skipIf(gitMissing)(
    `GitHub path, CI bundle path, then a clone from that bundle, against a local bare repo${skipNote}`,
    async () => {
      requireUsableGit();
      const tag = "b9999";
      const work = tempDir("flair-bench-nlc-github-");
      const nlc = isolatedNodeLlamaCpp(work, tag, false);
      expect(realpathSync(resolveFrom(nlc.root, "simple-git"))).toBe(realpathSync(resolveFrom(nlcRoot, "simple-git")));

      // A two-commit source with the release tag, served as https://github.com/ggml-org/llama.cpp.git.
      const src = join(work, "src");
      mkdirSync(src);
      git(["init", "-q", "-b", "master"], src, nlc.home);
      writeFileSync(join(src, "CMakeLists.txt"), "# one\n");
      writeFileSync(join(src, ".gitignore"), "build/\n");
      git(["add", "."], src, nlc.home);
      git(["commit", "-q", "-m", "first"], src, nlc.home);
      writeFileSync(join(src, "CMakeLists.txt"), "# two\n");
      git(["commit", "-q", "-a", "-m", "second commit message"], src, nlc.home);
      git(["tag", tag], src, nlc.home);
      git(["tag", "other-tag"], src, nlc.home);
      const remotes = join(work, "remotes");
      mkdirSync(join(remotes, "ggml-org"), { recursive: true });
      git(["clone", "-q", "--bare", src, join(remotes, "ggml-org", "llama.cpp.git")], work, nlc.home);
      writeGitconfig(nlc.home, pathToFileURL(remotes).href + "/");

      await withHome(nlc.home, async () => {
        const { cloneLlamaCppRepo } = await nlc.load("dist/bindings/utils/cloneLlamaCppRepo.js");
        const { unshallowAndSquashCurrentRepoAndSaveItAsReleaseBundle } = await nlc.load("dist/utils/gitReleaseBundles.js");

        // GitHub path: simpleGit({ progress }).clone(url, dir, { --depth 1, --branch <tag>, --quiet }).
        await cloneLlamaCppRepo("ggml-org", "llama.cpp", tag, false, true);
        expect(git(["rev-parse", "--is-shallow-repository"], nlc.llamaCpp, nlc.home)).toBe("true");
        expect(git(["tag", "--points-at", "HEAD"], nlc.llamaCpp, nlc.home).split("\n")).toContain(tag);
        expect(git(["config", "remote.origin.url"], nlc.llamaCpp, nlc.home)).toBe("https://github.com/ggml-org/llama.cpp.git");

        // CI bundle path: addConfig, revparse, tag --points-at, fetch --unshallow, log -1,
        // raw commit-tree, reset --hard, tags, tag --delete, branch, branch --delete, tag,
        // raw gc, raw bundle create.
        await unshallowAndSquashCurrentRepoAndSaveItAsReleaseBundle();
        expect(git(["rev-parse", "--is-shallow-repository"], nlc.llamaCpp, nlc.home)).toBe("false");
        expect(git(["rev-list", "--count", "HEAD"], nlc.llamaCpp, nlc.home)).toBe("1");
        expect(git(["log", "-1", "--format=%B"], nlc.llamaCpp, nlc.home)).toBe("## SQUASHED ##\n\nsecond commit message");
        expect(git(["config", "user.name"], nlc.llamaCpp, nlc.home)).toBe("node-llama-cpp-ci");
        expect(git(["tag"], nlc.llamaCpp, nlc.home)).toBe(tag);
        git(["bundle", "verify", nlc.bundle], nlc.llamaCpp, nlc.home);

        // Bundle path from the bundle just written: simpleGit({}).clone, then removeRemote("origin").
        await cloneLlamaCppRepo("ggml-org", "llama.cpp", tag, true, false);
        expect(readFileSync(join(nlc.llamaCpp, "CMakeLists.txt"), "utf8")).toBe("# two\n");
        expect(git(["remote"], nlc.llamaCpp, nlc.home)).toBe("");
      });
    },
    CASE_BUDGET_MS,
  );
});
