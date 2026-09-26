/**
 * canary-fail-closed-hardening.test.ts — flair#1856 round 2, flair#1671 (A1c).
 *
 * The post-publish canary is the last gate before `latest` moves. A1c rebinds the
 * PASS block from "one sha256 test per package" to a SINGLE package-set-digest
 * preflight, and the sha step now re-derives the canonical package-set digest from
 * the per-package shas it verified and requires it to equal the dispatched
 * `package_set_digest` BEFORE any verdict (A1a, #1877 certified the same digest).
 *
 * This file exercises the fail-closed contract end to end, with no network and no
 * real npm: a stub `node` synthesizes per-package shas (or simulates "the helper
 * printed nothing"), and a stub `npm` records every `dist-tag add` so the tests can
 * prove that a refusal aborts the whole preflight BEFORE the first tag could move.
 *
 *   (a) a SemVer prerelease PASS prints no promote block (in the unit test file).
 *   (b) the promote block is bound to the single set digest, no per-package tests.
 *   (c) a sha-step `package_set_digest` mismatch is a FAIL verdict (the step
 *       fails, names both digests, and writes no LOCKSTEP_SHAS — so the verdict
 *       is FAIL, never a promote).
 *   (d) a paste-time re-hash with ONE package's registry hash changed aborts the
 *       preflight before any dist-tag line.
 *   (e) an empty re-hash refuses the whole preflight (unmeasurable is never a match).
 *
 * A regression here (a per-package sha test, a match on an unmeasured set, a
 * promote on a mismatch) turns these red.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import yaml from "js-yaml";

import { lockstepPackages } from "../../scripts/ci/lockstep-packages.mjs";
import { computePackageSetDigest } from "../../scripts/ci/package-set-digest.mjs";

const REPO = join(import.meta.dir, "..", "..");
const CANARY_YML = join(REPO, ".github", "workflows", "canary.yml");
const SHA_SCRIPT = join(REPO, "scripts", "ci", "registry-tarball-sha256.mjs");
const LOCKSTEP_SCRIPT = join(REPO, "scripts", "ci", "lockstep-packages.mjs");
const VERDICT_SCRIPT = join(REPO, "scripts", "ci", "canary-verdict.sh");

const RUN_URL = "https://github.com/tpsdev-ai/flair/actions/runs/42";
const PACKAGES: string[] = lockstepPackages();
const VER = "0.55.1";

const SCRATCH = mkdtempSync(join(tmpdir(), "flair-1856-r2-"));
const BIN = join(SCRATCH, "bin");
const SHIM = join(SCRATCH, "shim");
const FIXTURES = join(SCRATCH, "fixtures.json");
mkdirSync(BIN, { recursive: true });
mkdirSync(SHIM, { recursive: true });
// `bun test` sets process.execPath to BUN, whose symlink semantics differ from
// Node's — and the fail-open under test is a NODE behaviour, so the tests drive
// real node. `REAL_NODE` is resolved through the untouched PATH here (before any
// shim exists).
const REAL_NODE = execFileSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).trim();

const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");
/** The digest the canary would re-derive if every package hashed to sha256(seed+pkg). */
function rederivedDigest(seed: string): string {
  return computePackageSetDigest(PACKAGES.map((p) => [p, sha256Hex(seed + p)]), VER);
}

// ── the local registry: one HTTP server + a stub npm ────────────────────────
const servers: Server[] = [];
function listen(srv: Server): Promise<number> {
  servers.push(srv);
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve((srv.address() as { port: number }).port)));
}
// flair#1856 R3: the mock registry's bytes come from a FIXED map built BEFORE the
// server starts. No response byte is derived from `req.url` at request time —
// echoing the request path into the body reads as reflected XSS to a taint
// analyser, and a required security check is red for it. A lookup that misses
// gets a constant body.
const PI_FLAIR_TARBALL_PATH = "/@tpsdev-ai/pi-flair@0.55.1.tgz";
const tarballBody = (path: string): Buffer => Buffer.from(`tarball-bytes:${path}`);
const TARBALL_BODIES = new Map<string, Buffer>([[PI_FLAIR_TARBALL_PATH, tarballBody(PI_FLAIR_TARBALL_PATH)]]);
const NOT_FOUND_BODY = Buffer.from("not found");

/** A mock registry: it answers ONLY the precomputed paths, else a constant 404. */
function mockRegistry(): Server {
  return createServer((req, res) => {
    const body = TARBALL_BODIES.get(req.url ?? "");
    res.writeHead(body ? 200 : 404, { "Content-Type": "application/octet-stream" });
    res.end(body ?? NOT_FOUND_BODY);
   });
}

// The stub npm ALSO logs every `dist-tag add` to $DISTTAG_LOG, so the block
// tests can prove a refusal aborts BEFORE the first tag could move.
const npmStub = [
   "#!/usr/bin/env bash",
   "if [ \"${1:-}\" = \"view\" ] && [ \"${3:-}\" = \"dist.tarball\" ]; then",
   "  base=\"$(cat \"$FIXTURES\")\"; spec=\"$2\"",
   "  printf '%s/%s@%s.tgz\\n' \"$base\" \"${spec%@*}\" \"${spec##*@}\"",
   "fi",
   "if [ \"${1:-}\" = \"dist-tag\" ] && [ \"${2:-}\" = \"ls\" ]; then echo \"latest: 1.2.2\"; exit 0; fi",
   "if [ \"${1:-}\" = \"dist-tag\" ] && [ \"${2:-}\" = \"add\" ]; then printf 'dist-tag add %s\\n' \"${3:-}\" >> \"${DISTTAG_LOG:-/dev/null}\"; fi",
   "exit 0",
].join("\n");

