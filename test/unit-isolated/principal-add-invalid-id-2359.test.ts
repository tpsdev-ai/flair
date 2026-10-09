/**
 * principal-add-invalid-id-2359.test.ts — flair#2359.
 *
 * `flair principal add <id>` upserts the Agent row through the operations API,
 * so the Agent resource's own guard never runs on it. The command must refuse an
 * id outside the ONE shared agent-ID rule BEFORE writing any key file or making
 * any request.
 *
 * Isolated because it drives the process-global commander `program` and stands
 * up an HTTP server in place of the operations API.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { program } from "../../src/cli.js";

let tmpHome: string;
let keysDir: string;
let server: Server;
let hits: number;

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), "flair-2359-principal-"));
  keysDir = join(tmpHome, "keys");
  hits = 0;
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.on("data", () => {});
    req.on("end", () => {
      hits++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  rmSync(tmpHome, { recursive: true, force: true });
});

async function principalAdd(id: string, opsPort: number): Promise<{ code: number; stderr: string }> {
  const stderr: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation(() => {});
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
  return { code, stderr: stderr.join("\n") };
}

describe("flair#2359 — principal add refuses an id outside the shared rule before anything is written", () => {
  test("a dot in the id is refused with the named rule, no key files, no ops call", async () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("mock ops server has no port");
    const result = await principalAdd("bad.id", address.port);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("invalid agent id");
    expect(result.stderr).toContain("^[a-zA-Z0-9_-]{1,64}$");
    expect(hits, "a refused id reached the operations API").toBe(0);
    expect(existsSync(keysDir), "a refused id wrote a key file").toBe(false);
  });
});
