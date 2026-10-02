// flair#1942 — a workflow's agent cannot read another agent's private memories.
//
// The n8n credential now holds an agent id + that agent's Ed25519 key, and the
// nodes sign every request as that agent. This control runs against an
// EPHEMERAL Harper started for this test only: it seeds two agents, writes one
// private and one shared memory as agent A (through the FlairWrite node), and
// reads them back as agent B (through the same credential path the nodes use).
//
// The read is asserted on the raw collection the client lists from, so the
// boundary proven is the SERVER's: B's signed request is scoped to what B may
// read, not filtered client-side afterwards.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomUUID } from "node:crypto";

import { FlairWrite } from "../../packages/n8n-nodes-flair/src/nodes/FlairWrite/FlairWrite.node";
import {
  flairCredentialTest,
  makeClient,
  type FlairCredentials,
} from "../../packages/n8n-nodes-flair/src/client";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

interface TestAgent {
  id: string;
  keyText: string;
  publicKey: string;
}

function mkAgent(id: string): TestAgent {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    id,
    keyText: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    publicKey: (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32).toString("base64"),
  };
}

async function adminOp(harper: HarperInstance, op: Record<string, unknown>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify(op),
  });
}

async function seedAgent(harper: HarperInstance, agent: TestAgent): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert",
    database: "flair",
    table: "Agent",
    records: [
      { id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() },
    ],
  });
  expect(res.status).toBe(200);
}

/** The rows a credential's agent may read for `owner` — the raw list the nodes' client fetches. */
async function listForOwner(credentials: FlairCredentials, owner: string): Promise<any[]> {
  const client = await makeClient(credentials);
  const rows = await client.request<unknown>("GET", `/Memory?${new URLSearchParams({ agentId: owner })}`);
  return Array.isArray(rows) ? (rows as any[]) : ((rows as any)?.results ?? []);
}

function writeCtx(credentials: FlairCredentials, durability: string, subject: string, content: string): any {
  const params: Record<string, unknown> = {
    content,
    subject,
    tags: "",
    durability,
    type: "fact",
    skipEmpty: true,
  };
  return {
    getCredentials: async () => credentials,
    getNodeParameter: (name: string, _i?: number, fallback?: unknown) => (name in params ? params[name] : fallback),
    getInputData: () => [{ json: { content } }],
    logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
  };
}

/** Write through the node, as a workflow does. */
async function writeAsNode(credentials: FlairCredentials, durability: string, subject: string, content: string): Promise<string> {
  const out = await (new FlairWrite().execute as any).call(writeCtx(credentials, durability, subject, content));
  expect(out[0][0].json._flair_id).toBeTruthy();
  return out[0][0].json._flair_id as string;
}

let harper: HarperInstance;
const agentA = mkAgent(`n8n-a-${randomUUID().slice(0, 8)}`);
const agentB = mkAgent(`n8n-b-${randomUUID().slice(0, 8)}`);
const subject = `n8n-isolation-${randomUUID().slice(0, 8)}`;
const privateContent = `PRIVATE-ONLY-${randomUUID()}`;
const sharedContent = `SHARED-${randomUUID()}`;
let credentialsA: FlairCredentials;
let credentialsB: FlairCredentials;

beforeAll(async () => {
  harper = await startHarper();
  // Every target this test touches is the ephemeral instance it started (never
  // the host's ops/HTTP ports): 127.0.0.1 with OS-assigned ports.
  for (const target of [harper.httpURL, harper.opsURL]) {
    const url = new URL(target);
    expect(url.hostname).toBe("127.0.0.1");
    expect(Number(url.port)).toBeGreaterThan(1024);
    expect(["9925", "9926"]).not.toContain(url.port);
  }
  expect(new URL(harper.opsURL).port).not.toBe(new URL(harper.httpURL).port);
  await seedAgent(harper, agentA);
  await seedAgent(harper, agentB);
  credentialsA = { baseUrl: harper.httpURL, agentId: agentA.id, agentPrivateKey: agentA.keyText };
  credentialsB = { baseUrl: harper.httpURL, agentId: agentB.id, agentPrivateKey: agentB.keyText };
  // A writes one private memory (the node's default durability) and one shared.
  await writeAsNode(credentialsA, "standard", subject, privateContent);
  await writeAsNode(credentialsA, "persistent", subject, sharedContent);
}, 180_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
});

describe("n8n signs as the credential's agent (flair#1942)", () => {
  test("the writer's own agent reads both its memories — the writes landed signed", async () => {
    const rows = await listForOwner(credentialsA, agentA.id);
    const contents = rows.map((r) => r.content);
    expect(contents).toContain(privateContent);
    expect(contents).toContain(sharedContent);
  }, 30_000);

  test("another agent cannot read the private memory, and does reach the shared one", async () => {
    const rows = await listForOwner(credentialsB, agentA.id);
    const contents = rows.map((r) => r.content);
    expect(contents).not.toContain(privateContent);
    expect(contents).toContain(sharedContent);
  }, 30_000);

  test("another agent cannot write under the first agent's id", async () => {
    const asB = await makeClient(credentialsB);
    const id = `n8n-cross-${randomUUID().slice(0, 8)}`;
    let status = 0;
    let message = "";
    try {
      await asB.request("PUT", `/Memory/${id}`, {
        id,
        agentId: agentA.id,
        content: "a memory B tries to write under A's id",
        type: "fact",
        durability: "standard",
        tags: [],
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      status = (error as any)?.status ?? 0;
      message = (error as Error).message;
    }
    expect(status).toBeGreaterThanOrEqual(400);
    expect(message).toContain("another agent");
  }, 30_000);

  test("the credential test signs a read as the agent, and fails for a key that is not the agent's", async () => {
    const ok = await (flairCredentialTest as any).call({}, { data: credentialsA });
    expect(ok.status).toBe("OK");

    const stranger = mkAgent(`n8n-stranger-${randomUUID().slice(0, 8)}`);
    const wrong = await (flairCredentialTest as any).call({}, {
      data: { baseUrl: harper.httpURL, agentId: agentA.id, agentPrivateKey: stranger.keyText },
    });
    expect(wrong.status).toBe("Error");
  }, 30_000);

  test("the deprecated admin credential still works — and it does read the private memory", async () => {
    const adminCredentials: FlairCredentials = {
      baseUrl: harper.httpURL,
      agentId: agentB.id,
      adminPassword: harper.admin.password,
    };
    const warns: string[] = [];
    const logger = { warn: (m: string) => warns.push(m), error: () => {}, info: () => {}, debug: () => {} };
    const out = await (new FlairWrite().execute as any).call({
      ...writeCtx(adminCredentials, "standard", subject, privateContent),
      logger,
    });
    expect(out[0][0].json._flair_id).toBeTruthy();
    expect(warns).toHaveLength(1);

    // The administrator bypasses the agent scope: B's private memory is visible.
    const rows = await listForOwner(adminCredentials, agentA.id);
    expect(rows.map((r) => r.content)).toContain(privateContent);
  }, 30_000);
});
