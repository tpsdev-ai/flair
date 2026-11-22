/**
 * rem-nightly-admin-pass-file-809.test.ts — the nightly REM shim passes the
 * admin-pass FILE PATH as one shell argument, never its value; run-once reads
 * it through the shared credential resolver so the admin-gated dedup step and
 * the ops pending-candidate count run, while every agent-scoped call is signed
 * by the selected agent alone.
 *
 * The valid case executes the shim `flair rem nightly enable` renders, then
 * the real CLI against a real HOME-isolated Harper instance, with the selected
 * agent (FLAIR_AGENT_ID + key) as in the systemd unit. Agent-scoped calls are
 * signed by that agent; the dedup step and the pending-candidate count use the
 * admin credential read from `--admin-pass-file`. The signing test also sets
 * ambient admin and bearer credentials to show they do not take over the
 * agent-scoped calls.
 *
 * The refusal cases name a missing / group-readable file: the run must fail at
 * startup, before any cycle work, including a paused cycle and a dry run. The
 * dedup step reports NOT RUN with the path and remedy, no admin call is made,
 * and nothing is written.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { nodeBin } from "../helpers/node-runtime";
import { enableScheduler } from "../../src/rem/scheduler";

const CLI = join(process.cwd(), "dist", "cli.js");
const AGENT_ID = "rem-admin-fixture";
const ADMIN_FILE_REL = join("secrets", "admin-pass");

let harper: HarperInstance;
let home: string;
let adminPassPath: string;
let shimPath: string;

const opsPort = (h: HarperInstance) => new URL(h.opsURL).port;

function assertOwnInstance(h: HarperInstance): void {
  const http = new URL(h.httpURL);
  const ops = new URL(h.opsURL);
  for (const u of [http, ops]) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (http.port === ops.port || !h.process?.pid || !h.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${h.httpURL} / ${h.opsURL} is not an instance this test started`);
  }
}

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    HOME: home,
    FLAIR_URL: harper.httpURL,
    FLAIR_AGENT_ID: AGENT_ID,
    FLAIR_OPS_PORT: opsPort(harper),
  };
  delete env.FLAIR_ADMIN_PASS;
  delete env.HDB_ADMIN_PASSWORD;
  delete env.FLAIR_TOKEN;
  delete env.FLAIR_KEY_DIR;
  return env;
}

async function run(
  args: string[],
  opts: { env?: Record<string, string>; cwd?: string } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(args, {
    env: opts.env ?? baseEnv(),
    cwd: opts.cwd ?? process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

function runCli(args: string[], opts: { env?: Record<string, string>; cwd?: string } = {}) {
  return run([nodeBin(), CLI, ...args], opts);
}

function statPath(): string {
  return join(harper.installDir, ".flair", "rem-dedup-stats.json");
}

async function opsInsert(records: Record<string, unknown>[]): Promise<void> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify({
      operation: "insert",
      database: "flair",
      table: "MemoryCandidate",
      records,
    }),
  });
  if (res.status !== 200) throw new Error(`seed failed ${res.status}: ${await res.text()}`);
}

/**
 * A local recording proxy in front of the real instance. It preserves the
 * Authorization header the CLI actually sent, so the test can assert which
 * identity signed each agent-scoped call. Ops-API calls go directly to the
 * ops port and are not proxied.
 */
function startRecordingProxy(target: string) {
  const seen: { path: string; auth: string }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req: Request) {
      const incoming = new URL(req.url);
      const auth = req.headers.get("authorization") ?? "";
      seen.push({ path: incoming.pathname + incoming.search, auth });
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const body = hasBody ? new Uint8Array(await req.arrayBuffer()) : undefined;
      const headers = new Headers(req.headers);
      headers.delete("host");
      headers.delete("content-length");
      const upstream = await fetch(target + incoming.pathname + incoming.search, {
        method: req.method,
        headers,
        body,
      });
      const responseHeaders = new Headers();
      const contentType = upstream.headers.get("content-type");
      if (contentType) responseHeaders.set("content-type", contentType);
      return new Response(await upstream.arrayBuffer(), {
        status: upstream.status,
        headers: responseHeaders,
      });
    },
  });
  return { server, seen, url: `http://127.0.0.1:${server.port}` };
}

