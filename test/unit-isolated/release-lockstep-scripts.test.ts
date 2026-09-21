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
