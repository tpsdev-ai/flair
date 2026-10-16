// ─── flair#2537 — write replies report the STORED (redacted) text, real Harper ─
//
// A Memory write whose text the server redacts answers with `redactedValues`
// and `stored`, the post-redaction text that write committed (flair#2467). This
// file drives each reply surface's shipped code against a real Harper, the
// inproc-app fixture with Flair loaded as a sub-component:
//
//   - the built-in /mcp tools through the shipped `mcpHandler`, with
//     `request.mcp = { sub }` and the sub mapped to the agent by the real
//     identity-mapping flow (the inproc-app `mcpRpc` op; `withMCPAuth`'s JWT
//     check is the one layer not in the loop);
//   - pi-flair's `memory_store`, the real extension with its real FlairClient
//     signing over HTTP;
//   - openclaw-flair's `memory_store`, the real plugin with its real per-agent
//     signing client over HTTP.
//
// Each redacted reply must show the stored text and never the credential-shaped
// input. The stored row is read afterwards through the operations API to prove
// the reply text is what Harper holds. The /mcp block includes a skill
// `memory_update` with `preserveHistory`, the path that writes a successor row.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, mkdir, cp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { startHarper, stopHarper, HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { provisionIdpIdentityMapping } from "../../src/lib/mcp-enable.ts";
import registerPiFlair from "../../packages/pi-flair/src/index.ts";
import openclawPlugin from "../../packages/openclaw-flair/index.ts";

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

