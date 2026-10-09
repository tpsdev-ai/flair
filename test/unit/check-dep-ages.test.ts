/**
 * test/unit/check-dep-ages.test.ts — test the collectDeps function in
 * scripts/lib/check-dep-ages-collect.mjs against literal fixture inputs, and
 * the CLI's fail-closed exit codes against a fixture repo:
 *    exit 2: dead registry (FLAIR_NPM_REGISTRY=http://127.0.0.1:1)
 *    exit 1: too-fresh dep (a fixture registry in this process that reports
 *            the dep as published "now", against the default 7-day policy)
 *
 * The CLI cases spawn `node scripts/check-dep-ages.mjs` directly. The script
 * path is derived from this file's location, never from the working directory,
 * and a broken setup (a missing script, a fixture that was not written, a
 * registry that did not bind) throws before the CLI runs. It can never pass as
 * exit 1: `node` exits 1 on a missing entry file too, which is why every CLI
 * case also asserts the gate's own diagnostic, and the too-fresh cases the
 * request the gate made to the fixture registry.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectDeps,
  collectNonExactOverrides,
  collectUnsupportedOverrides,
} from "../../scripts/lib/check-dep-ages-collect.mjs";

/* ─────────────────────────── Unit tests ───────────────────────────── */


/** A registry that reports FIXTURE_VERSION with a PRESENT but unparseable time. */
function unparseableRegistry(value: unknown = "not-a-timestamp") {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      requests.push(new URL(req.url).pathname);
      return Response.json({ time: { [FIXTURE_VERSION]: value } });
    },
  });
  if (!server.port) setupFailure("fixture registry did not bind a port");
  return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) };
}

