// ─── flair#2575 — server-side redaction covers a skill's name/description/tags ─
//
// flair#2407 redacts the Memory text fields (`content`, `summary`, `trigger`) on
// a write; flair#2575 extends the SAME redactor to a skill's fields: each
// `tags` entry and the `name`/`description` keys of the `metadata` JSON blob.
// The write response's `stored` names those redacted fields like the Memory
// fields, and the /mcp and stdio replies echo the STORED value.
//
// This file drives each surface against a REAL Harper (the inproc-app fixture,
// Flair loaded as a sub-component — test/helpers/harper-lifecycle.ts):
//
//   - REST:  the real FlairClient signs a POST /Memory carrying the skill fields;
//   - /mcp:  the shipped `mcpHandler`, with `request.mcp = { sub }` and the sub
//            mapped to the agent by the real identity-mapping flow;
//   - stdio: the shipped `STDIO_TOOL_HANDLERS.skill_store` over the real client.
//
// Each redacted field is asserted on the stored row, in the write reply and in
// the echo; a clean value is unchanged. The stored row is read afterwards
// through the operations API to prove the reported value is what Harper holds.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, mkdir, cp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { provisionIdpIdentityMapping } from "../../src/lib/mcp-enable.ts";
import { FlairClient } from "../../packages/flair-client/src/client.js";
import { STDIO_TOOL_HANDLERS } from "../../packages/flair-mcp/src/adapter-tools.ts";

const REPO_ROOT = process.cwd();
const FIXTURE = join(REPO_ROOT, "test", "fixtures", "inproc-app");

let harper: HarperInstance;
let appDir: string;
let keyDir: string;
let keyPath: string;
let client: FlairClient;

const sfx = Date.now().toString(36);
const AGENT = `skillredact-${sfx}`;
const SUB = `skillredact-sub-${sfx}`;

const GITHUB_TOKEN = `ghp_${"a".repeat(24)}`;
const AWS_KEY = `AKIA${"B".repeat(16)}`;
const SLACK_TOKEN = `xoxb-${"c".repeat(12)}`;
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

