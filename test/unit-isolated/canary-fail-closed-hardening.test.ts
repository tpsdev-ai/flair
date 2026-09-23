/**
 * canary-fail-closed-hardening.test.ts — flair#1856 round 2.
 *
 * The post-publish canary is the last gate before `latest` moves. Its sha256
 * helpers had a FAIL-OPEN: they decided "am I the entry point?" with
 * `resolve(process.argv[1]) === fileURLToPath(import.meta.url)`. `resolve()` does
 * not follow symlinks, but Node builds `import.meta.url` for the entry module
 * from the REAL path — so a checkout reached through a symlink made that
 * comparison false. The script then loaded, skipped `main()`, printed NOTHING and
 * exited 0. In the workflow a zero exit counted as success, so an empty sha could
 * reach `LOCKSTEP_SHAS`, and the line-count check counts LINES, not VALUES. An
 * unmeasurable tarball must never read as a pass.
 *
 * These tests exercise the fail-closed contract end to end, with no network and
 * no real npm: a stub `npm` resolves tarballs to a local HTTP server, and a stub
 * `node` can simulate "the helper printed nothing". Every case is run the way the
 * gate runs it — through a SYMLINKED path — so a regression to `resolve()` turns
 * this file red.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import yaml from "js-yaml";

const REPO = join(import.meta.dir, "..", "..");
const CANARY_YML = join(REPO, ".github", "workflows", "canary.yml");
const SHA_SCRIPT = join(REPO, "scripts", "ci", "registry-tarball-sha256.mjs");
const LOCKSTEP_SCRIPT = join(REPO, "scripts", "ci", "lockstep-packages.mjs");
const VERDICT_SCRIPT = join(REPO, "scripts", "ci", "canary-verdict.sh");
const { lockstepPackages } = await import("../../scripts/ci/lockstep-packages.mjs");

const RUN_URL = "https://github.com/tpsdev-ai/flair/actions/runs/42";
const PACKAGES: string[] = lockstepPackages();

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

/** A distinct, valid 64-hex sha per package, so a mis-bound line is detectable. */
function shaFor(pkg: string): string {
  return createHash("sha256").update(`sha:${pkg}`).digest("hex");
}
/** The stub "hashed" sha for `<pkg>` in ok/flair-only modes. */
function stubSha(pkg: string): string {
  return createHash("sha256").update(`stub:${pkg}`).digest("hex");
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

const npmStub = [
  "#!/usr/bin/env bash",
  "set -uo pipefail",
  'if [ "${1:-}" = "view" ] && [ "${3:-}" = "dist.tarball" ]; then',
  '  base="$(cat "$FIXTURES")"; spec="$2"',
  '  printf \'%s/%s@%s.tgz\\n\' "$base" "${spec%@*}" "${spec##*@}"',
  "fi",
  "exit 0",
].join("\n");

// ── the stub `node`: it can simulate "the helper printed nothing" ───────────
// Modes (env STUB_SHA_MODE):
//   ok         — a distinct 64-hex sha per package (the happy path)
//   flair-only — @tpsdev-ai/flair hashes; every OTHER package prints NOTHING
//   bindings   — sha256("sha:" + pkg), matching the bindings this test emits
//   empty      — prints nothing for every package
const nodeStub = [
  "#!/usr/bin/env node",
  "import { createHash } from 'node:crypto';",
  "import { spawnSync } from 'node:child_process';",
  "import { join as require_join } from 'node:path';",
  "const args = process.argv.slice(2);",
  "const joined = args.join(' ');",
  "if (joined.includes('lockstep-packages.mjs')) {",
  "  const abs = args.map((a, i) => (i === 0 ? require_join(process.env.REPO_ROOT, a) : a));",
  "  const r = spawnSync(process.env.REAL_NODE, abs, { cwd: process.env.REPO_ROOT, encoding: 'utf8' });",
  "  if (r.stdout) process.stdout.write(r.stdout);",
  "  if (r.stderr) process.stderr.write(r.stderr);",
  "  process.exit(r.status ?? 1);",
  "}",
  "if (joined.includes('registry-tarball-sha256.mjs')) {",
  "  const mode = process.env.STUB_SHA_MODE || 'ok';",
  "  const pkg = args[args.length - 1];",
  "  if (mode === 'empty') process.exit(0);",
  "  if (mode === 'flair-only' && pkg !== '@tpsdev-ai/flair') process.exit(0);",
  "  const seed = mode === 'bindings' ? 'sha:' : 'stub:';",
  "  process.stdout.write(createHash('sha256').update(seed + pkg).digest('hex') + '\\n');",
  "  process.exit(0);",
  "}",
  "// Any other node script the gate runs (registry-latest-skew) is a no-op here.",
  "process.exit(0);",
].join("\n");

writeFileSync(join(BIN, "npm"), npmStub);
writeFileSync(join(SCRATCH, "node-stub.mjs"), nodeStub);
// A `node` shim on the PATH can simulate "the helper printed nothing" for the
// workflow step. It lives in its OWN dir so the direct-helper tests keep real
// node.
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

// ── the workflow step: an unmeasurable sha must not become a partial set ─────
function shaStepScript(): string {
  const wf = yaml.load(readFileSync(CANARY_YML, "utf8")) as {
    jobs: { canary: { steps: { id?: string; run?: string }[] } };
  };
  const step = wf.jobs.canary.steps.find((s) => s.id === "sha");
  if (!step?.run) throw new Error("canary.yml has no step id 'sha' with a run: block");
  return step.run;
}

function runShaStep(mode: string): { status: number | null; stdout: string; envFile: string } {
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
      VERSION: "0.55.1",
      EXPECTED: stubSha("@tpsdev-ai/flair"),
    },
  });
  return { status: r.status, stdout: `${r.stdout}${r.stderr}`, envFile: readFileSync(genv, "utf8") };
}

