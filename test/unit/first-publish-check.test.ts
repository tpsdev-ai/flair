// flair#1674 — the release must HARD-STOP an unapproved first-publish of a new
// public package name under our org.
//
// These are fails-first behaviour tests: a gate that always passed would fail
// every one of them. The registry lookup is INJECTED (a fixture JSON passed via
// --lookup-fixture, or the exported `runCheck` lookup parameter) so no test
// touches the real npm registry. The cases mirror the acceptance list:
//   - unapproved first-publish   -> exit non-zero with the required message
//   - approved first-publish     -> pass
//   - already-live package       -> pass
//   - lookup error/network error -> block (never fail open)
//   - npm: alias into our scope  -> enumerated and flagged
// plus wiring invariants so the release.sh / CI call sites cannot be removed
// without a red test.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ALLOW_LIST_REL,
  enumeratePublishTargets,
  parseApprovals,
  parseNpmAliasTarget,
} from "../../scripts/first-publish-check.mjs";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "first-publish-check.mjs");
const APPROVED_MESSAGE_FOR = (name: string) =>
  `FIRST-PUBLISH DETECTED: ${name}. This puts a new public package under our org (near-irreversible). ` +
  `Add it to ${ALLOW_LIST_REL} with approver+reason, or remove it from the release.`;

type FixtureLookupEntry =
  | { state: "live"; version?: string }
  | { state: "missing" }
  | { state: "error"; error?: string };

interface FixtureOptions {
  rootName?: string;
  rootPrivate?: boolean;
  rootDependencies?: Record<string, string>;
  packages?: Record<string, { private?: boolean }>;
  approved?: Array<Record<string, string>>;
  lookup: Record<string, FixtureLookupEntry>;
}

function makeFixture(opts: FixtureOptions): { dir: string; lookupPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "flair-first-publish-"));
  const rootPkg: Record<string, unknown> = {
    name: opts.rootName ?? "@tpsdev-ai/root",
    version: "1.0.0",
    workspaces: ["packages/*"],
  };
  if (opts.rootPrivate) rootPkg.private = true;
  if (opts.rootDependencies) rootPkg.dependencies = opts.rootDependencies;
  writeFileSync(join(dir, "package.json"), JSON.stringify(rootPkg, null, 2));

  for (const [pkgName, meta] of Object.entries(opts.packages ?? {})) {
    const pkgDir = join(dir, "packages", pkgName);
    mkdirSync(pkgDir, { recursive: true });
    const pkg: Record<string, unknown> = { name: `@tpsdev-ai/${pkgName}`, version: "1.0.0" };
    if (meta.private) pkg.private = true;
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify(pkg, null, 2));
  }

  if (opts.approved) {
    mkdirSync(join(dir, ".release"), { recursive: true });
    writeFileSync(join(dir, ALLOW_LIST_REL), JSON.stringify({ approved: opts.approved }, null, 2));
  }

  const lookupPath = join(dir, "lookup.json");
  writeFileSync(lookupPath, JSON.stringify(opts.lookup, null, 2));
  return { dir, lookupPath };
}

function runCli(dir: string, lookupPath: string): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [SCRIPT, "--root", dir, "--lookup-fixture", lookupPath], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 20_000,
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("first-publish preflight blocks the hazard", () => {
  test("an unapproved public name not on the registry exits non-zero with the required message", () => {
    const { dir, lookupPath } = makeFixture({
      packages: { "new-pkg": {} },
      lookup: {
        "@tpsdev-ai/root": { state: "live", version: "1.0.0" },
        "@tpsdev-ai/new-pkg": { state: "missing" },
      },
    });
    const { status, out } = runCli(dir, lookupPath);
    expect(status).not.toBe(0);
    expect(out).toContain(APPROVED_MESSAGE_FOR("@tpsdev-ai/new-pkg"));
  });

  test("the same name present in the allow-list passes", () => {
    const { dir, lookupPath } = makeFixture({
      packages: { "new-pkg": {} },
      approved: [
        {
          name: "@tpsdev-ai/new-pkg",
          approver: "nathan",
          date: "2026-09-14",
          reason: "Intended to be a supported public package.",
        },
      ],
      lookup: {
        "@tpsdev-ai/root": { state: "live", version: "1.0.0" },
        "@tpsdev-ai/new-pkg": { state: "missing" },
      },
    });
    const { status, out } = runCli(dir, lookupPath);
    expect(status).toBe(0);
    expect(out).not.toContain("FIRST-PUBLISH DETECTED");
    expect(out).toContain("approved first-publish(es): @tpsdev-ai/new-pkg");
  });

  test("an already-live package (normal version bump) passes", () => {
    const { dir, lookupPath } = makeFixture({
      packages: { "live-pkg": {} },
      lookup: {
        "@tpsdev-ai/root": { state: "live", version: "0.53.0" },
        "@tpsdev-ai/live-pkg": { state: "live", version: "0.53.0" },
      },
    });
    const { status, out } = runCli(dir, lookupPath);
    expect(status).toBe(0);
    expect(out).not.toContain("FIRST-PUBLISH DETECTED");
  });

  test("a lookup error/network failure BLOCKS instead of failing open", () => {
    const { dir, lookupPath } = makeFixture({
      packages: { "flaky-pkg": {} },
      lookup: {
        "@tpsdev-ai/root": { state: "live", version: "1.0.0" },
        "@tpsdev-ai/flaky-pkg": { state: "error", error: "ETIMEDOUT" },
      },
    });
    const { status, out } = runCli(dir, lookupPath);
    expect(status).not.toBe(0);
    expect(out).toContain("FIRST-PUBLISH CHECK CANNOT CONFIRM LIVE: @tpsdev-ai/flaky-pkg");
    expect(out).toContain("ETIMEDOUT");
    expect(out).not.toContain("FIRST-PUBLISH DETECTED");
  });

  test("an npm:-alias to a non-live name (the Harper shape) is flagged", () => {
    const { dir, lookupPath } = makeFixture({
      rootDependencies: { harper: "npm:@tpsdev-ai/harper@5.2.8" },
      lookup: {
        "@tpsdev-ai/root": { state: "live", version: "1.0.0" },
        "@tpsdev-ai/harper": { state: "missing" },
      },
    });
    const { status, out } = runCli(dir, lookupPath);
    expect(status).not.toBe(0);
    expect(out).toContain(APPROVED_MESSAGE_FOR("@tpsdev-ai/harper"));
  });

  test("private workspace packages are not publish targets", () => {
    const { dir, lookupPath } = makeFixture({
      packages: { "secret-pkg": { private: true } },
      // No lookup entry for @tpsdev-ai/secret-pkg: if it were checked, the
      // fixture would return an error and the run would block.
      lookup: { "@tpsdev-ai/root": { state: "live", version: "1.0.0" } },
    });
    const { status } = runCli(dir, lookupPath);
    expect(status).toBe(0);
  });

  test("a malformed allow-list entry does not count as an approval", () => {
    const { dir, lookupPath } = makeFixture({
      packages: { "new-pkg": {} },
      approved: [{ name: "@tpsdev-ai/new-pkg", approver: "nathan" }],
      lookup: {
        "@tpsdev-ai/root": { state: "live", version: "1.0.0" },
        "@tpsdev-ai/new-pkg": { state: "missing" },
      },
    });
    const { status, out } = runCli(dir, lookupPath);
    expect(status).not.toBe(0);
    expect(out).toContain("An incomplete entry is not an approval.");
    expect(out).toContain(APPROVED_MESSAGE_FOR("@tpsdev-ai/new-pkg"));
  });
});

