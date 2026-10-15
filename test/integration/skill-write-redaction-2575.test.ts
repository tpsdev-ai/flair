// Skill POST, PUT without `_reindex`, and feed writes refuse metadata with
// duplicate top-level keys; otherwise name/description and string tags are redacted.
// After a counted redaction, successful Memory POST and PUT responses report
// the skill fields in `stored`; feed returns the written row directly with
// `redactedValues`. After a counted redaction, /mcp echoes the stored skill fields;
// stdio renders the stored name, with no description or tags. On a clean
// write, stdio uses the input name.
//
// This file drives each surface against a REAL Harper (the inproc-app fixture,
// Flair loaded as a sub-component — test/helpers/harper-lifecycle.ts):
//
//   - REST:  the real FlairClient signs a POST /Memory carrying the skill fields;
//   - /mcp:  the shipped `mcpHandler`, with `request.mcp = { sub }` and the sub
//            mapped to the agent by the real identity-mapping flow;
//   - stdio: the shipped `STDIO_TOOL_HANDLERS.skill_store` over the real client.
//
// Coverage per surface: REST and /mcp assert every redacted skill field on the
// stored row and in the reply/echo; stdio asserts the `Name:` line after a
// counted redaction and every field on the stored row. Clean field values
// are unchanged. The stored row is read afterwards through the
// operations API to prove the reported value is what Harper holds.
//
// It also drives the built-in /mcp `memory_basement` / `memory_restore` against
// real Harper and applies each tool's declared contract to its real reply
// (flair#2575).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, mkdir, cp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { conform } from "../helpers/mcp-conformance";
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

