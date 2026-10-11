/**
 * mcp-discovery-discriminator-2283.test.ts — flair#2283.
 *
 * The discovery discriminator compares an RFC 8414 document's STRINGS against an
 * issuer the CALLER knows independently of the document — the configured
 * FLAIR_PUBLIC_URL / FLAIR_MCP_ISSUER, or the origin the caller verifies.
 * Flair's document advertises `<issuer>/OAuthToken`; the plugin's MCP document
 * advertises `<issuer>/oauth/mcp/token`. A positive result requires `issuer` to equal a
 * caller-known candidate; the document's own `issuer` is never a candidate on its
 * own. `flair mcp enable` runs the check inside `selfVerifyMcpMetadata`; `flair
 * doctor` and `flair deploy` import `discriminateMcpOAuthDiscovery` so all three
 * read one function.
 *
 * These drive it against a REAL HTTP server that answers each of the document
 * shapes on the wire — not a stubbed `fetch` — so the parse, the HTTP-status
 * handling and the comparison are exercised together.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discriminateMcpOAuthDiscovery,
  mcpAuthServerOwner,
  reportMcpOAuthDiscovery,
  selfVerifyMcpMetadata,
} from "../../src/lib/mcp-enable.ts";

type Shape = "plugin-live" | "plugin-absent" | "unrecognized" | "non-json" | "not-found";

let server: ReturnType<typeof Bun.serve>;
let origin: string;
let shape: Shape;

/** When set, the document advertises THIS issuer instead of the probed origin —
 *  the shape of a document advertising flair's own token endpoint while doctor
 *  probes it over loopback (FLAIR_PUBLIC_URL ≠ the probed address). */
let advertisedIssuer: string | null = null;
/** When true, the document omits `issuer` entirely — the fallback shape. */
let omitIssuer = false;