describe("first-publish enumeration", () => {
  test("parseNpmAliasTarget extracts scoped and unscoped targets", () => {
    expect(parseNpmAliasTarget("npm:@tpsdev-ai/harper@5.2.8")).toBe("@tpsdev-ai/harper");
    expect(parseNpmAliasTarget("npm:@tpsdev-ai/harper")).toBe("@tpsdev-ai/harper");
    expect(parseNpmAliasTarget("npm:left-pad@1.0.0")).toBe("left-pad");
    expect(parseNpmAliasTarget("^1.2.3")).toBeNull();
    expect(parseNpmAliasTarget("@tpsdev-ai/flair")).toBeNull();
  });

  test("enumerates every public workspace package on disk and no private ones", () => {
    const { targets, problems } = enumeratePublishTargets(REPO_ROOT);
    expect(problems).toEqual([]);
    const names = new Set(targets.map((t) => t.name));
    expect(names.size).toBeGreaterThan(0);

    const packagesDir = join(REPO_ROOT, "packages");
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      let pkg: { name?: string; private?: boolean };
      try {
        pkg = JSON.parse(readFileSync(join(packagesDir, entry.name, "package.json"), "utf8"));
      } catch {
        continue; // Python package / plain directory — not a workspace npm package
      }
      if (!pkg.name) continue;
      if (pkg.private === true) expect(names.has(pkg.name)).toBe(false);
      else expect(names.has(pkg.name)).toBe(true);
    }

    const root = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { name?: string };
    expect(root.name).toBeDefined();
    if (!root.name) throw new Error("root package.json is missing a name");
    expect(names.has(root.name)).toBe(true);
  });

  test("parseApprovals requires name/approver/date/reason", () => {
    const incomplete = parseApprovals(
      JSON.stringify({ approved: [{ name: "@tpsdev-ai/x", approver: "nathan", date: "2026-09-14" }] }),
      ALLOW_LIST_REL,
    );
    expect(incomplete.approvedNames.size).toBe(0);
    expect(incomplete.problems.join("\n")).toContain("reason");

    const complete = parseApprovals(
      JSON.stringify({
        approved: [{ name: "@tpsdev-ai/x", approver: "nathan", date: "2026-09-14", reason: "ok" }],
      }),
      ALLOW_LIST_REL,
    );
    expect(complete.problems).toEqual([]);
    expect(complete.approvedNames.has("@tpsdev-ai/x")).toBe(true);
  });

  test("the repo allow-list starts empty — the gate must not be pre-seeded", () => {
    const raw = readFileSync(join(REPO_ROOT, ALLOW_LIST_REL), "utf8");
    const parsed = parseApprovals(raw, ALLOW_LIST_REL);
    expect(parsed.problems).toEqual([]);
    expect(parsed.entries).toEqual([]);
  });
});

describe("first-publish preflight is wired into the release and CI", () => {
  test("release.sh runs the preflight", () => {
    const src = readFileSync(join(REPO_ROOT, "scripts", "release.sh"), "utf8");
    expect(src).toContain("scripts/first-publish-check.mjs");
  });

  test("CI runs the preflight on release/v* pull requests", () => {
    const src = readFileSync(join(REPO_ROOT, ".github", "workflows", "test.yml"), "utf8");
    expect(src).toContain("first-publish-check.mjs");
    expect(src).toMatch(/startsWith\(github\.head_ref, 'release\/v'\)/);
  });
});
