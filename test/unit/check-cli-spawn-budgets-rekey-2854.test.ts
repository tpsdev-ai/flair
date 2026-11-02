// check-cli-spawn-budgets-rekey-2854.test.ts — GATE-LEVEL tests for the
// re-key rule (flair#2854): `spawn-no-timeout`'s scope is derived attribution,
// so moving a call into the helper that performs it changes only the scope and
// must be reported as RE-KEYED rather than refused as ADDED-EX. Case-level
// kinds keep strict identity.
//
// Each test drives the real gate (`runGate`, and the CLI for the exit codes)
// against a fixture git repo with a base commit and a PR working tree.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runGate } from "../../scripts/ci/check-cli-spawn-budgets.mjs";

const GATE = join(import.meta.dir, "..", "..", "scripts", "ci", "check-cli-spawn-budgets.mjs");
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const FP = `process.execPath ["src/cli.ts","init"] ; { encoding: "utf8" }`;
const FP_STATUS = `process.execPath ["src/cli.ts","status"] ; { encoding: "utf8" }`;
const BASELINE = "scripts/ci/cli-spawn-budgets.baseline.json";

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8", env: GIT_ENV });
}

function writeTree(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
}

function mkRepo(files: Record<string, string>): { dir: string; baseSha: string } {
  const dir = mkdtempSync(join(tmpdir(), "spawn-rekey-2854-"));
  git(dir, ["init", "-q"]);
  writeTree(dir, files);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  return { dir, baseSha: git(dir, ["rev-parse", "HEAD"]).trim() };
}

/** `base` is the baseline committed at the base commit; `pr` is the working copy. */
function mk(baseline: unknown[], files: Record<string, string>): { dir: string; baseSha: string } {
  return mkRepo({
    [BASELINE]: JSON.stringify(baseline, null, 2) + "\n",
    ...files,
  });
}

function pr(dir: string, baseline: unknown[], files: Record<string, string>): void {
  writeTree(dir, { [BASELINE]: JSON.stringify(baseline, null, 2) + "\n", ...files });
}