// ── the stub `node`: it can synthesize per-package shas or "print nothing" ────
// Modes (env STUB_SHA_MODE):
//   ok          — sha256("stub:"+pkg) per package (the happy path)
//   bindings     — sha256("sha:"+pkg) per package
//   empty        — prints nothing for every package (unmeasurable)
//   flair-only   — @tpsdev-ai/flair hashes; every OTHER package prints NOTHING
//   one-changed  — STUB_CHANGED_PKG hashes sha256("changed:"+pkg); the rest "sha:"
// `package-set-digest.mjs` is delegated to REAL node so the digest is computed for
// real over the (stubbed) per-package shas.
const nodeStub = [
   "#!/usr/bin/env node",
   "import { createHash } from 'node:crypto';",
   "import { spawnSync } from 'node:child_process';",
   "import { join as require_join } from 'node:path';",
   "const args = process.argv.slice(2);",
   "const joined = args.join(' ');",
   "if (joined.includes('lockstep-packages.mjs')) {",
   "  const abs = args.map((a, i) => (i === 0 ? require_join(process.env.REPO_ROOT, a) : a));",
   "  const r = spawnSync(process.env.REAL_NODE, abs, { cwd: process.env.REPO_ROOT, encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] });",
   "  if (r.stdout) process.stdout.write(r.stdout);",
   "  if (r.stderr) process.stderr.write(r.stderr);",
   "  process.exit(r.status ?? 1);",
   "}",
   "if (joined.includes('package-set-digest.mjs')) {",
   "  const abs = args.map((a, i) => (i === 0 ? require_join(process.env.REPO_ROOT, a) : a));",
   "  const r = spawnSync(process.env.REAL_NODE, abs, { cwd: process.env.REPO_ROOT, encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] });",
   "  if (r.stdout) process.stdout.write(r.stdout);",
   "  if (r.stderr) process.stderr.write(r.stderr);",
   "  process.exit(r.status ?? 1);",
   "}",
   "if (joined.includes('registry-tarball-sha256.mjs')) {",
   "  const mode = process.env.STUB_SHA_MODE || 'ok';",
   "  const pk = args[args.length - 1];",
   "  if (mode === 'empty') process.exit(0);",
   "  if (mode === 'flair-only' && pk !== '@tpsdev-ai/flair') process.exit(0);",
   "  if (mode === 'one-changed' && pk === process.env.STUB_CHANGED_PKG) { process.stdout.write(createHash('sha256').update('changed:' + pk).digest('hex') + '\\n'); process.exit(0); }",
   "  const seed = (mode === 'bindings') ? 'sha:' : 'stub:';",
   "  process.stdout.write(createHash('sha256').update(seed + pk).digest('hex') + '\\n');",
   "  process.exit(0);",
   "}",
   "if (joined.includes('registry-latest-skew.mjs') && process.env.SKEW_FAIL === '1') process.exit(1);",
   "if (joined.includes('registry-latest-skew.mjs') && process.env.SKEW_FAIL === '2') process.exit(2);",
   "// Any other node script the gate runs (registry-latest-skew) is a no-op here.",
   "process.exit(0);",
].join("\n");

const nodeStdin = { stdin: "inherit" as const }; // ensure child scripts see the caller's stdin

writeFileSync(join(BIN, "npm"), npmStub);
writeFileSync(join(SCRATCH, "node-stub.mjs"), nodeStub);
// A `node` shim on the PATH can synthesize per-package shas for the workflow step
// and the emitted block. It lives in its OWN dir so the direct-helper tests keep
// real node.
writeFileSync(join(SHIM, "node"), ["#!/usr/bin/env bash", 'exec "$REAL_NODE" "$NODE_STUB" "$@"', ""].join("\n"));
chmodSync(join(BIN, "npm"), 0o755);
chmodSync(join(SHIM, "node"), 0o755);

/** A "checkout" whose scripts/ci is reached through a symlink. */
const LINKREPO = join(SCRATCH, "linkrepo");
mkdirSync(join(LINKREPO, "scripts"), { recursive: true });
symlinkSync(join(REPO, "scripts", "ci"), join(LINKREPO, "scripts", "ci"), "dir");

afterAll(() => {
  for (const s of servers) s.close();
  rmSync(SCRATCH, { recursive: true, force: true });
});

async function runNode(cwd: string, args: string[], extraEnv: Record<string, string> = {}) {
  const proc = Bun.spawn(["node", ...args], {
    cwd,
    env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, FIXTURES, REPO_ROOT: REPO, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
   });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
   ]);
  return { stdout, stderr, status: await proc.exited };
}