describe("collectDeps", () => {
  const keepCurrent = new Set(["harper", "some-skip"]);

  // Helper: build a pkg with only `dependencies` (no optionalDeps, no peerDeps)
  const pkgsDeps = (deps: Record<string,string>, p: string) => [
    { pkg: { dependencies: deps }, path: p },
  ];
  const pkgsOpts = (deps: Record<string,string>, p: string) => [
    { pkg: { optionalDependencies: deps }, path: p },
  ];
  const pkgsPeer = (deps: Record<string,string>, p: string) => [
    { pkg: { peerDependencies: deps }, path: p },
  ];

  /* dependencies */
  describe("dependencies", () => {
    it("collects an exact dependencies pin", () => {
      const result = collectDeps(pkgsDeps({"some-pkg":"1.2.3"},"packages/foo/package.json"), keepCurrent);
      expect(result.size).toBe(1);
      expect(result.get("some-pkg@1.2.3")).toEqual({
        name: "some-pkg", version: "1.2.3",
        declaredIn: ["packages/foo/package.json"],
       });
     });
   });

   /* optionalDependencies */
  describe("optionalDependencies", () => {
    it("collects exact optional pin with correct declaredIn", () => {
      const result = collectDeps(pkgsOpts({"some-opt":"4.5.6"},"packages/bar/package.json"), keepCurrent);
      expect(result.size).toBe(1);
      expect(result.get("some-opt@4.5.6")).toEqual({
        name: "some-opt", version: "4.5.6",
        declaredIn: ["packages/bar/package.json"],
       });
     });
    it("skips an optional range like ^1.2.3", () => {
      expect(collectDeps(pkgsOpts({"some-opt":"^1.2.3"},"packages/bar/package.json"), keepCurrent).size).toBe(0);
     });
    it("skips an optional @tpsdev-ai/* pin", () => {
      expect(collectDeps(pkgsOpts({"@tpsdev-ai/internal":"1.0.0"},"packages/internal/package.json"), keepCurrent).size).toBe(0);
     });
   });

   /* peerDependencies */
  describe("peerDependencies", () => {
    it("does NOT collect an exact peerDependencies pin", () => {
      expect(collectDeps(pkgsPeer({"some-peer":"7.8.9"},"packages/peer/package.json"), keepCurrent).size).toBe(0);
     });
   });

   /* cross-package dedup */
  describe("cross-package dedup", () => {
    it("one entry for same name@version in two packages", () => {
      const result = collectDeps([
           { pkg: { dependencies: {"shared-pkg":"2.0.0"} }, path: "packages/a/package.json" },
           { pkg: { optionalDependencies: {"shared-pkg":"2.0.0"} }, path: "packages/b/package.json" },
        ], keepCurrent);
      expect(result.size).toBe(1);
      expect(result.get("shared-pkg@2.0.0")!.declaredIn.sort()).toEqual([
           "packages/a/package.json", "packages/b/package.json",
        ]);
     });
   });

  /* overrides */
  describe("overrides", () => {
    const pkgsOverrides = (overrides: Record<string,string>, p: string) => [
      { pkg: { overrides }, path: p },
    ];

    it("collects an exact override pin from the root manifest", () => {
      const result = collectDeps(pkgsOverrides({"some-pin":"1.2.3"},"package.json"), keepCurrent);
      expect(result.size).toBe(1);
      expect(result.get("some-pin@1.2.3")).toEqual({
        name: "some-pin", version: "1.2.3", declaredIn: ["package.json"],
      });
    });

    it("collects an exact override pin from a workspace manifest", () => {
      const result = collectDeps(pkgsOverrides({"some-pin":"1.2.3"},"packages/foo/package.json"), keepCurrent);
      expect(result.get("some-pin@1.2.3")!.declaredIn).toEqual(["packages/foo/package.json"]);
    });

    it("checks the target of an npm: alias, not the alias key", () => {
      const result = collectDeps(pkgsOverrides({"alias-key":"npm:real-pkg@2.0.0"},"package.json"), keepCurrent);
      expect(result.size).toBe(1);
      expect(result.has("real-pkg@2.0.0")).toBe(true);
      expect(result.has("alias-key@2.0.0")).toBe(false);
    });

    it("skips a non-exact override range", () => {
      expect(collectDeps(pkgsOverrides({"some-pin":"^1.2.3"},"package.json"), keepCurrent).size).toBe(0);
    });

    it("collects a pin nested under a parent package and through a \".\" self key", () => {
      const result = collectDeps([
        { pkg: { overrides: { "parent-dep": { "nested-pin": "1.2.3" }, "self-pin": { ".": "4.5.6" } } }, path: "package.json" },
      ], keepCurrent);
      expect([...result.keys()].sort()).toEqual(["nested-pin@1.2.3", "self-pin@4.5.6"]);
    });

    it("names the package of a selector key, not the key", () => {
      const result = collectDeps(pkgsOverrides({"some-pin@^1":"1.2.3"},"package.json"), keepCurrent);
      expect([...result.keys()]).toEqual(["some-pin@1.2.3"]);
    });

    it("skips a digit-leading range like 1.x", () => {
      expect(collectDeps(pkgsOverrides({"some-pin":"1.x"},"package.json"), keepCurrent).size).toBe(0);
    });

    it("dedups a pin declared in both dependencies and overrides of one manifest", () => {
      const result = collectDeps([
        { pkg: { dependencies: {"some-pin":"1.2.3"}, overrides: {"some-pin":"1.2.3"} }, path: "package.json" },
      ], keepCurrent);
      expect(result.size).toBe(1);
      expect(result.get("some-pin@1.2.3")!.declaredIn).toEqual(["package.json"]);
    });
  });
});

/* ── Override specifiers the gate cannot age-check ────────────────────── */

