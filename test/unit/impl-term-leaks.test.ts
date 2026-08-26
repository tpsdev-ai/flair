// Behaviour of scripts/check-impl-term-leaks.sh (flair#1381, flair#1420).
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
import { dirname, join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "check-impl-term-leaks.sh");

const ALLOWLISTED = ["ops-port", "ops-api", "ops-target", "ops-server"] as const;
// Verified to resolve to nothing in the internal tracker (flair#1420).
// Do not replace with a live bead ID — the repo is public.
const DEAD_BEAD_ID = "ops-0000";

const created: string[] = [];

function writeCorpus(dir: string, relPath: string, body: string) {
  const dest = join(dir, relPath);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, body);
}

function emptyCorpus(): string {
  const dir = mkdtempSync(join(tmpdir(), "flair-impl-term-leaks-"));
  created.push(dir);
  return dir;
}

function fixtureWith(files: Record<string, string>): string {
  const dir = emptyCorpus();
  mkdirSync(join(dir, "docs"), { recursive: true });
  mkdirSync(join(dir, "packages"), { recursive: true });
  for (const [relPath, body] of Object.entries(files)) {
    writeCorpus(dir, relPath, body);
  }
  return dir;
}

function fixture(body: string, filename = "integrations.md"): string {
  return fixtureWith({ [`docs/${filename}`]: body });
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
  test(`a bead-shaped ID (${DEAD_BEAD_ID}) in a docs file FAILS and names token + rule`, () => {
    const dir = fixture(`See the coordination note in ${DEAD_BEAD_ID} for the write surface.\n`);
    const res = runGate(dir);
    expect(res.status).not.toBe(0);
    expect(res.out).toContain(
      `docs/integrations.md:1: matched bead-ID pattern on token "${DEAD_BEAD_ID}"`,
    );
  });

  test("an allowlisted compound on the same line does not hide a bead-shaped ID", () => {
    const dir = fixture(`the ops-port trap is not ${DEAD_BEAD_ID}\n`);
    const res = runGate(dir);
    expect(res.status).not.toBe(0);
    expect(res.out).toContain(`matched bead-ID pattern on token "${DEAD_BEAD_ID}"`);
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

  test("a leading hyphen still excludes a non-allowlisted ops-* token", () => {
    // The fixture used to prove the guard must not itself be on the allowlist.
    // `--ops-target` would still exit 0 if the [^-a-z0-9] guard disappeared,
    // because ops-target is exempt. `--ops-0000` is a bead-ID shape:
    // bare it fails (test above); prefixed with `--` it passes only if the
    // preceding hyphen excludes it.
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).not.toMatch(/^ops-0000$/m);
    const dir = fixture("flair agent add --ops-0000 <ops-url>\n");
    const res = runGate(dir);
    expect(res.status).toBe(0);
    expect(res.out).toContain("No leaks found");
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

describe("impl-term-leak gate: CHANGELOG.md and .changelog/ are in scope (flair#1420)", () => {
  // Clean docs keep the corpus non-empty if the changelog paths are ignored.
  // Against current main (scan docs/ only) the leaky fragment is invisible, so
  // the gate exits 0 and this test is red. That is the powered check.
  const CLEAN_DOCS = "no implementation terms here\n";

  test("a non-allowlisted bead-shaped token in .changelog/unreleased/ FAILS", () => {
    const dir = fixtureWith({
      "docs/integrations.md": CLEAN_DOCS,
      ".changelog/unreleased/leaked-bead.md": `See ${DEAD_BEAD_ID} for the write surface.\n`,
    });
    const res = runGate(dir);
    expect(res.status).not.toBe(0);
    expect(res.out).toContain(
      `.changelog/unreleased/leaked-bead.md:1: matched bead-ID pattern on token "${DEAD_BEAD_ID}"`,
    );
  });

  test("a fragment with only allowlisted compounds PASSES", () => {
    const dir = fixtureWith({
      "docs/integrations.md": CLEAN_DOCS,
      ".changelog/unreleased/allowlisted.md":
        "ops-port, ops-api, ops-target, and ops-server are English compounds.\n",
    });
    const res = runGate(dir);
    expect(res.status).toBe(0);
    expect(res.out).toContain("No leaks found");
  });

  test("a non-allowlisted bead-shaped token in CHANGELOG.md FAILS", () => {
    const dir = fixtureWith({
      "docs/integrations.md": CLEAN_DOCS,
      "CHANGELOG.md": `## [Unreleased]\n\n- leaked ${DEAD_BEAD_ID} in the notes\n`,
    });
    const res = runGate(dir);
    expect(res.status).not.toBe(0);
    expect(res.out).toContain(
      `CHANGELOG.md:3: matched bead-ID pattern on token "${DEAD_BEAD_ID}"`,
    );
  });

  test("CHANGELOG.md with only allowlisted compounds PASSES", () => {
    const dir = fixtureWith({
      "docs/integrations.md": CLEAN_DOCS,
      "CHANGELOG.md":
        "## [Unreleased]\n\n- ops-port, ops-api, ops-target, and ops-server are English compounds.\n",
    });
    const res = runGate(dir);
    expect(res.status).toBe(0);
    expect(res.out).toContain("No leaks found");
  });

  test("an empty corpus still fails after the changelog paths were added", () => {
    const dir = emptyCorpus();
    const res = runGate(dir);
    expect(res.status).not.toBe(0);
    expect(res.out).toContain("found 0 files to search");
    expect(res.out).toContain("CHANGELOG.md and .changelog/");
  });
});
