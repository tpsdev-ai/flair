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
 *   - the allow-listed literal only  -> PASS (allow-listed)
 *   - literal + a real ✗             -> FAIL (a real finding must stay red)
 *   - unknown ✗ only                 -> FAIL
 *   - non-zero exit with no ✗ at all -> FAIL (never a vacuous pass)
 *
 * The allow-list itself is the security-relevant part, so it is pinned twice:
 * the source must declare exactly one entry, that entry must be a literal with
 * no ERE metacharacters (so an alternation is red), and the runtime must
 * enforce count parity (one entry excuses at most one finding). The last case
 * matters because "every ✗ is allow-listed" is vacuously true for zero ✗ lines,
 * so the helper must fail closed when it finds none.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "../..");
const HELPER = join(REPO, "scripts", "ci", "doctor-advisory.sh");
const HELPER_SRC = readFileSync(HELPER, "utf8");

// The allow-list's single literal entry, as doctor prints the finding line.
const LITERAL = "  ✗ FLAIR_PUBLIC_URL is not set";
// The full hint text: contains the literal phrase PLUS extra text (the loopback
// issuer and prose). Whole-line matching must NOT allow-list this.
const HINT_WITH_EXTRA =
  "  ✗ FLAIR_PUBLIC_URL is not set — OAuth and A2A discovery advertise http://127.0.0.1:19926, which is correct for a local-only install and unusable for any remote client";
const HINT_FIX = "     Fix: if this instance is reachable at a public URL, set FLAIR_PUBLIC_URL=https://flair.example.com";
const REAL = "  ✗ Ops socket permissions: the socket's parent directory is group/world-accessible";
const UNKNOWN = "  ✗ Embeddings: probe rejected — invalid signature";
const SUMMARY_ONE = "  ✗ 1 issue found — see fixes above";
const SUMMARY_TWO = "  ✗ 2 issues found — see fixes above";

// ERE metacharacters an allow-list entry may not contain. A pattern can hide
// several findings in a single entry (`A|B`) or over-match a finding that
// merely contains the phrase; an entry must be a literal full line.
const ERE_METACHARS = /[|()[\]*+?.^$\\{}]/;

/**
 * Extract the literal entries from the `ADVISORY_ALLOWLIST=( … )` array in the
 * helper source. Single-quoted, one per line. Parsing the real source (rather
 * than a copied constant) is what pins the declaration site.
 */