beforeAll(async () => {
  harper = await startHarper();
  assertOwnInstance(harper);
  home = mkdtempSync(join(tmpdir(), "flair-rem-809-"));
  const keysDir = join(home, ".flair", "keys");
  mkdirSync(keysDir, { recursive: true });
  const kp = nacl.sign.keyPair();
  writeFileSync(join(keysDir, `${AGENT_ID}.key`), Buffer.from(kp.secretKey.slice(0, 32)), { mode: 0o600 });

  const seeded = await fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify({
      operation: "insert",
      database: "flair",
      table: "Agent",
      records: [{
        id: AGENT_ID,
        name: AGENT_ID,
        role: "agent",
        publicKey: Buffer.from(kp.publicKey).toString("base64"),
        createdAt: new Date().toISOString(),
      }],
    }),
  });
  expect(seeded.status).toBe(200);

  // A real pending candidate in the real instance: the shim's ops-API count
  // must report it as nonzero, not merely avoid an error.
  await opsInsert([{
    id: "rem-admin-pending",
    agentId: AGENT_ID,
    claim: "A pending candidate seeded for the nightly count.",
    generatedBy: "test-seed",
    generatedAt: new Date().toISOString(),
    status: "pending",
    createdAt: new Date().toISOString(),
  }]);

  const secretsDir = join(home, "secrets");
  mkdirSync(secretsDir, { recursive: true });
  adminPassPath = join(home, ADMIN_FILE_REL);
  writeFileSync(adminPassPath, harper.admin.password, { mode: 0o600 });

  shimPath = join(home, "bin", "flair-rem-nightly");
  enableScheduler({
    agentId: AGENT_ID,
    flairUrl: harper.httpURL,
    hour: 3,
    minute: 0,
    flairBin: CLI,
    nodeBin: nodeBin(),
    adminPassFile: adminPassPath,
    platformOverride: "linux",
    homeOverride: home,
    shimPathOverride: shimPath,
    systemdTimerOverride: join(home, "systemd", "flair-rem-nightly.timer"),
    systemdServiceOverride: join(home, "systemd", "flair-rem-nightly.service"),
    templateRootOverride: join(process.cwd(), "templates"),
    skipLoad: true,
  });
}, 180_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (home) rmSync(home, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

describe("flair#809 — nightly REM admin credential file", () => {
  test("the rendered shim passes the absolute file path as one single-quoted argument and no secret value", () => {
    const shim = readFileSync(shimPath, "utf-8");
    expect(shim).toContain(`--admin-pass-file '${adminPassPath}'`);
    expect(shim).not.toContain(`--admin-pass-file "${adminPassPath}"`);
    expect(shim).not.toContain(harper.admin.password);
  });

  test("run-once through the shim reaches the admin-gated dedup route and reports the pending candidate count", async () => {
    rmSync(statPath(), { force: true });
    const { stdout, stderr, exitCode } = await run(["sh", shimPath], { cwd: home });
    const text = stdout + stderr;
    expect(exitCode, text).toBe(0);
    expect(text).toContain("Dedup:      ");
    expect(text).not.toContain("dedup: not run");
    expect(text).not.toContain("Errors:");
    expect(text).toMatch(/Pending:\s+1\b/);
    // The resource persisted the stat server-side: the admin call happened.
    expect(existsSync(statPath())).toBe(true);
  }, 180_000);

  test("a pending count the real ops API refuses prints as unknown with the reason, never 0, and fails the run (flair#2680)", async () => {
    // Only the count's credential is wrong: this proxy forwards the CLI's ops
    // request to the real instance with a wrong admin password, so real Harper
    // makes the refusal while the admin-authed dedup REST call still succeeds.
    const upstream = new URL(harper.opsURL);
    const statuses: number[] = [];
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req: Request) {
        const res = await fetch(upstream.href, {
          method: req.method,
          headers: {
            "Content-Type": "application/json",
            Authorization: "Basic " + btoa(`${harper.admin.username}:wrong-${harper.admin.password}`),
          },
          body: await req.text(),
        });
        statuses.push(res.status);
        return new Response(await res.arrayBuffer(), { status: res.status });
      },
    });
    try {
      if (proxy.port === 9925 || proxy.port === 9926 || String(proxy.port) === upstream.port) {
        throw new Error(`refusing to run: proxy port ${proxy.port} is not an ephemeral test port`);
      }
      rmSync(statPath(), { force: true });
      const { stdout, stderr, exitCode } = await runCli([
        "rem", "nightly", "run-once", "--agent", AGENT_ID,
        "--ops-port", String(proxy.port), "--admin-pass-file", adminPassPath,
      ]);
      const text = stdout + stderr;
      expect(statuses, text).toHaveLength(1);
      expect(statuses[0], text).toBeGreaterThanOrEqual(400);
      expect(text).toContain(`Pending:    unknown (ops API failed (${statuses[0]}))`);
      expect(text).not.toMatch(/Pending:\s+0\b/);
      expect(text).toContain("Status:     failed");
      expect(text).toContain(`Errors:\n  - pending-count: ops API failed (${statuses[0]})`);
      expect(text).not.toContain("dedup:");
      expect(exitCode, text).toBe(1);
      expect(existsSync(statPath())).toBe(true);
    } finally {
      proxy.stop(true);
    }
  }, 180_000);

  test("a shim path carrying shell syntax is executed literally: the file is read and no command runs", async () => {
    const evilDir = join(home, "secrets-evil");
    mkdirSync(evilDir, { recursive: true });
    const evilPath = join(evilDir, "admin pass 'single' \"double\" $(touch shell-executed-a) `touch shell-executed-b`");
    writeFileSync(evilPath, harper.admin.password, { mode: 0o600 });
    const evilShim = join(home, "bin", "flair-rem-nightly-evil");
    enableScheduler({
      agentId: AGENT_ID,
      flairUrl: harper.httpURL,
      hour: 3,
      minute: 0,
      flairBin: CLI,
      nodeBin: nodeBin(),
      adminPassFile: evilPath,
      platformOverride: "linux",
      homeOverride: home,
      shimPathOverride: evilShim,
      systemdTimerOverride: join(home, "systemd", "flair-rem-nightly-evil.timer"),
      systemdServiceOverride: join(home, "systemd", "flair-rem-nightly-evil.service"),
      templateRootOverride: join(process.cwd(), "templates"),
      skipLoad: true,
    });

    rmSync(statPath(), { force: true });
    rmSync(join(home, "shell-executed-a"), { force: true });
    rmSync(join(home, "shell-executed-b"), { force: true });

    const { stdout, stderr, exitCode } = await run(["sh", evilShim], { cwd: home });
    const text = stdout + stderr;
    expect(exitCode, text).toBe(0);
    expect(text).not.toContain("path does not exist");
    expect(existsSync(join(home, "shell-executed-a"))).toBe(false);
    expect(existsSync(join(home, "shell-executed-b"))).toBe(false);
    expect(existsSync(statPath())).toBe(true);
  }, 180_000);

  test("a missing admin-pass file fails at startup with NOT RUN on the paused path, before cycle work", async () => {
    rmSync(statPath(), { force: true });
    mkdirSync(join(home, ".flair"), { recursive: true });
    writeFileSync(join(home, ".flair", "rem.paused"), new Date().toISOString() + "\n", { mode: 0o600 });
    const missing = join(home, "secrets", "missing-admin-pass");
    try {
      const { stdout, stderr, exitCode } = await runCli([
        "rem", "nightly", "run-once", "--agent", AGENT_ID,
        "--ops-port", opsPort(harper), "--admin-pass-file", missing,
      ]);
      const text = stdout + stderr;
      expect(exitCode, text).not.toBe(0);
      expect(text).toContain(`--admin-pass-file path does not exist: ${missing}`);
      expect(text).toContain("Dedup:      NOT RUN —");
      expect(text).toContain("chmod 600");
      expect(text).not.toContain("Status:     paused");
      expect(existsSync(statPath())).toBe(false);
    } finally {
      rmSync(join(home, ".flair", "rem.paused"), { force: true });
    }
  }, 120_000);

  test("a missing admin-pass file fails at startup with NOT RUN on a dry run, before cycle work", async () => {
    rmSync(statPath(), { force: true });
    const missing = join(home, "secrets", "missing-admin-pass");
    const { stdout, stderr, exitCode } = await runCli([
      "rem", "nightly", "run-once", "--agent", AGENT_ID,
      "--ops-port", opsPort(harper), "--admin-pass-file", missing, "--dry-run",
    ]);
    const text = stdout + stderr;
    expect(exitCode, text).not.toBe(0);
    expect(text).toContain(`--admin-pass-file path does not exist: ${missing}`);
    expect(text).toContain("Dedup:      NOT RUN —");
    expect(text).toContain("chmod 600");
    expect(text).not.toContain("-- rem nightly run-once (dry-run) --");
    expect(existsSync(statPath())).toBe(false);
  }, 120_000);

  test("a group-readable admin-pass file is refused at startup, reports NOT RUN, and makes no admin call", async () => {
    rmSync(statPath(), { force: true });
    chmodSync(adminPassPath, 0o644);
    try {
      const { stdout, stderr, exitCode } = await runCli([
        "rem", "nightly", "run-once", "--agent", AGENT_ID,
        "--ops-port", opsPort(harper), "--admin-pass-file", adminPassPath,
      ]);
      const text = stdout + stderr;
      expect(exitCode, text).not.toBe(0);
      expect(text).toContain(`permissions 644 are too open`);
      expect(text).toContain(adminPassPath);
      expect(text).toContain("Dedup:      NOT RUN —");
      expect(existsSync(statPath())).toBe(false);
    } finally {
      chmodSync(adminPassPath, 0o600);
    }
  }, 120_000);

  test("agent-scoped calls are signed by the selected agent, never by ambient admin or bearer credentials", async () => {
    const ambientAdmin = harper.admin.password;
    const ambientToken = "ambient-bearer-token-809";
    const proxy = startRecordingProxy(harper.httpURL);
    try {
      rmSync(statPath(), { force: true });
      const env = {
        ...baseEnv(),
        FLAIR_URL: proxy.url,
        FLAIR_ADMIN_PASS: ambientAdmin,
        FLAIR_TOKEN: ambientToken,
        FLAIR_AGENT_ID: "other-agent",
      };
      const { stdout, stderr, exitCode } = await runCli([
        "rem", "nightly", "run-once", "--agent", AGENT_ID,
        "--ops-port", opsPort(harper), "--admin-pass-file", adminPassPath,
      ], { env });
      const text = stdout + stderr;
      expect(exitCode, text).toBe(0);

      const agentCalls = proxy.seen.filter(
        (s) => s.path !== "/Health" && s.path !== "/MemoryDedupStats",
      );
      expect(agentCalls.length).toBeGreaterThan(0);
      for (const call of agentCalls) {
        expect(call.auth.startsWith(`TPS-Ed25519 ${AGENT_ID}:`), `${call.path} was signed by neither the selected agent nor a refusal`).toBe(true);
        expect(call.auth).not.toContain(ambientAdmin);
        expect(call.auth).not.toContain(ambientToken);
      }
      const dedupCalls = proxy.seen.filter((s) => s.path === "/MemoryDedupStats");
      expect(dedupCalls.length).toBe(1);
      expect(dedupCalls[0].auth.startsWith("Basic ")).toBe(true);
    } finally {
      proxy.server.stop(true);
    }
  }, 180_000);

  test("a selected agent with no key is refused instead of using an ambient admin credential", async () => {
    const env = {
      ...baseEnv(),
      FLAIR_ADMIN_PASS: harper.admin.password,
      FLAIR_AGENT_ID: "other-agent",
    };
    const { stdout, stderr, exitCode } = await runCli([
      "rem", "nightly", "run-once", "--agent", "no-key-agent",
      "--ops-port", opsPort(harper), "--admin-pass-file", adminPassPath,
    ], { env });
    const text = stdout + stderr;
    expect(exitCode, text).not.toBe(0);
    expect(text).toContain("has no signing key");
    expect(text).not.toContain("Dedup:      ");
  }, 120_000);

  test("the packaged enable command bakes a custom --admin-pass-file path into the rendered shim", async () => {
    const enableHome = mkdtempSync(join(tmpdir(), "flair-rem-809-enable-"));
    const customPath = join(enableHome, "custom secrets", "admin pass");
    const emptyPath = join(enableHome, "empty-bin");
    mkdirSync(emptyPath, { recursive: true });
    try {
      const env: Record<string, string> = {
        ...process.env as Record<string, string>,
        HOME: enableHome,
        FLAIR_URL: harper.httpURL,
        // No service manager on PATH: the test inspects the rendered shim;
        // it does not load a user unit.
        PATH: emptyPath,
      };
      delete env.FLAIR_AGENT_ID;
      await run([nodeBin(), CLI, "rem", "nightly", "enable", "--agent", AGENT_ID, "--admin-pass-file", customPath], {
        env,
        cwd: enableHome,
      });
      const renderedShim = join(enableHome, ".flair", "bin", "flair-rem-nightly");
      expect(existsSync(renderedShim)).toBe(true);
      const shim = readFileSync(renderedShim, "utf-8");
      expect(shim).toContain(`--admin-pass-file '${customPath}'`);
      expect(shim).not.toContain("--admin-pass-file '" + join(enableHome, ".flair", "admin-pass") + "'");
    } finally {
      rmSync(enableHome, { recursive: true, force: true });
    }
  }, 120_000);
});
