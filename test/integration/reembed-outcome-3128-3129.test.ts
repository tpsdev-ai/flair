/**
 * reembed-outcome-3128-3129.test.ts — `flair reembed`'s end-of-run outcome and
 * the keyless listing's row ownership, through the real CLI and a real
 * ephemeral Harper (flair#3128, flair#3129).
 *
 * The successful, instance-id and unproven-pair cases target Harper's real
 * HTTP and ops ports, so the all-agent pair proof reads the real OS listener
 * table; the unproven-pair case stubs that read unavailable. The
 * unrecorded-pair, foreign-port and equal-port cases point `--port` at a
 * separate listener. A `node --import`
 * preload records every fetch the child sends and can refuse a chosen Memory
 * PATCH, fail a readback GET or ops `search_by_id`, or answer a 2xx readback
 * with a malformed body, so each path can be run with a failing write or
 * readback: the run exits non-zero and its summary names the count and the
 * reason. A clean run exits 0.
 *
 * The all-agent run sends every re-embed PATCH with the administrator
 * credential it lists rows with, so it re-embeds rows whose owner has no local
 * key: a registered agent without a key file, the `skill:using-flair` row the
 * skill seed writes as the administrator, and rows of an owner with no Agent
 * row. The success case compares the full stored state of the initial Memory
 * rows read through the ops API before and after: the model stamp is new, while
 * agentId and every provenance/authority field are byte-identical.
 *
 * Without FLAIR_ADMIN_PASS, `reembed --agent <id>` lists rows with
 * POST /SemanticSearch, whose read scope includes other agents' non-private
 * rows: this file seeds such rows for other agents and asserts the run excludes
 * them from the candidate, up-to-date and updated counts and reports them in
 * `Skipped (other agents)`, and writes none.
 *
 * Throwaway HOMEs, ephemeral ports, the boot migration trigger omitted. The
 * Harper instance's base URLs are asserted to be 127.0.0.1 on ports other than
 * 9925 and 9926. Three cases point `--port` at a separate listener that
 * advertises the re-embed capability: an unrecorded pair refuses and the
 * listener sees no Authorization header or PATCH; a configured pair whose
 * HTTP port is that listener refuses for the ops port's proven HTTP port; and
 * an equal HTTP/ops port pair refuses before any request reaches it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { startHarper, stopHarper, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { componentWithoutMigrationBoot, type ComposedComponent } from "../helpers/component-without-migration-boot";
import { ensureCliBuild, spawnCli } from "../helpers/build-cli-once";
import { getModelId } from "../../resources/embeddings-provider.ts";
import { currentSeed, runSkillSeed, SEED_SKILL_ID, skillSeedRestIo } from "../../src/lib/skill-seed.js";

const AGENT_A = "r3o-agent-a";
const AGENT_B = "r3o-agent-b";
const AGENT_C = "r3o-agent-c";
const OWNER_NO_AGENT = "r3o-owner-no-agent";
const A_ROWS = ["r3o-a-1", "r3o-a-2"];
const B_ROW = "r3o-b-1";
const C_ROW = "r3o-c-1";
const D_ROWS = ["r3o-d-1", "r3o-d-2"];
const REFUSED_ROW = A_ROWS[0];
const NEWLINE_AGENT = "r3o-agent-newline\ncontinued";
const NEWLINE_ROW = "r3o-newline-1";

const rowPath = (id: string) => `/Memory/${encodeURIComponent(id)}`;

const agentA = { id: AGENT_A, ...nacl.sign.keyPair() };
const agentB = { id: AGENT_B, ...nacl.sign.keyPair() };
const agentC = { id: AGENT_C, ...nacl.sign.keyPair() };
const agentNewline = { id: NEWLINE_AGENT, ...nacl.sign.keyPair() };

let component: ComposedComponent;
let harper: HarperInstance;
let homeAllKeys: string;
let homeMissingC: string;
let homeOnlyA: string;
let homeForeign: string;
let homeUnpaired: string;
let homeNewline: string;
let foreignPort = 0;
let unpairedListenerPort = 0;
let equalPortListenerPort = 0;
let logDir = "";
let runSeq = 0;
let listenerAuthorizations: string[] = [];
let listenerRequests: string[] = [];
let listenerPatches: string[] = [];
const servers: Server[] = [];

const PRELOAD = join(import.meta.dirname, "..", "helpers", "reembed-fault-preload.ts");
const realHttpPort = () => Number(new URL(harper.httpURL).port);
const realOpsPort = () => Number(new URL(harper.opsURL).port);
const harperHttpHost = () => `${new URL(harper.httpURL).hostname}:${new URL(harper.httpURL).port}`;

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
    // Server-owned fields a re-embed must leave untouched.
    instanceToken: `token-${id}`,
    provenance: JSON.stringify({ v: 1, verified: { agentId, timestamp: "2021-03-01T00:00:00.000Z", receivedAt: "2021-03-01T00:00:00.000Z" } }),
    originatorInstanceId: "instance-r3o",
    promotionStatus: "approved",
    promotedAt: "2021-03-03T00:00:00.000Z",
    promotedBy: agentId,
    promotionContentHash: `hash-${id}`,
    writeBackWriteId: `write-back-${id}`,
  };
}

async function rowState(id: string): Promise<Record<string, unknown>> {
  const rows = await op({
    operation: "search_by_id",
    database: "flair",
    table: "Memory",
    ids: [id],
    get_attributes: ["*"],
  });
  expect(rows[0]?.id).toBe(id);
  return rows[0];
}

/** Fields a re-embed can change: vector, stamp, timestamps, text hash, legacy token. */
const REEMBED_MUTABLE = new Set(["embedding", "embeddingModel", "updatedAt", "embeddedContentHash", "instanceToken"]);