function allowlistEntries(src: string): string[] {
  const block = src.match(/^ADVISORY_ALLOWLIST=\(\r?\n([\s\S]*?)^\)/m);
  if (!block) throw new Error("ADVISORY_ALLOWLIST=() array not found in doctor-advisory.sh");
  return [...block[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

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

/** Write a modified copy of the helper and run it, to exercise a mutated list. */
function runPatchedHelper(patchedSrc: string, args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "flair-doctor-advisory-patched-"));
  temps.push(dir);
  const script = join(dir, "doctor-advisory.sh");
  writeFileSync(script, patchedSrc);
  const r = spawnSync("bash", [script, ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("doctor-advisory — advisory-only passes", () => {
  test("the allow-listed literal is the only ✗ -> exit 0 and the count is logged", () => {
    const file = fixture([LITERAL, HINT_FIX, SUMMARY_ONE].join("\n") + "\n");
    const r = run([file]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("doctor: advisory-only (allow-listed): 1");
    expect(r.stderr).toContain("allow-listed: FLAIR_PUBLIC_URL is not set");
  });

  test("ANSI-wrapped ✗ is recognised (doctor may colour on a TTY)", () => {
    // render.icons.error wraps only the glyph: ESC[31m✗ESC[0m.
    const coloured = `  \u001b[31m✗\u001b[0m FLAIR_PUBLIC_URL is not set`;
    const file = fixture([coloured, SUMMARY_ONE].join("\n") + "\n");
    const r = run([file]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("doctor: advisory-only (allow-listed): 1");
  });
});

describe("doctor-advisory — literal, whole-line matching", () => {
  test("FAILS-FIRST: the phrase plus extra text is NOT allow-listed", () => {
    // The full hint embeds the issuer; the literal-only matcher must reject it.
    const file = fixture([HINT_WITH_EXTRA, HINT_FIX, SUMMARY_ONE].join("\n") + "\n");
    const r = run([file]);
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("advisory-only");
    expect(r.stderr).toContain("not allow-listed: FLAIR_PUBLIC_URL is not set —");
    expect(r.stderr).toContain("count-parity");
  });

  test("a prefix of the allow-listed text is NOT allow-listed", () => {
    const file = fixture(["  ✗ FLAIR_PUBLIC_URL is", SUMMARY_ONE].join("\n") + "\n");
    const r = run([file]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not allow-listed: FLAIR_PUBLIC_URL is");
  });
});

describe("doctor-advisory — any real finding fails", () => {
  test("the literal plus a real ✗ -> exit 1, naming the real one", () => {
    const file = fixture([LITERAL, REAL, SUMMARY_TWO].join("\n") + "\n");
    const r = run([file]);
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("advisory-only");
    expect(r.stderr).toContain("not allow-listed: Ops socket permissions:");
    expect(r.stderr).toContain("count-parity");
  });

  test("FAILS-FIRST: the ops-socket finding alone -> exit 1", () => {
    const file = fixture([REAL, SUMMARY_ONE].join("\n") + "\n");
    const r = run([file]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not allow-listed: Ops socket permissions:");
  });

  test("an unknown ✗ only -> exit 1", () => {
    const file = fixture([UNKNOWN, SUMMARY_ONE].join("\n") + "\n");
    const r = run([file]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not allow-listed: Embeddings:");
  });
});

describe("doctor-advisory — count parity (one entry excuses one finding)", () => {
  test("two identical allow-listed findings fail parity (one entry cannot hide N)", () => {
    const file = fixture([LITERAL, LITERAL, SUMMARY_TWO].join("\n") + "\n");
    const r = run([file]);
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("advisory-only");
    expect(r.stderr).toContain("count-parity");
  });

  test("a finding with extra text plus a real finding cannot reach parity", () => {
    const file = fixture([HINT_WITH_EXTRA, REAL, SUMMARY_TWO].join("\n") + "\n");
    const r = run([file]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("count-parity");
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

describe("doctor-advisory — the allow-list is pinned to one literal entry", () => {
  test("the source names flair#1701 and the shrink-to-empty rule", () => {
    expect(HELPER_SRC).toContain("flair#1701");
    expect(HELPER_SRC.toLowerCase()).toContain("shrinks");
  });

  test("exactly one allow-list entry is declared", () => {
    expect(allowlistEntries(HELPER_SRC)).toHaveLength(1);
  });

  test("the sole entry is the public-URL hint phrase", () => {
    expect(allowlistEntries(HELPER_SRC)).toEqual(["FLAIR_PUBLIC_URL is not set"]);
  });

  test("every allow-list entry is a literal (no ERE metacharacters)", () => {
    for (const entry of allowlistEntries(HELPER_SRC)) {
      expect(ERE_METACHARS.test(entry)).toBe(false);
    }
  });

  test("FAILS-FIRST: an alternation entry is caught by the literal guard", () => {
    // If someone widened the single entry to an ERE alternation (the exact
    // flair#1702 regression), the metachar assertion above must go red. Prove
    // the guard is non-vacuous by feeding it the patched source.
    const patched = HELPER_SRC.replace(
      "'FLAIR_PUBLIC_URL is not set'",
      "'FLAIR_PUBLIC_URL is not set|Ops socket permissions'",
    );
    const patchedEntries = allowlistEntries(patched);
    expect(patchedEntries).toHaveLength(1);
    expect(patchedEntries.some((entry) => ERE_METACHARS.test(entry))).toBe(true);

    // And the literal matcher refuses to let that entry excuse anything.
    const file = fixture([HINT_WITH_EXTRA, REAL, SUMMARY_TWO].join("\n") + "\n");
    const r = runPatchedHelper(patched, [file]);
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("advisory-only");
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
