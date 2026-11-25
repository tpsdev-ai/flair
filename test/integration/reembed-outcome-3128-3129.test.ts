/**
 * reembed-outcome-3128-3129.test.ts — `flair reembed`'s end-of-run outcome and
 * the keyless listing's row ownership, through the real CLI and a real
 * ephemeral Harper (flair#3128, flair#3129).
 *
 * A recording proxy in front of Harper refuses one Memory PATCH on request, so
 * each path (all-agent, single-agent with an administrator password) can be
 * run with a failing write: the run exits non-zero and its summary names the
 * count and the reason. A clean run keeps the previous output and exits 0. An
 * all-agent run whose HOME lacks one agent's key exits non-zero and names the
 * agent and the remedy.
 *
 * Without FLAIR_ADMIN_PASS, `reembed --agent <id>` lists rows with
 * POST /SemanticSearch, whose read scope includes other agents' non-private
 * rows: this file seeds one such row for each of two other agents and asserts
 * the run neither counts nor writes them, and reports the skipped count.
 *
 * Throwaway HOMEs, ephemeral ports, the boot migration trigger omitted, no
 * assertion reads a vector. Each request target is asserted to be this test's
 * instance.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { startHarper, stopHarper, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { componentWithoutMigrationBoot, type ComposedComponent } from "../helpers/component-without-migration-boot";
import { ensureCliBuild, spawnCli } from "../helpers/build-cli-once";
import { getModelId } from "../../resources/embeddings-provider.ts";

const AGENT_A = "r3o-agent-a";
const AGENT_B = "r3o-agent-b";
const AGENT_C = "r3o-agent-c";
const A_ROWS = ["r3o-a-1", "r3o-a-2"];
const B_ROW = "r3o-b-1";
const C_ROW = "r3o-c-1";
const REFUSED_ROW = A_ROWS[0];

const agentA = { id: AGENT_A, ...nacl.sign.keyPair() };
const agentB = { id: AGENT_B, ...nacl.sign.keyPair() };
const agentC = { id: AGENT_C, ...nacl.sign.keyPair() };

let component: ComposedComponent;
let harper: HarperInstance;
let homeAllKeys: string;
let homeMissingC: string;
let homeOnlyA: string;
let proxyPort = 0;
let refusePatchId: string | null = null;
const patchUrls: string[] = [];
const servers: Server[] = [];

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

type Agent = { id: string; publicKey: Uint8Array; secretKey: Uint8Array };

function memoryRow(id: string, agentId: string, visibility: string): Record<string, unknown> {
  return {
    id,
    agentId,
    content: `Release checklist ${id}: verify the tarball checksum before tagging.`,
    createdAt: "2021-03-01T00:00:00.000Z",
    updatedAt: "2021-03-02T00:00:00.000Z",
    embeddingModel: "old-model",
    visibility,
    archived: false,
  };
}

async function rowState(id: string): Promise<{ embeddingModel: unknown; updatedAt: unknown }> {
  const rows = await op({
    operation: "search_by_id",
    database: "flair",
    table: "Memory",
    ids: [id],
    get_attributes: ["id", "embeddingModel", "updatedAt"],
  });
  expect(rows[0]?.id).toBe(id);
  return rows[0];
}

/** A reverse proxy that records every Memory PATCH and can refuse one row's. */
async function startProxy(target: string): Promise<number> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      const payload = Buffer.concat(chunks);
      if (req.method === "PATCH") patchUrls.push(req.url ?? "");
      if (refusePatchId && req.method === "PATCH" && req.url === `/Memory/${refusePatchId}`) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "write refused" }));
        return;
      }
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
        const upstreamBody = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") ?? "application/json" });
        res.end(upstreamBody);
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

function makeHome(label: string, agents: Agent[]): string {
  const home = mkdtempSync(join(tmpdir(), `flair-${label}-home-`));
  const keysDir = join(home, ".flair", "keys");
  mkdirSync(keysDir, { recursive: true });
  for (const agent of agents) {
    writeFileSync(join(keysDir, `${agent.id}.key`), agent.secretKey.slice(0, 32), { mode: 0o600 });
  }
  return home;
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  ensureCliBuild();
  homeAllKeys = makeHome("3128-all", [agentA, agentB, agentC]);
  homeMissingC = makeHome("3128-missing-c", [agentA, agentB]);
  homeOnlyA = makeHome("3128-only-a", [agentA]);
  component = componentWithoutMigrationBoot();
  harper = await startHarper({ cwd: component.dir, harperBinDir: component.sourceRoot });
  for (const url of [new URL(harper.httpURL), new URL(harper.opsURL)]) {
    expect(url.hostname).toBe("127.0.0.1");
    expect(["9925", "9926"]).not.toContain(url.port);
  }
  const now = new Date().toISOString();
  await op({
    operation: "upsert",
    database: "flair",
    table: "Agent",
    records: [agentA, agentB, agentC].map((a) => ({
      id: a.id, name: a.id, role: "agent", publicKey: Buffer.from(a.publicKey).toString("base64"), createdAt: now,
    })),
  });
  await op({
    operation: "insert",
    database: "flair",
    table: "Memory",
    records: [
      ...A_ROWS.map((id) => memoryRow(id, AGENT_A, "private")),
      memoryRow(B_ROW, AGENT_B, "public"),
      memoryRow(C_ROW, AGENT_C, "public"),
    ],
  });
  proxyPort = await startProxy(harper.httpURL);
}, 240_000);