describe("collectNonExactOverrides", () => {
  const pkgsOverrides = (overrides: Record<string,string>, p: string) => [
    { pkg: { overrides }, path: p },
  ];

  it("reports a non-exact override range with its manifest", () => {
    const gaps = collectNonExactOverrides(pkgsOverrides({"some-pin":"^1.2.3"},"package.json"));
    expect(gaps).toEqual([{ name: "some-pin", spec: "^1.2.3", declaredIn: "package.json" }]);
  });

  it("does not report an exact override pin", () => {
    expect(collectNonExactOverrides(pkgsOverrides({"some-pin":"1.2.3"},"package.json"))).toEqual([]);
  });

  it("does not report an exempt workspace: specifier", () => {
    expect(collectNonExactOverrides(pkgsOverrides({"some-pin":"workspace:*"},"package.json"))).toEqual([]);
  });

  it("reports digit-leading and nested ranges", () => {
    const gaps = collectNonExactOverrides([
      { pkg: { overrides: { "some-pin": "1.0.0 || 2.0.0", "parent-dep": { "nested-pin": "1 - 2" } } }, path: "package.json" },
    ]);
    expect(gaps).toEqual([
      { name: "some-pin", spec: "1.0.0 || 2.0.0", declaredIn: "package.json" },
      { name: "nested-pin", spec: "1 - 2", declaredIn: "package.json" },
    ]);
  });
});

describe("collectUnsupportedOverrides", () => {
  it("names the manifest, the rule and the reason", () => {
    const unsupported = collectUnsupportedOverrides([
      { pkg: { overrides: { "parent-dep": { "some-pin": "latest" } } }, path: "packages/foo/package.json" },
    ]);
    expect(unsupported).toEqual([{
      declaredIn: "packages/foo/package.json",
      at: 'overrides["parent-dep"]["some-pin"]',
      reason: '"latest" is not an exact version, a semver range or an npm: alias of one',
    }]);
  });

  it("refuses a value that is neither a string nor an object", () => {
    const unsupported = collectUnsupportedOverrides([{ pkg: { overrides: { "some-pin": 1 } }, path: "package.json" }]);
    expect(unsupported.map((u) => u.at)).toEqual(['overrides["some-pin"]']);
  });
});

/* ───────────── CLI fail-closed exit tests ─────────────────────────── */

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI_SCRIPT = join(REPO_ROOT, "scripts", "check-dep-ages.mjs");
const COLLECT_LIB = join(REPO_ROOT, "scripts", "lib", "check-dep-ages-collect.mjs");

/** The one exact external pin every fixture repo declares. */
const FIXTURE_DEP = "fixture-dep";
const FIXTURE_VERSION = "1.0.0";
/** A positive policy: a dep published "now" is too fresh under it. */
const MIN_AGE_DAYS = "7";

/** A broken test setup fails as itself, never as the CLI exit a case expects. */
function setupFailure(what: string): never {
  throw new Error(`test setup failed before the gate ran: ${what}`);
}

let scratch = "";

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "flair-dep-ages-"));
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

/** Write a repo root with one exact external pin and an empty packages/ dir. */
function writeFixtureRepo(root: string): string {
  mkdirSync(join(root, "packages"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "dep-ages-fixture",
    version: "0.0.0",
    dependencies: { [FIXTURE_DEP]: FIXTURE_VERSION },
  }));
  if (!existsSync(join(root, "package.json"))) setupFailure(`fixture package.json not written under ${root}`);
  return root;
}

/** Write a repo root whose only pin is an `overrides` entry, and an empty packages/ dir. */
function writeOverrideFixtureRepo(root: string, overrides: Record<string, unknown>): string {
  mkdirSync(join(root, "packages"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "dep-ages-overrides-fixture",
    version: "0.0.0",
    overrides,
  }));
  if (!existsSync(join(root, "package.json"))) setupFailure(`fixture package.json not written under ${root}`);
  return root;
}

/** Write the gate's dated exemption allowlist under a fixture root's .github/. */
function writeAllowlist(root: string, entries: unknown[]): void {
  mkdirSync(join(root, ".github"), { recursive: true });
  writeFileSync(join(root, ".github", "dep-age-allowlist.json"), JSON.stringify({ entries }));
}

/** One well-formed dated exemption for the fixture pin, added on `added`, expiring on `expires`. */
function exemption(added: string, expires: string): Record<string, unknown> {
  return {
    package: FIXTURE_DEP,
    version: FIXTURE_VERSION,
    ghsa: ["GHSA-1234-5678-9abc"],
    added,
    expires,
    reason: "fixture: a security pin younger than the bake window",
  };
}