describe("flair#2575 — REST: skill fields with distinct top-level metadata keys", () => {
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

describe("flair#2575 — stdio skill_store uses the stored name after a counted redaction", () => {
  test("after a counted redaction, the reply's Name: line shows the stored name", async () => {
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

describe("flair#2575 — inherited skill tags with distinct top-level metadata keys", () => {
  test("a PUT that omits `tags` on a stored skill redacts the supplied metadata name/description", async () => {
    const created: any = await client.request("POST", "/Memory", {
      agentId: AGENT,
      content: "procedure v1",
      trigger: "when deploying",
      tags: ["skill"],
      metadata: JSON.stringify({ name: "deploy", description: "runs the nightly build" }),
    });
    const put: any = await client.request("PUT", `/Memory/${created.id}`, {
      id: created.id,
      agentId: AGENT,
      content: "procedure v2",
      trigger: "when deploying",
      metadata: JSON.stringify({ name: `deploy ${GITHUB_TOKEN}`, description: `runs the nightly ${AWS_KEY}` }),
    });
    expect(put.redactedValues).toBe(2);
    expect(put.stored.name).toBe(`deploy ${REDACTED}`);
    expect(put.stored.description).toBe(`runs the nightly ${REDACTED}`);
    expect(JSON.stringify(put)).not.toContain(GITHUB_TOKEN);
    const row = await storedRow(put.id);
    expect(row.tags).toContain("skill");
    expect(metadataOf(row).name).toBe(`deploy ${REDACTED}`);
    expect(metadataOf(row).description).toBe(`runs the nightly ${REDACTED}`);
  }, 120_000);

  test("a superseding POST that omits `tags` inherits the skill tag and redacts the supplied metadata name", async () => {
    const root: any = await client.request("POST", "/Memory", {
      agentId: AGENT, content: "root procedure", trigger: "when deploying", tags: ["skill"],
    });
    const succ: any = await client.request("POST", "/Memory", {
      agentId: AGENT, content: "successor procedure", trigger: "when deploying", supersedes: root.id,
      metadata: JSON.stringify({ name: `deploy ${GITHUB_TOKEN}` }),
    });
    expect(succ.redactedValues).toBe(1);
    expect(succ.stored.name).toBe(`deploy ${REDACTED}`);
    expect(JSON.stringify(succ)).not.toContain(GITHUB_TOKEN);
    const row = await storedRow(succ.id);
    expect(row.tags).toContain("skill");
    expect(metadataOf(row).name).toBe(`deploy ${REDACTED}`);
  }, 120_000);

  test("a feed ingest that omits `tags` inherits the skill tag and redacts the supplied metadata name", async () => {
    const root: any = await client.request("POST", "/Memory", {
      agentId: AGENT, content: "feed procedure v1", trigger: "when deploying", tags: ["skill"],
    });
    const feed: any = await client.request("POST", "/FeedMemories", {
      id: root.id, agentId: AGENT, content: "feed procedure v2", trigger: "when deploying",
      metadata: JSON.stringify({ name: `deploy ${GITHUB_TOKEN}` }),
    });
    expect(feed.redactedValues).toBe(1);
    expect(JSON.stringify(feed)).not.toContain(GITHUB_TOKEN);
    expect(feed.tags).toContain("skill");
    expect(metadataOf(feed).name).toBe(`deploy ${REDACTED}`);
    const row = await storedRow(feed.id);
    expect(metadataOf(row).name).toBe(`deploy ${REDACTED}`);
  }, 120_000);
});

describe("flair#2575 — `stored.tags` reports the accepted entries of the stored array", () => {
  test("a redacted skill write with a null tag reports the array including the null", async () => {
    const out: any = await client.request("POST", "/Memory", {
      agentId: AGENT, content: "the procedure", trigger: "when deploying",
      tags: ["skill", null, `release-${SLACK_TOKEN}`],
      metadata: JSON.stringify({ name: "deploy" }),
    });
    expect(out.redactedValues).toBe(1);
    expect(out.stored.tags).toEqual(["skill", null, `release-${REDACTED}`]);
    const row = await storedRow(out.id);
    expect(row.tags).toEqual(["skill", null, `release-${REDACTED}`]);
  }, 120_000);
});

describe("flair#2575 — the archive tools' contracts hold on their real Harper replies", () => {
  test("memory_basement's declared contract holds on its real reply, including `written`", async () => {
    const { TOOLS } = await import("../../resources/mcp-tools.ts");
    const created = await mcpTool("memory_store", { content: "a plain note for basement" });
    const { echo } = await mcpTool("memory_basement", { id: created.echo.id });
    conform("memory_basement", echo, TOOLS.memory_basement.contract as any);
    expect(echo.id).toBe(created.echo.id);
    expect(echo.written).toBe(true);
    const row = await storedRow(created.echo.id);
    expect(row.archived).toBe(true);
  }, 120_000);

  test("memory_restore's declared contract holds on its real reply, including `written`", async () => {
    const { TOOLS } = await import("../../resources/mcp-tools.ts");
    const created = await mcpTool("memory_store", { content: "a plain note for restore" });
    const { echo } = await mcpTool("memory_restore", { id: created.echo.id });
    conform("memory_restore", echo, TOOLS.memory_restore.contract as any);
    expect(echo.id).toBe(created.echo.id);
    expect(echo.written).toBe(true);
    const row = await storedRow(created.echo.id);
    expect(row.archived).toBe(false);
  }, 120_000);
});


const metadataWritePaths = ["POST", "PUT create", "feed create", "PUT inherited", "superseding POST", "feed inherited"] as const;
type MetadataWritePath = (typeof metadataWritePaths)[number];

async function metadataWrite(path: MetadataWritePath, metadata: string, summary: string) {
  const id = `metadata-${crypto.randomUUID()}`;
  let root: any;
  if (path === "PUT inherited" || path === "superseding POST" || path === "feed inherited") {
    root = await client.request("POST", "/Memory", {
      agentId: AGENT, content: `root ${id}`, trigger: "when deploying", tags: ["skill"],
      metadata: JSON.stringify({ name: "deploy" }),
    });
  }
  const before = root ? await storedRow(root.id) : undefined;
  const body: Record<string, unknown> = {
    id, agentId: AGENT, content: `procedure ${id}`, trigger: "when deploying", metadata, summary,
  };
  if (!root) body.tags = ["skill"];
  else if (path === "superseding POST") body.supersedes = root.id;
  else body.id = root.id;
  const method = path.startsWith("PUT") ? "PUT" : "POST";
  const endpoint = path.startsWith("feed") ? "/FeedMemories" : method === "PUT" ? `/Memory/${body.id}` : "/Memory";
  const response = await fetch(`${harper.httpURL}${endpoint}`, {
    method, headers: { "Content-Type": "application/json", Authorization: adminAuth() },
    body: JSON.stringify(body),
  });
  return { response, id: body.id as string, root, before };
}

async function agentMemoryRows(): Promise<any[]> {
  const response = await fetch(harper.opsURL, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: adminAuth() },
    body: JSON.stringify({ operation: "search_by_value", database: "flair", table: "Memory", search_attribute: "agentId", search_value: AGENT, get_attributes: ["*"] }),
  });
  expect(response.status).toBe(200);
  return (await response.json() as any[]).sort((a, b) => a.id.localeCompare(b.id));
}

describe("skill writes require distinct top-level metadata keys", () => {
  for (const path of metadataWritePaths) {
    for (const key of ["name", "description", "source", "na\\u006de"]) {
      test(`${path} refuses duplicate ${key} keys with no supplied metadata in its reply or rows`, async () => {
        const firstKey = key === "na\\u006de" ? "name" : key;
        const metadata = `{"${firstKey}":"${GITHUB_TOKEN}","${key}":"deploy"}`;
        const { response, id, root, before } = await metadataWrite(path, metadata, `summary ${AWS_KEY}`);
        expect(response.status).toBe(400);
        const reply = await response.text();
        expect(JSON.parse(reply)).toEqual({ error: "skill_metadata_duplicate_key" });
        expect(reply).not.toContain(GITHUB_TOKEN);
        expect(reply).not.toContain(AWS_KEY);
        if (root && path !== "superseding POST") expect(await storedRow(id)).toEqual(before);
        else expect(await storedRow(id)).toBeUndefined();
        if (root) expect(await storedRow(root.id)).toEqual(before);
        const rows = await agentMemoryRows();
        expect(JSON.stringify(rows)).not.toContain(GITHUB_TOKEN);
        expect(JSON.stringify(rows)).not.toContain(AWS_KEY);
        if (root) expect(rows.filter((row) => row.supersedes === root.id)).toEqual([]);
      }, 120_000);
    }

    test(`${path} redacts metadata and summary in a valid write's raw row and reply`, async () => {
      const metadata = JSON.stringify({ name: `deploy ${GITHUB_TOKEN}`, description: `nightly ${AWS_KEY}` });
      const { response } = await metadataWrite(path, metadata, `summary ${SLACK_TOKEN}`);
      expect(response.ok).toBe(true);
      const reply = await response.text();
      const out = JSON.parse(reply);
      expect(out.redactedValues).toBe(3);
      const row = await storedRow(out.id);
      expect(typeof row.metadata).toBe("string");
      expect(metadataOf(row)).toEqual({ name: `deploy ${REDACTED}`, description: `nightly ${REDACTED}` });
      expect(row.summary).toBe(`summary ${REDACTED}`);
      for (const credential of [GITHUB_TOKEN, AWS_KEY, SLACK_TOKEN]) {
        expect(row.metadata).not.toContain(credential);
        expect(JSON.stringify(row)).not.toContain(credential);
        expect(reply).not.toContain(credential);
      }
    }, 120_000);
  }
});


test("a skill reindex refuses duplicate top-level metadata keys before row comparison", async () => {
  const created: any = await client.request("POST", "/Memory", {
    agentId: AGENT, content: `reindex ${crypto.randomUUID()}`, trigger: "when deploying", tags: ["skill"],
    metadata: JSON.stringify({ name: "deploy" }),
  });
  const before = await storedRow(created.id);
  const response = await fetch(`${harper.httpURL}/Memory/${created.id}`, {
    method: "PUT", headers: { "Content-Type": "application/json", Authorization: adminAuth() },
    body: JSON.stringify({ id: created.id, _reindex: true, metadata: `{"name":"${GITHUB_TOKEN}","name":"deploy"}` }),
  });
  expect(response.status).toBe(400);
  const reply = await response.text();
  expect(JSON.parse(reply).error).toBe("skill_metadata_duplicate_key");
  expect(reply).not.toContain(GITHUB_TOKEN);
  expect(await storedRow(created.id)).toEqual(before);
}, 120_000);
