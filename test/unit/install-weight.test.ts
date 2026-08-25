/**
 * flair#1004 — a global install's weight must be able to fail a gate.
 *
 * The original defect was not a wrong number. It was that nothing asserted a
 * number at all: typecheck, lint, unit tests, integration tests and the
 * install-from-tarball smoke all passed on a 462 MB / 513-package tree.
 * A tarball-size check would have passed too (the tarball is ~3 MB).
 *
 * These tests are the ways the gate has to be able to go red — including the
 * skip that used to look like a pass.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — plain .mjs helper, no type declarations by design.
import {
  EXIT_DID_NOT_RUN,
  EXIT_OK,
  EXIT_OVER,
  diffEntries,
  evaluateWeight,
  formatDeltaBytes,
  formatReport,
  loadBudget,
  measureInstalledTree,
} from "../../scripts/check-install-weight.mjs";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "check-install-weight.mjs");
const BUDGET_PATH = join(REPO_ROOT, ".github", "install-weight-budget.json");
const TEST_YML = readFileSync(join(REPO_ROOT, ".github", "workflows", "test.yml"), "utf8");

const created: string[] = [];
function scratch(prefix = "flair-install-weight-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

function writeTree(spec: Record<string, { version?: string; bytes: number }>): string {
  const root = join(scratch(), "node_modules");
  mkdirSync(root, { recursive: true });
  for (const [name, { version = "1.0.0", bytes }] of Object.entries(spec)) {
    const dir = name.startsWith("@") ? join(root, name) : join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }) + "\n");
    writeFileSync(join(dir, "payload.bin"), Buffer.alloc(bytes));
  }
  return root;
}

function writeBudgetFile(budget: {
  maxBytes: number;
  maxPackages: number;
  baseline?: { bytes?: number; packages?: number; entries?: Record<string, number> };
}): string {
  const dir = scratch();
  const path = join(dir, "budget.json");
  writeFileSync(path, JSON.stringify(budget) + "\n");
  return path;
}

function runGate(args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("measureInstalledTree", () => {
  test("sums apparent bytes and counts installed packages, not nested package.json files", () => {
    const tree = writeTree({
      harper: { bytes: 1000 },
      "left-pad": { bytes: 40 },
    });
    mkdirSync(join(tree, "harper", "examples"), { recursive: true });
    writeFileSync(join(tree, "harper", "examples", "package.json"), '{"name":"not-an-install"}\n');
    const m = measureInstalledTree(tree);
    expect(m.didNotRun).toBe(false);
    expect(m.packages).toBe(2);
    expect(m.bytes).toBeGreaterThanOrEqual(1040);
    const names = m.entries.map((e: { name: string }) => e.name);
    expect(names).toContain("harper");
    expect(names).toContain("left-pad");
  });

  test("a missing tree is did-not-run, not a zero-weight pass", () => {
    const m = measureInstalledTree(join(scratch(), "no-such-node_modules"));
    expect(m.didNotRun).toBe(true);
    expect(m.reason).toMatch(/not found/);
  });

  test("an empty node_modules is did-not-run", () => {
    const empty = join(scratch(), "node_modules");
    mkdirSync(empty, { recursive: true });
    const m = measureInstalledTree(empty);
    expect(m.didNotRun).toBe(true);
    expect(m.reason).toMatch(/empty/);
  });
});

describe("evaluateWeight — the ways the gate goes red", () => {
  const budget = {
    ok: true,
    maxBytes: 400 * 1024 * 1024,
    maxPackages: 500,
    baseline: {
      bytes: 360 * 1024 * 1024,
      packages: 490,
      entries: { harper: 100 * 1024 * 1024 },
    },
  };

  test("the 0.32.0 462 MB / 513-package tree would have failed a 400 MB / 500 budget", () => {
    const measured = {
      didNotRun: false,
      bytes: Math.round(462 * 1000 * 1000),
      packages: 513,
      entries: [
        { name: "harper", bytes: 105.8 * 1024 * 1024 },
        { name: "hermes-compiler", bytes: 46.2 * 1024 * 1024 },
        { name: "react-native", bytes: 32.9 * 1024 * 1024 },
      ],
    };
    const result = evaluateWeight({ measured, budget });
    expect(result.status).toBe("over");
    expect(result.overBytes).toBe(true);
    expect(result.overPackages).toBe(true);
    const report = formatReport(result);
    expect(report).toContain("OVER BUDGET");
    expect(report).toMatch(/react-native/);
    expect(report).toMatch(/new/);
    expect(report).toMatch(/up /);
  });

  test("a tree under both ceilings passes", () => {
    const measured = {
      didNotRun: false,
      bytes: 200 * 1024 * 1024,
      packages: 400,
      entries: [{ name: "harper", bytes: 100 * 1024 * 1024 }],
    };
    expect(evaluateWeight({ measured, budget }).status).toBe("ok");
  });

  test("package-count overflow fails even when bytes fit", () => {
    const measured = {
      didNotRun: false,
      bytes: 100,
      packages: 501,
      entries: [{ name: "tiny", bytes: 100 }],
    };
    const result = evaluateWeight({ measured, budget });
    expect(result.status).toBe("over");
    expect(result.overPackages).toBe(true);
    expect(result.overBytes).toBe(false);
  });

  test("a missing measurement is did-not-run, not ok", () => {
    const result = evaluateWeight({
      measured: { didNotRun: true, reason: "npm install failed: ENOTFOUND" },
      budget,
    });
    expect(result.status).toBe("did-not-run");
    expect(formatReport(result)).toContain("DID NOT RUN");
    expect(formatReport(result)).toContain("ENOTFOUND");
  });

  test("a missing budget is did-not-run, not a free pass", () => {
    const result = evaluateWeight({
      measured: { didNotRun: false, bytes: 1, packages: 1, entries: [] },
      budget: { ok: false, reason: "budget file not found: x" },
    });
    expect(result.status).toBe("did-not-run");
  });
});

describe("diffEntries names the change", () => {
  test("a brand-new heavy package is the largest new entry", () => {
    const grown = diffEntries(
      [
        { name: "harper", bytes: 100 },
        { name: "foo", bytes: 38 * 1024 * 1024 },
      ],
      { harper: 100 },
    );
    expect(grown[0].name).toBe("foo");
    expect(grown[0].kind).toBe("new");
    expect(formatDeltaBytes(grown[0].delta)).toBe("up 38.0 MB");
  });

  test("growth of an existing package is reported as grew, not new", () => {
    const grown = diffEntries([{ name: "harper", bytes: 150 }], { harper: 100 });
    expect(grown[0]).toMatchObject({ name: "harper", kind: "grew", previous: 100, delta: 50 });
  });
});

describe("the process a human or CI step actually consumes", () => {
  test("over budget exits 1 and names the new entry plus the delta", () => {
    const tree = writeTree({
      harper: { bytes: 1000 },
      foo: { version: "1.2.3", bytes: 8000 },
    });
    const budget = writeBudgetFile({
      maxBytes: 2000,
      maxPackages: 10,
      baseline: { bytes: 1000, packages: 1, entries: { harper: 1000 } },
    });
    const res = runGate(["--tree", tree, "--budget", budget]);
    expect(res.status).toBe(EXIT_OVER);
    expect(res.out).toContain("OVER BUDGET");
    expect(res.out).toMatch(/foo/);
    expect(res.out).toMatch(/new/);
    expect(res.out).toMatch(/up /);
  });

  test("under budget exits 0", () => {
    const tree = writeTree({ harper: { bytes: 100 } });
    const budget = writeBudgetFile({
      maxBytes: 10_000,
      maxPackages: 10,
      baseline: { bytes: 100, packages: 1, entries: { harper: 100 } },
    });
    const res = runGate(["--tree", tree, "--budget", budget]);
    expect(res.status).toBe(EXIT_OK);
    expect(res.out).toContain("UNDER BUDGET");
  });

  test("a missing tree exits 2 (DID NOT RUN), never 0", () => {
    const budget = writeBudgetFile({ maxBytes: 10_000, maxPackages: 10 });
    const res = runGate(["--tree", join(scratch(), "missing"), "--budget", budget]);
    expect(res.status).toBe(EXIT_DID_NOT_RUN);
    expect(res.status).not.toBe(0);
    expect(res.out).toContain("DID NOT RUN");
  });

  test("a missing tarball exits 2 rather than treating 'nothing installed' as light", () => {
    const budget = writeBudgetFile({ maxBytes: 10_000, maxPackages: 10 });
    const res = runGate(["--tarball", join(scratch(), "no.tgz"), "--budget", budget]);
    expect(res.status).toBe(EXIT_DID_NOT_RUN);
    expect(res.out).toContain("DID NOT RUN");
    expect(res.out).toMatch(/tarball not found/);
  });

  test("no args is DID NOT RUN, not a silent pass", () => {
    const res = runGate([]);
    expect(res.status).toBe(EXIT_DID_NOT_RUN);
    expect(res.out).toMatch(/Usage:/);
  });
});

describe("the committed ratchet", () => {
  const budget = JSON.parse(readFileSync(BUDGET_PATH, "utf8"));
  const loaded = loadBudget(BUDGET_PATH);

  test("loads and is a ceiling above the recorded baseline, not an aspirational miss", () => {
    expect(loaded.ok).toBe(true);
    expect(loaded.maxBytes).toBeGreaterThan(loaded.baseline.bytes);
    expect(loaded.maxPackages).toBeGreaterThan(loaded.baseline.packages);
    // Headroom is "slightly above today", not a 2× wish. A 2× budget is how
    // the gate gets disabled without anyone saying so.
    expect(loaded.maxBytes).toBeLessThanOrEqual(loaded.baseline.bytes * 1.25);
    expect(loaded.maxPackages).toBeLessThanOrEqual(loaded.baseline.packages + 50);
  });

  test("records the heaviest known entries so a failure can name what grew", () => {
    expect(budget.baseline.entries.harper).toBeGreaterThan(100_000_000);
    expect(Object.keys(budget.baseline.entries).length).toBeGreaterThanOrEqual(3);
  });

  test("the 0.32.0 incident number still exceeds this ratchet", () => {
    // If someone "fixes" a red build by raising the budget past the number
    // this issue exists to catch, the ratchet has been disabled.
    expect(budget.maxBytes).toBeLessThan(462 * 1000 * 1000);
  });
});

describe("the CI job must remain able to fail", () => {
  const start = TEST_YML.indexOf("\n  install-weight:");
  expect(start).toBeGreaterThan(-1);
  const rest = TEST_YML.slice(start + 1);
  const next = rest.search(/\n  [a-z0-9-]+:/);
  const job = next === -1 ? rest : rest.slice(0, next);
  const directives = job
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

  test("invokes the gate script", () => {
    expect(directives).toContain("scripts/check-install-weight.mjs");
  });

  test("measures a tarball install or an installed tree, not the tarball file", () => {
    expect(directives).toMatch(/--tarball|--tree/);
    expect(job).toMatch(/installed tree|global install/i);
    expect(directives).not.toMatch(/stat .*tpsdev-ai-flair-.*\.tgz/);
  });

  test("has no continue-on-error and does not swallow the exit code", () => {
    expect(directives).not.toContain("continue-on-error");
    const gateLine = directives.split("\n").find((l) => l.includes("check-install-weight.mjs")) ?? "";
    expect(gateLine.length).toBeGreaterThan(0);
    expect(gateLine).not.toMatch(/\|\|\s*(true|echo|:)/);
  });

  test("is marked blocking, not advisory", () => {
    expect(job).toContain("BLOCKING");
    expect(job).not.toMatch(/PROMOTION CRITERION/);
  });
});

describe("cleanup", () => {
  test("removes fixtures", () => {
    for (const d of created) rmSync(d, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});
