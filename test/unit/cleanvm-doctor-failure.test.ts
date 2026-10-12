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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("clean-VM gate: the doctor failure lists the failing doctor lines (#2438)", () => {
  test("a non-embeddings failure lists that line and does not mention embeddings", () => {
    const r = run(NON_EMBEDDINGS_FAIL);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("no home instance");
    expect(r.stdout).not.toMatch(/embeddings/i);
    expect(r.stdout).not.toMatch(/DEGRADED/);
    expect(r.stdout).toContain("1 issue");
  });

  test("a Semantic search DEGRADED failure names the #538 showstopper", () => {
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

  test("a finding line containing 'issues found' does not change the count", () => {
    const log = [
      "  ✗ Ops socket permissions: world-accessible",
      "     Fix: flair init (7 issues found in the socket scan)",
      "  ✗ 1 issue found — see fixes above",
      "     7 issues found by a later tool",
    ].join("\n");
    const r = run(log);
    expect(r.stdout).toContain("doctor reported 1 issue:");
  });

  test("a ⚠ finding may itself have counted, so the summary lists every finding", () => {
    const mixed = [
      "  ⚠ FLAIR_PUBLIC_URL is not set — local-only, unusable for any remote client",
      "     Fix: set FLAIR_PUBLIC_URL at a public URL, then restart",
      "  ✗ Ops socket permissions: the socket's parent directory is group/world-accessible",
      "     Fix: flair init",
      "  ✗ 1 issue found — see fixes above",
    ].join("\n");
    const r = run(mixed);
    // The ✗ count matches the summary, but a counted check can print as ⚠, so the
    // gate cannot tell whether the ⚠ or the ✗ was the one counted. It lists both.
    expect(r.stdout).toContain("Ops socket permissions:");
    expect(r.stdout).toContain("FLAIR_PUBLIC_URL");
    expect(r.stdout).toContain("1 issue");
  });

  test("a non-zero exit with no finding line does not mention embeddings", () => {
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

// flair#2489: the whole gate script, driven against a stubbed `flair`. The stub
// answers `init` with a passing semantic line and `doctor` with a chosen log
// and exit 1, so the gate reaches its doctor-FAIL branch. `id`/`whoami` are
// stubbed so the gate's non-root guard is deterministic on any host, including
// a root CI runner.
describe("clean-VM gate: the script against a failing stubbed doctor (#2489)", () => {
  const temps: string[] = [];
  afterEach(() => {
    while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
  });

  function stubBin(dir: string): string {
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "flair"),
      [
        "#!/bin/sh",
        "case \"$1\" in",
        "  init) printf '%s\\n' 'Semantic search operational (paraphrase recall verified, score 0.75)'; exit 0 ;;",
        "  doctor) printf '%s' \"$FLAIR_STUB_DOCTOR\"; exit 1 ;;",
        "esac",
        "exit 2",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeFileSync(join(bin, "id"), "#!/bin/sh\necho 1000\n", { mode: 0o755 });
    writeFileSync(join(bin, "whoami"), "#!/bin/sh\necho gateuser\n", { mode: 0o755 });
    return bin;
  }

  function runGate(doctorOutput: string): { status: number | null; stdout: string } {
    const dir = mkdtempSync(join(tmpdir(), "flair-cleanvm-gate-"));
    temps.push(dir);
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    const bin = stubBin(dir);
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FLAIR_STUB_DOCTOR: doctorOutput,
    };
    delete env.FLAIR_MODELS_DIR;
    const r = spawnSync("bash", [GATE_PATH], { cwd: REPO, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", env });
    return { status: r.status, stdout: r.stdout ?? "" };
  }

  test("a non-embeddings doctor failure lists the counted finding and exits non-zero", () => {
    const r = runGate(NON_EMBEDDINGS_FAIL);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("FAIL: flair doctor exited non-zero. doctor reported 1 issue:");
    expect(r.stdout).toContain("no home instance");
    // The #538 block is emitted only when an embeddings ✗ is among the findings.
    expect(r.stdout).not.toContain("#538");
  });

  test("an embeddings DEGRADED failure names the #538 showstopper and exits non-zero", () => {
    const r = runGate(EMBEDDINGS_FAIL);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("FAIL: flair doctor exited non-zero. doctor reported 1 issue:");
    expect(r.stdout).toMatch(/Semantic search DEGRADED/);
    expect(r.stdout).toContain("#538");
  });
});
