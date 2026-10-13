/**
 * doctor-embedding-space-health-2530.test.ts — flair#2530, the ACTUAL
 * `flair doctor` command against a real local HTTP /Health response.
 *
 * Health.get puts the embedding-space guard's verdict (`embeddingSpace`) on the
 * public /Health body, including its readiness 503 (search routes not mounted:
 * the boot window, when the guard is usually still unverified). Doctor must
 * report that state from both a 200 and a 503 with Flair's /Health shape,
 * without calling the 503 healthy; must not read a verdict from a 503 without
 * those fields; and must count only a mixed store as an issue.
 *
 * The server is a plain node HTTP listener on an ephemeral loopback port that
 * answers /Health with a fixed status + body and 404s everything else. Doctor
 * runs all its other checks too, under an isolated HOME with no admin password
 * and a closed ops port; this file asserts only the guard lines, the not-ready
 * line, and the issue counts of three 200 responses that differ only in the
 * guard verdict.
 *
 * Mutation checks: delete the `renderEmbeddingSpaceDoctorFinding(...)` call from
 * the doctor action (src/commands/doctor.ts) and rebuild, and the 200 and
 * Flair-503 guard-line assertions go red (the non-Flair-503 negative assertions
 * stay green). Keep the call but drop its `issues +=` and the issue-count
 * assertion goes red.
 *
 * Build prerequisite: dist/cli.js (`bun run build:cli`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "dist", "cli.js");
const VERSION = (JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8")) as { version: string }).version;

let home: string;
let closedOpsPort: number;
const servers: Server[] = [];

/** A loopback port nothing listens on (doctor's ops reads fail fast there). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** Serve /Health with `status` + `body`; returns the port. */
async function serveHealth(status: number, body: Record<string, unknown>): Promise<number> {
  const srv = createServer((req, res) => {
    if ((req.url ?? "").split("?")[0] === "/Health") {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as AddressInfo).port;
  if (port === 9925 || port === 9926) throw new Error("refusing a production port");
  return port;
}

/** The body Health.get builds (resources/search-readiness.ts buildPublicHealthBody + the guard field). */
function flairHealthBody(ready: boolean, embeddingSpace: Record<string, unknown>): Record<string, unknown> {
  return {
    ok: ready,
    version: VERSION,
    buildCommit: null,
    searchReady: ready,
    ...(ready ? {} : { searchReadyReason: "search routes not mounted (Memory, SemanticSearch)" }),
    capabilities: ["memory-reembed-patch"],
    embeddingSpace,
  };
}

/** The issue count in doctor's summary line ("N issue(s) found", or 0 for "No issues found"). */
function issueCount(stdout: string): number {
  if (stdout.includes("No issues found")) return 0;
  const m = /(\d+) issues? found/.exec(stdout);
  if (!m) throw new Error(`no doctor summary line in:\n${stdout}`);
  return Number(m[1]);
}

function runDoctor(port: number): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HOME: home,
      FLAIR_URL: "",
      FLAIR_TOKEN: "",
      FLAIR_OPS_PORT: String(closedOpsPort),
      NO_COLOR: "1",
    };
    delete env.FLAIR_ADMIN_PASS;
    delete env.FLAIR_AGENT_ID;
    const child = spawn(process.execPath, [CLI, "doctor", "--port", String(port)], { env, timeout: 90_000 });
    let stdout = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", () => {});
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal !== null) { reject(new Error(`flair doctor overran: ${signal}\n${stdout}`)); return; }
      resolve({ code, stdout });
    });
  });
}

describe("flair doctor reports the embedding-space guard from /Health (flair#2530)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "flair-doctor-2530-"));
    closedOpsPort = await freePort();
  });

  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test("200: the guard state is reported, and a mixed store is a blocking finding", async () => {
    const port = await serveHealth(200, flairHealthBody(true, { state: "mixed", reason: null }));
    const { stdout } = await runDoctor(port);
    expect(stdout).toContain(`Harper responding on port ${port}`);
    expect(stdout).toContain("the store has mixed embedding spaces");
    expect(stdout).toContain("flair reembed --stale-only");
  }, 120_000);

  test("Flair readiness 503: the guard state is reported and the server is NOT called healthy", async () => {
    const port = await serveHealth(503, flairHealthBody(false, { state: "unverified", reason: null }));
    const { stdout } = await runDoctor(port);
    expect(stdout).toContain("embedding space not yet verified");
    expect(stdout).toContain("not serving search (search routes not mounted (Memory, SemanticSearch))");
    expect(stdout).not.toContain(`Harper responding on port ${port}`);
  }, 120_000);

  test("only a mixed store weighs on the issue count and the exit status", async () => {
    // Same fixture, three 200 responses that differ only in the guard verdict.
    const runs: Record<string, { code: number | null; count: number }> = {};
    for (const state of ["uniform", "mixed", "scan-failed"]) {
      const reason = state === "scan-failed" ? "the Memory corpus scan failed" : null;
      const port = await serveHealth(200, flairHealthBody(true, { state, reason }));
      const { code, stdout } = await runDoctor(port);
      runs[state] = { code, count: issueCount(stdout) };
      // Doctor exits non-zero exactly when its summary counts an issue.
      expect(code, `${state}: exit status vs summary`).toBe(runs[state].count > 0 ? 1 : 0);
    }
    expect(runs.mixed.count - runs.uniform.count, "a mixed store adds exactly one issue").toBe(1);
    expect(runs.mixed.code).toBe(1);
    expect(runs["scan-failed"].count, "a failed scan is an advisory, not an issue").toBe(runs.uniform.count);
  }, 240_000);

  test("a 503 without Flair's /Health shape is not read as a guard verdict", async () => {
    // searchReady:false and a guard field, but no version or capabilities list.
    const port = await serveHealth(503, { ok: false, searchReady: false, embeddingSpace: { state: "mixed", reason: null } });
    const { stdout } = await runDoctor(port);
    expect(stdout).not.toContain("mixed embedding spaces");
    expect(stdout).not.toContain("not serving search");
  }, 120_000);
});
