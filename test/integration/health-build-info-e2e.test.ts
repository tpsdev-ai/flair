/**
 * health-build-info-e2e.test.ts — flair#1076 against a REAL Harper instance:
 * the running server reports its own build identity.
 *
 * Kern's ruling on #1076 is the shape of this file: a file-only check proves
 * the artifact on disk, not what the server LOADED (the 0.25.0 stale-dist
 * incident class) — so the load-bearing assertions here go through HTTP to a
 * spawned Harper serving dist/resources/*.js, and require /Health's payload
 * to EQUAL the stamp file field-for-field. The writer's own paths (git /
 * no-git / no-version) are unit-covered in test/unit/build-info-stamp.test.ts.
 *
 * This file also carries the repo-identity assertion (stamp.version ===
 * package.json version) that the deploy discriminator retires into — the
 * release mutation-check target: stamp a wrong version into
 * dist/build-info.json and "the stamp is this build's identity" goes red.
 *
 * Requires a built dist/ (bun run build) — same precondition as every file in
 * this directory (config.yaml's jsResource loads dist/resources/*.js; the
 * integration CI lane builds first).
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STAMP_PATH = join(REPO_ROOT, "dist", "build-info.json");

let harper: HarperInstance;
let stamp: { version: string; commit: string | null; builtAt: string; builder: string };

describe("/Health serves the build's own identity (flair#1076)", () => {
  beforeAll(async () => {
    // Load the stamp BEFORE spawning: if the build didn't write it, fail here
    // with the actionable cause, not downstream with a shapeless 404/null.
    expect(
      existsSync(STAMP_PATH),
      `${STAMP_PATH} missing — run \`bun run build\` first; the build scripts write the stamp (flair#1076)`,
    ).toBe(true);
    stamp = JSON.parse(readFileSync(STAMP_PATH, "utf-8"));
    harper = await startHarper();
  }, 120_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  });

  test("identity: the stamp is THIS build's identity (version = package.json, builder = tsc)", () => {
    // The deploy-verification identity check (`grep -o '"version": "X.Y.Z"'
    // dist/build-info.json`) asserts exactly this equality server-side. The
    // release mutation-check targets this test: stamp a wrong version into
    // dist/build-info.json → red.
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8"));
    expect(stamp.version).toBe(pkg.version);
    expect(stamp.builder).toBe("tsc");
    expect(Number.isFinite(new Date(stamp.builtAt).getTime())).toBe(true);
  });

  test("GET /Health: version and buildCommit come from the stamp the running server loaded", async () => {
    const res = await fetch(`${harper.httpURL}/Health`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { ok?: boolean; version?: string; buildCommit?: string | null };
    expect(body.ok).toBe(true);
    // Sherlock's honesty ruling: the field is ALWAYS present — a tarball
    // build renders null, but the key is never silently omitted.
    expect("buildCommit" in body).toBe(true);
    // Field-for-field equality with the stamp — /Health is a truthful view of
    // the file adjacent to the modules Harper loaded, not of package.json.
    expect(body.version).toBe(stamp.version);
    expect(body.buildCommit).toBe(stamp.commit);
  });

  test("this build ran in a git work tree, so buildCommit is a REAL 40-hex sha end-to-end", async () => {
    // The null path is legitimate for tarball builds and unit-covered; HERE,
    // built from a checkout, null (or anything but the tree's HEAD at build
    // time) would be the stamp lying about a knowable fact.
    const res = await fetch(`${harper.httpURL}/Health`);
    const body = (await res.json()) as { buildCommit?: string | null };
    expect(body.buildCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  test("npm pack payload carries dist/build-info.json (dist/ ships wholesale)", () => {
    // The stamp is only a deploy discriminator if it actually leaves the
    // building machine. --dry-run --json lists the real pack payload from the
    // files array; no tarball is written.
    const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
    });
    // Output shape varies by npm major: <=11 prints an ARRAY of payloads,
    // 12 prints an OBJECT keyed by package name (measured: npm 12.0.1).
    type PackPayload = { files: Array<{ path: string }> };
    const parsed = JSON.parse(out) as PackPayload[] | Record<string, PackPayload>;
    const payload = Array.isArray(parsed)
      ? parsed[0]
      : (parsed["@tpsdev-ai/flair"] ?? Object.values(parsed)[0]);
    expect(payload && Array.isArray(payload.files)).toBe(true);
    const paths = payload.files.map((f) => f.path);
    expect(paths).toContain("dist/build-info.json");
  }, 120_000);
});
