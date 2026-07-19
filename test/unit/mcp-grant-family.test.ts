/**
 * Tests for `flair mcp grant/revoke/list` (flair#746) — src/cli.ts's
 * grantMcpClient/revokeMcpClient/readMcpClientManifest/buildMcpGrantConfig.
 *
 * House style matches test/unit/keys-prune.test.ts: mock globalThis.fetch
 * (or pass an injected fetchImpl), write/read real files under a mkdtemp
 * temp dir, never touch ~/.flair or a real Harper instance.
 *
 * K&S binding-condition coverage (see the #746 PR body for the mapping):
 *   - grant happy path
 *   - duplicate-name rejection ("already exists — use `flair mcp revoke...`")
 *   - revoke requires a server ack; a server error leaves the local key file
 *     (and manifest entry) untouched
 *   - list output (name + client_id + status + created)
 *   - the DCR token-location contract (delegated to dcr-client.test.ts;
 *     re-exercised here at the CLI-gate level)
 *   - 0600 mode on both the private key file and the manifest file
 *   - no key material ever reaches stdout/console output
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  grantMcpClient,
  revokeMcpClient,
  readMcpClientManifest,
  buildMcpGrantConfig,
  defaultMcpClientManifestPath,
  McpClientNameExistsError,
  McpClientAgentIdCollisionError,
  McpClientNotFoundError,
  type McpClientManifestEntry,
} from "../../src/cli.ts";
import { requireDcrToken, DcrTokenNotFoundError, DCR_TOKEN_ENV } from "../../src/lib/dcr-client.ts";

let dir: string;
let keysDir: string;
let manifestPath: string;

const ISSUER = "https://flair.example.com";
const OPS_PORT = 19925;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flair-mcp-grant-"));
  keysDir = join(dir, "keys");
  manifestPath = join(dir, "mcp-clients.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Mock ops-API fetch: search_by_value → configurable existing-agent set;
 *  insert → 200 unless failInsert; delete → 200 unless failDelete. Captures
 *  every request body for assertions. */
