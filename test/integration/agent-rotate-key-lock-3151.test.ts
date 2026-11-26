// agent-rotate-key-lock-3151.test.ts — flair#3151 against a REAL Harper.
//
// Two `flair agent rotate-key` runs of ONE agent: the first stalls between the
// ops update and the rename (env-gated pause). The second must wait within the
// lock bound and then refuse, and after both finish the stored public key must
// match the private key on disk. A second case proves rotations of DIFFERENT
// agents do not block each other.
//
// Build prerequisite: dist/resources/*.js (`bun run build`).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";

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

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function publicKeyOfSeed(seed: Uint8Array): string {
  return b64url(nacl.sign.keyPair.fromSeed(seed).publicKey);
}

let harper: HarperInstance;
const cleanup: Array<() => void> = [];

async function ops(op: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify({ database: "flair", ...op }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  expect(res.status, `${op.operation} returned ${res.status}: ${text.slice(0, 300)}`).toBeLessThan(300);
  return text.length ? JSON.parse(text) : null;
}

async function storedPublicKey(id: string): Promise<string | undefined> {
  const rows = await ops({
    operation: "search_by_value",
    table: "Agent",
    search_attribute: "id",
    search_value: id,
    get_attributes: ["id", "publicKey"],
  });
  const row = Array.isArray(rows) ? rows.find((r: any) => r?.id === id) : undefined;
  return row?.publicKey;
}

/** Make a keys dir with one seeded private key and an Agent row for it. */
function seedAgent(id: string): { keysDir: string; keyPath: string } {
  const root = mkdtempSync(join(tmpdir(), "flair-3151-lock-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const keysDir = join(root, "keys");
  mkdirSync(keysDir, { recursive: true });
  const kp = nacl.sign.keyPair();
  const keyPath = join(keysDir, `${id}.key`);
  writeFileSync(keyPath, Buffer.from(kp.secretKey.slice(0, 32)));
  chmodSync(keyPath, 0o600);
  return { keysDir, keyPath };
}

function spawnRotate(id: string, keysDir: string, home: string, extraEnv: Record<string, string> = {}) {
  const cliPath = join(import.meta.dirname, "..", "..", "src", "cli.ts");
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const key of ["FLAIR_ADMIN_PASS", "FLAIR_AGENT_ID", "FLAIR_TOKEN", "HDB_ADMIN_PASSWORD", "FLAIR_KEY_DIR", "FLAIR_TEST_ROTATE_KEY_PAUSE"]) delete env[key];
  env.HOME = home;
  Object.assign(env, extraEnv);
  const proc = Bun.spawn(
    [
      "bun", cliPath, "agent", "rotate-key", id,
      "--ops-port", new URL(harper.opsURL).port,
      "--port", new URL(harper.httpURL).port,
      "--admin-pass", harper.admin.password,
      "--admin-user", harper.admin.username,
      "--keys-dir", keysDir,
    ],
    { env, stdout: "pipe", stderr: "pipe", timeout: 120_000 },
  );
  const pid = proc.pid;
  cleanup.push(() => {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  });
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  return { proc, stdout, stderr };
}

async function waitForFile(path: string, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`waited ${budgetMs} ms for ${path}`);
}

beforeAll(async () => {
  harper = await startHarper();
  assertOwnInstance(harper);
}, 180_000);

afterAll(async () => {
  for (const fn of cleanup.splice(0)) fn();
  if (harper) await stopHarper(harper);
}, HARPER_STOP_BUDGET_MS);

describe("flair#3151 — rotate-key holds a per-agent lock from key read to install", () => {
  test("(a) a second rotation of the same agent refuses while the first is stalled; the final key matches the stored public key", async () => {
    const id = "agent-a";
    const home = mkdtempSync(join(tmpdir(), "flair-3151-home-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const { keysDir, keyPath } = seedAgent(id);
    const seed = readFileSync(keyPath);
    await ops({
      operation: "insert",
      table: "Agent",
      records: [{
        id, name: id, role: "agent", admin: false, status: "active",
        publicKey: publicKeyOfSeed(seed), createdAt: new Date().toISOString(),
      }],
    });
    const lockPath = join(keysDir, `${id}.rotate-key.lock`);
    const base = join(home, "pause-a");

    const first = spawnRotate(id, keysDir, home, { FLAIR_TEST_ROTATE_KEY_PAUSE: base });
    await waitForFile(`${base}.ready`, 30_000);

    const second = spawnRotate(id, keysDir, home);
    const secondCode = await second.proc.exited;
    const secondErr = await second.stderr;

    writeFileSync(`${base}.go`, "");
    const firstCode = await first.proc.exited;
    const firstErr = await first.stderr;

    const onDisk = readFileSync(keyPath);
    expect(onDisk.equals(seed)).toBe(false);
    // The defect: the stored public key must match the private key on disk.
    expect(await storedPublicKey(id)).toBe(publicKeyOfSeed(onDisk));
    expect(firstCode, `${await first.stdout}\n${firstErr}`.slice(0, 800)).toBe(0);
    expect(secondCode, secondErr.slice(0, 800)).toBe(1);
    expect(secondErr).toContain(lockPath);
    expect(secondErr).toMatch(/only once no rotation of that agent is running/);
    expect(existsSync(lockPath)).toBe(false);
  }, 180_000);

  test("(b) rotations of different agents do not block each other", async () => {
    const home = mkdtempSync(join(tmpdir(), "flair-3151-home-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const stalled = seedAgent("agent-b");
    const other = seedAgent("agent-c");
    for (const [id, keyPath] of [["agent-b", stalled.keyPath], ["agent-c", other.keyPath]] as const) {
      await ops({
        operation: "insert",
        table: "Agent",
        records: [{
          id, name: id, role: "agent", admin: false, status: "active",
          publicKey: publicKeyOfSeed(readFileSync(keyPath)), createdAt: new Date().toISOString(),
        }],
      });
    }
    const base = join(home, "pause-b");

    const first = spawnRotate("agent-b", stalled.keysDir, home, { FLAIR_TEST_ROTATE_KEY_PAUSE: base });
    await waitForFile(`${base}.ready`, 30_000);

    // agent-c's rotation completes while agent-b's is stalled under its lock.
    const second = spawnRotate("agent-c", other.keysDir, home);
    const secondCode = await second.proc.exited;
    expect(secondCode, (await second.stderr).slice(0, 800)).toBe(0);
    expect(await storedPublicKey("agent-c")).toBe(publicKeyOfSeed(readFileSync(other.keyPath)));

    writeFileSync(`${base}.go`, "");
    const firstCode = await first.proc.exited;
    expect(firstCode, (await first.stderr).slice(0, 800)).toBe(0);
    expect(await storedPublicKey("agent-b")).toBe(publicKeyOfSeed(readFileSync(stalled.keyPath)));
    expect(existsSync(join(other.keysDir, "agent-c.rotate-key.lock"))).toBe(false);
    expect(existsSync(join(stalled.keysDir, "agent-b.rotate-key.lock"))).toBe(false);
  }, 180_000);
});
