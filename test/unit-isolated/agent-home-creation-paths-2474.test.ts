/**
 * agent-home-creation-paths-2474.test.ts — flair#2474.
 *
 * Every CLI Agent creation path must stamp the local instance's home, and the
 * suite must fail if any path stops doing so. This file drives the paths that
 * create the Agent row through the shared seed (`flair agent add`, `flair
 * import`) — the ones the writer-coverage test could not see, because they call
 * the seed rather than carrying the ops-API create literal themselves — against
 * an in-memory operations API and asserts the row they create carries the local
 * home. `flair init`'s two paths and the ops-literal creators
 * (principal/mcp/mcp-enable) are covered by their own tests.
 *
 * Isolated because it drives the process-global commander `program` and stands
 * up an HTTP server in place of the operations API.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { program } from "../../src/cli.js";

const LOCAL_ID = "inst-local-2474";

let tmpHome: string;
let keysDir: string;
let server: Server;
let agentInserts: any[];
let agents: Array<Record<string, unknown>>;

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), "flair-2474-paths-"));
  keysDir = join(tmpHome, "keys");
  agentInserts = [];
  agents = [];
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8") || "{}";
      let answer: unknown = {};
      try {
        const body = JSON.parse(raw);
        if (body.operation === "sql") answer = [{ id: LOCAL_ID }];
        else if (body.operation === "search_by_value") answer = agents;
        else if (body.operation === "insert" && body.table === "Agent") {
          agentInserts.push(body);
          agents = [...agents, ...body.records];
          answer = { inserted_hashes: body.records.map((r: any) => r.id), skipped_hashes: [] };
        }
      } catch {
        /* a non-ops body (a Soul/Memory PUT) — answer {} below */
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  rmSync(tmpHome, { recursive: true, force: true });
});

function opsUrl(): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock ops server has no port");
  return `http://127.0.0.1:${address.port}`;
}

async function run(args: string[]): Promise<number> {
  const logSpy = spyOn(console, "log").mockImplementation(() => {});
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  const origExit = process.exit;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as typeof process.exit;
  let code = 0;
  try {
    await program.parseAsync([...args], { from: "user" });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const match = message.match(/^process\.exit\((\d+)\)$/);
    if (!match) throw err;
    code = Number(match[1]);
  } finally {
    process.exit = origExit;
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
  return code;
}

describe("flair#2474 — each seed-based creation path stamps the local home", () => {
  test("flair agent add creates a row whose home is the local instance", async () => {
    const code = await run([
      "agent", "add", "path-agent",
      "--port", "1",
      "--ops-target", opsUrl(),
      "--admin-pass", "throwaway-admin-pass-not-a-secret",
      "--keys-dir", keysDir,
    ]);
    expect(code).toBe(0);
    expect(agentInserts).toHaveLength(1);
    expect(agentInserts[0].records[0].id).toBe("path-agent");
    expect(agentInserts[0].records[0].originatorInstanceId).toBe(LOCAL_ID);
  });

  test("flair import creates a row whose home is the local instance", async () => {
    const exportPath = join(tmpHome, "agent-export.json");
    writeFileSync(exportPath, JSON.stringify({ type: "agent-export", agent: { id: "imported-agent" }, souls: [], memories: [] }));
    const code = await run([
      "import", exportPath,
      "--port", "1",
      "--ops-target", opsUrl(),
      "--admin-pass", "throwaway-admin-pass-not-a-secret",
      "--keys-dir", keysDir,
    ]);
    expect(code).toBe(0);
    expect(agentInserts).toHaveLength(1);
    expect(agentInserts[0].records[0].id).toBe("imported-agent");
    expect(agentInserts[0].records[0].originatorInstanceId).toBe(LOCAL_ID);
  });
});
