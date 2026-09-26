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
