/**
 * status-ops-bind.test.ts — `flair status` must agree with `flair doctor`
 * about the Harper ops-API bind (flair#852).
 *
 * The dogfood finding: after a stock `flair init`, `flair status` printed
 * "✓ all checks passing" while `flair doctor` reported the ops API was bound
 * to all interfaces. `status` only rendered the server's `/HealthDetail`
 * warnings, so a local install-health finding doctor already made was
 * invisible — a security-relevant exposure reported as green by the command
 * users trust for a green light.
 *
 * The fix makes the ops-API decision a single shared function
 * (`opsApiBindFinding`, src/lib/ops-api-bind.ts) that both commands call, and
 * folds the finding into status's existing warning verdict. These tests drive
 * the real `status` command as a subprocess (isolated $HOME + local HTTP mock)
 * because an in-process $HOME mutation does not re-read for os.homedir(); see
 * cli-auth-floor.test.ts's header for the same technique.
 *
 * Fails on the old code: the all-interfaces scenario printed
 * "all checks passing". Passes on the fix: it prints a warning instead, while
 * a loopback-bound instance still reports green.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import nacl from "tweetnacl";
import { opsApiBindFinding, detectOpsApiAllInterfacesBind } from "../../src/lib/ops-api-bind.ts";

function makeTmpDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function startMockFlairServer(healthDetail: Record<string, unknown>): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === "/Health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, version: "0.0.0" }));
        return;
      }
      if (req.url === "/HealthDetail") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(healthDetail));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}

async function runCli(args: string[], env: Record<string, string | undefined>): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cliPath = join(import.meta.dirname ?? __dirname, "..", "..", "src", "cli.ts");
  const merged: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  const proc = Bun.spawn(["bun", cliPath, ...args], { env: merged, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

function installedVersion(): string {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname ?? __dirname, "..", "..", "package.json"), "utf-8"));
  return String(pkg.version);
}

// ─── the shared decision (single source of truth doctor also uses) ──────────

describe("opsApiBindFinding — one decision for both health surfaces (flair#852)", () => {
  test("a bare numeric ops port (Harper's all-interfaces default) is a finding", () => {
    const finding = opsApiBindFinding({ operationsApi: { network: { port: 19925 } } });
    expect(finding?.allInterfaces).toBe(true);
    expect(finding?.portValue).toBe(19925);
  });

  test("a host-qualified loopback ops port is NOT a finding", () => {
    const finding = opsApiBindFinding({ operationsApi: { network: { port: "127.0.0.1:19925" } } });
    expect(finding?.allInterfaces).toBe(false);
    expect(finding?.boundHost).toBe("127.0.0.1");
  });

  test("a missing/empty config declares no ops bind — nothing to report", () => {
    expect(opsApiBindFinding(null)).toBeNull();
    expect(opsApiBindFinding({})).toBeNull();
    expect(opsApiBindFinding({ operationsApi: { network: { port: "" } } })).toBeNull();
  });

  test("the detector narrows only on loopback: bare and wildcard hosts flag, loopback does not", () => {
    expect(detectOpsApiAllInterfacesBind(19925).allInterfaces).toBe(true);
    expect(detectOpsApiAllInterfacesBind("0.0.0.0:19925").allInterfaces).toBe(true);
    expect(detectOpsApiAllInterfacesBind("[::]:19925").allInterfaces).toBe(true);
    expect(detectOpsApiAllInterfacesBind("127.0.0.1:19925").allInterfaces).toBe(false);
    expect(detectOpsApiAllInterfacesBind("localhost:19925").allInterfaces).toBe(false);
  });

  test("doctor still FAILS the same finding — the fix must not make doctor quieter", () => {
    // Hazard guard (flair#852): the disagreement is fixed by making status
    // honest, never by softening doctor. doctor must keep calling the shared
    // decision and counting an all-interfaces bind as an issue.
    const doctorSource = readFileSync(
      join(import.meta.dirname ?? __dirname, "..", "..", "src", "commands", "doctor.ts"),
      "utf-8",
    );
    const anchor = doctorSource.indexOf("opsApiBindFinding(readHarperConfig(defaultDataDir()))");
    expect(anchor).toBeGreaterThan(-1);
    const section = doctorSource.slice(anchor, anchor + 400);
    expect(section).toContain("finding?.allInterfaces");
    expect(section).toContain("issues++");
  });
});

// ─── command-level: status must not lie about a local all-interfaces bind ───

describe("flair status — ops-API bind agreement with doctor (flair#852)", () => {
  let tmpHome: string;
  let server: Server;
  let serverUrl: string;

  beforeEach(async () => {
    tmpHome = makeTmpDir("flair-852-home");
    const started = await startMockFlairServer({ warnings: [] });
    server = started.server;
    serverUrl = started.url;

    // A local install with a healthy server and no server-side warnings. The
    // ops-API bind is a LOCAL install-health fact, read from harper-config.yaml
    // exactly as doctor reads it.
    mkdirSync(join(tmpHome, ".flair", "data"), { recursive: true });
    mkdirSync(join(tmpHome, ".flair", "keys"), { recursive: true });
    const kp = nacl.sign.keyPair();
    writeFileSync(join(tmpHome, ".flair", "keys", "dogfood-agent.key"), Buffer.from(kp.secretKey.slice(0, 32)));

    // Pin the version cache to the installed version so `status` does not hit
    // the npm registry during the test (nudges do not affect the verdict, but
    // the network round trip would make the test slow and flaky).
    writeFileSync(
      join(tmpHome, ".flair", ".version-check-cache.json"),
      JSON.stringify({ latest: installedVersion(), checkedAt: Date.now() }),
    );
  });

  afterEach(async () => {
    await stopServer(server);
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  });

  function writeHarperConfig(opsPort: unknown, httpPort: number): void {
    const lines = [
      "http:",
      `  port: ${httpPort}`,
      "operationsApi:",
      "  network:",
      `    port: ${typeof opsPort === "string" ? `"${opsPort}"` : opsPort}`,
      "",
    ];
    writeFileSync(join(tmpHome, ".flair", "data", "harper-config.yaml"), lines.join("\n"));
  }

  const CLEAR_ENV = {
    FLAIR_ADMIN_PASS: undefined,
    HDB_ADMIN_PASSWORD: undefined,
    FLAIR_AGENT_ID: undefined,
    FLAIR_TOKEN: undefined,
    FLAIR_URL: undefined,
    FLAIR_TARGET: undefined,
  };

  test("all-interfaces bind: status does NOT report all-passing — it surfaces the same finding doctor makes", async () => {
    const port = new URL(serverUrl).port;
    writeHarperConfig(Number(port) - 1, Number(port));

    const { stdout, exitCode } = await runCli(
      ["status", "--target", serverUrl],
      { HOME: tmpHome, ...CLEAR_ENV },
    );

    // The lie this issue is about: a green verdict while a known exposure is
    // visible to doctor.
    expect(stdout).not.toContain("all checks passing");
    expect(stdout).toMatch(/Ops API bound to all interfaces/i);
    expect(stdout).toMatch(/1 warning/);
    // Status stays a non-fatal health readout — the warning is surfaced, not
    // converted into an "unreachable" failure.
    expect(exitCode).toBe(0);
  });

  test("all-interfaces bind: --json carries the warning so machine consumers cannot see a false green either", async () => {
    const port = new URL(serverUrl).port;
    writeHarperConfig(Number(port) - 1, Number(port));

    const { stdout, exitCode } = await runCli(
      ["status", "--target", serverUrl, "--json"],
      { HOME: tmpHome, ...CLEAR_ENV },
    );

    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(Array.isArray(out.warnings)).toBe(true);
    expect(out.warnings.some((w: any) => /Ops API bound to all interfaces/i.test(String(w.message)))).toBe(true);
  });

  test("wildcard host:port bind (--ops-bind 0.0.0.0): status does NOT report all-passing", async () => {
    // The exact flair#852 false-negative: `flair init --ops-bind 0.0.0.0`
    // persists `0.0.0.0:19925`. The old detector read any host:port as
    // narrowed, so status printed green while the ops API was reachable
    // off-box. It must now surface the finding like doctor.
    const port = new URL(serverUrl).port;
    writeHarperConfig(`0.0.0.0:${Number(port) - 1}`, Number(port));

    const { stdout, exitCode } = await runCli(
      ["status", "--target", serverUrl],
      { HOME: tmpHome, ...CLEAR_ENV },
    );

    expect(stdout).not.toContain("all checks passing");
    expect(stdout).toMatch(/Ops API bound to all interfaces/i);
    expect(stdout).toMatch(/1 warning/);
    expect(exitCode).toBe(0);
  });

  test("loopback-bound instance: status still reports a genuine green", async () => {
    const port = new URL(serverUrl).port;
    writeHarperConfig(`127.0.0.1:${Number(port) - 1}`, Number(port));

    const { stdout, exitCode } = await runCli(
      ["status", "--target", serverUrl],
      { HOME: tmpHome, ...CLEAR_ENV },
    );

    expect(stdout).toContain("all checks passing");
    expect(stdout).not.toMatch(/Ops API bound to all interfaces/i);
    expect(exitCode).toBe(0);
  });

  test("--deep also surfaces the finding instead of ending on 'no warnings'", async () => {
    const port = new URL(serverUrl).port;
    writeHarperConfig(Number(port) - 1, Number(port));

    const { stdout, exitCode } = await runCli(
      ["status", "deep", "--target", serverUrl],
      { HOME: tmpHome, ...CLEAR_ENV },
    );

    expect(stdout).not.toContain("✅ no warnings");
    expect(stdout).toMatch(/Ops API bound to all interfaces/i);
    expect(exitCode).toBe(0);
  });

  test("a remote target is not judged by the local install's harper config", async () => {
    // An operator checking a remote instance must not be told the REMOTE
    // instance is exposed because their own laptop's install is. The local
    // bind is a local fact, so a non-loopback target skips the check.
    const port = new URL(serverUrl).port;
    writeHarperConfig(Number(port) - 1, Number(port));

    const { stdout } = await runCli(
      ["status", "--target", "https://flair.example.invalid:19926"],
      { HOME: tmpHome, ...CLEAR_ENV },
    );

    // Unreachable remote — either way, it must not claim the remote instance
    // has an all-interfaces ops bind derived from the local config.
    expect(stdout).not.toMatch(/Ops API bound to all interfaces/i);
  });
});
