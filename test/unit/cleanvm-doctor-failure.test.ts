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
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { summarizeDoctorRun } from "../../src/commands/doctor";
import { ensureCliBuild } from "../helpers/build-cli-once.js";

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

// flair#2489: the whole gate script, run against a `flair` on PATH that this
// file writes. Its `init` prints a passing semantic line, so the gate reaches
// step 3; its `doctor` either prints a chosen log and exits 1, or runs the BUILT
// CLI's real `flair doctor` against a port nothing listens on, in a temp HOME.
// `id`/`whoami` are stubbed so the gate's non-root guard is deterministic on any
// host, including a root CI runner; the real doctor runs with this test
// process's PATH, so it never sees those stubs.
//
// The gate's FAIL branch prints doctor's raw output, a blank line, and then the
// summary its parser builds. A finding asserted anywhere in stdout can be
// satisfied by the raw echo while the summary drops it, so every finding
// assertion below reads only the summary, cut from stdout at the exact end of
// the echo.
describe("clean-VM gate: the script's doctor-FAIL summary (#2489)", () => {
  const temps: string[] = [];
  afterEach(() => {
    while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
  });

  beforeAll(() => {
    ensureCliBuild();
  }, 120_000);

  const STEP3 = "[3/3] flair doctor --agent cleanvmbot --port 9926 (hard semantic gate)\n";
  const DOCTOR_SUMMARY = /^✗ (\d+) issues? found\b/;

  function stubBin(dir: string): string {
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "flair"),
      [
        "#!/bin/sh",
        "case \"$1\" in",
        "  init) printf '%s\\n' 'Semantic search operational (paraphrase recall verified, score 0.75)'; exit 0 ;;",
        "  doctor)",
        "    printf '%s\\n' \"$*\" > \"$FLAIR_TEST_DIR/doctor-args\"",
        "    if [ -z \"${FLAIR_TEST_REAL_CLI:-}\" ]; then",
        "      printf '%s' \"$FLAIR_STUB_DOCTOR\" > \"$FLAIR_TEST_DIR/doctor-raw\"; rc=1",
        "    else",
        "      # The gate's arguments, except the --port value: a port nothing listens on.",
        "      prev=",
        "      for a do",
        "        shift",
        "        if [ \"$prev\" = --port ]; then a=$FLAIR_TEST_DOCTOR_PORT; fi",
        "        prev=$a",
        "        set -- \"$@\" \"$a\"",
        "      done",
        "      PATH=$FLAIR_TEST_REAL_PATH node \"$FLAIR_TEST_REAL_CLI\" \"$@\" > \"$FLAIR_TEST_DIR/doctor-raw\" 2>&1; rc=$?",
        "    fi",
        "    cat \"$FLAIR_TEST_DIR/doctor-raw\"; exit $rc ;;",
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

  async function deadPort(): Promise<number> {
    const server = createNetServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }

  /**
   * Run the gate. `doctor` is a log for the stub, or `{ real: port }` for the
   * built CLI. Returns the gate's exit status, the args the gate passed to
   * `flair doctor`, the raw doctor output, and the summary section.
   */
  function runGate(doctor: string | { real: number }) {
    const dir = mkdtempSync(join(tmpdir(), "flair-cleanvm-gate-"));
    temps.push(dir);
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    const bin = stubBin(dir);
    const realPath = process.env.PATH ?? "";
    // Only what the gate and doctor need: no FLAIR_* or HDB_* from this shell.
    const env: Record<string, string> = { PATH: `${bin}:${realPath}`, HOME: home, FLAIR_TEST_DIR: dir };
    if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
    if (typeof doctor === "string") {
      env.FLAIR_STUB_DOCTOR = doctor;
    } else {
      env.FLAIR_TEST_REAL_CLI = join(REPO, "dist", "cli-shim.cjs");
      env.FLAIR_TEST_REAL_PATH = realPath;
      env.FLAIR_TEST_DOCTOR_PORT = String(doctor.real);
    }
    const r = spawnSync("bash", [GATE_PATH], { cwd: REPO, encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL", env });
    const stdout = r.stdout ?? "";
    const raw = readFileSync(join(dir, "doctor-raw"), "utf8");
    const args = readFileSync(join(dir, "doctor-args"), "utf8").trim();

    // The gate captures doctor with $(...), which strips trailing newlines, and
    // prints it with `echo` followed by an empty `echo`.
    const at = stdout.indexOf(STEP3);
    if (at < 0) throw new Error(`the gate never reached step 3:\n${stdout}\n${r.stderr ?? ""}`);
    const echo = `${raw.replace(/\n+$/, "")}\n\n`;
    const afterStep3 = stdout.slice(at + STEP3.length);
    if (!afterStep3.startsWith(echo)) throw new Error(`the gate's raw doctor echo is not doctor's output:\n${afterStep3}`);
    const summary = afterStep3.slice(echo.length);
    return { status: r.status, args, raw, summary };
  }

  /**
   * Every ✗/⚠ finding doctor printed, each with the lines indented under it,
   * excluding doctor's own "✗ N issues found" count line.
   */
  function findingBlocks(raw: string): string[][] {
    const lines = raw.split("\n");
    const blocks: string[][] = [];
    for (let i = 0; i < lines.length; i++) {
      const head = lines[i].trimStart();
      if (!(head.startsWith("✗") || head.startsWith("⚠")) || DOCTOR_SUMMARY.test(head)) continue;
      const indent = lines[i].length - head.length;
      const block = [lines[i]];
      while (i + 1 < lines.length && lines[i + 1].trim() !== "" && lines[i + 1].length - lines[i + 1].trimStart().length > indent) {
        block.push(lines[++i]);
      }
      blocks.push(block);
    }
    return blocks;
  }

  const header = (n: number) => `FAIL: flair doctor exited non-zero. doctor reported ${n} issue${n === 1 ? "" : "s"}:`;

  test("a ⚠-only failure: the summary lists both ⚠ findings with their Fix lines, and no #538 text", () => {
    const r = runGate(NON_EMBEDDINGS_FAIL);
    expect(r.status).toBe(1);
    expect(r.args).toBe("doctor --agent cleanvmbot --port 9926");
    // The counted finding is one of two ⚠ findings and doctor does not say which,
    // so the summary lists both.
    expect(r.summary).toBe([header(1), ...findingBlocks(NON_EMBEDDINGS_FAIL).flat()].join("\n") + "\n");
    expect(r.summary).toContain("no home instance");
    expect(r.summary).not.toContain("#538");
  }, 90_000);

  test("one ✗ matching the count: the summary lists that ✗ block, then names the #538 showstopper", () => {
    const r = runGate(EMBEDDINGS_FAIL);
    expect(r.status).toBe(1);
    const lines = r.summary.replace(/\n$/, "").split("\n");
    const block = findingBlocks(EMBEDDINGS_FAIL).flat();
    expect(block).toHaveLength(3);
    expect(lines.slice(0, 1 + block.length)).toEqual([header(1), ...block]);
    // The #538 block is emitted only when `Semantic search DEGRADED` appears
    // anywhere inside a parsed ✗ block; here it is the ✗ line itself.
    const tail = lines.slice(1 + block.length).join("\n");
    expect(tail).toContain("#538");
    expect(tail).not.toMatch(/[✗⚠]/);
  }, 90_000);

  test("a ✗ count matching doctor's while a ⚠ is also printed: the summary lists both", () => {
    const mixed = [
      "  ⚠ FLAIR_PUBLIC_URL is not set — local-only, unusable for any remote client",
      "     Fix: set FLAIR_PUBLIC_URL at a public URL, then restart",
      "  ✗ Ops socket permissions: the socket's parent directory is group/world-accessible",
      "     Fix: flair init",
      "  ✗ 1 issue found — see fixes above",
    ].join("\n");
    const r = runGate(mixed);
    expect(r.status).toBe(1);
    expect(r.summary).toBe([header(1), ...findingBlocks(mixed).flat()].join("\n") + "\n");
    expect(r.summary).toContain("FLAIR_PUBLIC_URL is not set");
  }, 90_000);

  // An actual failing `flair doctor`: the built CLI, an empty HOME, and a port
  // nothing listens on. Doctor cannot read the instance's version there, prints
  // that as a ⚠ with no Fix line, and counts it (the `issues++` after
  // "could not determine the version running at" in src/commands/doctor.ts), so
  // this run has a counted ⚠ and the gate cannot tell which findings counted.
  test("an actual failing flair doctor with a counted ⚠: the summary lists every finding doctor printed, exactly", async () => {
    const port = await deadPort();
    const r = runGate({ real: port });
    expect(r.status).toBe(1);
    expect(r.args).toBe("doctor --agent cleanvmbot --port 9926");

    const rawLines = r.raw.split("\n").map((l) => l.trimStart());
    const counts = rawLines.filter((l) => DOCTOR_SUMMARY.test(l));
    expect(counts, r.raw).toHaveLength(1);
    const n = Number(counts[0].match(DOCTOR_SUMMARY)![1]);
    expect(n).toBeGreaterThan(0);

    const blocks = findingBlocks(r.raw);
    const versionHead = `⚠ could not determine the version running at http://127.0.0.1:${port}`;
    const counted = blocks.filter((b) => b[0].trimStart().startsWith(versionHead));
    expect(counted, r.raw).toHaveLength(1);
    expect(counted[0]).toHaveLength(1);
    expect(blocks.some((b) => b[0].trimStart().startsWith("✗")), r.raw).toBe(true);

    expect(r.summary).toBe([header(n), ...blocks.flat()].join("\n") + "\n");
    expect(r.summary).not.toContain("#538");
  }, 90_000);
});
