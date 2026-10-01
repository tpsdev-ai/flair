/**
 * release-lockstep-scripts.test.ts — flair#1781.
 *
 * Exercises the two registry-facing lockstep helpers against local fixtures (no
 * network, no real npm, no real dist-tag write):
 *   - registry-tarball-sha256.mjs honours the optional package argument
 *     (flair#1781) and keeps its exit-code contract (0 printed / 2 DID NOT RUN);
 *   - registry-latest-skew.mjs names the skewed packages and exits non-zero.
 *
 * A stub `npm` on PATH serves the fixtures: `view <pkg> dist.tarball` → a local
 * URL, `view <pkg> dist-tags.latest` → a fixture version.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO = join(import.meta.dirname, "..", "..");
const SHA_SCRIPT = join(REPO, "scripts", "ci", "registry-tarball-sha256.mjs");
const SKEW_SCRIPT = join(REPO, "scripts", "ci", "registry-latest-skew.mjs");
const { lockstepPackages } = await import("../../scripts/ci/lockstep-packages.mjs");

const SCRATCH = mkdtempSync(join(tmpdir(), "flair-1781-lockstep-"));
const BIN = join(SCRATCH, "bin");
const FIXTURES = join(SCRATCH, "fixtures.json");
const NPM_LOG = join(SCRATCH, "npm.log");
mkdirSync(BIN, { recursive: true });
writeFileSync(NPM_LOG, "");
writeFileSync(
  join(BIN, "npm"),
  [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const [, , cmd, arg, field] = process.argv;",
    "fs.appendFileSync(process.env.NPM_LOG, `${cmd} ${arg} ${field}\\n`);",
    "const fixtures = JSON.parse(fs.readFileSync(process.env.FIXTURES, 'utf8'));",
    "let pkg = arg;",
    "if (field === 'dist.tarball') { const a = arg.indexOf('@'); const b = arg.lastIndexOf('@'); if (b > a) pkg = arg.slice(0, b); }",
    "const f = fixtures[pkg];",
    "if (!f) { process.stderr.write(`no fixture for ${pkg}\\n`); process.exit(1); }",
    "if (field === 'dist.tarball') { process.stdout.write(f.tarball + '\\n'); process.exit(0); }",
    "if (field === 'dist-tags.latest') { process.stdout.write(f.latest + '\\n'); process.exit(0); }",
    "process.stderr.write(`unexpected field ${field}\\n`); process.exit(1);",
    "",
  ].join("\n"),
);
chmodSync(join(BIN, "npm"), 0o755);

const servers: Server[] = [];
function listen(srv: Server): Promise<number> {
  servers.push(srv);
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve((srv.address() as { port: number }).port)));
}

afterAll(() => {
  for (const s of servers) s.close();
  rmSync(SCRATCH, { recursive: true, force: true });
});

async function runNode(script: string, args: string[]): Promise<{ stdout: string; stderr: string; status: number | null }> {
  const env = { ...process.env, PATH: `${BIN}:${process.env.PATH}`, FIXTURES, NPM_LOG };
  const proc = Bun.spawn(["node", script, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const status = await proc.exited;
  return { stdout, stderr, status };
}

function setFixtures(map: Record<string, { tarball?: string; latest?: string }>): void {
  writeFileSync(FIXTURES, JSON.stringify(map));
}

describe("registry-tarball-sha256 — optional package argument", () => {
  test("hashes the NAMED package's published tarball (default stays @tpsdev-ai/flair)", async () => {
    const bytes = Buffer.from("published-tarball-bytes-for-pi-flair");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const srv = createServer((_req, res) => { res.writeHead(200); res.end(bytes); });
    const port = await listen(srv);
    setFixtures({ "@tpsdev-ai/pi-flair": { tarball: `http://127.0.0.1:${port}/pi.tgz` } });

    const named = await runNode(SHA_SCRIPT, ["0.55.1", "@tpsdev-ai/pi-flair"]);
    expect(named.status).toBe(0);
    expect(named.stdout.trim()).toBe(sha);
    expect(readFileSync(NPM_LOG, "utf8")).toContain("view @tpsdev-ai/pi-flair@0.55.1 dist.tarball");
  });

  test("a bad package argument is DID NOT RUN (exit 2), never a spec", async () => {
    const r = await runNode(SHA_SCRIPT, ["0.55.1", "Not A Package"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage:");
  });

  test("a bad version is still DID NOT RUN (exit 2)", async () => {
    const r = await runNode(SHA_SCRIPT, ["nope"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage:");
  });

  test("accepts a hyphen inside a prerelease identifier (flair#1781 R4)", async () => {
    const bytes = Buffer.from("prerelease-shaped-tarball-bytes");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const srv = createServer((_req, res) => { res.writeHead(200); res.end(bytes); });
    const port = await listen(srv);
    setFixtures({ "@tpsdev-ai/flair": { tarball: `http://127.0.0.1:${port}/rc.tgz` } });
    const r = await runNode(SHA_SCRIPT, ["1.2.3-rc-1"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(sha);
  });

  test("still strict: a leading \"v\" or a non-semver version is DID NOT RUN", async () => {
    expect((await runNode(SHA_SCRIPT, ["v1.2.3"])).status).toBe(2);
    expect((await runNode(SHA_SCRIPT, ["0.55.1.rc"])).status).toBe(2);
  });
});

describe("registry-latest-skew — the lockstep set must agree on `latest`", () => {
  test("all packages equal => exit 0", async () => {
    const map: Record<string, { latest: string }> = {};
    for (const p of lockstepPackages()) map[p] = { latest: "0.55.1" };
    setFixtures(map);
    const r = await runNode(SKEW_SCRIPT, []);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("agree on latest 0.55.1");
  });

  test("one package behind => non-zero, naming it", async () => {
    const map: Record<string, { latest: string }> = {};
    for (const p of lockstepPackages()) map[p] = { latest: "0.55.1" };
    map["@tpsdev-ai/flair-client"] = { latest: "0.54.2" };
    setFixtures(map);
    const r = await runNode(SKEW_SCRIPT, []);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("@tpsdev-ai/flair-client");
    expect(r.stderr).toContain("0.54.2");
  });

  test("expected-version mode: a package not at the expected version is skew", async () => {
    const map: Record<string, { latest: string }> = {};
    for (const p of lockstepPackages()) map[p] = { latest: "0.55.1" };
    setFixtures(map);
    const ok = await runNode(SKEW_SCRIPT, ["0.55.1"]);
    expect(ok.status).toBe(0);

    map["@tpsdev-ai/flair-mcp"] = { latest: "0.54.2" };
    setFixtures(map);
    const skew = await runNode(SKEW_SCRIPT, ["0.55.1"]);
    expect(skew.status).toBe(1);
    expect(skew.stderr).toContain("@tpsdev-ai/flair-mcp");
  });

  test("an unreadable tag is DID NOT RUN (exit 2), never a false green", async () => {
    const map: Record<string, { latest: string }> = {};
    for (const p of lockstepPackages()) map[p] = { latest: "0.55.1" };
    delete map["@tpsdev-ai/pi-flair"];
    setFixtures(map);
    const r = await runNode(SKEW_SCRIPT, []);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("DID NOT RUN");
    expect(r.stderr).toContain("@tpsdev-ai/pi-flair");
  });
});

// ── flair#2140: the wait mode (`--await`) of registry-latest-skew.mjs ────────────
//
// The promote block's final check read a stale `latest` straight after the last
// `npm dist-tag add` and printed RESTORE lines for a promote that had succeeded.
// The wait mode reads every `latest` from the registry's dist-tags endpoint
// (`npm dist-tag ls <pkg> --prefer-online`) and re-reads a package that is not yet
// at the expected version, with backoff, until the wait ends.
//
// This stub npm models the two registry surfaces separately:
//   - `view <pkg> dist-tags.latest` — the CDN-served package document: the
//     fixture's `view` value, which never changes during a test;
//   - `dist-tag ls <pkg> [--prefer-online]` — the dist-tags endpoint: the
//     fixture's `ls` list, one entry per read (the last entry repeats). `<fail>`
//     exits 1 (an unreadable read). An optional `delayMs` list (same indexing)
//     makes that read answer late.
// Every call is logged, one line per call, so a test can assert which surface
// the script read and how many times.
const WAIT_BIN = join(SCRATCH, "wait-bin");
const WAIT_STATE = join(SCRATCH, "wait-state");
const WAIT_FIXTURES = join(SCRATCH, "wait-fixtures.json");
const WAIT_LOG = join(SCRATCH, "wait-npm.log");
mkdirSync(WAIT_BIN, { recursive: true });
writeFileSync(
  join(WAIT_BIN, "npm"),
  [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const args = process.argv.slice(2);",
    "fs.appendFileSync(process.env.WAIT_LOG, args.join(' ') + '\\n');",
    "const fx = JSON.parse(fs.readFileSync(process.env.WAIT_FIXTURES, 'utf8'));",
    "if (args[0] === 'view' && args[2] === 'dist-tags.latest') {",
    "  const f = fx[args[1]];",
    "  if (!f || typeof f.view !== 'string') process.exit(1);",
    "  process.stdout.write(f.view + '\\n');",
    "  process.exit(0);",
    "}",
    "if (args[0] === 'dist-tag' && args[1] === 'ls') {",
    "  const f = fx[args[2]];",
    "  if (!f || !Array.isArray(f.ls)) process.exit(1);",
    "  const counter = path.join(process.env.WAIT_STATE, encodeURIComponent(args[2]));",
    "  const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;",
    "  fs.writeFileSync(counter, String(n + 1));",
    "  const v = f.ls[Math.min(n, f.ls.length - 1)];",
    "  const delay = Array.isArray(f.delayMs) ? f.delayMs[Math.min(n, f.delayMs.length - 1)] : 0;",
    "  setTimeout(() => {",
    "    if (v === '<fail>') process.exit(1);",
    "    process.stdout.write('latest: ' + v + '\\nnext: 9.9.9-rc.1\\n');",
    "    process.exit(0);",
    "  }, delay);",
    "  return;",
    "}",
    "process.stderr.write('unexpected npm call: ' + args.join(' ') + '\\n');",
    "process.exit(1);",
    "",
  ].join("\n"),
);
chmodSync(join(WAIT_BIN, "npm"), 0o755);

type WaitFixture = { view?: string; ls?: string[]; delayMs?: number[] };

/** Every lockstep package at `value` on both surfaces, then the overrides. */
function waitFixtures(value: string, overrides: Record<string, WaitFixture> = {}): Record<string, WaitFixture> {
  const map: Record<string, WaitFixture> = {};
  for (const p of lockstepPackages()) map[p] = { view: value, ls: [value] };
  for (const [p, f] of Object.entries(overrides)) map[p] = { ...map[p], ...f };
  return map;
}

