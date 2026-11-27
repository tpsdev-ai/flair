/**
 * agent-home-creation-paths-2474.test.ts — flair#2474.
 *
 * Every CLI Agent creation path must stamp the local instance's home. This file
 * drives the paths that create the Agent row through the shared seed (`flair
 * agent add`, `flair import`) — the ones the writer-coverage test could not see,
 * because they call the seed rather than carrying the ops-API create literal
 * themselves — against an in-memory operations API and asserts the row they
 * create carries the local home.
 *
 * NAMED GAP: `flair init`'s LOCAL path also reaches the seed (src/commands/init.ts,
 * seedAgentWithLocalHome), but is asserted at row level only for `--remote`
 * (init-remote-agent-home-2433.test.ts) — a row-level case for the local init
 * path needs a real Harper boot and is not in this file. The ops-literal creators
 * (principal/mcp/mcp-enable) are covered by their own tests.
 *
 * Isolated because it drives the process-global commander `program` and stands
 * up an HTTP server in place of the operations API.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { chmodSync, fstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { program } from "../../src/cli.js";
import { setAgentKeyFileTestHooks } from "../../src/lib/agent-key-file.js";

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

let lastErrors: string[] = [];

async function run(args: string[]): Promise<number> {
  const logSpy = spyOn(console, "log").mockImplementation(() => {});
  lastErrors = [];
  const errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lastErrors.push(args.map(String).join(" "));
  });
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

describe("flair#3077 — import checks the existing key file before reuse", () => {
  function exportPath(id: string, privateKey?: boolean): string {
    const path = join(tmpHome, `${id}.json`);
    writeFileSync(path, JSON.stringify({
      type: "agent-export",
      agent: { id },
      ...(privateKey ? { privateKey: Buffer.alloc(32, 6).toString("base64") } : {}),
      souls: [],
      memories: [],
    }));
    return path;
  }

  for (const withPrivateKey of [true, false]) {
    test(`a 0644 key is refused and unchanged (export ${withPrivateKey ? "with" : "without"} a private key)`, async () => {
      const id = withPrivateKey ? "import-wide-export-3077" : "import-wide-generate-3077";
      mkdirSync(keysDir, { recursive: true });
      const keyPath = join(keysDir, `${id}.key`);
      const prior = Buffer.alloc(32, 5);
      writeFileSync(keyPath, prior);
      chmodSync(keyPath, 0o644);
      const path = exportPath(id, withPrivateKey);

      const code = await run([
        "import", path,
        "--port", "1",
        "--ops-target", opsUrl(),
        "--admin-pass", "throwaway-admin-pass-not-a-secret",
        "--keys-dir", keysDir,
      ]);

      expect(code).toBe(1);
      expect(lastErrors.join("\n")).toContain(`chmod 600 ${keyPath}`);
      expect(readFileSync(keyPath).equals(prior)).toBe(true);
      expect(agentInserts).toHaveLength(0);
      expect(statSync(keyPath).mode & 0o777).toBe(0o644);
    });

    test(`a fresh ${withPrivateKey ? "restored" : "generated"} key is 0600 at its first write under a zero umask`, async () => {
      const id = withPrivateKey ? "import-restore-first-3077" : "import-generate-first-3077";
      const keyPath = join(keysDir, `${id}.key`);
      const path = exportPath(id, withPrivateKey);
      const observed: number[] = [];
      setAgentKeyFileTestHooks({
        beforeFirstWrite: (fd) => {
          observed.push(fstatSync(fd).mode & 0o777);
        },
      });
      const previous = process.umask(0);
      let code: number;
      try {
        code = await run([
          "import", path,
          "--port", "1",
          "--ops-target", opsUrl(),
          "--admin-pass", "throwaway-admin-pass-not-a-secret",
          "--keys-dir", keysDir,
        ]);
      } finally {
        process.umask(previous);
        setAgentKeyFileTestHooks(undefined);
      }
      expect(code).toBe(0);
      expect(observed).toEqual([0o600]);
      expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    });
  }
});