function documentFor(o: string, s: Shape): Response {
  const base = advertisedIssuer ?? o;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const withIssuer = (body: Record<string, unknown>) => json(omitIssuer ? body : { issuer: base, ...body });
  switch (s) {
    case "plugin-live":
      return withIssuer({
        registration_endpoint: `${base}/oauth/mcp/register`,
        token_endpoint: `${base}/oauth/mcp/token`,
        client_id_metadata_document_supported: true,
        token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
      });
    case "plugin-absent":
      return withIssuer({ token_endpoint: `${base}/OAuthToken` });
    case "unrecognized":
      return withIssuer({ token_endpoint: `${base}/weird/token` });
    case "non-json":
      return new Response("<html>nope</html>", { status: 200, headers: { "content-type": "text/html" } });
    case "not-found":
      return json({ error: "not_found" }, 404);
  }
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return documentFor(url.origin, shape);
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

describe("mcpAuthServerOwner", () => {
  const issuer = "https://flair.example.com";
  test("names the plugin for the MCP token endpoint and flair's own for /OAuthToken", () => {
    expect(mcpAuthServerOwner(issuer, `${issuer}/oauth/mcp/token`)).toBe("plugin");
    expect(mcpAuthServerOwner(issuer, `${issuer}/OAuthToken`)).toBe("flair-own");
    expect(mcpAuthServerOwner(issuer, `${issuer}/oauth/mcp/token/`)).toBe("other");
    expect(mcpAuthServerOwner(issuer, "https://token.elsewhere.example/x")).toBe("other");
    expect(mcpAuthServerOwner(issuer, undefined)).toBe("other");
  });
});

describe("discriminateMcpOAuthDiscovery (real HTTP)", () => {
  test("plugin-live when the document names the MCP authorization server", async () => {
    shape = "plugin-live";
    const result = await discriminateMcpOAuthDiscovery(origin);
    expect(result.state).toBe("plugin-live");
    expect(result.tokenEndpoint).toBe(`${origin}/oauth/mcp/token`);
    expect(result.status).toBe(200);
    expect(result.origin).toBe(origin);
  });

  test("plugin-absent when the document names flair's own authorization server", async () => {
    shape = "plugin-absent";
    const result = await discriminateMcpOAuthDiscovery(origin);
    expect(result.state).toBe("plugin-absent");
    expect(result.tokenEndpoint).toBe(`${origin}/OAuthToken`);
  });

  test("unrecognized when the document names an unrelated token endpoint", async () => {
    shape = "unrecognized";
    const result = await discriminateMcpOAuthDiscovery(origin);
    expect(result.state).toBe("unrecognized");
    expect(result.detail).toContain("/weird/token");
  });

  test("unreachable when the answer is not JSON", async () => {
    shape = "non-json";
    const result = await discriminateMcpOAuthDiscovery(origin);
    expect(result.state).toBe("unreachable");
    expect(result.status).toBe(200);
    expect(result.detail).toContain("did not return JSON");
  });

  // flair#2283 blocker 1: Flair can advertise FLAIR_PUBLIC_URL as its issuer while
  // doctor probes loopback. Comparing the token endpoint against the PROBED
  // address turned a document advertising flair's own token endpoint into
  // "unrecognized" (and, symmetrically, let an unrelated endpoint read "live").
  // These drive the document's OWN issuer, distinct from the probed address.
  test("plugin-absent when the document advertises a public issuer the caller knows, distinct from the probed address", async () => {
    shape = "plugin-absent";
    advertisedIssuer = "https://public.flair.example.com";
    try {
      const result = await discriminateMcpOAuthDiscovery(origin, {
        expectedIssuers: ["https://public.flair.example.com"],
      });
      expect(result.state).toBe("plugin-absent");
      expect(result.issuer).toBe("https://public.flair.example.com");
      expect(result.tokenEndpoint).toBe("https://public.flair.example.com/OAuthToken");
    } finally {
      advertisedIssuer = null;
    }
  });

  test("plugin-live when the document advertises a public issuer the caller knows, distinct from the probed address", async () => {
    shape = "plugin-live";
    advertisedIssuer = "https://public.flair.example.com";
    try {
      const result = await discriminateMcpOAuthDiscovery(origin, {
        expectedIssuers: ["https://public.flair.example.com"],
      });
      expect(result.state).toBe("plugin-live");
      expect(result.tokenEndpoint).toBe("https://public.flair.example.com/oauth/mcp/token");
    } finally {
      advertisedIssuer = null;
    }
  });

  // flair#2283 round 2: the document's OWN issuer is not a trust anchor. A fully
  // "plugin-shaped" document (issuer = X, token_endpoint = X/oauth/mcp/token) whose
  // X is not an issuer the caller knows is NOT plugin-live — the caller must know X
  // independently of the document. Re-adding the document's issuer as a candidate
  // (the mutation this pins) makes this case read "plugin-live".
  test("a plugin-shaped document whose issuer the caller does not know is not plugin-live", async () => {
    shape = "plugin-live"; // issuer = advertised; token = advertised/oauth/mcp/token
    advertisedIssuer = "https://stranger.flair.example.com";
    try {
      const result = await discriminateMcpOAuthDiscovery(origin, {
        expectedIssuers: ["https://expected.flair.example.com"],
      });
      expect(result.state).not.toBe("plugin-live");
      expect(result.state).toBe("unrecognized");
      expect(result.detail).toContain("https://stranger.flair.example.com");
    } finally {
      advertisedIssuer = null;
    }
  });

  test("an issuer-less document cannot be positively classified, even when the caller supplies the public issuer", async () => {
    shape = "plugin-live";
    omitIssuer = true;
    advertisedIssuer = "https://public.flair.example.com";
    try {
      // The document's endpoints derive from the public URL, but with no `issuer`
      // string of its own there is nothing to bind to a caller-known issuer.
      const withExpected = await discriminateMcpOAuthDiscovery(origin, {
        expectedIssuers: ["https://public.flair.example.com"],
      });
      expect(withExpected.state).toBe("unrecognized");
      const withoutExpected = await discriminateMcpOAuthDiscovery(origin);
      expect(withoutExpected.state).toBe("unrecognized");
    } finally {
      omitIssuer = false;
      advertisedIssuer = null;
    }
  });

  test("unreachable (a named non-2xx) when the answer is a 404", async () => {
    shape = "not-found";
    const result = await discriminateMcpOAuthDiscovery(origin);
    expect(result.state).toBe("unreachable");
    expect(result.status).toBe(404);
    expect(result.detail).toContain("HTTP 404");
  });

  test("unreachable with no status when the request itself fails", async () => {
    // Nothing listens on port 1; the request throws rather than answering.
    const result = await discriminateMcpOAuthDiscovery("http://127.0.0.1:1");
    expect(result.state).toBe("unreachable");
    expect(result.status).toBeUndefined();
    expect(result.detail).toContain("could not reach");
  });
});

describe("reportMcpOAuthDiscovery", () => {
  async function observe(s: Shape) {
    shape = s;
    return discriminateMcpOAuthDiscovery(origin);
  }

  test("metadata advertising the expected MCP token endpoint is a pass", async () => {
    const report = reportMcpOAuthDiscovery(await observe("plugin-live"), false);
    expect(report.severity).toBe("ok");
    expect(report.pass).toBe(true);
  });

  test("flair's own advertised endpoint with locally inferred MCP OAuth is a named failure with a remedy", async () => {
    const report = reportMcpOAuthDiscovery(await observe("plugin-absent"), true);
    expect(report.severity).toBe("error");
    expect(report.pass).toBe(false);
    expect(report.lines[0]).toContain("local configuration implies FLAIR_MCP_OAUTH is enabled, but the document advertises flair's own token endpoint");
    expect(report.lines[1]).toContain("FLAIR_MCP_OAUTH=true");
  });

  test("flair's own advertised endpoint without locally inferred MCP OAuth is informational", async () => {
    const report = reportMcpOAuthDiscovery(await observe("plugin-absent"), false);
    expect(report.severity).toBe("info");
    expect(report.pass).toBe(false);
  });

  test("unreachable is neither a pass nor an error", async () => {
    const report = reportMcpOAuthDiscovery(await observe("not-found"), true);
    expect(report.severity).toBe("warn");
    expect(report.pass).toBe(false);
  });
});

describe("selfVerifyMcpMetadata runs the same discriminator", () => {
  test("a live plugin document passes (CIMD advertised)", async () => {
    shape = "plugin-live";
    const result = await selfVerifyMcpMetadata(origin, { fetchImpl: fetch });
    expect(result.ok).toBe(true);
    expect(result.tokenEndpoint).toBe(`${origin}/oauth/mcp/token`);
  });

  test("flair's own document is refused by name, not blamed on CIMD configuration", async () => {
    shape = "plugin-absent";
    const result = await selfVerifyMcpMetadata(origin, { fetchImpl: fetch });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("FLAIR_MCP_OAUTH");
    expect(result.detail).not.toContain("clientIdMetadataDocuments");
  });
});

// ─── Through the REAL `flair doctor` command ───────────────────────────────────
//
// The discriminator is exercised directly above; this drives the whole command so
// the CALL in doctor.ts is what is under test: removing it leaves the configured
// case no longer reporting the failure, which this file then fails on. The fake
// issuer is the SAME real HTTP server the tests above use (it answers /.well-known
// from `shape` and everything else with 200 JSON, so doctor's /Health probe
// reaches it). "Configured" is FLAIR_MCP_OAUTH in the child's environment, the
// other half of the effective-flag decision.

describe("flair doctor runs the discriminator through the real command", () => {
  const CLI_ENTRY = join(import.meta.dirname, "..", "..", "src", "cli.ts");

  function runDoctor(extraEnv: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
    const home = mkdtempSync(join(tmpdir(), "flair-2283-doctor-"));
    // A minimal PATH (a bare `sh`), as test/helpers/offline-doctor.ts uses: the
    // lane's service-manager tripwire is FIRST on the real PATH, and doctor's
    // install-tree section reaches `systemctl` when its own process sits in a
    // systemd cgroup. Omitting PATH entirely is what keeps this case from
    // tripping the lane (flair#2062).
    const bin = join(home, "bin");
    mkdirSync(bin);
    symlinkSync("/bin/sh", join(bin, "sh"));
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI_ENTRY, "doctor", "--port", String(server.port)], {
        cwd: home,
        env: { HOME: home, USERPROFILE: home, TMPDIR: home, NO_COLOR: "1", PATH: bin, ...extraEnv },
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("close", (status) => {
        rmSync(home, { recursive: true, force: true });
        resolve({ status, stdout, stderr });
      });
    });
  }

  test(
    "doctor reports a named failure for flair's own advertised endpoint with locally inferred MCP OAuth",
    async () => {
      shape = "plugin-absent";
      const result = await runDoctor({ FLAIR_MCP_OAUTH: "true" });
      expect(result.stdout).toContain("local configuration implies FLAIR_MCP_OAUTH is enabled, but the document advertises flair's own token endpoint");
      expect(result.status).not.toBe(0);
    },
    60_000,
  );

  test(
    "a document advertising the MCP token endpoint of the probed origin is reported as a pass",
    async () => {
      shape = "plugin-live";
      const result = await runDoctor({ FLAIR_MCP_OAUTH: "true" });
      expect(result.stdout).toContain("the metadata advertises the expected token endpoint");
      expect(result.stdout).not.toContain("local configuration implies FLAIR_MCP_OAUTH is enabled, but the document advertises flair's own token endpoint");
    },
    60_000,
  );

  test(
    "doctor reports a named failure for a known public issuer's own endpoint with locally inferred MCP OAuth",
    async () => {
      shape = "plugin-absent";
      advertisedIssuer = "https://public.flair.example.com";
      try {
        const result = await runDoctor({ FLAIR_MCP_OAUTH: "true", FLAIR_PUBLIC_URL: "https://public.flair.example.com" });
        expect(result.stdout).toContain("local configuration implies FLAIR_MCP_OAUTH is enabled, but the document advertises flair's own token endpoint");
        expect(result.status).not.toBe(0);
      } finally {
        advertisedIssuer = null;
      }
    },
    60_000,
  );
});