/** `--previous <pkg>=<version>` for every lockstep package (or those given). */
function previousArgs(version: string, pkgs: string[] = lockstepPackages()): string[] {
  return pkgs.flatMap((p) => ["--previous", `${p}=${version}`]);
}

async function runWait(
  fixtures: Record<string, WaitFixture>,
  args: string[],
): Promise<{ stdout: string; stderr: string; status: number | null; calls: string[]; elapsedMs: number }> {
  rmSync(WAIT_STATE, { recursive: true, force: true });
  mkdirSync(WAIT_STATE, { recursive: true });
  writeFileSync(WAIT_FIXTURES, JSON.stringify(fixtures));
  writeFileSync(WAIT_LOG, "");
  const env = { ...process.env, PATH: `${WAIT_BIN}:${process.env.PATH}`, WAIT_FIXTURES, WAIT_STATE, WAIT_LOG };
  const started = performance.now();
  const proc = Bun.spawn(["node", SKEW_SCRIPT, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const status = await proc.exited;
  const elapsedMs = performance.now() - started;
  const calls = readFileSync(WAIT_LOG, "utf8").split("\n").filter((l) => l.length > 0);
  return { stdout, stderr, status, calls, elapsedMs };
}

const FLAIR = "@tpsdev-ai/flair";
const lsReadsOf = (calls: string[], pkg: string) => calls.filter((c) => c === `dist-tag ls ${pkg} --prefer-online`).length;

describe("registry-latest-skew --await — a promote the registry has not shown yet is not skew (flair#2140)", () => {
  test("the previous latest for the first 2 reads, then the expected one => converged (exit 0)", async () => {
    // The package document (`npm view`) stays on the previous latest for the WHOLE
    // test: the stale value the old check read for @tpsdev-ai/flair after the
    // v0.58.0 promote. Only the dist-tags endpoint catches up (after two reads).
    const fx = waitFixtures("0.58.0", { [FLAIR]: { view: "0.57.0", ls: ["0.57.0", "0.57.0", "0.58.0"] } });
    const r = await runWait(fx, ["0.58.0", "--await", "30", ...previousArgs("0.57.0")]);
    expect(r.status, `stderr:\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain(`all ${lockstepPackages().length} lockstep packages are at latest 0.58.0`);
    expect(r.stderr).toBe("");
    // It retried the lagging package until it read the expected version, and
    // read every other package once.
    expect(lsReadsOf(r.calls, FLAIR)).toBe(3);
    for (const p of lockstepPackages().filter((q) => q !== FLAIR)) expect(lsReadsOf(r.calls, p)).toBe(1);
    // Every read went to the dist-tags endpoint with --prefer-online; none read
    // the CDN-served document.
    expect(r.calls.length).toBe(lockstepPackages().length + 2);
    for (const c of r.calls) expect(c).toMatch(/^dist-tag ls \S+ --prefer-online$/);
    // It stopped as soon as the set converged, well inside the 30 s wait.
    expect(r.elapsedMs).toBeLessThan(20_000);
  }, 60_000);

  test("a package that never leaves its previous latest => NOT YET VISIBLE (exit 3), re-run before restoring", async () => {
    const fx = waitFixtures("0.58.0", { [FLAIR]: { view: "0.57.0", ls: ["0.57.0"] } });
    const r = await runWait(fx, ["0.58.0", "--await", "4", ...previousArgs("0.57.0")]);
    expect(r.status, `stderr:\n${r.stderr}`).toBe(3);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("lockstep latest not yet visible after 4 s — expected 0.58.0");
    expect(r.stderr).toContain(`   ${FLAIR}: latest 0.57.0`);
    expect(r.stderr).toContain("Re-run this check with the same arguments before restoring anything.");
    expect(r.stderr).not.toContain("skew");
    expect(r.stderr).not.toContain("DID NOT RUN");
    // Only the package still off the expected version is named.
    for (const p of lockstepPackages().filter((q) => q !== FLAIR)) expect(r.stderr).not.toContain(`${p}: latest`);
    // It retried (more than one read of the lagging package) and the wait is bounded.
    expect(lsReadsOf(r.calls, FLAIR)).toBeGreaterThanOrEqual(2);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(4_000);
    expect(r.elapsedMs).toBeLessThan(15_000);
  }, 60_000);

  test("a third version (neither expected nor the previous latest) => skew (exit 1), after the wait", async () => {
    const fx = waitFixtures("0.58.0", { [FLAIR]: { ls: ["0.56.0"] } });
    const r = await runWait(fx, ["0.58.0", "--await", "4", ...previousArgs("0.57.0")]);
    expect(r.status, `stderr:\n${r.stderr}`).toBe(1);
    expect(r.stderr).toContain("✗ lockstep latest skew — expected 0.58.0:");
    expect(r.stderr).toContain(`   ${FLAIR}: latest 0.56.0`);
    expect(r.stderr).not.toContain("not yet visible");
    expect(lsReadsOf(r.calls, FLAIR)).toBeGreaterThanOrEqual(2);
  }, 60_000);

  test("one package on its previous latest and another on a third version => skew (exit 1), both named", async () => {
    const mcp = "@tpsdev-ai/flair-mcp";
    const fx = waitFixtures("0.58.0", { [FLAIR]: { ls: ["0.57.0"] }, [mcp]: { ls: ["0.55.0"] } });
    const r = await runWait(fx, ["0.58.0", "--await", "3", ...previousArgs("0.57.0")]);
    expect(r.status, `stderr:\n${r.stderr}`).toBe(1);
    expect(r.stderr).toContain(`   ${FLAIR}: latest 0.57.0`);
    expect(r.stderr).toContain(`   ${mcp}: latest 0.55.0`);
    expect(r.stderr).not.toContain("not yet visible");
  }, 60_000);

  test("a package on a version with no --previous for it is not explained by lag => skew (exit 1)", async () => {
    const fx = waitFixtures("0.58.0", { [FLAIR]: { ls: ["0.57.0"] } });
    const others = lockstepPackages().filter((p) => p !== FLAIR);
    const r = await runWait(fx, ["0.58.0", "--await", "3", ...previousArgs("0.57.0", others)]);
    expect(r.status, `stderr:\n${r.stderr}`).toBe(1);
    expect(r.stderr).toContain(`   ${FLAIR}: latest 0.57.0`);
    expect(r.stderr).not.toContain("not yet visible");
  }, 60_000);

  test("a --previous in the promote block's step-2 shape (hyphen in the prerelease) is accepted", async () => {
    const fx = waitFixtures("0.58.0", { [FLAIR]: { ls: ["0.57.0-rc-1"] } });
    const r = await runWait(fx, ["0.58.0", "--await", "3", ...previousArgs("0.57.0-rc-1")]);
    expect(r.status, `stderr:\n${r.stderr}`).toBe(3);
    expect(r.stderr).toContain(`   ${FLAIR}: latest 0.57.0-rc-1`);
  }, 60_000);

  test("an unreadable latest => DID NOT RUN (exit 2), never converged and never 'not yet visible'", async () => {
    const pi = "@tpsdev-ai/pi-flair";
    const fx = waitFixtures("0.58.0", { [pi]: { ls: ["<fail>"] } });
    const r = await runWait(fx, ["0.58.0", "--await", "5", ...previousArgs("0.57.0")]);
    expect(r.status, `stderr:\n${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("DID NOT RUN");
    expect(r.stderr).toContain(pi);
    expect(r.stdout).toBe("");
  }, 60_000);

  test("a read that fails AFTER a lagging read => DID NOT RUN (exit 2), not 'not yet visible'", async () => {
    const fx = waitFixtures("0.58.0", { [FLAIR]: { ls: ["0.57.0", "<fail>"] } });
    const r = await runWait(fx, ["0.58.0", "--await", "5", ...previousArgs("0.57.0")]);
    expect(r.status, `stderr:\n${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("DID NOT RUN");
    expect(r.stderr).toContain(FLAIR);
    expect(r.stderr).not.toContain("not yet visible");
    expect(lsReadsOf(r.calls, FLAIR)).toBe(2);
  }, 60_000);

  test("a read whose latest is not a version => DID NOT RUN (exit 2)", async () => {
    const fx = waitFixtures("0.58.0", { [FLAIR]: { ls: ["garbage"] } });
    const r = await runWait(fx, ["0.58.0", "--await", "5", ...previousArgs("0.57.0")]);
    expect(r.status, `stderr:\n${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("DID NOT RUN");
    expect(r.stderr).toContain(FLAIR);
  }, 60_000);

  test("a first pass slower than the wait => DID NOT RUN (exit 2) at the end of the wait, naming the unread package", async () => {
    // @tpsdev-ai/flair is read last; its read would take 8 s, the wait is 3 s.
    const fx = waitFixtures("0.58.0", { [FLAIR]: { ls: ["0.58.0"], delayMs: [8_000] } });
    const r = await runWait(fx, ["0.58.0", "--await", "3", ...previousArgs("0.57.0")]);
    expect(r.status, `stderr:\n${r.stderr}`).toBe(2);
    expect(r.stderr).toContain(`DID NOT RUN — the 3 s wait ended before dist-tags.latest was read for: ${FLAIR}\n`);
    expect(r.stdout).toBe("");
    expect(r.elapsedMs).toBeGreaterThanOrEqual(3_000);
    expect(r.elapsedMs).toBeLessThan(6_000);
  }, 60_000);

  test("a re-read slower than the time left is cut at the end of the wait; the last read decides (exit 3)", async () => {
    // First read of @tpsdev-ai/flair: its previous latest, at once. Its re-read
    // would take 8 s; the wait is 4 s.
    const fx = waitFixtures("0.58.0", { [FLAIR]: { ls: ["0.57.0"], delayMs: [0, 8_000] } });
    const r = await runWait(fx, ["0.58.0", "--await", "4", ...previousArgs("0.57.0")]);
    expect(r.status, `stderr:\n${r.stderr}`).toBe(3);
    expect(r.stderr).toContain(`   ${FLAIR}: latest 0.57.0`);
    expect(lsReadsOf(r.calls, FLAIR)).toBe(2);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(4_000);
    expect(r.elapsedMs).toBeLessThan(7_000);
  }, 60_000);

  test("without --await the reads are unchanged: one `npm view` read per package, a lagging package is skew (exit 1)", async () => {
    const fx = waitFixtures("0.58.0", { [FLAIR]: { view: "0.57.0", ls: ["0.58.0"] } });
    const r = await runWait(fx, ["0.58.0"]);
    expect(r.status, `stderr:\n${r.stderr}`).toBe(1);
    expect(r.stderr).toContain("✗ lockstep latest skew — expected 0.58.0:");
    expect(r.stderr).toContain(`   ${FLAIR}: latest 0.57.0`);
    expect(r.calls).toEqual(lockstepPackages().map((p) => `view ${p} dist-tags.latest`));
  }, 60_000);

  test("usage errors are DID NOT RUN (exit 2) before any registry read", async () => {
    const fx = waitFixtures("0.58.0");
    const cases: string[][] = [
      ["--await", "5"], // no expected version
      ["0.58.0", "--await"], // no value
      ["0.58.0", "--await", "0"],
      ["0.58.0", "--await", "601"],
      ["0.58.0", "--await", "1.5"],
      ["0.58.0", "--await", "5", "--await", "5"],
      ["0.58.0", ...previousArgs("0.57.0")], // --previous without --await
      ["0.58.0", "--await", "5", "--previous", "0.57.0"], // no package
      ["0.58.0", "--await", "5", "--previous", `${FLAIR}=not-a-version`],
      ["0.58.0", "--await", "5", "--previous", "@tpsdev-ai/not-in-the-set=0.57.0"],
      ["0.58.0", "--await", "5", "--previous", `${FLAIR}=0.57.0`, "--previous", `${FLAIR}=0.57.0`],
      ["0.58.0", "--await", "5", "--surprise"],
      ["0.58.0", "extra"],
    ];
    for (const args of cases) {
      const r = await runWait(fx, args);
      expect(r.status, `args ${JSON.stringify(args)}\nstderr:\n${r.stderr}`).toBe(2);
      expect(r.stderr, `args ${JSON.stringify(args)}`).toContain("usage:");
      expect(r.calls, `args ${JSON.stringify(args)}`).toEqual([]);
    }
  }, 60_000);

  test("--await=<n> and --previous=<pkg>=<version> spellings are accepted", async () => {
    const fx = waitFixtures("0.58.0");
    const r = await runWait(fx, ["0.58.0", "--await=5", ...lockstepPackages().map((p) => `--previous=${p}=0.57.0`)]);
    expect(r.status, `stderr:\n${r.stderr}`).toBe(0);
    // It ran in the wait mode: one dist-tags read per package, no `npm view`.
    expect(r.calls).toEqual(lockstepPackages().map((p) => `dist-tag ls ${p} --prefer-online`));
  }, 60_000);
});
