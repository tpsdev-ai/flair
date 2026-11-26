// agent-rotate-key-real-harper-3077.test.ts — flair#3077 slice B, against a
// REAL Harper: `flair agent rotate-key` stages the new private key before the
// update request, verifies the read-back row holds its public key, and replaces
// the key by rename. Afterwards the new key signs a request Flair accepts and
// the old key is refused.
//
// Build prerequisite: dist/resources/*.js (`bun run build`).
import { describe, expect, test, beforeAll, afterAll, spyOn } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { program } from "../../src/cli.js";

const AGENT_ID = "agent-rotate-3077b";

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

function edHeader(agentId: string, seed: Uint8Array, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const keyPair = nacl.sign.keyPair.fromSeed(seed);
  const sig = nacl.sign.detached(new TextEncoder().encode(`${agentId}:${ts}:${nonce}:${method}:${path}`), keyPair.secretKey);
  return `TPS-Ed25519 ${agentId}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

let harper: HarperInstance;
let rootDir: string;
let keysDir: string;

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

/** Run the real rotate-key command without letting it end the test process. */
async function runRotate(): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    stdout.push(args.map((a) => String(a)).join(" "));
  });
  const errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderr.push(args.map((a) => String(a)).join(" "));
  });
  const origExit = process.exit;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as typeof process.exit;
  let code = 0;
  try {
    await program.parseAsync([
      "node",
      "flair",
      "agent",
      "rotate-key",
      AGENT_ID,
      "--ops-port",
      new URL(harper.opsURL).port,
      "--port",
      new URL(harper.httpURL).port,
      "--admin-pass",
      harper.admin.password,
      "--admin-user",
      harper.admin.username,
      "--keys-dir",
      keysDir,
    ]);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const match = message.match(/^process\.exit\((\d+)\)$/);
    if (!match) throw err;
    code = Number(match[1]);
  } finally {
    process.exit = origExit;
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

beforeAll(async () => {
  harper = await startHarper();
  assertOwnInstance(harper);
  keysDir = join(mkdtempSync(join(tmpdir(), "flair-3077b-")), "keys");
  rootDir = join(keysDir, "..");
  const kp = nacl.sign.keyPair();
  mkdirSync(keysDir, { recursive: true });
  const keyPath = join(keysDir, `${AGENT_ID}.key`);
  writeFileSync(keyPath, Buffer.from(kp.secretKey.slice(0, 32)));
  chmodSync(keyPath, 0o600);
  await ops({
    operation: "insert",
    table: "Agent",
    records: [{
      id: AGENT_ID,
      name: AGENT_ID,
      role: "agent",
      admin: false,
      status: "active",
      publicKey: Buffer.from(kp.publicKey).toString("base64url"),
      createdAt: new Date().toISOString(),
    }],
  });
}, 180_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (rootDir) rmSync(rootDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

describe("flair#3077 slice B — rotate-key replaces the key Flair verified against", () => {
  test("(h) after success the new key signs a request Flair accepts and the old key is refused", async () => {
    const oldSeed = readFileSync(join(keysDir, `${AGENT_ID}.key`));
    const result = await runRotate();
    expect(result.code, `rotate-key exited ${result.code}: ${result.stderr.slice(0, 500)}`).toBe(0);

    const newSeed = readFileSync(join(keysDir, `${AGENT_ID}.key`));
    expect(newSeed.equals(oldSeed)).toBe(false);

    const path = `/Agent/${AGENT_ID}`;
    const fresh = await fetch(`${harper.httpURL}${path}`, {
      headers: { Authorization: edHeader(AGENT_ID, newSeed, "GET", path) },
      signal: AbortSignal.timeout(15_000),
    });
    expect(fresh.status, (await fresh.text()).slice(0, 200)).toBeLessThan(300);

    const stale = await fetch(`${harper.httpURL}${path}`, {
      headers: { Authorization: edHeader(AGENT_ID, oldSeed, "GET", path) },
      signal: AbortSignal.timeout(15_000),
    });
    expect(stale.status, (await stale.text()).slice(0, 200)).toBe(401);
  }, 60_000);
});
