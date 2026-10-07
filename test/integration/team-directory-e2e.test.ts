// team-directory-e2e.test.ts — the S3a team-directory seam, end to end on a
// real Harper (test/helpers/harper-lifecycle.ts).
//
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cp, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { FlairClient } from "../../packages/flair-client/src/client";
import { STDIO_TOOL_HANDLERS } from "../../packages/flair-mcp/src/adapter-tools";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; keyPath: string }

let keyDir: string;
let appDir: string;
let reader: TestAgent;
let subject: TestAgent;
let owner: TestAgent;
let adminAgent: TestAgent;
let bulk: TestAgent;
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

async function registerAgent(a: TestAgent, fields: Record<string, string> = {}): Promise<void> {
  const res = await adminOp({
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: a.id, name: a.id, role: "agent", publicKey: a.publicKey, createdAt: new Date().toISOString(), ...fields }],
  });
  expect(res.status, `Agent insert for ${a.id} returned ${res.status}`).toBe(200);
}

/** A request over the real HTTP route, as Basic admin (the operator) or signed as `a`. */
async function requestAs(a: TestAgent | "operator", method: string, path: string, body?: unknown): Promise<Response> {
  const authorization = a === "operator"
    ? "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`)
    : ed25519Header(a, method, path);
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: authorization },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** The stored Integration row, read through the operations API (not the resource under test). */
async function storedRow(id: string): Promise<any> {
  const res = await adminOp({
    operation: "search_by_id", database: "flair", table: "Integration", ids: [id],
    get_attributes: ["id", "agentId", "platform", "email", "directoryPublishedAt"],
  });
  expect(res.status).toBe(200);
  const rows: any = await res.json();
  return Array.isArray(rows) ? rows[0] ?? null : null;
}

/** Ids of the stored Integration rows owned by `agentId`. */
async function storedIdsFor(agentId: string): Promise<string[]> {
  const res = await adminOp({
    operation: "search_by_value", database: "flair", table: "Integration",
    search_attribute: "agentId", search_value: agentId, get_attributes: ["id"],
  });
  expect(res.status).toBe(200);
  const rows: any = await res.json();
  return (rows as any[]).map((r) => r.id).sort();
}