describe("the workflow's sha guard rejects an unmeasurable sha (flair#1856 R2)", () => {
  test("a helper that exits 0 with NO output does NOT reach LOCKSTEP_SHAS", () => {
    // flair + a correct sha, but every OTHER package prints nothing. Before the
    // guard the step exited 0 and wrote eight `pkg=` (empty) bindings: the count
    // check counted lines, not values.
    const r = runShaStep("flair-only");
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("unmeasurable is FAIL");
    expect(r.envFile).not.toContain("LOCKSTEP_SHAS");
    // No `pkg=` line with an empty value ever leaves the step.
    expect(/(^|\n)[^\n=]+=\n/.test(r.envFile)).toBe(false);
  });

  test("positive control: every sha is 64-hex => the step passes and writes all bindings", () => {
    const r = runShaStep("ok");
    expect(r.status).toBe(0);
    expect(r.envFile).toContain("LOCKSTEP_SHAS<<EOF");
    const lines = r.envFile.split("\n").filter((l) => /^@/.test(l));
    expect(lines.length).toBe(PACKAGES.length);
    for (const line of lines) expect(line).toMatch(/^@[^=]+=[0-9a-f]{64}$/);
  });
});

// ── canary-verdict: a malformed binding is DID NOT RUN, naming the package ───
function runVerdict(args: string[]) {
  return spawnSync("bash", [VERDICT_SCRIPT, ...args], { encoding: "utf8", cwd: REPO });
}
function bindings(): string[] {
  return PACKAGES.map((p) => `${p}=${shaFor(p)}`);
}

describe("canary-verdict refuses a malformed binding, naming the package (flair#1856 R2)", () => {
  test("an empty binding is DID NOT RUN", () => {
    const bad = bindings().map((b) => (b.startsWith("@tpsdev-ai/flair-client=") ? "@tpsdev-ai/flair-client=" : b));
    const r = runVerdict(["pass", "1.2.3", RUN_URL, ...bad]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("DID NOT RUN");
    expect(r.stderr).toContain("@tpsdev-ai/flair-client");
    expect(r.stdout).not.toContain("npm dist-tag add");
  });

  test("a 40-hex (SHA-1) binding is DID NOT RUN", () => {
    const bad = bindings().map((b) =>
      b.startsWith("@tpsdev-ai/flair-client=") ? "@tpsdev-ai/flair-client=0123456789abcdef0123456789abcdef01234567" : b,
    );
    const r = runVerdict(["pass", "1.2.3", RUN_URL, ...bad]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("@tpsdev-ai/flair-client");
    expect(r.stderr).toContain("64-char hex");
    expect(r.stdout).not.toContain("npm dist-tag add");
  });
});

// ── the emitted preflight: an unmeasurable re-hash is a refusal ─────────────
function emittedBlock(): string {
  const r = runVerdict(["pass", "1.2.3", RUN_URL, ...bindings()]);
  expect(r.status).toBe(0);
  const m = r.stdout.match(/```\n([\s\S]*?)\n```/);
  if (!m?.[1]) throw new Error("no fenced promote block in the PASS output");
  return m[1];
}

function runBlock(mode: string): number | null {
  const cwd = mkdtempSync(join(SCRATCH, "block-"));
  const f = join(cwd, "block.sh");
  writeFileSync(f, emittedBlock());
  const r = spawnSync("bash", [f], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${SHIM}:${BIN}:${process.env.PATH}`,
      REAL_NODE,
      NODE_STUB: join(SCRATCH, "node-stub.mjs"),
      REPO_ROOT: REPO,
      STUB_SHA_MODE: mode,
    },
  });
  return r.status;
}

describe("the emitted promote preflight never matches an unmeasured bytes set (flair#1856 R2)", () => {
  test("an empty re-hash refuses the whole preflight (no tag moves)", () => {
    expect(runBlock("empty")).not.toBe(0);
  });

  test("positive control: a re-hash that equals its binding lets the block run", () => {
    expect(runBlock("bindings")).toBe(0);
  });
});
