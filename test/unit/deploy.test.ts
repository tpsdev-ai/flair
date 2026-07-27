/**
 * deploy.test.ts — Unit tests for `flair deploy` pre-flight logic.
 *
 * Covers pure/extractable validation and resolution without making any
 * network calls to Harper Fabric.
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  validateOptions,
  buildTargetUrl,
  resolvePackageRoot,
  validatePackageLayout,
  deploy,
  REQUIRED_PACKAGE_FILES,
  buildHarperDeployArgs,
  DEFAULT_DEPLOYMENT_TIMEOUT_MS,
  DEFAULT_INSTALL_TIMEOUT_MS,
  deriveVerifyResources,
  FALLBACK_VERIFY_RESOURCE,
  verifyDeployServing,
  REPLICATION_FAILURE_RE,
  DEFAULT_DEPLOY_RETRIES,
  DEPLOY_RETRY_BACKOFF_MS,
  describeDeployFailure,
  summarizeHarperOutput,
  type DeployAttemptFailure,
} from "../../src/deploy.js";
import type { ConvergenceDeps } from "../../src/replication-convergence.js";

// ─── flair#878 helpers: a fake cluster for the convergence poll ─────────────
//
// deploy()'s convergence/quiescence polls go through an injected
// ConvergenceDeps, so these tests drive real decision logic with no network
// and no wall-clock waiting (the clock only advances when sleep() is awaited).

const FAKE_TARGET = "https://prod.acme.harperfabric.com";
const FAKE_TARGET_HOST = "prod.acme.harperfabric.com";
const FAKE_PEER_HOST = "node-b.acme.harperfabric.com";
const FAKE_PEER_URL = "https://node-b.acme.harperfabric.com";

function fakeTree(project: string, mtime: string): unknown {
  return {
    name: "components",
    entries: [{ name: project, entries: [{ name: "config.yaml", size: 2551, mtime }] }],
  };
}

const MTIME_NEW = "2026-07-27T14:45:44.000Z";
const MTIME_OLD = "2026-07-01T09:00:00.000Z";

function fakeConvergenceDeps(cfg: {
  /** baseUrl -> body (or a thunk, to script a per-read sequence). */
  trees: Record<string, unknown | (() => unknown)>;
  addresses: Record<string, string[]>;
}): ConvergenceDeps {
  let t = 0;
  return {
    getComponents: async (baseUrl: string) => {
      const entry = cfg.trees[baseUrl];
      if (entry === undefined) throw new Error("get_components returned HTTP 502");
      return typeof entry === "function" ? (entry as () => unknown)() : entry;
    },
    resolveHostAddresses: async (hostname: string) => {
      const addrs = cfg.addresses[hostname];
      if (!addrs) throw new Error("ENOTFOUND");
      return addrs;
    },
    sleep: async (ms: number) => {
      t += ms;
    },
    now: () => t,
  };
}

/** Every peer holds exactly what the origin holds — replication healed. */
const CONVERGED_CLUSTER = () =>
  fakeConvergenceDeps({
    trees: { [FAKE_TARGET]: fakeTree("flair", MTIME_NEW), [FAKE_PEER_URL]: fakeTree("flair", MTIME_NEW) },
    addresses: { [FAKE_TARGET_HOST]: ["203.0.113.10"], [FAKE_PEER_HOST]: ["203.0.113.20"] },
  });

/** Peer stuck on the previous tree, origin stable — conclusive non-convergence. */
const DIVERGED_CLUSTER = () =>
  fakeConvergenceDeps({
    trees: { [FAKE_TARGET]: fakeTree("flair", MTIME_NEW), [FAKE_PEER_URL]: fakeTree("flair", MTIME_OLD) },
    addresses: { [FAKE_TARGET_HOST]: ["203.0.113.10"], [FAKE_PEER_HOST]: ["203.0.113.20"] },
  });

describe("flair deploy: validateOptions", () => {
  test("rejects missing org + cluster", () => {
    const errs = validateOptions({
      fabricUser: "admin",
      fabricPassword: "pw",
    });
    expect(errs).toContain("--fabric-org required (or FABRIC_ORG env)");
    expect(errs).toContain("--fabric-cluster required (or FABRIC_CLUSTER env)");
  });

  test("rejects missing credentials", () => {
    const errs = validateOptions({
      fabricOrg: "acme",
      fabricCluster: "prod",
    });
    expect(errs.some(e => e.startsWith("credentials required"))).toBe(true);
  });

  test("accepts basic auth", () => {
    const errs = validateOptions({
      fabricOrg: "acme",
      fabricCluster: "prod",
      fabricUser: "admin",
      fabricPassword: "pw",
    });
    expect(errs).toEqual([]);
  });

  test("accepts bearer token", () => {
    const errs = validateOptions({
      fabricOrg: "acme",
      fabricCluster: "prod",
      fabricToken: "tok",
    });
    expect(errs).toEqual([]);
  });

  test("--target skips org/cluster requirement", () => {
    const errs = validateOptions({
      target: "https://custom.host",
      fabricUser: "admin",
      fabricPassword: "pw",
    });
    expect(errs).toEqual([]);
  });
});

