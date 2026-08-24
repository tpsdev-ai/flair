// Behaviour of scripts/check-impl-term-leaks.sh (flair#1381).
//
// The gate exists to keep bead IDs and impl labels out of user-facing docs.
// Two defects landed together: English compounds such as "ops-port" were
// indistinguishable from a bead ID, and a failure printed the line without
// naming the token or the rule. These tests run the real script against a
// throwaway corpus — asserting on exit code and stdout, the two things CI
// and an author actually see.
//
// The mutation case is the load-bearing one: if the allowlist were a
// heuristic (or were empty and the gate just stopped matching ops-*), every
// happy-path test below would still pass.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "check-impl-term-leaks.sh");

const ALLOWLISTED = ["ops-port", "ops-api", "ops-target", "ops-server"] as const;
const REAL_BEAD_ID = "ops-xllz";

const created: string[] = [];

function fixture(body: string, filename = "integrations.md"): string {
  const dir = mkdtempSync(join(tmpdir(), "flair-impl-term-leaks-"));
  created.push(dir);
  mkdirSync(join(dir, "docs"), { recursive: true });
  mkdirSync(join(dir, "packages"), { recursive: true });
  writeFileSync(join(dir, "docs", filename), body);
  return dir;
}

function runGate(dir: string, scriptPath = SCRIPT) {
  const r = spawnSync("bash", [scriptPath], {
    cwd: dir,
    encoding: "utf8",
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

afterAll(() => {
  for (const d of created) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe("impl-term-leak gate: real bead IDs still fail (flair#1381)", () => {
  test(`a real bead ID (${REAL_BEAD_ID}) in a docs file FAILS and names token + rule`, () => {
    const dir = fixture(`See the coordination note in ${REAL_BEAD_ID} for the write surface.\n`);
    const res = runGate(dir);
    expect(res.status).not.toBe(0);
    expect(res.out).toContain(
      `docs/integrations.md:1: matched bead-ID pattern on token "${REAL_BEAD_ID}"`,
    );
  });

  test("an allowlisted compound on the same line does not hide a real bead ID", () => {
    const dir = fixture(`the ops-port trap is not ${REAL_BEAD_ID}\n`);
    const res = runGate(dir);
    expect(res.status).not.toBe(0);
    expect(res.out).toContain(`matched bead-ID pattern on token "${REAL_BEAD_ID}"`);
    expect(res.out).not.toContain('token "ops-port"');
  });
});

describe("impl-term-leak gate: exact-literal allowlist PASSES (flair#1381)", () => {
  for (const compound of ALLOWLISTED) {
    test(`${compound} in a docs file PASSES`, () => {
      const dir = fixture(`Configure the ${compound} before registering the agent.\n`);
      const res = runGate(dir);
      expect(res.status).toBe(0);
      expect(res.out).toContain("No leaks found");
    });
  }

  test("all four allowlisted compounds together PASS", () => {
    const dir = fixture(
      `ops-port, ops-api, ops-target, and ops-server are English compounds.\n`,
    );
    const res = runGate(dir);
    expect(res.status).toBe(0);
  });

  test("CLI flags with a leading hyphen still PASS (--ops-target)", () => {
    const dir = fixture("flair agent add --ops-target <ops-url> --admin-pass-file <path>\n");
    const res = runGate(dir);
    expect(res.status).toBe(0);
  });

  test("a near-miss compound that is not on the allowlist still FAILS", () => {
    // Proves the allowlist is exact literals, not a prefix or "looks like a word" heuristic.
    const dir = fixture("the ops-portal is not an allowlisted compound\n");
    const res = runGate(dir);
    expect(res.status).not.toBe(0);
    expect(res.out).toContain('matched bead-ID pattern on token "ops-portal"');
  });
});

describe("impl-term-leak gate: findings name the token and the rule (flair#1381)", () => {
  test("an impl-label hit names the impl-label rule and the token", () => {
    const dir = fixture("shipped in post-1.2 as an implementation label\n");
    const res = runGate(dir);
    expect(res.status).not.toBe(0);
    expect(res.out).toContain('docs/integrations.md:1: matched impl-label pattern on token "post-1.2"');
  });
});

describe("impl-term-leak gate: allowlist mutation restores the failure (flair#1381)", () => {
  test("removing ops-port from the allowlist makes that compound fail again", () => {
    const src = readFileSync(SCRIPT, "utf8");
    // The entry must sit on its own line so this replacement cannot silently
    // no-op against a comment or a regex. If the allowlist is rewritten as a
    // heuristic, this test goes red — which is the point.
    expect(src).toMatch(/^ops-port$/m);
    const mutated = src.replace(/^ops-port$/m, "");
    expect(mutated).not.toMatch(/^ops-port$/m);

    const dir = fixture("the ops-port trap\n");
    const mutatedScript = join(dir, "check-impl-term-leaks.sh");
    writeFileSync(mutatedScript, mutated, { mode: 0o755 });

    const before = runGate(dir, SCRIPT);
    expect(before.status).toBe(0);

    const after = runGate(dir, mutatedScript);
    expect(after.status).not.toBe(0);
    expect(after.out).toContain('matched bead-ID pattern on token "ops-port"');
  });
});