beforeAll(async () => {
  appDir = await mkdtemp(join(tmpdir(), "flair-inproc-2537-"));
  await cp(FIXTURE, appDir, { recursive: true });
  await mkdir(join(appDir, "node_modules", "@tpsdev-ai"), { recursive: true });
  await symlink(REPO_ROOT, join(appDir, "node_modules", "@tpsdev-ai", "flair"), "dir");
  harper = await startHarper({ cwd: appDir, harperBinDir: REPO_ROOT });
  assertOwnInstance(harper);

  // One agent with a real Ed25519 key, so the HTTP adapters can sign as it.
  keyDir = await mkdtemp(join(tmpdir(), "flair-2537-keys-"));
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

describe("flair#2537 — the built-in /mcp write echo reports the stored text (shipped mcpHandler)", () => {
  test("memory_store: the echo carries the stored text and the count, never the input", async () => {
    const { echo, text } = await mcpTool("memory_store", { content: `mcp store ${GITHUB_TOKEN} note` });
    expect(echo.redactedValues).toBe(1);
    expect(echo.content).toBe(`mcp store ${REDACTED} note`);
    expect(echo.contentWithheld).toBeUndefined();
    expect(echo.stored).toBeUndefined();
    expect(text).not.toContain(GITHUB_TOKEN);
    expect((await storedRow(echo.id)).content).toBe(echo.content);
  }, 120_000);

  test("memory_update in place: the echo carries the stored text and the count, never the input", async () => {
    const seeded = await mcpTool("memory_store", { content: "seed before the redacted update" });
    const { echo, text } = await mcpTool("memory_update", { id: seeded.echo.id, content: `mcp update ${GITHUB_TOKEN} note` });
    expect(echo.id).toBe(seeded.echo.id);
    expect(echo.redactedValues).toBe(1);
    expect(echo.content).toBe(`mcp update ${REDACTED} note`);
    expect(text).not.toContain(GITHUB_TOKEN);
    expect((await storedRow(echo.id)).content).toBe(echo.content);
  }, 120_000);

  test("skill memory_update with preserveHistory: the echo reports the successor's id and stored text; the predecessor is closed and unchanged", async () => {
    const created = await mcpTool("skill_store", { content: "procedure v1", trigger: "when v1" });
    const predecessorId = created.echo.id;
    expect(typeof predecessorId).toBe("string");
    const { echo, text } = await mcpTool("memory_update", {
      id: predecessorId,
      content: `procedure v2 uses ${GITHUB_TOKEN}`,
      preserveHistory: true,
    });
    expect(echo.id).not.toBe(predecessorId);
    expect(echo.redactedValues).toBe(1);
    expect(echo.content).toBe(`procedure v2 uses ${REDACTED}`);
    expect(echo.trigger).toBe("when v1");
    expect(text).not.toContain(GITHUB_TOKEN);
    const successor = await storedRow(echo.id);
    expect(successor.content).toBe(echo.content);
    const predecessor = await storedRow(predecessorId);
    expect(predecessor.content).toBe("procedure v1");
    expect(predecessor.validTo, "the predecessor must be closed").toBeTruthy();
  }, 120_000);

  test("control: a write the server did not redact carries no count and no text", async () => {
    const { echo } = await mcpTool("memory_store", { content: "a plain note with no credential-shaped text" });
    expect(echo.redactedValues).toBeUndefined();
    expect(echo.content).toBeUndefined();
    expect(echo.contentWithheld).toBeUndefined();
  }, 120_000);
});

describe("flair#2537 — pi-flair memory_store reports the stored text (real extension and client)", () => {
  async function piStore(content: string): Promise<any> {
    const saved = { url: process.env.FLAIR_URL, id: process.env.FLAIR_AGENT_ID, key: process.env.FLAIR_KEY_PATH };
    process.env.FLAIR_URL = harper.httpURL;
    process.env.FLAIR_AGENT_ID = AGENT;
    process.env.FLAIR_KEY_PATH = keyPath;
    try {
      const tools = new Map<string, any>();
      registerPiFlair({ registerTool: (spec: any) => tools.set(spec.name, spec), on() {} } as any);
      return await tools.get("memory_store").execute("2537", { content });
    } finally {
      for (const [k, v] of [["FLAIR_URL", saved.url], ["FLAIR_AGENT_ID", saved.id], ["FLAIR_KEY_PATH", saved.key]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  test("the reply previews the stored text and states the count, never the input", async () => {
    const res = await piStore(`pi store ${GITHUB_TOKEN} note`);
    const text: string = res.content[0].text;
    expect(res.details.written, text).toBe(true);
    expect(text).toContain(`Preview: pi store ${REDACTED} note`);
    expect(text).toContain("Redacted 1 credential-shaped value(s) before storing.");
    expect(text).not.toContain(GITHUB_TOKEN);
    expect(res.details.redactedValues).toBe(1);
    expect(res.details.contentWithheld).toBeUndefined();
    expect((await storedRow(res.details.id)).content).toBe(`pi store ${REDACTED} note`);
  }, 120_000);
});

describe("flair#2537 — openclaw-flair memory_store reports the stored text (real plugin and client)", () => {
  function openclawStoreTool(): any {
    const tools = new Map<string, (ctx: any) => any>();
    const api = {
      id: "openclaw-flair",
      runtime: { version: "2026.9.6" },
      config: { agents: { entries: { [AGENT]: {} } }, plugins: { slots: { memory: "openclaw-flair" }, entries: {} } },
      pluginConfig: { url: harper.httpURL, agentId: AGENT, keyPath },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      on() {},
      registerTool(factory: (ctx: any) => any, meta: { name: string }) { tools.set(meta.name, factory); },
      registerService() {},
      registerContextEngine() {},
    };
    openclawPlugin.register(api as any);
    const factory = tools.get("memory_store");
    if (!factory) throw new Error("openclaw-flair registered no memory_store");
    return factory({ agentId: AGENT });
  }

  test("the reply previews the stored text and states the count, never the input", async () => {
    const res = await openclawStoreTool().execute("2537", { text: `openclaw store ${GITHUB_TOKEN} note` });
    const text: string = res.content[0].text;
    expect(res.details.written, text).toBe(true);
    expect(text).toContain(`Preview: openclaw store ${REDACTED} note`);
    expect(text).toContain("Redacted 1 credential-shaped value(s) before storing.");
    expect(text).not.toContain(GITHUB_TOKEN);
    expect(res.details.redactedValues).toBe(1);
    expect(res.details.contentWithheld).toBeUndefined();
    expect((await storedRow(res.details.id)).content).toBe(`openclaw store ${REDACTED} note`);
  }, 120_000);
});