/** The stored row without the fields a re-embed is allowed to change. */
function identityState(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !REEMBED_MUTABLE.has(key)));
}

const FIELDS_THAT_MUST_NOT_MOVE = [
  "agentId",
  "provenance",
  "originatorInstanceId",
  "promotionStatus",
  "promotedAt",
  "promotedBy",
  "promotionContentHash",
  "writeBackWriteId",
] as const;

function makeHome(label: string, agents: Agent[]): string {
  const home = mkdtempSync(join(tmpdir(), `flair-${label}-home-`));
  const keysDir = join(home, ".flair", "keys");
  mkdirSync(keysDir, { recursive: true });
  for (const agent of agents) {
    writeFileSync(join(keysDir, `${agent.id}.key`), agent.secretKey.slice(0, 32), { mode: 0o600 });
  }
  return home;
}

/** Record the instance's port pair the way `flair init` does, so the all-agent run sees a configured pair. */
function writePairConfig(home: string, httpPort: number, opsPort: number): void {
  writeFileSync(join(home, ".flair", "config.yaml"), `port: ${httpPort}\nopsPort: ${opsPort}\n`);
}

/** A listener that advertises the re-embed capability and records any Authorization header and every PATCH, by port. */
async function startListener(instanceRows: unknown[]): Promise<number> {
  let port = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      listenerRequests.push(`${port} ${req.method} ${req.url}`);
      if (req.headers.authorization) listenerAuthorizations.push(`${port} ${req.method} ${req.url}`);
      if (req.method === "PATCH") listenerPatches.push(`${port} ${req.url ?? ""}`);
      res.setHeader("Content-Type", "application/json");
      if (req.method === "GET" && req.url === "/Health") {
        res.end(JSON.stringify({ version: "other-instance", capabilities: ["memory-reembed-patch"] }));
        return;
      }
      if (req.method === "GET" && req.url === "/Instance/") {
        res.end(JSON.stringify(instanceRows));
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ error: "not this test's instance" }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  return port;
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  ensureCliBuild();
  homeAllKeys = makeHome("3128-all", [agentA, agentB, agentC]);
  homeMissingC = makeHome("3128-missing-c", [agentA, agentB]);
  homeOnlyA = makeHome("3128-only-a", [agentA]);
  homeForeign = makeHome("3128-foreign", [agentA, agentB, agentC]);
  homeUnpaired = makeHome("3128-unpaired", [agentA, agentB, agentC]);
  homeNewline = makeHome("3128-newline", [agentNewline]);
  logDir = mkdtempSync(join(tmpdir(), "flair-3128-fetch-"));
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
      ...D_ROWS.map((id) => memoryRow(id, OWNER_NO_AGENT, "public")),
    ],
  });
  // The row `flair init` seeds, written by the same seed call the init path
  // uses, owned by the administrator that runs it.
  const seeded = await runSkillSeed(
    skillSeedRestIo({ baseUrl: harper.httpURL, user: harper.admin.username, pass: harper.admin.password }),
    currentSeed(),
  );
  if (seeded.kind !== "ok") throw new Error(`skill seed failed: ${JSON.stringify(seeded)}`);
  await op({
    operation: "upsert",
    database: "flair",
    table: "Instance",
    records: [{ id: "r3o-instance", role: "hub", publicKey: "cHVibGljLWtleQ", status: "active", createdAt: now }],
  });
  for (const home of [homeAllKeys, homeMissingC]) writePairConfig(home, realHttpPort(), realOpsPort());
  listenerAuthorizations = [];
  listenerRequests = [];
  listenerPatches = [];
  foreignPort = await startListener([{ id: "r3o-other-instance" }]);
  unpairedListenerPort = await startListener([{ id: "r3o-instance" }]);
  equalPortListenerPort = await startListener([{ id: "r3o-instance" }]);
  writePairConfig(homeForeign, foreignPort, realOpsPort());
}, 300_000);

