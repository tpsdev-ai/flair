/**
 * principal-add-home-2433.test.ts — flair#2433.
 *
 * `flair principal add` upserts the Agent row through the operations API. The
 * upsert body carries the local instance's home on a create (no stored row) and
 * omits it over a found row.
 *
 * Isolated because it drives the process-global commander `program` and stands
 * up an HTTP server in place of the operations API.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { program } from "../../src/cli.js";

let tmpHome: string;
let keysDir: string;
let server: Server;
let upserts: any[];
let storedRows: Array<Record<string, unknown>>;

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), "flair-2433-principal-"));
  keysDir = join(tmpHome, "keys");
  upserts = [];
  storedRows = [];
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      let answer: unknown = { ok: true };
      if (body.operation === "sql") answer = [{ id: "inst-local-2433" }];
      else if (body.operation === "search_by_id") answer = storedRows;
      else if (body.operation === "upsert") upserts.push(body);
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

async function principalAdd(id: string, opsPort: number): Promise<number> {
  const logSpy = spyOn(console, "log").mockImplementation(() => {});
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  const origExit = process.exit;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as typeof process.exit;
  let code = 0;
  try {
    await program.parseAsync([
      "node", "flair", "principal", "add", id,
      "--ops-port", String(opsPort),
      "--admin-pass", "throwaway-admin-pass-not-a-secret",
      "--keys-dir", keysDir,
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
  return code;
}

function opsPort(): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock ops server has no port");
  return address.port;
}

describe("flair#2433 — principal add upsert body", () => {
  test("a create (no stored row) carries the local home", async () => {
    expect(await principalAdd("fresh-id", opsPort())).toBe(0);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].records[0].id).toBe("fresh-id");
    expect(upserts[0].records[0].originatorInstanceId).toBe("inst-local-2433");
  });

  test("an upsert over a found row omits the home", async () => {
    storedRows = [{ id: "known-id", originatorInstanceId: null }];
    expect(await principalAdd("known-id", opsPort())).toBe(0);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].records[0].id).toBe("known-id");
    expect("originatorInstanceId" in upserts[0].records[0]).toBe(false);
  });
});