/**
 * Run the gate as its own process. Async on purpose: the too-fresh cases serve
 * the child's registry request from this same process, and a synchronous spawn
 * would block that server's event loop. The env is built explicitly (no
 * ambient FLAIR_* can change the policy, the keep-current list or the root).
 */
async function runGate(script: string, extraEnv: Record<string, string>, extraArgs: string[] = []) {
  if (!existsSync(script)) setupFailure(`gate script not found at ${script}`);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    FLAIR_DEP_MIN_AGE_DAYS: MIN_AGE_DAYS,
    ...extraEnv,
  };
  const proc = Bun.spawn(["node", script, ...extraArgs], {
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
    killSignal: "SIGKILL",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, output: stdout + stderr };
}

/** A registry that reports FIXTURE_VERSION as published at the moment of the request. */
function freshRegistry() {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      requests.push(new URL(req.url).pathname);
      return Response.json({ time: { [FIXTURE_VERSION]: new Date().toISOString() } });
    },
  });
  if (!server.port) setupFailure("fixture registry did not bind a port");
  return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) };
}

describe("CLI fail-closed exit — dead registry", () => {
  it("exits 2 when FLAIR_NPM_REGISTRY is unreachable", async () => {
    const root = writeFixtureRepo(join(scratch, "dead-registry"));
    const { exitCode, output } = await runGate(CLI_SCRIPT, {
      FLAIR_CHECK_DEP_AGES_ROOT: root,
      FLAIR_NPM_REGISTRY: "http://127.0.0.1:1",
    });
    expect(output).toContain("Failed to fetch publish times");
    expect(output).toContain(`${FIXTURE_DEP}@${FIXTURE_VERSION}:`);
    expect(exitCode).toBe(2);
  }, 30_000);
});

describe("CLI fail-closed exit — too-fresh dep", () => {
  it("exits 1 when a dep was published now, under a 7-day policy", async () => {
    const root = writeFixtureRepo(join(scratch, "too-fresh"));
    const registry = freshRegistry();
    try {
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: registry.url,
      });
      // The gate asked the fixture registry, and reported the dep as too fresh.
      expect(registry.requests).toEqual([`/${FIXTURE_DEP}`]);
      expect(output).toContain("Pinned production deps younger than the bake-time policy");
      expect(output).toContain(`${FIXTURE_DEP}@${FIXTURE_VERSION}`);
      expect(output).toContain("declared in package.json");
      expect(exitCode).toBe(1);
    } finally {
      registry.stop();
    }
  }, 30_000);

  it("resolves its default root from its own location, through a path with a space", async () => {
    // The documented downstream install: both files copied, relative layout kept,
    // no FLAIR_CHECK_DEP_AGES_ROOT. The gate must find the package.json one level
    // above its own scripts/ dir even though the path contains a space.
    const root = writeFixtureRepo(join(scratch, "downstream repo"));
    mkdirSync(join(root, "scripts", "lib"), { recursive: true });
    const script = join(root, "scripts", "check-dep-ages.mjs");
    copyFileSync(CLI_SCRIPT, script);
    copyFileSync(COLLECT_LIB, join(root, "scripts", "lib", "check-dep-ages-collect.mjs"));
    const registry = freshRegistry();
    try {
      const { exitCode, output } = await runGate(script, { FLAIR_NPM_REGISTRY: registry.url });
      expect(registry.requests).toEqual([`/${FIXTURE_DEP}`]);
      expect(output).toContain("Pinned production deps younger than the bake-time policy");
      expect(output).toContain(`${FIXTURE_DEP}@${FIXTURE_VERSION}`);
      expect(exitCode).toBe(1);
    } finally {
      registry.stop();
    }
  }, 30_000);
});

