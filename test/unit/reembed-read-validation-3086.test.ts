/**
 * reembed-read-validation-3086.test.ts — `flair reembed`'s page validation
 * (flair#3086).
 *
 * A 200 response is only used when it is an array of rows with non-empty
 * string ids that strictly increase across the read. Anything else — an error
 * object, a row without an id, ids that go backwards — throws before the first
 * write, on both administrator branches. A local stub operations server answers
 * the CLI; no Harper is involved.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Command } from "commander";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import nacl from "tweetnacl";
import { tempDir } from "../helpers/temp-dir";
import { bindCli, register } from "../../src/commands/reembed.ts";

const realExit = process.exit;
const realLog = console.log;
const realError = console.error;

type Scenario = { name: string; body: unknown };

const ROWS: Scenario[] = [
  { name: "a 200 error object", body: { error: "partial read" } },
  { name: "a row without an id", body: [{ agentId: "agent-a", content: "a memory", embeddingModel: "old" }] },
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
  bindCli({ privKeyPath: () => key, resolveHttpPort: () => port, resolveOpsPort: () => port });

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