/** Publish a fresh tps-mail row for `a` as the operator; returns the stored row. */
async function publishedRow(a: TestAgent, prefix: string): Promise<any> {
  const id = `${prefix}-${randomUUID().slice(0, 8)}`;
  const res = await publishAsOperator({ id, agentId: a.id, platform: "tps-mail", email: `${id}@example.test`, directoryPublishedAt: "x" });
  expect(res.ok, `operator publish returned ${res.status}`).toBe(true);
  const row = await storedRow(id);
  expect(typeof row?.directoryPublishedAt).toBe("string");
  return row;
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

async function embeddedCall(name: string, args: Record<string, unknown>, sub = "td-reader-sub"): Promise<any> {
  const res = await fetch(`${harper.httpURL}/AgentFleet/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify({ op: "mcpRpc", sub, rpc: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } }),
  });
  expect(res.status).toBe(200);
  const out: any = await res.json();
  expect(out.ok).toBe(true);
  expect(out.value.status).toBe(200);
  return out.value.rpc;
}

describe("team directory on Harper", () => {
  const publishedEmail = `td-${randomUUID().slice(0, 8)}@example.test`;

  beforeAll(async () => {
    keyDir = mkdtempSync(join(tmpdir(), "flair-td-e2e-keys-"));
    reader = mkAgent("td-reader");
    subject = mkAgent("td-subject");
    owner = mkAgent("td-owner");
    adminAgent = mkAgent("td-admin");
    bulk = mkAgent("td-bulk");
    appDir = mkdtempSync(join(tmpdir(), "flair-td-e2e-app-"));
    await cp(join(process.cwd(), "test/fixtures/inproc-app"), appDir, { recursive: true });
    await mkdir(join(appDir, "node_modules", "@tpsdev-ai"), { recursive: true });
    await symlink(process.cwd(), join(appDir, "node_modules", "@tpsdev-ai", "flair"), "dir");
    harper = await startHarper({ cwd: appDir, harperBinDir: process.cwd() });
    assertOwnInstance(harper);
    await registerAgent(reader);
    await registerAgent(subject);
    // Deactivated until the published-row cases below, so the roster cases do
    // not count them; registered now so the admin role is known from the first
    // signed request.
    await registerAgent(owner, { status: "deactivated" });
    await registerAgent(adminAgent, { role: "admin", status: "deactivated" });
    await registerAgent(bulk, { status: "deactivated" });
    expect((await adminOp({ operation: "insert", database: "flair", table: "Agent", records: [
      { id: "td-human", name: "td-human", kind: "human", status: "active", role: "agent", publicKey: "pending", createdAt: new Date().toISOString() },
    ] })).status).toBe(200);
    expect((await adminOp({ operation: "insert", database: "flair", table: "Credential", records: [
      { id: "td-reader-credential", kind: "idp", principalId: reader.id, idpSubject: "td-reader-sub", status: "active", createdAt: new Date().toISOString() },
      { id: "td-human-credential", kind: "idp", principalId: "td-human", idpSubject: "td-human-sub", status: "active", createdAt: new Date().toISOString() },
    ] })).status).toBe(200);
    expect((await adminOp({ operation: "insert", database: "flair", table: "Soul", records: [
      { id: "td-reader-role", agentId: reader.id, key: "role", value: "reviewer", priority: "standard", createdAt: new Date().toISOString() },
    ] })).status).toBe(200);
    readerClient = new FlairClient({ agentId: reader.id, url: harper.httpURL, keyPath: reader.keyPath });
  }, 240_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    if (keyDir) rmSync(keyDir, { recursive: true, force: true });
    if (appDir) rmSync(appDir, { recursive: true, force: true });
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

  test("embedded tools/call returns the published entry", async () => {
    const rpc = await embeddedCall("team_directory", { id: subject.id, limit: 1 });
    expect(rpc.error).toBeUndefined();
    expect(rpc.result.isError).toBe(false);
    expect(rpc.result.structuredContent.entries.map((e: any) => e.agentId)).toEqual([subject.id]);
    expect(rpc.result.structuredContent.entries[0].email).toBe(publishedEmail);
    expect(JSON.parse(rpc.result.content[0].text)).toEqual(rpc.result.structuredContent);
  });

  test("embedded tools/call refuses a human reader and invalid limit type", async () => {
    const rpc = await embeddedCall("team_directory", {}, "td-human-sub");
    expect(rpc.error).toBeUndefined();
    expect(rpc.result.isError).toBe(true);
    expect(rpc.result.structuredContent).toEqual({ error: "team_directory_reader_not_active", status: 403 });
    expect(JSON.parse(rpc.result.content[0].text)).toEqual(rpc.result.structuredContent);
    const invalid = await embeddedCall("team_directory", { limit: "1" });
    expect(invalid.error.code).toBe(-32602);
    expect(invalid.result).toBeUndefined();
  });

  for (const roster of [true, false]) {
    for (const includeContext of [true, false]) {
      for (const includeSoul of [true, false]) {
        test(`bootstrap directory hint with roster=${roster}, context=${includeContext}, soul=${includeSoul}`, async () => {
          expect((await adminOp({ operation: "update", database: "flair", table: "Agent", records: [
            { id: subject.id, status: roster ? "active" : "deactivated" },
          ] })).status).toBe(200);
          const res = await fetch(`${harper.httpURL}/BootstrapMemories`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: ed25519Header(reader, "POST", "/BootstrapMemories") },
            body: JSON.stringify({ includeContext, includeSoul }),
          });
          expect(res.status).toBe(200);
          const body: any = await res.json();
          expect(body.directoryHint).toBe("Need a teammate? Call the `team_directory` tool (MCP) or `GET /TeamDirectory` for this office's active agents with published tps-mail addresses.");
          expect(body.soul.role).toBe(includeSoul ? "reviewer" : undefined);
          expect(body.sections.team).toBe(roster ? 1 : 0);
          expect(body.context.includes("## Team")).toBe(roster && includeContext);
          if (roster && includeContext) expect(body.context).toContain(body.directoryHint);
        });
      }
    }
  }

  describe("published-row writes through the real resource", () => {
    beforeAll(async () => {
      expect((await adminOp({ operation: "update", database: "flair", table: "Agent", records: [owner, adminAgent, bulk].map((a) => ({ id: a.id, status: "active" })) })).status).toBe(200);
    });

    for (const verb of ["PATCH", "PUT"] as const) {
      test(`a ${verb} that reassigns agentId is refused for the owner (403) and an admin agent (409); the row is unchanged`, async () => {
        const before = await publishedRow(owner, "td-own");
        for (const [actor, status] of [[owner, 403], [adminAgent, 409]] as const) {
          const body = verb === "PATCH"
            ? { agentId: reader.id }
            : { id: before.id, agentId: reader.id, platform: "tps-mail", email: before.email };
          const res = await requestAs(actor, verb, `/Integration/${before.id}`, body);
          expect(res.status, `${actor.id} ${verb} agentId returned ${res.status}`).toBe(status);
          expect(await storedRow(before.id)).toEqual(before);
        }
      });

      test(`a ${verb} that changes a published email is refused (409) for the owner, an admin agent and the operator; the row is unchanged`, async () => {
        const before = await publishedRow(owner, "td-addr");
        const body = verb === "PATCH"
          ? { email: "moved@example.test" }
          : { id: before.id, agentId: owner.id, platform: "tps-mail", email: "moved@example.test" };
        for (const actor of [owner, adminAgent, "operator"] as const) {
          const res = await requestAs(actor, verb, `/Integration/${before.id}`, body);
          expect(res.status, `${actor === "operator" ? actor : actor.id} ${verb} email returned ${res.status}`).toBe(409);
          expect(await storedRow(before.id)).toEqual(before);
        }
      });

      test(`a ${verb} withdrawal is refused for an admin agent (403) and persists for the operator`, async () => {
        const before = await publishedRow(owner, "td-wd");
        const body = verb === "PATCH"
          ? { directoryPublishedAt: null }
          : { id: before.id, agentId: owner.id, platform: "tps-mail", email: before.email, directoryPublishedAt: null };
        const refused = await requestAs(adminAgent, verb, `/Integration/${before.id}`, body);
        expect(refused.status, `admin-agent ${verb} withdrawal returned ${refused.status}`).toBe(403);
        expect(await storedRow(before.id)).toEqual(before);
        const res = await requestAs("operator", verb, `/Integration/${before.id}`, body);
        expect(res.ok, `operator ${verb} withdrawal returned ${res.status}`).toBe(true);
        expect(await storedRow(before.id)).toEqual({ ...before, directoryPublishedAt: null });
      });
    }

    test("a by-id DELETE of a published row is refused for an admin agent (403) and removes it for the operator", async () => {
      const row = await publishedRow(owner, "td-del");
      for (const path of [`/Integration/${row.id}`, `/Integration/${row.id}?select(id)`]) {
        const res = await requestAs(adminAgent, "DELETE", path);
        expect(res.status, `admin-agent DELETE ${path} returned ${res.status}`).toBe(403);
        expect(await storedRow(row.id)).toEqual(row);
      }
      const res = await requestAs("operator", "DELETE", `/Integration/${row.id}`);
      expect(res.ok, `operator DELETE returned ${res.status}`).toBe(true);
      expect(await storedRow(row.id)).toBeNull();
    });

    test("a collection DELETE by an admin agent is refused (403) and the rows remain; the operator is not refused by the gate", async () => {
      const ids = [(await publishedRow(bulk, "td-bulk")).id, (await publishedRow(bulk, "td-bulk")).id].sort();
      for (const path of [`/Integration/?agentId=${bulk.id}`, "/Integration/"]) {
        const res = await requestAs(adminAgent, "DELETE", path);
        expect(res.status, `admin-agent DELETE ${path} returned ${res.status}`).toBe(403);
        expect(String(((await res.json()) as any)?.error ?? "")).toStartWith("integration_directory_requires_operator");
        expect(await storedIdsFor(bulk.id)).toEqual(ids);
      }
      const res = await requestAs("operator", "DELETE", `/Integration/?agentId=${bulk.id}`);
      expect([401, 403], `operator collection DELETE returned ${res.status}`).not.toContain(res.status);
    });
  });
});