describe("CLI — a pin through overrides and the dated exemption", () => {
  it("exits 1 when a version pinned through overrides was published now", async () => {
    const root = writeOverrideFixtureRepo(join(scratch, "override-too-fresh"), { [FIXTURE_DEP]: FIXTURE_VERSION });
    const registry = freshRegistry();
    try {
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: registry.url,
      });
      expect(registry.requests).toEqual([`/${FIXTURE_DEP}`]);
      expect(output).toContain("Pinned production deps younger than the bake-time policy");
      expect(output).toContain(`${FIXTURE_DEP}@${FIXTURE_VERSION}`);
      expect(output).toContain("declared in package.json");
      expect(exitCode).toBe(1);
    } finally {
      registry.stop();
    }
  }, 30_000);

  it("exits 0 with a matching unexpired dated exemption", async () => {
    const root = writeOverrideFixtureRepo(join(scratch, "override-exempt"), { [FIXTURE_DEP]: FIXTURE_VERSION });
    writeAllowlist(root, [exemption("2026-01-01", "2099-01-01")]);
    const registry = freshRegistry();
    try {
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: registry.url,
      });
      expect(output).toContain("Exempted fresh pins");
      expect(output).toContain("exempt until 2099-01-01");
      expect(output).not.toContain("Pinned production deps younger than the bake-time policy");
      expect(exitCode).toBe(0);
    } finally {
      registry.stop();
    }
  }, 30_000);

  it("exits 2 on an expired exemption, before fetching", async () => {
    const root = writeOverrideFixtureRepo(join(scratch, "override-expired"), { [FIXTURE_DEP]: FIXTURE_VERSION });
    writeAllowlist(root, [exemption("2020-01-01", "2020-01-02")]);
    const { exitCode, output } = await runGate(CLI_SCRIPT, {
      FLAIR_CHECK_DEP_AGES_ROOT: root,
      // A dead registry keeps a RED run off the real npm registry; the
      // discriminating assertion is the message and the exit code.
      FLAIR_NPM_REGISTRY: "http://127.0.0.1:1",
    });
    expect(output).toContain("Expired bake-time exemption");
    expect(output).toContain(`${FIXTURE_DEP}@${FIXTURE_VERSION}`);
    expect(output).toContain("2020-01-02");
    expect(exitCode).toBe(2);
  }, 30_000);

  it("reports a non-exact override range and does not age-check it", async () => {
    const root = writeOverrideFixtureRepo(join(scratch, "override-range"), { [FIXTURE_DEP]: "^1.0.0" });
    const { exitCode, output } = await runGate(CLI_SCRIPT, {
      FLAIR_CHECK_DEP_AGES_ROOT: root,
      // Nothing is age-checked, so the dead registry is never queried.
      FLAIR_NPM_REGISTRY: "http://127.0.0.1:1",
    });
    expect(output).toContain("Not age-checked (override ranges)");
    expect(output).toContain(`${FIXTURE_DEP} "^1.0.0"`);
    expect(output).toContain("No external pinned production deps to check.");
    expect(exitCode).toBe(0);
  }, 30_000);
});

