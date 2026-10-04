// team-directory-e2e.test.ts — the S3a team-directory seam, end to end on a
// real Harper (test/helpers/harper-lifecycle.ts).
//
// The unit suite (test/unit/team-directory.test.ts) drives the resolver against
// a mocked `databases.flair`. This file exercises the REAL components on the
// other side of the seams the resolver depends on:
//
//   publish:  an operator (Basic admin) POST /Integration reaches the real
//             Integration resource, runs its validate + commit inside the
//             resource's owned transaction, and stamps `directoryPublishedAt`.
//   resolve:  GET /TeamDirectory (the real HTTP route + the shared resolver) and
//             packages/flair-client's `teamDirectory.list()` both read the
//             published entry back.
//   refusal:  a non-operator (a verified agent) publish is refused with the
//             resource's refusal shape, and an anonymous route read is refused.
//   stdio:    the `team_directory` stdio binding runs in-process against the same
//             Harper, through the flair client.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { FlairClient } from "../../packages/flair-client/src/client";
import { STDIO_TOOL_HANDLERS } from "../../packages/flair-mcp/src/adapter-tools";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; keyPath: string }

let keyDir: string;
let reader: TestAgent;
let subject: TestAgent;
let readerClient: FlairClient;
let harper: HarperInstance;

function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  const keyPath = join(keyDir, `${id}.key`);
  // loadPrivateKey() (flair-client/src/auth.ts) treats an exactly-32-byte file as
  // a raw Ed25519 seed — nacl's secretKey is (seed || pubkey), so the first 32
  // bytes are the seed it expects.
  writeFileSync(keyPath, Buffer.from(kp.secretKey.slice(0, 32)));
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey, keyPath };
}

function ed25519Header(a: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const sig = nacl.sign.detached(new TextEncoder().encode(`${a.id}:${ts}:${nonce}:${method}:${path}`), a.secretKey);
  return `TPS-Ed25519 ${a.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

/** Refuse to talk to anything but this test's own ephemeral instance: loopback,
 *  the OS-assigned ports it was started on (never a fixed production port), and a
 *  data directory under the temp dir. */
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

async function adminOp(op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify(op),
  });
}

async function registerAgent(a: TestAgent): Promise<void> {
  const res = await adminOp({
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: a.id, name: a.id, role: "agent", publicKey: a.publicKey, createdAt: new Date().toISOString() }],
  });
  expect(res.status, `Agent insert for ${a.id} returned ${res.status}`).toBe(200);
}

/** POST a collection row over the real HTTP route as Basic admin (the operator). */
async function publishAsOperator(body: Record<string, any>): Promise<Response> {
  return fetch(`${harper.httpURL}/Integration`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify(body),
  });
}

/** POST a collection row over the real HTTP route signed as `agent`. */
async function publishAsAgent(a: TestAgent, body: Record<string, any>): Promise<Response> {
  return fetch(`${harper.httpURL}/Integration`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: ed25519Header(a, "POST", "/Integration") },
    body: JSON.stringify(body),
  });
}

/** GET the real route, signed as `agent` (or anonymous when omitted). */
async function getTeamDirectory(a?: TestAgent): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (a) headers.Authorization = ed25519Header(a, "GET", "/TeamDirectory");
  return fetch(`${harper.httpURL}/TeamDirectory`, { method: "GET", headers });
}

describe("team directory e2e (real Integration resource -> GET /TeamDirectory -> flair client -> stdio binding)", () => {
  const publishedEmail = `td-${randomUUID().slice(0, 8)}@example.test`;

  beforeAll(async () => {
    keyDir = mkdtempSync(join(tmpdir(), "flair-td-e2e-keys-"));
    reader = mkAgent("td-reader");
    subject = mkAgent("td-subject");
    harper = await startHarper();
    assertOwnInstance(harper);
    await registerAgent(reader);
    await registerAgent(subject);
    readerClient = new FlairClient({ agentId: reader.id, url: harper.httpURL, keyPath: reader.keyPath });
  }, 240_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    if (keyDir) rmSync(keyDir, { recursive: true, force: true });
  });

  test("a non-operator publish is refused by the real resource (refusal shape)", async () => {
    const res = await publishAsAgent(reader, {
      id: `td-denied-${randomUUID().slice(0, 8)}`,
      agentId: reader.id,
      platform: "tps-mail",
      email: "denied@example.test",
      directoryPublishedAt: new Date().toISOString(),
    });
    expect(res.status, `non-operator publish returned ${res.status}, expected 403`).toBe(403);
    const body: any = await res.json();
    expect(String(body?.error ?? "")).toStartWith("integration_directory_requires_operator");
  });

  test("operator publish through the resource is then read by GET /TeamDirectory", async () => {
    const id = `td-pub-${randomUUID().slice(0, 8)}`;
    const pub = await publishAsOperator({
      id,
      agentId: subject.id,
      platform: "tps-mail",
      email: publishedEmail,
      directoryPublishedAt: new Date().toISOString(),
    });
    const pubText = await pub.text();
    expect(pub.ok, `operator publish returned ${pub.status}: ${pubText.slice(0, 200)}`).toBe(true);

    const route = await getTeamDirectory(reader);
    expect(route.status, "GET /TeamDirectory did not return 200").toBe(200);
    const page: any = await route.json();
    const entry = (page?.entries ?? []).find((e: any) => e.agentId === subject.id);
    expect(entry, "the published subject is absent from GET /TeamDirectory").toBeDefined();
    expect(entry.email).toBe(publishedEmail);
    expect(entry.platform).toBe("tps-mail");
  });

  test("the flair-client method returns the same published entry", async () => {
    const page = await readerClient.teamDirectory.list({ id: subject.id });
    expect(page.entries.map((e) => e.agentId)).toEqual([subject.id]);
    expect(page.entries[0].email).toBe(publishedEmail);
  });

  test("anonymous GET /TeamDirectory is refused", async () => {
    const res = await getTeamDirectory();
    expect(res.status, `anonymous GET returned ${res.status}, expected 403`).toBe(403);
  });

  test("the stdio binding resolves the directory in-process against the same Harper", async () => {
    const result: any = await STDIO_TOOL_HANDLERS.team_directory(
      { id: subject.id },
      { flair: readerClient, agentId: reader.id, heartbeat: () => {}, rememberTask: () => {} },
    );
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as any;
    expect(structured.entries.map((e: any) => e.agentId)).toEqual([subject.id]);
    expect(structured.entries[0].email).toBe(publishedEmail);
    expect(result.content[0].text).toContain(publishedEmail);
  });
});
