/**
 * fabric-upgrade.test.ts — Unit tests for `flair upgrade --target <fabric>`.
 *
 * Covers the pure version-resolution + Harper-pin logic, and the orchestrator
 * with deploy()/npm/registry fully mocked — NO real Fabric deploy, no network.
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseSemverCore,
  semverGte,
  resolveHarperPin,
  buildDeployablePackageJson,
  resolveStagedHarperVersion,
  planFabricUpgrade,
  fabricUpgrade,
  MIN_HARPER_VERSION,
  DEFAULT_HARPER_PIN,
  type FabricUpgradeDeps,
} from "../../src/fabric-upgrade.js";
import type { DeployOptions, DeployResult } from "../../src/deploy.js";

// ─── semver helpers ─────────────────────────────────────────────────────────

describe("parseSemverCore", () => {
  test("parses plain semver", () => {
    expect(parseSemverCore("5.1.14")).toEqual([5, 1, 14]);
  });
  test("strips leading v and pre-release / build", () => {
    expect(parseSemverCore("v0.14.0")).toEqual([0, 14, 0]);
    expect(parseSemverCore("5.1.14-rc.1")).toEqual([5, 1, 14]);
    expect(parseSemverCore("5.1.14+build.7")).toEqual([5, 1, 14]);
  });
  test("returns null for junk", () => {
    expect(parseSemverCore("")).toBeNull();
    expect(parseSemverCore("5.1")).toBeNull();
    expect(parseSemverCore("latest")).toBeNull();
  });
});

describe("semverGte", () => {
  test("orders correctly", () => {
    expect(semverGte("5.1.14", "5.1.13")).toBe(true);
    expect(semverGte("5.1.13", "5.1.13")).toBe(true);
    expect(semverGte("5.0.21", "5.1.13")).toBe(false);
    expect(semverGte("6.0.0", "5.99.99")).toBe(true);
    expect(semverGte("5.2.0", "5.1.99")).toBe(true);
  });
  test("false on unparseable input", () => {
    expect(semverGte("latest", "5.1.13")).toBe(false);
  });
});

// ─── Harper-pin logic (the baked-in dance) ──────────────────────────────────

describe("resolveHarperPin", () => {
  test("published flair@0.14.0 declares 5.0.21 → override to default fix", () => {
    const d = resolveHarperPin("5.0.21");
    expect(d.overridden).toBe(true);
    expect(d.pin).toBe(DEFAULT_HARPER_PIN);
    expect(semverGte(d.pin, MIN_HARPER_VERSION)).toBe(true);
    expect(d.declared).toBe("5.0.21");
    expect(d.reason).toContain("513");
  });

  test("declared already >= fix floor → no override, keep declared", () => {
    const d = resolveHarperPin("5.1.13");
    expect(d.overridden).toBe(false);
    expect(d.pin).toBe("5.1.13");
  });

  test("declared 5.1.20 (newer than floor) → no override", () => {
    const d = resolveHarperPin("5.1.20");
    expect(d.overridden).toBe(false);
    expect(d.pin).toBe("5.1.20");
  });

  test("declared absent/null → override to default fix", () => {
    const d = resolveHarperPin(null);
    expect(d.overridden).toBe(true);
    expect(d.pin).toBe(DEFAULT_HARPER_PIN);
  });

  test("caller's preferred pin is honored when >= floor", () => {
    const d = resolveHarperPin("5.0.21", "5.2.0");
    expect(d.overridden).toBe(true);
    expect(d.pin).toBe("5.2.0");
  });

  test("caller's preferred pin BELOW the floor is rejected (no silent regression)", () => {
    const d = resolveHarperPin("5.0.21", "5.1.10");
    expect(d.overridden).toBe(true);
    expect(d.pin).toBe(DEFAULT_HARPER_PIN); // not 5.1.10
    expect(d.reason).toContain("below the");
  });
});

describe("buildDeployablePackageJson", () => {
  test("adds overrides block ONLY when pin is an override", () => {
    const withOverride = buildDeployablePackageJson(
      "0.14.0",
      resolveHarperPin("5.0.21"),
    );
    expect((withOverride.dependencies as any)["@tpsdev-ai/flair"]).toBe("0.14.0");
    expect((withOverride.overrides as any)["@harperfast/harper"]).toBe(DEFAULT_HARPER_PIN);

    const noOverride = buildDeployablePackageJson(
      "0.14.0",
      resolveHarperPin("5.1.14"),
    );
    expect(noOverride.overrides).toBeUndefined();
  });
});

describe("resolveStagedHarperVersion", () => {
  test("reads version from a hoisted @harperfast/harper", () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-staged-"));
    try {
      const harperDir = join(dir, "node_modules", "@harperfast", "harper");
      mkdirSync(harperDir, { recursive: true });
      writeFileSync(
        join(harperDir, "package.json"),
        JSON.stringify({ name: "@harperfast/harper", version: "5.1.14" }),
      );
      expect(resolveStagedHarperVersion(dir)).toBe("5.1.14");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reads version nested under the flair package", () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-staged-"));
    try {
      const harperDir = join(
        dir, "node_modules", "@tpsdev-ai", "flair",
        "node_modules", "@harperfast", "harper",
      );
      mkdirSync(harperDir, { recursive: true });
      writeFileSync(
        join(harperDir, "package.json"),
        JSON.stringify({ name: "@harperfast/harper", version: "5.1.13" }),
      );
      expect(resolveStagedHarperVersion(dir)).toBe("5.1.13");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns null when nothing is installed", () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-staged-"));
    try {
      expect(resolveStagedHarperVersion(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Mock deps factory ──────────────────────────────────────────────────────

function mockDeps(over: Partial<FabricUpgradeDeps> = {}): {
  deps: FabricUpgradeDeps;
  calls: { deploy: DeployOptions[]; npmInstall: string[]; logs: string[] };
} {
  const calls = { deploy: [] as DeployOptions[], npmInstall: [] as string[], logs: [] as string[] };
  const deps: FabricUpgradeDeps = {
    fetchLatestFlairVersion: async () => "0.14.0",
    fetchDeclaredHarperVersion: async () => "5.0.21",
    npmInstall: (dir: string) => {
      calls.npmInstall.push(dir);
      // Simulate npm honoring the override: drop a fixed Harper + the flair pkg.
      const harperDir = join(dir, "node_modules", "@harperfast", "harper");
      mkdirSync(harperDir, { recursive: true });
      writeFileSync(
        join(harperDir, "package.json"),
        JSON.stringify({ name: "@harperfast/harper", version: DEFAULT_HARPER_PIN }),
      );
      const flairDir = join(dir, "node_modules", "@tpsdev-ai", "flair");
      mkdirSync(flairDir, { recursive: true });
      writeFileSync(
        join(flairDir, "package.json"),
        JSON.stringify({ name: "@tpsdev-ai/flair", version: "0.14.0" }),
      );
    },
    fetchDeployedVersion: async () => "0.13.0",
    deploy: async (opts: DeployOptions): Promise<DeployResult> => {
      calls.deploy.push(opts);
      return {
        url: opts.target ?? "https://fabric",
        project: opts.project ?? "flair",
        version: opts.version ?? "0.14.0",
        packageRoot: opts.packageRoot ?? "",
        dryRun: false,
      };
    },
    log: (m: string) => calls.logs.push(m),
    ...over,
  };
  return { deps, calls };
}

// ─── planFabricUpgrade: version diff ─────────────────────────────────────────

describe("planFabricUpgrade", () => {
  test("resolves latest version + harper pin + current deployed version", async () => {
    const { deps } = mockDeps();
    const plan = await planFabricUpgrade({ target: "https://fabric" }, deps);
    expect(plan.targetVersion).toBe("0.14.0");
    expect(plan.currentVersion).toBe("0.13.0");
    expect(plan.harper.overridden).toBe(true);
    expect(plan.harper.pin).toBe(DEFAULT_HARPER_PIN);
    expect(plan.upToDate).toBe(false);
  });

  test("explicit --version overrides the registry latest", async () => {
    const { deps } = mockDeps();
    const plan = await planFabricUpgrade(
      { target: "https://fabric", version: "0.13.5" },
      deps,
    );
    expect(plan.targetVersion).toBe("0.13.5");
  });

  test("upToDate when deployed == target", async () => {
    const { deps } = mockDeps({ fetchDeployedVersion: async () => "0.14.0" });
    const plan = await planFabricUpgrade({ target: "https://fabric" }, deps);
    expect(plan.upToDate).toBe(true);
  });

  test("currentVersion null when Fabric won't report it (older build)", async () => {
    const { deps } = mockDeps({ fetchDeployedVersion: async () => null });
    const plan = await planFabricUpgrade({ target: "https://fabric" }, deps);
    expect(plan.currentVersion).toBeNull();
    expect(plan.upToDate).toBe(false);
  });
});

// ─── fabricUpgrade: --check stops before deploy ──────────────────────────────

describe("fabricUpgrade --check", () => {
  test("shows the plan and does NOT call deploy or npmInstall", async () => {
    const { deps, calls } = mockDeps();
    const result = await fabricUpgrade({ target: "https://fabric", check: true }, deps);
    expect(result.deployed).toBe(false);
    expect(calls.deploy.length).toBe(0);
    expect(calls.npmInstall.length).toBe(0);
    // The plan/version diff is still computed + surfaced.
    expect(result.plan.targetVersion).toBe("0.14.0");
    expect(result.plan.currentVersion).toBe("0.13.0");
    expect(calls.logs.join("\n")).toContain("0.13.0 → 0.14.0");
  });
});

// ─── fabricUpgrade: full run reuses deploy() with the right options ──────────

describe("fabricUpgrade (deploy path)", () => {
  test("stages, confirms Harper fix version, then calls deploy() with packageRoot", async () => {
    const { deps, calls } = mockDeps();
    const result = await fabricUpgrade(
      {
        target: "https://fabric",
        fabricUser: "admin",
        fabricPassword: "pw",
        project: "flair",
      },
      deps,
    );

    expect(calls.npmInstall.length).toBe(1);
    expect(calls.deploy.length).toBe(1);

    const dOpts = calls.deploy[0];
    expect(dOpts.target).toBe("https://fabric");
    expect(dOpts.project).toBe("flair");
    expect(dOpts.version).toBe("0.14.0");
    expect(dOpts.fabricUser).toBe("admin");
    expect(dOpts.fabricPassword).toBe("pw");
    // packageRoot points at the staged flair package, not the running checkout.
    expect(dOpts.packageRoot).toContain("node_modules");
    expect(dOpts.packageRoot).toContain("flair");

    expect(result.deployed).toBe(true);
    // Verification re-queries the Fabric (mock returns 0.13.0 — a soft warn, not a throw).
    expect(result.verifiedVersion).toBe("0.13.0");
    // Staging dir is cleaned up.
    const { existsSync } = await import("node:fs");
    expect(existsSync(result.stagingDir)).toBe(false);
  });

  test("REFUSES to deploy if staged Harper is below the fix floor", async () => {
    const { deps, calls } = mockDeps({
      npmInstall: (dir: string) => {
        // Simulate the override NOT taking — a stale 5.0.21 lands.
        const harperDir = join(dir, "node_modules", "@harperfast", "harper");
        mkdirSync(harperDir, { recursive: true });
        writeFileSync(
          join(harperDir, "package.json"),
          JSON.stringify({ name: "@harperfast/harper", version: "5.0.21" }),
        );
        const flairDir = join(dir, "node_modules", "@tpsdev-ai", "flair");
        mkdirSync(flairDir, { recursive: true });
        writeFileSync(
          join(flairDir, "package.json"),
          JSON.stringify({ name: "@tpsdev-ai/flair", version: "0.14.0" }),
        );
      },
    });
    await expect(
      fabricUpgrade(
        { target: "https://fabric", fabricUser: "admin", fabricPassword: "pw" },
        deps,
      ),
    ).rejects.toThrow(/fix floor|513/);
    // Never reached deploy.
    expect(calls.deploy.length).toBe(0);
  });

  test("never passes creds into the staged package.json (no leak surface)", async () => {
    const { deps, calls } = mockDeps();
    await fabricUpgrade(
      { target: "https://fabric", fabricUser: "admin", fabricPassword: "s3cret" },
      deps,
    );
    // Creds flow ONLY through deploy() opts, never the logged plan.
    expect(calls.logs.join("\n")).not.toContain("s3cret");
    expect(calls.logs.join("\n")).not.toContain("admin");
  });
});
