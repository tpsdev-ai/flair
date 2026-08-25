// darwin-gated-visibility.test.ts — flair#1012.
//
// Darwin-gated launchd tests failed on macOS and were invisible on Linux CI
// because `test.if(isDarwin)` made them structurally unreachable on the only
// platform CI runs. `release.sh` was the first (and last) gate, and it
// reported a bare "Tests failed".
//
// Two properties, both enforced here so the next occurrence cannot hide:
//
//   1. The snapshot-targeting tests assert WHICH INSTANCE launchctl named,
//      not which verb (`stop` vs `unload`). The original failure was a stale
//      `toContain(\`stop ${scratchLabel}\`)` after quiescing moved to
//      unload/load. A test that pins the verb would have failed then; a test
//      that pins the instance would have passed. This file fails if those
//      verb pins come back.
//   2. `scripts/check-darwin-gated-tests.mjs` inventories every darwin gate,
//      refuses `test.if` (omit) in favour of `test.skipIf` (reported skip),
//      and on Linux requires bun to report a skip per inventoried title.
//      An empty inventory, an omit-form gate, or a skip count of 0 is a
//      failure — "nothing at all" is what let #1012 sit.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "check-darwin-gated-tests.mjs");
const SNAPSHOT = join(
  REPO_ROOT,
  "test",
  "unit",
  "snapshot-datadir-instance-targeting.test.ts",
);

const ORIGINAL_TITLES = [
  "snapshot restore --data-dir <scratch> resolves the SCRATCH instance's launchd label, never the default install's",
  "snapshot create --data-dir <scratch> quiesces the SCRATCH instance around the snapshot",
];

function runGate(
  extraArgs: string[] = [],
  opts: { root?: string } = {},
): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [SCRIPT, ...extraArgs], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      DARWIN_GATE_ROOT: opts.root ?? REPO_ROOT,
      GITHUB_STEP_SUMMARY: "",
    },
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function fixture(contents: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "flair1012-"));
  for (const [rel, body] of Object.entries(contents)) {
    const path = join(dir, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
  }
  return dir;
}

describe("flair#1012 — snapshot targeting pins the instance, not the verb", () => {
  const src = readFileSync(SNAPSHOT, "utf8");

  test("expectLaunchctlNamedOnly is the assertion both darwin cases use", () => {
    expect(src).toContain("function expectLaunchctlNamedOnly");
    const uses = src.split("expectLaunchctlNamedOnly({ label: scratchLabel").length - 1;
    expect(uses).toBe(2);
  });

  test("the original verb pins that failed on macOS are gone", () => {
    // The #1012 failure, verbatim:
    //   expect(invocations).toContain(`stop ${scratchLabel}`);
    //   expect(invocations).toContain(`start ${scratchLabel}`);
    // Those pins broke when quiescing moved to unload/load and the targeting
    // they existed to protect was still holding. String scan, not regex —
    // the same discipline as the other tripwires.
    expect(src.includes("toContain(`stop ${scratchLabel}`)")).toBe(false);
    expect(src.includes("toContain(`start ${scratchLabel}`)")).toBe(false);
    expect(src.includes('toContain("stop ai.tpsdev.flair.')).toBe(false);
  });
});

describe("check-darwin-gated-tests.mjs inventory (real repo)", () => {
  const res = runGate(["--inventory-only", "--json"]);
  const body = (() => {
    try {
      return JSON.parse(res.out) as {
        ok: boolean;
        tests: Array<{ file: string; title: string; form: string }>;
      };
    } catch {
      return null;
    }
  })();

  test("exits 0", () => {
    expect(res.status).toBe(0);
    expect(body?.ok).toBe(true);
  });

  test("finds the two #1012 snapshot cases and reports them as skip-form", () => {
    expect(body).not.toBeNull();
    const titles = (body?.tests ?? []).map((t) => t.title);
    for (const title of ORIGINAL_TITLES) {
      expect(titles).toContain(title);
    }
    const snapshot = (body?.tests ?? []).filter((t) =>
      t.file.endsWith("snapshot-datadir-instance-targeting.test.ts"),
    );
    expect(snapshot.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.every((t) => t.form === "skip")).toBe(true);
  });

  test("inventory is non-empty and uses skipIf, not if", () => {
    expect((body?.tests ?? []).length).toBeGreaterThanOrEqual(9);
    expect((body?.tests ?? []).every((t) => t.form === "skip")).toBe(true);
    const files = new Set((body?.tests ?? []).map((t) => t.file));
    expect(files.has("test/unit/snapshot-datadir-instance-targeting.test.ts")).toBe(true);
    expect(files.has("test/unit/launchd-management-reporting.test.ts")).toBe(true);
    expect(files.has("test/unit/harper-config-port.test.ts")).toBe(true);
  });
});

describe("check-darwin-gated-tests.mjs refuses a silent omit", () => {
  test("test.if(isDarwin) fails the gate", () => {
    const dir = fixture({
      "test/unit/omit.test.ts": [
        `import { test, expect } from "bun:test";`,
        `const isDarwin = process.platform === "darwin";`,
        `test.if(isDarwin)("hidden darwin case", () => { expect(true).toBe(true); });`,
        `test("always", () => { expect(true).toBe(true); });`,
        "",
      ].join("\n"),
    });
    try {
      const res = runGate(["--inventory-only"], { root: dir });
      expect(res.status).not.toBe(0);
      expect(res.out).toContain("test.if");
      expect(res.out).toContain("hidden darwin case");
      expect(res.out).toContain("skipIf");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an empty test/ is a failure, not a clean scan", () => {
    const dir = fixture({ "test/.keep": "" });
    try {
      const res = runGate(["--inventory-only"], { root: dir });
      expect(res.status).not.toBe(0);
      expect(res.out).toContain("0 darwin-gated tests");
      expect(res.out).toContain("nothing was verified");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("check-darwin-gated-tests.mjs skip count on this platform", () => {
  test("skipIf is reported as skipped on linux (and the count is asserted)", () => {
    const dir = fixture({
      "test/unit/visible.test.ts": [
        `import { test, expect } from "bun:test";`,
        `const isDarwin = process.platform === "darwin";`,
        `test.skipIf(!isDarwin)("visible darwin case", () => { expect(true).toBe(true); });`,
        `test("always", () => { expect(true).toBe(true); });`,
        "",
      ].join("\n"),
    });
    try {
      const res = runGate([], { root: dir });
      if (process.platform === "darwin") {
        expect(res.status).toBe(0);
        expect(res.out).toContain("1 darwin-gated unit tests ran on darwin");
        expect(res.out).not.toContain("0 darwin tests ran on this platform");
      } else {
        expect(res.status).toBe(0);
        expect(res.out).toContain("1 darwin-gated unit tests skipped");
        expect(res.out).toContain("0 darwin tests ran on this platform");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
