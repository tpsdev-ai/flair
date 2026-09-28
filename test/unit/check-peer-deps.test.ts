/**
 * check-peer-deps — the guard that fails when a workspace package's
 * NON-OPTIONAL peer, as resolved in bun.lock, does not satisfy the range the
 * package declares (flair#1936).
 *
 * Fixture locks only: no network, no install. The real bug — openclaw-flair
 * declares `openclaw >=2026.8.1` while bun.lock resolved `openclaw@2026.7.1` —
 * is reproduced as a fixture so the failure mode is pinned, not just the
 * mechanism.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findPeerViolations, resolvedPeerVersion } from "../../scripts/check-peer-deps.mjs";
import { tempDir } from "../helpers/temp-dir.ts";

const SCRIPT = join(import.meta.dir, "../../scripts/check-peer-deps.mjs");

interface FixturePkg {
  dir: string;
  name: string;
  json?: Record<string, unknown>;
}

/** `[resolution, registry, meta, integrity]` — the shape bun.lock's packages map holds. */
function res(name: string, version: string): [string, string, Record<string, unknown>, string] {
  return [`${name}@${version}`, "", {}, "sha512-fixture"];
}

/** A scratch repo: root + packages/<dir>/package.json + a JSONC bun.lock. */
function buildFixture(pkgs: FixturePkg[], packages: Record<string, unknown>): string {
  const root = tempDir("flair-peer-check-");
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "fixture-root" }, null, 2)}\n`);
  mkdirSync(join(root, "packages"), { recursive: true });
  for (const p of pkgs) {
    mkdirSync(join(root, "packages", p.dir), { recursive: true });
    writeFileSync(
      join(root, "packages", p.dir, "package.json"),
      `${JSON.stringify({ name: p.name, ...(p.json ?? {}) }, null, 2)}\n`,
    );
  }
  // Trailing comma => the lock parser must tolerate bun's JSONC, not just JSON.
  writeFileSync(
    join(root, "bun.lock"),
    `{\n  "lockfileVersion": 1,\n  "packages": ${JSON.stringify(packages, null, 2)},\n}\n`,
  );
  return root;
}

function runCli(root: string) {
  return spawnSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8" });
}

const adapter = (peers: Record<string, unknown>, meta?: Record<string, unknown>): FixturePkg => ({
  dir: "adapter",
  name: "@x/adapter",
  json: {
    peerDependencies: peers,
    ...(meta ? { peerDependenciesMeta: meta } : {}),
  },
});

describe("check-peer-deps — locked peer resolution vs the declared range", () => {
  test("a satisfied non-optional peer passes", () => {
    const root = buildFixture([adapter({ openclaw: ">=2026.8.1" })], {
      openclaw: res("openclaw", "2026.9.5"),
    });
    expect(findPeerViolations(root)).toEqual([]);
  });

  test("an UNSATISFIED peer fails, naming the package, peer, range and what the lock holds", () => {
    // The exact flair#1936 shape: declared floor above the locked version.
    const root = buildFixture([adapter({ openclaw: ">=2026.8.1" })], {
      openclaw: res("openclaw", "2026.7.1"),
    });
    const violations = findPeerViolations(root);
    expect(violations.length).toBe(1);
    expect(violations[0]).toMatchObject({
      from: "@x/adapter",
      peer: "openclaw",
      range: ">=2026.8.1",
      version: "2026.7.1",
    });
  });

  test("an OPTIONAL peer is skipped even when the lock resolves it unsatisfying", () => {
    const root = buildFixture(
      [adapter({ openclaw: ">=2026.8.1" }, { openclaw: { optional: true } })],
      { openclaw: res("openclaw", "2026.7.1") },
    );
    expect(findPeerViolations(root)).toEqual([]);
  });

  test("a declared non-optional peer with NO resolution in the lock FAILS (fail closed)", () => {
    const root = buildFixture([adapter({ openclaw: ">=2026.8.1" })], {});
    const violations = findPeerViolations(root);
    expect(violations.length).toBe(1);
    expect(violations[0]).toMatchObject({
      from: "@x/adapter",
      peer: "openclaw",
      range: ">=2026.8.1",
      version: null,
    });
  });

  test("a prerelease below the floor does NOT satisfy a plain `>=` range (the repo's range edge)", () => {
    // openclaw publishes `2026.8.1-beta.N` before `2026.8.1`; semver excludes
    // prereleases from a stable range, so this must fail rather than pass.
    const root = buildFixture([adapter({ openclaw: ">=2026.8.1" })], {
      openclaw: res("openclaw", "2026.8.1-beta.1"),
    });
    const violations = findPeerViolations(root);
    expect(violations.length).toBe(1);
    expect(violations[0].version).toBe("2026.8.1-beta.1");
  });

  test("a `*` range (the n8n adapters' peer spelling) is satisfied by any locked version", () => {
    const root = buildFixture([adapter({ "n8n-workflow": "*" })], {
      "n8n-workflow": res("n8n-workflow", "1.119.0"),
    });
    expect(findPeerViolations(root)).toEqual([]);
  });

  test("the workspace's OWN nested resolution wins over the hoisted one", () => {
    // The lock can carry `<workspaceName>/<peer>` when the workspace resolves
    // the peer differently from the top level (e.g. n8n-nodes-flair's
    // @langchain/core). The nested entry is the one that matters.
    const satisfied = buildFixture([adapter({ foo: ">=2.0.0" })], {
      foo: res("foo", "1.0.0"),
      "@x/adapter/foo": res("foo", "2.0.0"),
    });
    expect(findPeerViolations(satisfied)).toEqual([]);

    const unsatisfied = buildFixture([adapter({ foo: ">=2.0.0" })], {
      foo: res("foo", "2.0.0"),
      "@x/adapter/foo": res("foo", "1.0.0"),
    });
    const violations = findPeerViolations(unsatisfied);
    expect(violations.length).toBe(1);
    expect(violations[0].version).toBe("1.0.0");
  });

  test("resolvedPeerVersion reads the nested entry, falls back to top-level, else undefined", () => {
    const lock = { packages: { foo: res("foo", "1.0.0"), "ws-a/foo": res("foo", "2.0.0") } };
    expect(resolvedPeerVersion(lock, "ws-a", "foo")).toBe("2.0.0");
    expect(resolvedPeerVersion(lock, "ws-b", "foo")).toBe("1.0.0");
    expect(resolvedPeerVersion(lock, "ws-a", "missing")).toBeUndefined();
    expect(resolvedPeerVersion(null, "ws-a", "foo")).toBeUndefined();
  });
});

describe("check-peer-deps — the CLI exit codes and message", () => {
  test("exits 1 with the remedy when a peer is unsatisfied", () => {
    const root = buildFixture([adapter({ openclaw: ">=2026.8.1" })], {
      openclaw: res("openclaw", "2026.7.1"),
    });
    const r = runCli(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("openclaw");
    expect(r.stderr).toContain(">=2026.8.1");
    expect(r.stderr).toContain("2026.7.1");
    expect(r.stderr).toContain("refresh bun.lock so openclaw satisfies >=2026.8.1");
  });

  test("exits 0 when every non-optional peer is satisfied", () => {
    const root = buildFixture([adapter({ openclaw: ">=2026.8.1" })], {
      openclaw: res("openclaw", "2026.9.5"),
    });
    const r = runCli(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("✓");
  });
});
