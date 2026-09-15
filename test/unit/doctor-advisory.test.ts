/**
 * doctor-advisory.test.ts — flair#1686 / #1698 follow-on (flair#1701).
 *
 * `scripts/ci/check-instance-boot.sh` requires `flair doctor` to exit 0. On a
 * fresh loopback instance doctor can exit 1 for a conditional hint that is not
 * a defect (flair#1701), which made the boot contract unable to describe a
 * healthy 0.54.2 macOS instance. `scripts/ci/doctor-advisory.sh` is the one
 * place that decides whether a non-zero doctor exit is advisory-only.
 *
 * These are the fails-first cases the boot check needs to be able to tell
 * apart, exercised against fixtures rather than a live instance:
 *   - advisory hint only            -> PASS (allow-listed)
 *   - advisory hint + a real ✗      -> FAIL (a real finding must stay red)
 *   - unknown ✗ only                -> FAIL
 *   - non-zero exit with no ✗ at all -> FAIL (never a vacuous pass)
 *
 * The last case is the dangerous one: "every ✗ is allow-listed" is vacuously
 * true for zero ✗ lines, so the helper must fail closed when it finds none.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "../..");
const HELPER = join(REPO, "scripts", "ci", "doctor-advisory.sh");
const HELPER_SRC = readFileSync(HELPER, "utf8");

const HINT = "  ✗ FLAIR_PUBLIC_URL is not set — OAuth and A2A discovery advertise http://127.0.0.1:19926, which is correct for a local-only install and unusable for any remote client";
const HINT_FIX = "     Fix: if this instance is reachable at a public URL, set FLAIR_PUBLIC_URL=https://flair.example.com";
const REAL = "  ✗ Ops socket permissions: the socket's parent directory is group/world-accessible";
const UNKNOWN = "  ✗ Embeddings: probe rejected — invalid signature";
const SUMMARY_ONE = "  ✗ 1 issue found — see fixes above";
const SUMMARY_TWO = "  ✗ 2 issues found — see fixes above";

const temps: string[] = [];
afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

function fixture(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "flair-doctor-advisory-"));
  temps.push(dir);
  const file = join(dir, "doctor.log");
  writeFileSync(file, content);
  return file;
}

function run(args: string[]) {
  const r = spawnSync("bash", [HELPER, ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("doctor-advisory — advisory-only passes", () => {
  test("the allow-listed hint is the only ✗ -> exit 0 and the count is logged", () => {
    const file = fixture([HINT, HINT_FIX, SUMMARY_ONE].join("\n") + "\n");
    const r = run([file]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("doctor: advisory-only (allow-listed): 1");
    expect(r.stderr).toContain("allow-listed: FLAIR_PUBLIC_URL is not set");
  });

  test("several allow-listed findings still report the real count", () => {
    const file = fixture([HINT, HINT, SUMMARY_TWO].join("\n") + "\n");
    const r = run([file]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("doctor: advisory-only (allow-listed): 2");
  });

  test("ANSI-wrapped ✗ is recognised (doctor may colour on a TTY)", () => {
    // render.icons.error wraps only the glyph: ESC[31m✗ESC[0m.
    const coloured = `  \u001b[31m✗\u001b[0m FLAIR_PUBLIC_URL is not set — loopback`;
    const file = fixture([coloured, SUMMARY_ONE].join("\n") + "\n");
    const r = run([file]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("doctor: advisory-only (allow-listed): 1");
  });
});

describe("doctor-advisory — any real finding fails", () => {
  test("the hint plus a real ✗ -> exit 1, naming the real one", () => {
    const file = fixture([HINT, REAL, SUMMARY_TWO].join("\n") + "\n");
    const r = run([file]);
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("advisory-only");
    expect(r.stderr).toContain("not allow-listed: Ops socket permissions:");
    expect(r.stderr).toContain("outside the advisory allow-list");
  });

  test("an unknown ✗ only -> exit 1", () => {
    const file = fixture([UNKNOWN, SUMMARY_ONE].join("\n") + "\n");
    const r = run([file]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not allow-listed: Embeddings:");
  });
});

describe("doctor-advisory — fail closed", () => {
  test("a non-zero exit with no ✗ lines does not pass vacuously", () => {
    const file = fixture("everything looks fine\n");
    const r = run([file]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no finding (✗) lines");
  });

  test("a count summary alone is not a finding (no vacuous pass)", () => {
    const file = fixture([SUMMARY_ONE].join("\n") + "\n");
    const r = run([file]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no finding (✗) lines");
  });

  test("rejects a missing log path with a usage error", () => {
    const r = run([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage:");
  });

  test("rejects a nonexistent log file with a usage error", () => {
    const r = run([join(tmpdir(), "does-not-exist-doctor.log")]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage:");
  });
});

describe("doctor-advisory — the allow-list is pinned to its one entry", () => {
  test("the source names flair#1701 and the shrink-to-empty rule", () => {
    expect(HELPER_SRC).toContain("flair#1701");
    expect(HELPER_SRC.toLowerCase()).toContain("shrinks");
  });

  test("exactly one allow-list pattern is declared", () => {
    // The list must NOT grow to paper over a real finding. Each pattern is the
    // only quoted assignment; assert there is exactly one and it is the hint.
    const matches = HELPER_SRC.match(/^ADVISORY_ALLOWLIST=(.*)$/gm) ?? [];
    expect(matches.length).toBe(1);
    expect(matches[0]).toContain("FLAIR_PUBLIC_URL is not set");
  });
});

describe("the boot check actually consults the allow-list", () => {
  const BOOT = readFileSync(join(REPO, "scripts", "ci", "check-instance-boot.sh"), "utf8");

  test("a non-zero doctor exit is delegated to doctor-advisory.sh", () => {
    expect(BOOT).toContain("doctor-advisory.sh");
    expect(BOOT).toContain("DOCTOR_STATUS");
  });

  test("a non-advisory exit still calls fail() — it is not swallowed", () => {
    // The advisory branch must be conditional. If the fail() call were removed
    // and the helper's exit ignored, a real finding would pass silently.
    expect(BOOT).toMatch(/else[\s\S]{0,600}fail "flair doctor exited/);
    expect(BOOT).toContain("non-advisory");
  });
});