describe("CLI — override forms", () => {
  it("exits 1 when the fresh pin is nested under a parent package", async () => {
    const root = writeOverrideFixtureRepo(join(scratch, "override-nested"), {
      "parent-dep": { [FIXTURE_DEP]: FIXTURE_VERSION },
    });
    const registry = freshRegistry();
    try {
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: registry.url,
      });
      expect(registry.requests).toEqual([`/${FIXTURE_DEP}`]);
      expect(output).toContain("Pinned production deps younger than the bake-time policy");
      expect(output).toContain(`${FIXTURE_DEP}@${FIXTURE_VERSION}`);
      expect(exitCode).toBe(1);
    } finally {
      registry.stop();
    }
  }, 30_000);

  it("exits 1 when the fresh override exists only in a workspace manifest", async () => {
    const root = writeFixtureRepo(join(scratch, "override-workspace-only"));
    // The root manifest pins nothing; the only pin is a workspace override.
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "dep-ages-fixture", version: "0.0.0" }));
    mkdirSync(join(root, "packages", "ws-a"), { recursive: true });
    writeFileSync(join(root, "packages", "ws-a", "package.json"), JSON.stringify({
      name: "ws-a",
      version: "0.0.0",
      overrides: { [FIXTURE_DEP]: FIXTURE_VERSION },
    }));
    const registry = freshRegistry();
    try {
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: registry.url,
      });
      expect(registry.requests).toEqual([`/${FIXTURE_DEP}`]);
      expect(output).toContain("Pinned production deps younger than the bake-time policy");
      expect(output).toContain("declared in packages/ws-a/package.json");
      expect(exitCode).toBe(1);
    } finally {
      registry.stop();
    }
  }, 30_000);

  it("reports a digit-leading range and does not age-check it", async () => {
    const root = writeOverrideFixtureRepo(join(scratch, "override-digit-range"), { [FIXTURE_DEP]: "1.x" });
    const registry = freshRegistry();
    try {
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: registry.url,
      });
      expect(output).toContain(`${FIXTURE_DEP} "1.x"`);
      expect(registry.requests).toEqual([]);
      expect(exitCode).toBe(0);
    } finally {
      registry.stop();
    }
  }, 30_000);

  it("exits 2 on an unsupported override form, naming it, before fetching", async () => {
    const root = writeOverrideFixtureRepo(join(scratch, "override-unsupported"), {
      [FIXTURE_DEP]: FIXTURE_VERSION,
      "parent-dep": { "other-dep": "latest" },
    });
    const registry = freshRegistry();
    try {
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: registry.url,
      });
      expect(output).toContain("Unsupported `overrides` entries");
      expect(output).toContain('package.json overrides["parent-dep"]["other-dep"]: "latest" is not an exact version');
      expect(registry.requests).toEqual([]);
      expect(exitCode).toBe(2);
    } finally {
      registry.stop();
    }
  }, 30_000);
});

describe("CLI — a malformed exemption date fails the gate", () => {
  // A fresh override pin with ONE exemption entry whose dates are malformed.
  // The gate must refuse the allowlist (exit 2, naming the field) before any
  // registry request — never exempt the pin.
  async function assertMalformed(label: string, dates: { added: unknown; expires: unknown }, diagnostic: string) {
    const root = writeOverrideFixtureRepo(join(scratch, `malformed-${label}`), { [FIXTURE_DEP]: FIXTURE_VERSION });
    writeAllowlist(root, [{ ...exemption("2026-01-01", "2099-01-01"), ...dates }]);
    const registry = freshRegistry();
    try {
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: registry.url,
      });
      expect(output).toContain("dep-age-allowlist.json entries[0]");
      expect(output).toContain(diagnostic);
      expect(output).not.toContain("Exempted fresh pins");
      expect(registry.requests).toEqual([]);
      expect(exitCode).toBe(2);
    } finally {
      registry.stop();
    }
  }

  it("an invalid month", async () => {
    await assertMalformed("month", { added: "2026-01-01", expires: "2099-13-01" },
      '"expires" must be a calendar date string, YYYY-MM-DD');
  }, 30_000);

  it("an impossible day", async () => {
    await assertMalformed("day", { added: "2026-02-30", expires: "2099-01-01" },
      '"added" must be a calendar date string, YYYY-MM-DD');
  }, 30_000);

  it("an array date", async () => {
    await assertMalformed("array", { added: "2026-01-01", expires: ["2099-01-01"] },
      '"expires" must be a calendar date string, YYYY-MM-DD');
  }, 30_000);

  it("an expiry before the added date", async () => {
    await assertMalformed("reversed", { added: "2099-01-02", expires: "2099-01-01" },
      '"expires" (2099-01-01) must be after "added" (2099-01-02)');
  }, 30_000);
});

