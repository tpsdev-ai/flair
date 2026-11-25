/**
 * reembed-command-paging-3086.test.ts — `flair reembed --stale-only` through the
 * real CLI and a real ephemeral Harper, on both administrator paths
 * (flair#3086).
 *
 * Memory is seeded with 2,003 rows in one operations insert: 2,000 already
 * current and 3 stale rows whose ids sort last (page 3 of 3). A recording proxy
 * sits between the CLI and Harper, so the test can assert the printed read count
 * and page count, that the stale rows are re-embedded, and that every operations
 * read request arrives before the first Memory PATCH.
 *
 * Throwaway HOME + data dir, ephemeral ports; the administrator password is
 * never printed. Each request target is asserted to be this test's instance.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { startHarper, stopHarper, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { ensureCliBuild, spawnCli } from "../helpers/build-cli-once";
import { getModelId } from "../../resources/embeddings-provider.ts";

const CURRENT_MODEL_ID = getModelId();
const ADMIN_PASS = "test123";
const AGENT_ID = "p6-agent-a";
const TOTAL_ROWS = 2_003;
const STALE_IDS = ["p6-z-0001", "p6-z-0002", "p6-z-0003"];
let harper: HarperInstance;
let home: string;

const agent = { id: AGENT_ID, ...nacl.sign.keyPair() };
const opsAuth = () => "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");

async function op(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: opsAuth() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(200);
  return JSON.parse(text);
}

function memoryRow(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    agentId: AGENT_ID,
    content: `Release checklist ${id}: verify the tarball checksum before tagging.`,
    createdAt: "2021-03-01T00:00:00.000Z",
    updatedAt: "2021-03-02T00:00:00.000Z",
    embeddingModel: CURRENT_MODEL_ID,
    ...overrides,
  };
}

const staleRow = (id: string) => memoryRow(id, {
  embeddingModel: "old-model",
  // The all-agent read must not filter on createdAt: this row predates 1970.
  createdAt: id === STALE_IDS[STALE_IDS.length - 1] ? "1960-01-01T00:00:00Z" : "2021-03-01T00:00:00.000Z",
});

async function storedStamp(id: string): Promise<unknown> {
  const rows = await op({ operation: "search_by_id", database: "flair", table: "Memory", ids: [id], get_attributes: ["id", "embeddingModel"] });
  return rows[0]?.embeddingModel;
}

async function resetStaleRows(): Promise<void> {
  await op({ operation: "upsert", database: "flair", table: "Memory", records: STALE_IDS.map(staleRow) });
}

type Recorded = { seq: number; kind: "read" | "write" | "other"; method: string; url: string };
const events: Recorded[] = [];
const servers: Server[] = [];

/** A recording reverse proxy: forwards to `target`, notes what arrived. */
async function startProxy(target: string): Promise<number> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      const payload = Buffer.concat(chunks);
      let kind: Recorded["kind"] = "other";
      if (req.method === "POST" && req.url === "/") {
        try {
          const parsed = JSON.parse(payload.toString("utf8")) as { operation?: string };
          if (parsed.operation === "search_by_conditions") kind = "read";
        } catch {
          /* not a JSON operations request */
        }
      }
      if (req.method === "PATCH" && req.url?.startsWith("/Memory/")) kind = "write";
      events.push({ seq: events.length + 1, kind, method: req.method ?? "", url: req.url ?? "" });

      const headers: Record<string, string> = {};
      if (req.headers["content-type"]) headers["content-type"] = String(req.headers["content-type"]);
      if (req.headers.authorization) headers.authorization = String(req.headers.authorization);
      try {
        const upstream = await fetch(`${target}${req.url}`, {
          method: req.method,
          headers,
          body: payload.length > 0 ? payload : undefined,
          signal: AbortSignal.timeout(120_000),
        });
        res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") ?? "application/json" });
        res.end(Buffer.from(await upstream.arrayBuffer()));
      } catch {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "proxy upstream failed" }));
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  ensureCliBuild();
  home = mkdtempSync(join(tmpdir(), "flair-3086-cli-home-"));
  const keysDir = join(home, ".flair", "keys");
  mkdirSync(keysDir, { recursive: true });
  writeFileSync(join(keysDir, `${AGENT_ID}.key`), agent.secretKey.slice(0, 32), { mode: 0o600 });
  harper = await startHarper();
  for (const url of [new URL(harper.httpURL), new URL(harper.opsURL)]) {
    expect(url.hostname).toBe("127.0.0.1");
    expect(["9925", "9926"]).not.toContain(url.port);
  }
  await op({
    operation: "upsert",
    database: "flair",
    table: "Agent",
    records: [{ id: AGENT_ID, name: AGENT_ID, role: "agent", publicKey: Buffer.from(agent.publicKey).toString("base64"), createdAt: new Date().toISOString() }],
  });
  const rows = [
    ...Array.from({ length: TOTAL_ROWS - STALE_IDS.length }, (_, i) => memoryRow(`p6-a-${String(i + 1).padStart(4, "0")}`)),
    ...STALE_IDS.map(staleRow),
  ];
  await op({ operation: "insert", database: "flair", table: "Memory", records: rows });
}, 240_000);

afterAll(async () => {
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (harper) await stopHarper(harper);
  if (home) rmSync(home, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

afterEach(() => {
  events.length = 0;
});

let httpProxyPort = 0;
let opsProxyPort = 0;

async function runReembed(agentId?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  if (!httpProxyPort) {
    httpProxyPort = await startProxy(harper.httpURL);
    opsProxyPort = await startProxy(harper.opsURL);
  }
  events.length = 0;
  await resetStaleRows();
  const args = ["reembed", "--stale-only", "--port", String(httpProxyPort)];
  if (agentId) args.push("--agent", agentId);
  const env = {
    ...process.env,
    HOME: home,
    FLAIR_OPS_PORT: String(opsProxyPort),
    FLAIR_ADMIN_PASS: ADMIN_PASS,
    NO_COLOR: "1",
  };
  const child = spawnCli(args, { env, timeout: 180_000 });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (exitCode) => resolve(exitCode));
  });
  return { code, stdout, stderr };
}

function assertReadsBeforeFirstPatch(reads: number): void {
  const readEvents = events.filter((event) => event.kind === "read");
  const writeEvents = events.filter((event) => event.kind === "write");
  expect(readEvents).toHaveLength(reads);
  expect(writeEvents.length).toBeGreaterThan(0);
  const firstWrite = Math.min(...writeEvents.map((event) => event.seq));
  expect(Math.max(...readEvents.map((event) => event.seq))).toBeLessThan(firstWrite);
}

for (const path of [{ name: "all-agent", agentId: undefined }, { name: "single-agent with an admin password", agentId: AGENT_ID }]) {
  test(`the ${path.name} path reads 2,003 rows in 3 pages and re-embeds the 3 stale rows`, async () => {
    const { code, stdout, stderr } = await runReembed(path.agentId);
    expect(code, stderr.slice(0, 800)).toBe(0);
    expect(stdout).toContain(`Read ${TOTAL_ROWS} memories in 3 page(s)`);
    if (path.agentId) expect(stdout).toContain("Candidates for re-embedding: 3");
    else expect(stdout).toContain("Memories to re-embed: 3");
    assertReadsBeforeFirstPatch(3);
    for (const id of STALE_IDS) expect(await storedStamp(id)).toBe(CURRENT_MODEL_ID);
  }, 300_000);
}
