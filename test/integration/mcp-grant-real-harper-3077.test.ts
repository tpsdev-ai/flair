// mcp-grant-real-harper-3077.test.ts — flair#3077 slice C, against a REAL
// Harper: `grantMcpClient` inserts the Agent row through the operations API
// and the instance then serves the client's CIMD metadata. The test reads back
// the inserted row's id, name, kind, type, status, displayName, publicKey,
// admin, defaultTrustTier, runtime and createdAt, and the served document's
// client_id, client_name and jwks key.
//
// Build prerequisite: dist/resources/*.js (`bun run build`).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { grantMcpClient } from "../../src/cli.ts";

const ISSUER = "https://agent-a.example.test";
const CLIENT = "client-a";

function assertOwnInstance(h: HarperInstance): void {
  const http = new URL(h.httpURL);
  const ops = new URL(h.opsURL);
  for (const u of [http, ops]) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (http.port === ops.port || !h.process?.pid || !h.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${h.httpURL} / ${h.opsURL} is not an instance this test started`);
  }
}

let harper: HarperInstance;
let rootDir: string;
let keysDir: string;
let manifestPath: string;

async function ops(op: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify({ database: "flair", ...op }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  expect(res.status, `${op.operation} returned ${res.status}: ${text.slice(0, 300)}`).toBeLessThan(300);
  return text.length ? JSON.parse(text) : null;
}

const AGENT_ATTRS = [
  "id",
  "name",
  "kind",
  "type",
  "status",
  "displayName",
  "publicKey",
  "admin",
  "defaultTrustTier",
  "runtime",
  "createdAt",
];

async function readAgent(id: string): Promise<any[]> {
  return ops({
    operation: "search_by_value",
    table: "Agent",
    search_attribute: "id",
    search_value: id,
    get_attributes: AGENT_ATTRS,
  });
}

/** Seed an Agent row this test owns, so a grant must neither reuse nor delete it. */
async function seedAgent(id: string): Promise<void> {
  await ops({
    operation: "insert",
    table: "Agent",
    records: [{
      id,
      name: id,
      kind: "agent",
      type: "agent",
      status: "active",
      displayName: id,
      publicKey: "existing-public-key",
      admin: false,
      defaultTrustTier: "unverified",
      runtime: "headless",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
  });
}

beforeAll(async () => {
  harper = await startHarper({ serverEnv: { FLAIR_MCP_ISSUER: ISSUER } });
  assertOwnInstance(harper);
  rootDir = mkdtempSync(join(tmpdir(), "flair-3077c-"));
  keysDir = join(rootDir, "keys");
  manifestPath = join(rootDir, "mcp-clients.json");
}, 180_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (rootDir) rmSync(rootDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

describe("flair#3077 slice C — mcp grant against a real Harper", () => {
  test("(h) the inserted Agent row carries the fields the test reads and the instance serves the client's metadata", async () => {
    const { entry } = await grantMcpClient({
      name: CLIENT,
      keysDir,
      manifestPath,
      issuer: ISSUER,
      opsPortOrUrl: harper.opsURL,
      adminUser: harper.admin.username,
      adminPass: harper.admin.password,
    });
    expect(entry.clientId).toBe(`${ISSUER}/MCPClientMetadata/${CLIENT}`);

    const publicKey = readFileSync(join(keysDir, `${CLIENT}.pub`)).toString("base64url");

    // schemas/agent.graphql: name/publicKey/createdAt are String!; the rest are
    // the grant's own values for id, kind, type, status, displayName, admin,
    // defaultTrustTier and runtime.
    const rows = await ops({
      operation: "search_by_value",
      table: "Agent",
      search_attribute: "id",
      search_value: CLIENT,
      get_attributes: [
        "id",
        "name",
        "kind",
        "type",
        "status",
        "displayName",
        "publicKey",
        "admin",
        "defaultTrustTier",
        "runtime",
        "createdAt",
      ],
    });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.id).toBe(CLIENT);
    expect(row.name).toBe(CLIENT);
    expect(row.kind).toBe("agent");
    expect(row.type).toBe("agent");
    expect(row.status).toBe("active");
    expect(row.displayName).toBe(CLIENT);
    expect(row.publicKey).toBe(publicKey);
    expect(row.admin).toBe(false);
    expect(row.defaultTrustTier).toBe("unverified");
    expect(row.runtime).toBe("headless");
    expect(typeof row.createdAt).toBe("string");

    const res = await fetch(`${harper.httpURL}/MCPClientMetadata/${CLIENT}`);
    expect(res.status).toBe(200);
    const doc: any = await res.json();
    expect(doc.client_id).toBe(`${ISSUER}/MCPClientMetadata/${CLIENT}`);
    expect(doc.client_name).toBe(CLIENT);
    expect(doc.jwks.keys).toHaveLength(1);
    expect(doc.jwks.keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519", x: publicKey });
  }, 60_000);

  test("(i) a manifest write failure after the insert deletes the Agent and removes its key files", async () => {
    const client = "client-b";
    const occupied = join(rootDir, "manifest-parent");
    writeFileSync(occupied, "occupied");
    const failingManifest = join(occupied, "mcp-clients.json");

    const seen: Array<{ operation: string; status: number }> = [];
    const recordingFetch = (async (url: any, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const res = await fetch(url, init);
      seen.push({ operation: body.operation, status: res.status });
      return res;
    }) as typeof fetch;

    let thrown: Error | undefined;
    try {
      await grantMcpClient(
        {
          name: client,
          keysDir,
          manifestPath: failingManifest,
          issuer: ISSUER,
          opsPortOrUrl: harper.opsURL,
          adminUser: harper.admin.username,
          adminPass: harper.admin.password,
        },
        { fetchImpl: recordingFetch },
      );
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeDefined();
    expect(seen.find((s) => s.operation === "insert")).toEqual({ operation: "insert", status: 200 });
    expect(seen.find((s) => s.operation === "delete")).toEqual({ operation: "delete", status: 200 });
    expect(thrown!.message).toContain("was deleted");
    expect(thrown!.message).toContain("its key files were removed");
    expect(existsSync(join(keysDir, `${client}.key`))).toBe(false);
    expect(existsSync(join(keysDir, `${client}.pub`))).toBe(false);

    const rows = await ops({
      operation: "search_by_value",
      table: "Agent",
      search_attribute: "id",
      search_value: client,
      get_attributes: ["id"],
    });
    expect(rows).toHaveLength(0);
  }, 60_000);

  test("(j) a failed existence lookup refuses the grant and leaves the existing Agent row untouched", async () => {
    const client = "client-lookup-fail";
    await seedAgent(client);
    const before = await readAgent(client);
    expect(before).toHaveLength(1);

    const seen: string[] = [];
    const lookupFails = (async (_url: any, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      seen.push(body.operation);
      if (body.operation === "search_by_value") return new Response("lookup unavailable", { status: 503 });
      throw new Error(`unexpected ${body.operation} request after a failed lookup`);
    }) as typeof fetch;

    let thrown: Error | undefined;
    try {
      await grantMcpClient(
        {
          name: client,
          keysDir,
          manifestPath,
          issuer: ISSUER,
          opsPortOrUrl: harper.opsURL,
          adminUser: harper.admin.username,
          adminPass: harper.admin.password,
        },
        { fetchImpl: lookupFails },
      );
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown!.message).toContain("status 503");
    expect(thrown!.message).toContain(client);
    expect(thrown!.message).toContain("refusing the grant before any key or Agent record write");
    expect(seen).toEqual(["search_by_value"]);
    expect(existsSync(join(keysDir, `${client}.key`))).toBe(false);
    expect(existsSync(join(keysDir, `${client}.pub`))).toBe(false);
    expect(await readAgent(client)).toEqual(before);
  }, 60_000);

  test("(k) an unacknowledged insert sends no delete and keeps the existing Agent row and the keys", async () => {
    const client = "client-unack-insert";
    await seedAgent(client);
    const before = await readAgent(client);
    expect(before).toHaveLength(1);

    const deletes: any[] = [];
    const insertFails = (async (url: any, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.operation === "search_by_value") {
        // A successful answer that misses the seeded row: the grant proceeds
        // to the insert, which then fails without committing.
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (body.operation === "insert") return new Response("insert failed", { status: 500 });
      if (body.operation === "delete") {
        deletes.push(body);
        return fetch(url, init);
      }
      return fetch(url, init);
    }) as typeof fetch;

    let thrown: Error | undefined;
    try {
      await grantMcpClient(
        {
          name: client,
          keysDir,
          manifestPath,
          issuer: ISSUER,
          opsPortOrUrl: harper.opsURL,
          adminUser: harper.admin.username,
          adminPass: harper.admin.password,
        },
        { fetchImpl: insertFails },
      );
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown!.message).toContain("outcome is unknown");
    expect(thrown!.message).toContain(`flair agent show ${client}`);
    expect(deletes).toHaveLength(0);
    expect(existsSync(join(keysDir, `${client}.key`))).toBe(true);
    expect(existsSync(join(keysDir, `${client}.pub`))).toBe(true);
    expect(await readAgent(client)).toEqual(before);
  }, 60_000);

  test("(l) a 2xx insert the real Harper reports as skipped sends no delete, keeps the keys and leaves the seeded Agent", async () => {
    const client = "client-real-skip";
    await seedAgent(client);
    const before = await readAgent(client);
    expect(before).toHaveLength(1);

    const occupied = join(rootDir, "manifest-parent-skip");
    writeFileSync(occupied, "occupied");
    const failingManifest = join(occupied, "mcp-clients.json");

    let insertBody: any = null;
    const deletes: any[] = [];
    const lookupMissesThenReal = (async (url: any, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.operation === "search_by_value") {
        // Empty list through the injected seam: the grant proceeds to the real
        // insert, which Harper answers 2xx with the id skipped (row exists).
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (body.operation === "delete") deletes.push(body);
      const res = await fetch(url, init);
      if (body.operation === "insert") insertBody = await res.clone().json().catch(() => null);
      return res;
    }) as typeof fetch;

    let thrown: Error | undefined;
    try {
      await grantMcpClient(
        {
          name: client,
          keysDir,
          manifestPath: failingManifest,
          issuer: ISSUER,
          opsPortOrUrl: harper.opsURL,
          adminUser: harper.admin.username,
          adminPass: harper.admin.password,
        },
        { fetchImpl: lookupMissesThenReal },
      );
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeDefined();
    expect(insertBody?.skipped_hashes).toEqual([client]);
    expect(thrown!.message).toContain("outcome is unknown");
    expect(deletes).toHaveLength(0);
    expect(existsSync(join(keysDir, `${client}.key`))).toBe(true);
    expect(existsSync(join(keysDir, `${client}.pub`))).toBe(true);
    expect(await readAgent(client)).toEqual(before);
  }, 60_000);
});
