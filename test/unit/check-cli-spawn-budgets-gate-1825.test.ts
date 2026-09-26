// check-cli-spawn-budgets-gate-1825.test.ts — GATE-LEVEL tests for flair#1825's
// round-2 fixes. Each drives the REAL gate (`runGate`) against a fixture git
// repo with a base commit and a PR commit, not a hand-built input array.
//
// RED before: the gate read the baseline from the PR's own tree (so the
// same-diff attack passed); a numeric budget was never checked, so `1` beside a
// `timeout: 30000` passed; and a whole template literal was masked, so a
// `Bun.spawn` inside `${…}` was invisible.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runGate,
  scanTree,
  SEED_INTRODUCTION_BASE,
  offenderKey,
  normalizeFingerprint,
  findSpawnCalls,
} from "../../scripts/ci/check-cli-spawn-budgets.mjs";

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8", env: GIT_ENV });
}

/** A temp git repo with a base commit of the given tree. */
function mkRepo(files: Record<string, string>): { dir: string; baseSha: string } {
  const dir = mkdtempSync(join(tmpdir(), "spawn-gate-1825-"));
  git(dir, ["init", "-q"]);
  writeTree(dir, files);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  return { dir, baseSha: git(dir, ["rev-parse", "HEAD"]).trim() };
}

function writeTree(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
}

/** A CLI-entry spawn offender (no timeout) plus its baselined entry. */
const CLI_SPAWN_CASE = `test("a CLI spawn", () => {\n  const p = Bun.spawn(["bun", "src/cli.ts", "status"], {});\n});\n`;

