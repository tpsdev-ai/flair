/**
 * reembed-server-support-2337.test.ts — `flair reembed` refuses before its
 * first write against a server that does not advertise the re-embed PATCH
 * (flair#2337).
 *
 * The CLI is spawned against a stub HTTP server (ephemeral 127.0.0.1 port) that
 * stands in for the server, so the check is exercised through the real CLI
 * entry point. Real Harper coverage:
 * test/integration/reembed-preserves-fields-2296.test.ts — current-server PATCH;
 * test/compat/reembed-pre-2298.test.ts — older-server refusal in both CLI modes.
 *
 * Fixtures and outputs use neutral ids (agent-a), never a real host or agent.
 */
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import nacl from "tweetnacl";
import { tempDir } from "../helpers/temp-dir";
import { ensureCliBuild } from "../helpers/build-cli-once.js";
import { getModelId } from "../../resources/embeddings-provider.ts";
import {
  MEMORY_REEMBED_PATCH_CAPABILITY,
  healthVersion,
  parseHealthCapabilities,
  reembedUnsupportedMessage,
} from "../../src/lib/reembed-server-support.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const CLI = join(REPO_ROOT, "dist", "cli.js");
// The spawn `timeout` and each per-case budget are written as literals: the
// CLI spawn-budget gate reads them as text (scripts/ci/check-cli-spawn-budgets.mjs).
const CURRENT_MODEL_ID = getModelId();

type Recorded = { method: string; path: string };

/**
 * A stub server on an ephemeral 127.0.0.1 port. Rejects (fails fast) if it
 * cannot bind within 5 s; every response closes its connection so teardown is
 * not held open by a kept-alive connection.
 */
function startStub(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{
  port: number;
  requests: Recorded[];
  close: () => Promise<void>;
}> {
  const requests: Recorded[] = [];
  const server: Server = createServer((req, res) => {
    requests.push({ method: req.method ?? "", path: (req.url ?? "").split("?")[0] });
    res.setHeader("Connection", "close");
    handler(req, res);
  });
  return new Promise((resolveStart, rejectStart) => {
    const guard = setTimeout(() => rejectStart(new Error("stub server did not bind within 5000ms")), 5000);
    server.on("error", (err) => {
      clearTimeout(guard);
      rejectStart(err);
    });
    server.listen(0, "127.0.0.1", () => {
      clearTimeout(guard);
      const { port } = server.address() as AddressInfo;
      resolveStart({
        port,
        requests,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** A /Health fixture without capabilities. */
const OLD_HEALTH = { ok: true, version: "0.59.0", buildCommit: null, searchReady: true };
/** A /Health fixture advertising the re-embed PATCH. */
const CURRENT_HEALTH = {
  ok: true,
  version: "0.60.0",
  buildCommit: null,
  searchReady: true,
  capabilities: [MEMORY_REEMBED_PATCH_CAPABILITY],
};
const CANDIDATE = { id: "agent-a/item-1", content: "fixture content", embeddingModel: "stale-model" };

/** A HOME with a key file for agent-a, so the single-agent path proceeds. */
function homeWithKey(): string {
  const home = tempDir("flair-2337-home-");
  const keysDir = join(home, ".flair", "keys");
  mkdirSync(keysDir, { recursive: true });
  writeFileSync(join(keysDir, "agent-a.key"), nacl.sign.keyPair().secretKey.slice(0, 32), { mode: 0o600 });
  return home;
}

function runReembed(port: number, home: string, args: string[] = []): Promise<{ code: number | null; out: string }> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(FLAIR_|HARPER_|HDB_|FABRIC_)/.test(key)));
  // Async, not spawnSync: the stand-in server shares this process, so a blocked
  // event loop would leave its requests unanswered. The child still carries its
  // own deadline via the `timeout` option and a per-case budget below.
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [CLI, "reembed", "--agent", "agent-a", "--port", String(port), ...args], {
      env: { ...env, HOME: home },
      timeout: 60_000,
      killSignal: "SIGTERM",
    });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });
    child.on("error", (err) => { out += `\n[spawn error: ${err.message}]`; });
    child.on("close", (code, signal) => resolveRun({ code, out: out + (signal ? `\n[killed by ${signal}]` : "") }));
  });
}

/** Routes a stand-in server: /Health plus the single-agent read and write paths. */
function standInHealth(health: (req: IncomingMessage, res: ServerResponse) => void) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/Health") return health(req, res);
    if (req.url === "/SemanticSearch") return json(res, 200, { results: [CANDIDATE] });
    if (req.url?.startsWith("/Memory/")) return json(res, 200, { id: CANDIDATE.id, embeddingModel: CURRENT_MODEL_ID });
    return json(res, 404, { error: "not_found" });
  };
}

