/**
 * deploy.test.ts — Unit tests for `flair deploy` pre-flight logic.
 *
 * Covers pure/extractable validation and resolution without making any
 * network calls to Harper Fabric.
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  validateOptions,
  buildTargetUrl,
  resolvePackageRoot,
  validatePackageLayout,
  deploy,
  REQUIRED_PACKAGE_FILES,
} from "../../src/deploy.js";

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
    // This test runs from inside the flair repo, so the resolved root
    // must be the repo itself.
    expect(root.endsWith("flair")).toBe(true);
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
  test("returns success without calling Harper", async () => {
    const result = await deploy({
      fabricOrg: "acme",
      fabricCluster: "prod",
      fabricUser: "admin",
      fabricPassword: "pw",
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.url).toBe("https://prod.acme.harperfabric.com");
    expect(result.project).toBe("flair");
    expect(result.version).toMatch(/^\d+\.\d+/);
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
