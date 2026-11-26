// mcp-grant-real-harper-3077.test.ts — flair#3077 slice C, against a REAL
// Harper: `grantMcpClient` inserts the Agent row through the operations API
// and the instance then serves the client's CIMD metadata. The inserted row is
// read back and checked against schemas/agent.graphql's field set.
//
// Build prerequisite: dist/resources/*.js (`bun run build`).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  test("(h) the inserted Agent row carries the schema's fields and the instance serves the client's metadata", async () => {
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
});