test("a missing capability: the CLI refuses before any write, names what it found and the remedy", async () => {
  ensureCliBuild();
  const stub = await startStub(standInHealth((_req, res) => json(res, 200, OLD_HEALTH)));
  try {
    expect(["9925", "9926"]).not.toContain(String(stub.port));
    const r = await runReembed(stub.port, homeWithKey());
    expect(r.code, r.out).not.toBe(0);
    expect(stub.requests.some((q) => q.method === "PATCH")).toBe(false);
    expect(r.out).toContain("does not advertise the re-embed PATCH");
    expect(r.out).toContain("server version 0.59.0");
    expect(r.out).toContain("Restart or upgrade the server, then re-run `flair reembed`");
  } finally {
    await stub.close();
  }
}, 90_000);

test("an advertised capability: the CLI sends a re-embed PATCH", async () => {
  ensureCliBuild();
  const stub = await startStub(standInHealth((_req, res) => json(res, 200, CURRENT_HEALTH)));
  try {
    const r = await runReembed(stub.port, homeWithKey(), ["--batch-size", "1", "--delay-ms", "0"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("Re-embedding complete: 1 updated, 0 errors");
    expect(stub.requests.filter((q) => q.method === "PATCH")).toHaveLength(1);
  } finally {
    await stub.close();
  }
}, 90_000);

test.each([
  ["a /Health that returns a non-2xx status", (_req: IncomingMessage, res: ServerResponse) => json(res, 503, { ok: false })],
  ["a /Health that is not JSON", (_req: IncomingMessage, res: ServerResponse) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("not json"); }],
  ["a /Health whose capabilities are not a string array", (_req: IncomingMessage, res: ServerResponse) =>
    json(res, 200, { ...CURRENT_HEALTH, capabilities: "memory-reembed-patch" })],
])("an unverifiable server (%s): the CLI refuses before any write and sends no PATCH", async (_label, health) => {
  ensureCliBuild();
  const stub = await startStub(standInHealth(health));
  try {
    const r = await runReembed(stub.port, homeWithKey());
    expect(r.code, r.out).not.toBe(0);
    expect(stub.requests.some((q) => q.method === "PATCH")).toBe(false);
    expect(r.out).toContain("could not confirm the server supports the re-embed PATCH");
    expect(r.out).toContain("Restart or upgrade the server, then re-run `flair reembed`");
  } finally {
    await stub.close();
  }
}, 90_000);

test("an unreachable server: the CLI refuses before any write", async () => {
  ensureCliBuild();
  // Bind then close, to get a port nothing listens on.
  const stub = await startStub((_req, res) => json(res, 200, OLD_HEALTH));
  const port = stub.port;
  await stub.close();
  const r = await runReembed(port, homeWithKey());
  expect(r.code, r.out).not.toBe(0);
  expect(r.out).toContain("could not confirm the server supports the re-embed PATCH");
}, 90_000);

test("parseHealthCapabilities: absent is [], a string array is read, anything else is null", () => {
  expect(parseHealthCapabilities({})).toEqual([]);
  expect(parseHealthCapabilities({ capabilities: [MEMORY_REEMBED_PATCH_CAPABILITY] })).toEqual([MEMORY_REEMBED_PATCH_CAPABILITY]);
  expect(parseHealthCapabilities({ capabilities: [] })).toEqual([]);
  expect(parseHealthCapabilities({ capabilities: "memory-reembed-patch" })).toBeNull();
  expect(parseHealthCapabilities({ capabilities: [1] })).toBeNull();
  expect(parseHealthCapabilities(null)).toBeNull();
  expect(parseHealthCapabilities([])).toBeNull();
});

test("healthVersion: a non-empty string or null", () => {
  expect(healthVersion({ version: "1.2.3" })).toBe("1.2.3");
  expect(healthVersion({ version: "" })).toBeNull();
  expect(healthVersion({})).toBeNull();
  expect(healthVersion({ version: 7 })).toBeNull();
  expect(healthVersion(null)).toBeNull();
});

test("reembedUnsupportedMessage names the version and the remedy", () => {
  const msg = reembedUnsupportedMessage("0.59.0");
  expect(msg).toContain("0.59.0");
  expect(msg).toContain("Restart or upgrade the server, then re-run `flair reembed`");
  expect(reembedUnsupportedMessage(null)).toContain("server version unknown");
});
