import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { execFileSync, spawn } from "node:child_process";
import { installCapturePackage } from "../helpers/capture-package";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { FlairClient } from "../../packages/flair-client/src/client";
import { buildCaptureMemoryRow, captureHash, planStop } from "../../packages/flair-mcp/src/capture";
import { appendRecord, readSpool } from "../../packages/flair-mcp/src/capture-spool";
import { memoryPutPath } from "../../packages/flair-mcp/src/record-id-path";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }

function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}

async function registerAgent(harper: HarperInstance, agent: TestAgent): Promise<void> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify({
      operation: "insert",
      database: "flair",
      table: "Agent",
      records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
    }),
  });
  expect(res.status, `Agent insert for ${agent.id} returned ${res.status}`).toBe(200);
}

let harper: HarperInstance;
let keyDir: string;

describe("flair#2068 — capture flush through the production client path against real Harper", () => {
  beforeAll(async () => {
    harper = await startHarper();
    keyDir = await mkdtemp(join(tmpdir(), "flair-2068-flush-keys-"));
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    if (keyDir) await rm(keyDir, { recursive: true, force: true, maxRetries: 4 });
  });

  test("a staged candidate is written and read back with its id, content, meta and provenance", async () => {
    const agent = mkAgent(`capture-flush-${randomUUID()}`);
    await registerAgent(harper, agent);

    // loadPrivateKey() treats an exactly-32-byte file as a raw Ed25519 seed;
    // nacl's secretKey is 64 bytes (seed||pubkey), so write the leading 32.
    const keyPath = join(keyDir, `${agent.id}.key`);
    await writeFile(keyPath, Buffer.from(agent.secretKey.slice(0, 32)));

    const dir = join(keyDir, "capture");
    const candidate = {
      kind: "decision" as const,
      content: "Decision: prefer the staged-capture path for the flush check.",
      dedupKey: captureHash(`dedup-${agent.id}`),
      provenance: { hook: "Stop" as const, sessionId: `sess-${agent.id}`, cwd: "/work/agent-a", capturedAt: "2026-10-03T00:00:00.000Z" },
    };
    expect(appendRecord(dir, agent.id, candidate)).toBe("appended");
    const staged = readSpool(dir, agent.id);
    expect(staged.length).toBe(1);

    const fixture = installCapturePackage(join(keyDir, "npm"));
    const binEnv = { ...fixture.env, FLAIR_AGENT_ID: agent.id, FLAIR_URL: harper.httpURL, FLAIR_KEY_PATH: keyPath, FLAIR_CAPTURE_DIR: dir };
    execFileSync("npx", ["--offline", "-y", "-p", fixture.spec, "flair-capture", "--flush"], {
      cwd: fixture.cwd, env: binEnv, timeout: 30_000, stdio: "pipe",
    });
    expect(readSpool(dir, agent.id)).toHaveLength(0);

    // Read the PERSISTED row back through the real client's read path.
    const expected = buildCaptureMemoryRow(
      { kind: candidate.kind, content: candidate.content, dedupKey: candidate.dedupKey, provenance: candidate.provenance },
      agent.id,
    );
    const client = new FlairClient({ agentId: agent.id, url: harper.httpURL, keyPath });
    const stored: any = await client.request("GET", memoryPutPath(expected.id));
    expect(stored, `row ${expected.id} must exist in the store`).toBeTruthy();

    // id + content.
    expect(stored.id).toBe(expected.id);
    expect(stored.content).toBe(expected.content);
    // The row's EXPLICIT private visibility rides through.
    expect(stored.visibility).toBe("private");
    // The `meta` object round-trips (an undeclared field the writer keeps).
    expect(stored.meta).toEqual(expected.meta);
    // The provenance fields, asserted one by one.
    expect(stored.meta.source).toBe("claude-code-capture");
    expect(stored.meta.hook).toBe("Stop");
    expect(stored.meta.dedupKey).toBe(candidate.dedupKey);
    expect(stored.meta.capturedAt).toBe(candidate.provenance.capturedAt);
    expect(stored.meta.sessionId).toBe(candidate.provenance.sessionId);

    const entry = join(fixture.cwd, "node_modules/@tpsdev-ai/flair-mcp/dist/capture-hook.js");
    const child = spawn(process.execPath, [entry], {
      cwd: fixture.cwd, env: { ...binEnv, FLAIR_CAPTURE_FLUSH_SPEC: fixture.spec },
      stdio: ["pipe", "pipe", "pipe"], timeout: 10_000,
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    const payload = { hook_event_name: "Stop", session_id: "auto-flush", last_assistant_message: "Decision: choose PostgreSQL for the analytics warehouse." };
    const automaticRow = buildCaptureMemoryRow(planStop(payload, new Date().toISOString())!, agent.id);
    child.stdin.end(JSON.stringify(payload));
    expect(await exited).toBe(0);
    const deadline = Date.now() + 30_000;
    let automatic: any;
    while (Date.now() < deadline) {
      try {
        automatic = await client.request("GET", memoryPutPath(automaticRow.id));
        if (automatic && readSpool(dir, agent.id).length === 0) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(automatic?.content).toBe(automaticRow.content);
    expect(automatic?.meta.sessionId).toBe("auto-flush");
    expect(automatic?.meta.source).toBe("claude-code-capture");
    expect(automatic?.visibility).toBe("private");
    expect(readSpool(dir, agent.id)).toHaveLength(0);
  }, 120_000);
});