// ── the direct helpers are recognised through a symlinked checkout ───────────
describe("the canary's sha256 helpers are recognised through a symlinked path (flair#1856 R2)", () => {
  test("registry-tarball-sha256.mjs prints a 64-hex sha and exits 0 (was: empty output, exit 0)", async () => {
    const srv = mockRegistry();
    const port = await listen(srv);
    writeFileSync(FIXTURES, `http://127.0.0.1:${port}`);
    const expected = createHash("sha256").update(TARBALL_BODIES.get(PI_FLAIR_TARBALL_PATH)!).digest("hex");

     // cwd is the SYMLINKED checkout; argv[1] carries the symlinked path.
    const r = await runNode(LINKREPO, ["scripts/ci/registry-tarball-sha256.mjs", "0.55.1", "@tpsdev-ai/pi-flair"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(expected);
    expect(r.stdout.trim()).toMatch(/^[0-9a-f]{64}$/);
   });

  test("lockstep-packages.mjs prints the full set and exits 0 (was: empty output, exit 0)", async () => {
    const r = await runNode(LINKREPO, ["scripts/ci/lockstep-packages.mjs"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual(PACKAGES);
   });
});

// ── the sha step: the package-set digest must match before any verdict ───────
function shaStepScript(): string {
  const wf = yaml.load(readFileSync(CANARY_YML, "utf8")) as {
    jobs: { canary: { steps: { id?: string; run?: string }[] } };
   };
  const step = wf.jobs.canary.steps.find((s) => s.id === "sha");
  if (!step?.run) throw new Error("canary.yml has no step id 'sha' with a run: block");
  return step.run;
}

function runShaStep(mode: string, certDigest: string): { status: number | null; stdout: string; envFile: string } {
  const cwd = mkdtempSync(join(SCRATCH, "step-"));
  const stepFile = join(cwd, "step.sh");
  const genv = join(cwd, "github_env.txt");
  writeFileSync(stepFile, shaStepScript());
  writeFileSync(genv, "");
  const r = spawnSync("bash", [stepFile], {
    cwd,
    encoding: "utf8",
    env: {
       ...process.env,
      PATH: `${SHIM}:${BIN}:${process.env.PATH}`,
      REAL_NODE,
      NODE_STUB: join(SCRATCH, "node-stub.mjs"),
      REPO_ROOT: REPO,
      STUB_SHA_MODE: mode,
      GITHUB_ENV: genv,
      VERSION: VER,
      EXPECTED: sha256Hex("stub:@tpsdev-ai/flair"),
      PKG_SET_DIGEST: certDigest,
      RUNNER_TEMP: join(cwd, "temp"),
     },
   });
  return { status: r.status, stdout: `${r.stdout}${r.stderr}`, envFile: readFileSync(genv, "utf8") };
}

describe("the sha step binds the verdict to the package-set digest (A1c of #1671)", () => {
  test("positive control: every sha 64-hex and the digest matches => step passes, writes all bindings", () => {
    const cert = rederivedDigest("stub:"); // the "ok" mode hashes seed "stub:"
    const r = runShaStep("ok", cert);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("package-set digest verified");
    // A1c/F1: the sha step no longer emits a LOCKSTEP_SHAS GITHUB_ENV binding —
    // the verdict is bound to the package_set_digest input (and the emitted
    // preflight re-derives it), not a GITHUB_ENV hand-off.
    expect(r.envFile).not.toContain("LOCKSTEP_SHAS");
   });

  test("(c) a package_set_digest mismatch => FAIL: step fails, names both digests, no LOCKSTEP_SHAS", () => {
    const wrong = "0000000000000000000000000000000000000000000000000000000000000000";
    const r = runShaStep("ok", wrong);
    expect(r.status).not.toBe(0);
    // Both digests are named: the re-derived one and the dispatched (wrong) one.
    expect(r.stdout).toContain("differs from the dispatched " + wrong);
    // The re-derived digest (from the "ok" seed) is the real one, so it is named too.
    expect(r.stdout).toContain(rederivedDigest("stub:"));
    expect(r.stdout).toContain("do not promote");
     // A FAIL canary writes no promote bindings: no digest could move `latest`.
    expect(r.envFile).not.toContain("LOCKSTEP_SHAS");
   });

  test("(c-2) a non-hex package_set_digest => FAIL before any verdict", () => {
    const r = runShaStep("ok", "not-a-hex-digest");
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("64-char hex");
    expect(r.envFile).not.toContain("LOCKSTEP_SHAS");
   });

  test("a 40-hex (SHA-1) package_set_digest => FAIL before any verdict", () => {
    const r = runShaStep("ok", "0123456789abcdef0123456789abcdef01234567");
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("64-char hex");
   });

  test("(unmeasurable) a helper that exits 0 with NO output does NOT reach the verdict", () => {
     // flair + a correct sha, but every OTHER package prints nothing. The 64-hex
     // guard aborts the step (before the digest is even computed), so no
     // LOCKSTEP_SHAS is written — the canary is FAIL, never a promote.
    const r = runShaStep("flair-only", rederivedDigest("stub:"));
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("unmeasurable is FAIL");
    expect(r.envFile).not.toContain("LOCKSTEP_SHAS");
     // No `pkg=` line with an empty value ever leaves the step.
    expect(/(^|\n)[^\n=]+=\n/.test(r.envFile)).toBe(false);
   });
});

// ── the emitted promote block: digest-bound, refuses on any unmeasured set ────
function emittedBlock(): string {
   // The certified digest the block re-derives to is the "bindings" (seed "sha:") digest;
   // the block is emitted with that digest so the "bindings"-mode run matches it.
  const cert = rederivedDigest("sha:");
  const r = runVerdict(["pass", VER, RUN_URL, "--os", "ubuntu-latest", "--package-set-digest", cert]);
  expect(r.status).toBe(0);
  expect(r.stderr).toBe("");
  const m = r.stdout.match(/```\n([\s\S]*?)\n```/);
  if (!m?.[1]) throw new Error("no fenced promote block in the PASS output");
  return m[1]!;
}

function runVerdict(args: string[]) {
  return spawnSync("bash", [VERDICT_SCRIPT, ...args], { encoding: "utf8", cwd: REPO });
}

/** Run an emitted block with a given STUB_SHA_MODE; returns status + dist-tag log. */
function runBlock(mode: string): { status: number | null; dt: string } {
  const cwd = mkdtempSync(join(SCRATCH, "block-"));
  const f = join(cwd, "block.sh");
  const dt = join(cwd, "disttag.log");
  writeFileSync(f, emittedBlock());
  writeFileSync(dt, "");
  const r = spawnSync("bash", [f], {
    cwd: REPO,
    encoding: "utf8",
    env: {
       ...process.env,
      PATH: `${SHIM}:${BIN}:${process.env.PATH}`,
      REAL_NODE,
      NODE_STUB: join(SCRATCH, "node-stub.mjs"),
      REPO_ROOT: REPO,
      STUB_SHA_MODE: mode,
      DISTTAG_LOG: dt,
     },
   });
  return { status: r.status, dt: readFileSync(dt, "utf8") };
}

describe("the emitted promote preflight aborts before any tag (A1c of #1671)", () => {
  test("(e) an empty re-hash refuses the whole preflight and moves no tag", () => {
    const r = runBlock("empty");
    expect(r.status).not.toBe(0);
    expect(r.dt).toBe(""); // no `dist-tag add` was ever reached
   });

  test("(d) one package's registry hash changed => the preflight aborts before any tag", () => {
    const cwd = mkdtempSync(join(SCRATCH, "block-d-"));
    const f = join(cwd, "block.sh");
    const dt = join(cwd, "disttag.log");
    const cert = rederivedDigest("sha:"); // certified for the all-matching "sha:" set
    const verdict = runVerdict(["pass", VER, RUN_URL, "--os", "ubuntu-latest", "--package-set-digest", cert]);
    writeFileSync(f, verdict.stdout.match(/```\n([\s\S]*?)\n```/)![1]!);
    writeFileSync(dt, "");
    const r = spawnSync("bash", [f], {
      cwd: REPO,
      encoding: "utf8",
      env: {
         ...process.env,
        PATH: `${SHIM}:${BIN}:${process.env.PATH}`,
        REAL_NODE,
        NODE_STUB: join(SCRATCH, "node-stub.mjs"),
        REPO_ROOT: REPO,
        STUB_SHA_MODE: "one-changed",
        STUB_CHANGED_PKG: "@tpsdev-ai/flair-bench",
        DISTTAG_LOG: dt,
      },
     });
    expect(r.status).not.toBe(0);
    expect(readFileSync(dt, "utf8")).toBe(""); // the mismatch was caught at the digest preflight, before any tag
    expect(r.stderr).toContain("differs from the release run");
   });

  test("positive control: a re-derivation matching the certified digest moves every tag", () => {
    const r = runBlock("bindings"); // seed "sha:" matches the certified "sha:" digest
    expect(r.status).toBe(0);
    expect(r.dt.split("\n").filter((l) => l.startsWith("dist-tag")).length).toBe(PACKAGES.length);
   });
});

// ── the emitted block is the single-digest form, not per-package sha tests ─────
describe("A1c: the promote block is the single package-set-digest preflight", () => {
  test("(b) no per-package sha tests; exactly one digest comparison; dist-tags after it", () => {
    const cert = rederivedDigest("sha:");
    const r = runVerdict(["pass", VER, RUN_URL, "--os", "ubuntu-latest", "--package-set-digest", cert]);
    expect(r.status).toBe(0);
    const lines = r.stdout.split("\n");
    const oldPerPkg = lines.filter((l) => l.startsWith('test "$(node scripts/ci/registry-tarball-sha256.mjs'));
    expect(oldPerPkg).toEqual([]);
    const digestChecks = lines.filter((l) => l.includes('if [ "$_rehash" != "'));
    expect(digestChecks.length).toBe(1);
    const firstDigest = lines.findIndex((l) => l.includes('if [ "$_rehash" != "'));
    const firstPromote = lines.findIndex((l) => l.includes('if ! npm dist-tag add'));
    expect(firstDigest).toBeLessThan(firstPromote);
  });

  test("a missing --package-set-digest => DID NOT RUN, no dist-tag add", () => {
    const r = runVerdict(["pass", VER, RUN_URL, "--os", "ubuntu-latest"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("DID NOT RUN");
    expect(r.stdout).not.toContain("npm dist-tag add");
   });
});


// ── the verdict step (F0/F1/F4 of A1c #1671) ────────────────────────────────
// F0: the digest is a workflow input carried as an ENV VAR (never an unquoted
//     ${{ inputs... }} in the shell), and a 64-hex guard refuses a bad value
//     before any verdict.  F1: the step is fail-closed (set -euo pipefail, no
//     LOCKSTEP_SHAS) — a non-zero canary-verdict.sh makes the step's shell exit
//     non-zero.  F4: the digest producer's stdout and its exit status are
//     captured SEPARATELY, so a producer that exits non-zero (even with a valid
//     first line), that emits more than one line, or that is empty is a refusal.
function verdictStep() {
  const wf = yaml.load(readFileSync(CANARY_YML, "utf8")) as {
    jobs: { canary: { steps: { name?: string; run?: string; env?: Record<string, string> }[] } };
  };
  const step = wf.jobs.canary.steps.find((s) => typeof s.name === "string" && /canary verdict/i.test(s.name));
  if (!step?.run) throw new Error("canary.yml has no 'Canary verdict' step with a run: block");
  return { run: step.run, env: step.env ?? {} };
}

// A dedicated `node` stub for the F4 producer scenarios: it intercepts the three
// scripts the emitted block calls, and (via the F4_MODE env var) controls the
// package-set-digest producer's stdout and exit status INDEPENDENTLY.
const F4_STUB = join(SCRATCH, "f4-node-stub.mjs");
const F4_SHIM = join(SCRATCH, "f4-shim");
mkdirSync(F4_SHIM, { recursive: true });
const f4NodeStub = [
   "#!/usr/bin/env node",
   "const args = process.argv.slice(2);",
   "const a0 = args[0] || '';",
   "if (a0.includes('registry-tarball-sha256.mjs')) { process.stdout.write((process.env.F4_PKG_SHA || 'a'.repeat(64)) + '\\n'); process.exit(0); }",
   "if (a0.includes('package-set-digest.mjs')) {",
   "  const mode = process.env.F4_MODE || 'valid';",
   "  if (mode === 'exit1') { process.stdout.write('b'.repeat(64) + '\\ngarbage\\n'); process.exit(1); }",
   "  if (mode === 'twolines') { process.stdout.write('c'.repeat(64) + '\\n' + 'd'.repeat(64) + '\\n'); process.exit(0); }",
   "  if (mode === 'empty') { process.stdout.write(''); process.exit(0); }",
   "  process.stdout.write((process.env.F4_CERT || 'e'.repeat(64)) + '\\n'); process.exit(0);",
   "}",
   "if (a0.includes('registry-latest-skew.mjs')) { process.exit(0); }",
   "process.exit(0);",
].join("\n");
writeFileSync(F4_STUB, f4NodeStub);
writeFileSync(join(F4_SHIM, "node"), ["#!/usr/bin/env bash", 'exec "$REAL_NODE" "$F4_STUB" "$@"', ""].join("\n"));
chmodSync(join(F4_SHIM, "node"), 0o755);

/** Emit the PASS block with any valid 64-hex certified digest, then run the
    fenced block under the F4 producer stub (mode controls the digest producer). */
function runF4Block(mode: string): { status: number | null; stderr: string; stdout: string } {
  const cert = "e".repeat(64); // the F4 refusal fires before (or independent of) the digest compare
  const emitted = runVerdict(["pass", VER, RUN_URL, "--os", "ubuntu-latest", "--package-set-digest", cert]);
  if (emitted.status !== 0) throw new Error("F4: canary-verdict.sh did not emit a PASS block (status " + emitted.status + "): " + emitted.stderr);
  const m = emitted.stdout.match(/```\n([\s\S]*?)\n```/);
  if (!m?.[1]) throw new Error("F4: no fenced promote block in the PASS output");
  const block = m[1]!;
  const cwd = mkdtempSync(join(SCRATCH, "f4block-"));
  const f = join(cwd, "block.sh");
  writeFileSync(f, block);
  const r = spawnSync("bash", [f], {
    cwd: REPO,
    encoding: "utf8",
    env: {
       ...process.env,
      PATH: `${F4_SHIM}:${process.env.PATH}`,
      REAL_NODE,
      F4_STUB,
      F4_MODE: mode,
      F4_PKG_SHA: "a".repeat(64),
     },
   });
  return { status: r.status, stderr: r.stderr, stdout: r.stdout };
}

/** Run the CURRENT verdict step's run text with a supplied env; returns status+output. */
function runVerdictStepText(extra: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const { run } = verdictStep();
  const cwd = mkdtempSync(join(SCRATCH, "vs-"));
  const stepFile = join(cwd, "verdict-step.sh");
  writeFileSync(stepFile, run);
  const summary = join(cwd, "summary.txt");
  writeFileSync(summary, "");
  const r = spawnSync("bash", [stepFile], {
    cwd,
    encoding: "utf8",
    env: {
       ...process.env, ...extra,
      VERSION: VER,
      EXPECTED: "0".repeat(64),
      SHA_OUTCOME: "success",
      INSTALL_OUTCOME: "success",
      BOOT_OUTCOME: "success",
      PLUGIN_OUTCOME: "success",
      OS_NAME: "ubuntu-latest",
      RUN_URL,
      GITHUB_STEP_SUMMARY: summary,
      },
    });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("F0: the verdict step carries the package-set digest as an env var (A1c of #1671)", () => {
  test("the verdict step's env carries PACKAGE_SET_DIGEST from the package_set_digest input", () => {
    expect(verdictStep().env.PACKAGE_SET_DIGEST).toBe("${{ inputs.package_set_digest }}");
   });
  test("the verdict step's run text contains no ${{ inputs. interpolation (env var, never unquoted)", () => {
    expect(verdictStep().run).not.toContain("${{ inputs.");
   });
  test("a non-64-hex package-set digest is refused before any verdict (the guard runs first)", () => {
    const r = runVerdictStepText({ PACKAGE_SET_DIGEST: "not-a-64-hex-digest" });
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toContain("64-char hex");
    });
});

describe("F1: the verdict step is fail-closed (A1c of #1671)", () => {
  test("the verdict step's run text starts with 'set -euo pipefail' and references no LOCKSTEP_SHAS", () => {
    const { run } = verdictStep();
    expect(run.trimStart().startsWith("set -euo pipefail")).toBe(true);
    expect(run).not.toContain("LOCKSTEP_SHAS");
    });
  test("with canary-verdict.sh forced to exit non-zero, the verdict step's shell exits non-zero (set -e in force)", () => {
    const { run } = verdictStep();
    const repoRoot = mkdtempSync(join(SCRATCH, "f1root-"));
    mkdirSync(join(repoRoot, "scripts", "ci"), { recursive: true });
    const stub = join(repoRoot, "scripts", "ci", "canary-verdict.sh");
    writeFileSync(stub, "#!/usr/bin/env bash\necho 'forced non-zero verdict' >&2\nexit 2\n");
    chmodSync(stub, 0o755);
    const stepFile = join(repoRoot, "verdict-step.sh");
    writeFileSync(stepFile, run);
    const summary = join(repoRoot, "summary.txt");
    writeFileSync(summary, "");
    const r = spawnSync("bash", [stepFile], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
          ...process.env,
        VERSION: VER,
        EXPECTED: "0".repeat(64),
        SHA_OUTCOME: "success",
        INSTALL_OUTCOME: "success",
        BOOT_OUTCOME: "success",
        PLUGIN_OUTCOME: "success",
        OS_NAME: "ubuntu-latest",
        RUN_URL,
        PACKAGE_SET_DIGEST: "0".repeat(64),
        GITHUB_STEP_SUMMARY: summary,
        },
      });
    expect(r.status).not.toBe(0);
    expect(r.status).toBe(2);
    });
});

describe("F4: the producer's stdout and its exit status are captured SEPARATELY (A1c of #1671)", () => {
  test("a producer that prints a valid hash then garbage and exits 1 is refused (its status is a veto)", () => {
    const r = runF4Block("exit1");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("producer exited");
    });
  test("a producer that emits two 64-hex lines is refused (exactly one line is required)", () => {
    const r = runF4Block("twolines");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("emitted");
    });
  test("an empty producer is refused (unmeasurable is never a match)", () => {
    const r = runF4Block("empty");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("empty output");
    });
});
/** The stub node can drive the direct-helper path (used above) too. */
void nodeStdin;
void SHA_SCRIPT;
void LOCKSTEP_SCRIPT;

// ── F4 (registry hasher, A1c of #1671): the emitted preflight's per-package producer
// is captured by stdout AND exit status. A `registry-tarball-sha256.mjs` that prints a
// valid first line followed by garbage, and exits non-zero, MUST be a refusal. The old
// `| grep -E '^[0-9a-f]{64}` filtered the bad line AND supplied grep's (0) status,
// masking the non-zero exit and promoting anyway — this test is RED on c0bc720e.
const F4REG_STUB = join(SCRATCH, "f4reg-stub.mjs");
const F4REG_SHIM = join(SCRATCH, "f4reg-shim");
mkdirSync(F4REG_SHIM, { recursive: true });
const f4regNodeStub = [
       "#!/usr/bin/env node",
      "const a0 = process.argv[2] || '';",
      "if (a0.includes('registry-tarball-sha256.mjs')) {",
      "  process.stdout.write('a'.repeat(64) + '\\ngarbage\\n');",
      "  process.exit(1);",
      "}",
      "if (a0.includes('package-set-digest.mjs')) { process.stdout.write('e'.repeat(64) + '\\n'); process.exit(0); }",
      "if (a0.includes('registry-latest-skew.mjs')) { process.exit(0); }",
      "process.exit(0);",
].join("\n");
writeFileSync(F4REG_STUB, f4regNodeStub);
writeFileSync(join(F4REG_SHIM, "node"), ["#!/usr/bin/env bash", 'exec "$REAL_NODE" "$F4REG_STUB" "$@"', ""].join("\n"));
chmodSync(join(F4REG_SHIM, "node"), 0o755);

describe("F4 (registry hasher, A1c of #1671): the emitted preflight refuses a bad per-package producer", () => {
      test("a registry hasher that prints a valid line then garbage and exits 1 is refused; no tag moves", () => {
       // Emit a real PASS block (the 9 lockstep packages, a valid 64-hex certified digest).
    const cert = "e".repeat(64);
    const emitted = runVerdict(["pass", VER, RUN_URL, "--os", "ubuntu-latest", "--package-set-digest", cert]);
    expect(emitted.status).toBe(0);
    const m = emitted.stdout.match(/```\n([\s\S]*?)\n```/);
    if (!m?.[1]) throw new Error("F4-registry: no fenced promote block in the PASS output");
    const block = m[1]!;
    const cwd = mkdtempSync(join(SCRATCH, "f4regblock-"));
    const f = join(cwd, "block.sh");
    const dt = join(cwd, "disttag.log");
    writeFileSync(f, block);
    writeFileSync(dt, "");
    const r = spawnSync("bash", [f], {
      cwd: REPO,
      encoding: "utf8",
      env: {
           ...process.env,
        PATH: `${F4REG_SHIM}:${BIN}:${process.env.PATH}`,   // item 3: BIN carries the logging npm stub, so "no tag moves" is a real observation (the stub is reachable), not a pass because npm was unreachable
        REAL_NODE,
        F4REG_STUB,
        DISTTAG_LOG: dt,
       },
       });
        // The preflight refuses before the first tag: non-zero exit, names the package,
        // and the dist-tag log is empty because the *logging* npm stub (BIN, now on the
        // PATH) was never reached. item 3: "no tag moves" is a real observation, not a
        // vacuous pass — the stub is reachable, so a wrong promote would log here.
    expect(r.status, `stderr:\n${r.stderr}\nstdout:\n${r.stdout}`).not.toBe(0);
    expect(r.stderr).toContain("tarball hasher exited");
    expect(readFileSync(dt, "utf8")).toBe("");    // the logging npm stub (BIN, on the PATH) recorded zero dist-tag adds
    });
 });

// ── item 1 (A1c of #1671, round 5): the RESTORE, not a delete. A mid-promote npm
// failure STOPS the block; the block prints one RESTORE line per already-moved
// package — `npm dist-tag add <pkg>@<previous> latest` — and the packages NOT moved.
// It never `npm dist-tag rm`s a tag. A failing skew check after every move prints the
// same restore lines; a pre-move `dist-tag ls` failure stops BEFORE any move.
const CTL_SHIM = join(SCRATCH, "ctl-shim");
const CTL_LOG_DIR = join(SCRATCH, "ctl-log");
mkdirSync(CTL_SHIM, { recursive: true });
// Stub npm: `dist-tag ls <pkg>` answers `latest: 1.2.2` (or FAILS for DISTTAG_LS_FAIL_PKG);
// `dist-tag add` logs the SUCCESSFUL moves and fails from NFAIL_FAIL_ON (default: never).
const ctlNpmStub = [
  "#!/usr/bin/env bash",
  "if [ \"${1:-}\" = \"dist-tag\" ] && [ \"${2:-}\" = \"ls\" ]; then",
  "  if [ -n \"${DISTTAG_LS_FAIL_PKG:-}\" ] && [ \"${3:-}\" = \"$DISTTAG_LS_FAIL_PKG\" ]; then exit 1; fi",
  "  if [ -n \"${DISTTAG_LS_PRINTFAIL_PKG:-}\" ] && [ \"${3:-}\" = \"$DISTTAG_LS_PRINTFAIL_PKG\" ]; then echo \"latest: 1.2.2\"; exit 1; fi",
  "  if [ -n \"${DISTTAG_LS_CR:-}\" ]; then printf 'latest: 1.2.2\\r\\n'; exit 0; fi",
  "  if [ -n \"${DISTTAG_LS_GARBAGE:-}\" ]; then echo \"latest: garbage\"; exit 0; fi",
  "  echo \"latest: 1.2.2\"",
  "  exit 0",
  "fi",
  "if [ \"${1:-}\" = \"dist-tag\" ] && [ \"${2:-}\" = \"add\" ]; then",
  "  n=\"$(cat \"${NFAIL_COUNT:-\"$CTL_LOG_DIR/nfail\"}\" 2>/dev/null || echo 0)\"",
  "  n=$((n + 1)); echo \"$n\" > \"${NFAIL_COUNT:-\"$CTL_LOG_DIR/nfail\"}\"",
  "  if [ \"${3:-}\" = \"${DISTTAG_APPLY_THEN_FAIL:-}\" ]; then printf 'dist-tag add %s\\n' \"${3:-}\" >> \"${DISTTAG_LOG:-/dev/null}\"; exit 1; fi",
  "  if [ \"$n\" -ge \"${NFAIL_FAIL_ON:-99}\" ]; then exit 1; fi",
  "  printf 'dist-tag add %s\\n' \"${3:-}\" >> \"${DISTTAG_LOG:-/dev/null}\"",
  "  exit 0",
  "fi",
  "exit 0",
  "",
].join("\n");
writeFileSync(join(CTL_SHIM, "npm"), ctlNpmStub);
chmodSync(join(CTL_SHIM, "npm"), 0o755);

/** Emit the PASS block (bindings-certified digest) and run it under the control npm stub. */
function runPromoteBlock(extraEnv: Record<string, string>): { status: number | null; stderr: string; dt: string; stdout: string } {
  const cert = rederivedDigest("sha:");
  const emitted = runVerdict(["pass", VER, RUN_URL, "--os", "ubuntu-latest", "--package-set-digest", cert]);
  expect(emitted.status).toBe(0);
  const m = emitted.stdout.match(/```\n([\s\S]*?)\n```/);
  if (!m?.[1]) throw new Error("item1: no fenced promote block in the PASS output");
  const cwd = mkdtempSync(join(SCRATCH, "item1-"));
  const f = join(cwd, "block.sh");
  const dt = join(cwd, "disttag.log");
  const nfail = join(cwd, "nfail.count");
  writeFileSync(f, m[1]!);
  writeFileSync(dt, "");
  writeFileSync(nfail, "0");
  const r = spawnSync("bash", [f], {
    cwd: REPO,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${SHIM}:${CTL_SHIM}:${process.env.PATH}`,
      REAL_NODE,
      NODE_STUB: join(SCRATCH, "node-stub.mjs"),
      REPO_ROOT: REPO,
      STUB_SHA_MODE: "bindings",
      DISTTAG_LOG: dt,
      NFAIL_COUNT: nfail,
      ...extraEnv,
    },
  });
  return { status: r.status, stderr: r.stderr, dt: readFileSync(dt, "utf8"), stdout: r.stdout };
}

describe("item 1 (A1c of #1671, round 5): a mid-promote failure RESTORES the moved tags", () => {
  test("(a) the 3rd dist-tag add fails => RESTORE lines for exactly the two moved packages, no `rm`", () => {
    const r = runPromoteBlock({ NFAIL_FAIL_ON: "3" });
    expect(r.status, `stderr:\n${r.stderr}`).not.toBe(0);
    const moves = r.dt.split("\n").filter((l) => l.startsWith("dist-tag add "));
    expect(moves.length).toBe(2);
    expect(moves[0]).toContain(PACKAGES[0]);
    expect(moves[1]).toContain(PACKAGES[1]);
    // The RESTORE lines restore each moved package to its PREVIOUS latest (1.2.2).
    expect(r.stderr).toContain(`npm dist-tag add ${PACKAGES[0]}@1.2.2 latest`);
    expect(r.stderr).toContain(`npm dist-tag add ${PACKAGES[1]}@1.2.2 latest`);
    // Never a delete, and the not-moved set is named (the failed package included).
    expect(r.stderr).not.toContain("dist-tag rm");
    expect(r.stderr).toContain("ABORTED");
    expect(r.stderr).toContain("NOT moved");
    expect(r.stderr).toContain(PACKAGES[2]);
    expect(r.dt).not.toContain(PACKAGES[2]);
  });

  test("(b) the skew check fails after EVERY move => RESTORE lines for all moved packages, no `rm`", () => {
    const r = runPromoteBlock({ SKEW_FAIL: "1" });
    const combined = `${r.stdout}${r.stderr}`;
    expect(r.status, `stderr:\n${r.stderr}`).not.toBe(0);
    const moves = r.dt.split("\n").filter((l) => l.startsWith("dist-tag add "));
    expect(moves.length).toBe(PACKAGES.length); // every move succeeded before the skew check
    for (const p of PACKAGES) expect(combined).toContain(`npm dist-tag add ${p}@1.2.2 latest`);
    expect(combined).not.toContain("dist-tag rm");
    expect(combined).toContain("convergence check found skew");
    expect(combined).not.toContain("none is still on its previous latest");
  });

  test("(c) the pre-move dist-tag ls fails for one package => no add is reached, and it is named", () => {
    const r = runPromoteBlock({ DISTTAG_LS_FAIL_PKG: PACKAGES[2] });
    expect(r.status, `stderr:\n${r.stderr}`).not.toBe(0);
    expect(r.dt).toBe(""); // no dist-tag add was ever reached
    expect(r.stderr).toContain(PACKAGES[2]);
    expect(r.stderr).toContain("could not read the current latest");
    expect(r.stderr).toContain("NOTHING has moved");
  });

  test("(d) npm prints `latest: 1.2.2` but EXITS 1 => no add reached, package named", () => {
    const r = runPromoteBlock({ DISTTAG_LS_PRINTFAIL_PKG: PACKAGES[1] });
    expect(r.status, `stderr:\n${r.stderr}`).not.toBe(0);
    expect(r.dt).toBe(""); // the failed read stopped the block BEFORE the first move
    expect(r.stderr).toContain(PACKAGES[1]);
    expect(r.stderr).toContain("unmeasurable is FAIL");
  });

  test("(e) a CRLF `latest: 1.2.2\\r\\n` read yields a CLEAN previous (no CR in the RESTORE line)", () => {
    const r = runPromoteBlock({ DISTTAG_LS_CR: "1", NFAIL_FAIL_ON: "2" }); // 2nd move fails => RESTORE lines
    expect(r.status, `stderr:\n${r.stderr}`).not.toBe(0);
    // The recorded previous is exactly 1.2.2, so the restore line is well-formed.
    expect(r.stderr).toContain(`npm dist-tag add ${PACKAGES[0]}@1.2.2 latest`);
    expect(r.stderr).not.toContain("1.2.2\r");
    expect(r.stderr).not.toContain("\r");
  });

  test("(f) a non-version `latest: garbage` read => stop before any move, value named", () => {
    const r = runPromoteBlock({ DISTTAG_LS_GARBAGE: "1" });
    expect(r.status, `stderr:\n${r.stderr}`).not.toBe(0);
    expect(r.dt).toBe("");
    expect(r.stderr).toContain("garbage");
    expect(r.stderr).toContain("is not a version");
  });

  test("(g) an add that APPLIES its tag then exits 1 => that package is ATTEMPTED and RESTORED too", () => {
    const failed = PACKAGES[1]!;
    // The stub compares the FULL argv token (pkg@version).
    const r = runPromoteBlock({ DISTTAG_APPLY_THEN_FAIL: `${failed}@${VER}` });
    expect(r.status, `stderr:\n${r.stderr}`).not.toBe(0);
    // The add DID apply (the stub logged it) and then exited non-zero.
    expect(r.dt).toContain(`dist-tag add ${failed}@${VER}`);
    // The attempted package gets its own restore line (state UNKNOWN).
    expect(r.stderr).toContain(`npm dist-tag add ${failed}@1.2.2 latest`);
    expect(r.stderr).toContain("ATTEMPTED");
    expect(r.stderr).toContain("UNKNOWN");
    // The NOT-moved list is only the packages NEVER attempted (after the failed one).
    const notMoved = r.stderr.slice(r.stderr.indexOf("NOT moved"));
    expect(notMoved).toContain(PACKAGES[2]!);
    expect(notMoved).not.toContain(failed);
  });

  test("(h) a final-check READ failure => no sentence asserts the packages' state; all attempted restored", () => {
    const r = runPromoteBlock({ SKEW_FAIL: "2" }); // registry-latest-skew exits 2 (could not run)
    const combined = `${r.stdout}${r.stderr}`;
    expect(r.status, `stderr:\n${r.stderr}`).not.toBe(0);
    expect(combined).toContain("DID NOT RUN");
    expect(combined).toContain("could not establish the current tag state");
    expect(combined).not.toContain("none is still on its previous latest");
    for (const p of PACKAGES) expect(combined).toContain(`npm dist-tag add ${p}@1.2.2 latest`);
    expect(r.status).not.toBe(0);
  });
});

describe("round 8: the emitted block promises an EQUALITY check, not freshness", () => {
  test("a PASS block with an unchanged certified digest does not promise a freshness refusal", () => {
    const cert = rederivedDigest("sha:");
    const r = runVerdict(["pass", VER, RUN_URL, "--os", "ubuntu-latest", "--package-set-digest", cert]);
    expect(r.status, "stderr:\n" + r.stderr).toBe(0);
    const out = `${r.stdout}${r.stderr}`;
    // No sentence claims a stale PASS or a paste-from-a-FAIL is necessarily refused.
    expect(out).not.toContain("stale PASS");
    expect(out).not.toContain("paste from a FAIL");
    // It says what the check actually is.
    expect(out).toContain("EQUALITY check");
    expect(out).toContain("not a freshness check");
    expect(out).toContain("a different package set is refused");
  });
});