describe("flair deploy: buildTargetUrl", () => {
  test("constructs fabric URL from org + cluster", () => {
    expect(
      buildTargetUrl({ fabricOrg: "acme", fabricCluster: "prod" }),
    ).toBe("https://prod.acme.harperfabric.com");
  });

  test("--target wins over org/cluster", () => {
    expect(
      buildTargetUrl({
        fabricOrg: "acme",
        fabricCluster: "prod",
        target: "https://custom.host:9925",
      }),
    ).toBe("https://custom.host:9925");
  });
});

describe("flair deploy: package resolution", () => {
  test("resolvePackageRoot finds the live package from its own module", () => {
    const root = resolvePackageRoot();
    // Verify we're inside the real flair package by checking package.json
    // name, not by directory basename (which breaks when cloned to a
    // differently-named directory).
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    expect(pkg.name).toBe("@tpsdev-ai/flair");
  });

  test("validatePackageLayout accepts a proper layout", () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-deploy-test-"));
    try {
      for (const f of REQUIRED_PACKAGE_FILES) {
        const p = join(dir, f);
        if (f.endsWith(".yaml")) writeFileSync(p, "port: 9926\n");
        else mkdirSync(p);
      }
      expect(() => validatePackageLayout(dir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("validatePackageLayout rejects missing dirs", () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-deploy-test-"));
    try {
      // Only create dist/, intentionally skip the rest
      mkdirSync(join(dir, "dist"));
      expect(() => validatePackageLayout(dir)).toThrow(/missing required/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("flair deploy: dry-run end-to-end", () => {
  // Synthesize a minimal package-root so the test is independent of whether
  // `dist/` has been built in the repo — unit tests run before build in CI.
  function synthPkgRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "flair-deploy-e2e-"));
    for (const f of REQUIRED_PACKAGE_FILES) {
      const p = join(dir, f);
      if (f.endsWith(".yaml")) writeFileSync(p, "port: 9926\n");
      else mkdirSync(p);
    }
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "@tpsdev-ai/flair", version: "9.9.9-test" }),
    );
    return dir;
  }

  test("returns success without calling Harper", async () => {
    const pkgRoot = synthPkgRoot();
    try {
      const result = await deploy({
        fabricOrg: "acme",
        fabricCluster: "prod",
        fabricUser: "admin",
        fabricPassword: "pw",
        dryRun: true,
        packageRoot: pkgRoot,
      });
      expect(result.dryRun).toBe(true);
      expect(result.url).toBe("https://prod.acme.harperfabric.com");
      expect(result.project).toBe("flair");
      expect(result.version).toBe("9.9.9-test");
    } finally {
      rmSync(pkgRoot, { recursive: true, force: true });
    }
  });

  test("rejects invalid options before any package work", async () => {
    await expect(
      deploy({
        fabricOrg: "acme",
        // missing cluster + creds
      } as any),
    ).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Incident fix: harper's deploy CLI defaults to a 120s peer-replication
// timeout with no override, which aborted a real Fabric deploy. These tests
// cover the two closes: (A) timeout passthrough, (B) post-deploy verification
// that the served API is actually serving (not just harper claiming success).
// ─────────────────────────────────────────────────────────────────────────

describe("flair deploy: buildHarperDeployArgs (timeout passthrough)", () => {
  test("defaults deployment_timeout and install_timeout to 600000ms", () => {
    expect(DEFAULT_DEPLOYMENT_TIMEOUT_MS).toBe(600_000);
    expect(DEFAULT_INSTALL_TIMEOUT_MS).toBe(600_000);

    const args = buildHarperDeployArgs(
      { fabricOrg: "acme", fabricCluster: "prod", fabricUser: "a", fabricPassword: "b" },
      "https://prod.acme.harperfabric.com",
      "flair",
    );
    expect(args).toContain("deployment_timeout=600000");
    expect(args).toContain("install_timeout=600000");
  });

  test("threads deploymentTimeoutMs / installTimeoutMs overrides through", () => {
    const args = buildHarperDeployArgs(
      { deploymentTimeoutMs: 900_000, installTimeoutMs: 45_000 },
      "https://custom.host",
      "flair",
    );
    expect(args).toContain("deployment_timeout=900000");
    expect(args).toContain("install_timeout=45000");
  });

  test("still carries target/project/restart/replicated alongside the new timeout args", () => {
    const args = buildHarperDeployArgs(
      { restart: false, replicated: false },
      "https://custom.host",
      "myproject",
    );
    expect(args).toEqual([
      "deploy",
      "target=https://custom.host",
      "project=myproject",
      "restart=false",
      "replicated=false",
      "deployment_timeout=600000",
      "install_timeout=600000",
    ]);
  });
});

describe("flair deploy: deriveVerifyResources", () => {
  test("derives table-backed Resource classes, skips helpers and generic-Resource action endpoints", () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-deploy-derive-"));
    const resourcesDir = join(dir, "dist", "resources");
    mkdirSync(resourcesDir, { recursive: true });
    try {
      // Real table-backed resources (the kind curled in the incident).
      writeFileSync(
        join(resourcesDir, "Memory.js"),
        "export class Memory extends databases.flair.Memory {}\n",
      );
      writeFileSync(
        join(resourcesDir, "Soul.js"),
        "export class Soul extends databases.flair.Soul {}\n",
      );
      // Action-style endpoint extending the generic Resource base — not a
      // GET-able collection, must be excluded.
      writeFileSync(
        join(resourcesDir, "AgentCard.js"),
        "export class AgentCard extends Resource {}\n",
      );
      // Lowercase helper module — never a route, must be excluded.
      writeFileSync(
        join(resourcesDir, "agent-auth.js"),
        "export function allowAdmin() { return true; }\n",
      );

      const resources = deriveVerifyResources(dir);
      expect(resources).toEqual(["Memory", "Soul"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("falls back to FALLBACK_VERIFY_RESOURCE when dist/resources can't be scanned", () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-deploy-derive-missing-"));
    try {
      expect(deriveVerifyResources(dir)).toEqual([FALLBACK_VERIFY_RESOURCE]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("flair deploy: verifyDeployServing (served-API verification)", () => {
  // Fast settling for tests: 1ms poll interval, 1-response streak unless a
  // test needs to exercise the flap/retry path specifically.
  const FAST = { pollIntervalMs: 1, settleStreak: 1, timeoutMs: 2000 };

  test("404 on the resource fails loudly with a clear message (the incident: empty deploy, harper said success)", async () => {
    const fetchImpl = (async (url: any) => {
      const u = String(url);
      return new Response("", { status: u.endsWith("/Memory") ? 404 : 200 });
    }) as unknown as typeof fetch;

    await expect(
      verifyDeployServing({
        baseUrl: "https://cluster.org.harperfabric.com",
        resources: ["Memory"],
        fetchImpl,
        ...FAST,
      }),
    ).rejects.toThrow(/deploy reported success but \/Memory returns 404 — component is not serving/);
  });

  test("401 (auth-gated) and 200 both count as serving — no throw", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call++;
      // First call is the settle probe against baseUrl; alternate 401/200
      // for the resource checks to prove both are accepted.
      return new Response("", { status: call % 2 === 0 ? 401 : 200 });
    }) as unknown as typeof fetch;

    await expect(
      verifyDeployServing({
        baseUrl: "https://cluster.org.harperfabric.com",
        resources: ["Memory", "Agent"],
        fetchImpl,
        ...FAST,
      }),
    ).resolves.toBeUndefined();
  });

  test("connection-flap (network failure, then reachable) retries the settle probe then passes", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call++;
      if (call <= 2) throw new Error("connect ECONNREFUSED (simulated post-restart flap)");
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    await expect(
      verifyDeployServing({
        baseUrl: "https://cluster.org.harperfabric.com",
        resources: ["Memory"],
        fetchImpl,
        pollIntervalMs: 1,
        settleStreak: 3,
        timeoutMs: 5000,
      }),
    ).resolves.toBeUndefined();
    // 2 failures + 3-streak settle (3 more calls) + 1 resource check = 6
    expect(call).toBeGreaterThanOrEqual(6);
  });

  test("endpoint never comes back (always unreachable) fails with a settle-timeout message", async () => {
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;

    await expect(
      verifyDeployServing({
        baseUrl: "https://cluster.org.harperfabric.com",
        resources: ["Memory"],
        fetchImpl,
        pollIntervalMs: 5,
        settleStreak: 3,
        timeoutMs: 20,
      }),
    ).rejects.toThrow(/did not settle within 20ms after restart/);
  });
});

describe("flair deploy: deploy() gating — --no-verify and --dry-run both skip verification", () => {
  function synthPkgRootForGatingTests(): string {
    const dir = mkdtempSync(join(tmpdir(), "flair-deploy-gating-"));
    for (const f of REQUIRED_PACKAGE_FILES) {
      const p = join(dir, f);
      if (f.endsWith(".yaml")) writeFileSync(p, "port: 9926\n");
      else mkdirSync(p, { recursive: true });
    }
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "@tpsdev-ai/flair", version: "9.9.9-test" }),
    );
    return dir;
  }

  // flair#870: `harperPkg` selects which package-name layout the stub is
  // planted under. Default is the BARE `harper` name flair now declares; the
  // legacy scoped name is exercised by its own test below, because a staged
  // install of an OLDER published flair still resolves that way.
  function addStubHarperBinary(packageRoot: string, harperPkg = "harper"): void {
    // Stands in for the real harper CLI so spawnHarper() succeeds without
    // touching a real Fabric cluster — exits 0 immediately.
    const binDir = join(packageRoot, "node_modules", harperPkg, "dist", "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "harper.js"), "process.exit(0);\n");
  }

  // flair#870 regression guard: resolveHarperBin() must still find a Harper
  // planted ONLY under the legacy scoped layout. `flair upgrade --target`
  // stages a published flair version, and every version before #870 declared
  // `@harperfast/harper` — if this fallback is dropped, deploying from such a
  // stage throws "Could not locate Harper CLI binary" instead of deploying.
  test("resolves the Harper bin from the legacy @harperfast/harper layout", async () => {
    const pkgRoot = synthPkgRootForGatingTests();
    addStubHarperBinary(pkgRoot, join("@harperfast", "harper"));
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("", { status: 200 })) as any;
    try {
      const result = await deploy({
        fabricOrg: "acme",
        fabricCluster: "prod",
        fabricUser: "admin",
        fabricPassword: "pw",
        packageRoot: pkgRoot,
        verify: false,
      });
      expect(result.dryRun).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
      rmSync(pkgRoot, { recursive: true, force: true });
    }
  });

  test("verify: false skips the served-API check entirely (--no-verify)", async () => {
    const pkgRoot = synthPkgRootForGatingTests();
    addStubHarperBinary(pkgRoot);
    const origFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response("", { status: 200 });
    }) as any;
    try {
      const result = await deploy({
        fabricOrg: "acme",
        fabricCluster: "prod",
        fabricUser: "admin",
        fabricPassword: "pw",
        packageRoot: pkgRoot,
        verify: false,
      });
      expect(result.dryRun).toBe(false);
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = origFetch;
      rmSync(pkgRoot, { recursive: true, force: true });
    }
  });

  test("--dry-run skips both the harper deploy call AND verification", async () => {
    // Deliberately no stub harper binary present — if deploy() incorrectly
    // tried to spawn harper, resolveHarperBin() would throw before we ever
    // got here, failing this test.
    const pkgRoot = synthPkgRootForGatingTests();
    const origFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error("fetch must not be called during --dry-run");
    }) as any;
    try {
      const result = await deploy({
        fabricOrg: "acme",
        fabricCluster: "prod",
        fabricUser: "admin",
        fabricPassword: "pw",
        packageRoot: pkgRoot,
        dryRun: true,
      });
      expect(result.dryRun).toBe(true);
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = origFetch;
      rmSync(pkgRoot, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Flaky-peer-replication resilience. A real Fabric deploy hit
//   "Component 'flair' was deployed on the origin node but failed to
//    replicate to 1 of 1 peer node(s): ... (Error: Connection closed 1006)"
// and hard-exited 1 — a bare manual retry cleared it with no other change.
// These tests cover: (A) the replication-signature detector itself, (B) the
// retry loop firing ONLY on that signature, (C) --deploy-retries 0 disabling
// retry, (D) --ignore-replication-errors turning a still-failing replication
// error into a warned success.
// ─────────────────────────────────────────────────────────────────────────

describe("flair deploy: REPLICATION_FAILURE_RE (signature detection)", () => {
  test("matches the real incident message", () => {
    expect(
      "Component 'flair' was deployed on the origin node but failed to replicate to 1 of 1 peer node(s): timeout (Error: Connection closed 1006)",
    ).toMatch(REPLICATION_FAILURE_RE);
  });

  test("matches a bare 'Connection closed 1006'", () => {
    expect("socket error: Connection closed 1006").toMatch(REPLICATION_FAILURE_RE);
  });

  test("matches a 'failed to replicate to N peer(s)' without 'of M'", () => {
    expect("failed to replicate to 2 peer nodes").toMatch(REPLICATION_FAILURE_RE);
  });

  test("does NOT match an unrelated deploy failure", () => {
    expect("Error: ENOENT: no such file or directory, package tarball not found").not.toMatch(
      REPLICATION_FAILURE_RE,
    );
  });

  test("does NOT match a plain auth failure", () => {
    expect("Error: 401 Unauthorized").not.toMatch(REPLICATION_FAILURE_RE);
  });

  test("does NOT match benign mentions of 'peer' with no failure", () => {
    expect("Fabric cluster has 3 peer nodes, all healthy").not.toMatch(REPLICATION_FAILURE_RE);
  });
});

describe("flair deploy: buildHarperDeployArgs (--ignore-replication-errors passthrough)", () => {
  test("omits ignore_replication_errors by default", () => {
    const args = buildHarperDeployArgs(
      { fabricOrg: "acme", fabricCluster: "prod", fabricUser: "a", fabricPassword: "b" },
      "https://prod.acme.harperfabric.com",
      "flair",
    );
    expect(args.some((a) => a.startsWith("ignore_replication_errors"))).toBe(false);
  });

  test("appends ignore_replication_errors=true when set", () => {
    const args = buildHarperDeployArgs(
      { ignoreReplicationErrors: true },
      "https://custom.host",
      "flair",
    );
    expect(args).toContain("ignore_replication_errors=true");
  });
});

describe("flair deploy: deploy() replication-flake retry + --ignore-replication-errors", () => {
  function synthPkgRootForReplicationTests(): string {
    const dir = mkdtempSync(join(tmpdir(), "flair-deploy-replication-"));
    for (const f of REQUIRED_PACKAGE_FILES) {
      const p = join(dir, f);
      if (f.endsWith(".yaml")) writeFileSync(p, "port: 9926\n");
      else mkdirSync(p, { recursive: true });
    }
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "@tpsdev-ai/flair", version: "9.9.9-test" }),
    );
    return dir;
  }

  // Scripted stub harper binary: on each invocation, consults `behaviors`
  // (indexed by attempt number, clamped to the last entry) and either exits
  // 0 ("success"), exits 1 with the real replication-failure message
  // ("replication-fail"), or exits 1 with an unrelated message ("other-fail").
  // Attempt count is persisted to a counter file on disk so it survives
  // across separate process spawns (one spawn per retry attempt).
  function addScriptedHarperBinary(packageRoot: string, behaviors: string[]): string {
    const binDir = join(packageRoot, "node_modules", "harper", "dist", "bin");
    mkdirSync(binDir, { recursive: true });
    const counterPath = join(packageRoot, ".attempt-count");
    writeFileSync(counterPath, "0");
    const script = `
const fs = require('fs');
const counterPath = ${JSON.stringify(counterPath)};
const behaviors = ${JSON.stringify(behaviors)};
let n = parseInt(fs.readFileSync(counterPath, 'utf8'), 10) || 0;
n += 1;
fs.writeFileSync(counterPath, String(n));
const behavior = behaviors[Math.min(n - 1, behaviors.length - 1)];
if (behavior === 'success') {
  console.log('Successfully deployed');
  process.exit(0);
} else if (behavior === 'replication-fail') {
  // Peer detail that is NOT an addressable host — harper's detail is free
  // text and can be an error string. Fixture for "convergence cannot be
  // checked from here" (flair#878).
  console.error("Component 'flair' was deployed on the origin node but failed to replicate to 1 of 1 peer node(s): timeout waiting for ack (Error: Connection closed 1006)");
  process.exit(1);
} else if (behavior === 'replication-fail-named') {
  // The real shape harper emits, with a node name the CLI can address.
  console.error("Component 'flair' was deployed on the origin node but failed to replicate to 1 of 1 peer node(s): ${FAKE_PEER_HOST} (Error: Connection closed  1006). See deployment 0f2c-9b1a (get_deployment) for details, or pass ignore_replication_errors: true to treat replication failures as non-fatal.");
  process.exit(1);
} else if (behavior === 'enotempty-fail') {
  // The exact escalation from the flair#878 report: the RETRY's install dies
  // over the previous attempt's native-module tree.
  console.error("npm error code ENOTEMPTY");
  console.error("npm error ENOTEMPTY: directory not empty, rmdir '/home/harperdb/harper/components/flair/node_modules/node-llama-cpp/dist'");
  console.error("error: Failed to install dependencies for flair using npm default. Exit code: 217 (500)");
  process.exit(1);
} else {
  console.error('Error: ENOENT: package tarball not found');
  process.exit(1);
}
`;
    writeFileSync(join(binDir, "harper.js"), script);
    return counterPath;
  }

  function attemptCount(counterPath: string): number {
    return parseInt(readFileSync(counterPath, "utf8"), 10) || 0;
  }

  // flair#878 moved this default from 2 to 0: retrying re-runs harper's own
  // component install, which is not idempotent over an existing native-module
  // tree, so the remedy could be worse than the transient it retried. The
  // convergence poll now covers the window the retry was buying.
  test("defaults: DEFAULT_DEPLOY_RETRIES=0, DEPLOY_RETRY_BACKOFF_MS=[5000,10000]", () => {
    expect(DEFAULT_DEPLOY_RETRIES).toBe(0);
    expect(DEPLOY_RETRY_BACKOFF_MS).toEqual([5_000, 10_000]);
  });

  test("non-replication failure fails immediately — no retry, even with retries available", async () => {
    const pkgRoot = synthPkgRootForReplicationTests();
    // If a retry incorrectly fired, attempt 2 would succeed — proves the
    // assertion is about retry behavior, not just eventual failure.
    const counterPath = addScriptedHarperBinary(pkgRoot, ["other-fail", "success"]);
    try {
      await expect(
        deploy({
          fabricOrg: "acme",
          fabricCluster: "prod",
          fabricUser: "admin",
          fabricPassword: "pw",
          packageRoot: pkgRoot,
          verify: false,
          deployRetries: 2,
          deployRetryBackoffMs: [1, 1],
        }),
      ).rejects.toThrow(/harper deploy exited with code 1/);
      expect(attemptCount(counterPath)).toBe(1);
    } finally {
      rmSync(pkgRoot, { recursive: true, force: true });
    }
  });

  test("succeeds on attempt 2 after an OBSERVED non-convergence on attempt 1 (loud retry log)", async () => {
    const pkgRoot = synthPkgRootForReplicationTests();
    const counterPath = addScriptedHarperBinary(pkgRoot, ["replication-fail-named", "success"]);
    const origWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: any) => { warnings.push(String(msg)); };
    try {
      const result = await deploy({
        fabricOrg: "acme",
        fabricCluster: "prod",
        fabricUser: "admin",
        fabricPassword: "pw",
        packageRoot: pkgRoot,
        verify: false,
        deployRetries: 2,
        deployRetryBackoffMs: [1, 1],
        convergenceTimeoutMs: 1,
        convergenceDeps: DIVERGED_CLUSTER(),
      });
      expect(result.dryRun).toBe(false);
      expect(result.replicationWarning).toBe(false);
      expect(attemptCount(counterPath)).toBe(2);
      expect(warnings.some((w) => /did not converge on attempt 1\/3/.test(w))).toBe(true);
    } finally {
      console.warn = origWarn;
      rmSync(pkgRoot, { recursive: true, force: true });
    }
  });

  test("--deploy-retries 0 disables retry — first replication failure fails immediately", async () => {
    const pkgRoot = synthPkgRootForReplicationTests();
    const counterPath = addScriptedHarperBinary(pkgRoot, ["replication-fail", "success"]);
    try {
      await expect(
        deploy({
          fabricOrg: "acme",
          fabricCluster: "prod",
          fabricUser: "admin",
          fabricPassword: "pw",
          packageRoot: pkgRoot,
          verify: false,
          deployRetries: 0,
        }),
      ).rejects.toThrow(/peer replication was reported failed/);
      expect(attemptCount(counterPath)).toBe(1);
    } finally {
      rmSync(pkgRoot, { recursive: true, force: true });
    }
  });

  test("--ignore-replication-errors: still-failing replication after retries exhausted becomes a warned success", async () => {
    const pkgRoot = synthPkgRootForReplicationTests();
    // Always fails with the replication signature — simulates harper's own
    // ignore_replication_errors not fully suppressing the non-zero exit.
    const counterPath = addScriptedHarperBinary(pkgRoot, ["replication-fail"]);
    const origWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: any) => { warnings.push(String(msg)); };
    try {
      const result = await deploy({
        fabricOrg: "acme",
        fabricCluster: "prod",
        fabricUser: "admin",
        fabricPassword: "pw",
        packageRoot: pkgRoot,
        verify: false,
        deployRetries: 0,
        ignoreReplicationErrors: true,
      });
      expect(result.dryRun).toBe(false);
      expect(result.replicationWarning).toBe(true);
      expect(attemptCount(counterPath)).toBe(1);
      expect(warnings.some((w) => /WARNED SUCCESS/.test(w))).toBe(true);
    } finally {
      console.warn = origWarn;
      rmSync(pkgRoot, { recursive: true, force: true });
    }
  });

  test("--ignore-replication-errors composes with retry: retries first, then falls back to warned success", async () => {
    const pkgRoot = synthPkgRootForReplicationTests();
    const counterPath = addScriptedHarperBinary(pkgRoot, [
      "replication-fail-named",
      "replication-fail-named",
      "replication-fail-named",
    ]);
    try {
      const result = await deploy({
        fabricOrg: "acme",
        fabricCluster: "prod",
        fabricUser: "admin",
        fabricPassword: "pw",
        packageRoot: pkgRoot,
        verify: false,
        deployRetries: 2,
        deployRetryBackoffMs: [1, 1],
        convergenceTimeoutMs: 1,
        convergenceDeps: DIVERGED_CLUSTER(),
        ignoreReplicationErrors: true,
      });
      expect(result.replicationWarning).toBe(true);
      // 1 initial attempt + 2 retries = 3 total attempts before falling back.
      expect(attemptCount(counterPath)).toBe(3);
    } finally {
      rmSync(pkgRoot, { recursive: true, force: true });
    }
  });

  // ── flair#878 ─────────────────────────────────────────────────────────────

  test("CONVERGED: a replication error whose peers actually converged is a SUCCESS, not a failure", async () => {
    // The reported incident: harper exits 1 with a peer-replication error while
    // Harper is still healing; afterwards both nodes carry identical component
    // files. The deploy succeeded and must be reported as such.
    const pkgRoot = synthPkgRootForReplicationTests();
    const counterPath = addScriptedHarperBinary(pkgRoot, ["replication-fail-named"]);
    const origWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: any) => { warnings.push(String(msg)); };
    try {
      const result = await deploy({
        fabricOrg: "acme",
        fabricCluster: "prod",
        fabricUser: "admin",
        fabricPassword: "pw",
        packageRoot: pkgRoot,
        verify: false,
        deployRetries: 2,
        deployRetryBackoffMs: [1, 1],
        convergenceDeps: CONVERGED_CLUSTER(),
      });
      expect(result.convergedAfterReplicationError).toBe(true);
      expect(result.replicationWarning).toBe(false);
      // No retry: convergence was confirmed, so nothing was re-deployed.
      expect(attemptCount(counterPath)).toBe(1);
      expect(warnings.some((w) => /CONVERGED on its own/.test(w))).toBe(true);
    } finally {
      console.warn = origWarn;
      rmSync(pkgRoot, { recursive: true, force: true });
    }
  });

  test("NO ESCALATION: when a retry dies with ENOTEMPTY, the reported error is the ORIGINAL replication failure", async () => {
    // The core defect. Attempt 1 = transient peer-replication error; the retry
    // then dies on npm ENOTEMPTY over the previous attempt's native-module
    // tree. Reporting the ENOTEMPTY sends the operator into node_modules when
    // the actual event was a peer link blipping.
    const pkgRoot = synthPkgRootForReplicationTests();
    const counterPath = addScriptedHarperBinary(pkgRoot, ["replication-fail-named", "enotempty-fail"]);
    try {
      const err = await deploy({
        fabricOrg: "acme",
        fabricCluster: "prod",
        fabricUser: "admin",
        fabricPassword: "pw",
        packageRoot: pkgRoot,
        verify: false,
        deployRetries: 1,
        deployRetryBackoffMs: [1],
        convergenceTimeoutMs: 1,
        convergenceDeps: DIVERGED_CLUSTER(),
      }).then(
        () => null,
        (e: Error) => e,
      );
      expect(attemptCount(counterPath)).toBe(2);
      expect(err).not.toBeNull();
      const msg = err!.message;
      // The headline is the replication failure...
      expect(msg.split("\n")[0]).toMatch(/peer replication was reported failed/);
      // ...the ENOTEMPTY is still reported, but explicitly as a consequence...
      expect(msg).toMatch(/ENOTEMPTY/);
      expect(msg).toMatch(/CONSEQUENCE of retrying/);
      // ...and it is never the first thing the operator reads.
      expect(msg.indexOf("peer replication")).toBeLessThan(msg.indexOf("ENOTEMPTY"));
    } finally {
      rmSync(pkgRoot, { recursive: true, force: true });
    }
  });

  test("INCONCLUSIVE: convergence that cannot be determined does NOT authorise a retry", async () => {
    // A retry is the destructive operation here. "We could not look" is not a
    // licence to re-deploy into a cluster that may still be mid-heal.
    const pkgRoot = synthPkgRootForReplicationTests();
    // Attempt 2 would SUCCEED if it fired — so the assertion is about the retry
    // decision, not about eventual failure.
    const counterPath = addScriptedHarperBinary(pkgRoot, ["replication-fail", "success"]);
    const origWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: any) => { warnings.push(String(msg)); };
    try {
      await expect(
        deploy({
          fabricOrg: "acme",
          fabricCluster: "prod",
          fabricUser: "admin",
          fabricPassword: "pw",
          packageRoot: pkgRoot,
          verify: false,
          deployRetries: 2,
          deployRetryBackoffMs: [1, 1],
          convergenceDeps: CONVERGED_CLUSTER(),
        }),
      ).rejects.toThrow(/peer replication was reported failed/);
      expect(attemptCount(counterPath)).toBe(1);
      expect(warnings.some((w) => /NOT retrying/.test(w))).toBe(true);
    } finally {
      console.warn = origWarn;
      rmSync(pkgRoot, { recursive: true, force: true });
    }
  });

  test("NOT QUIESCENT: a retry is withheld while the origin's component tree is still changing", async () => {
    // Overlapping a retry with the previous attempt's still-running install is
    // what produces ENOTEMPTY. Attempt 2 would succeed if it fired.
    const pkgRoot = synthPkgRootForReplicationTests();
    const counterPath = addScriptedHarperBinary(pkgRoot, ["replication-fail-named", "success"]);
    let n = 0;
    const churning = fakeConvergenceDeps({
      trees: {
        // Origin never settles: a different tree on every read.
        [FAKE_TARGET]: () => fakeTree("flair", `2026-07-27T14:45:${String(44 + ++n).padStart(2, "0")}.000Z`),
        [FAKE_PEER_URL]: fakeTree("flair", MTIME_OLD),
      },
      addresses: { [FAKE_TARGET_HOST]: ["203.0.113.10"], [FAKE_PEER_HOST]: ["203.0.113.20"] },
    });
    const origWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: any) => { warnings.push(String(msg)); };
    try {
      await expect(
        deploy({
          fabricOrg: "acme",
          fabricCluster: "prod",
          fabricUser: "admin",
          fabricPassword: "pw",
          packageRoot: pkgRoot,
          verify: false,
          deployRetries: 2,
          deployRetryBackoffMs: [1, 1],
          convergenceTimeoutMs: 1,
          convergenceDeps: churning,
        }),
      ).rejects.toThrow(/peer replication was reported failed/);
      expect(attemptCount(counterPath)).toBe(1);
      expect(warnings.some((w) => /NOT retrying/.test(w) && /ENOTEMPTY/.test(w))).toBe(true);
    } finally {
      console.warn = origWarn;
      rmSync(pkgRoot, { recursive: true, force: true });
    }
  });

  test("--no-convergence-check + --deploy-retries honours the pre-#878 retry behaviour it opts into", async () => {
    // The flag means "don't poll, do what you used to". An operator who sets
    // BOTH gets the old behaviour including its hazard — silently refusing to
    // retry would make the flag mean something other than what it says.
    const pkgRoot = synthPkgRootForReplicationTests();
    const counterPath = addScriptedHarperBinary(pkgRoot, ["replication-fail-named", "success"]);
    try {
      const result = await deploy({
        fabricOrg: "acme",
        fabricCluster: "prod",
        fabricUser: "admin",
        fabricPassword: "pw",
        packageRoot: pkgRoot,
        verify: false,
        deployRetries: 1,
        deployRetryBackoffMs: [1],
        convergenceCheck: false,
      });
      expect(result.convergedAfterReplicationError).toBe(false);
      expect(attemptCount(counterPath)).toBe(2);
    } finally {
      rmSync(pkgRoot, { recursive: true, force: true });
    }
  });

  test("--no-convergence-check restores the pre-#878 behaviour (fail on harper's error verbatim)", async () => {
    const pkgRoot = synthPkgRootForReplicationTests();
    const counterPath = addScriptedHarperBinary(pkgRoot, ["replication-fail-named"]);
    try {
      await expect(
        deploy({
          fabricOrg: "acme",
          fabricCluster: "prod",
          fabricUser: "admin",
          fabricPassword: "pw",
          packageRoot: pkgRoot,
          verify: false,
          deployRetries: 0,
          convergenceCheck: false,
          // Would report CONVERGED if it were consulted — it must not be.
          convergenceDeps: CONVERGED_CLUSTER(),
        }),
      ).rejects.toThrow(/peer replication was reported failed/);
      expect(attemptCount(counterPath)).toBe(1);
    } finally {
      rmSync(pkgRoot, { recursive: true, force: true });
    }
  });
});

// ─── flair#878: describeDeployFailure (the anti-escalation rule) ────────────

describe("flair#878: describeDeployFailure", () => {
  const rep = (attempt: number, summary = "failed to replicate to 1 of 1 peer node(s): node-b (1006)"): DeployAttemptFailure =>
    ({ attempt, totalAttempts: 3, code: 1, kind: "replication", summary });
  const other = (attempt: number, summary = "npm error ENOTEMPTY: directory not empty, rmdir '.../node-llama-cpp/dist'"): DeployAttemptFailure =>
    ({ attempt, totalAttempts: 3, code: 1, kind: "other", summary });

  test("a single non-replication failure is reported verbatim", () => {
    const msg = describeDeployFailure([other(1, "Error: 401 Unauthorized")]);
    expect(msg).toMatch(/401 Unauthorized/);
    expect(msg).not.toMatch(/CONSEQUENCE/);
  });

  test("replication then ENOTEMPTY: the headline is the replication failure, not the ENOTEMPTY", () => {
    const msg = describeDeployFailure([rep(1), other(2)]);
    expect(msg.split("\n")[0]).toMatch(/peer replication was reported failed/);
    expect(msg.split("\n")[0]).not.toMatch(/ENOTEMPTY/);
  });

  test("the escalated failure is still surfaced, labelled as caused by the retry, with the remedy named", () => {
    const msg = describeDeployFailure([rep(1), other(2)]);
    expect(msg).toMatch(/ENOTEMPTY/);
    expect(msg).toMatch(/CONSEQUENCE of retrying/);
    expect(msg).toMatch(/--deploy-retries 0/);
  });

  test("repeated replication failures do not manufacture an escalation notice", () => {
    const msg = describeDeployFailure([rep(1), rep(2), rep(3)]);
    expect(msg).not.toMatch(/CONSEQUENCE of retrying/);
  });

  test("the convergence verdict is carried into the error so the operator knows what was checked", () => {
    const msg = describeDeployFailure([rep(1)], {
      converged: false,
      conclusive: true,
      peers: [],
      elapsedMs: 12,
      detail: "peer replication did NOT converge — node-b: diverged",
    });
    expect(msg).toMatch(/convergence check: peer replication did NOT converge/);
  });

  test("an empty history never produces a confident message", () => {
    expect(describeDeployFailure([])).toMatch(/no recorded attempt/);
  });
});

describe("flair#878: summarizeHarperOutput", () => {
  test("prefers the last error-shaped line", () => {
    const out = "prepare done\ninstall started\nnpm error code ENOTEMPTY\nsome trailing note\n";
    expect(summarizeHarperOutput(out)).toMatch(/ENOTEMPTY/);
  });

  test("falls back to the last non-empty line, and never returns an empty string", () => {
    expect(summarizeHarperOutput("alpha\nbeta\n\n")).toBe("beta");
    expect(summarizeHarperOutput("")).toBe("(no output)");
    expect(summarizeHarperOutput("   \n\n")).toBe("(no output)");
  });
});
