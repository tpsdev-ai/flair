/**
 * cleanvm-doctor-failure.test.ts — flair#2438.
 *
 * `docker/test-clean-vm.sh`'s doctor gate printed a fixed message naming the
 * embeddings showstopper (#538) whenever `flair doctor` exited non-zero, even
 * when doctor had counted a different check. On the run cited in #2436 the
 * embeddings check printed "semantic search operational ... score 0.75" and the
 * counted issue was an agent-homes warning, so the fixed message pointed the
 * reader at the wrong component.
 *
 * The parser that builds the message is the Node program embedded in the gate.
 * These tests extract it from the real script (the same convention as
 * from-scratch-teardown.test.ts) and feed it doctor logs: one whose only counted
 * issue is a non-embeddings check, one whose counted issue is the embeddings
 * check.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeDoctorRun } from "../../src/commands/doctor";

const REPO = join(import.meta.dir, "../..");
const GATE_PATH = join(REPO, "docker", "test-clean-vm.sh");
const GATE = readFileSync(GATE_PATH, "utf8");

const PROGRAM = GATE.split("<<'DOCTORFAIL'\n")[1]?.split("\nDOCTORFAIL")[0];
if (!PROGRAM) throw new Error("flair#2438: the doctor-FAIL program is missing from docker/test-clean-vm.sh");

// A real capture (trimmed) of the clean-VM gate's `flair doctor` on the failing
// run cited in #2436: the embeddings check passed, and the one counted issue was
// the ⚠ agent-homes finding. The advisory ⚠ public-URL hint is present and did
// NOT count.
const NON_EMBEDDINGS_FAIL = [
  "  ✓ Harper responding on port 9926",
  "  ⚠ FLAIR_PUBLIC_URL is not set — OAuth and A2A discovery advertise http://127.0.0.1:9926, which is correct for a local-only install and unusable for any remote client",
  "     Fix: if this instance is reachable at a public URL, set FLAIR_PUBLIC_URL=https://flair.example.com in the Flair process environment, then restart the instance",
  "  ✓ Embeddings: semantic search operational (paraphrase recall verified, score 0.75)",
  "  ✓ Instance identity: no rows",
  "  ⚠ 1 stored agent row(s) have no home instance (originatorInstanceId): cleanvmbot; this instance has no single canonical id to stamp",
  "     Fix: flair agent stamp-home (dry run; add --apply to stamp)",
  "  ✗ 1 issue found — see fixes above",
].join("\n");

// A doctor log whose counted issue is the embeddings check (the #538 class).
const EMBEDDINGS_FAIL = [
  "  ✓ Harper responding on port 9926",
  "  ✗ Semantic search DEGRADED — embeddings model could not be loaded (EACCES writing the models dir)",
  "     Embeddings are not loaded; recall-by-meaning will NOT work.",
  "     Common cause: the embeddings component lacks write access (sudo/root global installs).",
  "  ✗ 1 issue found — see fixes above",
].join("\n");

const temps: string[] = [];
afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

function run(doctorOutput: string) {
  const dir = mkdtempSync(join(tmpdir(), "flair-cleanvm-doctor-"));
  temps.push(dir);
  const program = join(dir, "doctor-failure.mjs");
  writeFileSync(program, PROGRAM);
  // Same argv shape as the gate: the program lands in argv[1], the doctor log
  // in argv[2].
  const r = spawnSync("node", [program, doctorOutput], { encoding: "utf8", timeout: 5000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("clean-VM gate: the doctor failure names the check that failed (#2438)", () => {
  test("a non-embeddings failure names that check, not embeddings", () => {
    const r = run(NON_EMBEDDINGS_FAIL);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("no home instance");
    expect(r.stdout).not.toMatch(/embeddings/i);
    expect(r.stdout).not.toMatch(/DEGRADED/);
    expect(r.stdout).toContain("1 issue");
  });

  test("an embeddings failure names embeddings", () => {
    const r = run(EMBEDDINGS_FAIL);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Semantic search DEGRADED/);
    expect(r.stdout).toMatch(/embeddings/i);
    expect(r.stdout).toContain("#538");
  });

  test("a ✗ finding carries its Common cause line", () => {
    const r = run(EMBEDDINGS_FAIL);
    expect(r.stdout).toContain("Common cause:");
  });

  test("the count comes from doctor's summary line", () => {
    const two = [
      "  ✓ Harper responding on port 9926",
      "  ✗ Ops socket permissions: the socket's parent directory is group/world-accessible",
      "     Fix: flair init",
      "  ✗ FLAIR_PUBLIC_URL is set in this shell but discovery advertises the loopback address",
      "     Fix: set FLAIR_PUBLIC_URL and restart",
      "  ✗ 2 issues found — see fixes above",
    ].join("\n");
    const r = run(two);
    expect(r.stdout).toContain("2 issues");
    expect(r.stdout).not.toMatch(/embeddings/i);
  });

  test("doctor's own summary line is read as the count", () => {
    const log = [
      "  ✗ Ops socket permissions: world-accessible",
      "  ✗ Instance identity: bad",
      "  ✗ Harper unreachable",
      summarizeDoctorRun(3, 0, false).line,
    ].join("\n");
    const r = run(log);
    expect(r.stdout).toContain("doctor reported 3 issues");
  });

  test("when the ✗ findings explain the count, an advisory ⚠ is not listed", () => {
    const mixed = [
      "  ⚠ FLAIR_PUBLIC_URL is not set — local-only, unusable for any remote client",
      "     Fix: set FLAIR_PUBLIC_URL at a public URL, then restart",
      "  ✗ Ops socket permissions: the socket's parent directory is group/world-accessible",
      "     Fix: flair init",
      "  ✗ 1 issue found — see fixes above",
    ].join("\n");
    const r = run(mixed);
    expect(r.stdout).toContain("Ops socket permissions:");
    expect(r.stdout).not.toContain("FLAIR_PUBLIC_URL");
  });

  test("a non-zero exit with no finding line does not name embeddings", () => {
    const r = run("  something unexpected happened\n");
    expect(r.stdout).not.toMatch(/embeddings/i);
    expect(r.stdout).toContain("something unexpected happened");
  });

  test("an ANSI-coloured ✗ is recognised", () => {
    const coloured =
      "  \u001b[31m✗\u001b[0m Ops socket permissions: world-accessible\n  ✗ 1 issue found — see fixes above";
    const r = run(coloured);
    expect(r.stdout).toContain("Ops socket permissions:");
    expect(r.stdout).not.toMatch(/embeddings/i);
  });

  test("doctor's own count line is not listed as a finding", () => {
    const r = run(EMBEDDINGS_FAIL);
    const findings = r.stdout.split("\n").filter((l) => l.trimStart().startsWith("✗"));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("Semantic search DEGRADED");
  });
});

describe("clean-VM gate: the parser is wired into the non-zero branch", () => {
  test("the FAIL branch runs the embedded parser", () => {
    expect(GATE).toContain("<<'DOCTORFAIL'");
    expect(GATE).toContain('node --input-type=module - "$DOCTOR_OUTPUT"');
  });

  test("the fixed embeddings-only message is gone", () => {
    expect(GATE).not.toContain("semantic search is DEGRADED on a");
  });
});
