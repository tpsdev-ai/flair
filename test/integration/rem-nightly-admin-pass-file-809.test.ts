/**
 * rem-nightly-admin-pass-file-809.test.ts — the nightly REM shim must pass
 * the admin-pass FILE PATH, never its value, and run-once must read it
 * through the shared credential resolver so the admin-gated dedup step runs.
 *
 * The valid case executes the shim `flair rem nightly enable` renders, then
 * the real CLI against a real HOME-isolated Harper instance, with the cycle
 * authenticated as an agent (FLAIR_AGENT_ID + key) exactly like the systemd
 * unit. Only `--admin-pass-file` supplies admin credentials in this fixture;
 * the cycle itself is agent-authenticated.
 *
 * The refusal cases point run-once at a missing / group-readable file: the
 * dedup step must report NOT RUN with the path and the remedy, and the
 * server-side stat file must not appear (no admin call was made).
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

const httpPort = (h: HarperInstance) => new URL(h.httpURL).port;
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

async function run(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(args, { env: baseEnv(), stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

function runCli(args: string[]) {
  return run([nodeBin(), CLI, ...args]);
}

function statPath(): string {
  return join(harper.installDir, ".flair", "rem-dedup-stats.json");
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
  test("the rendered shim passes the absolute file path and no secret value", () => {
    const shim = readFileSync(shimPath, "utf-8");
    expect(shim).toContain(`--admin-pass-file "${adminPassPath}"`);
    expect(shim).not.toContain(harper.admin.password);
  });

  test("run-once through the shim reaches the admin-gated dedup route", async () => {
    rmSync(statPath(), { force: true });
    const { stdout, stderr, exitCode } = await run(["sh", shimPath]);
    const text = stdout + stderr;
    expect(exitCode, text).toBe(0);
    expect(text).toContain("Dedup:      ");
    expect(text).not.toContain("dedup: not run");
    expect(text).not.toContain("Errors:");
    // The resource persisted the stat server-side: the admin call happened.
    expect(existsSync(statPath())).toBe(true);
  }, 180_000);

  test("a missing admin-pass file reports NOT RUN with the path and remedy, and makes no admin call", async () => {
    rmSync(statPath(), { force: true });
    const missing = join(home, "secrets", "missing-admin-pass");
    const { stdout, stderr, exitCode } = await runCli([
      "rem", "nightly", "run-once", "--agent", AGENT_ID,
      "--ops-port", opsPort(harper), "--admin-pass-file", missing,
    ]);
    const text = stdout + stderr;
    expect(exitCode, text).not.toBe(0);
    expect(text).toContain(`--admin-pass-file path does not exist: ${missing}`);
    expect(text).toContain("Dedup:      NOT RUN —");
    expect(text).toContain("chmod 600");
    expect(existsSync(statPath())).toBe(false);
  }, 120_000);

  test("a group-readable admin-pass file is refused, reports NOT RUN, and makes no admin call", async () => {
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
});
