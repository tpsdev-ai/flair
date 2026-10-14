// ─── flair#2541 — skill_store / memory_basement / memory_restore write replies ─
//
// A Memory write whose text the server redacts answers with `redactedValues`
// and `stored`, the post-redaction text that write committed (flair#2467). The
// built-in /mcp `skill_store`, `memory_basement` and `memory_restore` take their
// `content`/`summary`/`trigger` from that response, report the count, and make
// no read after the write. This file drives the shipped `mcpHandler` against a
// real Harper, the inproc-app fixture with Flair loaded as a sub-component:
// `request.mcp = { sub }` and the sub mapped to the agent by the real
// identity-mapping flow (the inproc-app `mcpRpc` op).
//
// Each redacted reply must show the stored text and never the credential-shaped
// input. The stored row is read afterwards through the operations API to prove
// the reply text is what Harper holds.
//
// `memory_basement` / `memory_restore` take only an id: the text they re-write
// to the row is the stored row's own. To exercise a redaction on that write,
// the row is seeded through the operations API with a credential-shaped content
// — the shape a pre-flair#2407 row has — so the re-put has something to redact.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, mkdir, cp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { startHarper, stopHarper, HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { provisionIdpIdentityMapping } from "../../src/lib/mcp-enable.ts";

const REPO_ROOT = process.cwd();
const FIXTURE = join(REPO_ROOT, "test", "fixtures", "inproc-app");

let harper: HarperInstance;
let appDir: string;
let keyDir: string;
let keyPath: string;

const sfx = Date.now().toString(36);
const AGENT = `wrredact-${sfx}`;
const SUB = `wrredact-sub-${sfx}`;

const GITHUB_TOKEN = `ghp_${"a".repeat(24)}`;
const REDACTED = "[redacted]";

/** Refuse anything but this test's own ephemeral instance. */
function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], url).toContain(u.hostname);
    expect(["9925", "9926"], `${url} must be this test's own Harper`).not.toContain(u.port);
  }
}

const adminAuth = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);

/** Drive one in-process fixture op (POST /AgentFleet). */
async function fleet(op: string, body: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(`${harper.httpURL}/AgentFleet/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: adminAuth() },
    body: JSON.stringify({ op, ...body }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`AgentFleet ${op} → HTTP ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

/** One tools/call through the shipped mcpHandler as SUB; the tool result, asserted non-error. */
async function mcpTool(tool: string, args: Record<string, unknown>): Promise<{ echo: any; text: string }> {
  const out = await fleet("mcpRpc", {
    sub: SUB,
    rpc: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } },
  });
  expect(out.ok, `mcpRpc transport failed: ${JSON.stringify(out).slice(0, 400)}`).toBe(true);
  const rpc = out.value.rpc;
  expect(rpc?.error, `tools/call ${tool} returned a JSON-RPC error: ${JSON.stringify(rpc?.error)}`).toBeUndefined();
  expect(rpc.result.isError, `tools/call ${tool} returned a tool error: ${rpc.result.content?.[0]?.text}`).toBe(false);
  return { echo: rpc.result.structuredContent, text: rpc.result.content[0].text };
}

/** The stored Memory row, read past every resource gate. */
async function storedRow(id: string): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: adminAuth() },
    body: JSON.stringify({
      operation: "search_by_value",
      database: "flair",
      table: "Memory",
      search_attribute: "id",
      search_value: id,
      get_attributes: ["*"],
    }),
  });
  expect(res.status).toBe(200);
  const rows = await res.json();
  return (rows as any[]).find((r) => r.id === id);
}

/** Seed a row directly, the shape a pre-flair#2407 row has: a raw credential. */
async function seedLegacyRow(id: string, content: string, archived: boolean): Promise<void> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: adminAuth() },
    body: JSON.stringify({
      operation: "insert",
      database: "flair",
      table: "Memory",
      records: [{
        id, agentId: AGENT, content, type: "session", durability: "standard",
        visibility: "private", createdAt: new Date().toISOString(), archived,
        embedding: Array(768).fill(0),
        embeddingModel: "nomic-embed-text-v1.5-Q4_K_M+searchprefix",
      }],
    }),
  });
  expect(res.status, await res.text()).toBe(200);
}