afterAll(async () => {
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (harper) await stopHarper(harper);
  component?.cleanup();
  for (const home of [homeAllKeys, homeMissingC, homeOnlyA, homeForeign, homeUnpaired, homeNewline]) {
    if (home) rmSync(home, { recursive: true, force: true });
  }
  if (logDir) rmSync(logDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

type FetchEntry = { method: string; host: string; path: string };
type Run = { code: number | null; stdout: string; stderr: string; fetches: FetchEntry[] };

async function runReembed(
  args: string[],
  home: string,
  admin: boolean | string,
  opts: { ports?: { http: number; ops: number }; env?: Record<string, string> } = {},
): Promise<Run> {
  const ports = opts.ports ?? { http: realHttpPort(), ops: realOpsPort() };
  const logPath = join(logDir, `fetch-${runSeq++}.log`);
  writeFileSync(logPath, "");
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(FLAIR_|HARPER_|HDB_|FABRIC_)/.test(key)));
  const env: Record<string, string | undefined> = {
    ...base,
    HOME: home,
    FLAIR_OPS_PORT: String(ports.ops),
    NO_COLOR: "1",
    FLAIR_TEST_FETCH_LOG: logPath,
    ...opts.env,
  };
  if (admin) {
    env.FLAIR_ADMIN_USER = harper.admin.username;
    env.FLAIR_ADMIN_PASS = typeof admin === "string" ? admin : harper.admin.password;
  }
  const child = spawnCli([...args, "--port", String(ports.http), "--batch-size", "1", "--delay-ms", "0"], {
    env,
    timeout: 180_000,
    preload: PRELOAD,
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (exitCode) => resolve(exitCode));
  });
  const fetches = readFileSync(logPath, "utf-8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as FetchEntry);
  return { code, stdout, stderr, fetches };
}

const patchPaths = (fetches: FetchEntry[]): string[] => fetches.filter((entry) => entry.method === "PATCH").map((entry) => entry.path);

test("a pair bound by the instance's configuration proceeds and the all-agent run exits 0", async () => {
  const { code, stdout, stderr } = await runReembed(["reembed"], homeAllKeys, true);
  expect(code, stderr.slice(0, 800)).toBe(0);
  expect(stdout).toContain("✅ Re-embedding complete: 7 updated, 0 errors");
  expect(stdout).not.toContain("❌");
  expect(stdout).not.toContain("row(s) not updated");
}, 240_000);

test("a named pair that configuration does not bind refuses with no Authorization header sent to that HTTP port", async () => {
  const before = new Map<string, Record<string, unknown>>();
  for (const id of [...A_ROWS, B_ROW, C_ROW, ...D_ROWS]) before.set(id, await rowState(id));
  const listenerBefore = listenerAuthorizations.filter((entry) => entry.startsWith(`${unpairedListenerPort} `)).length;
  const { code, stdout, stderr } = await runReembed(["reembed"], homeUnpaired, true, {
    ports: { http: unpairedListenerPort, ops: realOpsPort() },
  });
  expect(code, stderr.slice(0, 800)).toBe(1);
  expect(listenerAuthorizations.filter((entry) => entry.startsWith(`${unpairedListenerPort} `))).toHaveLength(listenerBefore);
  expect(listenerPatches.filter((entry) => entry.startsWith(`${unpairedListenerPort} `))).toEqual([]);
  expect(stderr).toContain("ambiguous_instance_target");
  expect(stderr).toContain("--port or FLAIR_URL");
  expect(stdout).not.toContain("Re-embedding complete");
  for (const id of before.keys()) expect(await rowState(id), id).toEqual(before.get(id)!);
}, 240_000);

test("a configured pair whose HTTP port is a foreign listener refuses and sends it no Authorization header or PATCH", async () => {
  const before = new Map<string, Record<string, unknown>>();
  for (const id of [...A_ROWS, B_ROW, C_ROW, ...D_ROWS]) before.set(id, await rowState(id));
  const listenerBefore = listenerAuthorizations.filter((entry) => entry.startsWith(`${foreignPort} `)).length;
  const { code, stdout, stderr } = await runReembed(["reembed"], homeForeign, true, {
    ports: { http: foreignPort, ops: realOpsPort() },
  });
  expect(code, stderr.slice(0, 800)).toBe(1);
  expect(stderr).toContain("ambiguous_instance_target");
  expect(stderr).toContain("configured pair does not match the running instance");
  expect(listenerAuthorizations.filter((entry) => entry.startsWith(`${foreignPort} `))).toHaveLength(listenerBefore);
  expect(listenerPatches.filter((entry) => entry.startsWith(`${foreignPort} `))).toEqual([]);
  expect(stdout).not.toContain("Re-embedding complete");
  for (const id of before.keys()) expect(await rowState(id), id).toEqual(before.get(id)!);
}, 240_000);

test("an all-agent run whose HTTP port reports a different instance id refuses with the instance-id remedy and no PATCH", async () => {
  const { code, stdout, stderr, fetches } = await runReembed(["reembed"], homeAllKeys, true, {
    env: { FLAIR_TEST_REWRITE_HTTP_INSTANCE_JSON: JSON.stringify([{ id: "r3o-different-instance" }]) },
  });
  expect(code, stderr.slice(0, 800)).toBe(1);
  expect(stderr).toContain("The two ports report different instance ids; point both at one instance.");
  expect(patchPaths(fetches)).toEqual([]);
  expect(stdout).not.toContain("Re-embedding complete");
}, 240_000);

test("an unproven pair refuses with nothing sent to the HTTP port", async () => {
  const before = new Map<string, Record<string, unknown>>();
  for (const id of [...A_ROWS, B_ROW, C_ROW, ...D_ROWS]) before.set(id, await rowState(id));
  const { code, stdout, stderr, fetches } = await runReembed(["reembed"], homeAllKeys, true, {
    env: { FLAIR_TEST_PAIR_OS_READS_UNAVAILABLE: "1" },
  });
  expect(fetches.filter((entry) => entry.host === harperHttpHost())).toEqual([]);
  expect(code, stderr.slice(0, 800)).toBe(1);
  expect(stderr).toContain("ambiguous_instance_target");
  expect(stderr).toContain("not proven to pair");
  expect(stdout).not.toContain("Re-embedding complete");
  for (const id of before.keys()) expect(await rowState(id), id).toEqual(before.get(id)!);
}, 240_000);

test("a target whose HTTP and ops ports are the same port refuses before any request", async () => {
  expect(listenerRequests.filter((entry) => entry.startsWith(`${equalPortListenerPort} `))).toEqual([]);
  const { code, stdout, stderr } = await runReembed(["reembed"], homeUnpaired, true, {
    ports: { http: equalPortListenerPort, ops: equalPortListenerPort },
  });
  expect(code, stderr.slice(0, 800)).toBe(1);
  expect(stderr).toContain(`the target names HTTP port ${equalPortListenerPort} and ops port ${equalPortListenerPort}, which are the same port`);
  expect(stderr).toContain("The HTTP and ops ports must differ");
  expect(listenerRequests.filter((entry) => entry.startsWith(`${equalPortListenerPort} `))).toEqual([]);
  expect(listenerAuthorizations.filter((entry) => entry.startsWith(`${equalPortListenerPort} `))).toEqual([]);
  expect(stdout).not.toContain("Re-embedding complete");
}, 240_000);

test("a clean single-agent run exits 0 with the unchanged summary", async () => {
  const { code, stdout, stderr } = await runReembed(["reembed", "--agent", AGENT_A], homeAllKeys, true);
  expect(code, stderr.slice(0, 800)).toBe(0);
  expect(stdout).toContain("Candidates for re-embedding: 2");
  expect(stdout).toContain("✅ Re-embedding complete: 2 updated, 0 errors");
  expect(stdout).not.toContain("❌");
}, 240_000);

test("a refused write in the all-agent path exits 1 and names the count and reason", async () => {
  const { code, stdout, stderr } = await runReembed(["reembed"], homeAllKeys, true, {
    env: { FLAIR_TEST_REFUSE_PATCH_JSON: JSON.stringify({ [rowPath(REFUSED_ROW)]: 500 }) },
  });
  expect(code, stderr.slice(0, 800)).toBe(1);
  expect(stdout).toContain("❌ Re-embedding complete: 6 updated, 1 errors");
  expect(stdout).toContain("1 row(s) not updated: HTTP 500");
  expect(stdout).not.toContain("✅ Re-embedding complete");
}, 240_000);

test("a refused write in the single-agent path exits 1 and names the count and reason", async () => {
  const { code, stdout, stderr } = await runReembed(["reembed", "--agent", AGENT_A], homeAllKeys, true, {
    env: { FLAIR_TEST_REFUSE_PATCH_JSON: JSON.stringify({ [rowPath(REFUSED_ROW)]: 500 }) },
  });
  expect(code, stderr.slice(0, 800)).toBe(1);
  expect(stdout).toContain("❌ Re-embedding complete: 1 updated, 1 errors");
  expect(stdout).toContain("1 row(s) not updated: HTTP 500");
  expect(stdout).not.toContain("✅ Re-embedding complete");
}, 240_000);

test("the summary reports each distinct failure reason once with its row count", async () => {
  const { code, stdout, stderr } = await runReembed(["reembed"], homeAllKeys, true, {
    env: {
      FLAIR_TEST_REFUSE_PATCH_JSON: JSON.stringify({
        [rowPath(A_ROWS[0])]: 500,
        [rowPath(A_ROWS[1])]: 500,
        [rowPath(B_ROW)]: 503,
      }),
    },
  });
  expect(code, stderr.slice(0, 800)).toBe(1);
  expect(stdout).toContain("❌ Re-embedding complete: 4 updated, 3 errors");
  const reasonLines = stdout.split("\n").map((line) => line.trim()).filter((line) => line.includes("row(s) not updated:"));
  expect(reasonLines).toHaveLength(2);
  expect(reasonLines.filter((line) => line.startsWith("❌ 2 row(s) not updated: HTTP 500"))).toHaveLength(1);
  expect(reasonLines.filter((line) => line.startsWith("❌ 1 row(s) not updated: HTTP 503"))).toHaveLength(1);
  expect(stdout).not.toContain("✅ Re-embedding complete");
}, 240_000);

test("a stored model string with a newline renders as one failure reason line", async () => {
  const { code, stdout, stderr } = await runReembed(["reembed", "--agent", AGENT_A], homeAllKeys, true, {
    env: {
      FLAIR_TEST_REWRITE_OPS_READBACK_JSON: JSON.stringify({
        [REFUSED_ROW]: JSON.stringify([{ id: REFUSED_ROW, embeddingModel: "wrong\nmodel" }]),
      }),
    },
  });
  expect(code, stderr.slice(0, 800)).toBe(1);
  const reasonLines = stdout.split("\n").filter((line) => line.includes("row(s) not updated:"));
  expect(reasonLines).toHaveLength(1);
  expect(reasonLines[0]).toContain("stored embeddingModel is wrong\\nmodel");
}, 240_000);

test("a stored model string with a carriage return renders as one escaped failure entry", async () => {
  const { code, stdout, stderr } = await runReembed(["reembed", "--agent", AGENT_A], homeAllKeys, true, {
    env: {
      FLAIR_TEST_REWRITE_OPS_READBACK_JSON: JSON.stringify({
        [A_ROWS[0]]: JSON.stringify([{ id: A_ROWS[0], embeddingModel: "wrong\rmodel" }]),
      }),
    },
  });
  expect(code, stderr.slice(0, 800)).toBe(1);
  const reasonLines = stdout.split("\n").filter((line) => line.includes("row(s) not updated:"));
  expect(reasonLines).toHaveLength(1);
  expect(reasonLines[0]).toContain("stored embeddingModel is wrong\\rmodel");
}, 240_000);

test("a stored model string with another C0 control character renders as one escaped failure entry", async () => {
  const { code, stdout, stderr } = await runReembed(["reembed", "--agent", AGENT_A], homeAllKeys, true, {
    env: {
      FLAIR_TEST_REWRITE_OPS_READBACK_JSON: JSON.stringify({
        [A_ROWS[0]]: JSON.stringify([{ id: A_ROWS[0], embeddingModel: "wrong\u0007model" }]),
      }),
    },
  });
  expect(code, stderr.slice(0, 800)).toBe(1);
  const reasonLines = stdout.split("\n").filter((line) => line.includes("row(s) not updated:"));
  expect(reasonLines).toHaveLength(1);
  expect(reasonLines[0]).toContain("stored embeddingModel is wrong\\x07model");
}, 240_000);

test("a thrown error message with a newline renders as one escaped failure entry", async () => {
  const { code, stdout, stderr } = await runReembed(["reembed", "--agent", AGENT_A], homeAllKeys, true, {
    env: { FLAIR_TEST_THROW_PATCH_JSON: JSON.stringify({ [rowPath(A_ROWS[0])]: "boom\nline two" }) },
  });
  expect(code, stderr.slice(0, 800)).toBe(1);
  const reasonLines = stdout.split("\n").filter((line) => line.includes("row(s) not updated:"));
  expect(reasonLines).toHaveLength(1);
  expect(reasonLines[0]).toContain("PATCH failed: boom\\nline two");
}, 240_000);

test("a successful PATCH whose readback fails exits non-zero and does not count the row", async () => {
  const { code, stdout, stderr } = await runReembed(["reembed", "--agent", AGENT_A], homeOnlyA, false, {
    env: { FLAIR_TEST_REFUSE_GET_JSON: JSON.stringify({ [rowPath(A_ROWS[0])]: 500 }) },
  });
  expect(code, stderr.slice(0, 800)).toBe(1);
  expect(stdout).toContain("❌ Re-embedding complete: 1 updated, 1 errors");
  expect(stdout).toContain("1 row(s) not updated: stored model read failed: HTTP 500");
  expect(stdout).not.toContain("✅ Re-embedding complete");
  expect((await rowState(A_ROWS[0])).embeddingModel).toBe(getModelId());
}, 240_000);

test("a successful all-agent PATCH whose ops readback fails exits non-zero and does not count the row", async () => {
  const { code, stdout, stderr, fetches } = await runReembed(["reembed"], homeAllKeys, true, {
    env: { FLAIR_TEST_REFUSE_OPS_READBACK_JSON: JSON.stringify({ [REFUSED_ROW]: 500 }) },
  });
  expect(code, stderr.slice(0, 800)).toBe(1);
  expect(stdout).toContain("❌ Re-embedding complete: 6 updated, 1 errors");
  expect(stdout).toContain("1 row(s) not updated: stored model read failed: HTTP 500");
  expect(stdout).not.toContain("✅ Re-embedding complete");
  expect(fetches.filter((entry) => entry.method === "PATCH").map((entry) => entry.path)).toContain(rowPath(REFUSED_ROW));
}, 240_000);

test("a malformed 2xx readback is a failed read with its reason, not a missing stamp", async () => {
  const allAgent = await runReembed(["reembed"], homeAllKeys, true, {
    env: {
      FLAIR_TEST_REWRITE_OPS_READBACK_JSON: JSON.stringify({ [REFUSED_ROW]: JSON.stringify({ not: "rows" }) }),
    },
  });
  expect(allAgent.code, allAgent.stderr.slice(0, 800)).toBe(1);
  expect(allAgent.stdout).toContain("row(s) not updated: stored model read failed: search_by_id answered an object, not a row array");
  expect(allAgent.stdout).not.toContain("stored embeddingModel is missing");

  const signed = await runReembed(["reembed", "--agent", AGENT_A], homeOnlyA, false, {
    env: {
      FLAIR_TEST_REWRITE_GET_READBACK_JSON: JSON.stringify({ [A_ROWS[0]]: JSON.stringify([]) }),
    },
  });
  expect(signed.code, signed.stderr.slice(0, 800)).toBe(1);
  expect(signed.stdout).toContain(`row(s) not updated: stored model read failed: GET /Memory/${A_ROWS[0]} answered an array, not a record`);
  expect(signed.stdout).not.toContain("stored embeddingModel is missing");
}, 300_000);

test("the admin all-agent run re-embeds rows whose owners have no key and leaves their identity fields byte-identical", async () => {
  const ids = [...A_ROWS, B_ROW, C_ROW, ...D_ROWS, SEED_SKILL_ID];
  const before = new Map<string, Record<string, unknown>>();
  for (const id of ids) before.set(id, await rowState(id));

  const { code, stdout, stderr, fetches } = await runReembed(["reembed"], homeMissingC, true);
  expect(code, stderr.slice(0, 800)).toBe(0);
  expect(stdout).toContain("✅ Re-embedding complete: 7 updated, 0 errors");
  expect(stdout).not.toContain("skipped");

  for (const id of ids) {
    const prior = before.get(id)!;
    const after = await rowState(id);
    expect(after.embeddingModel, `${id}: new model stamp`).toBe(getModelId());
    for (const field of FIELDS_THAT_MUST_NOT_MOVE) {
      expect(after[field], `${id}: ${field} unchanged`).toBe(prior[field]);
    }
    expect(identityState(after), `${id}: every other stored field unchanged`).toEqual(identityState(prior));
    expect(fetches.filter((entry) => entry.method === "PATCH").map((entry) => entry.path)).toContain(rowPath(id));
  }
}, 240_000);

test("a wrong administrator password exits non-zero before any row changes", async () => {
  const ids = [...A_ROWS, B_ROW, C_ROW, ...D_ROWS, SEED_SKILL_ID];
  const before = new Map<string, Record<string, unknown>>();
  for (const id of ids) before.set(id, await rowState(id));

  const { code } = await runReembed(["reembed"], homeMissingC, "definitely-not-the-admin-password");
  expect(code).toBe(1);
  for (const id of ids) {
    expect(await rowState(id), id).toEqual(before.get(id)!);
  }
}, 240_000);

test("a --dry-run all-agent run counts rows without needing any owner's key", async () => {
  const { code, stdout, stderr, fetches } = await runReembed(["reembed", "--dry-run"], homeMissingC, true);
  expect(code, stderr.slice(0, 800)).toBe(0);
  expect(stdout).toContain("✅ Re-embedding complete: 0 updated, 0 errors");
  expect(stdout).not.toContain("Key not found");
  expect(patchPaths(fetches)).toEqual([]);
}, 240_000);

test("keyless single-agent excludes other agents' listed rows from the candidate and counts and reports them in Skipped (other agents)", async () => {
  const otherIds = [B_ROW, C_ROW, ...D_ROWS, SEED_SKILL_ID];
  const before = new Map<string, Record<string, unknown>>();
  for (const id of otherIds) before.set(id, await rowState(id));
  const { code, stdout, stderr, fetches } = await runReembed(["reembed", "--agent", AGENT_A], homeOnlyA, false);
  expect(code, stderr.slice(0, 800)).toBe(0);
  expect(stdout).toContain("Candidates for re-embedding: 2");
  expect(stdout).toContain(`Skipped (other agents): ${otherIds.length}`);
  expect(stdout).toContain(`✅ Re-embedding complete: 2 updated, 0 errors`);
  for (const id of otherIds) {
    expect(await rowState(id), id).toEqual(before.get(id)!);
    expect(patchPaths(fetches)).not.toContain(rowPath(id));
  }
}, 240_000);

test("an agent id with a newline renders as one failure entry line", async () => {
  await op({
    operation: "insert",
    database: "flair",
    table: "Memory",
    records: [memoryRow(NEWLINE_ROW, NEWLINE_AGENT, "public")],
  });
  const { code, stdout, stderr } = await runReembed(["reembed", "--agent", NEWLINE_AGENT], homeNewline, true);
  expect(code, stderr.slice(0, 800)).toBe(1);
  const entry = stdout.split("\n").find((line) => line.includes("row(s) not updated:"));
  expect(entry).toBeDefined();
  expect(entry).toContain(`--agent ${NEWLINE_AGENT.replace(/\n/g, "\\n")}`);
  expect(entry).toContain("after fixing the cause");
}, 240_000);

test("the seeded rows are current after the runs (the re-embeds the assertions relied on)", async () => {
  for (const id of [...A_ROWS, B_ROW, C_ROW, ...D_ROWS, SEED_SKILL_ID]) {
    expect((await rowState(id)).embeddingModel, id).toBe(getModelId());
  }
}, 60_000);
