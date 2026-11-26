/**
 * reembed-read-validation-3086.test.ts — `flair reembed`'s page validation
 * (flair#3086).
 *
 * A 200 response is only used when it is an array of rows, or an object whose
 * `results` is an array of rows; every row must carry a non-empty string `id`
 * and `agentId` and a string `content`, and ids must strictly increase across
 * the read. Anything else — an error object, a row missing one of those fields,
 * ids that go backwards — throws before the first write, on both administrator
 * branches. A page cap passed to the reader that is not a whole number from 1
 * to the hard bound throws before any request. A local stub operations server
 * answers the CLI; no Harper is involved.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Command } from "commander";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import nacl from "tweetnacl";
import { tempDir } from "../helpers/temp-dir";
import { bindCli, readAllMemoryRows, register } from "../../src/commands/reembed.ts";
import { getModelId } from "../../resources/embeddings-provider.ts";

const realExit = process.exit;
const realLog = console.log;
const realError = console.error;

type Scenario = { name: string; body: unknown };

const ROWS: Scenario[] = [
  { name: "a 200 error object", body: { error: "partial read" } },
  { name: "a row without an id", body: [{ agentId: "agent-a", content: "a memory", embeddingModel: "old" }] },
  { name: "a row without a content", body: [{ id: "m-1", agentId: "agent-a", embeddingModel: "old" }] },
  { name: "a row without an agentId", body: [{ id: "m-1", content: "a memory", embeddingModel: "old" }] },
  {
    name: "ids that go backwards",
    body: [
      { id: "m-2", agentId: "agent-a", content: "a memory", embeddingModel: "old" },
      { id: "m-1", agentId: "agent-a", content: "a memory", embeddingModel: "old" },
    ],
  },
];

let server: Server;
let port: number;
let body: unknown;
const patched: string[] = [];
let opsRequests = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    let requestBody = "";
    req.on("data", (chunk) => { requestBody += chunk; });
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.method === "GET" && req.url === "/Health") {
        res.end(JSON.stringify({ version: "test", capabilities: ["memory-reembed-patch"] }));
        return;
      }
      if (req.method === "PATCH") {
        patched.push(req.url ?? "");
        res.end(JSON.stringify({ id: decodeURIComponent((req.url ?? "").split("/").pop() ?? "") }));
        return;
      }
      opsRequests += 1;
      let operation: unknown;
      try {
        operation = (JSON.parse(requestBody) as { operation?: unknown }).operation;
      } catch {
        operation = undefined;
      }
      if (operation === "search_by_id") {
        const ids = (JSON.parse(requestBody) as { ids?: string[] }).ids ?? [];
        res.end(JSON.stringify(ids.map((id) => ({ id, embeddingModel: getModelId() }))));
        return;
      }
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  process.exit = realExit;
  console.log = realLog;
  console.error = realError;
});

async function run(agent: string | undefined): Promise<{ exitCode: number | null; logs: string[] }> {
  patched.length = 0;
  const key = join(tempDir("reembed-validate-3086-"), "agent-a.key");
  writeFileSync(key, nacl.sign.keyPair().secretKey.slice(0, 32), { mode: 0o600 });
  bindCli({
    privKeyPath: () => key,
    resolveHttpPort: () => port,
    resolveOpsPort: () => port,
    resolveAgentHomeTarget: () => ({ httpPort: port, opsPort: port, pairBound: true }),
    ambiguousInstanceTargetError: "ambiguous_instance_target",
  });

  const logs: string[] = [];
  let exitCode: number | null = null;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`EXIT:${exitCode}`);
  }) as typeof process.exit;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

  const saved = { pass: process.env.FLAIR_ADMIN_PASS, hdb: process.env.HDB_ADMIN_PASSWORD };
  process.env.FLAIR_ADMIN_PASS = "stub-admin-pass";
  delete process.env.HDB_ADMIN_PASSWORD;
  try {
    const program = new Command().exitOverride();
    register(program);
    const args = agent ? ["reembed", "--agent", agent, "--stale-only"] : ["reembed", "--stale-only"];
    await program.parseAsync(args, { from: "user" });
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith("EXIT:")) throw err;
  } finally {
    if (saved.pass === undefined) delete process.env.FLAIR_ADMIN_PASS; else process.env.FLAIR_ADMIN_PASS = saved.pass;
    if (saved.hdb === undefined) delete process.env.HDB_ADMIN_PASSWORD; else process.env.HDB_ADMIN_PASSWORD = saved.hdb;
  }
  return { exitCode, logs };
}

for (const scenario of ROWS) {
  for (const agent of [undefined, "agent-a"]) {
    const branch = agent ? "single-agent with an admin password" : "all-agent";
    test(`${scenario.name} exits non-zero on the ${branch} path and writes nothing`, async () => {
      body = scenario.body;
      const { exitCode, logs } = await run(agent);
      expect(exitCode).toBe(1);
      expect(patched).toEqual([]);
      expect(logs.some((line) => line.includes("Re-embedding complete"))).toBe(false);
    }, 10_000);
  }
}

const ENVELOPE_ROW = { id: "m-1", agentId: "agent-a", content: "a memory", embeddingModel: "old" };

for (const agent of [undefined, "agent-a"]) {
  const branch = agent ? "single-agent with an admin password" : "all-agent";
  test(`a results envelope re-embeds its stale row on the ${branch} path`, async () => {
    body = { results: [ENVELOPE_ROW] };
    const { exitCode, logs } = await run(agent);
    expect(exitCode).toBeNull();
    expect(patched).toEqual(["/Memory/m-1"]);
    expect(logs.some((line) => line.includes("Re-embedding complete: 1 updated, 0 errors"))).toBe(true);
  }, 10_000);
}

const CAP_CONDITION = [{ search_attribute: "agentId", search_type: "equals", search_value: "agent-a" }];

test("a page cap above the hard bound is refused before any read", async () => {
  body = [];
  opsRequests = 0;
  await expect(readAllMemoryRows({ opsPort: port, opsAuth: "Basic stub", conditions: CAP_CONDITION, maxPages: 10_001 }))
    .rejects.toThrow("invalid page cap 10001");
  expect(opsRequests).toBe(0);
}, 10_000);

test("a page cap that is not a whole number from 1 up is refused before any read", async () => {
  body = [];
  opsRequests = 0;
  for (const maxPages of [0, -1, 1.5]) {
    await expect(readAllMemoryRows({ opsPort: port, opsAuth: "Basic stub", conditions: CAP_CONDITION, maxPages }))
      .rejects.toThrow("invalid page cap");
  }
  expect(opsRequests).toBe(0);
}, 10_000);
