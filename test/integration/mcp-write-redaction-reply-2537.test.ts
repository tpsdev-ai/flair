// ─── flair#2537 — the /mcp write replies report the STORED (redacted) content ─
//
// The built-in `/mcp` write tools (resources/mcp-tools.ts) returned the raw
// write response. The server replaces credential-shaped text before it stores a
// Memory and reports the count on the write response (`redactedValues`) but does
// NOT echo the stored `content`, so the reply carried no stored text at all.
// This drives the REAL `TOOLS.<tool>.impl` wrappers through the inproc-app
// fixture (the same harness mcp-byid-read-static-pattern.test.ts uses), against a
// HOME-isolated ephemeral Harper, so the whole path is the shipped one: the write
// redacts on the server and the wrapper re-reads the stored row by id.
//
// The load-bearing assertions:
//   1. a redacted write's reply carries the STORED (redacted) content and the
//      count — and never the caller's token;
//   2. a write the server did not redact is unchanged (no count, no content echo)
//      and makes no extra request.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, cp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";

const REPO_ROOT = process.cwd();
const FIXTURE = join(REPO_ROOT, "test", "fixtures", "inproc-app");

let harper: HarperInstance;
let appDir: string;

const sfx = Date.now().toString(36);
const AGENT = `mcpredact-${sfx}`;

const GITHUB_TOKEN = `ghp_${"a".repeat(24)}`;
const REDACTED = "[redacted]";

/** Drive one in-process operation inside the fixture app. */
async function fleet(op: string, body: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(`${harper.httpURL}/AgentFleet/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify({ op, ...body }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`AgentFleet ${op} → HTTP ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

/** Call a /mcp tool wrapper (`TOOLS[tool].impl`) as AGENT and unwrap the run() envelope. */
async function tool(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = await fleet("mcpTool", { agentId: AGENT, tool: name, args, isAdmin: false });
  expect(res.ok, `mcpTool ${name} failed: ${JSON.stringify(res).slice(0, 500)}`).toBe(true);
  return res.value;
}

beforeAll(async () => {
  appDir = await mkdtemp(join(tmpdir(), "flair-inproc-2537-"));
  await cp(FIXTURE, appDir, { recursive: true });
  await mkdir(join(appDir, "node_modules", "@tpsdev-ai"), { recursive: true });
  await symlink(REPO_ROOT, join(appDir, "node_modules", "@tpsdev-ai", "flair"), "dir");
  harper = await startHarper({ cwd: appDir, harperBinDir: REPO_ROOT });
  await fleet("register", { id: AGENT });
}, 300_000);

afterAll(async () => {
  const dataDir = harper?.installDir;
  if (harper) await stopHarper(harper);
  if (dataDir) await rm(dataDir, { recursive: true, force: true, maxRetries: 4 });
  if (appDir) await rm(appDir, { recursive: true, force: true });
});

describe("flair#2537 — /mcp write replies report the STORED (redacted) content", () => {
  test("memory_store's reply carries the STORED redacted text and the count, never the caller's token", async () => {
    const res: any = await tool("memory_store", { content: `mcp redact ${GITHUB_TOKEN} note`, durability: "standard" });
    expect(res.redactedValues).toBe(1);
    expect(res.content).toBe(`mcp redact ${REDACTED} note`);
    expect(JSON.stringify(res)).not.toContain(GITHUB_TOKEN);
  }, 120_000);

  test("memory_update's reply carries the STORED redacted text and the count", async () => {
    const seeded: any = await tool("memory_store", { content: "seed before the redacted update", durability: "standard" });
    expect(typeof seeded.id).toBe("string");
    const res: any = await tool("memory_update", { id: seeded.id, content: `mcp redact update ${GITHUB_TOKEN} note` });
    expect(res.redactedValues).toBe(1);
    expect(res.content).toBe(`mcp redact update ${REDACTED} note`);
    expect(JSON.stringify(res)).not.toContain(GITHUB_TOKEN);
  }, 120_000);

  test("a write the server did not redact reports no count and echoes no stored content", async () => {
    const res: any = await tool("memory_store", { content: "a plain note with no credential-shaped text", durability: "standard" });
    expect(res.redactedValues).toBeUndefined();
    expect(res.content).toBeUndefined();
  }, 120_000);
});
