// flair#2068 — the capture background flush, driven through the PRODUCTION
// client path against a real Harper instance.
//
// runCaptureFlush() writes each staged candidate with `PUT /Memory/<id>` through
// a dynamically loaded FlairClient (the same @tpsdev-ai/flair-client the
// published hook resolves), NOT an injected request(). Every other flush test
// injects a fake client; this one closes that seam: it stages one candidate,
// drains the spool with the real client, and reads the PERSISTED row back — its
// id, content, the `meta` object and the provenance fields.
//
// HOME-isolated: helpers/harper-lifecycle spawns Harper with HOME/ROOTPATH in a
// fresh temp dir, never ~/.flair. The flush's client factory reads FLAIR_URL and
// FLAIR_KEY_PATH from process.env, so this file sets those (restoring them
// afterward), which is why it lives in test/integration-isolated — its own
// process, no env bleed into sibling integration files.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { FlairClient } from "../../packages/flair-client/src/client";
import { buildCaptureMemoryRow } from "../../packages/flair-mcp/src/capture";
import { appendRecord, readSpool, runCaptureFlush } from "../../packages/flair-mcp/src/capture-spool";
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
const savedEnv: Record<string, string | undefined> = {};

describe("flair#2068 — capture flush through the production client path against real Harper", () => {
  beforeAll(async () => {
    harper = await startHarper();
    keyDir = await mkdtemp(join(tmpdir(), "flair-2068-flush-keys-"));
  }, 180_000);

  afterAll(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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

    // Point the flush's default client factory at this instance. Saved for the
    // afterAll restore.
    for (const key of ["FLAIR_URL", "FLAIR_KEY_PATH", "FLAIR_AGENT_ID"]) {
      savedEnv[key] ??= process.env[key];
    }
    process.env.FLAIR_URL = harper.httpURL;
    process.env.FLAIR_KEY_PATH = keyPath;
    process.env.FLAIR_AGENT_ID = agent.id;

    // Stage ONE candidate in the real spool (no flush kicked).
    const dir = join(keyDir, "capture");
    const candidate = {
      kind: "decision" as const,
      content: "Decision: prefer the staged-capture path for the flush check.",
      dedupKey: `dedup-${agent.id}`,
      provenance: { hook: "Stop" as const, sessionId: `sess-${agent.id}`, cwd: "/work/agent-a", capturedAt: "2026-10-03T00:00:00.000Z" },
    };
    expect(appendRecord(dir, agent.id, candidate)).toBe("appended");
    const staged = readSpool(dir, agent.id);
    expect(staged.length).toBe(1);

    // Drain with NO makeClient: the real defaultClientFactory loads
    // @tpsdev-ai/flair-client and PUTs /Memory/<id>.
    const outcome = await runCaptureFlush({ env: { FLAIR_AGENT_ID: agent.id, FLAIR_CAPTURE_DIR: dir }, dir });
    expect(outcome.flushed).toBe(1);
    expect(outcome.remaining).toBe(0);
    expect(readSpool(dir, agent.id).length).toBe(0);

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
  }, 120_000);
});
