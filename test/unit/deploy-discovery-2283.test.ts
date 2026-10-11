/**
 * deploy-discovery-2283.test.ts — flair#2283.
 *
 * `flair deploy`'s self-verify must run the SAME discovery discriminator
 * `flair mcp enable` runs (src/lib/mcp-enable.ts). A positive classification
 * requires the target document's own `issuer` to EQUAL a caller-known candidate —
 * the configured `FLAIR_PUBLIC_URL` / `FLAIR_MCP_ISSUER` read from the shipped
 * component `.env`, plus the origin the deploy shipped to — and its `token_endpoint`
 * to be that issuer's. So a deploy whose shipped `.env` implies MCP OAuth is
 * enabled fails when the document advertises flair's own token endpoint for an
 * issuer the deploy knows, and deploy verification is enabled. A document naming an
 * unknown token endpoint, or one that is not JSON, is reported as a warning, never
 * as a failure and never as a pass.
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

/** Capture `console.warn` during a test so a warning's TEXT can be asserted. */
function captureWarn(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  return { lines, restore: () => { console.warn = original; } };
}

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
  test("a document advertising the MCP token endpoint of the shipped origin passes", async () => {
    shape = "plugin-live";
    await expect(verifyDeployedMcpDiscovery({ url: origin, mcpOAuthConfigured: true })).resolves.toBeUndefined();
  });

  test("local configuration implying MCP OAuth is enabled makes flair's own advertised endpoint a failure", async () => {
    shape = "plugin-absent";
    await expect(verifyDeployedMcpDiscovery({ url: origin, mcpOAuthConfigured: true })).rejects.toThrow(
      /document advertises flair's own token endpoint/,
    );
  });

  test("the same document with no local inference of enablement is not a failure", async () => {
    shape = "plugin-absent";
    await expect(verifyDeployedMcpDiscovery({ url: origin, mcpOAuthConfigured: false })).resolves.toBeUndefined();
  });

  test("a document naming an unrecognized token endpoint warns rather than throwing", async () => {
    shape = "unrecognized";
    const warnings = captureWarn();
    try {
      await expect(verifyDeployedMcpDiscovery({ url: origin, mcpOAuthConfigured: true })).resolves.toBeUndefined();
      // The warning is EMITTED, not merely non-fatal: suppressing it must fail this.
      expect(warnings.lines.join("\n")).toContain(
        "MCP OAuth discovery: the MCP authorization server could not be confirmed",
      );
    } finally {
      warnings.restore();
    }
  });

  test("a non-JSON document warns rather than throwing", async () => {
    shape = "non-json";
    const warnings = captureWarn();
    try {
      await expect(verifyDeployedMcpDiscovery({ url: origin, mcpOAuthConfigured: true })).resolves.toBeUndefined();
      expect(warnings.lines.join("\n")).toContain(
        "MCP OAuth discovery: the MCP authorization server could not be confirmed",
      );
    } finally {
      warnings.restore();
    }
  });

  // ─── Part B: the whole deploy() path, so the CALL is under test ─────────────

  const TARGET = "https://prod.acme.harperfabric.com";
  const temps: string[] = [];

  afterAll(() => {
    while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
  });

  function synthPkgRoot(dotEnv: string | null, harperJs = "process.exit(0);\n"): string {
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
    writeFileSync(join(binDir, "harper.js"), harperJs);
    return dir;
  }

  /** A target that answers every post-deploy probe, with `shape` at the well-known.
   *  `docIssuer` overrides the issuer the well-known document advertises, so a
   *  document whose issuer differs from the probed origin (a vanity public URL) can
   *  be exercised. */
  function routedTarget(routeShape: Shape, docIssuer?: string) {
    return (async (input: any) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      if (url.pathname === "/.well-known/oauth-authorization-server") return documentFor(docIssuer ?? url.origin, routeShape);
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
    "deploy() with verification enabled fails when shipped .env implies MCP OAuth and discovery advertises flair's own endpoint",
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
        ).rejects.toThrow(/document advertises flair's own token endpoint/);
      } finally {
        globalThis.fetch = origFetch;
      }
    },
    120_000,
  );

  // flair#2283 round 6: a staged component `.env` that EXISTS but cannot be READ
  // must fail the verification BY NAME, never default to "not configured / no known
  // issuers" — that empty default would let a deploy return success against an
  // instance serving flair's own AS, which is the whole class this check closes.
  //
  // The stub harper replaces the staged `.env` with a DIRECTORY so readFileSync
  // throws (EISDIR) regardless of the runner's uid: a chmod-0000 file is still
  // readable as root, which would make this control vacuous in CI containers.
  test(
    "deploy() fails by name when the staged .env cannot be read",
    async () => {
      const UNREADABLE_ENV = [
        'const fs = require("node:fs");',
        'try { fs.rmSync(".env", { force: true, recursive: true }); } catch {}',
        'fs.mkdirSync(".env");',
        "process.exit(0);",
        "",
      ].join("\n");
      const pkgRoot = synthPkgRoot("FLAIR_MCP_OAUTH=true\n", UNREADABLE_ENV);
      const origFetch = globalThis.fetch;
      // A plugin-live document with NO known issuers would pass if the read failure
      // silently became "not configured" — so this case fails exactly when the fix
      // is reverted to the empty defaults.
      globalThis.fetch = routedTarget("plugin-live");
      try {
        await expect(
          deploy({
            target: TARGET,
            fabricUser: "admin",
            fabricPassword: "pw",
            packageRoot: pkgRoot,
            verifyTimeoutMs: 40_000,
          } as any),
        ).rejects.toThrow(/could not read the staged \.env; discovery not verified/);
      } finally {
        globalThis.fetch = origFetch;
      }
    },
    120_000,
  );

  // flair#2283 round 5: staging preserves an operator's FLAIR_PUBLIC_URL when it
  // differs from the deploy target (component-env.ts planComponentEnv). The deploy
  // must pass that shipped value — and FLAIR_MCP_ISSUER — as caller-known issuers,
  // as doctor does; binding to the target URL alone left a vanity issuer advertising
  // flair's own /OAuthToken "unrecognized" (a warning) instead of the named failure.
  test(
    "deploy() fails for a shipped vanity FLAIR_PUBLIC_URL whose document advertises flair's own token endpoint",
    async () => {
      const VANITY = "https://vanity.acme.example.com";
      const pkgRoot = synthPkgRoot(`FLAIR_MCP_OAUTH=true\nFLAIR_PUBLIC_URL=${VANITY}\n`);
      const origFetch = globalThis.fetch;
      globalThis.fetch = routedTarget("plugin-absent", VANITY);
      try {
        await expect(
          deploy({
            target: TARGET,
            fabricUser: "admin",
            fabricPassword: "pw",
            packageRoot: pkgRoot,
            verifyTimeoutMs: 40_000,
          } as any),
        ).rejects.toThrow(/document advertises flair's own token endpoint/);
      } finally {
        globalThis.fetch = origFetch;
      }
    },
    120_000,
  );
});