afterAll(async () => {
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (harper) await stopHarper(harper);
  component?.cleanup();
  for (const home of [homeAllKeys, homeMissingC, homeOnlyA]) if (home) rmSync(home, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

type Run = { code: number | null; stdout: string; stderr: string };

async function runReembed(args: string[], home: string, admin: boolean): Promise<Run> {
  patchUrls.length = 0;
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(FLAIR_|HARPER_|HDB_|FABRIC_)/.test(key)));
  const env: Record<string, string | undefined> = {
    ...base,
    HOME: home,
    FLAIR_OPS_PORT: new URL(harper.opsURL).port,
    NO_COLOR: "1",
  };
  if (admin) {
    env.FLAIR_ADMIN_USER = harper.admin.username;
    env.FLAIR_ADMIN_PASS = harper.admin.password;
  }
  const child = spawnCli([...args, "--port", String(proxyPort), "--batch-size", "1", "--delay-ms", "0"], {
    env,
    timeout: 180_000,
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (exitCode) => resolve(exitCode));
  });
  return { code, stdout, stderr };
}

test("a clean all-agent run exits 0 with the unchanged summary", async () => {
  refusePatchId = null;
  const { code, stdout, stderr } = await runReembed(["reembed"], homeAllKeys, true);
  expect(code, stderr.slice(0, 800)).toBe(0);
  expect(stdout).toContain("✅ Re-embedding complete: 4 updated, 0 errors");
  expect(stdout).not.toContain("❌");
  expect(stdout).not.toContain("row(s) not updated");
}, 240_000);

test("a clean single-agent run exits 0 with the unchanged summary", async () => {
  refusePatchId = null;
  const { code, stdout, stderr } = await runReembed(["reembed", "--agent", AGENT_A], homeAllKeys, true);
  expect(code, stderr.slice(0, 800)).toBe(0);
  expect(stdout).toContain("Candidates for re-embedding: 2");
  expect(stdout).toContain("✅ Re-embedding complete: 2 updated, 0 errors");
  expect(stdout).not.toContain("❌");
}, 240_000);

test("a refused write in the all-agent path exits 1 and names the count and reason", async () => {
  refusePatchId = REFUSED_ROW;
  const { code, stdout, stderr } = await runReembed(["reembed"], homeAllKeys, true);
  expect(code, stderr.slice(0, 800)).toBe(1);
  expect(stdout).toContain("❌ Re-embedding complete: 3 updated, 1 errors");
  expect(stdout).toContain("1 row(s) not updated: HTTP 500");
  expect(stdout).not.toContain("✅ Re-embedding complete");
}, 240_000);

test("a refused write in the single-agent path exits 1 and names the count and reason", async () => {
  refusePatchId = REFUSED_ROW;
  const { code, stdout, stderr } = await runReembed(["reembed", "--agent", AGENT_A], homeAllKeys, true);
  expect(code, stderr.slice(0, 800)).toBe(1);
  expect(stdout).toContain("❌ Re-embedding complete: 1 updated, 1 errors");
  expect(stdout).toContain("1 row(s) not updated: HTTP 500");
  expect(stdout).not.toContain("✅ Re-embedding complete");
}, 240_000);

test("an all-agent run with one agent's key missing exits 1 and names the agent and the remedy", async () => {
  refusePatchId = null;
  const before = await rowState(C_ROW);
  const { code, stdout, stderr } = await runReembed(["reembed"], homeMissingC, true);
  expect(code, stderr.slice(0, 800)).toBe(1);
  expect(stdout).toContain("❌ Re-embedding complete: 3 updated, 0 errors, 1 skipped agent");
  expect(stdout).toContain(`Agent ${AGENT_C} skipped: key not found`);
  expect(stdout).toContain("create or restore that agent's key");
  expect(stdout).toContain(`flair reembed --agent ${AGENT_C}`);
  expect(await rowState(C_ROW)).toEqual(before);
}, 240_000);

test("a --dry-run all-agent run with a missing key keeps the previous exit and summary", async () => {
  refusePatchId = null;
  const { code, stdout, stderr } = await runReembed(["reembed", "--dry-run"], homeMissingC, true);
  expect(code, stderr.slice(0, 800)).toBe(0);
  expect(stdout).toContain("✅ Re-embedding complete: 0 updated, 0 errors");
  expect(stdout).not.toContain("skipped: key not found");
}, 240_000);

test("keyless single-agent skips other agents' listed rows without counting or writing them", async () => {
  refusePatchId = null;
  const beforeB = await rowState(B_ROW);
  const beforeC = await rowState(C_ROW);
  const { code, stdout, stderr } = await runReembed(["reembed", "--agent", AGENT_A], homeOnlyA, false);
  expect(code, stderr.slice(0, 800)).toBe(0);
  expect(stdout).toContain("Candidates for re-embedding: 2");
  expect(stdout).toContain("Skipped (other agents): 2");
  expect(stdout).toContain(`✅ Re-embedding complete: 2 updated, 0 errors`);
  expect(await rowState(B_ROW)).toEqual(beforeB);
  expect(await rowState(C_ROW)).toEqual(beforeC);
  expect(patchUrls.filter((url) => url === `/Memory/${B_ROW}` || url === `/Memory/${C_ROW}`)).toEqual([]);
}, 240_000);

test("the seeded rows are current after the runs (the re-embeds the assertions relied on)", async () => {
  for (const id of [...A_ROWS, B_ROW]) expect((await rowState(id)).embeddingModel).toBe(getModelId());
}, 60_000);
