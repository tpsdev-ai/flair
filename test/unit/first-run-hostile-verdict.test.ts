// first-run-hostile two-way xfail (flair#1462).
//
// The detector still prints FAIL (#NNNN) and exits non-zero while known
// first-run defects fire. The lane verdict is no longer that exit code — it
// is observed markers == docker/first-run-hostile.expected.json. These tests
// drive the real judge (and the CLI) against fixture logs so a count-only
// comparison cannot sneak back in: one defect fixed and one new one
// introduced must not cancel out.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  judge,
  loadExpected,
  main,
  observedFailIssues,
} from "../../scripts/ci/first-run-hostile-verdict.mjs";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "ci", "first-run-hostile-verdict.mjs");
const COMMITTED = join(REPO_ROOT, "docker", "first-run-hostile.expected.json");

/** Detector output from current main (CI run 33273121183 on 23445893). */
const CURRENT_MAIN_LOG = `
── #1459: follow README.md to first working command ──
  ✓ 'flair: command not found' — the trap the README now documents
  PASS: README remedy works — flair is on PATH (#1459 fixed)

── #1454: daemon lifecycle (init → start → stop → status) ──
  FAIL (#1454): flair stop said 'not running' while the daemon is alive — lsof absent

==============================================
RED: 1 first-run defect(s) still present.
  #1459: flair off PATH (npm prefix off PATH)
  #1454: flair stop cannot find the daemon without lsof
==============================================
`;

const BOTH_FAIL_LOG = `
  FAIL (#1459): README remedy did not put flair on PATH
  FAIL (#1454): flair stop said 'not running' while the daemon is alive — lsof absent
`;

const CLEAN_LOG = `
  PASS: README remedy works — flair is on PATH (#1459 fixed)
  PASS: flair stop actually stopped the daemon (#1454 fixed)
GREEN: both #1459 and #1454 are fixed.
`;

function expectedFile(entries: { issue: number; marker: string }[]) {
  return JSON.stringify({ expected: entries });
}

function bothEntries() {
  return [
    { issue: 1454, marker: "FAIL (#1454)" },
    { issue: 1459, marker: "FAIL (#1459)" },
  ];
}

function only1454() {
  return [{ issue: 1454, marker: "FAIL (#1454)" }];
}

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "flair-hostile-xfail-"));
}

function runCli(args: string[], files: Record<string, string> = {}) {
  const dir = tmpDir();
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
  const resolved = args.map((a) => (a.startsWith("-") ? a : join(dir, a)));
  return spawnSync("node", [SCRIPT, ...resolved], { encoding: "utf8" });
}