let repos: string[] = [];
beforeEach(() => {
  repos = [];
});
afterEach(() => {
  for (const d of repos.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

function mk(files: Record<string, string>): { dir: string; baseSha: string } {
  const r = mkRepo(files);
  repos.push(r.dir);
  return r;
}

describe("baseline comes from the trusted base ref (flair#1825 item 1)", () => {
  it("the same-diff attack FAILS: a new offender plus its own baseline entry", () => {
    // Base: an empty baseline.
    const { dir, baseSha } = mk({
      "scripts/ci/cli-spawn-budgets.baseline.json": "[]\n",
      "test/base.test.ts": `test("ok", () => {});\n`,
    });
    // PR: add an unbudgeted CLI spawn AND its entries to the PR's own copy.
    writeTree(dir, {
      "test/attack.test.ts": CLI_SPAWN_CASE,
      "scripts/ci/cli-spawn-budgets.baseline.json": JSON.stringify(
        [
          { file: "test/attack.test.ts", scope: "a CLI spawn", fingerprint: `["bun","src/cli.ts","status"] ; {}`, kind: "spawn-no-timeout", occurrence: 0, reason: "self-granted" },
          { file: "test/attack.test.ts", scope: "a CLI spawn", fingerprint: "a CLI spawn", kind: "case-no-budget", occurrence: 0, reason: "self-granted" },
        ],
        null,
        2,
      ) + "\n",
    });
    const r = runGate({ root: dir, baseRef: baseSha });
    expect(r.ok).toBe(false);
    // The PR's own entries are ADDED relative to the base → a failure.
    expect(r.added.length).toBeGreaterThan(0);
  });

  it("a PR that only REMOVES a now-budgeted entry PASSES", () => {
    const { dir, baseSha } = mk({
      "scripts/ci/cli-spawn-budgets.baseline.json": JSON.stringify(
        [{ file: "test/base.test.ts", scope: "budget me", fingerprint: `["bun","src/cli.ts","status"] ; {}`, kind: "spawn-no-timeout", occurrence: 0, reason: "r" }],
        null,
        2,
      ) + "\n",
      "test/base.test.ts": `test("budget me", () => {\n  const p = Bun.spawn(["bun", "src/cli.ts", "status"], {});\n});\n`,
    });
    // PR: budget the spawn + case and REMOVE the entry.
    writeTree(dir, {
      "test/base.test.ts": `test("budget me", () => {\n  const p = Bun.spawn(["bun", "src/cli.ts", "status"], { timeout: 30_000 });\n}, 40_000);\n`,
      "scripts/ci/cli-spawn-budgets.baseline.json": "[]\n",
    });
    const r = runGate({ root: dir, baseRef: baseSha });
    expect(r.ok).toBe(true);
  });

  it("an entry whose offender is gone goes STALE (the list can only shrink)", () => {
    const { dir, baseSha } = mk({
      "scripts/ci/cli-spawn-budgets.baseline.json": JSON.stringify(
        [{ file: "test/base.test.ts", scope: "gone", fingerprint: `["bun","src/cli.ts","status"] ; {}`, kind: "spawn-no-timeout", occurrence: 0, reason: "r" }],
        null,
        2,
      ) + "\n",
      "test/base.test.ts": `test("gone", () => {\n  const p = Bun.spawn(["bun", "src/cli.ts", "status"], {});\n});\n`,
    });
    // PR: remove the offender, keep the entry (it now offends nothing).
    writeTree(dir, { "test/base.test.ts": `test("gone", () => { expect(1).toBe(1); });\n` });
    const r = runGate({ root: dir, baseRef: baseSha });
    expect(r.ok).toBe(false);
    expect(r.staleEntries.length).toBe(1);
  });

  it("multiplicity: one entry covers one call — a second identical call is NEW", () => {
    const twoIdentical = `test("dup", () => {\n  const a = Bun.spawn(["bun", "src/cli.ts"], {});\n  const b = Bun.spawn(["bun", "src/cli.ts"], {});\n});\n`;
    const { dir, baseSha } = mk({
      "scripts/ci/cli-spawn-budgets.baseline.json": JSON.stringify(
        [
          { file: "test/dup.test.ts", scope: "dup", fingerprint: `["bun","src/cli.ts"] ; {}`, kind: "spawn-no-timeout", occurrence: 0, reason: "r" },
          { file: "test/dup.test.ts", scope: "dup", fingerprint: `["bun","src/cli.ts"] ; {}`, kind: "spawn-no-timeout", occurrence: 1, reason: "r" },
        ],
        null,
        2,
      ) + "\n",
      "test/dup.test.ts": twoIdentical,
    });
    // Base has TWO entries for TWO calls. Drop one entry in the PR copy: the
    // second call is then NEW (multiplicity), even though a call-shaped entry
    // still exists.
    writeTree(dir, {
      "scripts/ci/cli-spawn-budgets.baseline.json": JSON.stringify(
        [{ file: "test/dup.test.ts", scope: "dup", fingerprint: `["bun","src/cli.ts"] ; {}`, kind: "spawn-no-timeout", occurrence: 0, reason: "r" }],
        null,
        2,
      ) + "\n",
    });
    const r = runGate({ root: dir, baseRef: baseSha });
    expect(r.ok).toBe(false);
    expect(r.newOffenders.filter((o: any) => o.kind === "spawn-no-timeout").length).toBe(1);
  });
});

describe("budget, templates, keys, skips (flair#1825 items 2/3/4)", () => {
  function offendersFor(src: string) {
    const dir = mkdtempSync(join(tmpdir(), "spawn-scan-1825-"));
    repos.push(dir);
    writeTree(dir, { "test/x.test.ts": src });
    return scanTree(dir);
  }

  it("item 2: a numeric budget no larger than the waits FAILS, naming the sum", () => {
    const src = `test("small", () => {\n  const p = Bun.spawn(["bun", "src/cli.ts"], { timeout: 30_000 });\n}, 1);\n`;
    const { caseOffenders } = offendersFor(src);
    const small = caseOffenders.find((o: any) => o.kind === "case-budget-too-small");
    expect(small).toBeDefined();
    expect(String(small!.detail)).toContain("30000");
  });

  it("item 2: an unbounded fetch inside a budgeted case FAILS, naming the call", () => {
    const src = `test("f", async () => {\n  const p = Bun.spawn(["bun", "src/cli.ts"], { timeout: 5_000 });\n  await fetch("http://127.0.0.1:9/");\n}, 30_000);\n`;
    const { caseOffenders } = offendersFor(src);
    const bad = caseOffenders.find((o: any) => o.kind === "case-unbounded-fetch");
    expect(bad).toBeDefined();
    expect(String(bad!.detail)).toContain("fetch");
  });

  it("item 3: a Bun.spawn inside a template ${…} expression IS flagged; in a plain string or regex it is NOT", () => {
    const inTemplate = findSpawnCalls("const s = `x ${Bun.spawn([\"bun\", \"src/cli.ts\"], {})} y`;").calls;
    expect(inTemplate.some((c: any) => c.isCliEntry)).toBe(true);
    const inString = findSpawnCalls('const s = "Bun.spawn([\\"bun\\", \\"src/cli.ts\\"], {})";').calls;
    expect(inString.length).toBe(0);
    const inRegex = findSpawnCalls("const r = /Bun.spawn\\([a-z]\\)/;").calls;
    expect(inRegex.length).toBe(0);
  });

  it("item 4a: the argv-array fingerprint is whitespace-insensitive", () => {
    const a = findSpawnCalls('Bun.spawn(["bun", "src/cli.ts"], {});').calls[0];
    const b = findSpawnCalls('Bun.spawn(["bun","src/cli.ts"], {});').calls[0];
    expect(normalizeFingerprint(a.text)).toBe(normalizeFingerprint(b.text));
  });

  it("item 4c: no file-level disable comment suppresses a real offender", () => {
    // The gate has no whole-file skip syntax; a comment that looks like one is ignored.
    const src = `// cli-spawn-budgets: disable-file\n// eslint-disable cli-spawn-budgets\ntest("still seen", () => {\n  const p = Bun.spawn(["bun", "src/cli.ts"], {});\n});\n`;
    const { spawnOffenders } = offendersFor(src);
    expect(spawnOffenders.length).toBe(1);
  });

  it("offenderKey is never a file:line", () => {
    const o = { file: "test/x.test.ts", scope: "s", fingerprint: normalizeFingerprint('["bun","src/cli.ts"]'), kind: "spawn-no-timeout", occurrence: 0 };
    expect(offenderKey(o)).not.toMatch(/\.ts:\d/);
  });
});
describe("anchored seed (descendant predicate) + fail-closed base (flair#1825 round 5)", () => {
  function offendersFor(src: string) {
    const dir = mkdtempSync(join(tmpdir(), "spawn-scan-r5-"));
    repos.push(dir);
    writeTree(dir, { "test/x.test.ts": src });
    return scanTree(dir);
  }
  function commit(dir: string, msg: string): string {
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", msg]);
    return git(dir, ["rev-parse", "HEAD"]).trim();
  }

  it("the anchor is on origin/main's history and this branch descends from it", () => {
    // Robust to main moving: the anchor must be an ancestor of BOTH origin/main
    // and HEAD (execFileSync throws on a non-zero exit).
    const root = join(import.meta.dirname, "..", "..");
    for (const target of ["origin/main", "HEAD"]) {
      execFileSync("git", ["merge-base", "--is-ancestor", SEED_INTRODUCTION_BASE, target], { cwd: root, encoding: "utf8" });
    }
  });

  it("item 1a: base DESCENDS from the anchor with no file → PASS (the CI case)", () => {
    const { dir, baseSha } = mk({ "test/base.test.ts": `test("ok", () => {});\n` });
    writeTree(dir, { "test/x2.test.ts": `test("ok2", () => {});\n` });
    const b2 = commit(dir, "B2");
    writeTree(dir, { "scripts/ci/cli-spawn-budgets.baseline.json": "[]\n" });
    const r = runGate({ root: dir, baseRef: b2, env: {}, seedBase: baseSha });
    expect(r.anchored).toBe(true);
    expect(r.ok).toBe(true);
  });

  it("item 1b: base == the anchor with no file → PASS", () => {
    const { dir, baseSha } = mk({ "test/base.test.ts": `test("ok", () => {});\n` });
    writeTree(dir, { "scripts/ci/cli-spawn-budgets.baseline.json": "[]\n" });
    const r = runGate({ root: dir, baseRef: baseSha, env: {}, seedBase: baseSha });
    expect(r.ok).toBe(true);
  });

  it("item 1c: an OLDER non-descendant base with no file → throws naming both shas", () => {
    const { dir, baseSha } = mk({ "test/base.test.ts": `test("ok", () => {});\n` }); // B1 = anchor
    writeTree(dir, { "test/x2.test.ts": `test("ok2", () => {});\n` });
    const b2 = commit(dir, "B2");
    writeTree(dir, { "scripts/ci/cli-spawn-budgets.baseline.json": "[]\n" });
    let err: any;
    try {
      runGate({ root: dir, baseRef: baseSha, env: {}, seedBase: b2 }); // anchor B2 (later), base B1 (earlier)
    } catch (e) {
      err = e;
    }
    expect(String(err?.message)).toMatch(/does not descend from the seed-introduction base/);
  });

  it("item 1d: the anchor missing from the local object store → hard failure naming it", () => {
    // base commit has NO baseline file (the seed path is attempted), and the PR copy does.
    const { dir, baseSha } = mk({ "test/base.test.ts": `test("ok", () => {});\n` });
    writeTree(dir, { "scripts/ci/cli-spawn-budgets.baseline.json": "[]\n" });
    let err: any;
    try {
      runGate({ root: dir, baseRef: baseSha, env: {}, seedBase: "1111111111111111111111111111111111111111" });
    } catch (e) {
      err = e;
    }
    expect(String(err?.message)).toMatch(/missing from the local object store/);
    expect(String(err?.message)).toContain("1111111111111111111111111111111111111111");
  });

  it("item 1e: base HAS the file → normal comparison, the anchor is irrelevant (dead code)", () => {
    const { dir, baseSha } = mk({ "scripts/ci/cli-spawn-budgets.baseline.json": "[]\n", "test/x.test.ts": `test("ok", () => {});\n` });
    const r = runGate({ root: dir, baseRef: baseSha, env: {}, seedBase: "0000000000000000000000000000000000000000" });
    expect(r.basePresent).toBe(true);
    expect(r.anchored).toBe(false);
    expect(r.ok).toBe(true);
  });

  it("item 1-invalid: an invalid base ref is a hard failure naming the ref", () => {
    const { dir } = mk({ "scripts/ci/cli-spawn-budgets.baseline.json": "[]\n", "test/x.test.ts": `test("ok", () => {});\n` });
    expect(() => runGate({ root: dir, baseRef: "definitely-not-a-ref", env: {} })).toThrow(/invalid base ref/);
  });

  it("item 3: a listed case that gains a SECOND unbudgeted CLI spawn is 1 NEW offender", () => {
    const base = `test("two", () => {\n  const a = Bun.spawn(["bun", "src/cli.ts", "status"], {});\n});\n`;
    const { dir, baseSha } = mk({
      "test/dup.test.ts": base,
      "scripts/ci/cli-spawn-budgets.baseline.json": JSON.stringify(
        [{ file: "test/dup.test.ts", scope: "two", fingerprint: `["bun","src/cli.ts","status"] ; {}`, kind: "case-no-budget", occurrence: 0, reason: "r" }],
        null, 2,
      ) + "\n",
    });
    writeTree(dir, {
      "test/dup.test.ts": `test("two", () => {\n  const a = Bun.spawn(["bun", "src/cli.ts", "status"], {});\n  const b = Bun.spawn(["bun", "src/cli.ts", "stop"], {});\n});\n`,
    });
    const r = runGate({ root: dir, baseRef: baseSha, env: {}, seedBase: baseSha });
    expect(r.ok).toBe(false);
    const newCase = r.newOffenders.filter((o: any) => o.kind === "case-no-budget");
    expect(newCase.length).toBe(1);
    expect(newCase[0].fingerprint).toBe(`["bun","src/cli.ts","stop"] ; {}`);
  });

  it("item 2: a wait held in a file-local helper the case CALLS counts toward the sum", () => {
    const src = `function runCli() {\n  return Bun.spawn(["bun", "src/cli.ts", "stop"], { timeout: 30_000 });\n}\ntest("uses helper", () => {\n  runCli();\n}, 1);\n`;
    const { caseOffenders } = offendersFor(src);
    const small = caseOffenders.find((o: any) => o.kind === "case-budget-too-small");
    expect(small).toBeDefined();
    expect(String(small!.detail)).toContain("30000");
  });

  it("item 4: a budgeted case with an unbounded REACHABLE fetch fails naming the call", () => {
    const src = `function helper() {\n  return Bun.spawn(["bun", "src/cli.ts"], { timeout: 5_000 });\n}\ntest("f", async () => {\n  helper();\n  await fetch("http://127.0.0.1:9/");\n}, 30_000);\n`;
    const { caseOffenders } = offendersFor(src);
    expect(caseOffenders.some((o: any) => o.kind === "case-unbounded-fetch")).toBe(true);
  });

  it("item 3(round3): fetch(..., { signal: undefined }) is unbounded", () => {
    const src = `test("f", async () => {\n  const p = Bun.spawn(["bun", "src/cli.ts"], { timeout: 5_000 });\n  await fetch("http://127.0.0.1:9/", { signal: undefined });\n}, 30_000);\n`;
    const { caseOffenders } = offendersFor(src);
    expect(caseOffenders.some((o: any) => o.kind === "case-unbounded-fetch")).toBe(true);
  });

  it("item 4(round3): fingerprint normalization is symmetric around argv commas", () => {
    const a = findSpawnCalls('Bun.spawn(["bun","src/cli.ts"], {});').calls[0];
    const b = findSpawnCalls('Bun.spawn(["bun" ,"src/cli.ts"], {});').calls[0];
    expect(normalizeFingerprint(a.text)).toBe(normalizeFingerprint(b.text));
  });
});

describe("wait bounds: false acceptances in the budgeted-case arm (flair#1825 round 6)", () => {
  function offendersFor(src: string) {
    const dir = mkdtempSync(join(tmpdir(), "spawn-scan-r6-"));
    repos.push(dir);
    writeTree(dir, { "test/x.test.ts": src });
    return scanTree(dir);
  }

  it("(a) fetch(..., { signal: new AbortController().signal }) is UNBOUNDED (only a real deadline bounds)", () => {
    // Gauge's probe: any signal that is not AbortSignal.timeout(<posint>) is unknown.
    const src = `test("a", async () => {\n  const p = Bun.spawn(["bun", "src/cli.ts", "status"], { timeout: 5_000 });\n  await fetch("http://127.0.0.1:9/x", { signal: new AbortController().signal });\n}, 60_000);\n`;
    const { caseOffenders } = offendersFor(src);
    expect(caseOffenders.some((o: any) => o.kind === "case-unbounded-fetch")).toBe(true);
  });

  it("(a') fetch(..., { signal: AbortSignal.timeout(5_000) }) IS bounded (no offender)", () => {
    const src = `test("a2", async () => {\n  const p = Bun.spawn(["bun", "src/cli.ts", "status"], { timeout: 5_000 });\n  await fetch("http://127.0.0.1:9/x", { signal: AbortSignal.timeout(5_000) });\n}, 60_000);\n`;
    const { caseOffenders } = offendersFor(src);
    expect(caseOffenders.some((o: any) => o.kind === "case-unbounded-fetch")).toBe(false);
  });

  it("(b) a LATER AbortSignal.timeout does not bound an earlier unbounded fetch (no proximity)", () => {
    const src = `test("b", async () => {\n  const p = Bun.spawn(["bun", "src/cli.ts", "status"], { timeout: 5_000 });\n  await fetch("http://127.0.0.1:9/x");\n  const t = AbortSignal.timeout(1_000);\n}, 60_000);\n`;
    const { caseOffenders } = offendersFor(src);
    expect(caseOffenders.some((o: any) => o.kind === "case-unbounded-fetch")).toBe(true);
  });

  it("(c) a WAIT-ONLY helper the case reaches contributes its deadline (spawn or not)", () => {
    const src = `async function waitABit() {\n  await new Promise((r) => setTimeout(r, 10));\n  const t = AbortSignal.timeout(30_000);\n}\ntest("c", async () => {\n  await waitABit();\n  const p = Bun.spawn(["bun", "src/cli.ts", "status"], { timeout: 5_000 });\n}, 30_000);\n`;
    const { caseOffenders } = offendersFor(src);
    // budget 30_000 <= sum of waits 5_000 (spawn) + 30_000 (helper) = 35_000.
    expect(caseOffenders.some((o: any) => o.kind === "case-budget-too-small")).toBe(true);
  });

  it("(d1) `timeout: 1e999` is NOT a positive literal → the spawn is UNBOUNDED", () => {
    const src = `test("d1", () => {\n  const p = Bun.spawn(["bun", "src/cli.ts", "status"], { timeout: 1e999 });\n});\n`;
    const { spawnOffenders } = offendersFor(src);
    expect(spawnOffenders.some((o: any) => o.kind === "spawn-no-timeout")).toBe(true);
  });

  it("(d2) `timeout: 10000-10000` (trailing operator) is NOT a positive literal → UNBOUNDED", () => {
    const src = `test("d2", () => {\n  const p = Bun.spawn(["bun", "src/cli.ts", "status"], { timeout: 10000-10000 });\n});\n`;
    const { spawnOffenders } = offendersFor(src);
    expect(spawnOffenders.some((o: any) => o.kind === "spawn-no-timeout")).toBe(true);
  });
});
