/**
 * mcp-surface.test.ts — native /mcp surface, slice 1 (FLAIR-NATIVE-MCP, ops-b6uk).
 *
 * Boots a real Harper with flair loaded as a component and proves the SECURITY
 * boundary end-to-end:
 *
 *   1. Flag ON (HARPER_CONFIG carries mcp.application) → POST /mcp `initialize`
 *      mounts, `tools/list` returns EXACTLY the 9 curated tools — NOT the ~147
 *      auto-generated verb tools, and NO `create_*`/`update_*`/`delete_*` mutators.
 *   2. An unauthed `tools/call` is REJECTED (no verifier yet — slice 2/3).
 *   3. Flag OFF (no HARPER_CONFIG) → POST /mcp 404s (byte-identical to today).
 *
 * CONFIG MECHANISM: the mcp block rides HARPER_CONFIG (the recommended merge-on-top
 * env-config var), set as a real process env var — mirroring how flair delivers it
 * on the local/launchd path and how Fabric delivers it (the deploy `.env` is sourced
 * into the env pre-boot). HARPER_SET_CONFIG carries only the base ports/paths.
 *
 * This is the backstop for the resource-level curation (static hidden +
 * FlairMcp.mcpTools): if a future resource ships without `static hidden`, the
 * `tools/list === 9` assertion fails here instead of silently leaking a mutator.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo, type Server } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HARPER_BIN = join(process.cwd(), "node_modules", "@harperfast", "harper", "dist", "bin", "harper.js");
const NODE_BIN = process.env.NODE_BIN ?? "node";
const STARTUP_TIMEOUT_MS = 60_000;

const CURATED = [
  "memory_search", "memory_store", "memory_get", "memory_delete", "bootstrap",
  "soul_set", "soul_get", "flair_workspace_set", "flair_orgevent",
].sort();

async function getFreePorts(count: number): Promise<number[]> {
  const servers = await Promise.all(
    Array.from({ length: count }, () =>
      new Promise<Server>((resolve, reject) => {
        const srv = createServer();
        srv.once("error", reject);
        srv.listen(0, "127.0.0.1", () => resolve(srv));
      })),
  );
  const ports = servers.map(s => (s.address() as AddressInfo).port);
  await Promise.all(servers.map(s => new Promise<void>(r => s.close(() => r()))));
  return ports;
}

interface Booted { httpURL: string; installDir: string; proc: ChildProcess; }

/**
 * Spawn Harper with flair as a component. `mcp` true → deliver the
 * `mcp.application` block via HARPER_CONFIG set as a real process env var (the
 * flag-ON path: this is exactly how flair delivers it locally/launchd, and how
 * Fabric delivers it after sourcing the deploy `.env` into the env pre-boot).
 * `mcp` false → omit it (flag-OFF / byte-identical). HARPER_SET_CONFIG always
 * carries only the base ports/paths — the mcp block is NEVER folded into it.
 */
