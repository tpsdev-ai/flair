/**
 * agent-remove-key-confinement-2479.test.ts — flair#2479.
 *
 * `flair agent remove` checks key candidates against their expected canonical
 * paths. An out-of-rule id requires manual key cleanup.
 *
 * Isolated because it drives the process-global commander `program` and stands
 * up an HTTP server in place of the operations API. The command deletes keys
 * after `resolveLocalDeleteInstance` has accepted the endpoint, so the mock
 * answers `get_configuration` too.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { program } from "../../src/cli.js";
import { setInstancePairOsReadsForTests } from "../../src/lib/local-instance-pair.js";

/**
 * flair#2526: the pair check reads the OS listener table, and the ops endpoint
 * here is a fetch mock with no listener behind it. These tests inject a
 * SIMULATED table: one simulated Harper process id on every port, with a
 * fixed birth identity and a Harper command line. No such process exists.
 */
const SIMULATED_LISTENER_TABLE = {
  listeners: () => ({ kind: "listeners" as const, pids: [24_526] }),
  birth: () => ({ kind: "birth" as const, id: "24526@simulated" }),
  commandLine: () => "node\u0000/simulated/node_modules/harper/dist/bin/harper.js\u0000run\u0000.",
};

let tmpHome: string;
let keysDir: string;
let outsidePath: string;
let server: Server;
let httpPort: number;

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

beforeEach(async () => {
  setInstancePairOsReadsForTests(SIMULATED_LISTENER_TABLE);
  tmpHome = mkdtempSync(join(tmpdir(), "flair-2479-remove-"));
  keysDir = join(tmpHome, "keys");
  mkdirSync(keysDir, { recursive: true });
  outsidePath = join(tmpHome, "outside.key");
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: { operation?: string; table?: string; search_value?: string } = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        return json(res, 400, { error: "bad json" });
      }
      if (body.operation === "get_configuration") {
        const address = server.address();
        const opsPort = address && typeof address !== "string" ? address.port : 0;
        return json(res, 200, {
          http: { port: `127.0.0.1:${httpPort}` },
          operationsApi: { network: { port: opsPort } },
        });
      }
      if (body.operation === "search_by_value" && body.table === "Agent") {
        return json(res, 200, [{ id: String(body.search_value ?? ""), name: String(body.search_value ?? "") }]);
      }
      // Memory/Soul scans: no rows owned by the removed id.
      if (body.operation === "search_by_conditions") return json(res, 200, []);
      return json(res, 200, { ok: true });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock ops server has no port");
  httpPort = address.port + 1; // an arbitrary HTTP port; only the ops port must match
});

afterEach(async () => {
  setInstancePairOsReadsForTests(null);
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  rmSync(tmpHome, { recursive: true, force: true });
});

/** Run the real `flair agent remove <id>` against the mock ops server. */
async function agentRemove(id: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock ops server has no port");
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
      "remove",
      id,
      "--ops-port",
      String(address.port),
      "--admin-pass",
      "throwaway-admin-pass-not-a-secret",
      "--keys-dir",
      keysDir,
      "--force",
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

function putKey(name: string): string {
  const p = join(keysDir, name);
  writeFileSync(p, "not-a-real-secret");
  return p;
}

describe("flair#2479 — agent remove key confinement", () => {
  test("removes only the removed id's own key files; another agent's keys survive", async () => {
    const own = [putKey("agent-a.key"), putKey("agent-a.pub"), putKey("agent-a.key.bak")];
    const other = [putKey("agent-b.key"), putKey("agent-b.pub")];
    writeFileSync(outsidePath, "outside");

    const result = await agentRemove("agent-a");

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Removed 3 key file(s).");
    for (const p of own) expect(existsSync(p)).toBe(false); // assertion: its own key files are gone
    for (const p of other) expect(existsSync(p)).toBe(true); // assertion: another agent's key files survive
    expect(existsSync(outsidePath)).toBe(true); // assertion: a file outside the keys dir survives
  });

  test("a dotted (out-of-rule) id deletes no key file and reports manual cleanup", async () => {
    const dotted = putKey("bad.id.key");

    const result = await agentRemove("bad.id");

    expect(existsSync(dotted)).toBe(true); // assertion: the out-of-rule id's key file survives
    expect(result.stdout.toLowerCase()).toContain("manually"); // assertion: the command says the cleanup is manual
  });

  test("a `.`-segment id cannot reach a file outside the keys dir", async () => {
    mkdirSync(join(tmpHome, "parent"), { recursive: true });
    const victim = join(tmpHome, "parent", "victim.key");
    writeFileSync(victim, "outside");

    const result = await agentRemove("../parent/victim");

    expect(existsSync(victim)).toBe(true); // assertion: the outside file is untouched
    expect(result.stdout.toLowerCase()).toContain("manually"); // assertion: nothing was deleted, cleanup is manual
  });

  test("a symlink to another filename inside the keys dir reports zero removals", async () => {
    const target = putKey("agent-b.key");
    const link = join(keysDir, "agent-a.key");
    symlinkSync(target, link);

    const result = await agentRemove("agent-a");

    expect(result.code).toBe(0);
    expect(existsSync(link)).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(result.stdout).toContain("Removed 0 key file(s).");
    expect(result.stdout).not.toContain("Key files deleted.");
  });

  test("a failed unlink reports zero removals", async () => {
    const candidate = join(keysDir, "agent-a.key");
    mkdirSync(candidate);
    const contents = join(candidate, "contents");
    writeFileSync(contents, "not-a-real-secret");

    const result = await agentRemove("agent-a");

    expect(result.code).toBe(0);
    expect(existsSync(contents)).toBe(true);
    expect(result.stdout).toContain("Removed 0 key file(s).");
    expect(result.stdout).not.toContain("Key files deleted.");
  });

});