describe("CLI fail-closed exit — the CI gate refuses the fixture-root override", () => {
  it("exits 2, naming the variable, when the CI invocation has the override set", async () => {
    const root = writeFixtureRepo(join(scratch, "ci-override"));
    const { exitCode, output } = await runGate(
      CLI_SCRIPT,
      // An unreachable registry keeps a RED run (main, which ignores --ci) off
      // the real npm registry; the discriminating assertion is the message.
      { FLAIR_CHECK_DEP_AGES_ROOT: root, FLAIR_NPM_REGISTRY: "http://127.0.0.1:1" },
      ["--ci"],
    );
    expect(output).toContain("FLAIR_CHECK_DEP_AGES_ROOT");
    expect(exitCode).toBe(2);
  }, 30_000);

  it("--ci without the override scans the real repository root", async () => {
    const registry = freshRegistry();
    try {
      const { exitCode, output } = await runGate(
        CLI_SCRIPT,
        { FLAIR_NPM_REGISTRY: registry.url },
        ["--ci"],
      );
      // It did NOT refuse ...
      expect(output).not.toContain("Refusing to run");
      // ... and it scanned the REAL root (several deps), not the one-dep fixture.
      expect(registry.requests.length).toBeGreaterThan(1);
      expect(registry.requests).not.toContain(`/${FIXTURE_DEP}`);
      // The fixture registry serves only FIXTURE_VERSION, so the real deps have
      // no publish time there and the gate fails closed (1 or 2).
      expect([1, 2]).toContain(exitCode);
    } finally {
      registry.stop();
    }
  }, 30_000);

  it("refuses an EMPTY override on the CI invocation, before reading or fetching", async () => {
    const registry = freshRegistry();
    try {
      const { exitCode, output } = await runGate(
        CLI_SCRIPT,
        { FLAIR_CHECK_DEP_AGES_ROOT: "", FLAIR_NPM_REGISTRY: registry.url },
        ["--ci"],
      );
      // A PRESENT-but-empty override is refused like any other.
      expect(output).toContain("FLAIR_CHECK_DEP_AGES_ROOT");
      expect(output).not.toContain("Checking"); // never started scanning
      expect(registry.requests).toEqual([]); // no registry request
      expect(exitCode).toBe(2);
    } finally {
      registry.stop();
    }
  }, 30_000);

  it("refuses an unknown argument, before scanning", async () => {
    const registry = freshRegistry();
    try {
      const { exitCode, output } = await runGate(
        CLI_SCRIPT,
        { FLAIR_NPM_REGISTRY: registry.url },
        ["--c1"], // a typo of --ci
      );
      expect(output).toContain("--c1"); // names the offending argument
      expect(output).toContain("--ci"); // ... and the accepted form
      expect(output).not.toContain("Checking");
      expect(registry.requests).toEqual([]);
      expect(exitCode).toBe(2);
    } finally {
      registry.stop();
    }
  }, 30_000);
});

describe("CLI fail-closed exit — unparseable publish time", () => {
  // Runs the gate against a fixture registry serving `value` as the pinned
  // dep's publish time, and asserts the fail-closed shape: the SPECIFIC
  // diagnostic, EXACTLY ONE request (not retried), and exit 2. Asserting the
  // diagnostic (not just the generic registry-failure report) keeps this from
  // passing on an unrelated fetch failure.
  async function assertUnparseable(label: string, value: unknown) {
    const root = writeFixtureRepo(join(scratch, `unparseable-${label}`));
    const registry = unparseableRegistry(value);
    try {
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: registry.url,
      });
      expect(output).toContain("unparseable publish time");
      expect(output).toContain(`${FIXTURE_DEP}@${FIXTURE_VERSION}`);
      expect(output).not.toContain("younger than the bake-time policy");
      expect(registry.requests).toEqual([`/${FIXTURE_DEP}`]); // exactly one
      expect(exitCode).toBe(2);
    } finally {
      registry.stop();
    }
  }

  it("a non-date STRING is a non-retryable registry failure (flair#2076)", async () => {
    await assertUnparseable("string", "not-a-timestamp");
  }, 30_000);

  it("an OBJECT publish time fails closed without a retried throw", async () => {
    await assertUnparseable("object", { toString: null });
  }, 30_000);

  it("a NUMBER publish time fails closed (Date.parse(1) is a finite date)", async () => {
    await assertUnparseable("number", 1);
  }, 30_000);
});