async function boot(mcp: boolean): Promise<Booted> {
  const installDir = await mkdtemp(join(tmpdir(), "flair-mcp-test-"));
  const parentEnv = { ...(process.env as Record<string, string>) };
  delete parentEnv.GITHUB_TOKEN;
  delete parentEnv.NPM_TOKEN;

  const [httpPort, opsPort] = await getFreePorts(2);
  const httpURL = `http://127.0.0.1:${httpPort}`;

  const baseConfig: Record<string, unknown> = {
    rootPath: installDir,
    http: { port: httpPort, cors: true },
    operationsApi: { network: { port: opsPort, cors: true } },
    mqtt: { network: { port: null }, webSocket: false },
    localStudio: { enabled: false },
    authentication: { authorizeLocal: true, enableSessions: true },
  };

  const baseEnv: Record<string, string> = {
    ...parentEnv,
    ROOTPATH: installDir,
    HOME: installDir,
    FLAIR_MODELS_DIR: parentEnv.FLAIR_MODELS_DIR ?? join(process.cwd(), "models"),
    DEFAULTS_MODE: "dev",
    HDB_ADMIN_USERNAME: "admin",
    HDB_ADMIN_PASSWORD: "test123",
    THREADS_COUNT: "1",
    NODE_HOSTNAME: "127.0.0.1",
    HTTP_PORT: String(httpPort),
    OPERATIONSAPI_NETWORK_PORT: String(opsPort),
    HARPER_SET_CONFIG: JSON.stringify(baseConfig),
    // Flag mirrors the config: ON sets HARPER_CONFIG (mounting /mcp) AND enables
    // FlairMcp's tool-registration nudge; OFF leaves both absent (byte-identical).
    FLAIR_MCP_ENABLED: mcp ? "1" : "false",
  };
  if (mcp) {
    // The mcp block rides HARPER_CONFIG as a real env var (merge-on-top), with
    // mountPath only — no allow/deny (a no-op on the application profile; curation
    // is resource-level static hidden + FlairMcp.mcpTools).
    baseEnv.HARPER_CONFIG = JSON.stringify({ mcp: { application: { mountPath: "/mcp" } } });
  }

  const install = spawn(NODE_BIN, [HARPER_BIN, "install"], { cwd: process.cwd(), env: baseEnv });
  await new Promise<void>((resolve, reject) => {
    let out = "";
    install.stdout?.on("data", d => out += d);
    install.stderr?.on("data", d => out += d);
    install.on("exit", c => c === 0 ? resolve() : reject(new Error(`install exit ${c}: ${out}`)));
    install.on("error", reject);
    setTimeout(() => { install.kill(); reject(new Error(`install timeout: ${out}`)); }, 30_000);
  });

  const proc = spawn(NODE_BIN, [HARPER_BIN, "run", "."], { cwd: process.cwd(), env: baseEnv });
  let log = "";
  let exited = false;
  proc.stdout?.on("data", d => log += d);
  proc.stderr?.on("data", d => log += d);
  proc.on("exit", () => exited = true);

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`Harper exited during startup. Log:\n${log}`);
    try {
      const res = await fetch(`${httpURL}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.status > 0) break;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  if (Date.now() >= deadline) throw new Error(`Harper did not become healthy. Log:\n${log}`);
  return { httpURL, installDir, proc };
}

async function shutdown(b: Booted | undefined): Promise<void> {
  if (!b) return;
  if (b.proc.exitCode === null && b.proc.signalCode === null) {
    b.proc.kill();
    await new Promise<void>(r => { b.proc.on("exit", () => r()); setTimeout(() => { try { b.proc.kill("SIGKILL"); } catch {} r(); }, 3000); });
  }
  await rm(b.installDir, { recursive: true, force: true, maxRetries: 4 });
}

const MCP_HEADERS = {
  "content-type": "application/json",
  "accept": "application/json, text/event-stream",
  "mcp-protocol-version": "2025-06-18",
};

/** POST /mcp initialize → the negotiated session id. */
async function mcpInitialize(httpURL: string): Promise<string> {
  const res = await fetch(`${httpURL}/mcp`, {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "flair-mcp-test", version: "0" } },
    }),
  });
  expect(res.status).toBe(200);
  const sessionId = res.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();
  // The spec lifecycle wants an initialized notification before normal traffic.
  await fetch(`${httpURL}/mcp`, {
    method: "POST",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId! },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  return sessionId!;
}

describe("native /mcp surface — slice 1 (curated, default-off, unauthed-reject)", () => {
  describe("flag ON — mcp.application in root config", () => {
    let b: Booted | undefined;
    beforeAll(async () => { b = await boot(true); }, STARTUP_TIMEOUT_MS + 40_000);
    afterAll(async () => { await shutdown(b); });

    test("tools/list returns EXACTLY the 9 curated tools — not the 147, no mutators", async () => {
      const sessionId = await mcpInitialize(b!.httpURL);
      const res = await fetch(`${b!.httpURL}/mcp`, {
        method: "POST",
        headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      });
      expect(res.status).toBe(200);
      const json: any = await res.json();
      const tools: any[] = json?.result?.tools ?? [];
      const names = tools.map(t => t.name).sort();

      // Exactly the 9 curated tools.
      expect(names).toEqual(CURATED);
      expect(names.length).toBe(9);

      // PROOF the surface is curated, NOT the raw 147: zero auto-generated
      // verb tools and ZERO mutators leaked.
      const mutators = names.filter(n => /^(create|update|patch|delete)_/.test(n));
      expect(mutators).toEqual([]);
      const verbTools = names.filter(n => /^(get|search|create|update|patch|delete)_/.test(n));
      expect(verbTools).toEqual([]);
    });

    test("unauthed tools/call is rejected (no Bearer verifier yet — slice 2/3)", async () => {
      const sessionId = await mcpInitialize(b!.httpURL);
      const res = await fetch(`${b!.httpURL}/mcp`, {
        method: "POST",
        headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 3, method: "tools/call",
          params: { name: "memory_search", arguments: { query: "anything", limit: 1 } },
        }),
      });
      expect(res.status).toBe(200); // JSON-RPC transport returns 200 with an error payload
      const json: any = await res.json();
      // The tool surfaces the rejection as an MCP tool error (isError) carrying
      // "authentication required" — proves no anonymous data access.
      const payload = JSON.stringify(json).toLowerCase();
      expect(payload).toContain("authentication required");
    });
  });

  describe("flag OFF — no mcp block (byte-identical to today)", () => {
    let b: Booted | undefined;
    beforeAll(async () => { b = await boot(false); }, STARTUP_TIMEOUT_MS + 40_000);
    afterAll(async () => { await shutdown(b); });

    test("POST /mcp 404s — the surface is absent", async () => {
      const res = await fetch(`${b!.httpURL}/mcp`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
        }),
      });
      expect(res.status).toBe(404);
    });
  });
});
