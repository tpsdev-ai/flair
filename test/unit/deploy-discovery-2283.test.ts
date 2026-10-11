/**
 * deploy-discovery-2283.test.ts — flair#2283.
 *
 * `flair deploy`'s self-verify must run the SAME discovery discriminator
 * `flair mcp enable` runs (src/lib/mcp-enable.ts), so a deploy that ships an
 * instance configured for MCP OAuth cannot report success while the MCP
 * authorization server is absent.
 *
 * Part A drives `verifyDeployedMcpDiscovery` — the deploy self-verify's check —
 * against a REAL HTTP server answering each document shape.
 *
 * Part B runs the whole `deploy()` path with a stub Harper binary, so the CALL in
 * `deploy()` is what is under test: removing it leaves the configured-absent case
 * no longer throwing, which this file then fails on.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deploy,
  REQUIRED_PACKAGE_FILES,
  verifyDeployedMcpDiscovery,
} from "../../src/deploy.ts";

type Shape = "plugin-live" | "plugin-absent" | "unrecognized" | "non-json";

function documentFor(o: string, s: Shape): Response {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  switch (s) {
    case "plugin-live":
      return json({ issuer: o, token_endpoint: `${o}/oauth/mcp/token` });
    case "plugin-absent":
      return json({ issuer: o, token_endpoint: `${o}/OAuthToken` });
    case "unrecognized":
      return json({ issuer: o, token_endpoint: `${o}/weird/token` });
    case "non-json":
      return new Response("<html>nope</html>", { status: 200, headers: { "content-type": "text/html" } });
  }
}

// ─── Part A: the check itself, against a real HTTP server ─────────────────────

let server: ReturnType<typeof Bun.serve>;
let origin: string;
let shape: Shape;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/.well-known/oauth-authorization-server") return documentFor(url.origin, shape);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

describe("verifyDeployedMcpDiscovery (real HTTP)", () => {
  test("a live MCP authorization server passes", async () => {
    shape = "plugin-live";
    await expect(verifyDeployedMcpDiscovery({ url: origin, mcpOAuthConfigured: true })).resolves.toBeUndefined();
  });

  test("a configured target whose discovery names flair's own AS fails, naming the remedy", async () => {
    shape = "plugin-absent";
    await expect(verifyDeployedMcpDiscovery({ url: origin, mcpOAuthConfigured: true })).rejects.toThrow(
      /MCP authorization server is absent/,
    );
  });

  test("the same document on an unconfigured target is not a failure", async () => {
    shape = "plugin-absent";
    await expect(verifyDeployedMcpDiscovery({ url: origin, mcpOAuthConfigured: false })).resolves.toBeUndefined();
  });

  test("an unrecognized document warns rather than throwing", async () => {
    shape = "unrecognized";
    await expect(verifyDeployedMcpDiscovery({ url: origin, mcpOAuthConfigured: true })).resolves.toBeUndefined();
  });

  test("a non-JSON document warns rather than throwing", async () => {
    shape = "non-json";
    await expect(verifyDeployedMcpDiscovery({ url: origin, mcpOAuthConfigured: true })).resolves.toBeUndefined();
  });

  // ─── Part B: the whole deploy() path, so the CALL is under test ─────────────

  const TARGET = "https://prod.acme.harperfabric.com";
  const temps: string[] = [];

  afterAll(() => {
    while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
  });

  function synthPkgRoot(dotEnv: string | null): string {
    const dir = mkdtempSync(join(tmpdir(), "flair-deploy-discovery-"));
    temps.push(dir);
    for (const f of REQUIRED_PACKAGE_FILES) {
      const p = join(dir, f);
      if (f.endsWith(".yaml")) writeFileSync(p, "port: 9926\n");
      else mkdirSync(p, { recursive: true });
    }
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "@tpsdev-ai/flair",
        version: "9.9.9-test",
        files: ["dist/", "schemas/", "templates/", "docs/", "config.yaml", "LICENSE", "README.md", "SECURITY.md"],
      }),
    );
    if (dotEnv !== null) writeFileSync(join(dir, ".env"), dotEnv);
    const binDir = join(dir, "node_modules", "harper", "dist", "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "harper.js"), "process.exit(0);\n");
    return dir;
  }

  /** A target that answers every post-deploy probe, with `shape` at the well-known. */
  function routedTarget(routeShape: Shape) {
    return (async (input: any) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      if (url.pathname === "/.well-known/oauth-authorization-server") return documentFor(url.origin, routeShape);
      if (url.pathname === "/OAuthMetadata") {
        return new Response(JSON.stringify({ issuer: TARGET }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/HealthDetail") {
        return new Response(
          JSON.stringify({
            memories: { modelCounts: { "nomic-embed-text-v1.5-Q4_K_M+searchprefix": 599 } },
            migrations: { cyclePhase: "done", migrations: [{ id: "embedding-stamp", state: "completed", rowsRemaining: 0 }] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  }

  test(
    "deploy() refuses success when the shipped .env enables MCP OAuth but the target serves flair's own AS",
    async () => {
      const pkgRoot = synthPkgRoot("FLAIR_MCP_OAUTH=true\n");
      const origFetch = globalThis.fetch;
      globalThis.fetch = routedTarget("plugin-absent");
      try {
        await expect(
          deploy({
            target: TARGET,
            fabricUser: "admin",
            fabricPassword: "pw",
            packageRoot: pkgRoot,
            verifyTimeoutMs: 40_000,
          } as any),
        ).rejects.toThrow(/MCP authorization server is absent/);
      } finally {
        globalThis.fetch = origFetch;
      }
    },
    120_000,
  );
});
