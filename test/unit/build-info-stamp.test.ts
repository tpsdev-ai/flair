/**
 * build-info-stamp.test.ts — flair#1076, the writer half of the build-identity
 * stamp: scripts/write-build-info.mjs, run exactly as the build scripts run it
 * (`node scripts/write-build-info.mjs` with cwd = the package root).
 *
 * Each case builds an ISOLATED fake package root under mkdtemp — never the
 * real repo — so the git-present and no-git paths are both driven explicitly
 * rather than inherited from wherever the test process happens to run. The
 * /Health-serves-the-stamp half (real ephemeral Harper) lives in
 * test/integration/health-build-info-e2e.test.ts, which also carries the
 * repo-identity assertion (dist stamp vs package.json) that the release
 * mutation-check targets.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolveBuildInfo } from "../../resources/build-info";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "write-build-info.mjs");

const cleanups: string[] = [];
afterAll(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway package root containing only a package.json. realpath'd so the
 *  paths git and the script see agree on macOS (/var/folders is a symlink). */
function makePackageRoot(version: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "flair-build-info-")));
  cleanups.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "build-info-fixture", version }, null, 2));
  return dir;
}

/** Env for spawning the script: inherited env minus any git redirection vars,
 *  plus a discovery ceiling so `git rev-parse` can never wander up out of the
 *  fixture and report some OTHER repo's HEAD (or this one's). */
function scriptEnv(fixtureDir: string): Record<string, string> {
  const env: Record<string, string> = { ...process.env as Record<string, string> };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  env.GIT_CEILING_DIRECTORIES = dirname(fixtureDir);
  return env;
}

function runScript(cwd: string): string {
  return execFileSync("node", [SCRIPT], { cwd, env: scriptEnv(cwd), encoding: "utf-8" });
}

describe("scripts/write-build-info.mjs (flair#1076)", () => {
  test("git work tree: stamps {version, commit, builtAt, builder} with the tree's real HEAD", () => {
    const dir = makePackageRoot("9.9.9-test");
    execFileSync("git", ["init", "-q"], { cwd: dir, env: scriptEnv(dir) });
    execFileSync(
      "git",
      ["-c", "user.email=fixture@test", "-c", "user.name=fixture", "commit", "--allow-empty", "-q", "-m", "stamp fixture"],
      { cwd: dir, env: scriptEnv(dir) },
    );
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, env: scriptEnv(dir), encoding: "utf-8" }).trim();
    expect(head).toMatch(/^[0-9a-f]{40}$/); // fixture sanity — the expected value is itself well-formed

    const before = Date.now();
    runScript(dir);

    const stampPath = join(dir, "dist", "build-info.json");
    expect(existsSync(stampPath)).toBe(true);
    const stamp = JSON.parse(readFileSync(stampPath, "utf-8"));
    expect(stamp.version).toBe("9.9.9-test");
    expect(stamp.commit).toBe(head);
    expect(stamp.builder).toBe("tsc");
    // builtAt: a real ISO instant from THIS run, not a placeholder.
    const builtAt = new Date(stamp.builtAt).getTime();
    expect(Number.isFinite(builtAt)).toBe(true);
    expect(Math.abs(builtAt - before)).toBeLessThan(60_000);
  });

  test("non-git dir (tarball build): commit is an EXPLICIT null — present in the JSON, never omitted", () => {
    const dir = makePackageRoot("7.7.7-tarball");
    runScript(dir);

    const raw = readFileSync(join(dir, "dist", "build-info.json"), "utf-8");
    const stamp = JSON.parse(raw);
    expect(stamp.version).toBe("7.7.7-tarball");
    // Sherlock's honesty ruling on #1076, both halves: the KEY must exist
    // (never silently omitted) and the VALUE must be null (never fabricated).
    expect(Object.hasOwn(stamp, "commit")).toBe(true);
    expect(stamp.commit).toBeNull();
    // And it is grep-ably explicit in the serialized file — the server-side
    // deploy check reads this file with grep, not a JSON parser.
    expect(raw).toContain('"commit": null');
    expect(stamp.builder).toBe("tsc");
  });

  test("a package.json without a version fails the build loudly instead of stamping an unidentifiable dist", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "flair-build-info-")));
    cleanups.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "no-version-fixture" }));
    expect(() => runScript(dir)).toThrow(); // exit 1
    expect(existsSync(join(dir, "dist", "build-info.json"))).toBe(false);
  });

  test("files-array ride-along: package.json ships dist/ wholesale, so the stamp rides into the npm payload", () => {
    // The pack payload itself is asserted end-to-end (npm pack --dry-run) in
    // test/integration/health-build-info-e2e.test.ts, which runs with a built
    // dist/. This half pins the MECHANISM it relies on: the files array
    // entry is the whole directory, not a glob that could strand a non-.js
    // file. If someone narrows "dist/" this fails while the author still has
    // the context.
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8"));
    expect(pkg.files).toContain("dist/");
  });

  test("resolveBuildInfo() from a source run (no stamp adjacent to the module) is an honest null", () => {
    // Imported as resources/build-info.ts, the module-relative stamp path is
    // <repo-root>/build-info.json. Prove the precondition, then the fallback:
    // no stamp → null → /Health would serve buildCommit: null, not a guess.
    expect(existsSync(join(REPO_ROOT, "build-info.json"))).toBe(false);
    expect(resolveBuildInfo()).toBeNull();
  });
});