function runCli(dir: string, baseSha: string): { status: number | null; stdout: string; stderr: string } {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CLI_SPAWN_BUDGETS_BASE_REF;
  delete env.CLI_SPAWN_BUDGET_BASE_REF;
  const r = spawnSync(process.execPath, [GATE, "--root", dir, "--base", baseSha], {
    cwd: join(import.meta.dir, "..", ".."),
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function entry(scope: string, kind: string, fingerprint = FP): Record<string, unknown> {
  return { file: "test/fixture.test.ts", scope, fingerprint, kind, occurrence: 0, reason: "r" };
}

let repos: string[] = [];
beforeEach(() => {
  repos = [];
});
afterEach(() => {
  for (const d of repos.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function repo(baseline: unknown[], files: Record<string, string>): { dir: string; baseSha: string } {
  const r = mk(baseline, files);
  repos.push(r.dir);
  return r;
}

const CASE_SCOPED_SPAWN = `import { spawnSync } from "node:child_process";
test("end to end: a value is set and read back", () => {
  spawnSync(process.execPath, ["src/cli.ts", "init"], { encoding: "utf8" });
}, 40_000);
`;

const HELPER_SPAWN = `import { spawnSync } from "node:child_process";
function runInit() {
  return spawnSync(process.execPath, ["src/cli.ts", "init"], { encoding: "utf8" });
}
test("end to end: a value is set and read back", () => {
  runInit();
}, 40_000);
`;

describe("re-key: a scope-only move of a spawn-no-timeout call (flair#2854)", () => {
  it("(a) a call moved from the case body into a helper is RE-KEYED and passes", () => {
    const oldScope = "end to end: a value is set and read back";
    const { dir, baseSha } = repo([entry(oldScope, "spawn-no-timeout")], {
      "test/fixture.test.ts": CASE_SCOPED_SPAWN,
    });
    pr(dir, [entry("runInit", "spawn-no-timeout")], {
      "test/fixture.test.ts": HELPER_SPAWN,
    });

    const r = runGate({ root: dir, baseRef: baseSha });
    expect(r.rekeyed.length).toBe(1);
    expect(r.rekeyed[0]?.from.scope).toBe(oldScope);
    expect(r.rekeyed[0]?.to.scope).toBe("runInit");
    expect(r.added.length).toBe(0);
    expect(r.staleEntries.length).toBe(0);
    expect(r.ok).toBe(true);

    const cli = runCli(dir, baseSha);
    expect(cli.status).toBe(0);
    expect(cli.stdout).toContain(`RE-KEYED test/fixture.test.ts  ${oldScope} -> runInit`);
    expect(cli.stdout).toContain("1 re-keyed");
  });

  it("(b) an added key with no matching removal is ADDED-EX and fails", () => {
    const { dir, baseSha } = repo([], { "test/fixture.test.ts": `test("nothing spawned", () => {});\n` });
    pr(dir, [entry("runInit", "spawn-no-timeout")], {
      "test/fixture.test.ts": `import { spawnSync } from "node:child_process";
test("a budgeted case", () => {
  spawnSync(process.execPath, ["src/cli.ts", "init"], { encoding: "utf8" });
}, 40_000);
`,
    });

    const r = runGate({ root: dir, baseRef: baseSha });
    expect(r.added.length).toBe(1);
    expect(r.rekeyed.length).toBe(0);
    expect(r.ok).toBe(false);

    const cli = runCli(dir, baseSha);
    expect(cli.status).toBe(1);
    expect(cli.stdout).toContain("ADDED-EX");
    expect(cli.stdout).toContain("1 added-exception");
  });

  it("(c) a scope move whose fingerprint differs is ADDED-EX", () => {
    const oldScope = "end to end: a value is set and read back";
    const { dir, baseSha } = repo([entry(oldScope, "spawn-no-timeout")], { "test/fixture.test.ts": CASE_SCOPED_SPAWN });
    pr(dir, [entry("runInit", "spawn-no-timeout", FP_STATUS)], {
      "test/fixture.test.ts": `import { spawnSync } from "node:child_process";
function runInit() {
  return spawnSync(process.execPath, ["src/cli.ts", "status"], { encoding: "utf8" });
}
test("end to end: a value is set and read back", () => {
  runInit();
}, 40_000);
`,
    });

    const r = runGate({ root: dir, baseRef: baseSha });
    expect(r.rekeyed.length).toBe(0);
    expect(r.added.length).toBe(1);
    expect(r.ok).toBe(false);
  });

  it("(d) two added keys against one removed key are one RE-KEYED and one ADDED-EX", () => {
    const caseScope = "two helpers";
    const { dir, baseSha } = repo([entry(caseScope, "spawn-no-timeout")], {
      "test/fixture.test.ts": `import { spawnSync } from "node:child_process";
test("two helpers", () => {
  spawnSync(process.execPath, ["src/cli.ts", "init"], { encoding: "utf8" });
}, 40_000);
`,
    });
    pr(
      dir,
      [entry("helperA", "spawn-no-timeout"), entry("helperB", "spawn-no-timeout")],
      {
        "test/fixture.test.ts": `import { spawnSync } from "node:child_process";
function helperA() {
  spawnSync(process.execPath, ["src/cli.ts", "init"], { encoding: "utf8" });
}
function helperB() {
  spawnSync(process.execPath, ["src/cli.ts", "init"], { encoding: "utf8" });
}
test("two helpers", () => {
  helperA();
  helperB();
}, 40_000);
`,
      },
    );

    const r = runGate({ root: dir, baseRef: baseSha });
    expect(r.rekeyed.length).toBe(1);
    expect(r.added.length).toBe(1);
    expect(r.added[0]?.scope).toBe("helperB");
    expect(r.ok).toBe(false);

    const cli = runCli(dir, baseSha);
    expect(cli.status).toBe(1);
    expect(cli.stdout).toContain("1 added-exception, 1 re-keyed");
  });

  it("(e) a case-no-budget scope change is ADDED-EX, never a re-key", () => {
    const oldName = "the old case name";
    const { dir, baseSha } = repo([entry(oldName, "case-no-budget")], {
      "test/fixture.test.ts": `import { spawnSync } from "node:child_process";
test("the old case name", () => {
  spawnSync(process.execPath, ["src/cli.ts", "init"], { encoding: "utf8", timeout: 20_000 });
});
`,
    });
    pr(dir, [entry("the new case name", "case-no-budget")], {
      "test/fixture.test.ts": `import { spawnSync } from "node:child_process";
test("the new case name", () => {
  spawnSync(process.execPath, ["src/cli.ts", "init"], { encoding: "utf8", timeout: 20_000 });
});
`,
    });

    const r = runGate({ root: dir, baseRef: baseSha });
    expect(r.rekeyed.length).toBe(0);
    expect(r.added.length).toBe(1);
    expect(r.added[0]?.kind).toBe("case-no-budget");
    expect(r.ok).toBe(false);
  });
});