describe("loadExpected", () => {
  test("accepts the committed file", () => {
    const entries = loadExpected(readFileSync(COMMITTED, "utf8"), COMMITTED);
    expect(entries).toEqual(only1454());
  });

  test("refuses a marker that does not name its issue", () => {
    expect(() =>
      loadExpected(expectedFile([{ issue: 1454, marker: "FAIL (#1459)" }])),
    ).toThrow(/does not name issue #1454/);
  });

  test("refuses duplicate issues (count-only inventory)", () => {
    expect(() =>
      loadExpected(
        expectedFile([
          { issue: 1454, marker: "FAIL (#1454)" },
          { issue: 1454, marker: "FAIL (#1454) again" },
        ]),
      ),
    ).toThrow(/duplicate expected issue #1454/);
  });

  test("an empty expected array is valid (lane actually green of defects)", () => {
    expect(loadExpected(expectedFile([]))).toEqual([]);
  });
});

describe("observedFailIssues — per-issue, not a count", () => {
  test("current main's footer listing #1459 is not a FAIL marker", () => {
    expect(observedFailIssues(CURRENT_MAIN_LOG)).toEqual([1454]);
  });

  test("two FAIL markers are two issues, not a count of 2", () => {
    expect(observedFailIssues(BOTH_FAIL_LOG)).toEqual([1454, 1459]);
  });
});

describe("judge — negative: current main matches the committed file", () => {
  test("FAIL (#1454) only + committed inventory is GREEN and names the known defect", () => {
    const expected = loadExpected(readFileSync(COMMITTED, "utf8"));
    const v = judge({ expected, log: CURRENT_MAIN_LOG, containerStatus: 1 });
    expect(v.ok).toBe(true);
    expect(v.known).toEqual([1454]);
    expect(v.missing).toEqual([]);
    expect(v.unexpected).toEqual([]);
    expect(v.abort).toBe(false);
    expect(v.summary).toContain("GREEN: 1 known first-run defect present: #1454");
  });
});

describe("judge — powered: drop an expected entry or inject an unmarked failure", () => {
  test("dropping #1454 from the file against current main is RED and names unexpected #1454", () => {
    const v = judge({ expected: [], log: CURRENT_MAIN_LOG, containerStatus: 1 });
    expect(v.ok).toBe(false);
    expect(v.unexpected).toEqual([1454]);
    expect(v.summary).toContain("unexpected (not in expected-failures file): #1454");
  });

  test("listing #1459 when it does not fire is RED and names missing #1459", () => {
    const v = judge({
      expected: loadExpected(expectedFile(bothEntries())),
      log: CURRENT_MAIN_LOG,
      containerStatus: 1,
    });
    expect(v.ok).toBe(false);
    expect(v.known).toEqual([1454]);
    expect(v.missing).toEqual([1459]);
    expect(v.unexpected).toEqual([]);
    expect(v.summary).toContain("missing (xfail passed or check went blind): #1459");
  });

  test("an unmarked FAIL (no issue number) is RED and quotes the line", () => {
    const v = judge({
      expected: only1454(),
      log: `${CURRENT_MAIN_LOG}\n  FAIL: daemon hung during init\n`,
      containerStatus: 1,
    });
    expect(v.ok).toBe(false);
    expect(v.unmarked.some((l) => l.includes("daemon hung"))).toBe(true);
    expect(v.summary).toContain("unmarked FAIL");
    expect(v.summary).toContain("daemon hung during init");
  });
});

describe("judge — one fixed + one new must not cancel", () => {
  test("expected #1454, observed #1459 only is RED on both sides", () => {
    const v = judge({
      expected: only1454(),
      log: "  FAIL (#1459): README remedy did not put flair on PATH\n",
      containerStatus: 1,
    });
    expect(v.ok).toBe(false);
    expect(v.missing).toEqual([1454]);
    expect(v.unexpected).toEqual([1459]);
    expect(v.summary).toContain("unexpected (not in expected-failures file): #1459");
    expect(v.summary).toContain("missing (xfail passed or check went blind): #1454");
  });

  test("both expected markers firing is GREEN and names both", () => {
    const v = judge({
      expected: loadExpected(expectedFile(bothEntries())),
      log: BOTH_FAIL_LOG,
      containerStatus: 1,
    });
    expect(v.ok).toBe(true);
    expect(v.known).toEqual([1454, 1459]);
    expect(v.summary).toContain("GREEN: 2 known first-run defects present: #1454, #1459");
  });
});

describe("judge — xfail that unexpectedly passes is an ERROR", () => {
  test("expected #1454, clean detector log, container exit 0 is RED missing #1454", () => {
    const v = judge({ expected: only1454(), log: CLEAN_LOG, containerStatus: 0 });
    expect(v.ok).toBe(false);
    expect(v.missing).toEqual([1454]);
    expect(v.abort).toBe(false);
    expect(v.summary).toContain("missing (xfail passed or check went blind): #1454");
  });

  test("empty file + clean log + exit 0 is GREEN", () => {
    const v = judge({ expected: [], log: CLEAN_LOG, containerStatus: 0 });
    expect(v.ok).toBe(true);
    expect(v.summary).toContain("GREEN: no first-run defects");
  });
});

describe("judge — container abort is not a silent pass", () => {
  test("non-zero exit with no FAIL markers is RED abort", () => {
    const v = judge({
      expected: [],
      log: "ERROR: daemon not healthy (HTTP 000) — cannot test #1454.\n",
      containerStatus: 1,
    });
    expect(v.ok).toBe(false);
    expect(v.abort).toBe(true);
    expect(v.summary).toContain("abort: container exited non-zero with no FAIL");
  });

  test("non-zero exit that still printed the expected FAIL is not an abort", () => {
    const v = judge({
      expected: only1454(),
      log: CURRENT_MAIN_LOG,
      containerStatus: 1,
    });
    expect(v.abort).toBe(false);
    expect(v.ok).toBe(true);
  });
});

describe("CLI — the interface CI runs", () => {
  test("current-main fixture + committed-shaped file exits 0", () => {
    const r = runCli(["--expected", "expected.json", "--log", "log.txt", "--container-status", "1"], {
      "expected.json": expectedFile(only1454()),
      "log.txt": CURRENT_MAIN_LOG,
    });
    const out = `${r.stdout}${r.stderr}`;
    expect(r.status).toBe(0);
    expect(out).toContain("GREEN: 1 known first-run defect present: #1454");
  });

  test("dropping the expected entry exits 1 and names #1454", () => {
    const r = runCli(["--expected", "expected.json", "--log", "log.txt", "--container-status", "1"], {
      "expected.json": expectedFile([]),
      "log.txt": CURRENT_MAIN_LOG,
    });
    const out = `${r.stdout}${r.stderr}`;
    expect(r.status).toBe(1);
    expect(out).toContain("unexpected (not in expected-failures file): #1454");
  });

  test("broken expected file exits 2, not 0", () => {
    const r = runCli(["--expected", "expected.json", "--log", "log.txt"], {
      "expected.json": "{ not json",
      "log.txt": CURRENT_MAIN_LOG,
    });
    expect(r.status).toBe(2);
    expect(`${r.stdout}${r.stderr}`).toContain("invalid JSON");
  });

  test("main() reads --log - from stdin", () => {
    const dir = tmpDir();
    const expectedPath = join(dir, "expected.json");
    writeFileSync(expectedPath, expectedFile(only1454()));
    const chunks: string[] = [];
    const status = main(["--expected", expectedPath, "--log", "-", "--container-status", "1"], {
      readStdin: () => CURRENT_MAIN_LOG,
      write: (s) => {
        chunks.push(s);
      },
      writeErr: (s) => {
        chunks.push(s);
      },
    });
    expect(status).toBe(0);
    expect(chunks.join("")).toContain("GREEN: 1 known first-run defect present: #1454");
  });
});
