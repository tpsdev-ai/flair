/**
 * agent-add-invalid-id-2359.test.ts — flair#2359.
 *
 * `flair agent add <id>` must refuse an id outside the ONE shared agent-ID rule
 * BEFORE writing any key file or touching the operations API. Before the fix the
 * command validated nothing: it generated a keypair (writing <id>.key and
 * <id>.pub into the keys dir) and then attempted an insert with whatever id the
 * caller passed.
 *
 * Isolated because it drives the process-global commander `program` and stands
 * up an HTTP server in place of the operations API.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { program } from "../../src/cli.js";

let tmpHome: string;
let keysDir: string;
let server: Server;
let baseUrl: string;
let ops: string[];
let table: Map<string, { id: string; name: string; publicKey: string }>;

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), "flair-2359-add-"));
  keysDir = join(tmpHome, "keys");
  ops = [];
  table = new Map();
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: { operation?: string; table?: string; search_value?: string; records?: Array<{ id?: string; name?: string; publicKey?: string }> } = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        return json(res, 400, { error: "bad json" });
      }
      ops.push(body.operation ?? "unknown");
      if (body.operation === "search_by_value" && body.table === "Agent") {
        const row = table.get(String(body.search_value ?? ""));
        return json(res, 200, row ? [row] : []);
      }
      if (body.operation === "insert" && body.table === "Agent") {
        const rec = body.records?.[0];
        if (rec && typeof rec.id === "string" && typeof rec.publicKey === "string") {
          table.set(rec.id, { id: rec.id, name: rec.name ?? rec.id, publicKey: rec.publicKey });
        }
        return json(res, 200, { ok: true });
      }
      return json(res, 200, { ok: true });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock ops server has no port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  rmSync(tmpHome, { recursive: true, force: true });
});

async function agentAdd(id: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    stdout.push(args.map((a) => String(a)).join(" "));
  });
  const errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderr.push(args.map((a) => String(a)).join(" "));
  });
  const origExit = process.exit;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as typeof process.exit;
  let code = 0;
  try {
    await program.parseAsync([
      "node",
      "flair",
      "agent",
      "add",
      id,
      "--ops-target",
      baseUrl,
      "--admin-pass",
      "throwaway-admin-pass-not-a-secret",
      "--keys-dir",
      keysDir,
    ]);
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
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

describe("flair#2359 — agent add refuses an id outside the shared rule before anything is written", () => {
  test("a dot in the id is refused with the named rule, no key files, no ops call", async () => {
    const result = await agentAdd("bad.id");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("invalid agent id");
    expect(result.stderr).toContain("^[a-zA-Z0-9_-]{1,64}$");
    // Nothing reached the operations API, and no key material was written.
    expect(ops).toEqual([]);
    expect(existsSync(keysDir)).toBe(false);
  });

  test("an over-long id (65 chars) is refused before any write", async () => {
    const result = await agentAdd("a".repeat(65));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("invalid agent id");
    expect(ops).toEqual([]);
    expect(existsSync(keysDir)).toBe(false);
  });

  test("a conforming id still reaches the operations API (the guard is not over-broad)", async () => {
    const result = await agentAdd("good-id-2359");

    expect(result.code).toBe(0);
    expect(ops).toContain("insert");
    expect(table.has("good-id-2359")).toBe(true);
    expect(readdirSync(keysDir).length).toBeGreaterThan(0);
  });
});