beforeAll(async () => {
  appDir = await mkdtemp(join(tmpdir(), "flair-inproc-2541-"));
  await cp(FIXTURE, appDir, { recursive: true });
  await mkdir(join(appDir, "node_modules", "@tpsdev-ai"), { recursive: true });
  await symlink(REPO_ROOT, join(appDir, "node_modules", "@tpsdev-ai", "flair"), "dir");
  harper = await startHarper({ cwd: appDir, harperBinDir: REPO_ROOT });
  assertOwnInstance(harper);

  keyDir = await mkdtemp(join(tmpdir(), "flair-2541-keys-"));
  const kp = nacl.sign.keyPair();
  keyPath = join(keyDir, `${AGENT}.key`);
  // loadPrivateKey() treats an exactly-32-byte file as a raw Ed25519 seed.
  writeFileSync(keyPath, Buffer.from(kp.secretKey.slice(0, 32)));
  chmodSync(keyPath, 0o600);
  const reg = await fleet("register", { id: AGENT, publicKey: Buffer.from(kp.publicKey).toString("base64") });
  expect(reg.ok, JSON.stringify(reg).slice(0, 300)).toBe(true);

  // The /mcp token subject maps to the same agent through the real flow.
  await provisionIdpIdentityMapping({
    opsPortOrUrl: Number(new URL(harper.opsURL).port),
    adminUser: harper.admin.username,
    adminPass: harper.admin.password,
    principal: AGENT,
    principalKind: "agent",
    idpProvider: "github",
    idpSubject: SUB,
  });
}, 300_000);

afterAll(async () => {
  const dataDir = harper?.installDir;
  if (harper) await stopHarper(harper);
  if (dataDir) await rm(dataDir, { recursive: true, force: true, maxRetries: 4 });
  if (appDir) await rm(appDir, { recursive: true, force: true });
  if (keyDir) await rm(keyDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

describe("flair#2541 — the built-in /mcp write echo reports the stored text (shipped mcpHandler)", () => {
  test("skill_store: the echo carries the stored content and trigger with the count, never the input", async () => {
    const { echo, text } = await mcpTool("skill_store", {
      content: `procedure uses ${GITHUB_TOKEN}`,
      trigger: `when ${GITHUB_TOKEN}`,
      name: "wrredact-skill",
    });
    expect(echo.redactedValues).toBe(2);
    expect(echo.content).toBe(`procedure uses ${REDACTED}`);
    expect(echo.trigger).toBe(`when ${REDACTED}`);
    expect(echo.stored).toBeUndefined();
    expect(echo.contentWithheld).toBeUndefined();
    expect(text).not.toContain(GITHUB_TOKEN);
    const row = await storedRow(echo.id);
    expect(row.content).toBe(echo.content);
    expect(row.trigger).toBe(echo.trigger);
  }, 120_000);

  test("memory_basement: the echo carries the stored content the write redacted, never the row's input", async () => {
    const id = `wrredact-base-${sfx}`;
    await seedLegacyRow(id, `legacy note ${GITHUB_TOKEN} here`, false);
    expect((await storedRow(id)).content).toBe(`legacy note ${GITHUB_TOKEN} here`);

    const { echo, text } = await mcpTool("memory_basement", { id });
    expect(echo.id).toBe(id);
    expect(echo.redactedValues).toBe(1);
    expect(echo.content).toBe(`legacy note ${REDACTED} here`);
    expect(echo.stored).toBeUndefined();
    expect(echo.contentWithheld).toBeUndefined();
    expect(text).not.toContain(GITHUB_TOKEN);
    const row = await storedRow(id);
    expect(row.content).toBe(echo.content);
    expect(row.archived).toBe(true);
  }, 120_000);

  test("memory_restore: the echo carries the stored content the write redacted, never the row's input", async () => {
    const id = `wrredact-restore-${sfx}`;
    await seedLegacyRow(id, `archived note ${GITHUB_TOKEN} here`, true);
    expect((await storedRow(id)).content).toBe(`archived note ${GITHUB_TOKEN} here`);

    const { echo, text } = await mcpTool("memory_restore", { id });
    expect(echo.id).toBe(id);
    expect(echo.redactedValues).toBe(1);
    expect(echo.content).toBe(`archived note ${REDACTED} here`);
    expect(echo.stored).toBeUndefined();
    expect(echo.contentWithheld).toBeUndefined();
    expect(text).not.toContain(GITHUB_TOKEN);
    const row = await storedRow(id);
    expect(row.content).toBe(echo.content);
    expect(row.archived).toBe(false);
  }, 120_000);

  test("control: a write the server did not redact carries no count, no text and no withheld marker", async () => {
    const created = await mcpTool("memory_store", { content: "a plain note with no credential-shaped text" });
    const { echo } = await mcpTool("memory_basement", { id: created.echo.id });
    expect(echo.redactedValues).toBeUndefined();
    expect(echo.content).toBeUndefined();
    expect(echo.contentWithheld).toBeUndefined();
  }, 120_000);
});