/** The `metadata` blob of a stored skill row, parsed. */
function metadataOf(row: any): Record<string, unknown> {
  if (!row || typeof row.metadata !== "string" || row.metadata.length === 0) return {};
  try {
    const parsed = JSON.parse(row.metadata);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

beforeAll(async () => {
  appDir = await mkdtemp(join(tmpdir(), "flair-inproc-2575-"));
  await cp(FIXTURE, appDir, { recursive: true });
  await mkdir(join(appDir, "node_modules", "@tpsdev-ai"), { recursive: true });
  await symlink(REPO_ROOT, join(appDir, "node_modules", "@tpsdev-ai", "flair"), "dir");
  harper = await startHarper({ cwd: appDir, harperBinDir: REPO_ROOT });
  assertOwnInstance(harper);

  // One agent with a real Ed25519 key, so the REST/stdio client can sign as it.
  keyDir = await mkdtemp(join(tmpdir(), "flair-2575-keys-"));
  const kp = nacl.sign.keyPair();
  keyPath = join(keyDir, `${AGENT}.key`);
  // loadPrivateKey() treats an exactly-32-byte file as a raw Ed25519 seed.
  writeFileSync(keyPath, Buffer.from(kp.secretKey.slice(0, 32)));
  chmodSync(keyPath, 0o600);
  const reg = await fleet("register", { id: AGENT, publicKey: Buffer.from(kp.publicKey).toString("base64") });
  expect(reg.ok, JSON.stringify(reg).slice(0, 300)).toBe(true);
  client = new FlairClient({ agentId: AGENT, url: harper.httpURL, keyPath });

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
}, 60_000);

describe("flair#2575 — REST: a skill write redacts name, description and each tag entry", () => {
  test("POST /Memory stores the redacted skill fields and reports them in `stored`", async () => {
    const name = `deploy ${GITHUB_TOKEN}`;
    const description = `runs the nightly ${AWS_KEY}`;
    const tag = `release-${SLACK_TOKEN}`;
    const out: any = await client.request("POST", "/Memory", {
      agentId: AGENT,
      content: "the procedure",
      trigger: "when deploying",
      tags: ["skill", tag],
      metadata: JSON.stringify({ name, description }),
    });
    expect(out.redactedValues).toBe(3);
    expect(out.stored.name).toBe(`deploy ${REDACTED}`);
    expect(out.stored.description).toBe(`runs the nightly ${REDACTED}`);
    expect(out.stored.tags).toEqual(["skill", `release-${REDACTED}`]);
    expect(out.stored.content).toBe("the procedure");

    const row = await storedRow(out.id);
    expect(metadataOf(row).name).toBe(`deploy ${REDACTED}`);
    expect(metadataOf(row).description).toBe(`runs the nightly ${REDACTED}`);
    expect(row.tags).toEqual(["skill", `release-${REDACTED}`]);
  }, 120_000);

  test("POST /Memory leaves a clean skill field unchanged and reports no count", async () => {
    const out: any = await client.request("POST", "/Memory", {
      agentId: AGENT,
      content: "the procedure",
      trigger: "when deploying",
      tags: ["skill", "release"],
      metadata: JSON.stringify({ name: "deploy", description: "runs the nightly build" }),
    });
    expect(out.redactedValues).toBeUndefined();
    expect(out.stored).toBeUndefined();
    const row = await storedRow(out.id);
    expect(metadataOf(row).name).toBe("deploy");
    expect(metadataOf(row).description).toBe("runs the nightly build");
    expect(row.tags).toEqual(["skill", "release"]);
  }, 120_000);
});

describe("flair#2575 — /mcp skill_store echoes the stored skill fields", () => {
  test("the echo carries the redacted name, description and tags, never the input", async () => {
    const { echo, text } = await mcpTool("skill_store", {
      content: "the procedure",
      trigger: "when deploying",
      name: `deploy ${GITHUB_TOKEN}`,
      description: `runs the nightly ${AWS_KEY}`,
      tags: [`release-${SLACK_TOKEN}`],
    });
    expect(echo.redactedValues).toBe(3);
    expect(echo.name).toBe(`deploy ${REDACTED}`);
    expect(echo.description).toBe(`runs the nightly ${REDACTED}`);
    expect(echo.tags).toEqual(["skill", `release-${REDACTED}`]);
    expect(echo.stored).toBeUndefined();
    expect(text).not.toContain(GITHUB_TOKEN);
    expect(text).not.toContain(AWS_KEY);
    expect(text).not.toContain(SLACK_TOKEN);
    const row = await storedRow(echo.id);
    expect(metadataOf(row).name).toBe(echo.name);
    expect(metadataOf(row).description).toBe(echo.description);
    expect(row.tags).toEqual(echo.tags);
  }, 120_000);

  test("a clean skill write echoes no count and no skill fields", async () => {
    const { echo } = await mcpTool("skill_store", {
      content: "the procedure",
      trigger: "when deploying",
      name: "deploy",
      description: "runs the nightly build",
      tags: ["release"],
    });
    expect(echo.redactedValues).toBeUndefined();
    expect(echo.name).toBeUndefined();
    expect(echo.description).toBeUndefined();
    expect(echo.tags).toBeUndefined();
  }, 120_000);
});

describe("flair#2575 — stdio skill_store echoes the stored name", () => {
  test("the reply's Name: line shows the stored name, never the input", async () => {
    const res: any = await STDIO_TOOL_HANDLERS.skill_store(
      {
        content: "the procedure",
        trigger: "when deploying",
        name: `deploy ${GITHUB_TOKEN}`,
        description: `runs the nightly ${AWS_KEY}`,
        tags: [`release-${SLACK_TOKEN}`],
      },
      { flair: client, agentId: AGENT, heartbeat: () => {}, rememberTask: () => {} } as any,
    );
    const text: string = res.content[0].text;
    expect(res.structuredContent.redactedValues).toBe(3);
    expect(text).toContain(`Name: deploy ${REDACTED}`);
    expect(text).not.toContain(GITHUB_TOKEN);
    expect(text).not.toContain(AWS_KEY);
    expect(text).not.toContain(SLACK_TOKEN);
    const row = await storedRow(res.structuredContent.id);
    expect(metadataOf(row).name).toBe(`deploy ${REDACTED}`);
    expect(metadataOf(row).description).toBe(`runs the nightly ${REDACTED}`);
    expect(row.tags).toEqual(["skill", `release-${REDACTED}`]);
  }, 120_000);

  test("a clean skill write shows the name unchanged and no count", async () => {
    const res: any = await STDIO_TOOL_HANDLERS.skill_store(
      { content: "the procedure", trigger: "when deploying", name: "deploy" },
      { flair: client, agentId: AGENT, heartbeat: () => {}, rememberTask: () => {} } as any,
    );
    const text: string = res.content[0].text;
    expect(res.structuredContent.redactedValues).toBeUndefined();
    expect(text).toContain("Name: deploy");
  }, 120_000);
});