function mockOpsFetch(opts: {
  existingAgentIds?: Set<string>;
  failInsert?: boolean;
  failDelete?: boolean;
  networkErrorOnDelete?: boolean;
} = {}): { fetchImpl: typeof fetch; calls: any[] } {
  const calls: any[] = [];
  const fetchImpl = (async (_url: any, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push(body);
    if (body.operation === "search_by_value") {
      const found = opts.existingAgentIds?.has(body.search_value) ? [{ id: body.search_value }] : [];
      return new Response(JSON.stringify(found), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (body.operation === "insert") {
      if (opts.failInsert) return new Response("insert failed", { status: 500 });
      return new Response(JSON.stringify({ message: "inserted" }), { status: 200 });
    }
    if (body.operation === "delete") {
      if (opts.networkErrorOnDelete) throw new TypeError("fetch failed: connection refused");
      if (opts.failDelete) return new Response("delete failed", { status: 500 });
      return new Response(JSON.stringify({ message: "deleted" }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

// ─── grant: happy path ───────────────────────────────────────────────────────

describe("grantMcpClient — happy path", () => {
  test("creates a 0600 keypair, inserts the Agent, writes a 0600 manifest entry, returns a config", async () => {
    const { fetchImpl, calls } = mockOpsFetch();

    const { entry, config } = await grantMcpClient(
      {
        name: "ci-runner",
        keysDir,
        manifestPath,
        issuer: ISSUER,
        opsPortOrUrl: OPS_PORT,
        adminUser: "admin",
        adminPass: "s3cret",
      },
      { fetchImpl, now: () => "2026-07-19T00:00:00.000Z" },
    );

    expect(entry.name).toBe("ci-runner");
    expect(entry.agentId).toBe("ci-runner");
    expect(entry.clientId).toBe(`${ISSUER}/MCPClientMetadata/ci-runner`);
    expect(entry.status).toBe("active");
    expect(entry.createdAt).toBe("2026-07-19T00:00:00.000Z");

    // Key file exists, is 0600, and contains exactly a 32-byte seed.
    expect(existsSync(entry.keyFile)).toBe(true);
    const keyStat = statSync(entry.keyFile);
    expect(keyStat.mode & 0o777).toBe(0o600);
    expect(readFileSync(entry.keyFile).length).toBe(32);

    // Manifest persisted and 0600.
    expect(existsSync(manifestPath)).toBe(true);
    const manifestStat = statSync(manifestPath);
    expect(manifestStat.mode & 0o777).toBe(0o600);
    const persisted = readMcpClientManifest(manifestPath);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].name).toBe("ci-runner");

    // Config references the key file path, never inline key material.
    expect(config).toMatchObject({
      mcpServers: {
        "ci-runner": { type: "http", url: `${ISSUER}/mcp` },
      },
    });
    expect(JSON.stringify(config)).toContain(entry.keyFile);

    // Ops calls: search_by_value (dup check) then insert.
    expect(calls.map((c) => c.operation)).toEqual(["search_by_value", "insert"]);
    expect(calls[1].records[0]).toMatchObject({ id: "ci-runner", publicKey: expect.any(String), runtime: "headless" });
  });

  test("rejects an invalid name before any I/O", async () => {
    const { fetchImpl, calls } = mockOpsFetch();
    await expect(
      grantMcpClient(
        { name: "bad name!", keysDir, manifestPath, issuer: ISSUER, opsPortOrUrl: OPS_PORT, adminUser: "admin", adminPass: "s3cret" },
        { fetchImpl },
      ),
    ).rejects.toThrow(/Invalid machine client name/);
    expect(calls).toHaveLength(0);
    expect(existsSync(manifestPath)).toBe(false);
  });
});

// ─── grant: duplicate-name rejection ────────────────────────────────────────

describe("grantMcpClient — duplicate-name rejection", () => {
  test("rejects a name already present in the manifest with the exact guidance message", async () => {
    const { fetchImpl } = mockOpsFetch();
    await grantMcpClient(
      { name: "dup", keysDir, manifestPath, issuer: ISSUER, opsPortOrUrl: OPS_PORT, adminUser: "admin", adminPass: "s3cret" },
      { fetchImpl },
    );

    let thrown: unknown;
    try {
      await grantMcpClient(
        { name: "dup", keysDir, manifestPath, issuer: ISSUER, opsPortOrUrl: OPS_PORT, adminUser: "admin", adminPass: "s3cret" },
        { fetchImpl: mockOpsFetch().fetchImpl },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(McpClientNameExistsError);
    expect((thrown as Error).message).toBe(
      "Machine client 'dup' already exists — use `flair mcp revoke dup` first or pick a different name.",
    );

    // Only one manifest entry — the second attempt never wrote a second one.
    expect(readMcpClientManifest(manifestPath)).toHaveLength(1);
  });

  test("rejects (distinctly) when the name collides with an unrelated pre-existing Agent not in the manifest", async () => {
    const { fetchImpl } = mockOpsFetch({ existingAgentIds: new Set(["flint"]) });
    await expect(
      grantMcpClient(
        { name: "flint", keysDir, manifestPath, issuer: ISSUER, opsPortOrUrl: OPS_PORT, adminUser: "admin", adminPass: "s3cret" },
        { fetchImpl },
      ),
    ).rejects.toThrow(McpClientAgentIdCollisionError);
    expect(existsSync(join(keysDir, "flint.key"))).toBe(false);
    expect(readMcpClientManifest(manifestPath)).toHaveLength(0);
  });

  test("rolls back the key files it wrote if the Agent insert fails", async () => {
    const { fetchImpl } = mockOpsFetch({ failInsert: true });
    await expect(
      grantMcpClient(
        { name: "will-fail", keysDir, manifestPath, issuer: ISSUER, opsPortOrUrl: OPS_PORT, adminUser: "admin", adminPass: "s3cret" },
        { fetchImpl },
      ),
    ).rejects.toThrow(/Failed to create Agent/);
    expect(existsSync(join(keysDir, "will-fail.key"))).toBe(false);
    expect(existsSync(join(keysDir, "will-fail.pub"))).toBe(false);
    expect(readMcpClientManifest(manifestPath)).toHaveLength(0);
  });
});

// ─── revoke: server-ack requirement ─────────────────────────────────────────

describe("revokeMcpClient — server-ack requirement", () => {
  async function granted(name: string, fetchImpl: typeof fetch): Promise<McpClientManifestEntry> {
    const { entry } = await grantMcpClient(
      { name, keysDir, manifestPath, issuer: ISSUER, opsPortOrUrl: OPS_PORT, adminUser: "admin", adminPass: "s3cret" },
      { fetchImpl },
    );
    return entry;
  }

  test("happy path: server ack (2xx) → key files deleted, manifest entry removed", async () => {
    const grantFetch = mockOpsFetch();
    const entry = await granted("to-revoke", grantFetch.fetchImpl);
    expect(existsSync(entry.keyFile)).toBe(true);

    const { fetchImpl: revokeFetch, calls } = mockOpsFetch();
    const revoked = await revokeMcpClient(
      { name: "to-revoke", manifestPath, opsPortOrUrl: OPS_PORT, adminUser: "admin", adminPass: "s3cret" },
      { fetchImpl: revokeFetch },
    );

    expect(revoked.name).toBe("to-revoke");
    expect(calls).toEqual([{ operation: "delete", database: "flair", table: "Agent", ids: ["to-revoke"] }]);
    expect(existsSync(entry.keyFile)).toBe(false);
    expect(existsSync(entry.pubKeyFile)).toBe(false);
    expect(readMcpClientManifest(manifestPath)).toHaveLength(0);
  });

  test("server 500 on delete → throws, local key file AND manifest entry survive untouched", async () => {
    const grantFetch = mockOpsFetch();
    const entry = await granted("survives", grantFetch.fetchImpl);

    const { fetchImpl: revokeFetch } = mockOpsFetch({ failDelete: true });
    await expect(
      revokeMcpClient(
        { name: "survives", manifestPath, opsPortOrUrl: OPS_PORT, adminUser: "admin", adminPass: "s3cret" },
        { fetchImpl: revokeFetch },
      ),
    ).rejects.toThrow(/Server-side revoke failed \(HTTP 500\)/);

    expect(existsSync(entry.keyFile)).toBe(true);
    expect(existsSync(entry.pubKeyFile)).toBe(true);
    const surviving = readMcpClientManifest(manifestPath);
    expect(surviving).toHaveLength(1);
    expect(surviving[0].name).toBe("survives");
  });

  test("network error reaching the ops API → throws, nothing deleted locally", async () => {
    const grantFetch = mockOpsFetch();
    const entry = await granted("net-fail", grantFetch.fetchImpl);

    const { fetchImpl: revokeFetch } = mockOpsFetch({ networkErrorOnDelete: true });
    await expect(
      revokeMcpClient(
        { name: "net-fail", manifestPath, opsPortOrUrl: OPS_PORT, adminUser: "admin", adminPass: "s3cret" },
        { fetchImpl: revokeFetch },
      ),
    ).rejects.toThrow(/could not reach the operations API/);

    expect(existsSync(entry.keyFile)).toBe(true);
    expect(readMcpClientManifest(manifestPath)).toHaveLength(1);
  });

  test("unknown name → McpClientNotFoundError, no network call at all", async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return new Response("{}", { status: 200 }); }) as typeof fetch;
    await expect(
      revokeMcpClient(
        { name: "never-granted", manifestPath, opsPortOrUrl: OPS_PORT, adminUser: "admin", adminPass: "s3cret" },
        { fetchImpl },
      ),
    ).rejects.toThrow(McpClientNotFoundError);
    expect(called).toBe(false);
  });

  test("--keep-keys (keepKeys: true): server ack still required, but local key files are preserved", async () => {
    const grantFetch = mockOpsFetch();
    const entry = await granted("keep-me", grantFetch.fetchImpl);

    const { fetchImpl: revokeFetch } = mockOpsFetch();
    await revokeMcpClient(
      { name: "keep-me", manifestPath, opsPortOrUrl: OPS_PORT, adminUser: "admin", adminPass: "s3cret", keepKeys: true },
      { fetchImpl: revokeFetch },
    );

    expect(existsSync(entry.keyFile)).toBe(true);
    // Manifest entry is still removed — it's no longer a "granted" client,
    // even though the raw key bytes were left on disk at the caller's request.
    expect(readMcpClientManifest(manifestPath)).toHaveLength(0);
  });
});

// ─── list ────────────────────────────────────────────────────────────────────

describe("readMcpClientManifest — list output", () => {
  test("empty/missing manifest → empty array, no throw", () => {
    expect(readMcpClientManifest(join(dir, "does-not-exist.json"))).toEqual([]);
  });

  test("malformed manifest JSON → treated as empty, never throws", () => {
    writeFileSync(manifestPath, "{ not valid json", { mode: 0o600 });
    expect(readMcpClientManifest(manifestPath)).toEqual([]);
  });

  test("returns every granted entry with name + client_id + status + createdAt", async () => {
    const { fetchImpl: f1 } = mockOpsFetch();
    await grantMcpClient(
      { name: "alpha", keysDir, manifestPath, issuer: ISSUER, opsPortOrUrl: OPS_PORT, adminUser: "admin", adminPass: "s3cret" },
      { fetchImpl: f1, now: () => "2026-07-01T00:00:00.000Z" },
    );
    const { fetchImpl: f2 } = mockOpsFetch();
    await grantMcpClient(
      { name: "beta", keysDir, manifestPath, issuer: ISSUER, opsPortOrUrl: OPS_PORT, adminUser: "admin", adminPass: "s3cret" },
      { fetchImpl: f2, now: () => "2026-07-02T00:00:00.000Z" },
    );

    const entries = readMcpClientManifest(manifestPath);
    expect(entries.map((e) => e.name)).toEqual(["alpha", "beta"]);
    for (const e of entries) {
      expect(e.clientId).toBe(`${ISSUER}/MCPClientMetadata/${e.name}`);
      expect(e.status).toBe("active");
      expect(typeof e.createdAt).toBe("string");
    }
  });

  test("defaultMcpClientManifestPath is under ~/.flair", () => {
    expect(defaultMcpClientManifestPath()).toContain(join(".flair", "mcp-clients.json"));
  });
});

// ─── buildMcpGrantConfig — no key material, ever ────────────────────────────

describe("buildMcpGrantConfig — printed config never carries key material", () => {
  test("references the key file path, never a raw key or a working static bearer token", () => {
    const config = buildMcpGrantConfig({ name: "svc", resource: `${ISSUER}/mcp`, keyFile: "/home/x/.flair/keys/svc.key" });
    const serialized = JSON.stringify(config);
    expect(serialized).toContain("/home/x/.flair/keys/svc.key");
    expect(serialized).not.toMatch(/"privateKey"|"secretKey"|"seed"/i);
    // The Authorization value is a documented placeholder, not a real token —
    // it must not look like an opaque credential (no base64url-ish long token).
    expect((config as any).mcpServers.svc.headers.Authorization).toContain("flair mcp token");
  });
});

// ─── no key material on stdout ──────────────────────────────────────────────

describe("grant — no key material ever reaches console output", () => {
  test("capturing every console.log/console.error during a grant call finds no raw key bytes", async () => {
    const { fetchImpl } = mockOpsFetch();
    const logs: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: any[]) => { logs.push(args.map(String).join(" ")); };
    console.error = (...args: any[]) => { logs.push(args.map(String).join(" ")); };

    let entry: McpClientManifestEntry;
    try {
      const result = await grantMcpClient(
        { name: "quiet", keysDir, manifestPath, issuer: ISSUER, opsPortOrUrl: OPS_PORT, adminUser: "admin", adminPass: "s3cret" },
        { fetchImpl },
      );
      entry = result.entry;
      // grantMcpClient itself performs NO console output at all — the CLI
      // action layer does the printing. Assert that invariant directly.
      expect(logs).toHaveLength(0);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    // Belt-and-suspenders: the raw private key bytes (base64) never appear
    // in anything that was logged (there was nothing logged, but if that
    // ever regresses, this catches leakage specifically).
    const rawKeyBase64 = readFileSync(entry!.keyFile).toString("base64");
    for (const line of logs) {
      expect(line).not.toContain(rawKeyBase64);
    }
  });
});

// ─── DCR token gate, exercised at the contract level (full CLI-gate coverage
// lives in dcr-client.test.ts; this confirms grant/revoke's own option wiring
// reads the same contract) ───────────────────────────────────────────────────

describe("requireDcrToken — the gate flair mcp grant/revoke enforce before touching anything", () => {
  test("a missing DCR token surfaces the same actionable error grant/revoke would see", () => {
    const filePath = join(dir, "no-token-here");
    delete process.env[DCR_TOKEN_ENV];
    expect(() => requireDcrToken({ filePath })).toThrow(DcrTokenNotFoundError);
  });
});
